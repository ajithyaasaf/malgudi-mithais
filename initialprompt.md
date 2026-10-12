# MASTER DEVELOPMENT PROMPT — MALGUDI MITHAIS POS & RETAIL MANAGEMENT SYSTEM

## 1. YOUR ROLE

Act as a principal product engineer, senior software architect, database architect, POS domain specialist, senior UI/UX engineer, QA engineer, security engineer, and deployment engineer.

Build a reliable, offline-first, multi-branch retail POS and business management system for Malgudi Mithais, a sweets, savouries, snacks, and bakery retail business in Madurai, Tamil Nadu, India.

Apply mature engineering and design-system practices. Build a coherent, maintainable application with correct business logic, exceptional operational UX, strong transaction integrity, and realistic failure handling.

Do not merely produce code or attractive mockups. Understand the business, design its workflows, implement the product end to end, test it, and document its operation.

## 2. PRODUCT VISION

Product name: **Malgudi Mithais — Multi-Branch Retail POS & Business Management System**

The system must provide:

- Fast retail billing.
- Product catalog and selling configurations.
- Finished-goods receiving and inventory management.
- Automatic stock deduction after completed sales.
- Multi-branch and multi-device support.
- Offline-capable operations and reliable synchronization.
- Supplier purchases and stock transfers.
- Returns, cancellations, and refunds.
- Opening cash, cash tracking, and day-end closing.
- GST-aware sales and purchase records.
- Owner dashboards and operational reports.
- Centralized business activity and exception tracking.
- Thermal printer, barcode scanner, and weighing-scale integration where supported by actual hardware.

The application must be approachable for non-technical retail employees and provide meaningful oversight to the owner.

**Core philosophy: Powerful underneath. Lean on the surface.**

## 3. CONFIRMED BUSINESS REQUIREMENTS

Treat these as established:

1. Malgudi currently operates two branches.
2. Additional branches must be supported without redesign.
3. Malgudi is a retailer, not a manufacturer.
4. Finished goods arrive from an upstream production/source operation, external suppliers, or other branches.
5. Completed sales automatically reduce stock according to the product's configured inventory unit.
6. The owner needs centralized visibility across branches.
7. Employees may share a counter. Do not require each employee to log in and out whenever someone takes over.
8. The owner requires GST-related reporting and month-end exports for the CA/accountant.
9. Existing hardware includes computers and 80 mm thermal printers, believed to be predominantly USB-connected. Exact models still need verification.
10. The initial recurring infrastructure budget target is ₹0 wherever realistically possible.
11. Business correctness, data integrity, recovery, and transaction safety take priority over infrastructure cost.
12. A complete, coherent V1 is required. Do not artificially defer essential functionality to V2.
13. Cash opening and day-end reconciliation must be integrated into the POS workflow.
14. Automatic day-end processing may be used to prepare and monitor closing, but must never fabricate a physical cash count or falsely declare the drawer balanced.

Do not invent unconfirmed requirements. Mark assumptions and client questions clearly.

## 4. FIRST ACTION: INSPECT AND PLAN

Before large-scale implementation:

1. Inspect the existing repository, package manager, source code, installed dependencies, environment configuration, and current application state.
2. Identify working features that must be preserved.
3. Confirm the available runtime and target operating system.
4. Produce an architecture and UX blueprint before destructive changes.
5. Document:
   - Repository structure.
   - Technology choices and compatibility.
   - Database design.
   - Domain entities and relationships.
   - Branch and device assignment.
   - User roles and authorization.
   - Counter and cash-session lifecycle.
   - Business-day and day-end closing rules.
   - Stock ledger and sale finalization rules.
   - Offline operation and synchronization.
   - Hardware integration.
   - GST model.
   - Security and backup strategy.
   - Test strategy.
   - Deployment and recovery.
   - Unresolved business assumptions.

Do not remain in planning indefinitely. After the blueprint has been reviewed or authorized, proceed through implementation stages.

If clarification is unavailable, use sensible, documented, reversible defaults.

## 5. PREFERRED TECHNOLOGY STACK

Verify current package compatibility and inspect the repository before finalizing versions.

### Desktop POS

- React.
- TypeScript with strict mode.
- Vite.
- Tauri for the Windows desktop runtime.
- SQLite for durable local data.
- Drizzle ORM for local SQLite.
- Zustand for focused client state.
- TanStack Query where useful for server state.
- Tailwind CSS.
- Custom Malgudi Design Language System.
- Zod for shared schemas.
- Vitest.
- Playwright.

### Backend

- NestJS.
- TypeScript.
- REST API.
- OpenAPI.
- PostgreSQL.
- Prisma ORM.
- Server-side validation and authorization.
- Modular monolith architecture.

### Initial infrastructure

- Neon PostgreSQL Free, subject to current limits.
- Render Free for the API, subject to cold starts and service limitations.
- UptimeRobot Free for availability monitoring.
- Cloudinary for product/reference images where needed.
- GitHub and GitHub Actions.

### Suggested repository

malgudi-pos/
- apps/pos/
- apps/admin/
- apps/api/
- packages/domain/
- packages/contracts/
- packages/validation/
- packages/dls/
- packages/hardware/
- packages/sync-engine/
- packages/config/
- prisma/
- docs/

Use pnpm workspaces and Turborepo if they simplify the actual project. Avoid unnecessary packages and abstractions.

### Infrastructure constraints

Do not introduce Redis, BullMQ, microservices, Kubernetes, or a mandatory VPS without a demonstrated need.

The client should not need to install SQLite, PostgreSQL, Node.js, Docker, or a database server to run the packaged POS application.

SQLite is the local operational database. PostgreSQL is the central database. Each POS device has its own local database.

Never treat localStorage as the authoritative transaction database.

## 6. MALGUDI DESIGN LANGUAGE SYSTEM

Create a reusable design system before implementing the complete interface.

### Design principles

- Fast.
- Clear.
- Forgiving.
- Consistent.
- Traceable.
- Accessible.
- Operationally calm.
- Progressive disclosure.

### Color tokens

- Primary: #8B1E2D
- Primary dark: #6F1623
- Primary light: #F4DDE1
- Primary soft: #FBF1F3
- Cream: #FFF9F0
- Background: #F7F7F5
- Surface: #FFFFFF
- Subtle surface: #FCFCFA
- Primary text: #1F1F1F
- Secondary text: #666666
- Muted text: #8A8A8A
- Border: #E5E1DC
- Strong border: #D3CEC8
- Success: #16835B
- Success background: #E8F5EF
- Warning: #C77B00
- Warning background: #FFF4DE
- Error: #C62828
- Error background: #FDECEC
- Information: #2563A8
- Information background: #EAF2FB

Use predominantly neutral surfaces, cream sparingly, and maroon for primary actions. Do not rely on color alone to communicate status.

### Component foundations

Create reusable components including:

- Button and IconButton.
- Input and SearchInput.
- Select, Checkbox, Switch.
- Badge and Tooltip.
- Dialog and Drawer.
- Toast and ConfirmAction.
- Table and EmptyState.
- LoadingState and ErrorState.
- QuantityInput and MoneyDisplay.
- ConnectionStatus and SyncStatus.
- PermissionGuard.
- ProductRow, CartItem, PaymentSummary.
- StockMovementRow and StockIndicator.
- CashSummary and VarianceIndicator.
- SessionStatus and AuditEventRow.

Every component must have clear variants, accessibility behavior, interaction states, and appropriate loading/error/empty states.

Avoid excessive gradients, shadows, glassmorphism, decorative animations, and inconsistent rounding.

Support Tamil and English text rendering where appropriate.

## 7. LEAN UX RULES

The application may have complex internal logic, but normal employees must not be exposed to architectural complexity.

- Minimize clicks, typing, decisions, and context switching.
- Do not interrupt normal billing with unnecessary staff login prompts.
- Do not ask the cashier to select a branch when the device is already assigned to one.
- Keep common actions visible and rare actions discoverable.
- Use progressive disclosure.
- Avoid duplicate screens and forms.
- Use plain language.
- Provide clear error messages and recovery actions.
- Avoid meaningless charts and excessive dashboard cards.
- Use explicit confirmation for consequential actions, not harmless routine actions.
- Never show raw database errors or internal sync queue details.

Prefer terms such as:
- Receive Stock.
- Opening Cash.
- Close Counter.
- Expected Cash.
- Actual Cash.
- Cash Difference.
- Stock History.
- Print Again.
- Pending Synchronization.

Do not expose terms such as idempotency key, event sourcing, database transaction, or synchronization queue to ordinary staff.

**The user workflow must stay simple even when the underlying business logic is sophisticated.**

## 8. USER TYPES AND SHARED COUNTER MODEL

### Owner/Admin

- Consolidated dashboard.
- Branches and devices.
- Products and pricing.
- Stock and receiving.
- Purchases and suppliers.
- Cash closing oversight.
- Reports and GST.
- Activity and exception center.
- Sensitive action oversight.

### Manager/Authorized supervisor

- Authorized stock operations.
- Purchase receiving.
- Returns and refunds within policy.
- Cash closing and variance resolution.
- Authorized adjustments and discounts.
- Relevant branch reports.

### Counter staff

- Billing.
- Product lookup.
- Payment recording.
- Receipt printing/reprinting.
- Relevant customer lookup.
- Counter opening/closing where authorized.

### Shared-counter rule

The counter is associated with:

Organization → Branch → Counter/Device.

Do not force individual staff login/logout for every handover.

If the owner wants to identify who opened or closed a counter, capture the person's name through a simple, optional or policy-configured selection.

Sensitive operations may require manager authorization or a secure PIN. Do not invent a universal PIN or hard-code credentials.

Record actor identity only when the person has actually been identified. Otherwise, attribute the event to the known counter/device and indicate that the individual operator is unknown.

## 9. CASH OPENING AND COUNTER SESSION MANAGEMENT

This is a core V1 feature.

Implement a simple, reliable counter-session workflow with clear separation between the physical cash drawer, the business day, and individual employee identity.

### Terminology

Use:

- **Open Counter** — opening workflow.
- **Opening Cash** — physical cash present when the counter opens.
- **Opened By** — optional/configurable identity of the person opening it.
- **Expected Cash** — calculated physical cash according to recorded activity.
- **Actual Cash** — manually counted physical cash.
- **Cash Difference** — actual cash minus expected cash.
- **Close Counter** — manual closing workflow.
- **Day-End Summary** — consolidated summary of the business day.
- **Pending Close** — closing still requires action or reconciliation.

### Opening workflow

When the POS starts, check its assigned branch, counter, business date, and active session state.

If no valid counter session exists, display a compact opening dialog before normal cash billing begins.

Show:

- Branch and counter, automatically identified.
- Business date.
- Opening cash amount.
- Opened By, if identity capture is enabled.
- Optional notes.

Example:

"Good morning. Open Counter"

Branch: Iyer Bungalow  
Business date: 9 October 2026  
Opening cash: ₹2,000  
Opened by: [Select name, if configured]

[Start Billing]

The opening cash amount must represent the actual cash physically present in the drawer at opening.

Do not label it as revenue, sales, or profit.

After confirmation:
- Persist the opening record durably.
- Create or activate the appropriate counter session.
- Start normal billing immediately.
- Avoid unnecessary loading screens.
- Make the session state visible in a small, unobtrusive indicator.

If the internet is unavailable, opening must work locally where permitted.

Prevent accidental duplicate opening records. If a session already exists, offer to resume it instead of opening another session.

### Counter session versus employee session

The counter session represents the operational period of a physical counter/device. It does not represent one employee's login session.

Employees can hand over the counter without closing and reopening the session unless the business specifically requires a separate controlled handover process.

### Business-day model

Do not assume every business day ends exactly at midnight.

Support a configurable business-day cutoff, initially defaulting to 23:59 in the business's local timezone if the owner confirms that policy.

Store timestamps consistently and calculate the business date using the configured timezone and cutoff.

If the business trades past midnight, transactions must remain associated with the correct business day according to the configured rule.

Do not silently assign transactions to a different business day because the app restarted.

## 10. EXPECTED CASH CALCULATION

Expected physical drawer cash must be calculated from the opening balance and recorded cash movements.

Conceptually:

Expected Cash =
Opening Cash
+ Cash Sales Collected
+ Other Recorded Cash Inflows
+ Cash Credit Collections
- Cash Refunds Paid
- Cash Expenses Paid From Drawer
- Cash Removed and Recorded
+ Other Valid Recorded Cash Movements

Do not include UPI, card, or other non-cash payments in the physical drawer balance.

Avoid counting the same payment twice.

Each cash movement must have a unique reference and an explicit type.

Examples:

- Opening cash.
- Cash sale.
- Cash refund.
- Expense paid in cash.
- Cash deposit/removal.
- Cash addition.
- Credit collection.
- Authorized correction.

A cash deposit or removal must be recorded explicitly. Do not treat every expense or cash movement as an untraceable adjustment.

## 11. MANUAL COUNTER CLOSING

Provide a simple manual close flow.

The authorized employee selects "Close Counter" or "Close Day" according to the configured workflow.

The application should:

1. Stop or warn about new transactions during finalization according to the chosen concurrency policy.
2. Finish or safely preserve any pending local transaction.
3. Calculate expected cash.
4. Show cash inflows and outflows.
5. Ask the employee to count physical cash.
6. Accept the actual cash amount.
7. Calculate the difference.
8. Request an explanation or approval when required.
9. Record the closing durably.
10. Show a closing summary and status.

Example:

Opening Cash: ₹2,000  
Cash Sales: ₹18,000  
Cash Refunds: ₹500  
Cash Expenses: ₹300  
Cash Removed/Deposited: ₹5,000  
Expected Cash: ₹14,200

Actual Cash: ₹14,000  
Cash Difference: -₹200

Show the discrepancy prominently but calmly.

Do not silently change sales, refunds, expenses, or opening cash to force a zero difference.

Allow the authorized employee to submit a closing with a documented discrepancy if business policy permits. Otherwise, require supervisor approval.

Once finalized, preserve the closing record. Corrections must be traceable.

### Closing with offline synchronization

A counter may need to close when internet access is unavailable.

Allow locally durable closing where safe, record its synchronization state, and synchronize it later without creating duplicate closing records.

Do not claim that the central owner dashboard is fully reconciled until all required data has arrived.

## 12. AUTOMATIC DAY-END PROCESSING

Implement automatic day-end processing as an assistance and control mechanism, not a fake cash count.

### Required behavior

At the configured business-day cutoff:

- Prepare a day-end summary.
- Calculate expected cash from recorded movements.
- Identify counters that have not closed.
- Identify pending synchronization.
- Identify unresolved payment states.
- Identify outstanding cash variances.
- Mark unclosed counters as requiring attention.
- Notify the owner/admin through the application's notification or dashboard system where available.

If no manual cash count has been entered, status must remain **Pending Close** or **Cash Count Required**.

Never automatically set Actual Cash equal to Expected Cash.

Never mark a drawer as physically counted or reconciled without a real count.

Never silently close a session that has unresolved financial operations.

### Late-night transactions

If a transaction occurs after the configured business-day cutoff:

- Apply the configured business-day policy.
- Do not discard the transaction.
- Do not attach it to a closed session without an explicit, audited rule.
- Show any late transaction or reopening exception to the authorized owner/manager.

If a counter remains active after the cutoff, follow the configured policy. Do not forcibly terminate a sale in progress.

### Automatic session rollover

The system may create the next business-day opening workflow automatically, but it must not invent an opening cash amount.

Where physical cash remains in the drawer overnight, require the next opening amount to be entered or confirmed according to policy.

If the previous session has not been closed, show a pending-close warning and require an authorized decision before opening a conflicting session.

### Owner oversight

Provide a concise status list:

- Open.
- Closed.
- Pending Close.
- Cash Count Required.
- Variance Requires Review.
- Pending Synchronization.

The owner must be able to identify which branch/counter needs attention.

Do not build a complicated accounting audit system when a clear operational closing workflow is sufficient.

## 13. MULTIPLE COUNTERS AND STAFF HANDOVERS

The system must support multiple counters/devices per branch if required.

Each counter session must have its own opening cash and cash movements where physical drawers are separate.

If two POS devices share the same physical cash drawer, do not assume each has an independent opening cash balance. Require an explicitly configured shared-drawer or common-cash policy.

If employees hand over a counter:

- Billing continues without individual logout/login.
- The current counter session remains open.
- No duplicate opening cash is created.
- Cash activity continues to be attributed to the appropriate counter/session.
- If a formal handover is enabled, record the handover and optional cash count without treating it as a full day-end close.

Do not infer individual responsibility where the identity of the employee handling a transaction is unknown.

## 14. PRODUCT CATALOG AND SELLING CONFIGURATION

Separate the product from its selling configuration and inventory unit.

Examples:
- Milk Bread: pieces.
- Fixed 250 g Omapodi: packs.
- Loose Mysore Pak: grams or kilograms.
- 500 g sweet box: configured pack/weight behavior.

Support relevant units such as piece, pack, box, gram, kilogram, and dozen where needed.

Product fields should include, as applicable:

- Name.
- SKU/barcode.
- Category.
- Selling configurations.
- Inventory unit.
- Selling price.
- Tax configuration.
- HSN/UQC.
- Low-stock threshold.
- Active/inactive status.
- Optional image.
- Optional best-before/expiry data.
- Branch availability or pricing when needed.

Do not expose every possible selling method for every product. Only show configured options.

Support validated catalog imports and exports.

## 15. RETAIL INVENTORY

Malgudi receives finished products. It does not manufacture them.

Do not implement manufacturing, raw-material consumption, recipes/BOM, production planning, or central-kitchen functionality.

Stock can enter through:

- Opening stock.
- Central/production-source receipt.
- External supplier receipt.
- Branch transfer.
- Valid resaleable customer return.
- Authorized stock adjustment.

Stock can leave through:

- Completed sale.
- Wastage/damage/expiry.
- Branch transfer.
- Supplier return.
- Authorized adjustment.

### Receive Stock

Provide one primary "Receive Stock" workflow.

1. Choose source type.
2. Choose supplier/source where applicable.
3. Choose destination branch.
4. Add multiple products.
5. Enter quantities and units.
6. Add source reference, invoice, received date, and optional notes as relevant.
7. Review and confirm.

Hide irrelevant fields based on source type.

A stock receipt must update inventory exactly once.

Draft receipts must not count as available inventory.

### Automatic stock deduction

When a sale is completed, create its stock movements exactly once.

Selling 350 g must deduct the correct amount when inventory is tracked by weight.

Selling three 250 g packs must deduct three packs when the configured stock policy tracks packs.

Do not mix units without explicit conversions.

### Stock history

Maintain traceable stock movements with:

- Product.
- Branch.
- Movement type.
- Signed quantity.
- Unit.
- Timestamp.
- Source/reference.
- Reason/context.
- Related sale, receipt, transfer, return, or adjustment.
- Actor/approver where known.

Cached stock balances are acceptable only if maintained consistently and reconcilable with the ledger.

### Transfers, wastage, stock count, adjustments

Support branch transfers with dispatch/receipt states, stock counts, guided adjustments, and wastage records.

Returned goods must not automatically become sellable without an appropriate disposition.

Every adjustment must be traceable. Never silently overwrite stock history.

## 16. BILLING AND CHECKOUT

Create a fast, counter-first interface:

- Product search/scan.
- Category/product selection.
- Editable cart.
- Quantity and weight entry.
- Subtotal, discount, tax, and total.
- Prominent payment action.

Support configured products, discounts, authorized price overrides, cash/UPI recording, split payments if required, customer attachment where useful, bill hold/resume where useful, receipt printing, and searchable sale history.

Do not make customer entry mandatory for every normal retail bill.

Keep the cart responsive and avoid cloud round-trips for each action.

### Transaction safety

- Give every logical sale a stable identity.
- Prevent duplicate sales on repeated clicks/retries.
- Use database transactions for sale finalization and related stock changes.
- Preserve historical item prices and taxes.
- Separate sale status, payment status, and printing status.
- Do not treat an unknown payment outcome as success.
- Do not delete completed financial transactions.

### Printer failure

A successful sale must remain recorded if printing fails.

Provide "Print Again" without creating another sale or payment.

## 17. PAYMENTS

Support appropriate cash and UPI recording in V1.

Distinguish manual payment recording from gateway-verified payment.

Use explicit payment states where applicable:

- Initiated.
- Pending.
- Successful.
- Failed.
- Unknown.
- Refunded.

Never create a second payment just because the first request timed out.

Gateway integrations, if required, must verify status server-side and validate webhook signatures.

Cash closing must include only physical cash movements, not UPI/card payments.

## 18. RETURNS, CANCELLATIONS, AND REFUNDS

Distinguish between removing a cart item, cancelling a finalized bill, returning goods, refunding a payment, and adjusting inventory.

Support partial returns and prevent returning more than the remaining returnable quantity.

Record original sale reference, reason, refund state, stock disposition, and approvals where relevant.

Preserve history through linked corrective transactions and reversals.

## 19. PURCHASES AND SUPPLIERS

Support supplier records, purchase invoices, optional purchase orders, partial receiving, damaged/wrong goods, supplier returns, supplier payments/outstanding balances, and GST information.

Keep simple purchases simple. Do not force every receipt through an unnecessary purchase-order workflow.

Receiving stock must not duplicate inventory.

## 20. GST CENTER

GST reporting is core V1 functionality.

Capture relevant tax data when the sale/purchase occurs.

Support appropriate product tax settings:

- HSN.
- GST rate.
- UQC.
- Tax category.
- Applicable taxable/exempt classification.

Preserve invoice number/date, branch, customer classification, GSTIN where applicable, place of supply where applicable, quantities, taxable values, rates, CGST, SGST, IGST, and totals as relevant.

Provide monthly summaries, purchase/input-tax data summaries, HSN reports, relevant B2B/B2C classification, missing-data warnings, and Excel/CSV exports.

Do not hard-code tax rates or promise guaranteed legal compliance.

Confirm whether the branches use one GSTIN or separate registrations.

The system assists the owner and CA/accountant; it does not replace professional review.

## 21. CUSTOMERS

Provide lightweight customer records and fast lookup.

Support purchase history, relevant returns/refunds, GST details where applicable, and outstanding balances only if credit is implemented.

Collect only necessary personal information.

## 22. DASHBOARD AND REPORTS

### Business Pulse

Display useful, accurate metrics:

- Today's sales.
- Bill count.
- Average bill.
- Payment-method breakdown.
- Branch comparison.
- Low stock.
- Pending receiving/transfers.
- Cash closing status.
- Cash variance.
- Pending synchronization.
- Important exceptions.

### Essential reports

- Sales by date/branch/product.
- Payment summary.
- Returns/cancellations.
- Stock on hand/history.
- Low stock.
- Purchases and supplier outstanding.
- Transfers.
- Wastage/adjustments.
- Cash closing and variances.
- Expenses.
- GST reports.
- Basic profitability where reliable cost data exists.

Provide appropriate branch/date filters and exports.

### Since Your Last Visit

Summarize meaningful business changes and exceptions without flooding the owner with irrelevant notifications.

## 23. ACTIVITY AND EXCEPTION CENTER

Track meaningful events such as:

- Sale completed/cancelled.
- Return/refund.
- Stock received/adjusted/transferred.
- Wastage.
- Cash session opened/closed.
- Cash variance.
- Cash movement/deposit.
- Product/pricing change.
- Sensitive action.
- Sync failure/recovery.

Include relevant actor identity if known, branch, counter/device, timestamp, related entity, changes, and reason/approval.

Never invent staff attribution.

## 24. MULTI-BRANCH ARCHITECTURE

Treat organization, branch, device, counter, and business-day identity as first-class domain concepts.

Support two branches from day one and future expansion.

Every relevant query/mutation must enforce branch scope server-side.

Provide branch-specific inventory and cash sessions, branch transfers, centralized reporting, device assignments, and owner visibility.

Do not trust a client-supplied branch ID without authorization.

## 25. OFFLINE-FIRST AND SYNCHRONIZATION

Use local SQLite for durable local operations, cached catalog/pricing, local sales, relevant payment records, stock projections, cash-session records, sync queue, and required audit events.

Implement:

- Stable IDs.
- Durable queued operations.
- Idempotent processing.
- Retry with backoff.
- Server acknowledgement.
- Duplicate prevention.
- Conflict detection.
- Recovery after restart.
- Sync status visibility.
- Safe handling of out-of-order retries.

Offline cash recording is not equivalent to gateway-confirmed UPI payment.

A disconnected device cannot guarantee globally authoritative stock across other disconnected devices. Define explicit policies for concurrent sales, low stock, and later reconciliation.

Do not silently overwrite newer cloud data with stale local state.

Cash opening and closing must be durably recorded locally and synchronized safely.

## 26. HARDWARE ABSTRACTION

Use interfaces for printer, scanner, weighing scale, and cash drawer where appropriate.

Inspect the actual printer model, operating system, and connection before finalizing integration.

Provide receipt formatting, printing, reprinting, diagnostics, and clear failure messaging.

Support keyboard-style barcode scanners where suitable.

Support a weighing scale only if the hardware protocol is confirmed. Provide manual weight entry as a fallback.

Never claim hardware compatibility without testing evidence.

## 27. SECURITY AND PRIVACY

Implement secure authentication, server-side authorization, branch isolation, input validation, protected secrets, secure logging, and audit records for sensitive operations.

Never hard-code credentials or store passwords in plaintext.

Protect administrative operations and sensitive customer data.

## 28. BACKUPS, DEPLOYMENT, AND MONITORING

Target minimal recurring cost without compromising data safety.

Document free-tier limits, cold starts, database storage/availability constraints, and potential service changes.

Provide:

- Cloud database backup/export strategy.
- Independent backup storage.
- Local database recovery.
- Backup retention.
- Restore testing.
- Migration recovery.
- Disaster recovery documentation.

Monitor API availability, database connectivity, critical errors, and synchronization failures.

Monitoring does not replace redundancy or backups.

## 29. DATABASE AND DOMAIN MODEL

Design a consistent domain model with relevant entities such as:

- Organization.
- Branch.
- Device.
- Counter.
- User/Role/Permission.
- BusinessDay.
- CounterSession.
- CashOpening.
- CashMovement.
- CashClosing.
- Product.
- Category.
- SKU/Barcode.
- SellingConfiguration.
- Unit/Conversion.
- PriceConfiguration.
- GSTConfiguration.
- Sale.
- SaleItem.
- Payment.
- Refund.
- Return.
- StockMovement.
- StockBalance/Projection.
- StockReceipt.
- Purchase/PurchaseItem.
- Supplier.
- SupplierPayment.
- StockTransfer/TransferItem.
- StockCount.
- Wastage.
- Customer.
- Expense.
- AuditEvent.
- SyncOperation.

These are candidate entities, not a mandate to create a separate table for every concept. Use appropriate domain boundaries and constraints.

Use decimal-safe money calculations, explicit unit conversions, transactional invariants, indexes, stable IDs, historical snapshots, and safe migrations.

Document invoice numbering, tax rounding, stock precision, cash rounding, and business-day cutoff rules.

## 30. MANDATORY BUSINESS INVARIANTS

1. A completed sale cannot silently lose its stock movement.
2. Retries cannot create duplicate sales, receipts, refunds, transfers, or closings.
3. Printer failure cannot invalidate a completed sale.
4. Reprinting cannot create another sale.
5. Unknown payment status is not success.
6. A refund must reference a valid sale/payment under policy.
7. Historical prices and taxes remain unchanged when current configuration changes.
8. Stock corrections are traceable.
9. Transfers cannot silently create or destroy stock.
10. Draft receipts do not count as received stock.
11. Cash closing uses recorded physical cash movements only.
12. UPI/card payments are excluded from physical drawer cash.
13. Actual Cash must never be fabricated from Expected Cash.
14. A closing cannot be declared physically counted without an actual count.
15. Automatic day-end processing must not silently erase unresolved transactions.
16. Duplicate opening/closing records must be prevented.
17. Branch authorization is enforced server-side.
18. Offline records remain recoverable.
19. Cash variances remain visible until appropriately resolved.
20. Shared-counter staff identity must not be fabricated.
21. Reconciliation must reveal discrepancies rather than conceal them.

## 31. PERFORMANCE

Keep billing responsive using indexed local search, efficient SQLite access, sensible state management, and minimal network dependency.

Paginate large administrative lists. Avoid loading all historical records unnecessarily.

Optimize for the actual shop computer rather than synthetic benchmarks.

## 32. TESTING REQUIREMENTS

### Unit tests

Test money/tax calculations, unit conversions, stock movements, payment transitions, idempotency, cash expected-balance calculations, cash variance, business-day cutoff, closing eligibility, and authorization.

### Integration tests

Test sale + stock deduction, duplicate receipt prevention, transfers, partial receiving, returns/refunds, cash opening/closing, cash movements, GST snapshots, audit records, synchronization retries, concurrent stock changes, and migrations.

### End-to-end tests

Test:

1. Open a counter with opening cash.
2. Resume an already-open counter without duplicate opening.
3. Hand over a shared counter without logging out.
4. Complete a cash sale.
5. Complete a UPI-recorded sale without falsely claiming gateway verification.
6. Print and reprint a receipt.
7. Receive finished goods.
8. Sell a fixed pack and variable-weight item.
9. Close a counter and reconcile actual cash.
10. Record a cash variance.
11. Prepare automatic day-end summary without fabricating actual cash.
12. Leave a counter unclosed and verify Pending Close.
13. Process a late transaction according to business-day policy.
14. Close while offline and synchronize later.
15. Recover from a restart during pending synchronization.
16. Process a partial return/refund.
17. Transfer stock between branches.
18. Export GST reports.
19. Verify branch isolation and owner visibility.
20. Simulate printer disconnection and API timeout.

Test that every feature works beyond its visual representation.

## 33. IMPLEMENTATION STAGES

### Stage A — Discovery and foundation

Inspect the repository, create the blueprint, define domain rules, establish migrations, DLS, validation, and tests.

### Stage B — Core POS

Product catalog, selling configurations, local persistence, billing, payment recording, receipts, stock deduction, and opening counter workflow.

### Stage C — Cloud and synchronization

API, PostgreSQL, authorization, branch/device scope, sync engine, idempotency, offline/recovery behavior.

### Stage D — Inventory and purchases

Stock receiving, purchases, transfers, stock counts, adjustments, wastage, history, and alerts.

### Stage E — Cash and business management

Counter sessions, cash movements, manual closing, business-day processing, pending-close monitoring, returns/refunds, customers, expenses, GST, reports, activity, and dashboard.

### Stage F — Hardware and release

Hardware adapters, Windows packaging, end-to-end testing, security review, backup/restore validation, deployment, and release documentation.

Reorder stages if necessary, but do not skip essential correctness.

## 34. DEFINITION OF DONE

A feature is complete only when:

- The workflow works end to end.
- Data persists correctly.
- Validation and authorization work.
- Failure states are handled.
- Offline behavior works where required.
- Synchronization does not duplicate operations.
- Relevant audit events exist.
- UI states are designed.
- Automated tests pass.
- Operations are documented.

The finished V1 must provide:

- Working desktop POS.
- Owner/admin interface.
- Two configurable branches.
- Product catalog and selling configurations.
- Finished-goods receiving.
- Automatic stock deduction.
- Transfers and stock history.
- Reliable sale/payment records.
- Returns/refunds and cancellations.
- Cash opening and closing.
- Expected versus actual cash reconciliation.
- Automated day-end summary and pending-close handling.
- GST reports/exports.
- Centralized activity and exception tracking.
- Offline operation and recovery.
- Hardware abstractions.
- Tests, packaging, and deployment documentation.

## 35. AGENT WORKING RULES

- Inspect existing files before editing.
- Preserve working functionality unless a change is justified.
- Do not leave major features as static mockups.
- Do not create dead buttons.
- Do not silently swallow errors.
- Do not disable tests/type checking to hide problems.
- Do not duplicate business rules across the frontend and backend.
- Do not trust frontend-only authorization.
- Do not use floating-point arithmetic for authoritative currency calculations.
- Do not mutate completed financial history silently.
- Do not claim offline or hardware compatibility without testing evidence.
- Do not add features merely because another POS advertises them.
- Do not introduce manufacturing, raw-material, recipe/BOM, central-kitchen, restaurant table, KOT, delivery-platform, or kitchen workflows without a genuine requirement.
- Do not overengineer infrastructure.
- Keep documentation synchronized with implementation.
- Run tests after meaningful changes.
- Report failures honestly.
- Make sensible independent decisions and document consequential trade-offs.

## 36. FINAL PRODUCT STANDARD

A cashier should be able to open the counter, enter opening cash, and start billing with minimal friction.

Employees must be able to share the counter without mandatory repeated logins.

At day-end, staff should be able to count the physical cash, compare it with expected cash, record a variance, and close the counter safely.

The owner should see which counters have closed, which still require action, whether there are cash discrepancies, and whether synchronization is complete.

Automatic processing may prepare summaries and flag exceptions, but must never pretend that physical cash was counted when it was not.

A completed sale must remain trustworthy if the internet drops, the printer fails, the application restarts, or synchronization is retried.

**Build a complete, reliable retail operating system for Malgudi Mithais — not a generic CRUD application, not a restaurant POS clone, and not a polished prototype with unsafe business logic.**

Start by inspecting the repository and producing the architecture and UX blueprint. Then implement, test, document, and stabilize the complete V1.