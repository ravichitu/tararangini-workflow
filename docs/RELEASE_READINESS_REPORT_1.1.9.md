# Tarangini Workflow Suite 1.1.9 Release Readiness Report

Date: 2026-07-19
Target: Windows 10/11 x64 review release

## Added Since 1.1.8

- Corrupt protected client queue/cache files are quarantined with visible diagnostics.
- Valid orphan `.tmp` stores recover automatically after an interrupted atomic write.
- Financial-year boundary numbering is explicitly tested across March 31 and April 1.
- Local Portal Mode manages a Tarangini-specific Windows Private-profile TCP 3001 firewall rule restricted to `LocalSubnet`.
- Disabling Local Portal Mode or switching away from Client mode removes only that Tarangini rule.

## Release Gate

All local gates passed:

- Full 21-suite review: passed in 203.2 seconds.
- Capacity: 100,000 records inserted/saved in 3.45 seconds; SQLite integrity `ok`.
- Portal concurrency: 300/300 simultaneous uploads in 1.61 seconds; zero failures.
- Firewall PowerShell helper: parser validation passed.
- Packaged executable: remained alive through a controlled 10-second isolated startup probe.

## Artifacts

- Installer: `dist/Tarangini Workflow Suite Setup 1.1.9.exe` (112,030,188 bytes)
- Installer SHA-256: `06386D2CA6E1356511A536E8924BDCBC8FE662AA26212F4D951360A955B13998`
- ZIP: `dist/Tarangini Workflow Suite-1.1.9-win.zip` (153,754,905 bytes)
- ZIP SHA-256: `F6E52E291B66BAB4F93F306F2A7908819AC631866332F2E7AB9F408E0CB18110`

## Signing Notice

The installer is not Authenticode publisher-signed. SHA-256 verifies file integrity, but Windows SmartScreen may display an unknown-publisher warning. Production distribution should use an organization code-signing certificate.

## External Limits

Live GST/GSP, real DSC hardware signing, native Android publishing, public hosting, multi-day soak and clean-machine site validation remain separate external or physical gates.
