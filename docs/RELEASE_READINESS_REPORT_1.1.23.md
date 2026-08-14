# Tarangini Workflow Suite 1.1.23 Release Readiness Report

Date: 2026-08-07
Target: Windows 10/11 x64

## Release Scope

- Physical Stock Count sessions snapshot active items and on-hand quantities at count start.
- Only an owner can approve a submitted count, with a written reason and an immutable audit trail.
- Approval checks current stock against the snapshot. If any movement occurred after the count started, Tarangini stops the posting with a stale-count conflict instead of applying an unsafe variance.
- Approved count variances create explicit `stock_count` movements and survive an integrity rebuild.
- Automatic Backup settings now include a review interval and a recorded isolated restore drill. It decrypts and validates a temporary database only; it does not replace live data.
- Report Centre provides full CSV exports and a print/PDF-friendly operational view. Browser printing is limited to the first 2,000 rows; CSV remains the complete export.

## Validation Results

- Focused stock, report print, backup drill, and dashboard tests: passed.
- Full review suite: passed, including security, permission hardening, transaction reset, operator logs, backup/restore, deployment, attachments, GST/tax, device identity/registration, offline queue/replica/drafts, local portal, document duplication, transaction controls, jobs, sync, and responsive UI.
- Operational audit: 9 passed, 0 failed, 0 warnings.
- Database capacity: 100,000 records saved in 11 seconds; SQLite integrity check passed. Exact invoice search was 24.6 ms in the test environment.
- Customer portal concurrency: 300/300 unique 64 KB uploads passed with zero failures.
- Customer portal heavy upload stress: 300/300 unique 5 MB multipart uploads passed with zero failures. Total attachment traffic was 1.5 GB in 59.11 seconds; server RSS increased by approximately 110 MB. The load generator used approximately 1.6 GB of RAM.
- Release-agent suite: passed. Its machine-readable evidence is in `output/release/Tarangini_Release_Test_Report.json`.
- Package integrity: the ZIP contains the desktop executable and `resources/app.asar`; installer, ZIP, and blockmap hashes were calculated after build.

## Artifacts

- Installer: `dist/Tarangini Workflow Suite Setup 1.1.23.exe` (112,111,677 bytes)
- Installer SHA-256: `A641414C63D42965830F56807197F83AA632EE7D9E9CA6378159F7C888EC1EA3`
- ZIP: `dist/Tarangini Workflow Suite-1.1.23-win.zip` (153,857,768 bytes)
- ZIP SHA-256: `F6AD8A707AC7E277D6CB422F69119A940C4BB86B1D3F1828EEED6BD2C5F26A78`
- Checksum file: `RELEASE_SHA256_1.1.23.txt`

## Deployment Notes

- Supported release target is Windows 10/11 x64. The Windows 7 build remains frozen and is not upgraded by this release.
- Keep the Main System on an SSD, run automatic encrypted backups to a different physical drive or secure network/sync location, and run a recorded restore drill at the configured interval.
- For the demonstrated 300 simultaneous 5 MB upload load, plan a dedicated Main System with at least 16 GB RAM, fast SSD storage, reliable LAN, and headroom for antivirus and Windows. The test proves this environment, not every PC configuration or public-internet connection.
- The installer is not Authenticode publisher-signed. SHA-256 verifies the exact file, but Windows SmartScreen can display an unknown-publisher warning. Apply an organization code-signing certificate before broad external distribution.
- A separate clean-PC install and operator acceptance test remains recommended before replacing a working production workstation.
