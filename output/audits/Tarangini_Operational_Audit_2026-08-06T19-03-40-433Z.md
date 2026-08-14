# Tarangini Operational Audit Report

- Generated: 2026-08-06T19:03:46.880Z
- Application version: 1.1.22
- Audit database: isolated temporary fixture only
- Financial-year horizon: 12 years (2015-16 to 2026-27)
- Fixture retained: no

## Result Summary

- Passed: 8
- Findings: 1
- Warnings: 0
- Information: 0

## Audit Checks

- **PASS** - All simulated financial years have balanced journals and balance sheets
  Evidence: [{"fy":"2015-16","trial_difference":0,"balance_sheet_difference":0,"can_close":true},{"fy":"2016-17","trial_difference":0,"balance_sheet_difference":0,"can_close":true},{"fy":"2017-18","trial_difference":0,"balance_sheet_difference":0,"can_close":true},{"fy":"2018-19","trial_difference":0,"balance_sheet_difference":0,"can_close":true},{"fy":"2019-20","trial_difference":0,"balance_sheet_difference":0,"can_close":true},{"fy":"2020-21","trial_difference":0,"balance_sheet_difference":0,"can_close":true},{"fy":"2021-22","trial_difference":0,"balance_sheet_difference":0,"can_close":true},{"fy":"2022-23","trial_difference":0,"balance_sheet_difference":0,"can_close":true},{"fy":"2023-24","trial_difference":0,"balance_sheet_difference":0,"can_close":true},{"fy":"2024-25","trial_difference":0,"balance_sheet_difference":0,"can_close":true},{"fy":"2025-26","trial_difference":0,"balance_sheet_difference":0,"can_close":true},{"fy":"2026-27","trial_difference":0,"balance_sheet_difference":0,"can_close":true}]
  Upgrade: Block financial-year closing when a trial balance or balance-sheet difference exceeds the configured tolerance, and add owner-facing reconciliation details.
- **PASS** - Closed financial year blocks new financial posting
  Evidence: Close year 2016-17; post attempt returned HTTP 423.
  Upgrade: Ensure every future posting endpoint uses the same closed-financial-year guard and add release coverage for each transaction type.
- **PASS** - Stock balance equals opening stock plus source-linked movements across all tested years
  Evidence: Opening stock 100; qty out 13; current stock 87; expected 87.
  Upgrade: Add a scheduled stock-movement reconciliation report that compares item balances, movement sources, returns, and job-material consumption.
- **PASS** - Historic receivable remains visible to ageing and settlement reports
  Evidence: Dashboard receivable 118; historic invoice status overdue.
  Upgrade: Add ageing buckets, period-opening receivable balance, and owner alerts for invoices that remain unpaid after their due date.
- **FAIL** - Party statement includes only payments from the requested financial year
  Evidence: Requested 2026-27; statement closing balance 118; expected 0.00 for the settled in-year invoice.
  Upgrade: Filter party-statement payments by FY and calculate an explicit opening balance from transactions before the requested period; add a multi-year regression test.
- **PASS** - Another company cannot post an invoice using this company's party or item
  Evidence: Cross-company transaction attempt returned HTTP 400.
  Upgrade: Keep organization checks mandatory on every transaction, report, stock movement, party lookup, and future API endpoint.
- **PASS** - Organization backup contains the audited billing, payment, and stock movement records
  Evidence: Backup rows: bills 13, payments 12, stock movements 13.
  Upgrade: Run a periodic restore drill that verifies financial-year locks, payment allocations, journals, stock movements, and organization boundaries after restore.
- **PASS** - Multi-year report endpoints remain responsive on the isolated audit database
  Evidence: 15 API samples; p50 14.88 ms; p95 44.32 ms; max 44.32 ms.
  Upgrade: Add production telemetry for slow report queries, WAL checkpoint duration, database lock waits, RAM, disk latency, and queue depth.
- **PASS** - SQLite integrity, foreign keys, and audited query plans are healthy
  Evidence: Integrity ok; foreign-key violations 0; query plans SEARCH bills USING COVERING INDEX idx_bills_org_fy_date (org_id=? AND fy=?) | SEARCH payments USING COVERING INDEX idx_payments_org_fy_date (org_id=? AND fy=?) | SEARCH stock_movements USING COVERING INDEX idx_stock_org_item_date (org_id=? AND item_id=?).
  Upgrade: Before deployment, block automatic backup success when SQLite integrity or foreign-key checks fail, and retain the diagnostic report for the owner.

## Database Separation Verified

- Companies are separated by `org_id` on transaction, stock, journal, and party data.
- Financial years are stored on billing, payment, purchase, expense, note, and journal-entry records.
- Stock is derived from `items.opening_stock` plus immutable-style source-linked `stock_movements`.
- Accounting is derived from source-linked `journal_entries` and `journal_lines`; payment settlement uses `payment_allocations`.

## Prioritized Upgrade List

- **P0** - Filter party-statement payments by FY and calculate an explicit opening balance from transactions before the requested period; add a multi-year regression test. (party_statement_payment_fy_scope)
- **P0** - Restrict the global integrity repair so it cannot rebuild accounting journals or stock movements inside a closed financial year without an explicit owner-approved recovery workflow. (architecture-audit: closed-year-repair)
- **P1** - Make financial-year backup exports complete and explicit: include purchases, expenses, notes, stock, audit, jobs, bank rows, and GSTR data, or clearly label the export as organization-wide rather than FY-scoped. (architecture-audit: fy-backup-completeness)
- **P1** - Add backup retention, off-device replication, restore drills, disk-space alarms, and verification reporting; daily full backups otherwise grow without a defined retention limit. (architecture-audit: backup-retention)
- **P1** - Paginate and set-optimize stock, ageing, invoice-status, party-statement, account-ledger, and bank-report endpoints before long-lived databases grow beyond normal operating volume. (architecture-audit: report-scaling)
- **P1** - Strengthen financial-year close with immutable signed snapshots, carry-forward records, controlled reopen approval, and an auditable forced-close workflow. (architecture-audit: close-immutability)
- **P2** - Move accounting amounts from floating-point REAL/Number values to integer paise or validated decimal arithmetic before repeated multi-year aggregation and reposting can accumulate rounding drift. (architecture-audit: monetary-precision)
- **P2** - Replace silent additive migration failures with versioned transactional migrations and post-migration validation for long-lived customer databases. (architecture-audit: migration-safety)
- **P1** - Schedule this isolated audit weekly and retain only its JSON/Markdown reports; alert the owner when a reconciliation or integrity check fails. (operational-audit-agent)
- **P2** - Add a financial-year archive and reporting policy before real data exceeds the operational query limits; keep all statutory records and backups intact. (long-horizon-capacity)
- **P2** - Run the existing 100k/million-row benchmarks and a 24-hour multi-device pilot on the target hardware before certifying throughput or concurrent upload capacity. (capacity-evidence)

## Capacity Evidence

- capacity-100k-results.json: available
- capacity-million-each-results.json: available

## Full Regression Suites

- Not run. Execute `npm.cmd run audit:operations -- --full-suite` for the complete regression and customer-portal pass.

## Limits

- This agent tests live application APIs against synthetic data in a separate database. It does not inspect customer data or certify production hardware.
- Heavy upload, multi-PC, network outage, and million-row results must be interpreted from the dedicated capacity/soak tests and a physical deployment pilot.
- The canonical existing roadmap remains `UPGRADE_LIST.md`; this report adds evidence-based audit recommendations and does not mark future upgrades as complete.
