# Tarangini Billing 2.3.3 Review Release

## Included

- Mobile POS Held Bills button in the top-right header.
- Live held-bill count.
- Direct jump to the existing held-bill resume list.
- All versioned frontend, cache, desktop, QR login and Update Manager references promoted
  to 2.3.3 to prevent stale mobile scripts.

## Inherited 2.3.2 Reliability

- Inclusive-GST entry on every priced regular-taxpayer transaction.
- Optional nearest-rupee round-off for every taxpayer type.
- HTTPS-ready hosting, ASAR packaging and retention-safe maintenance.
- Receipt-voucher accounting for bank, UPI and card collections.

## Release Gate

Review completed: June 15, 2026.

- All 39 application and test JavaScript files passed syntax checks.
- Production dependency audit reported zero vulnerabilities.
- `npm.cmd run test:review` passed security, backup, HTTPS deployment, GST/round-off,
  feature, administration, jobs, offline sync and responsive/mobile suites.
- The isolated 100,000-record capacity test passed database integrity and query checks.
- The installer and checksum are added only after these checks pass.

## Installer Verification

- Installer: `Tarangini Billing Setup 2.3.3.exe`
- SHA-256: `79EA36BD6083E59B9166BD10F05197B2CFFBBB82BC9115B58DE13173AD8F5A3B`
- Size: 108,376,874 bytes
- ASAR contains `server.js` and `public/app-2.3.3.js`.
- The obsolete `app-2.3.2.js` and separate Job Order/Production Workflow project are absent.
- Authenticode status is unsigned because no trusted code-signing certificate is configured.
- The packaged-server health launch was blocked by the execution environment quota and is
  not represented as passed.
