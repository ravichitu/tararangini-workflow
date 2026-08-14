# Tarangini Workflow Suite 1.1.8 Release Readiness Report

Date: 2026-07-19
Target: Windows 10/11 x64 review release

## Release Scope

- Organization-scoped protected take-home snapshots with SHA-256 verification.
- Append-only database revision tracking and registered-device delta pull.
- Automatic client snapshot refresh after Main-System changes.
- Revoked-device synchronization denial, protected local wipe and acknowledgement.
- Controlled offline Payment Received, Payment Voucher, Sale, Purchase and Stock Adjustment posting.
- Base-version conflict detection and idempotent replay for offline job status transitions.
- Portable backup/restore coverage for registered devices, cursors, outbox and conflicts.

## Explicit External Gates

- Live GST e-invoice/e-way-bill requires licensed GSP credentials and certification.
- Real PKCS#11/PAdES signing requires the selected DSC middleware and USB token validation.
- Native Android publishing and public hosting are separate deployment projects.
- Multi-day physical soak and customer-site Windows boot validation cannot be certified by source tests.

## Artifact Gate

All local artifact gates passed:

- Full 21-suite review: passed in 224.2 seconds.
- Capacity: 100,000 records inserted/saved in 3.4 seconds; SQLite integrity `ok`.
- Portal concurrency: 300/300 simultaneous uploads in 1.63 seconds; zero failures.
- Packaged executable: remained alive through a controlled 10-second isolated startup probe.

## Artifacts

- Installer: `dist/Tarangini Workflow Suite Setup 1.1.8.exe` (112,028,885 bytes)
- Installer SHA-256: `31B7BA4310301DF5FD3DFAFDE022AF06F12489D2CD555C553EA78F0AA64374AF`
- ZIP: `dist/Tarangini Workflow Suite-1.1.8-win.zip` (153,753,765 bytes)
- ZIP SHA-256: `AF099E306CFE542FE48F4E69859B8FEB4FB4E92A4BFC0ECB1DFA85C13FFF4F40`

## Signing Notice

The NSIS installer is not Authenticode publisher-signed. Its SHA-256 hash verifies artifact integrity, but Windows SmartScreen may still display an unknown-publisher warning. Production distribution should use an organization code-signing certificate.
