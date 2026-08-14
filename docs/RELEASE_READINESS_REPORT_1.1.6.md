# Tarangini Workflow Suite 1.1.6 Release Readiness Report

Generated: 2026-07-16

## Executive Result

The release candidate passed the complete automated review suite and a 200-request concurrent health smoke. The installer can be built for Windows x64. The application is suitable for controlled LAN/store deployment with one Main System and multiple authenticated clients.

This report does not certify 200 simultaneous heavy uploads, invoice writes, or public-internet traffic. Those require a production profile, HTTPS, filesystem/object attachment storage, sufficient RAM/SSD, backup monitoring, and a load test using the actual expected files and network.

## Scope Audited

- Billing and invoice transactions: sale, POS, quotation, challan, proforma, project printing, returns, corrections, payments, purchases, expenses, notes, journal entries, purchase orders, bank statements and reconciliation.
- Job workflow: intake, customer/device details, service catalog, assignment, production stages, operator daily log, materials, completion, delivery and linked billing.
- Customer portal: QR intake, uploads, file metadata, PDF analysis, approval/status flow, preview and retention behavior.
- Organization isolation: company-scoped parties, items, categories, transactions and permissions.
- Security: authentication, PIN/session controls, role permissions, organization access, CORS/headers, financial-year locks and audit behavior.
- Reliability: offline invoice/job queue, idempotency, conflict handling, backups and restore.
- UI: responsive browser/mobile behavior and Electron renderer navigation.

## Test Agent Result

The repeatable agent is `tests/release-test-agent.js`. It generated:

- `output/release/Tarangini_Release_Test_Report.json`
- `output/release/Tarangini_Release_Test_Report.md`

All 16 suites passed:

1. Security
2. Security hardening
3. Operator daily log
4. Backup round-trip
5. Deployment maintenance
6. Attachment pipeline
7. Tax-inclusive transactions
8. Device identity
9. New features
10. Advanced upgrades
11. User administration
12. Job workflow
13. Offline synchronization
14. Version 2.3 compatibility
15. Responsive Chrome
16. Responsive UI

The 200-request health smoke passed with 200/200 successful responses. The measured result was p50 approximately 446 ms, p95 approximately 563 ms, and maximum approximately 574 ms on this development machine. This endpoint smoke does not represent full transaction or upload latency.

## Capacity Interpretation

The configured LAN/store baseline is 200 concurrent customer sessions. The public profile is configured for 300 target sessions, but that is a deployment target, not a guarantee.

Existing record-volume evidence:

- 100,000-record isolated database test: integrity passed; database approximately 28 MB; invoice search approximately 14 ms; monthly sales approximately 103 ms; party balance inputs approximately 168 ms.
- 10-million-row stress dataset: integrity passed; database approximately 1.77 GB; integrity check approximately 31 seconds.

Recommended operating limits:

- Store/LAN: up to 100-200 mixed customer sessions with one dedicated Main System, SSD and filesystem attachments.
- Accounting writes: keep operator/client write concurrency controlled by the Main System and offline idempotency rules.
- Large uploads: use `TARANGINI_DEPLOYMENT_PROFILE=store` or `public`, not the default inline database mode.
- Public internet: use HTTPS, reverse proxy, allowlisted origins, object/filesystem attachment storage and a realistic upload/write benchmark before advertising a user limit.

## Strengths

- Double-entry accounting and stock movements are linked to source transactions.
- Organization and permission checks are present across core routes.
- Offline queue uses client identity, idempotency and conflict safeguards.
- Backups include accounting, parties, items, jobs, portal metadata and remapped references.
- Customer files retain metadata and analysis history while retention rules can remove file bytes after completion.
- Android/PWA and website clients can use the same API foundation.
- Financial-year lock and audit trails reduce post-close changes.
- Full automated review passed before packaging.

## Deployment Conditions

- Use exactly one active Main System for the shared database.
- Keep the Main System on UPS and enable Windows Service/auto-start only on that PC.
- Keep clients on the same trusted LAN, or expose the server only through a secured VPN/HTTPS deployment.
- Configure a second-drive backup folder and verify restore periodically.
- Do not use the LAN profile for public internet uploads without changing storage and analysis settings.
- Do not treat a health smoke as proof that 200 people can upload 100 photos simultaneously.

## Known Boundaries

- Automatic cryptographic DSC PDF signing is not included; the external token/bridge process remains documented separately.
- A powered-off Main System is not reachable from home merely because clients have unique device IDs. Home access needs a reachable server, VPN or secure hosted deployment.
- Payments, completed-job edits and accounting changes remain controlled when the Main System is offline; unsafe blind posting is intentionally prevented.

## Release Decision

**Conditionally ready for review and controlled Windows x64 deployment.** The automated test suite is green. Before public internet use, complete a production-profile load test with representative uploads, HTTPS certificates, second-drive backup/restore verification and monitoring.
