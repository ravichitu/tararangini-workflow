# Tarangini 60-Upgrade Master Program

Date: 2026-07-19

Status rules:

- `COMPLETE`: implemented and covered by a passing focused or full regression test.
- `PARTIAL`: a safe foundation exists, but the entire acceptance condition is not proven.
- `PENDING`: implementation has not passed its acceptance gate.
- `EXTERNAL`: completion requires credentials, hardware, certification, or a deployment decision.
- No installer is produced until the selected release scope passes the complete gate.

## Priority 0 - Reliability And Offline Operation

| ID | Upgrade | Status | Evidence / remaining gate |
| --- | --- | --- | --- |
| 01 | Edit, Delete and Duplicate for every transaction | COMPLETE | All bills, payments, purchases, expenses, notes, purchase orders and manual journals; `test:advanced-upgrades` passed. |
| 02 | Owner-only deletion with mandatory reason | COMPLETE | Safe cancellation/reversal, audit record and stable number. |
| 03 | Rebuild ledger and stock after edits | COMPLETE | Atomic journal/stock replacement tests passed. |
| 04 | Replace repeated offline popup with header status | COMPLETE | API failures now update the status chip without opening the blocking overlay. |
| 05 | One-hour local continuation | COMPLETE | UI and regression assertion use a 60-minute suppression window. |
| 06 | Independent offline job preparation | PARTIAL | Job creation, customer intake and an accepted assignee's normal production-status transitions queue locally with device identity, idempotency and version checks; finance, delivery, reassignment and reopen actions remain Main-System-only. |
| 07 | Queue/draft survival across restart | COMPLETE | Protected atomic local stores and restart-oriented sync tests exist. |
| 08 | Offline Payment Received and Payment Voucher | COMPLETE | Both require owner approval and post atomically with server-owned PR/PV numbers. |
| 09 | Controlled offline Sale, Purchase and Stock posting | COMPLETE | Owner-approved adapters atomically post official Sale, Purchase and Stock Adjustment records. |
| 10 | Server-owned official financial numbering | COMPLETE | Payments, sales, purchases and stock adjustments allocate official numbers only inside Main-System posting transactions. |
| 11 | Idempotent retry and duplicate prevention | COMPLETE | Draft IDs, offline IDs, replay checks and tests pass for supported entities. |
| 12 | Owner conflict resolution | PARTIAL | Keep Main, Mark For Replay and a validated manual-merge snapshot are audited; a manual merge is explicitly queued for replay and never writes directly into accounting, stock or job records. Automated field-level merge policy remains intentionally unavailable. |
| 13 | Full encrypted take-home database | PARTIAL | Organization-scoped read-only snapshots now use protected local storage, schema versioning and SHA-256 verification; a writable SQLCipher replica is not implemented. |
| 14 | Device enforcement on every sync request | COMPLETE | Registration/revocation and API enforcement tests pass for current sync paths. |
| 15 | Revoked-device secure local wipe | COMPLETE | Revocation issues a wipe request; the client erases its protected queue/cache before replay, acknowledges the wipe, and the end-to-end test proves queued work is not posted. |
| 16 | Bidirectional revision-cursor synchronization | COMPLETE | Database revision triggers, registered-device delta API, push replay and throttled automatic protected snapshot refresh pass integration tests. |
| 17 | Client-hosted portal during Main outage | COMPLETE | Opt-in same-LAN portal, cached config, intake, status and sync tests pass. |
| 18 | Client IP and portal QR on dashboard | COMPLETE | Client status exposes LAN URL and organization-scoped QR. |
| 19 | Automatic private-network firewall lifecycle | PARTIAL | Save/switch lifecycle manages a Tarangini-only Private TCP 3001 LocalSubnet rule with UAC and status UI; physical elevated Windows validation remains. |
| 20 | Power-loss/corruption/year-boundary recovery | COMPLETE | Atomic stores, orphan-temp recovery, corrupt-store quarantine/diagnostics, idempotent retries, financial-year locks/boundaries and organization isolation pass regression tests. |

## Priority 1 - Workflow And Usability

| ID | Upgrade | Status | Evidence / remaining gate |
| --- | --- | --- | --- |
| 21 | Transaction autosave and recovery | COMPLETE | Transaction drafts restore across supported forms. |
| 22 | Preview after every saved transaction | PARTIAL | Bills, payments, purchases, expenses, notes, journals, purchase orders, POS, job orders, warranty replacements and sales returns now open a saved-document preview; a broader end-to-end UI audit remains the proof gate. |
| 23 | Prevent Job Order reset during entry | COMPLETE | Draft persistence and job workflow regression pass. |
| 24 | Organization service categories and department boards | COMPLETE | Catalog and service-board APIs/UI are organization scoped. |
| 25 | Existing, walk-in and Common Customer handling | COMPLETE | Party and warranty common-customer flows exist. |
| 26 | Complete warranty replacement lifecycle | COMPLETE | Product, serial, centre, RMA, courier, follow-up and delivery fields are implemented. |
| 27 | Same-name party/address correctness | COMPLETE | Multiple addresses and party identity tests pass. |
| 28 | Preserve party/address during edit and duplicate | COMPLETE | Transaction duplication and party snapshot fixes are covered by advanced tests. |
| 29 | Cross-organization shared parties | COMPLETE | Shared-party synchronization exists; regression remains part of release review. |
| 30 | Owner/operator job instructions | COMPLETE | Internal notes are separate, audited and backup-aware. |
| 31 | Focused Daily Work Log | COMPLETE | Work, pending, duration, job, miscellaneous work and filenames are covered. |
| 32 | Completion lock and controlled reopen | COMPLETE | Completion/reopen role and reason controls exist. |
| 33 | Customer quotation display and approval | COMPLETE | Portal status exposes accepted quotation and decisions. |
| 34 | Customer output preview without download | COMPLETE | Preview-only delivery is implemented for customer-facing output. |
| 35 | Attachment retention and archive override | COMPLETE | Retention worker, archive and physical-deletion audit exist. |
| 36 | Global company/party/document/job search | COMPLETE | Cross-year transaction search and indexed registers exist. |

## Priority 2 - Production Operations

| ID | Upgrade | Status | Evidence / remaining gate |
| --- | --- | --- | --- |
| 37 | Multi-day production soak | PARTIAL | A configurable isolated mixed-workload soak harness now produces latency, failure, and server-RSS evidence; a stable lab deployment and elapsed multi-day run remain required. |
| 38 | Ten-client continuous test | PARTIAL | The soak harness supports ten virtual clients; sustained ten-device physical-client validation remains required. |
| 39 | 100-200 active-user test | PARTIAL | Configuration and smoke/load foundations exist; 300 portal-upload requests pass, but a sustained mixed billing/job/portal hardware certification remains. |
| 40 | 300 customers with realistic 5 MB uploads | PARTIAL | Distinct-payload multipart run passed 300/300 concurrent 5 MB uploads (1.5 GB stored, zero failed requests); real deployment bandwidth, disk and multi-day workload certification remain. |
| 41 | CPU/RAM/disk/lock/queue/PDF monitoring | COMPLETE | Diagnostics performance endpoint reports these operational indicators. |
| 42 | Secondary-drive automatic backup | COMPLETE | Configurable encrypted scheduled backup directory supports another disk/network folder. |
| 43 | Scheduled restore verification | COMPLETE | Every scheduled/manual encrypted backup is restored into an isolated temporary database, checked for SQLite integrity and required schema, recorded in owner-visible history, and retried from the latest verified-good backup after failure. Valid and corrupt backup paths are integration-tested without replacing the live database. |
| 44 | Corruption-recovery documentation | COMPLETE | Backup, restore, recovery key and upgrade recovery documentation exist. |
| 45 | Windows service/autostart portal availability | PARTIAL | Service/autostart foundation exists; customer-site boot validation remains. |
| 46 | Windows 10/11 installer startup smoke test | PARTIAL | Packaged x64 executable passed a 10-second isolated Windows startup probe; clean-machine installer launch remains a deployment-site check. |
| 47 | Installer, ZIP, hashes and rollback | COMPLETE | Version 1.1.10 NSIS and ZIP built after review/capacity gates; SHA-256 hashes and rollback limitations are recorded. |

## Priority 3 - External And Future Channels

| ID | Upgrade | Status | Evidence / remaining gate |
| --- | --- | --- | --- |
| 48 | Live GST e-invoice | EXTERNAL | Preflight exists; licensed GSP credentials and sandbox certification required. |
| 49 | Live e-way bill | EXTERNAL | Preflight exists; GSP credentials and certification required. |
| 50 | Credential isolation and certification | EXTERNAL | Environment/config boundary exists; provider onboarding required. |
| 51 | PKCS#11/PAdES DSC architecture | EXTERNAL | Design approved; implementation needs selected token middleware and signing library proof. |
| 52 | Main-only temporary DSC PIN | PENDING | Required by design; real bridge not implemented. |
| 53 | Certificate expiry/token replacement | PENDING | Migration and renewal workflow documented, not implemented. |
| 54 | Signed-document versions/history | PENDING | Additive schema designed, not implemented. |
| 55 | Native Android application | PARTIAL | Responsive PWA/API foundation now includes independently registered customer-intake and customer-status shells; native APK packaging is intentionally deferred. |
| 56 | Public customer website | PARTIAL | Responsive customer service-selection, intake and tracking pages exist with safe static-shell caching; public hosting rollout is not deployed. |
| 57 | HTTPS public deployment | PARTIAL | HTTPS/config/security checks pass; production hosting and operations remain. |
| 58 | Filesystem/object attachment storage | COMPLETE | Active upload bytes are stored outside SQLite with metadata in the database. |
| 59 | Background upload/PDF workers | COMPLETE | Asynchronous attachment-analysis queue/worker and diagnostics exist. |
| 60 | Customer notifications | PARTIAL | Status links, recorded consent, queued message history, and audited external-WhatsApp opening records exist; general provider-confirmed WhatsApp, push and email delivery remain external. |

## Frozen Decisions

- No Windows 7 feature upgrades.
- No two-Main-PC accounting protocol.
- No direct shared-database clients.
- No Nitro PDF dependency.
- No unrestricted offline final accounting.
- No permanent backup of routine attachments.
- No chat inside the Daily Work Log; job instructions remain in internal job notes.

## Current Test State

- `npm.cmd run test:review`: passed on 2026-07-19 in 226.3 seconds after backup restore-verification hardening; all 21 chained suites passed.
- `npm.cmd run test:advanced-upgrades`: passed.
- `npm.cmd run test:offline-financial-drafts`: passed with Payment Received, Payment Voucher, Sale, Purchase and Stock Adjustment controlled posting and idempotent retries.
- `npm.cmd run test:local-portal`: passed with non-blocking offline status assertions.
- `npm.cmd run test:device-registration`: passed with revoked-device denial, wipe policy and organization-scoped snapshot checks.
- `npm.cmd run test:offline-sync`: passed with protected snapshot pull, end-to-end revoked-client queue wipe, and queued assigned-job status replay.
- `npm.cmd run test:capacity`: passed with 100,000 records, 35.55 MB database, 3.52-second insert/save and integrity `ok`.
- `npm.cmd run test:customer-portal-300`: passed 300/300 simultaneous distinct 64 KB uploads in 1.86 seconds with 0 failures; the report now separates load-generator and authenticated-server RSS.
- `npm.cmd run test:customer-portal-300-5mb`: passed 300/300 simultaneous distinct 5 MB multipart uploads in 39.13 seconds (P95 36.10 seconds), writing 1.5 GB to filesystem attachment storage with a 133 MB server RSS increase.
- `npm.cmd run test:soak-smoke` with a 5-second/2-client validation: passed 46 mixed health, quotation, job and customer-intake operations with 0 failures and 29.21 ms P95. The normal harness is configurable for ten virtual clients and longer runs.
- Version 1.1.10 installer/ZIP build: passed; exact files and SHA-256 hashes are in `RELEASE_READINESS_REPORT_1.1.10.md`.
