# Tarangini Workflow Suite 1.1.10 Release Readiness Report

Date: 2026-07-24
Target: Windows 10/11 x64 review release

## Added Since 1.1.9

- Every scheduled or manually triggered automatic backup is immediately restored into an isolated temporary database.
- Restore verification checks the SQLite header, `PRAGMA integrity_check`, required Tarangini tables and core record counts.
- Verification results and failures are retained in an owner-visible audit history and diagnostics response.
- The owner backup screen displays the latest result and provides a non-destructive `Verify Latest Backup` action.
- Failed verification is not reported as backup success; scheduling remains due from the latest verified-good backup.
- Temporary database, WAL and shared-memory files are removed after both successful and failed drills.

## Release Gate

- Full 23-suite review: passed in 200.3 seconds.
- Backup round trip: valid encrypted restore drill passed; deliberately corrupt backup was rejected and recorded; no decrypted temporary files remained.
- Deployment maintenance: passed.
- Capacity: 100,000 records inserted/saved in 4.02 seconds; 37.13 MB database; SQLite integrity `ok`.
- Portal concurrency: 300/300 simultaneous 64 KB uploads in 1.65 seconds; zero failures; 58.81 MB RSS increase.
- Installer and ZIP packaging: passed in 180.4 seconds for the company-isolation and persistent-autosave build.
- Packaged executable GUI startup probe: not rerun because desktop process-launch approval was unavailable; the source/Electron responsive suites and electron-builder packaging passed.

## Artifacts

- Installer: `dist/Tarangini Workflow Suite Setup 1.1.10.exe` (112,067,503 bytes)
- Installer SHA-256: `1FE13F4D73924FC7B737D8C3E82B9F8EB27A19FA98B1C19D9D5F45312E189599`
- ZIP: `dist/Tarangini Workflow Suite-1.1.10-win.zip` (153,799,852 bytes)
- ZIP SHA-256: `2729F060B887477449C2C62B0241426FCA2A3362B7712BA9919D388386B67E83`

## Signing Notice

The installer is not Authenticode publisher-signed. SHA-256 verifies file integrity, but Windows SmartScreen may display an unknown-publisher warning. Production distribution should use an organization code-signing certificate.

## Upgrade State

The 60-item master program now records 38 complete, 11 partial, 7 pending and 4 external items. Live GST/GSP, physical DSC hardware signing, native Android publishing, public hosting, multi-day soak and clean-machine site validation remain external or physical gates.
