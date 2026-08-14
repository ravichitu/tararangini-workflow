# LiveKeeping Comparative Billing Audit

Date: 2026-08-06
Scope: Read-only review of the user's signed-in LiveKeeping account with live company data. No voucher, party, item, configuration, reminder, export, backup, or other LiveKeeping data was created, changed, downloaded, or deleted.

## Decision First: Do Not Create Two Accounting Authorities

The observed LiveKeeping account is connected to Tally and displays a last-sync time. Tarangini already maintains its own accounting journals, stock movements, financial-year locks, payments, invoices, backups, roles, job workflow, and customer portal.

### Approved Direction: Tarangini Is The Accounting Authority

Decision recorded on 2026-08-07: Tarangini is the source of truth for final invoices, receipts/payments, purchases, stock movements, financial-year close, party balances, ledger journals, official voucher numbering, audit history, backups, and job-to-invoice links.

LiveKeeping/Tally can be used as a read-only reference or receive a controlled export from Tarangini after reconciliation. They must not independently create final Tarangini invoices, payments, stock postings, journal entries, or voucher numbers.

Before any Tally or LiveKeeping connection is built, select one authority:

1. **Tarangini as authority:** Tally/LiveKeeping is read-only reference or receives controlled exports from Tarangini.
2. **Tally as authority:** Tarangini imports a read-only replica for dashboards, jobs, customer portal, and work management; final accounting stays in Tally.
3. **Avoid:** both systems independently creating final invoices, payments, stock postings, or voucher numbers. This will cause duplicate invoices, stock differences, and ledger conflicts.

No automatic third-party sync should be enabled until this decision, the supported API/connector method, ownership of voucher numbering, reconciliation rules, and recovery procedure are approved.

## What Was Observed In LiveKeeping

### Dashboard And Live Data

- A compact dashboard uses live company totals for cash, bank, inventory, payables, sales, receipts, receivables, overdue amounts, and payment projections.
- Period controls support today, yesterday, week, month, quarter, current financial year, and last financial year.
- An attention panel highlights inactive customers, inactive items, payment reminders, and SMS credits.
- Sales versus receipts are visualized monthly, receivables use age buckets, and a day book plus Top 10 views are available.
- Each summary card opens a focused register. The header displays company identity and sync freshness, for example "Synced 5 hours ago".

### Transaction Entry

- Quick-create covers quotation, sales invoice, receipt, payment, sales order, purchase invoice, journal, contra, purchase order, credit note, debit note, stock journal, physical stock, receipt note, and delivery note.
- Sales/quotation and delivery forms include party, ledger, voucher/date, item search, quantity, rate, unit, discount, HSN, godown, description, tax-inclusive control, narration, and advanced settings.
- Receipt/payment entry includes party, cash/bank ledger, transaction type, closing balance, amount, and narration.
- Journal/contra supports multiple debit/credit particulars, reference number/date, party and narration.
- Stock forms support physical count, stock transfer/production, godown, batches, manufacture/expiry dates, and narration.

### Billing Registers And Reports

- Receivables provides total, overdue, credit days, average payment days, party ledger drill-down, PDF ledger, due filters, search/sort, pagination, reminder controls, and bulk-reminder/template controls.
- Cash/bank registers provide date-range navigation, search, pagination, balances, and account drill-down.
- Party and item registers have search, focused filters, pagination, PDF output, and direct details. The observed data volume was large enough to demonstrate pagination rather than loading every row at once.
- The report catalogue has favorites plus accounting reports, financial statements, sales dimensions, stock reports, top customers/suppliers/items, and personal-entry views.
- Day Book uses date range, voucher filter, search, PDF, and paginated results.
- Profit & Loss has period navigation, KPI summary cards, expandable account groups, and PDF export.

### Configuration And Backup

- Invoice settings are grouped: company/invoice details, voucher numbering, template, declaration, header, logo, delivery/consignee data, narration, stock/discount/description/batch options, tax display, e-way/e-invoice fields, bank details, round-off, and delivery/order detail visibility.
- The backup screen shows automatic backup history by date and filename.

## Current Tarangini Position

Tarangini already has important capabilities that must be retained and not replaced:

- Multi-company isolation, role permissions, operator restrictions, audit logs, correction reasons, controlled deletion, and owner review.
- Sale invoices, quotations, proformas, delivery challans, payment received/payment vouchers, purchase orders/purchases, credit/debit notes, warranty workflows, stock movements, journals, bank data, financial-year locks, trial balance, balance sheet, profit/loss, day book, GST reports, and invoice status.
- Twenty-two invoice themes, GST presentation, HSN handling, document notes, logo/settings, PDF output, and document conversion flows.
- Customer portal, customer matching, jobs, production stages, operator daily logs, customer files, and billing-to-job references. These are outside LiveKeeping's observed accounting scope.
- Controlled offline drafts, registered device checks, conflict handling, organization-scoped snapshots, and owner-only approval of financial drafts.
- Encrypted automatic backup, restore-key workflow, backup verification, diagnostics, and restore testing. This is stronger than merely showing a backup list.

## Tarangini Billing Implementation List

### Priority 0 - Correctness And Safety Before New Screens

1. Fix the audited multi-year party-statement error: payment rows must be filtered by the requested financial year and the report must calculate an explicit prior-period opening balance. Add regression coverage.
2. Prevent global integrity repair from rebuilding journals or stock movements in a closed financial year unless an all-organization owner enters an explicit, audited recovery workflow.
3. Add a stock-movement reconciliation report that compares item balance, source transactions, returns, adjustments, warranty consumption, and job-material use.
4. Strengthen backup operations with retention policy, off-device copy/replication verification, disk-space warning, scheduled restore drill, and owner-visible pass/fail history. Keep encryption and recovery-key safeguards.
5. Decide the accounting authority before considering Tally/LiveKeeping integration. Document the unique ID, company mapping, financial-year mapping, party/item mapping, stock reconciliation, idempotency, error queue, and reversal rules.

### Priority 1 - High-Value Billing Workflow Improvements

1. Build the recorded lightweight owner dashboard: company/FY header, cash, bank, inventory, receivables, payables, sales, receipts, tax due, low stock, sync state, backup state, financial-draft conflicts, jobs awaiting action, and direct drill-downs.
2. Create a report catalogue with searchable groups and owner favorites. Preserve current reports while adding one consistent entry point for accounting, sales, stock, GST, jobs, warranty, and operator reports.
3. Upgrade receivables/payables into an owner workbench:
   - due today, not due, overdue, and age-bucket filters;
   - party credit limit, allowed credit days, actual average payment days, and last sale/purchase date;
   - party statement/PDF export and click-through from dashboard;
   - consent-aware reminder queue, template preview, and audit history.
4. Standardize every large register: saved filters, server-side pagination, date range, search, sort, total count, CSV/PDF export where appropriate, and deep links that preserve company/FY/filter.
5. Extend long-history report performance: paginate/set-optimize stock, ageing, invoice status, party statement, account ledger, bank report, sales register, purchases, and audit log. Never load all records into the browser for a large company.
6. Add party credit-policy fields: credit limit, credit days, collection notes, last transaction dates, and owner-only override reason. Do not block a sale silently; show a clear limit/overdue warning and audit any override.
7. Add a transparent attention queue with real reasons and drill-downs: inactive parties/items, negative stock, low stock, overdue collections, unallocated advances, expired quotations, failed backups, server/sync outage, and blocked offline drafts.
8. Add a universal floating quick-create menu, limited by organization and role. It should open Tarangini's existing transaction forms and never bypass permission checks, financial-year locks, or offline controls.

### Priority 2 - Inventory, Reporting, And Document Depth

1. Add optional warehouse/godown support only for companies that need physical location tracking. Scope every balance to organization, item, location, and date.
2. Add optional batch, serial, manufacture date, and expiry tracking for stock categories such as computer parts, warranty items, and consumables. Do not force these fields on service businesses.
3. Add physical-stock and controlled stock-journal screens with owner approval, stock-movement source links, variance reason, and audit records.
4. Add stock reports: in stock, zero stock, negative stock, reorder level, group/category, location, batch/expiry, and stock valuation. Reuse the Priority 0 reconciliation controls.
5. Add sales analysis by month, document type, party, item/service, category, employee/operator, and job/service category. Make date/FY/company filters explicit.
6. Add top customers, top vendors, top services/items by quantity and value, with a defined calculation and drill-down.
7. Improve invoice setting profiles: company-level template profile, header, footer/declaration, logo, bank details, dispatch/order fields, tax/HSN visibility, rounding policy, and per-document fixed note. Preserve the existing 22 themes rather than replacing them.
8. Add consistent PDF exports for reports, filtered registers, party statements, and collection lists. Exports must display filter context, organization, FY, generated time, and page count.

### Priority 3 - External Services And Long-Term Integration

1. Build a provider-neutral communications layer for SMS/WhatsApp/email reminders. It must require consent, template approval, rate limiting, status evidence, opt-out handling, and audit logs. Do not claim delivery unless a provider confirms it.
2. Implement GST e-invoice/e-way-bill integration only after provider credentials, IRP/GSP selection, sandbox testing, cancellation rules, and legal workflow are available.
3. If Tally integration is approved, build a separate connector service with read-only first synchronization, mapping review, reconciliations, idempotent cursor, failure queue, and owner approval before any write-back capability.
4. Consider a mobile/PWA reporting companion after stable APIs, identity, pagination, offline boundaries, and access rules are fully tested. Do not duplicate the financial posting engine on mobile.

## Features Not To Copy Blindly

- SMS credits, e-invoice links, Tally synchronization, and cloud backup labels are provider-dependent and cannot be treated as features without the required service agreements and credentials.
- Any visual similarity should remain high-level only. Tarangini must keep its own branding, terminology, invoice themes, role model, and customer/job workflow.
- A quick-create button must not allow operators to create unauthorized vouchers or bypass owner approval.
- Batch/godown/expiry fields should be optional modules, not compulsory fields for printing, services, or simple trading companies.

## Recommended Implementation Order

1. Priority 0 accounting/backup/reconciliation fixes.
2. Dashboard attention queue, report catalogue, and standardized large registers.
3. Credit-policy and collections workbench.
4. Optional inventory-location/batch controls and deeper sales/stock reports.
5. Provider integrations and a separately approved Tally connector.

## Audit Boundary

This is a functional comparison of the user-visible LiveKeeping experience. It is not a security assessment, API review, database inspection, reverse-engineering exercise, legal/tax certification, or a license to copy a third-party product.
