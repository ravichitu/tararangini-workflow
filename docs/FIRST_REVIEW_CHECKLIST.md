# First Review Checklist

## Automated Review Result

- Version 2.3.3 review gate passed on June 15, 2026.
- Passed security, backup round trip, accounting/features, user administration, job workflow, offline sync, version 2.3, Chrome responsive and Electron responsive suites.
- Web/mobile portal passed, so the Android foundation remains an installable PWA. A native APK is deferred until a device requirement cannot be met safely by the PWA.

## Required Environment

- Use a copy of the database, not the live billing database.
- Change recovery passwords and assign unique PINs.
- Keep one main server process and unique client device codes.
- Confirm automatic backup location and restore a test backup.

## Review Flows

1. Owner and operator PIN login, lock and unlock.
2. Company access restrictions using a limited operator.
3. Cash, bank, UPI, card and split invoices.
4. Receipt-voucher creation and bank-statement matching.
5. GST-inclusive and exclusive calculations on every regular-taxpayer transaction.
6. Round-off enabled and disabled calculations for regular and composition taxpayers.
7. Invoice correction request, rejection and approved Credit Note.
8. Stock purchase, sale, return and movement journal.
9. Mobile POS hold, resume and save.
10. Offline client queue, sync, duplicate and conflict handling.
11. Backup export, encrypted backup and restore rehearsal.
12. GSTR-1 JSON and Tally party-master XML export.
13. PWA installation from Android Chrome over HTTPS or localhost.
14. HTTPS health/redirect behavior and retention-safe maintenance.

## Release Gate

- All syntax checks pass.
- Every integration suite passes in isolation.
- Responsive Chrome and Electron tests pass.
- Installer is built only after tests.
- SHA-256 is recalculated after the final build.
- Separate `job-order-workflow-design` is never included in the package.

Run the complete gate with:

```powershell
npm.cmd run test:review
```
