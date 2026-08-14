# Tarangini Workflow Suite Upgrade List

Status: Approved version 1.1.0 scope is implemented. Windows 7 is permanently frozen with no future upgrades or new installer builds. Unapproved future suggestions, the recorded payment-correction approval slice, e-invoice/e-way-bill integration and the stopped two-main-PC active-sync protocol are not included.

Version note: headings inherited from Billing Tool `2.x` releases record the source-feature lineage; the deployable merged Workflow Suite release is now version `1.1.3`.

Execution order: the dependency-ordered task queue and acceptance criteria are recorded in `docs/UPGRADE_TASK_SEPARATION_PLAN.md`. Tasks are completed one at a time; planning does not count as implementation.

## Prioritized Upgrade Roadmap

This priority order records all currently pending and previously recorded upgrades. No implementation or installer build is implied by this list.

### Priority 0 - Accounting And Data Safety

1. Owner-only editing of Payment Received vouchers and Payment Vouchers with mandatory correction reason, audit history, operator blocking, and atomic journal reposting.
2. Excess receipt handling: allocate the invoice balance and carry the remainder as traceable customer credit/advance for the next bill.
3. Controlled offline final invoices and payments only after device numbering, idempotency, duplicate prevention, payment/stock conflict rules, owner review, and reconciliation are approved.
4. Backup/restore verification for voucher edits, payment allocations, customer credit, audit history, and all organizations.
5. Digital-signature/DSC removal and replacement architecture after senior review, while preserving historical data and backup compatibility.

### Priority 1 - Reliable Client Operation

1. Replace repeated offline modal popups with a persistent Main System status indicator at the top of the screen.
2. Complete standalone client operation using encrypted local queues, local drafts, device IDs, provisional numbers, retry, conflict display, and sync history.
3. Add owner-controlled Local Customer Portal Mode on a selected client, including client IP display and same-network QR code.
4. Add operator assignment from offline job preparation with controlled sync and conflict review.
5. Add same-LAN client portal testing for multiple clients, restarts, server outage, reconnection, and duplicate submissions.

### Priority 2 - Workflow And Customer Experience

1. Improve offline customer intake, local order tracking, and portal status visibility.
2. Preserve service-category isolation and improve service-specific customer pages.
3. Complete customer approval replacement design after digital-signature removal.
4. Improve operator daily log suggestions and owner review workflow.
5. Add owner review and lock controls for completed jobs, payments, duplicate jobs, and corrections.

### Priority 3 - Scale, Performance, And Operations

1. Add indexed and summary-based financial reporting for very large databases.
2. Run a 24-hour pilot with 10 clients, unique 1-5 MB uploads, billing transactions, PDF analysis, backups, and monitoring.
3. Improve attachment queue visibility, storage monitoring, retention cleanup, and backup diagnostics.
4. Validate 300 simultaneous large uploads and PDF/image-analysis workloads on production hardware.
5. Add documented deployment monitoring for CPU, RAM, disk latency, database locks, queue depth, and backup duration.

### Priority 4 - External Integrations And Future Products

1. GST e-invoice and e-way-bill integration.
2. Android application rollout.
3. Public website rollout.
4. Future controlled multi-site/failover architecture only after a formal distributed accounting and conflict-resolution design.

### Frozen Or Stopped

- Windows 7 installer and future Windows 7 upgrades remain permanently frozen.
- Unrestricted automatic offline final invoice/payment creation remains disabled until Priority 0 controls pass.
- Two-main-PC active accounting synchronization remains stopped.
- No new DSC implementation is approved until the replacement architecture is reviewed.

## Uploaded DSC Specification Comparison

The uploaded architecture has been compared with the current source. The comparison and safe additive migration plan are recorded in `docs/DSC_SPEC_COMPARISON_AND_MIGRATION_PLAN.md`. The current decision is to preserve existing DSC fields and historical records, avoid deleting or renaming transaction tables, and wait for approval of the token vendor, middleware, archive policy, and real-token test plan before implementation.

## Uploaded Take-Home Offline Sync Specification Comparison

The take-home architecture has been compared with the current offline queue in `docs/TAKEHOME_SYNC_SPEC_COMPARISON.md`. It is recorded as a future upgrade, not as completed functionality. The current product has a protected queue/cache, device identity, provisional numbering, retry, duplicate checks and limited conflict handling; it does not yet provide a full encrypted SQLite replica, owner-approved device whitelist/revocation, universal entity versioning, bidirectional delta pull, or owner conflict-resolution UI. One Main System remains the accounting authority until those controls are implemented and tested.

## Version 1.1.8 Reliability-First Offline Accounting Guard

Completed and tested:

- Offline client entry now permits only quotation (`QUOT`), delivery challan (`DC`) and proforma (`PI`) drafts.
- Offline sale/POS and project-printing invoice creation is rejected with `OFFLINE_FINANCIAL_REVIEW_REQUIRED` instead of being queued as a final financial transaction.
- Existing online billing, Main-System invoice numbering, payment posting, stock posting and accounting behavior are unchanged.
- Offline quotation numbering remains device-scoped and idempotent; queued drafts continue to synchronize through the existing duplicate/conflict checks.
- Regression coverage verifies rejected offline sale creation, multiple offline drafts, retry synchronization and final server visibility.

This is a reliability guard, not unrestricted take-home accounting. Full take-home replicas, offline receipts/payments, stock changes and owner conflict-resolution UI remain future upgrades.

## Version 1.1.8 Owner Device Registration Foundation

Completed and tested:

- Owners can register a device ID against an organization from the authenticated advanced API.
- Owner device listings show system name, assigned person, fingerprint, MAC references, status and sync metadata.
- Owners can revoke a registered device with a mandatory reason; revocation is written to the audit log.
- A revoked device can be safely reactivated by the owner after its identity is verified.
- Organization access and owner-only authorization are enforced server-side.

Rollout boundary: mandatory rejection of unregistered offline synchronization is intentionally deferred until the client bootstrap/registration flow is added. This prevents existing clients with pending work from being stranded. The next sub-phase will send the device identity with every sync request and enforce active registration at the Main System API.

## Take-Home Replica And Conflict Foundations Started

Additive database foundations are now present for the requested take-home upgrades:

- `sync_cursors` tracks per-device pull and push progress.
- `sync_outbox` stores durable change envelopes with device, organization, entity, base version and replay status.
- `sync_conflicts` stores Main-System and incoming snapshots for owner review.
- The tables are currently metadata foundations only; the existing encrypted Electron queue remains active.

Not enabled yet: full database snapshot replication, SQLCipher/native replica encryption, owner keep-main/keep-incoming/manual-merge screens, or offline invoice/payment/stock ledger posting. Those require the next tested phases and remain deliberately gated.

## Remaining Upgrade Phase Started: Offline Store Integrity

Implemented and tested as an additive reliability slice:

- Protected client queue and cache envelopes now include a storage format marker and SHA-256 checksum.
- The checksum is verified after decryption before cached data is accepted.
- Tampered or partially written stores are quarantined and replaced with the safe fallback instead of being loaded silently.
- Existing protected stores without the new checksum remain backward-compatible and are upgraded on their next write.
- Offline synchronization, device registration, backup round-trip, and advanced-upgrade regression tests pass.

This is a foundation for the future encrypted take-home replica; it is not yet a full SQLCipher database replica or unrestricted offline accounting.

## Remaining Upgrade Phase: Encrypted Read-Only Organization Replica

Started and tested:

- Each validated organization snapshot is also stored as an organization-scoped encrypted replica file under the client offline data directory.
- Replica metadata records schema version, Main-System revision, source checksum and save time.
- Replica files use the same protected storage and integrity verification as the local queue/cache.
- Device revocation wipe removes replica files together with the queue and cache.
- Synchronization uses the encrypted replica revision as a read-only fallback when the normal cache snapshot is missing.
- The replica is read-only in this phase; offline writes still use the controlled queue and accounting safeguards.

## Remaining Upgrade Phase: Durable Conflict Replay Audit

Implemented and tested:

- Owner-completed conflict replays now create a separate immutable `sync_replay` record.
- Replay records retain the conflict, change ID, entity, owner reference, reason, and timestamp.
- Replay records are included in organization and all-company backup export/import.

Replay recording does not silently apply incoming data; the Main System remains the accounting authority.

The owner Sync Conflicts screen now displays the replay reference, completion reason and recorded time for completed replays.

## Remaining Upgrade Phase: Job Workflow Revision Events

Implemented and tested:

- Job creation, status transitions, delivery, work reports, and material consumption now append durable `sync_revisions` records.
- Client delta checks can detect these workflow changes using the existing organization/device cursor.
- Job workflow, offline synchronization, and backup regression tests pass.

Accounting tables remain Main-System controlled; this phase only improves read-only workflow synchronization and conflict detection.

Customer portal submissions now append `sync_revisions` events after successful intake creation, allowing local QR intake changes to participate in the same delta diagnostics.
Intake review/status changes and intake-to-job conversion now append revision events as well.
Portal party creation or completion of missing party contact fields now appends a party revision event.
Customer portal attachment records now append separate revision events, including file metadata and analysis state tracking.

This phase does not yet provide SQLCipher, bidirectional entity-level delta replication, or unrestricted offline posting.

## Recorded Requirement: Offline Work Continuity And Vouchers

The requirement that clients continue useful work offline and support controlled voucher creation is recorded in `docs/RECORDED_UPGRADE_OFFLINE_WORK_CONTINUITY_AND_VOUCHERS.md`. Current permitted offline work remains limited to non-posting drafts, jobs, intake, notes and workflow records. Offline Payment Received and Payment Voucher posting remains blocked until draft/post states, numbering, idempotency, allocation conflicts, owner review, reversal, backup and restore behavior are implemented and tested.

## Version 1.1.8 Persistent Offline Status Action

Completed and tested:

- Client connection status remains visible in the top bar without repeatedly interrupting data entry.
- The status chip now shows the client system name, online/offline state, pending queue count and conflict count.
- Clicking the chip opens `Offline Sync` so staff can review pending work or conflicts immediately.
- The chip provides accessible focus, hover and action text while preserving the existing offline locks.

## Planned Next Upgrade: Standalone Client And Local Customer Portal

The detailed implementation plan is recorded in `docs/NEXT_UPGRADE_STANDALONE_CLIENT_LOCAL_PORTAL_PLAN.md`. It covers non-blocking offline status, independent client queues, owner-controlled local customer intake with the client IP QR code, authenticated synchronization, conflict handling, security, and tests. It is planned only; no installer or functional implementation is included in this record.

## Recorded Upgrade: Payment Voucher Edit And Excess Receipt Credit

The requested voucher correction plan is recorded in `docs/RECORDED_UPGRADE_PAYMENT_VOUCHER_EDIT_AND_EXCESS_RECEIPT.md`. It covers owner-only edits with mandatory reasons and audit history, operator edit blocking, atomic journal reposting, and carrying excess customer receipts as traceable party credit for the next bill. It is recorded only; no functional implementation or installer build is included.

## Recorded Upgrade: Controlled Offline Final Invoices And Payments

Automatic unrestricted offline final invoice and payment creation is added to the upgrade list. The current application intentionally does not enable it: clients may create permitted offline jobs, quotations, customer intake requests, and queued workflow records, while final invoice numbering, payment posting, stock/accounting changes, and completed-job financial edits remain Main System controlled.

Future implementation must define device-scoped numbering, idempotency keys, duplicate prevention, payment conflict rules, stock conflict rules, financial-year locking, owner review, retry behavior, and audit/reconciliation before this capability is enabled. No functional implementation or installer build is included in this record.

## Version 1.1.7 Independent Offline Job Preparation

Completed in source and regression-tested:

- Each authorized client can prepare a job while the Main System is offline using its cached organization Service Catalog.
- Job entry provides `+ New Customer (works offline)` with required name and phone plus optional email and address.
- The unfinished job form, including new-customer details, is restored after refresh or an accidental page rerender.
- Offline jobs receive a device-scoped provisional token and remain in the local sync queue until the Main System returns.
- On sync, the server reuses a matching active customer by phone or name/email, otherwise creates the customer in the submitted organization; duplicate offline submissions remain idempotent.
- Existing cached customers without phone data remain compatible with the previous offline workflow.

Limit: service categories and services must have been opened online once on that client so the organization-scoped catalog is cached. Operator assignment from home remains a separate controlled queue/permission enhancement.

## Version 1.1.3 Common Warranty Customers And Job Draft Recovery

Completed and recorded:

- Warranty replacement entry now provides three organization-specific common ledgers: `Common Customer 1`, `Common Customer 2`, and `Common Customer 3`.
- Unknown walk-in customer name, phone, email and address are captured on the warranty case without creating or overwriting a permanent party master.
- Common ledger buckets remain hidden from normal party selectors and are available only in warranty replacement entry.
- Warranty search, display, backup export and import preserve the walk-in customer snapshot and selected common ledger.
- Registered customers continue using their normal party master and existing invoice/delivery validation.
- Job Order entry now saves an organization-specific browser draft as fields are entered and restores it after a page refresh or accidental rerender.
- Job drafts exclude file bytes and are cleared after successful job creation; owners/operators can clear the saved draft manually.
- Service categories, subcategories and services remain organization-scoped through the Service Catalog and are never merged between companies.

## Version 1.1.2 Quotation Print Controls Audit

Completed and recorded:

- Transaction controls are stored per company and protected by owner access; changing one company's settings does not change another company's quotation settings.
- Quotation defaults now hide `Payment Status`, `Prepared By`, and `Digital Signature` for new companies and existing companies after a one-time migration.
- The quotation renderer now respects the `Payment Status` print setting instead of always printing it.
- Owners can re-enable any of these fields under `Settings -> Transaction Controls -> Quotation` when a company requires them.
- Cross-company regression coverage verifies the defaults for all seeded companies.

## Version 1.1.2 Bits And Binary Quotation Party Identity Hotfix

Completed and recorded:

- Quotation entry now labels the party field as `Customer / Vendor Name`, matching computer-store vendor quotation usage.
- Typing in the party field immediately clears the previously selected hidden party ID, addresses and party details. A typed name alone can no longer silently retain the old vendor.
- Selecting an autocomplete result records and visibly displays the exact party ID, party type and location, allowing same-name and shared parties to be distinguished before save.
- Quotation save now verifies that the visible party selection, confirmed party ID and selected master record agree.
- The Bills API additionally rejects an optional submitted party-name confirmation when it does not match the selected party ID.
- The frontend/service-worker asset version was advanced so connected installed clients do not continue using the older cached quotation form.
- Regression coverage changes a Bits and Binary quotation between two shared vendors and verifies the party ID, saved snapshot, full quotation and transaction register all show the replacement vendor.
- Browser coverage proves that typing over the old vendor clears its identity before the replacement vendor is selected and saved.

## Version 1.1.0 All-Bills Search Correction

Completed and recorded:

- All Transactions now includes a real `All Bills` tab covering Sale, Project Printing, Quotation, Delivery Challan and Proforma records together.
- Bill-register searches now query the server instead of filtering only the latest rows already loaded in the browser.
- Bill number, party name, phone, GSTIN, saved party snapshot, PO number and description are searchable.
- Bill searches and the sidebar global transaction search now include previous financial years; the normal unfiltered register remains scoped to the selected financial year.
- The current-year register loads up to 500 rows, while explicit searches can return matching older records independently of that initial list.
- Regression coverage verifies finding a previous-financial-year quotation through both All Bills search and global transaction search.

## Version 1.1.0 Duplicate Quotation Party And Address Correction

Completed and recorded:

- Editing a duplicated quotation now updates the selected party ID and the saved party name, GST, contact and address snapshot together.
- Changing the party clears copied billing/delivery address IDs instead of incorrectly retaining addresses from the original quotation.
- Billing and delivery now default to the newly selected party's master address; an alternate address-book location remains optional.
- An explicit blank address selection is correctly treated as `Use party master address` during transaction edits.
- Shared-party address-book locations can be used by organizations that are authorized to use that shared party, while cross-party address selection remains blocked.
- Regression coverage verifies changing a duplicated quotation to a second party with the same name but a different address and confirms the new party ID and address snapshots are saved.

## Version 1.1.0 Party Address Book And Location Upgrade

Completed and recorded:

- Parties can now keep multiple billing, delivery, branch, village, town, department or site addresses under the same party/customer name.
- The original party master address is automatically preserved as a default address-book entry.
- Parties screen includes an Address Book action to add/delete saved locations with contact person, phone, email, city/village, district, state, pincode and GSTIN.
- Bills, quotations, delivery challans and proforma invoices can select separate billing and delivery addresses from the party address book.
- Selected billing and delivery addresses are saved as invoice snapshots, so old invoices keep their original address even if the party master changes later.
- Address validation blocks selecting an address that belongs to a different party, preventing accidental wrong-location billing.
- Party search now includes address/city/GST/phone context so same-name customers are easier to identify.
- Regression coverage verifies the government-office scenario: same office name, different location addresses, selected quotation address snapshot and cross-party address blocking.

## Version 1.1.0 Party Sharing And Similar-Name Selection Corrections

Completed and recorded:

- When `Share all organizations` is ticked, the party is now treated as available across all companies by the shared-party flag itself, not only by link rows. This prevents shared customers/vendors from disappearing in another organization when creating or duplicating transactions.
- Duplicating quotations, invoices, payments, purchases, notes and purchase orders now preserves a shared party across organizations instead of falling back to Cash Customer when the target company is allowed to use that party.
- Tally regular-party export now includes shared GST parties for the selected organization.
- Quotation/bill customer selection now protects against similar-name mistakes. If the user selects one party and then edits the visible customer name, the old hidden party ID is cleared unless the text still exactly matches the selected party.
- Saving a quotation/bill is blocked when the visible party name and selected party ID do not match, forcing the user to select the intended party from the dropdown.
- Party autocomplete now shows Party ID, party type, phone, GST, city and address context so names like `AIWC Kakinada` and `AIWC Kakinada - second party` are easier to distinguish before saving.
- Regression coverage verifies shared-party visibility in another company and duplicate quotation party preservation.

## Version 1.1.0 Production Health, Ledger Deposit And Warranty Dispatch Upgrade

Completed and recorded:

- Payment Received and Payment Voucher can now select a deposit/payment ledger, allowing owner personal accounts, separate bank accounts, UPI QR accounts, cash boxes or capital ledgers to be tracked distinctly.
- Receipt/payment accounting journals now post to the selected ledger when provided; old receipts continue to use automatic Cash or Bank / UPI posting.
- Payment registers show the selected ledger name.
- Duplicate payment vouchers preserve the selected ledger when a matching account exists in the target company.
- Backup export/import carries payment deposit ledger references where matching account codes are available.
- Warranty Replacement Tracking now includes service-center/company master records with category, brand, contact, phone, address and courier instructions.
- Warranty cases now record service center, courier vendor, courier tracking number, sent date, expected return date, RMA number, service-center contact and acknowledgement status.
- Warranty register now has quick filters for pending dispatch, sent to vendor, RMA received, follow-up due and replacement received.
- Backup export/import now includes warranty service-center master records and warranty dispatch/RMA fields.
- Data Diagnostics now includes a Production Health Dashboard showing server uptime, LAN IPs, customer portal link, mobile login link, connected clients, pending offline queue, sync conflicts, storage paths and backup age/settings.
- Sidebar global transaction search now searches bills, quotations, challans, receipts, payments, purchases, expenses, notes, purchase orders and journals by number, party, phone, GST, reference or description.
- Regression coverage verifies custom receipt ledger posting, warranty service-center dispatch tracking, production-health diagnostics and global transaction lookup.

## Version 1.0.0 Merged Workflow Suite

- Billing, accounting, POS, job workflow and customer portal now operate as one merged application baseline.
- Backup export/import now round-trips job orders, portal upload metadata, customer approval history and workflow audit records without permanently backing up normal attachment bytes.
- Data-shift batches and entity mapping are recorded to support safer migration, verification and troubleshooting.
- Customer portal uploads preserve attachment analysis data, including image dimensions and PDF page counts.
- Release packaging now builds both the Windows installer and a ZIP distribution artifact.
- The merged baseline is versioned separately as Tarangini Workflow Suite to reduce confusion with older billing-only releases.

## Version 1.0.0 Customer Intake And Portal Upgrade Record

Completed and recorded:

- Customer QR intake page is available as a separate public workflow entry point for each organization.
- Customer intake captures name, phone, email, address, preferred contact, service selection, item or device details, quantity, requested delivery date, summary, detailed instructions and consent.
- Same-network order-status lookup is available from the customer side using Order ID plus phone number.
- Customer-submitted intake requests can be reviewed by counter staff and converted into tracked production jobs with a generated job token.
- Intake attachments are carried forward into the converted job so the production side sees the same uploaded files and metadata.
- Customer portal uploads preserve original file bytes during active work and record permanent image/file/PDF metadata for JPG, PNG, WebP and PDF files.
- Customer PDF Analyzer is available on both the intake page and the customer job portal.
- PDF analysis records page count, page-size summary, uniform or mixed page-size status and orientation counts when readable.
- Customer print-intent recording for uploaded PDFs is available and stored for staff visibility, including:
  - colour print active flag
  - customer-confirmed total pages
  - customer-confirmed colour pages
  - customer-confirmed black-and-white pages
  - customer page-confirmation checkbox
  - customer notes for operator
- Operator and owner views already retain and display the above customer PDF metadata in job attachments.
- Customer-facing portal hides internal-only attachments until staff explicitly marks them visible.
- Customer additional-work approval flow is available with recorded digital confirmation and audit history.
- Delivery still links the completed job to the accounting and billing side through the existing final invoice flow:
  - job `party_id`
  - party snapshot
  - job token reference in bill custom data
  - linked receipts and payment allocations
- After delivery, customer status lookup now shows the linked Billing invoice number and payment status when available.
- After delivery, customer job portal now shows the linked Billing invoice number and payment status when available.
- Customer intake now creates or reuses a Billing party automatically during submission and stores that party link against the intake record.
- Intake-to-job conversion now reuses the linked party from intake by default, reducing duplicate customer creation.
- Customer status lookup now shows whether the Billing customer record is linked.
- After conversion, customer status lookup now shows the accepted quotation with line details and totals.
- Customer job portal now shows the accepted quotation with line details and totals.
- Customer portal landing page now shows Order ID tracking first, then service selection, before detailed form fields.
- Customer portal now behaves as separate in-page views: Home, Track Order, and New Request.
- The Track Existing Order button opens a dedicated tracking page/section instead of staying buried inside the form.
- Selecting a service family now opens a service-specific request page before the exact service and details are shown.
- Customer portal visual design has been upgraded with stronger landing cards, service tiles, motion, and mobile-friendly page navigation.
- Detailed customer/job fields are shown only after an exact service is selected.
- `brand`, `model`, `serial / ID`, and `quantity` fields are shown only for Computer Shop Services.
- Customer-selected upload files can now be previewed or removed before submission.
- Owner/operator intake review can download active customer-uploaded files as one ZIP bundle while files are still retained.
- PDF Analyzer now records best-effort colour-content detection and estimated colour/B/W pages when detectable.
- Unique Order ID is emphasized clearly after customer submission.
- Customer submit validation now shows an immediate popup/visible notification for missing details.
- Validation failure moves focus to the first field needing correction.
- Customer upload/submit state prevents accidental double-click duplicate submission.

## Version 1.0.0 Attachment Retention And Preview-Only Review

Completed and recorded:

- Normal customer and staff attachments are no longer treated as permanent backup payloads.
- Backup export keeps attachment metadata only, including file name, size, MIME type, hash, PDF/page analysis and print-request metadata.
- Physical attachment files remain available while work is active.
- Delivery/invoice completion starts a configurable retention timer, defaulting to 7 days.
- Expired attachment cleanup deletes only physical bytes and keeps the job attachment history row.
- Owner/counter users can move important or repeating-order attachments to Archive so they are excluded from auto-delete.
- Deleted attachments remain visible as metadata-only records in owner job history.
- Customer portal shows shared files as preview/review only and no longer provides a download-style file link.
- Customer preview returns an expiry message after retention cleanup instead of failing with a server error.

## Version 1.0.0 Job First-Bill Linkage

Completed and recorded:

- Owner/finance users can create a first bill directly from an accepted job estimate before production is completed.
- The first bill is linked back to the job through `pre_bill_id` and carries job references in invoice `custom_data`.
- Owner job detail shows the linked first bill number, amount and payment status.
- Customer job portal shows the linked bill number/payment status even before final delivery.
- Delivery reuses the linked first bill as the final job invoice when the final job total still matches the first bill.
- Duplicate final invoice creation is blocked when a linked first bill already exists.
- If approved additions change the final job amount after first billing, delivery stops with a clear message so a supplementary/correction billing path can be handled deliberately.
- Backup import/export carries the first-bill job link.

Remaining customer portal correction items:

- None.

## Version 1.0.0 Owner Work Order Record Upgrade

Completed and recorded:

- Requested behavior:
  - after completion of work, the job or work-order unique ID should retain the work description
  - descriptions, requests, remarks, estimates and related completion details should be visible to the owner in one place
- Implemented behavior:
  - job detail API now includes owner-oriented work-order aggregation under the unique job token
  - owner commercial view now keeps `counter_note` visible with the job detail payload
  - owner work-order aggregation combines:
    - customer request or commitment
    - counter note
    - item and service descriptions
    - accepted estimate lines and totals
    - work reports
    - additional-work records
    - delivery record details
    - status timeline
  - owner job detail screen now shows a consolidated `Owner Work Order Record`
  - status updates can now carry an owner-visible status remark
  - delivery flow now saves completion remarks together with warranty notes
  - focused workflow regression test now verifies the owner work-order record through creation, work reporting, additional-work flow and delivery
- Validation:
  - customer and owner workflow integration test passed
  - frontend syntax check passed

## Version 1.0.0 Job Material Consumption Upgrade

Completed and recorded:

- Jobs can now record inventory materials consumed during production as first-class workflow records.
- Each material entry stores the linked job ID, inventory item ID, item name snapshot, item code snapshot, quantity, unit, rate, notes, operator and timestamp.
- Recording job materials now creates linked stock-movement entries using source type `job_material` and the job token as the stock reference.
- Owner job detail and the consolidated owner work-order record now show consumed materials together with notes and operator attribution.
- Operator and owner job detail screens now show a dedicated `Materials Consumed` section, with in-workflow entry for authorized staff.
- Backup export and import now include job material consumption records alongside the rest of the production workflow data.
- Focused workflow regression test now verifies:
  - material consumption recording
  - owner visibility of the saved record
  - linked stock movement creation in inventory history
- Owner and finance job detail now also show a live production cost summary using:
  - accepted estimate value
  - approved additional-work value
  - recorded material cost
  - projected margin
  - final invoice and final margin after delivery
- Profitability reporting now includes a job-workflow profitability section with:
  - per-job projected revenue
  - per-job material cost
  - projected and final margins
  - delivered invoice linkage for completed jobs
- Customer intake service selection is now grouped by service family so customers can choose the department first and then the exact service.
- Owner dashboard now includes service-wise workflow boards for:
  - Printing Services
  - UV Printing
  - Book Binding / Finishing
  - Photo Printing
  - Photo Frames
  - Computer Shop Services
  - Other Services
- Service boards now show department-specific columns, work notes, quantity summary, assignment visibility and ready/unassigned queue counts without opening each job first.
- Online-readiness foundation is now recorded for future Android app and website work:
  - request, upload and rate limits are environment-configurable
  - customer intake supports idempotent retry keys
  - health and diagnostics expose deployment profile and target concurrency
  - default server readiness target is aligned to roughly 100-200 concurrent customer sessions
- Online-readiness implementation now also includes:
  - deployment profiles for `lan`, `store`, and `public`
  - attachment storage abstraction across `inline-db` and `filesystem` modes
  - asynchronous attachment analysis support for scaled upload profiles
  - durable SQLite queue, startup recovery and diagnostics for async attachment analysis
- metadata-only backup export/import compatibility across both attachment storage modes
  - focused regression coverage for filesystem storage plus async analysis

Always-on service upgrade:

- Main System can now run in optional headless Windows Service mode using `TaranginiWorkflowMain`.
- The service starts the server, customer portal, automatic backups, attachment storage and async analysis workers without opening the desktop window.
- Main / Client setup now includes service status plus install, restart, stop and uninstall controls for the Main System PC.
- The service helper self-elevates through Windows UAC for administrator-only service actions.
- Service mode is passed the saved Main-System `network.json` path so it uses the intended configured database, attachment and backup folders instead of accidentally using another Windows account's AppData.
- Diagnostics and health now expose service-mode status.
- Desktop tray keep-alive and Windows login startup remain available for shops that do not need pre-login service mode.
- This does not enable two-main-PC active sync or offline client writes; the single Main System remains the source of truth.

## Version 1.1.0 Client Availability And Section Standalone Upgrade

Completed and recorded:

- Dedicated client offline screen now appears when the desktop client cannot reach the Main System.
- The offline screen explains what can continue locally and what remains locked for accounting safety.
- Client offline screen provides direct actions for Retry Connection, Main / Client Setup, Offline Queue and Continue Locally.
- Customer QR intake API paths are now treated as public customer endpoints by the client proxy instead of requiring a logged-in operator token.
- When the Main System is offline, a section/client PC can save customer portal submissions into a protected local queue.
- Locally saved customer submissions receive a provisional `LOCAL-...` Order ID immediately, so the customer is not left without a reference.
- Same-section status lookup can show the locally saved customer request while waiting for Main System sync.
- When the Main System returns, the local customer request syncs into the normal intake table through the existing idempotent customer-intake API.
- The sync keeps the original customer details, request summary, consent, attachments payload and client request ID.
- Offline queue now labels records by type, including invoices, jobs and customer intake, instead of treating everything as an invoice.
- Accounting-sensitive actions remain deliberately restricted while offline; completed jobs, payments, invoice writes and duplicate-sensitive accounting still need Main System sync/review unless a future controlled offline-conflict engine is built.

Validation:

- Offline synchronization integration test now covers offline invoice, offline job and offline customer-intake queueing plus sync.
- Full `npm.cmd run test:review` passed after the upgrade.

## Version 1.1.0 Storage Location And Conflict-Control Upgrade

Completed and recorded:

- Keep accounting, parties, items, stock, invoices, payments and job orders in one linked business database for v1.0 so job-to-accounting references do not collide.
- Do not split accounting and job workflow into separate SQLite databases unless a future migration introduces a documented sync/compatibility layer.
- Store large customer uploads, photos, PDFs and production attachments outside the database in filesystem attachment storage.
- Support owner-configurable live database path, attachment path and second-drive backup path.
- Recommended deployment layout: live database on reliable local SSD, attachments on a large data drive, and automatic backups on a different physical hard disk.
- Normal attachment bytes should not be permanently backed up; only owner-archived important/repeating files should use a separate archive/backup rule.
- Main System setup now accepts optional database, attachment and second-drive backup folders.
- Main System startup validates configured folders before opening the server/database.
- Server startup honors the configured database folder, filesystem attachment folder and default automatic-backup folder.
- Health and owner diagnostics now report the active app-data folder, database path, attachment folder and backup folder.
- Owner/Senior-only correction reopening is required before moving a completed or ready-for-delivery job back into production.
- A correction/reopen reason is required and recorded in job audit history.
- Delivered/final-invoice-linked jobs remain locked; the reopen path does not unlock delivered accounting history.
- Payments cannot be posted into a closed POS shift; a new/open shift is required after handover close.

Validation:

- Deployment/maintenance integration test verifies active storage-location reporting and second-drive backup default.
- Attachment pipeline integration test verifies a custom filesystem attachment folder receives uploaded files.
- Job workflow integration test verifies operator reopen is blocked and owner reopen with reason is accepted before delivery.
- Advanced upgrade integration test verifies payments into a closed shift are blocked with HTTP 423.

## Version 2.4.0 Transaction Controls Audit

- Owner-only per-company Transaction Controls are available for all major transaction types.
- Hidden fields are not required and are omitted from print output.
- Sale, Project Printing, POS, vouchers, journals, purchases, notes, returns and purchase
  orders honor the configured visibility and validation rules.
- Transaction Control defaults, backup round trip and responsive settings behavior are tested.

## Version 2.3.3 Mobile POS Access

- Mobile POS displays Held Bills in the top-right header.
- The button shows the current number of held bills.
- Selecting it moves directly to the held-bill resume list.
- Existing hold, resume, payment and save behavior remains unchanged.

## Version 2.3.2 Deployment, Tax Entry And Reliability

- Inclusive-GST rate entry is available on every priced transaction for regular taxpayers.
- Nearest-rupee round-off is available for every taxpayer type and defaults to enabled.
- Signed round-off adjustments are saved, printed and posted to a dedicated ledger.
- HTTPS startup supports PEM and PFX certificates with an optional HTTP redirect listener.
- Health and diagnostics report transport security, database size and retention candidates.
- Owner maintenance removes only expired sessions and old revoked customer links; financial,
  stock, job and audit history is preserved.
- Additional database indexes protect reporting and maintenance performance as data grows.
- Electron packaging uses ASAR and is verified after the full review suite passes.

## Version 2.3.1 Invoice And Export Updates

- Per-company owner-selectable invoice themes: Classic, Sapphire, Emerald, Sunset and Common GST.
- Common GST accounting-style invoice layout for regular taxpayers.
- GST-inclusive item-rate default and printed inclusive-rate disclosure.
- GST-safe, company-specific invoice number prefixes.
- Logo crop, resize and positioning before saving.
- Tally Prime XML export for regular-GST Sundry Debtors and Sundry Creditors.
- Preloaded Bits & Binary computer catalogue with 26 common products, unique part codes and
  8-digit HSN classifications; existing user-edited items are never overwritten.

## Version 2.3.0 Payment, Mobile And Update Upgrades

1. Bank, UPI, and card invoice amounts remain receivable until a linked Receipt Voucher is created.
2. Cash and non-cash split payments with Paid, Partly Paid, Unpaid, and Overdue status.
3. Editable invoice-row descriptions and serial numbers preserved through print, edit, and duplicate.
4. Optional delivery recipient, phone, courier, tracking/LR number, and dispatch date.
5. Operator correction requests with owner approval/rejection and linked Credit Notes.
6. Operator collection/handover reports with owner acceptance and audit history.
7. Responsive LAN sales portal with barcode/manual entry and supported camera scanning.
8. Update Manager with backup, SHA-256 verification, LAN download, unsafe-upgrade blocking,
   client version warnings, and rollback recovery copies.
9. Daily username and PIN login with Owner1-controlled PIN assignment and reset.
10. Stock Movement Journal for purchase, sale, return, and correction references.
11. Offline searchable Help & FAQ included inside the application.
12. Dashboard QR code to open the mobile operator login from the same LAN.

## Version 2.0.0 POS And Production Upgrades

The following approved upgrades are implemented:

1. Fast keyboard-first POS counter.
2. USB barcode scanner and item-number entry.
3. 58 mm and 80 mm thermal receipts with optional automatic printing.
4. Cash, card, UPI, credit and split payments.
5. Hold and resume unfinished POS bills.
6. Invoice-linked returns, exchanges through rebilling, credit notes and refunds.
7. Counter shifts, opening cash, cash movements, closing count and variance.
8. Automatic bank column mapping and duplicate-file protection.
9. WhatsApp invoice and outstanding reminders.
10. AES-256 encrypted database backups and password-protected restore.
11. Profitability by invoice, item and customer.
12. Live intranet client and network-status dashboard.
13. Negative-stock prevention with an owner-controlled override.
14. Purchase orders, conversion to purchases, stock receipt and supplier payments.
15. Granular permissions for vouchers, reports and production tools.
16. Authorised signature image and invoice QR code.
17. Scheduled monthly CSV reports with optional SMTP email delivery.
18. Database integrity checks, accounting rebuild, stock rebuild and recovery copy.

Explicitly excluded by request:

- Manager approval workflow for discounts, returns, deletion and price changes.
- E-invoice and e-way-bill integration.

## Version 1.3.0 Invoice And Bank Upgrades

- Composition taxpayer invoices are Bill of Supply documents with no GST collection.
- Regular taxpayer invoices are Tax Invoices.
- Invoice notes moved to Settings > Invoice Settings.
- Bottom description and optional swipe/card charges added.
- New customers can be created and selected directly while entering an invoice.
- Project Printing Invoice added with file name, B/W prints, colour prints, number of books,
  each-book cost, optional charges, and its own voucher sequence.
- Project Printing sales are included in accounting, dashboard, customer, GST, and sales reports.
- Bank statement upload supports XLSX, XLS, and CSV with retained import history and matching.

## Accounting And Business Upgrades

1. Purchase Bills
   - Vendor invoices
   - Input GST
   - Accounts payable tracking

2. Expense Vouchers
   - Simple expense-entry workflow
   - Expense categories
   - Cash and bank payment posting

3. Inventory And Stock
   - Purchase and sales stock movement
   - Current stock
   - Low-stock alerts

4. Credit And Debit Notes
   - Sales returns
   - Purchase returns
   - Invoice and tax adjustments

5. Bank Reconciliation
   - Match software entries with bank statements
   - Identify missing and unmatched transactions

6. Invoice Payment Status
   - Paid, partly paid, unpaid, and overdue status
   - Due dates and outstanding amounts

7. GST Reports
   - GSTR-1 summary
   - GSTR-3B summary
   - HSN summary

8. User Permissions
   - Separate billing, accounting, reports, and administrator permissions
   - Restrict editing, deletion, and financial reports

9. Automatic Backups
   - Scheduled local or network backup
   - Optional backup to a selected synchronized cloud folder
   - Backup success and failure alerts

10. Audit Protection
    - Lock completed financial years
    - Prevent silent changes
    - Record edit and deletion history

11. Excel And PDF Export
    - Export all registers and financial reports
    - Printable standardized report layouts

12. Dashboard Alerts
    - Overdue customer payments
    - Cash and bank balances
    - Tax due
    - Low stock
   - Backup status

## Added Barcode Upgrade

- Automatic item number and barcode generation
- Company name, item name, model number, barcode, and MRP on labels
- 38 x 25 mm, 50 x 25 mm, 50 x 30 mm, and 70 x 40 mm label sizes
- Multiple-label printable sheets
- Fixed 100 mm label-printer roll with 1-up and 2-up printing
- A4 label sheets with selectable columns, horizontal gap, vertical gap, and page margins
- Opening stock and reorder level fields
- Invoices constrained and automatically scaled to one complete A4 page

## POS Upgrade Suggestions

These are suggestions only and are not approved for implementation.

1. Fast POS Billing Screen
   - Keyboard-first billing
   - Quick item search
   - Minimal clicks for checkout

2. Barcode Support
   - USB barcode scanner support
   - Barcode labels and printing
   - Multiple barcodes per product

3. Thermal Receipt Printing
   - 58 mm and 80 mm receipt formats
   - Automatic printing after sale
   - Reprint last receipt

4. Cash Counter And Shift Management
   - Opening cash
   - Cash added or removed
   - Shift closing and cash variance

5. Multiple Payment Methods
   - Cash, UPI, card, bank, and split payments
   - Payment reference capture

6. Hold And Resume Bills
   - Park an unfinished sale
   - Resume it from any permitted counter

7. Returns, Exchanges, And Refunds
   - Return against original invoice
   - Exchange items
   - Refund through original or selected payment method

8. Discounts And Price Rules
   - Line and bill discounts
   - Customer-specific prices
   - Quantity offers and scheduled promotions

9. Customer And Loyalty Features
   - Customer history
   - Loyalty points
   - Store credit
   - WhatsApp or SMS receipt integration

10. Counter And Device Management
    - Unique counter names
    - Cashier login
    - Device and printer assignment

11. POS Stock Controls
    - Real-time stock across all counters
    - Negative-stock prevention
    - Batch, expiry, serial number, or size/color support where required

12. POS Reports
    - Counter-wise and cashier-wise sales
    - Item, category, hour, and payment-mode analysis
    - Returns, discounts, and profit summary

13. Offline Continuity
    - Continue billing during temporary network interruption
    - Controlled synchronization after reconnection
    - Conflict and duplicate-invoice protection

14. POS Security
    - Manager approval for discounts, returns, deletion, and price changes
    - Complete cashier activity log

15. Day-End Closing
    - Sales and collection summary
    - Cash denomination counting
    - Variance report
    - Counter closing lock

## Suggested POS Priority

1. Fast POS billing screen
2. Barcode support
3. Thermal receipt printing
4. Multiple and split payments
5. Cash counter and shift management
6. Hold and resume bills
7. Returns and exchanges
8. Real-time stock controls
9. Day-end closing
10. POS reports and security

## Win10/Win11 Network Resilience Upgrade Record

Implemented in the Win10/Win11 line:

- Win7 installer/module is kept aside; future upgrades target the modern Win10/Win11 build.
- Client setup no longer asks the operator to type a manual client code.
- The desktop app now generates a stable automatic client identity from Windows system name, MAC references and a protected local installation seed.
- Each client stores an internal device ID and short device code for offline numbering and sync.
- Setup screen displays the original system name, assigned device code, device ID and MAC reference.
- Offline Sync status now shows the real system/display name, device ID and MAC reference so the owner can identify which physical PC has pending or conflicted work.
- Offline presence heartbeat uses the detected system/display name for the network dashboard.
- Delivered/final-invoice-linked jobs are now server-locked against new staff attachments, assignments, work reports, material consumption, additions and addition price/approval edits.
- Delivered-job lock returns HTTP 423 with a clear correction-required message and is covered by job workflow regression tests.
- Main System keep-alive mode is available on Win10/Win11: when enabled, closing the host window hides it to the Windows tray instead of stopping the server.
- The tray menu can reopen Tarangini, open Main/Client setup, or explicitly quit the Tarangini server.
- Main System setup includes an optional "Start Main System when Windows starts" boot-start setting for a dedicated server PC.
- Client API calls now time out with a clear "Main System is not responding" message instead of waiting indefinitely during power/network/server failure.

Completed:

- True Windows Service mode for environments where the server must run before user login.

Recorded for next implementation slices:

- Owner approval flow for payment corrections beyond current closed-shift/payment-entry locks.

Stopped / not to build now:

- Two-main-PC / two-location active sync protocol is stopped until explicitly re-approved later.
- Do not allow two Main Systems to independently write invoices, payments, stock movements, ledgers or job completion records.
- Reason: accounting, GST, invoice numbering, stock and payment conflicts can corrupt business records if both Main PCs write at the same time without a full high-availability conflict engine.

## Production-Level Stability Upgrade Record

Recorded production direction:

- Use one Main System as the source of truth for billing, accounting, jobs, stock, payments and customer portal data.
- Keep the live database on a reliable local SSD.
- Keep automatic backups on a different physical hard disk or reliable synced/network backup location.
- Keep clients/operators connected to the Main System through LAN/browser.
- If the Main System is off, clients should show offline/limited mode instead of creating final invoices, payments or stock-changing transactions.
- Safe offline records may include customer intake, upload metadata, operator notes and job progress notes.
- Unsafe offline records remain blocked unless a future controlled conflict engine is deliberately built:
  - final invoices
  - payments
  - stock deductions
  - financial year closing
  - deleted/cancelled transactions
  - duplicate-sensitive accounting entries

Implemented production upgrades:

- Add a Production Health Dashboard showing:
  - server running status
  - database path
  - attachment path
  - backup path
  - LAN IP address
  - customer portal QR/link
  - pending offline queue count
  - latest backup and restore-test status
- Add stronger backup safety:
  - daily automatic database backup
  - manual backup before every upgrade
  - keep the last 30 backups
  - monthly restore-test reminder/report
- Before public internet usage, prefer VPN/private tunnel first; if public hosting is used, require HTTPS, strong passwords/PIN policy, upload/login rate limits and owner/admin IP restrictions.

## Priority Database Backup Completeness Upgrade

Priority: High.

Implemented and recorded:

- Manual JSON backup/export now includes the previously missing business records:
  - shared-party company links
  - party address book / multiple party addresses
  - warranty replacement tracking
  - bank reconciliation records
  - GSTR-2B import headers and rows
- Manual JSON backup/import now restores additional accounting and business records:
  - party address book
  - shared-party links
  - purchases
  - purchase orders
  - expenses
  - credit/debit notes
  - financial year locks
  - warranty replacements
  - GSTR-2B import rows
  - bank statement imports and rows
  - bank reconciliation where rebuilt journal-line mapping can be matched
  - stock movements where source and item mapping can be resolved
- Restore rebuilds accounting journals after core documents are imported, then uses rebuilt journal entries/lines for statement and reconciliation remapping.
- Backup round-trip regression test now proves restore of:
  - company settings
  - item master
  - sale invoice and payment allocation
  - party address book
  - warranty replacement record
  - GSTR-2B import row
  - job workflow/customer portal records

Production rule:

- Automatic encrypted `.tbe` backup remains the safest full-database recovery backup because it copies the SQLite database.
- Manual JSON backup is now stronger for migration and selective restore, but full disaster recovery should still use encrypted automatic database backup plus recovery key.

## Transaction History And Deletion Control Upgrade Record

Implemented:

- Regular transaction saves now return to the saved transaction history/register instead of staying only on the print/preview flow.
- Sale, purchase, payment received, payment voucher, expense, notes, journal and project-printing invoice saves open the matching transaction register section after save.
- All Transactions now shows a contextual new-entry button for the selected tab, including "+ New Quotation" when the Quotations tab is selected.
- Transaction forms and previews now use document-specific labels such as Quotation No. / Quotation To, Challan No. / Delivered To, and Proforma No. / Proforma To instead of generic Bill No. / Bill To wording.
- POS billing remains the counter-speed exception and still opens the thermal receipt/next-bill flow.
- Owner delete/cancel action is available from the transaction register for bill-backed transactions.
- Owner deletion now requires a written reason before the bill is cancelled.
- Cancelled/deleted bills are soft-deleted and their original bill number is never reused.
- Delete reasons are written into the audit log for later owner review.
- Regression coverage verifies delete reason enforcement and bill-number non-reuse.

Completed performance and scale items:

- Server-side `limit` / `offset` pagination and search are now available for major transaction registers: bills, payments, purchases, expenses, credit/debit notes, journals and purchase orders.
- Heavy Excel/XLSX parsing is now lazy-loaded only when bank statement import is used, so normal billing, customer portal and job pages do not load it upfront.

## Party Address Book Upgrade Record

Recorded scenario:

- A business may have two parties with the same or similar name but different addresses.
- A single customer may also have multiple billing, branch, site or delivery addresses.
- During quotation, delivery challan, proforma invoice and sale invoice creation, staff must be able to select the correct party and correct address without confusion.
- Printed documents should show the selected address for that transaction, not accidentally change when the party master address is edited later.

Recommended workflow:

- Party search should show name, phone, GSTIN, city and short address so same-name parties can be distinguished.
- If they are actually different customers/vendors, create separate party records with unique phone/GSTIN/address details.
- If they are the same customer with multiple locations, use a Party Address Book under one party.
- Each transaction should store a snapshot of the selected billing and delivery address.

Implementation status:

- Multiple addresses per party are implemented.
- Address fields include label, type, contact person, phone, email, address, city, state, pincode, GSTIN override and billing/delivery defaults.
- Address types support billing, delivery, branch, site and other location-style workflows.
- Quotation, bill, challan and proforma creation can select billing and delivery addresses.
- Selected address snapshots print on documents and remain stable after party master changes.
- Party search now shows address context to reduce same-name selection mistakes.

## Client Offline Quotation And Main-System Recovery Hotfix 1.1.1

Implemented:

- Offline clients can queue Sale, Project Printing, Quotation, Delivery Challan and Proforma documents.
- Pending and conflicting local documents are merged into the cached All Transactions list while the Main System is unavailable.
- Local documents can be previewed immediately; edit, duplicate, correction and delete actions remain locked until synchronization.
- Known-offline clients return cached screens and document lists immediately instead of waiting for repeated network timeouts.
- Retry Connection now performs an actual health check and controlled LAN discovery.
- When the saved Main System IP is unreachable and exactly one valid Tarangini Main System is discovered, the client updates its stored URL atomically and reconnects.
- Automatic discovery does not choose when multiple Main Systems are detected, avoiding accidental connection to the wrong database.
- The offline warning can be dismissed for 10 minutes while staff continue permitted local work.
- Focused regression coverage verifies offline quotation save, immediate visibility, preview, idempotent synchronization, final server visibility and changed-IP rediscovery.

Operational finding on 2026-07-13:

- Client `DESKTOP-TUPBOCF` was configured for `http://192.168.0.41:3000` while using local IP `192.168.0.103`.
- No Main System answered on port 3000 anywhere in the `192.168.0.0/24` subnet during diagnosis.
- The client had no local `queue.json`; therefore its reported pending count of zero was accurate and quotations rejected by the older offline implementation were not recoverable from that client queue.
- Install the same 1.1.1 build on the Main System and all clients. Keep the Main System app, tray server or Windows Service running and allow private-network TCP port 3000.

## Operator Daily Log And Miscellaneous Work Upgrade Record

Implemented:

- Operators, senior operators, engineers and counter staff have a dedicated Daily Work Log page.
- Job reports, job status changes, assignments, material use, additional work, file records, invoice creation and invoice edits are collected automatically for the signed-in employee.
- Staff can add miscellaneous work such as customer support, maintenance, administration, training and other non-job activity.
- Manual entries record work done, pending work/blockers, optional linked job, start/completion time, duration and related filenames.
- Only sanitized filenames are stored in the operator log; the log does not upload or duplicate file content.
- Daily submission requires a work summary and locks the report against later entries.
- Owners can review, return or reopen a submitted report. Return/reopen actions require a reason and are audit logged.
- Owner dashboard summary shows each employee's report state and activity count for the selected company and date.
- Operators, senior operators and engineers can list, open, edit and duplicate only invoices they created.
- Operator invoice edits require a reason of at least 10 characters, recorded in the audit log and visible in daily activity.
- Operators cannot delete invoices; the existing owner-only soft-delete and mandatory deletion-reason controls remain unchanged.
- Operator default permissions no longer enable accounting reports, preventing accidental access to owner-level transaction reporting.
- Manual JSON migration backup/restore includes operator daily reports and miscellaneous entries. Encrypted full-database backups include them automatically.
- Focused API, security, backup and phone/tablet/desktop responsive regression coverage is included.

## Warranty Product Replacement Tracking Upgrade Record

Implemented:

- Added a dedicated Warranty Replacements module for computer-store service follow-up.
- Added required fields for party name, linked Delivery Challan/order, warranty product, serial number, number of items, request date and issue/follow-up note.
- Warranty cases receive a unique replacement number such as WR-2026-0001.
- Warranty cases track status, vendor/RMA reference, next follow-up date and resolution notes.
- Warranty records link to the selected customer party, item master product and Delivery Challan without changing existing invoice/accounting behavior.
- Warranty records can optionally link to the original Sale invoice, making the product chain visible from sale invoice to delivery challan/service dispatch to final customer follow-up.
- Owner/counter/operator workflow can review open cases, due follow-ups and completed/cancelled cases from one register.
- Create/update actions are audit logged.
- Regression coverage verifies required serial number validation, original Sale invoice linking, Delivery Challan linking, wrong-party sale-link blocking and follow-up updates.

Recorded warranty service-center scenario:

- Customer returns a sold product with a fault.
- Staff checks the warranty eligibility and accepts the product for warranty replacement/service.
- Staff prepares a Delivery Challan with the product item and serial number before sending it to the designated vendor, distributor or company service center.
- The service center/vendor may provide an RMA/service reference number during the sending or acceptance process.
- The item may be handed to a courier, requiring courier vendor name and tracking number for later follow-up.
- The owner/operator needs a fast category or service-center lookup to know where each product category/brand should be sent and to check current replacement status quickly.
- The already implemented warranty module is useful because it links customer, original Sale invoice, warranty product, serial number, item quantity, Delivery Challan, vendor/RMA reference, status, follow-up date and resolution notes.
## Version 1.1.10 Quotation -> Delivery Challan -> Invoice Workflow

- Added a backward-compatible transaction link layer for quotation, Delivery Challan and invoice relationships.
- Added line-level quantity allocations so partial Delivery Challans and partial invoices cannot exceed the source quantity.
- Added `POST /api/bills/:id/derive` with `target_format=DC|SALE`, source validation, duplicate-safe links, audit records and remaining-quantity validation.
- Delivery Challans retain internal rates for later invoicing but do not post stock; Sale invoices post accounting and stock as before.
- Added linked-document visibility to the full bill response and Create DC / Invoice actions in the bill list and preview.
- Added focused integration coverage for partial quantities, over-allocation rejection, invoice conversion and linked-document history.
