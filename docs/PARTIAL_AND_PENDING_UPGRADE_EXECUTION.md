# Partial And Pending Upgrade Execution

Date: 2026-07-24

## Completed In This Pass

- Added owner-reviewed manual sync merge snapshots. The snapshot is validated and audited, then queued for replay; it cannot directly overwrite job, stock, invoice, payment, or ledger data.
- Added safe offline job-status continuity. A registered client can queue only normal production progress for an already accepted assignment. Each replay carries the registered device ID, one idempotency key, and the source job version. A changed Main-System version creates a conflict instead of overwriting data.
- Corrected the 300-customer upload benchmark to distinguish browser-load-generator memory from Tarangini server memory and to use unique payloads, preventing attachment de-duplication from hiding real disk demand.
- Added consented external-WhatsApp audit records. Tarangini can record that staff opened a prepared message in WhatsApp, while keeping its state as `OPENED_EXTERNALLY`; it never represents that record as provider-confirmed delivery.
- Added WhatsApp-page consent controls and recent-activity history, including an evidence prompt for opt-in and an audited opt-out action.
- Restricted every job-by-ID operation, including communication status, messages, attachments, assignment, production status, materials, delivery, notes, and audit history, to the active user's organization. Shared parties remain supported through the selected organization context; cross-company access is denied and regression-tested.
- Added a configurable mixed-workload soak harness for health, quotation, job and customer-intake traffic, with a machine-readable report and isolated cleanup.
- Corrected customer-portal service-worker caching so customer-page navigation cannot overwrite the billing shell, and registered the worker from customer intake and job-status pages while continuing to exclude all API responses from cache.
- Added saved-document previews after job-order, warranty-replacement and sales-return saves, closing the identified secondary transaction-preview gaps.
- Expanded the owner diagnostics screen with company-scoped sync, attachment-analysis and intake queues, server memory/CPU/query timing, and company job/customer/file counts. Attachment metrics no longer reveal another organization's workload when a company is selected.
- Added a two-company job-and-attachment regression test that verifies each diagnostics response reports only that company's attachment count.
- Added missing startup-migration indexes for job attachments and customer-intake attachments, so existing installations receive the same fast job/file lookup paths as a newly created database.
- Added bill-summary indexes for monthly and party aggregation. In the isolated 100,000-record capacity run, monthly sales aggregation improved from about 269 ms to 40 ms and party aggregation from about 246 ms to 17 ms; bulk insertion remains well within the test gate while paying the normal small index-maintenance cost.
- Consolidated the owner dashboard's receivable and overdue calculations into one organization-filtered payment-allocation aggregation instead of two separate full allocation passes. Existing credit receivable and overdue results are regression-tested.
- Consolidated the dashboard's sales total, bill count, cash total, credit total, and quotation count into one company-and-financial-year bill summary instead of six repeated bill scans. Existing dashboard totals remain regression-tested.
- Moved dashboard low-stock detection into a focused database query, avoiding a full active-inventory load when only shortages are displayed. A zero-stock/reorder-level dashboard regression test confirms the owner-visible count and item remain correct.
- Corrected dashboard cash/bank balances to exclude soft-deleted manual journals while retaining their audit history. A regression test posts then owner-deletes a cash journal and verifies the displayed cash balance returns to its original value.
- Corrected supplier outstanding balances to exclude soft-deleted manual journals. A regression test posts then owner-deletes a payable journal and verifies the vendor no longer appears as outstanding.
- Restricted global network status, integrity/backup-path diagnostics, maintenance, and repair operations to all-organization owners. A restricted-owner regression test verifies those global operations are denied while normal primary-owner diagnostics still pass.
- Aligned the desktop navigation with the global-diagnostics policy: restricted owners no longer see Network Status or Data Diagnostics, and an old saved navigation state receives a clear all-organization-owner message instead of a failed page load.
- Kept company-scoped performance queues and counts available to restricted owners while withholding global database size/page details, host memory/CPU, and worker-wide status. A restricted-owner regression test verifies the split response.
- Restricted Update Manager status, package publishing, and package download to owners with access to all organizations. Restricted owners no longer see or open that global system page, preventing cross-company update administration.
- Restricted whole-database encrypted backup and restore to all-organization owners. Company-scoped owners cannot download another company's data or replace the shared database; the denial is covered by a job-workflow regression test.
- Restricted USB DSC hardware/certificate status probing to all-organization owners and hid the diagnostic control from restricted-owner Settings. This only protects server hardware information; it does not change the existing DSC workflow or records.
- Isolated scheduled reports by organization: schedule run/delete now verifies the saved schedule's organization, and restricted owners can create and view only their authorized-company schedules. Shared SMTP configuration is neither returned nor editable for restricted owners; only all-organization owners can manage it.
- Corrected cross-company editing: invoice and registered-transaction editors now switch to the saved record's organization before loading party, item, account, and transaction-control data. Invoice, purchase, and credit/debit-note APIs normalize missing item names from that company's master and reject foreign or inactive item IDs instead of saving blank/cross-company lines. Regression coverage verifies both behaviors.
- Strengthened per-company autosave: transaction drafts now save on input, every 10 seconds, app hide, and page exit; job-order drafts use persistent local storage rather than temporary session storage. Draft keys include the company, screen, and edited record, and company switching cannot copy an old company's form into the newly selected company.
- Added invoice-to-item-master capture: a manually typed invoice item now reuses an exact active item in the same company or creates a new company-scoped master item with its entered HSN, unit, GST, price, and description. The linked master ID is saved on the invoice and the creation is audited; other companies are never affected.

## Verified Evidence

| Check | Result |
| --- | --- |
| Offline job-status replay | Passed through the protected queue, active-device check, server version check, and Main-System status transition. |
| 300 x 5 MB customer upload test | 300 successful, 0 failed, 1.5 GB filesystem attachment storage, 39.13 seconds elapsed, 36.10 seconds P95, 133 MB server RSS growth. |
| 300 x 64 KB customer upload smoke test | 300 successful, 0 failed, 1.86 seconds elapsed, 91.12 MB server RSS growth. |
| Manual conflict merge | Focused offline-financial-drafts integration test passed. |

## Repeatable Soak Harness

Use `npm.cmd run test:soak-smoke` for a 10-client, 15-minute virtual mixed-workload run. The duration, client count and interval can be changed with `SOAK_SECONDS`, `SOAK_CLIENTS` and `SOAK_OPERATION_INTERVAL_MS`. It writes `output/soak/production-soak-report.json` and removes its isolated test data afterward.

This is a controlled pre-deployment harness, not a substitute for the required multi-day test on real client PCs.

## Remaining Gates

The following cannot honestly be marked complete until their real-world dependency is available:

- Multi-day and ten-client soak tests require a stable deployed Main System, real client computers, and elapsed operation time.
- Firewall lifecycle and clean Windows 10/11 installer verification require elevated, physical-machine validation.
- Public HTTPS deployment requires a domain, certificate/reverse proxy or hosting decision, and controlled production test.
- DSC signing requires the chosen token vendor middleware, PKCS#11 path, signing scope, and a non-production test certificate. No token PIN is stored by Tarangini.
- Native Android delivery requires an Android build environment, signing keystore, package identifier, and release-device test.
- General customer email/push/WhatsApp delivery requires approved provider credentials and consent policies. Existing status links and manually opened WhatsApp flows remain available without provider credentials.

## Safety Boundary

Offline final invoices, payments, stock posting, delivery completion, financial-year changes, user/role changes, and job reassignment are not silently enabled. They remain controlled Main-System operations so that accounting numbers, stock, and audit history cannot diverge.
