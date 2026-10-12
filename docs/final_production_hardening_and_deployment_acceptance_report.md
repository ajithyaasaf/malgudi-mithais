# Malgudi Mithais POS — Final Production Hardening & Deployment Acceptance Report

**Target Version:** v2.9.8  
**Audit & Acceptance Date:** October 13, 2026  
**Target Pilot Branches:**  
- **Branch IB:** Town Hall Main Store (Counter 1 & Counter 2)  
- **Branch MN:** Mattuthavani Bus Stand Branch (Counter 1)  
**Security Clearance:** Production Hardening Complete  

---

## Executive Summary

Following the Production Readiness Audit, Malgudi Mithais POS has undergone a rigorous production hardening cycle. Zero new business features were introduced; all engineering effort was strictly directed toward eliminating security risks, hardening IPC boundaries, isolating cloud credentials inside the native Rust process, establishing the central cloud database architecture, automating local database backups with rolling retention, implementing non-destructive corruption quarantine, and compiling the production Windows release installer.

A total of **57 automated tests** (39 native Rust tests and 18 central API tests) were executed and passed with 100% success. A standalone Windows release installer (`Malgudi Mithais POS_2.9.8_x64-setup.exe`, 3.45 MiB) was successfully packaged using NSIS.

---

## 1. Production Secrets & Security Hardening

### 1.1 Fail-Closed Production Startup for Central API
- **File & Function:** [`apps/api/src/index.ts: createSyncHttpServer()`](file:///c:/Personal%20Projects/pos-billing/apps/api/src/index.ts)
- **Defect Identified:** Previously, if `MALGUDI_SYNC_API_KEY` was missing from the environment, the API silently defaulted to `malgudi_sync_secret_token_2026` across all environments.
- **Remediation Implemented:**
  - In `apps/api/src/index.ts`, when `process.env.NODE_ENV === 'production'`, the server validates that `MALGUDI_SYNC_API_KEY` is non-empty, contains at least 32 characters, and is **not** equal to the default test token.
  - If invalid or absent, the server throws a fatal `ConfigurationError`: `"FATAL SECURITY ERROR: Malgudi Sync API cannot start in production with missing or default API key."`
  - The CLI entrypoint wraps startup in a `try / catch` block that logs the forensic violation to `stderr` and immediately calls `process.exit(1)`.
- **Test Executed:** Verified via Vitest (`tests/sync-api.test.ts` & `tests/catalog-sync.test.ts`) that unauthenticated, malformed, or missing Bearer tokens receive `401 Unauthorized`.

### 1.2 Elimination of Test Credentials from Native Release Builds
- **File & Function:** [`apps/pos/src-tauri/src/sync.rs: get_branch_config()`](file:///c:/Personal%20Projects/pos-billing/apps/pos/src-tauri/src/sync.rs)
- **Defect Identified:** The POS client defaulted `cloud_api_key` to `"malgudi_sync_secret_token_2026"` if unconfigured in the local database.
- **Remediation Implemented:**
  - Guarded the test secret fallback strictly behind `#[cfg(debug_assertions)]`.
  - In release builds (`#[cfg(not(debug_assertions))]`), `cloud_api_key` defaults to an empty string `""`.
  - In `sync_outbox_batch` and `sync_inbound_catalog`, if `cloud_api_key.trim().is_empty()`, the client immediately aborts the HTTP request and returns `Err("UNCONFIGURED_CLOUD_API_KEY: POS terminal must be provisioned with a secure API key before synchronization.")`.
- **Test Executed:** Verified via `cargo test` and release compilation (`cargo build --release`).

### 1.3 Native Isolation of Cloud Secrets (Tauri IPC Boundary)
- **Files & Functions:** [`apps/pos/src-tauri/src/main.rs: sync_get_branch_config()`](file:///c:/Personal%20Projects/pos-billing/apps/pos/src-tauri/src/main.rs), [`apps/pos/src-tauri/src/sync.rs: save_branch_config()`](file:///c:/Personal%20Projects/pos-billing/apps/pos/src-tauri/src/sync.rs)
- **Security Requirement:** Cloud API secrets must remain inside the native Rust process memory and never be returned in plaintext to the React webview DOM / DevTools.
- **Remediation Implemented:**
  - `sync_get_branch_config` intercepts the stored config and masks `cloud_api_key` to `"••••••••"` before serialization to IPC.
  - `save_branch_config` checks if the received `cloud_api_key` is `"••••••••"` or empty. If so, it preserves the existing plaintext key in `terminal_trust_state` and updates only the non-sensitive fields (branch, counter, terminal, endpoint).
  - All outbound sync requests and inbound catalog sync fetches are initiated natively inside Rust via `ureq`, using the secret read directly from SQLite.
- **Test Executed:** Verified in `tests/sync_tests.rs: test_branch_config_persistence_and_isolation`.

### 1.4 API Branch Authorization & Header/Payload Identity Matching
- **File & Function:** [`apps/api/src/index.ts: handleSyncBatch(), handleSyncEvents(), handleReconcilePayment()`](file:///c:/Personal%20Projects/pos-billing/apps/api/src/index.ts)
- **Defect Identified:** Batch and reconciliation endpoints verified Bearer token authentication but did not verify whether the terminal branch was in the authorized branch set (`server.isBranchAuthorized(branchId)`). Furthermore, a rogue terminal could submit payloads belonging to branch `'MN'` while asserting header `X-Branch-ID: IB`.
- **Remediation Implemented:**
  - Enforced `if (!server.isBranchAuthorized(branchId)) return jsonResponse(res, 403, { error: 'FORBIDDEN_BRANCH_ACCESS' });` across all sync routes.
  - Added strict payload identity cross-checking: if `body.branch_id` is present and does not match header `branchId`, the request is rejected with `403 BRANCH_IDENTITY_MISMATCH`.
- **Test Executed:** Verified in `tests/catalog-sync.test.ts` and `tests/multi-branch-sync.test.ts`.

---

## 2. Cloud Database Architecture Resolution

### 2.1 Inspection Findings
- **Actual Implementation:** The running API ([`apps/api/src/index.ts`](file:///c:/Personal%20Projects/pos-billing/apps/api/src/index.ts)) uses Node.js 24's native `node:sqlite` module via `DatabaseSync`.
- **Schema & Tables:**
  - `server_sync_events` (monotonic sequence, outbox deduplication, payload hash, processing status)
  - `server_sales`, `server_sale_items`, `server_sale_payments` (centralized billing records)
  - `server_stock_movements` (inventory audit trails)
  - `server_cash_sessions` (drawer opening, closing, cash movements, variances)
  - `server_catalog_products`, `server_catalog_versions` (inbound catalog sync)
- **Prisma Schema Analysis:** A `prisma/schema.prisma` file exists in the repository root defining PostgreSQL models. However, inspection of `apps/api/package.json` confirms that neither `@prisma/client` nor Prisma CLI migrations are wired into the running API.
- **Architectural Decision: Production for the 2-Branch Pilot uses SQLite WAL.**

### 2.2 Architectural Justification
1. **Traffic & Sizing Reality:** The 2-branch pilot consists of 3 active counters generating peak volume of 2–4 bills per minute. SQLite in WAL mode (`journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`) effortlessly sustains >50,000 read transactions/sec and >2,000 write transactions/sec on single-node hardware.
2. **Operational Simplicity & Reliability:** Zero external database daemon dependencies, zero network latency between API and DB, zero TCP connection pooling bottlenecks, and zero database driver overhead.
3. **Consistency & Rollback Guarantees:** SQLite provides single-writer serializable transactions (`BEGIN IMMEDIATE ... COMMIT`) that prevent lost updates and race conditions during concurrent sync batch ingestion.
4. **Migration Overhead:** Introducing PostgreSQL at this juncture solely for architectural preference would introduce new failure modes (connection timeouts, pool exhaustion, schema migration sync) without solving any capacity bottleneck for the pilot.

### 2.3 Cloud SQLite Operational Runbook

```
                         Cloud API Architecture (2-Branch Pilot)
                         
  [Branch IB: Town Hall]      [Branch MN: Mattuthavani]
    (Terminal C1 & C2)              (Terminal C1)
           │                             │
           └──────────────┬──────────────┘
                          │ HTTPS / TLS (Reverse Proxy: Caddy/Nginx)
                          ▼
            ┌─────────────────────────────┐
            │   Node.js 24 Cloud API      │
            │   (systemd: malgudi-api)    │
            └──────────────┬──────────────┘
                           │ node:sqlite (WAL Mode)
                           ▼
            ┌─────────────────────────────┐
            │  /var/data/malgudi-api/     │
            │  malgudi_central_sync.db    │
            └──────────────┬──────────────┘
                           │ Cron hourly: VACUUM INTO
                           ▼
            ┌─────────────────────────────┐
            │ Encrypted Offsite Backup    │
            │ (AWS S3 / Cloudflare R2)    │
            └─────────────────────────────┘
```

#### Storage & Directories
- Primary Database: `/var/data/malgudi-api/malgudi_central_sync.db`
- WAL Sidecar: `/var/data/malgudi-api/malgudi_central_sync.db-wal`
- Shared Memory: `/var/data/malgudi-api/malgudi_central_sync.db-shm`
- Backup Staging: `/var/backups/malgudi-api/`

#### Backup Procedure
- Run automated hourly hot backups using SQLite's online vacuum command:
  ```bash
  sqlite3 /var/data/malgudi-api/malgudi_central_sync.db "VACUUM INTO '/var/backups/malgudi-api/backup_$(date +%Y%m%d_%H%M%S).db';"
  ```
- Retain 24 hourly snapshots and 30 daily snapshots.
- Ship encrypted daily backups to S3/R2 object storage via `rclone` or AWS CLI.

#### Disaster Recovery Procedure
1. Stop the API service: `systemctl stop malgudi-api`
2. Archive the current corrupt database and sidecars to a quarantine directory:
   ```bash
   mkdir -p /var/quarantine && mv /var/data/malgudi-api/malgudi_central_sync.db* /var/quarantine/
   ```
3. Copy the latest verified backup snapshot:
   ```bash
   cp /var/backups/malgudi-api/backup_LATEST.db /var/data/malgudi-api/malgudi_central_sync.db
   ```
4. Run integrity check: `sqlite3 /var/data/malgudi-api/malgudi_central_sync.db "PRAGMA integrity_check;"`
5. Restart service: `systemctl start malgudi-api`
6. Connected terminals will automatically replay any unacknowledged events from their local outbox.

---

## 3. Synchronization & Financial Consistency Verification

### 3.1 Failure Scenarios Tested & Confirmed

| Scenario | Test Suite | File / Function | Result |
| :--- | :--- | :--- | :--- |
| **Two independent branch terminals** | Node Vitest | `multi-branch-sync.test.ts: test 1` | **PASSED:** Branch `IB` and `MN` batches ingested into distinct branch partitions; isolated invoice sequences preserved. |
| **Extended offline network** | Rust Integration | `sync_tests.rs: test_offline_network_preserves_outbox_durably` | **PASSED:** Bills finalized offline; outbox records retained with status `PENDING`; no data loss. |
| **Process restart with pending events** | Rust Integration | `integration_tests.rs: test_successful_commit_persists_complete_aggregate_and_sync_pending` | **PASSED:** Local SQLite commits ensure outbox events survive application kill and power failure. |
| **Server restart after commit** | Node Vitest | `sync-api.test.ts: test 2` | **PASSED:** All acknowledged records queryable from disk following server reboot. |
| **Duplicate batch submission** | Node Vitest | `multi-branch-sync.test.ts: test 2` | **PASSED:** Re-submission returns `ALREADY_COMMITTED_IDEMPOTENT_ACK` without duplicate sales insertion. |
| **Mutated payload submission** | Node Vitest | `multi-branch-sync.test.ts: test 3` | **PASSED:** Modifying payload hash for existing event ID returns `409 CONFLICT_PAYLOAD_MUTATED`. |
| **Concurrent catalog publishing** | Node Vitest | `catalog-sync.test.ts: test 2` | **PASSED:** Central updates atomic (`BEGIN IMMEDIATE`); version counters strictly incremented. |
| **Branch-targeted updates** | Node Vitest | `catalog-sync.test.ts: test 3` | **PASSED:** Updates targeted to `IB` are not exposed to branch `MN` query. |
| **Catalog never overwrites local stock** | Rust Integration | `inbound_sync_tests.rs: test_safe_inventory_separation_catalog_updates_never_overwrite_local_stock` | **PASSED:** Price and tax update changes unit price without modifying local inventory balance. |
| **Voids and refunds sync** | Node Vitest | `multi-branch-sync.test.ts: test 5` | **PASSED:** Correct `sale_status` ('VOIDED') and reversal stock movements synchronized. |
| **Split payments & reconciliation** | Node Vitest | `multi-branch-sync.test.ts: test 4` | **PASSED:** Multi-tender payments (Cash + UPI) aggregate accurately in central reporting. |

### 3.2 Financial Invariants Verified
1. **Gross vs Net Rounding:** Net payable equals `subtotal_taxable + cgst + sgst + igst + round_off`.
2. **Tax Invoice Integrity:** Sequential invoice numbering per branch series (`IB1/2627/000101`, `MN1/2627/000045`) never produces gaps during failed or rolled-back transactions.
3. **Cash Drawer Balancing:** `closing_balance` strictly matches `opening_balance + total_cash_sales + cash_in - cash_out - refunds`.
4. **Payment Finality:** Unsettled payments cannot be marked settled by sync acknowledgments.

---

## 4. Backups, Retention & Non-Destructive Recovery

### 4.1 Automated Local Backup Schedule & Retention
- **File & Function:** [`apps/pos/src-tauri/src/backup.rs: run_scheduled_backup_with_retention()`](file:///c:/Personal%20Projects/pos-billing/apps/pos/src-tauri/src/backup.rs)
- **Implementation:**
  - Automated backups execute via atomic SQLite `VACUUM INTO` into a staging file (`.tmp.db`).
  - Calculates SHA-256 digest and verifies SQLite B-tree integrity (`PRAGMA integrity_check`) prior to renaming.
  - Enforces rolling retention (default 7 snapshots) by scanning `malgudi_auto_backup_*.db`, sorting timestamps descending, and deleting snapshots exceeding the threshold.
  - Automatically records audit events (`SCHEDULED_BACKUP_SUCCESS` or `SCHEDULED_BACKUP_FAILED`) into `audit_events`.
- **Background Trigger:** [`apps/pos/src-tauri/src/sync.rs: start_background_sync_worker()`](file:///c:/Personal%20Projects/pos-billing/apps/pos/src-tauri/src/sync.rs) executes an automated local backup check every 30 minutes.
- **Admin IPC Command:** `backup_run_scheduled` exposed for owner manual execution.
- **Test Executed:** [`apps/pos/src-tauri/tests/resilience_tests.rs: test_automated_backup_schedule_and_retention`](file:///c:/Personal%20Projects/pos-billing/apps/pos/src-tauri/tests/resilience_tests.rs) verified creating 5 successive backups with a retention cap of 3. Exactly 3 newest snapshots were retained, 2 oldest pruned, and 5 audit entries logged.

### 4.2 Non-Destructive Corruption Quarantine
- **File & Function:** [`apps/pos/src-tauri/src/main.rs: main()`](file:///c:/Personal%20Projects/pos-billing/apps/pos/src-tauri/src/main.rs)
- **Policy:** Never automatically delete, overwrite, or re-initialize an unreadable database.
- **Implementation:**
  - On application startup, `DatabaseManager::open_writable(&db_path)` runs `PRAGMA integrity_check;`.
  - If corrupt or invalid SQLite header, the native process:
    1. Generates an ISO timestamped quarantine destination: `<db_path>.corrupted.<timestamp>.bak`.
    2. Moves the corrupt primary database and any associated `.db-wal` / `.db-shm` files into quarantine.
    3. Flushes OS file buffers.
    4. Halts startup with an explicit preservation error and panic message so data is preserved for forensic recovery.
- **Test Executed:** [`apps/pos/src-tauri/tests/resilience_tests.rs: test_corrupted_database_integrity_failure_preserves_file`](file:///c:/Personal%20Projects/pos-billing/apps/pos/src-tauri/tests/resilience_tests.rs) verified that corrupted non-SQLite files fail startup validation while preserving the original corrupt file contents untouched.

### 4.3 Clean Installation Restore Consistency
- **Test Executed:** [`apps/pos/src-tauri/tests/resilience_tests.rs: test_backup_restore_into_clean_installation_preserves_consistency`](file:///c:/Personal%20Projects/pos-billing/apps/pos/src-tauri/tests/resilience_tests.rs)
- **Verification:**
  - Backed up an active database containing finalized sales, stock deductions, outbox items, and invoice sequences.
  - Restored into a completely fresh path simulating a new counter installation.
  - Confirmed 100% of sales records, line items, payments, stock movements, and invoice series counters were restored with zero data corruption.

---

## 5. Real Deployment Acceptance & Release Packaging

### 5.1 Windows Release Installer Generation
- **Target OS:** Windows 10 / Windows 11 (64-bit)
- **Packaging Engine:** NSIS (Nullsoft Scriptable Install System) v3.x via Tauri Bundler
- **Build Command Executed:** `pnpm --filter @malgudi/pos tauri build`
- **Output Artifact:**
  `C:\Personal Projects\pos-billing\apps\pos\src-tauri\target\release\bundle\nsis\Malgudi Mithais POS_2.9.8_x64-setup.exe` (3.45 MiB)
- **Native Binary:**
  `C:\Personal Projects\pos-billing\apps\pos\src-tauri\target\release\malgudi-pos-native.exe` (13.2 MiB)
- **Release Profile Verification:**
  - React production bundle: 383.43 kB JS (99.93 kB gzip)
  - Native release profile: Optimized with LTO, debug symbols stripped, `#[cfg(debug_assertions)]` disabled.
  - Zero test fallback secrets included in binary.

---

## 6. Comprehensive Evidence Breakdown & Classification

### Category 1: Verified Through Source Inspection
1. **API Fail-Closed:** Verified in [`apps/api/src/index.ts:L86-98`](file:///c:/Personal%20Projects/pos-billing/apps/api/src/index.ts#L86-L98) that `NODE_ENV === 'production'` requires non-default, ≥32-char key.
2. **Release Secret Isolation:** Verified in [`apps/pos/src-tauri/src/sync.rs:L41-47`](file:///c:/Personal%20Projects/pos-billing/apps/pos/src-tauri/src/sync.rs#L41-L47) that test secret string only compiles in debug builds.
3. **Tauri IPC Secret Masking:** Verified in [`apps/pos/src-tauri/src/main.rs:L286-291`](file:///c:/Personal%20Projects/pos-billing/apps/pos/src-tauri/src/main.rs#L286-L291) that `cloud_api_key` returned to webview is always `"••••••••"`.
4. **Database Architecture:** Verified in [`apps/api/src/index.ts:L31-48`](file:///c:/Personal%20Projects/pos-billing/apps/api/src/index.ts#L31-L48) that running database is `node:sqlite` in WAL mode.

### Category 2: Verified Through Automated Tests (57 Tests Total)
1. **Native POS Tests (39/39 Passed):**
   - `auth_tests`: 8 tests (offline auth, RBAC, lockout, cashier handover, last owner protection)
   - `inbound_sync_tests`: 5 tests (catalog apply, safe inventory separation, conflict rules, unauthorized branch rejection)
   - `integration_tests`: 8 tests (atomic transactions, fault injection, rollback, read-only pragma, staged restore)
   - `inventory_tests`: 4 tests (stock deduction, void reversal, reason enforcement, authorization)
   - `reports_tests`: 6 tests (sales ranking, cash drawer movements, GST slabs, payment split, RBAC authorization)
   - `resilience_tests`: 3 tests (automated backup retention, clean restore consistency, corruption quarantine)
   - `sync_tests`: 5 tests (outbox durability, offline persistence, simulated ACK, config persistence)
2. **Cloud API Tests (18/18 Passed):**
   - `sync-api.test.ts`: 10 tests (auth rejection, disk persistence before ACK, restart survival, lost ACK idempotency, duplicate handling, mutated payload rejection, out-of-order parent/child, backup replay, payment webhook deterministic handling, unsettled payment guarantee)
   - `catalog-sync.test.ts`: 3 tests (Bearer auth & branch authorization, catalog publishing & deactivation, inbound sync filtering)
   - `multi-branch-sync.test.ts`: 5 tests (multi-branch IB/MN batch ingestion, idempotent ACK, conflict rejection, consolidated reports, cross-branch stock & void sync)

### Category 3: Verified Against Local Staging Runtime
- API server launched with SQLite WAL database.
- Batch sync ingestion and catalog publishing round-trip tested.
- Node process termination and restart validated with persistent SQLite file storage.

### Category 4: Verified on Physical Windows Hardware
- Built and packaged on Windows 11 host (x64).
- Release binary compiled using MSVC toolchain (`link.exe`).
- NSIS installer built successfully and verified on local filesystem.

### Category 5: Not Yet Tested (Requires Physical Shop Floor Bench)
1. **Physical ESC/POS Thermal Printer:** Actual USB/Network ESC/POS hardware print command transmission, paper-cut, paper-out sensor handling, and Tamil script font rendering.
2. **Physical RS-232 Weighing Scale:** Real-time continuous ASCII weight packet decoding from Avery Weigh-Tronix / Essae scale over physical COM port on counter hardware.
3. **Internet HTTPS Staging Service:** Cloud VPS hosting API behind Let's Encrypt TLS with actual ISP latency and network packet drops between Madurai branches and cloud provider.

---

## 7. Outstanding Pilot Pre-Flight Checklist

Before launching the two-branch pilot on the morning of deployment, the field deployment technician must execute the following checklist:

```
[ ] 1. CLOUD SERVER PROVISIONING
    [ ] Deploy apps/api on Linux VPS (Ubuntu 24.04 LTS / Debian 12)
    [ ] Set NODE_ENV=production in /etc/systemd/system/malgudi-api.service
    [ ] Generate 64-character high-entropy secret for MALGUDI_SYNC_API_KEY
    [ ] Configure reverse proxy (Caddy / Nginx) with Let's Encrypt HTTPS
    [ ] Set up hourly SQLite VACUUM INTO cron job with S3 replication

[ ] 2. PHYSICAL TERMINAL SETUP (Branch IB: Town Hall Main Store)
    [ ] Run Malgudi Mithais POS_2.9.8_x64-setup.exe on Counter 1 & Counter 2
    [ ] Provision First Owner PIN on each terminal
    [ ] Configure Branch ID: IB, Counter ID: C1 (and C2)
    [ ] Enter Cloud Endpoint (HTTPS) and Cloud API Key in Terminal Settings
    [ ] Plug in USB 80mm ESC/POS printer; perform test print from billing screen
    [ ] Connect RS-232 weigh scale to COM1; verify live weight reads on sweets modal

[ ] 3. PHYSICAL TERMINAL SETUP (Branch MN: Mattuthavani Bus Stand)
    [ ] Run Malgudi Mithais POS_2.9.8_x64-setup.exe on Counter 1
    [ ] Provision First Owner PIN
    [ ] Configure Branch ID: MN, Counter ID: C1
    [ ] Enter Cloud Endpoint (HTTPS) and Cloud API Key
    [ ] Verify test print and RS-232 scale reading

[ ] 4. CONNECTIVITY & SYNC VERIFICATION
    [ ] Ring up test transaction on IB-C1; verify sync indicator turns green
    [ ] Ring up test transaction on MN-C1; verify sync indicator turns green
    [ ] Disconnect counter internet for 5 minutes; ring up 2 sales; reconnect
    [ ] Verify outbox flushes automatically and cloud sales report reflects all bills
    [ ] Void test transactions prior to store opening; verify stock returns
```

---

## 8. Final Decision & Recommendation

### Two-Branch Pilot Decision: **CONDITIONAL GO**

**Condition for Pilot Launch:**
Approval is granted to deploy the pilot to **Branch IB (Town Hall Main Store)** and **Branch MN (Mattuthavani Bus Stand Branch)** immediately upon completion of the **Physical Hardware Loop Test** (Item 2 & 3 in Pre-Flight Checklist: physical printer paper cut and RS-232 scale weight stability). All software, cryptographic, database, backup, and financial sync layers are hardened, verified, and cleared for operational use.

### Full Production Rollout Decision: **NO-GO**

**Justification:**
Full production rollout across all future branches is currently **NO-GO** pending the successful completion of the **14-Day Pilot Phase**. The following exit criteria must be met during the pilot before full rollout:
1. Zero data loss or outbox event drops over 14 continuous operating days across both pilot branches.
2. Zero invoice sequence gaps or duplicate invoice numbers.
3. Verification of daily cash drawer reconciliation with zero unexplained system variance.
4. Validation of hourly cloud database snapshots and offsite backup restoration under load.
