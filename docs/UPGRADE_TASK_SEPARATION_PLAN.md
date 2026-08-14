# Tarangini Upgrade Task Separation Plan

Date: 2026-07-18
Status: Sequential execution plan. One task must pass its acceptance checks before the next task starts.

## Execution Rules

- Do not modify or rebuild the frozen Windows 7 module.
- Do not alter the frozen Billing backup.
- Do not merge the Billing and Job Workflow source trees directly.
- Keep accounting as the Main-System authority until offline posting has conflict, audit, recovery, and reconciliation tests.
- Every completed task must have focused tests and a short recorded result.
- Installer builds happen only after the selected task group passes regression tests.

## Task Queue

### Task 1 - Baseline, Preview, And Regression Gate

Status: COMPLETED

Scope:

- Verify the active source tree and current version.
- Verify invoice and quotation rendering for regular GST organizations.
- Keep the total section limited to Taxable Amount, CGST, SGST, and Final Total.
- Keep the separate HSN table above bank details.
- Confirm the HSN table does not change accounting calculations.

Acceptance:

- JavaScript syntax check passes.
- Responsive preview test passes.
- Quotation and invoice use the same GST presentation without payment status on quotations.

Result: `node --check public/app-2.4.0.js` and `npm.cmd run test:responsive-web` passed on 2026-07-18.

### Task 2 - Voucher Correction And Excess Receipt Safety

Status: COMPLETED

Scope:

- Owner-only edit of Payment Received and Payment Voucher.
- Mandatory correction reason and audit history.
- Operator edit/delete blocking.
- Atomic journal reposting.
- Excess receipt recorded as traceable party credit or advance.

Acceptance:

- Original voucher history remains preserved.
- Ledger remains balanced after correction.
- Duplicate payment and excess receipt tests pass.

Result: Owner-only correction, mandatory reason, stable voucher number, journal reposting, excess receipt credit, and operator blocking passed `npm.cmd run test:advanced-upgrades` on 2026-07-18.

### Task 3 - Backup And Restore Coverage

Status: COMPLETED

Scope:

- Include vouchers, allocations, party credits, audit logs, device registrations, sync metadata, jobs, and organizations.
- Verify restore into a clean database without overwriting the source.

Acceptance:

- Round-trip backup test passes for every included entity.
- Restore reports missing or incompatible records instead of silently dropping them.

Result: Portable backup now includes correction audit history. Payment allocations, vouchers, organizations, jobs, attachments, and audit records pass `npm.cmd run test:backup` on 2026-07-18.

### Task 4 - Controlled Offline Work And Device Enforcement

Status: COMPLETED

Scope:

- Durable local drafts and queues.
- Registered-device enforcement during synchronization.
- Provisional identifiers and server-owned final identifiers.
- Retry, idempotency, duplicate prevention, and visible conflicts.

Acceptance:

- Jobs, intake, quotations, challans, proformas, notes, and daily logs survive restart and synchronize once.
- Unregistered or revoked devices cannot synchronize.
- Financial posting remains blocked until Task 5 passes.

Result: Device registration, device identity, offline draft persistence, retry, duplicate protection, and synchronization passed `npm.cmd run test:device-registration`, `npm.cmd run test:device-identity`, and `npm.cmd run test:offline-sync` on 2026-07-18.

### Task 5 - Offline Financial Posting With Owner Conflict Review

Status: IN PROGRESS - SAFE FOUNDATION

Scope:

- Encrypted take-home replica or equivalent protected local ledger.
- Draft versus posted voucher states.
- Owner conflict-resolution interface.
- Controlled offline invoice, payment, and stock posting.

Acceptance:

- Financial-year locks, duplicate payment detection, stock conflicts, reversals, and owner approval are tested.
- Recovery from interrupted sync is idempotent and auditable.

Progress: The protected `offline_financial_drafts` state machine is durable and backup-aware. Registered devices can submit idempotent financial drafts; owners review them from `Settings > Offline Finance Review`, with operator access denied. Approval preflight blocks locked financial years, duplicate references and insufficient stock. Controlled owner-only posting now supports Payment Received, Payment Voucher, Sale, Purchase and Stock Adjustment with server-owned numbers, atomic accounting/stock effects and idempotent replay. Device revocation now blocks synchronization, securely clears the client's protected queue/cache on check-in and records acknowledgement. Organization-scoped read-only snapshots use protected local storage, schema versioning, SHA-256 verification and per-device cursors. Universal writable-replica versioning and field-level conflict merge remain gated.

### Task 6 - Local Customer Portal Mode

Status: IN PROGRESS - LAN INTAKE FOUNDATION

Scope:

- Owner selects an authorized client to host intake.
- Client IP and same-network QR display.
- Customer order creation and status lookup while Main System is unavailable.

Acceptance:

- Portal remains available during Main-System outage.
- Customer submissions synchronize without duplicates after reconnection.

Progress: Client setup now has an explicit opt-in for LAN customer portal mode. When enabled, the encrypted client proxy binds to LAN interfaces and reports a local portal base URL; default behavior remains localhost-only. Unauthenticated LAN access is restricted to customer intake config, analysis, submission, and status endpoints. Cached configuration, local submission, duplicate protection, local status lookup, staff API denial, and owner-only per-company QR generation pass `npm.cmd run test:local-portal`; existing synchronization also passes `npm.cmd run test:offline-sync` on 2026-07-18. Windows Firewall configuration remains a deployment step for the store network.

### Task 7 - Job Workflow Communication And Daily Reporting

Status: IN PROGRESS - INTERNAL NOTE FOUNDATION

Scope:

- Keep Daily Work Log focused on work done, pending work, time, job ID, and filenames.
- Keep owner/operator instructions and file discussions inside the job activity timeline.
- Preserve role visibility and completion locks.

Acceptance:

- Operator activity is linked to the correct job and daily log.
- Owner instructions are auditable and customer visibility is controlled.

Progress: Internal job notes are now persisted separately from customer conversations and daily-log activity. Owner/operator notes support typed instructions or progress updates, sanitized filename references only, job-detail display, auditing, and backup export/import coverage. This is intentionally not WhatsApp or customer-facing chat. Daily logs continue to hold time, pending work, miscellaneous work, and automatic job events.

### Task 8 - Performance, Diagnostics, And Capacity

Status: IN PROGRESS - DIAGNOSTICS AND INDEX FOUNDATION

Scope:

- Index and paginate large registers.
- Monitor queue depth, database locks, CPU, RAM, disk, attachments, and backup duration.
- Test concurrent customer uploads and PDF analysis.

Acceptance:

- Capacity report records tested users, uploads, memory, latency, and failure behavior.
- Slow operations identify a measurable bottleneck and mitigation.

Progress: Added production-safe indexes for large party, item, job, and intake lists. Added owner/diagnostics-only `/api/advanced/performance` reporting database page usage, WAL mode, queue depths, record counts, process memory/CPU, attachment-analysis state, and measured query time. Jobs, parties, and items now support optional bounded `limit`/`offset` pagination with `X-Total-Count` headers while preserving existing array responses. Pagination and diagnostics pass `npm.cmd run test:pagination` and `npm.cmd run test:deployment`. The 2026-07-18 300-customer upload benchmark passed 300/300 simultaneous uploads in 1.96 seconds, p95 latency 1.68 seconds, and RSS increase about 105 MB. The 100,000-record benchmark passed in 4.01 seconds with database integrity `ok`; invoice search measured 5.88 ms. Repeatable commands are `npm.cmd run test:customer-portal-300` and `npm.cmd run test:capacity`.

### Task 9 - External Integrations And Release

Status: REVIEW BUILD - GATED FEATURES REMAIN

Scope:

- GST e-invoice/e-way bill integration.
- Android application and public website preparation.
- Deployment documentation, installer, ZIP, hashes, and rollback notes.

Acceptance:

- Integration credentials are isolated from source and logs.
- Full regression suite passes before installer creation.
- Release artifacts identify exact source version and test result.

Progress: Added dry-run `/api/reports/gst/einvoice/preflight?bill_id=...` and `/api/reports/gst/ewaybill/preflight?bill_id=...` contracts. They validate taxpayer type, company/buyer GSTIN, invoice number/date, eligible document format, HSN/SAC, tax lines, transport fields, and vehicle/transporter references; they return normalized review payloads and credential-presence flags without exposing secrets or making live GSP/government calls. The complete release gate passed `npm.cmd run test:review`, `npm.cmd run test:capacity`, and `npm.cmd run test:customer-portal-300` on 2026-07-18/19. x64 NSIS and ZIP review artifacts were built from source version 1.1.6. Live e-invoice/e-way-bill submission, unrestricted offline sale/purchase/stock posting, and long-duration soak testing remain gated.

## Current Decision

Tasks are tracked independently and are not marked complete from planning alone. Tasks 1-4 have completed foundations, Task 5 remains a safe controlled-offline foundation, Task 6 has an opt-in LAN portal foundation, Task 7 has internal notes and daily-log integration, Task 8 has diagnostics, pagination, and benchmark validation, and Task 9 has GST preflight plus existing PWA/public-portal readiness. Live financial offline posting, live GST provider submission, long-duration soak testing, and release artifacts remain gated until their specific acceptance tests pass.
