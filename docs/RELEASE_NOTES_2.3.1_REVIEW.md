# Tarangini Billing 2.3.1 First Review

Review completed: June 13, 2026

## Included

- Receipt-voucher settlement for bank, UPI and card invoices.
- Cash and non-cash split payments with paid, partly paid, unpaid and overdue status.
- Invoice-row descriptions and serial numbers.
- Delivery and dispatch details.
- Operator correction requests with owner review and linked Credit Notes.
- Operator shift collection and owner handover acceptance.
- Responsive LAN mobile sales and POS portal.
- Safe offline Electron client queue and conflict handling.
- Update Manager foundations, SHA-256 verification and unsafe-update blocking.
- PIN-based operator access, role administration and audit history.
- Company-specific invoice themes, GST-inclusive rate setting, GST exports and Tally party export.
- PWA install foundation for Android Chrome.

## Hardening

- Closed CORS by default with an explicit origin allowlist.
- Added browser security headers.
- Persisted a random JWT secret across safe server restarts.
- Enforced stored-company access on ID-based records.
- Prevented cross-company bank-statement and journal matching.
- Added clean-install backup round-trip verification.
- Excluded the development/runtime transaction database from installer and source package inputs.

## Validation

`npm.cmd run test:review` passed all integration and responsive suites on June 13, 2026.

Native APK packaging is intentionally deferred because the responsive PWA passed. No unsafe offline API caching is enabled.
