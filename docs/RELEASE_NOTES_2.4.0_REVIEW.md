# Tarangini Billing 2.4.0 Review Notes

Review completed: June 17, 2026.

## Scope

- Per-company Transaction Controls for entry visibility, required validation and print output.
- Sale Invoice, Project Printing, Quotation, Proforma, Delivery Challan, POS, Receipt/Payment Voucher, Journal Voucher, Purchase, Purchase Order, Expense, Credit/Debit Note and Sales Return control coverage.
- POS print output, invoice print output and Project Printing print output aligned with owner-selected print toggles.
- Mobile QR and frontend asset version moved to 2.4.0.

## Verification

- `node --check` on touched server, Electron, route, test and frontend files.
- `node tests\new-features.integration.js`
- `npm.cmd run test:review`
- `npm.cmd run dist`

## Delivery

- Installer: `Tarangini Billing Setup 2.4.0.exe`
- SHA-256: `91A003EB3D75AF58616A8A753BCBA4CF126633D0D9E0840123F996988C8A5B63`
- Code signing: unsigned; trusted certificate not configured.
