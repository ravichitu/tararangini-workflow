# Tarangini Billing Source Guide

## Runtime

- `server.js`: Express application startup, middleware, route registration and static web delivery.
- `electron/main.js`: Windows desktop host/client startup and local offline proxy lifecycle.
- `electron/offline-proxy.js`: client-side invoice queue, local numbering and controlled synchronization.
- `public/`: responsive browser/PWA interface used by desktop, LAN mobile and installed Android home-screen app.

## Business Modules

- `src/routes/bills.js`: invoices, split payments, correction requests, conversion and printing data.
- `src/routes/reports.js`: receipts/payments, financial/GST reports and Tally exports.
- `src/routes/business.js`: purchases, expenses, notes, stock journals and bank reconciliation.
- `src/routes/jobs.js`: integrated job-order workflow.
- `src/routes/job-portal.js`: token-limited customer approval portal.
- `src/accounting/accounting.js`: double-entry posting and settlement rules.
- `src/business/stock.js`: stock validation, movement replacement and summaries.
- `src/business/numbering.js`: company-specific GST-safe invoice numbering.

## Security And Ownership

- `src/middleware/auth.js`: JWT sessions, role permissions, company access and financial-year locks.
- The JWT signing secret is randomly generated once in the application data directory as `.jwt-secret`; it survives server restarts so pending offline work can synchronize without using a predictable fallback.
- `src/routes/auth.js`: PIN/recovery login, session refresh, user administration and audit records.
- Every route that accepts `org_id` uses company-access middleware.
- ID-based reads and writes must additionally validate the record's stored `org_id`.

## Data

- `src/db/schema.sql`: clean-install schema.
- `src/db/seed.sql`: recovery users and initial organizations.
- `src/db/db.js`: startup migrations, idempotent catalogue preload and rebuild initialization.
- Runtime database location is controlled by `TARANGINI_DATA_DIR`.
- `src/routes/backup.js`: company-scoped JSON export/import with company, item, party, invoice, receipt and allocation ID remapping.
- `src/services/automatic-backup.js`: full database backups to the owner-configured backup directory.

## Mobile And Android Foundation

- The mobile interface is the same responsive web application.
- `manifest.webmanifest` enables installation from Android Chrome.
- `service-worker.js` caches only the application shell.
- `/api/*` requests are never cached; billing remains online unless the controlled Electron offline queue is used.
- A native APK is intentionally deferred until the web/PWA review confirms device requirements.
- Customer intake now accepts `X-Idempotency-Key` so Android app and website retries can safely resubmit without duplicate order creation.
- `src/config/deployment-profile.js` centralizes request limits, upload limits, rate limits and the target concurrent-customer profile for future public deployment.
- `/api/health` and `/api/advanced/integrity` expose the active deployment profile so app, website and operations checks can verify the server mode before rollout.
- `src/services/attachment-storage.js` now abstracts attachment persistence across inline-database and filesystem-backed modes.
- `src/services/attachment-processing.js` supports synchronous analysis plus a durable SQLite-backed async worker so heavier public upload paths can be shifted off the immediate submit response and recovered after restart.

## Online Growth Notes

- The current merged build is now organized so Android app, website and PWA clients can share the same authenticated API contract.
- The present runtime now supports both `inline-db` and `filesystem` attachment storage, with `filesystem` intended for store/public growth profiles.
- The readiness baseline now assumes `100-200` simultaneous customer sessions for browsing, job intake and file submission, provided deployment uses HTTPS, enough RAM, and controlled upload sizing.

## Tests

- `tests/new-features.integration.js`: GST, exports, catalogue and core feature integration.
- `tests/advanced-upgrades.integration.js`: advanced accounting and workflow behavior.
- `tests/offline-sync.integration.js`: controlled offline invoice synchronization and conflicts.
- `tests/user-administration.integration.js`: PINs, roles, sessions and organization permissions.
- `tests/responsive-chrome.integration.js`: real Chrome mobile/POS/held-bill and responsive behavior.
- `tests/responsive-ui.integration.js`: Electron renderer sizing and navigation.
- `tests/job-workflow.integration.js`: integrated job workflow and customer approvals.
- `tests/security.integration.js`: headers, CORS and cross-company ID isolation.
- `tests/backup-roundtrip.integration.js`: clean-install backup restore with invoice descriptions, delivery details, item identity and receipt settlement.
- `tests/deployment-maintenance.integration.js`: PEM/PFX-ready HTTPS startup, redirect behavior, diagnostics and safe maintenance.
- `tests/tax-inclusive-transactions.integration.js`: inclusive-GST calculations, universal round-off and balanced rounding journals.

## Change Rules

1. Preserve existing database fields and add migrations for every new field.
2. Keep accounting entries balanced and stock movements linked to source records.
3. Never cache API responses in the PWA.
4. Never allow a record ID to bypass company access.
5. Add an integration test for every accounting, permission or synchronization change.
6. Retention maintenance must never delete financial, stock, job or audit history.
