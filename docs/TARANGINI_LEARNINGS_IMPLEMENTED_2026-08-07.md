# Tarangini Billing Improvements - 2026-08-07

## Scope

This upgrade applies useful accounting and dashboard lessons directly inside Tarangini. It does not connect to, import from, export to, or depend on Tally, LiveKeeping, or any other accounting product. Tarangini remains the only accounting and workflow authority.

## Implemented

1. Financial-year party statements now show an explicit opening balance created from earlier bills and receipts. The selected year contains only that year's entries and payments.
2. Party opening balances now respect their configured Debit or Credit type in statements.
3. Integrity repair is blocked when any financial year is locked or closed. A global owner must either reopen the year through the normal process or explicitly request closed-year recovery with a documented 20-character reason. Every repair is audited.
4. Inventory & Stock now includes a read-only reconciliation result. It checks movement source links, job-material consumption links, and negative stock without changing any stock quantity.
5. Automatic encrypted backups retain a configurable number of verified `.tbe` files. Old automatic files are pruned only after a newly-created backup passes the isolated restore verification.
6. Automatic backup checks free disk space before it writes. Owners can configure the free-space threshold and see whether the backup folder shares the same disk volume as the live database.
7. The owner dashboard includes a Tarangini action queue for overdue invoices, low stock, missing HSN codes in regular-GST companies, and backup health. Each card opens the corresponding Tarangini screen; it does not alter accounting data.
8. Report Centre provides current-company CSV exports for Sales, Quotations, Delivery Challans, Purchases, Receipts, Payment Vouchers, Expenses, Credit/Debit Notes, Receivables Ageing, Stock Summary, Stock Movements, Cash/Bank Book, GST Sales, Profitability, and Party Master. CSV files open directly in Excel, LibreOffice, and Google Sheets.
9. Collections & Ageing provides current, 1-30, 31-60, 61-90, and 90+ day receivable buckets. Owners can record an auditable contact note, payment promise, promise date, dispute, no-response, or escalation outcome. It never creates or changes a receipt voucher.
10. Every company can maintain independent per-party credit limits, default credit days, and credit holds. New credit sales are blocked when a party is on hold or the new sale would exceed the company limit. Cash, bank, UPI, and card sales continue normally.
11. Credit due dates now use calendar-date arithmetic, preventing timezone-related one-day shifts in credit terms.
12. Physical Stock Counts create a date-stamped, item-by-item snapshot of live stock. Staff record physical quantities; only an owner can approve the variance with a written reason. Approval creates auditable stock movements, and approval is stopped if live stock changed after the count snapshot.
13. Automatic Backup settings include a restore-drill review interval. A global owner can run a recorded, non-destructive restore drill against an encrypted backup. The drill decrypts and checks a temporary database only; it never replaces the live database. Pass/fail evidence is retained for audit.
14. Report Centre exports now offer both full CSV download and a print-ready browser view for saving a PDF. The print view is intentionally limited to 2,000 rows to protect browser memory; CSV remains the complete export for larger registers.

## Owner Use

- Open `Settings > Automatic Backup` to select the backup folder, keep count, and minimum free space. Prefer another physical drive, a secure network share, or a cloud-synced folder over the database drive.
- Open `Inventory & Stock` to review the Stock Reconciliation section before posting a stock correction. Use `Physical Stock Count` for a counted variance; do not alter stock by changing an unrelated bill.
- Open `Party Statement`, select the company and financial year, and use the displayed opening and closing balances to review the period.
- Open `Reports > Report Centre`, select a financial year or a custom date range, and download the complete register as CSV or use `Print / PDF` for a formatted review copy. Use the current company selector before exporting.
- Open `Settings > Automatic Backup` and run a recorded restore drill at the chosen interval. A passed file copy is not enough; the isolated restore result is the recovery evidence.
- Open `Reports > Collections & Ageing` to record a call or payment promise. Actual money received must be saved in `Payment Received` so the invoice settlement and ledger stay correct.
- In `Collections & Ageing`, owners can open `Credit Policy` to set a limit, default credit days, or temporary hold for a party in the selected company.
- Treat `Diagnostics > Integrity Repair` as a recovery action only. Do not use it to correct ordinary transaction mistakes; use the normal owner edit, reversal, credit/debit note, or reopening process.

## Remaining Tarangini-Only Priorities

1. Optional batch, serial, expiry, and warehouse/godown tracking for organizations that need it.
2. Email delivery for explicitly approved report/document formats.
3. Keep GST e-invoice, e-way bill, SMS, Android, and public website work as separately approved future integrations.

## Verification

- `npm.cmd run test:advanced-upgrades`
- `npm.cmd run test:backup`
- `npm.cmd run test:dashboard-ui`
- `npm.cmd run audit:operations`
