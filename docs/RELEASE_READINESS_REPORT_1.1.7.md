# Tarangini Workflow Suite 1.1.7 Release Readiness Report

Date: 2026-07-19
Release type: Tested x64 Windows review build

## Release Result

Version 1.1.7 passed the complete regression gate after the saved Payment Voucher edit correction. The installer and ZIP are ready for controlled installation and demonstration.

## Completed And Verified Areas

- Owner editing and reversal of saved Payment Received and Payment Vouchers with mandatory audit reasons.
- All Transactions edit access for saved Payment Vouchers.
- Stable voucher numbering, journal reposting, invoice allocations, and excess receipt credit.
- Billing, quotations, HSN/tax presentation, parties, items, stock, accounting, and financial-year locks.
- Job intake, customer portal, PDF/file analysis, job workflow, materials, delivery, internal notes, and operator daily logs.
- Device registration, local queues, offline synchronization, conflict handling, and controlled approved offline payment posting.
- Backup/export and clean-database restore coverage.
- LAN customer portal mode, HTTPS deployment checks, diagnostics, pagination, PWA/mobile responsiveness, and security hardening.
- Dry-run GST e-invoice and e-way-bill preflight validation.

## Test Evidence

- `npm.cmd run test:review`: passed all security, workflow, accounting, backup, offline, portal, and responsive suites.
- `npm.cmd run test:capacity`: 100,000 records, database integrity `ok`, 2.12 seconds insertion/save, 6.31 ms invoice search.
- `npm.cmd run test:customer-portal-300`: 300/300 uploads succeeded, 1.59 seconds total, 1.39 seconds p95 latency, zero failures.

## Release Artifacts

- Installer: `dist/Tarangini Workflow Suite Setup 1.1.7.exe`
- ZIP: `dist/Tarangini Workflow Suite-1.1.7-win.zip`
- Installer SHA-256: `56A19B2A3358AE5F066D2E940DD45B6BD35CEE96188AFD494AFCB2B5A12B9627`
- ZIP SHA-256: `CAF46A0EE12461AE36BA03AC84E4CAA68D6BB53397436B5B67328EF4F2560A50`

## Gated Future Work

- Live GST/GSP submission requires licensed provider credentials and sandbox certification.
- Offline sale, purchase, and stock final posting remains owner-gated; only approved payment-received drafts have controlled final posting.
- Long-duration production soak testing remains recommended before high-volume public internet rollout.

These gated items are not silently enabled in this release.
