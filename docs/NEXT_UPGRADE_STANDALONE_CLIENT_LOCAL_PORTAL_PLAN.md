# Next Upgrade Plan: Standalone Client And Local Customer Portal

Status: Planned and recorded; implementation not started in this plan-only step.

## Objective

Allow every authorized client computer to continue useful work when the Main System is disconnected, without repeatedly blocking the operator with an offline modal. Show connection state in the application header and let the owner enable a controlled local customer-intake portal on a selected client computer.

## Important Boundary

Each client can work independently with its own encrypted local queue and local database/cache. Final accounting records, final invoice numbers, payments, stock posting, and completed-job financial changes must still synchronize through an authenticated API. This avoids duplicate invoice numbers, stock conflicts, and silent accounting divergence.

## Phase 1: Non-blocking Connection Experience

- Replace routine offline modal popups with a persistent header status chip: `Main Online`, `Main Offline`, `Local Mode`, `Sync Pending`, or `Sync Conflict`.
- Show the device name, device ID, organization, pending queue count, last successful sync time, and last connection error in a compact status panel.
- Show the detailed dialog only when the user clicks the status chip or chooses `Connection Details`.
- Keep the current retry, automatic discovery, sync, and conflict actions in that panel.
- Never interrupt data entry merely because a health check timed out; drafts and allowed local operations continue.

## Phase 2: Standalone Client Mode

- On first online authorization, cache the organization-scoped service catalog, permitted customer references, operator permissions, and required workflow configuration.
- Allow local job orders, quotations, customer intake requests, notes, work logs, and permitted non-final records while offline.
- Assign every local record a device ID, local sequence, UUID, and creation timestamp.
- Display provisional identifiers such as `LOCAL-C3-000123`; keep the central number assigned by the Main System after sync.
- Preserve local drafts and queued records across application restart and Windows restart.
- Keep payments, stock posting, final invoice creation, and locked/completed-job financial edits server-controlled unless a separately approved offline queue policy is implemented.

## Phase 3: Local Customer Intake Portal

- Add an owner-only `Enable Local Customer Portal` switch on the client dashboard.
- Start a local portal listener bound to the client LAN address, not the public internet and not `0.0.0.0` by default.
- Display the selected client IP, port, portal state, and QR code at the top of the dashboard.
- QR target: `http://<client-ip>:<local-port>/customer-intake.html?org=<org-id>&device=<device-id>`.
- Customers connected to the same Wi-Fi/LAN can scan the QR, select services, enter contact details, upload supported files, and receive a local order ID.
- Store only the local intake metadata and retained attachments according to the configured retention policy; queue the intake for Main System synchronization.
- Show local portal requests in the same client dashboard with a `Local`, `Synced`, `Conflict`, or `Needs Review` state.
- Provide `Stop Local Portal` and automatic shutdown when the owner logs out or disables the feature.

## Phase 4: Synchronization And Conflict Rules

- Use authenticated API calls with organization ID, client/device ID, local UUID, operation ID, and idempotency key.
- Server replays each operation once and returns the central ID and central number.
- If the same customer is entered on multiple clients, match by explicit customer ID first, then owner-review duplicate candidates; never silently merge uncertain parties.
- If two clients change the same job, retain both audit entries and place the operation in a conflict queue for owner review.
- Local QR order IDs remain traceable after conversion to central job/order IDs.
- Retry with exponential backoff and a visible queue state; never delete a failed operation automatically.

## Phase 5: Security And Network Controls

- Local portal requires a signed short-lived intake session and organization/device scope.
- Enforce file type, size, rate, and daily quota limits per client and per customer session.
- Use the Windows firewall rule only while Local Portal Mode is enabled.
- Keep the local portal on the private LAN; public internet access requires HTTPS reverse proxy and separate deployment hardening.
- Log portal start/stop, QR generation, uploads, sync, conflicts, and owner actions in the audit log.

## Phase 6: Verification Before Installer

- Unit tests for status-chip state transitions and modal suppression.
- Offline restart test with queued jobs, quotations, and customer intake.
- Same-LAN QR test from phone/tablet to a client IP.
- 4-client and 10-client concurrent local intake test.
- Duplicate customer, duplicate job, retry, conflict, and organization-isolation tests.
- Upload burst test with unique 1 MB and 5 MB images/PDFs.
- Backup/restore test for local queues and central sync metadata.
- Full regression suite must pass before a new installer is produced.

## Recommended Operating Model

Use one Main System for accounting authority and enable Local Customer Portal Mode only on the section computer where customers are physically connected. Other clients remain standalone for permitted work and sync later. Do not automatically promote multiple PCs to accounting Main Systems without a distributed-numbering and conflict-resolution design.

## Completion Criteria

The upgrade is complete only when the operator can continue data entry without repeated modal interruption, the owner can see local/central status at a glance, a phone can scan the client QR on the same network, the intake is stored locally while the Main System is off, and the record synchronizes once when the Main System returns.
