# Operational Audit Agent

## Purpose

`npm run audit:operations` starts a temporary Tarangini server with a new test database. It uses the actual authenticated APIs to audit a 12-financial-year scenario and creates a dated JSON and Markdown report in `output/audits/`.

It does not open, copy, modify, or delete the installed application's database, attachments, or backups.

## Coverage

- Twelve financial years by default, configurable from 10 to 20 years.
- Sales, payment allocation, historic unpaid credit invoice, ageing, financial-year lock/close/reopen, stock movements, accounting journals, backup export, and company isolation.
- Trial balance and balance-sheet differences for every simulated year.
- SQLite integrity check, foreign-key check, basic index-plan evidence, and short report-latency samples.
- Current 100k and million-row benchmark files are attached to the audit report as evidence. They are not silently rerun because that would take substantial time and disk space.

## Commands

```powershell
npm.cmd run audit:operations
```

```powershell
$env:AUDIT_YEARS='15'
npm.cmd run audit:operations
```

Use `--keep-fixture` only when a developer needs to inspect the temporary test database. Use `--strict` for CI-style failure when the report contains a finding or warning.

```powershell
npm.cmd run audit:operations -- --keep-fixture --strict
```

Run the full application pass when preparing a release or a formal audit. It runs the complete review suite plus quotation/DC/invoice, customer intake, and 300-request customer-portal coverage, then adds the result to the operational audit report.

```powershell
npm.cmd run audit:operations -- --full-suite
```

## Reading The Result

- `pass`: the scenario behaved as expected.
- `fail`: a reproducible application or data-integrity finding. Treat as Priority 0 until reviewed.
- `warning`: the scenario needs an operational improvement or did not meet the target threshold.
- `info`: supporting evidence only.

The agent does not claim that synthetic results equal production capacity. Large upload workloads, 10+ client behavior, WAN reliability, and hardware limits still require the existing load/soak scripts and a physical pilot.

## Data Model Checks

The report explains the separation used by the application:

- `org_id` keeps company data separate.
- `fy` keeps financial transactions and journal entries in the correct year.
- `stock_movements` links each stock change to a source document and item.
- `journal_entries` and `journal_lines` form the accounting audit trail.
- `payment_allocations` links receipts to invoices without changing the original invoice.

The current canonical roadmap remains `UPGRADE_LIST.md`. The generated report adds an evidence-based prioritized list without marking any future upgrade as complete.

## Architecture Findings Included In Every Report

The generated upgrade list also preserves these reviewed risks until they are addressed:

- Priority 0: protect closed financial years from unrestricted global integrity rebuilds.
- Priority 1: make FY backup scope complete and truthful; add backup retention, off-device replication, restore drills, and disk alarms.
- Priority 1: paginate and set-optimize stock, ageing, invoice-status, party-statement, account-ledger, and bank reports for long-lived data.
- Priority 1: make closing immutable with signed snapshots, carry-forward records, controlled reopen approval, and audited forced-close handling.
- Priority 2: use integer paise or validated decimals instead of floating-point accounting values.
- Priority 2: replace silent schema-migration failures with versioned transactional migrations and validation.

These are architecture audit findings. The agent labels its API-simulation findings separately, so no static review item is misrepresented as an observed production incident.
