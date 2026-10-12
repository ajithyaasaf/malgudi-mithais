# Malgudi Mithais POS — Final Architecture Specification & Acceptance Gate (v2.9)
**Document Version:** 2.9 (Final Security, State-Machine & Durability Specification)  
**Target Platform:** Windows 10/11 Desktop POS (Tauri v2 + Native Rust SQLite `rusqlite`) & Centralized Cloud API  
**Business Domain:** Multi-Branch Retail Sweets, Savouries, Snacks & Bakery (Madurai, Tamil Nadu, India)

---

## 1. Focused Defect Corrections (v2.8 → v2.9)

### 1.1 Asymmetric Ed25519 Terminal Leases & Key Management
1. **Asymmetric Key Separation**:
   - Replaced symmetric HMAC-SHA256 with **Ed25519 asymmetric cryptography**.
   - **Private Signing Key**: Stored exclusively in secure hardware/environment on the central cloud server. It is **never** deployed to, accessible from, or compiled into desktop terminal binaries.
   - **Public Verification Keys**: Embedded in the native desktop application trust store, mapped by `key_id`.
2. **Canonical Lease Token Schema**:
   ```typescript
   export interface TerminalLease {
     lease_version: '2.9';
     terminal_id: string;
     series_code: string;
     key_id: string; // Identifier for active CA key (supports key rotation)
     lease_start_epoch_ms: number;
     lease_valid_until_epoch_ms: number;
     max_offline_hours: number;
     signature_hex: string; // 64-byte Ed25519 signature
   }
   ```
   - Canonical payload string: `v2.9:${terminal_id}:${series_code}:${key_id}:${lease_start_epoch_ms}:${lease_valid_until_epoch_ms}:${max_offline_hours}`.
3. **Key Rotation & Revocation Protocol**:
   - **Zero-Downtime Rotation**: Central server introduces a new keypair (e.g., `key_id = 'ca_master_key_2027_q1'`). Desktop app maintains an array of recognized public keys. Leases signed by any valid, recognized key are accepted.
   - **Revocation**: If a CA key is compromised, central server broadcasts a revocation update adding `key_id` to `revokedKeyIds`. Any lease referencing a revoked `key_id` is immediately rejected (`REVOKED_SIGNING_KEY`).
4. **Monotonic Trusted-Time & Disconnected State Handling**:
   - **Reboot & Monotonic Time**: Terminal persists `last_known_trusted_time` in SQLite table `terminal_trust_state`. On reboot or before invoice issuance: if `current_system_time < last_known_trusted_time`, **clock rollback is detected**; invoice issuance is locked (`LOCKED_NO_OPERATIONS`).
   - **Clock Advancement & Lease Expiry**: If disconnected when `current_system_time > lease_valid_until_epoch_ms`, offline invoice issuance is blocked.
   - **Operational Standby Fallback**: Terminal offers **`EMERGENCY_ESTIMATE_STANDBY`** mode, allowing cashiers to print non-tax Customer Estimates (`EST-xxx`) or use physical manual bill books without corrupting official Rule 46(b) serial sequences.

### 1.2 Explicit Transaction Payment Lifecycle & Durable Partial Collections
1. **State Independence & Lifecycle States**:
   - **Sale Lifecycle (`SaleStatus`)**:
     $$\text{DRAFT} \to \text{PAYMENT\_IN\_PROGRESS} \to \begin{cases} \text{PARTIALLY\_COLLECTED} \\ \text{COMPLETED} \end{cases} \to \begin{cases} \text{CANCELLED\_ABORTED} \\ \text{RETURNED\_FULL} \end{cases}$$
   - **Payment Reconciliation (`SalePaymentStatus`)**:
     $$\text{UNSETTLED\_PENDING} \to \text{PARTIALLY\_SETTLED} \to \text{SETTLED} \to \text{REFUNDED}$$
   - **Individual Payment Outcome (`PaymentOutcome`)**:
     `INITIATED`, `PENDING_CONFIRMATION`, `SUCCESS`, `TIMEOUT_UNKNOWN`, `FAILED`, `REFUNDED`.
2. **Precise Financial Breakdown Semantics**:
   - `moneyTendered`: Gross currency offered by the customer across all tenders.
   - `moneyActuallyReceived`: Cash retained in drawer (`tendered - change_returned`) plus gateway-confirmed non-cash funds.
   - `gatewayConfirmedMoney`: Non-cash payments verified via payment aggregator or UPI gateway with outcome `SUCCESS`.
   - `outstandingBalance`: Remaining unpaid balance: $\max(0, \text{Net Payable} - \text{moneyActuallyReceived})$.
   - `moneyRefunded`: Authoritative outward cash/ledger disbursements recorded as `direction = 'OUT'`.
3. **Handling `TIMEOUT_UNKNOWN` UPI Outcomes & Cancellation Flow**:
   - If dynamic UPI QR times out without bank confirmation, outcome is set to `TIMEOUT_UNKNOWN`.
   - **Invariant**: A sale can **never** be finalized or marked `COMPLETED` while any payment has an unknown outcome.
   - **Cancellation Flow with Unresolved UPI**:
     - If the customer leaves or cashier aborts the transaction:
       - Sale status is set to `CANCELLED_ABORTED`.
       - Received cash tender is refunded: refunds **strictly the exact physical cash received** and generates **exactly ONE** cash movement: `movement_type = 'CASH_REFUND'`, `direction = 'OUT'`. The cash payment record is marked `outcome = 'REFUNDED'`.
       - **Crucial Rule**: The unresolved UPI payment is **NEVER marked `REFUNDED`**. Its outcome remains `TIMEOUT_UNKNOWN`, and sale payment status remains `UNSETTLED_PENDING` (preserving unresolved financial liability).
       - Stock reservations are released back to available inventory.
   - **Asynchronous Reconciliation Flow**:
     - When background polling or cashier manual retry reconciles with the bank gateway:
       - If bank reports **`FAILED`**: UPI outcome transitions to `FAILED` with disposition `GATEWAY_CONFIRMED_FAILED`. Zero funds were deducted; transaction is closed.
       - If bank reports **`SUCCESS`**: Because the sale was already aborted, the customer was debited without receiving goods. An automatic digital reversal is initiated to the customer's Virtual Payment Address (VPA) with disposition `UNSOLICITED_GATEWAY_SUCCESS_AUTO_REFUND`. The cash drawer is **never touched**.
4. **Idempotency of Ledger Effects**:
   - Each physical collection, manual entry, or refund creates exactly one authoritative ledger entry with a unique deterministic ID.
   - Duplicate retries, network repetitions, and multiple webhook deliveries check existing transaction records and return idempotent acknowledgments without duplicating cash drawer or stock movements.

### 1.3 Explicit Stock Reservation Engine & Truthful Restock Justification
1. **Stock Reservation Model & Scope**:
   - Scope Policy:
     - **`BRANCH_LAN`**: Connected terminals on the local branch network coordinate reservations via local LAN broker.
     - **`TERMINAL_LOCAL`**: In air-gapped disconnected operation, reservations are tracked locally per terminal. Disconnected terminals cannot prevent concurrent inventory over-selling across separate counters; physical sweet tray inspection remains the operational counter safeguard.
   - Schema:
     ```sql
     CREATE TABLE stock_reservations (
         id TEXT PRIMARY KEY,
         cart_or_sale_id TEXT NOT NULL,
         branch_id TEXT NOT NULL,
         product_id TEXT NOT NULL,
         reserved_quantity INTEGER NOT NULL,
         unit TEXT NOT NULL,
         status TEXT NOT NULL, -- ACTIVE, COMMITTED, EXPIRED, RELEASED
         expires_at TEXT NOT NULL,
         created_at TEXT NOT NULL
     );
     ```
   - **Available Inventory Calculation**:
     $$\text{Available Stock} = \text{Physical On-Hand Stock} - \sum \text{Active Unexpired Reservations}$$
2. **Concurrency-Safe Reservation Lifecycle**:
   - `ACTIVE`: Created with a 15-minute TTL.
   - `COMMITTED`: When sale finalization executes at Boundary 8, reservation is converted into permanent `SALE_DEDUCTION` in `stock_movements`.
     - *Concurrency Guard*: Finalization transaction verifies `status == 'ACTIVE' AND expires_at > now()`. If the background worker expired the reservation during slow payment, checkout transaction aborts before committing stock movements.
   - `RELEASED`: If cart is cleared or sale is aborted/voided, reservation is marked `RELEASED`.
   - `EXPIRED`: Periodic background worker runs `expireStaleReservations`.
     - *Concurrency Guard*: Worker only mutates rows where `status == 'ACTIVE' AND expires_at <= now()`. It never touches `COMMITTED` or `RELEASED` rows, preventing race conditions with sale finalization.
3. **Truthful Restock Justification & Cumulative Reversal Limits**:
   - Every stock reversal (`CUSTOMER_RETURN_RESTOCK` or `VOID_STOCK_REVERSAL`) must reference an eligible original deduction (`stock_deduction_delta < 0`).
   - Restocking non-inventory items (e.g. Carry Bags with `stock_deduction_delta == 0`) is strictly rejected.
   - Cumulative partial reversals: Tracked via `cumulative_restocked_quantity`. Any attempt where `attempted_return + cumulative_already_restocked > original_deduction` is rejected with `EXCESSIVE_RESTOCK_REJECTED`.

### 1.4 Native SQLite Durability, Backup Integration & Staged Restoration
1. **Authoritative Native Database Engine (`apps/pos/src-tauri`)**:
   - Native Rust SQLite (`rusqlite 0.31`) configured with `PRAGMA journal_mode = WAL;`, `PRAGMA synchronous = FULL;`, `PRAGMA foreign_keys = ON;`, `PRAGMA busy_timeout = 5000;`.
   - Read-only connections enforce `PRAGMA query_only = ON;` without executing `journal_mode = WAL`.
   - Single canonical cash ledger with opening float partial unique index: `idx_cash_movements_session_opening`.
2. **Atomic Hot Snapshots & USB Durability**:
   - Snapshot procedure: Parameterized `VACUUM INTO ?1;` into a `.tmp.db` staging file.
   - Verifies snapshot B-tree integrity via `PRAGMA integrity_check;`.
   - Computes SHA-256 checksum and writes companion `.sha256` file.
   - Calls `file.sync_all()` to ensure OS drive write barriers flush all buffers to physical media.
   - Atomically renames `.tmp.db` to final destination `.db`.
   - Corrupt or partial snapshots are automatically deleted; verified backups are **never** overwritten.
3. **Staged Restore & Multi-Level Verification**:
   - Restoring a backup mounts it first in a segregated staging path (`staged_restore.db`).
   - Executes 3 mandatory verification gates:
     1. `PRAGMA integrity_check;` (structural B-tree verification).
     2. `PRAGMA foreign_key_check;` (relational consistency).
     3. Business-level reconciliation: asserts `invoice_series.current_seq` continuity, cash ledger sum, stock movement balance, and `sync_outbox` completeness.
   - A checksum alone is **never** accepted as proof of a valid or recoverable database.

### 1.5 Acceptance Gate: 8 Crash Boundaries & Commit States
Sale finalization in [`apps/pos/src-tauri/src/transaction.rs`](file:///c:/Personal%20Projects/pos-billing/apps/pos/src-tauri/src/transaction.rs) operates across 8 tables and boundaries:

| Boundary | Interruption Point | Database State if Interrupted | Durability Guarantee |
|---|---|---|---|
| **Boundary 1** | After updating `invoice_series.current_seq` | Zero changes persisted. Sequence reverts to previous. | SQLite WAL uncommitted; rolls back on restart. |
| **Boundary 2** | After inserting `sales` parent record | Zero changes persisted. No orphan sale record. | SQLite WAL uncommitted; rolls back on restart. |
| **Boundary 3** | After inserting `sale_items` rows | Zero changes persisted. No partial line item rows. | SQLite WAL uncommitted; rolls back on restart. |
| **Boundary 4** | After inserting `sale_payments` rows | Zero changes persisted. No payment rows. | SQLite WAL uncommitted; rolls back on restart. |
| **Boundary 5** | After inserting `cash_movements` (if cash allocated) | Zero changes persisted. No cash drawer movement. | SQLite WAL uncommitted; rolls back on restart. |
| **Boundary 6** | After inserting `stock_movements` (for physical items) | Zero changes persisted. Stock balances unaffected. | SQLite WAL uncommitted; rolls back on restart. |
| **Boundary 7** | After inserting `sync_outbox` and `audit_events` | Zero changes persisted. No outbox/audit rows. | SQLite WAL uncommitted; rolls back on restart. |
| **Boundary 8** | `tx.commit()` with `PRAGMA synchronous = FULL;` | **All 8 tables atomically committed**. `sync_status = 'SYNC_PENDING'`. | Fully flushed to OS and drive media via WAL barrier. |

- **Process Crash (`taskkill /F`)**: SQLite WAL automatic recovery rolls back uncommitted transactions on next database open.
- **Power Loss (Abrupt Disconnect)**: Protected by `PRAGMA synchronous = FULL;`. Ensures WAL frames are explicitly flushed to disk media before returning commit success.
- **Storage/Filesystem Corruption**: Mitigated by atomic snapshot rotation (`.tmp` write before rename), companion `.sha256`, USB mirroring, and staged recovery validation.

### 1.6 Proposed Operational Fallback (Manual Bill Books)
- **Legal & Regulatory Status**: Classified as **Proposed Operational Fallback (Pending CA Validation)**. While Rule 46 of the CGST/TNGST Rules governs tax invoices, the physical manual bill book contingency procedure under Tamil Nadu State GST guidelines requires formal written sign-off from the business Chartered Accountant.
- **Manual Bill Book Protocol**:
  - Dedicated, pre-printed, serial-controlled carbon bill books with distinct series (e.g., `M-IB1-2627-0001`).
  - Cashiers issue manual bills during total terminal outage (e.g. hardware failure, expired lease without network).
  - When system authorization is restored:
    - Cashier enters "Manual Bill Reconciliation" mode with supervisor authorization.
    - Records manual serial reference into `manual_bill_ledger (manual_series, serial_number, pos_sale_id, recorded_at, reconciled_by)`.
    - Prevents duplicate re-entry via composite primary key constraint `(manual_series, serial_number)`.
    - Generates corresponding audit record `MANUAL_BILL_RECONCILED`.

---

## 2. Evidence-Based PoC Test Execution Report

Executed on Windows 11 host using Node.js `v24.12.0`, pnpm `10.28.0`, Vitest `v3.2.7`:

```
 RUN  v3.2.7 C:/Personal Projects/pos-billing/packages/domain

 ✓ tests/pricing.test.ts (3 tests)
   ✓ SC-01: Exactly calculates 375g Mysore Pak @ ₹680/kg tax-inclusive (Gross = ₹255.00, Taxable = ₹242.86, CGST = ₹6.07, SGST = ₹6.07)
   ✓ SC-02: Per-Dozen Pricing and Stock Deduction Equivalence (-12 pcs)
   ✓ Mixed Tax Rates on Single Invoice with Section 170 CGST Act Round-Off

 ✓ tests/tender.test.ts (14 tests)
   ✓ Validates exact ₹255 bill: ₹155 Cash + ₹100 UPI -> Cash drawer increases by exactly ₹155
   ✓ Rejects over-tendered cash when change returned does not match calculation
   ✓ Rejects non-cash tender that attempts to return cash change
   ✓ Rejects tender when total allocation does not equal required bill total (partial payment)
   ✓ Rejects duplicate cash payment entries in a single bill to prevent duplicate drawer entries
   ✓ Rejects change returned exceeding the tendered cash amount
   ✓ Derives DRAFT status when zero payments have been recorded
   ✓ Derives PARTIALLY_COLLECTED when partial cash is collected durably without marking sale settled
   ✓ Blocks finalization when dynamic UPI times out into TIMEOUT_UNKNOWN outcome
   ✓ Permits finalization and marks COMPLETED / SETTLED only when 100% is reconciled successfully
   ✓ Aborting a partially collected transaction refunds strictly the received cash with exactly one movement
   ✓ Correctly preserves TIMEOUT_UNKNOWN outcome upon cancellation without falsely marking it REFUNDED
   ✓ Idempotently reconciles unknown payment: triggers digital refund if bank debited customer for aborted sale
   ✓ Accurately computes detailed financial breakdown distinguishing tendered, received, confirmed, and refunded

 ✓ tests/reservations.test.ts (10 tests)
   ✓ Creates an active stock reservation with 15-minute TTL
   ✓ Calculates available stock as physical stock minus active unexpired reservations
   ✓ Ignores expired reservations when calculating available stock
   ✓ Commits reservations into formal SALE_DEDUCTION stock movements upon checkout
   ✓ Releases reservations when cart is cleared or sale is aborted
   ✓ Concurrency guard: Rejects committing an expired reservation at checkout
   ✓ Concurrency guard: Periodic expiry worker ignores already COMMITTED or RELEASED reservations
   ✓ Scope policy: Distinguishes BRANCH_LAN coordination from TERMINAL_LOCAL disconnected operation
   ✓ Rejects positive restock exceeding prior sale quantity
   ✓ Rejects cumulative partial returns exceeding original unreversed quantity

 ✓ tests/reversals.test.ts (10 tests)
   ✓ Refunds completed cash bill with sellable restock disposition
   ✓ Refunds damaged item with DAMAGED_SCRAP disposition (no sellable restock)
   ✓ Voids an unpaid/aborted sale: restores tentative stock without cash refund
   ✓ Cancels partially paid sale: refunds only actual received cash
   ✓ Refunds completed 100% UPI bill without creating cash drawer outflow
   ✓ Rejects duplicate reversal on an already-voided sale (Idempotency)
   ✓ Handles REJECTED_NO_RETURN disposition by generating zero stock movements
   ✓ Rejects restocking non-inventory items with zero prior stock deduction
   ✓ Rejects restocking quantity greater than original purchase
   ✓ Rejects cumulative partial returns when sum exceeds original sale quantity

 ✓ tests/lease.test.ts (8 tests)
   ✓ Allows invoice issuance when Ed25519 signature is valid and within lease window
   ✓ Rejects lease with forged or invalid Ed25519 signature bytes
   ✓ Rejects lease signed by rogue or unknown private key
   ✓ Rejects lease when terminal_id or series_code is modified after signing
   ✓ Rejects lease signed by revoked key
   ✓ Rejects lease signed by unrecognized key ID (Key Rotation required)
   ✓ Blocks tax and automated invoices when clock rollback is detected
   ✓ Blocks offline tax invoice issuance when lease has expired and permits estimate/manual fallback

 ✓ tests/aggregate.test.ts (10 tests)
   ✓ Generates identical versioned SHA-256 hash regardless of JSON object property ordering (v2.9:sha256:...)
   ✓ Verifies a complete and valid aggregate successfully
   ✓ Allows non-inventory service item without stock movement (business rule check)
   ✓ Detects incomplete aggregate when stock movements are missing for physical items
   ✓ Detects child record link mismatch when payment references wrong sale ID
   ✓ Recovers clean aggregate into empty database successfully
   ✓ Safely and idempotently recovers already-recovered aggregate without duplicate insertions
   ✓ Quarantines incomplete aggregate
   ✓ Quarantines payload mutation when same sale ID has conflicting hash
   ✓ Quarantines invoice collision when different sale ID reuses existing invoice number

 ✓ tests/sync.test.ts (4 tests)
   ✓ Durably commits sale on server BEFORE returning acknowledgment to client
   ✓ Idempotently handles lost ACK: repeated client retry receives ACK without duplicate insertion
   ✓ Rejects and quarantines payload mutation when same event ID arrives with altered payload
   ✓ Buffers out-of-order child event until parent sale aggregate is durably committed

 Test Files  7 passed (7)
      Tests  60 passed (60)
   Duration  1.24s
```

### Toolchain Status (`cargo check` & `cargo test`)
```
& "$env:USERPROFILE\.cargo\bin\cargo.exe" check
   Compiling proc-macro2 v1.0.107
   Compiling quote v1.0.47
   Compiling generic-array v0.14.7
   Compiling serde_core v1.0.229
   Compiling zerocopy v0.8.62
   Compiling ahash v0.8.12
   Compiling getrandom v0.4.3
   Compiling zmij v1.0.23
   Compiling serde v1.0.229
   Compiling thiserror v1.0.69
   Compiling serde_json v1.0.151
   Compiling libsqlite3-sys v0.28.0
error: linker `link.exe` not found
  |
  = note: program not found

note: the msvc targets depend on the msvc linker but `link.exe` was not found
note: please ensure that Visual Studio 2017 or later, or Build Tools for Visual Studio were installed with the Visual C++ option
note: VS Code is a different product, and is not sufficient

error: could not compile `generic-array` (build script) due to 1 previous error
```

Attempted unattended automated installation via Windows Package Manager:
```
winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --silent --force
Found Visual Studio BuildTools 2022 [Microsoft.VisualStudio.2022.BuildTools] Version 17.14.41
Starting package install...
Installer failed with exit code: 1602
```
*Root Cause*: Exit code 1602 is `ERROR_INSTALL_USEREXIT`. The Visual Studio Build Tools bootstrapper requires Administrator elevation (UAC prompt), which cannot be approved in a non-interactive console subshell. Must be launched interactively by the developer or machine administrator.

### Comprehensive Status Summary
- **Automated TypeScript Domain & Contract Tests**: `60 PASSED`, `0 FAILED` (Across 7 test suites).
- **Native Rust Database Integration Tests**: `NOT RUN / REQUIRES MSVC C++ LINKER` (Complete implementation in [`apps/pos/src-tauri/src/db.rs`](file:///c:/Personal%20Projects/pos-billing/apps/pos/src-tauri/src/db.rs), [`apps/pos/src-tauri/src/backup.rs`](file:///c:/Personal%20Projects/pos-billing/apps/pos/src-tauri/src/backup.rs), [`apps/pos/src-tauri/src/transaction.rs`](file:///c:/Personal%20Projects/pos-billing/apps/pos/src-tauri/src/transaction.rs), and [`apps/pos/src-tauri/tests/integration_tests.rs`](file:///c:/Personal%20Projects/pos-billing/apps/pos/src-tauri/tests/integration_tests.rs); host lacks `link.exe`).
- **External Hardware, CA & Owner Sign-Offs**: `4 REQUIRES VALIDATION`.

---

## 3. Remaining Blockers and Evidence Needed to Close

| Blocker | Domain | Required Evidence to Close |
|---|---|---|
| **1. Host MSVC C++ Linker** | Build Toolchain | Target `x86_64-pc-windows-msvc` requires `link.exe` / Windows SDK `kernel32.lib` to link Rust proc-macro build scripts (`quote`, `serde`). Install "Visual Studio Build Tools" (C++ workload) or configure `x86_64-pc-windows-gnu` (MinGW) toolchain. Run clean `cargo test --manifest-path apps/pos/src-tauri/Cargo.toml`. |
| **2. Physical ESC/POS Printer** | Hardware Validation | Connect physical ESC/POS 80mm thermal USB printer. Disconnect printer mid-sale; assert transaction commits to DB; reconnect printer; click reprint; verify receipt prints without creating duplicate database rows (SC-14). |
| **3. Physical Serial Scale** | Hardware Validation | Connect physical weighing scale via RS-232 COM port. Verify live weight updates to POS UI; disconnect scale; verify cashier is prompted for reason; assert database records `MANUAL_KEYPAD` and receipt flags `[M]` (SC-15). |
| **4. CA Tax Matrix & Manual Fallback Approval** | Regulatory Sign-off | Formal written sign-off from Malgudi Mithais Chartered Accountant confirming: (a) 0%, 5%, 18% GST classification and HSN codes per SKU (SC-16), and (b) Legal basis and required protocol for manual carbon bill books during terminal outages. |
| **5. Owner Operational Sign-Off** | Business Policy | Written sign-off from owners confirming: (a) Branch 2 location (Mattuthavani vs KK Nagar), (b) Business day cutoff time (23:59 IST vs past-midnight counters), and (c) Cash drawer allocation (dedicated physical drawer per terminal vs shared drawer) (SC-17). |
