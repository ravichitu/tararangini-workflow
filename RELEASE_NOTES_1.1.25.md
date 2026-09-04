# Tarangini Workflow Suite 1.1.25

## Web Invoice Batch Creator

- Added a controlled web/API invoice batch runner for a configured Main System or a client desktop.
- Uses a real Tarangini username and secure password/PIN prompt; it never stores the credential or API session token.
- Creates only clearly marked QA Sale invoices through the normal API so existing company permissions, GST/item validation, audit records, numbering, stock, and ledger logic remain active.
- Defaults to dry-run and requires `--commit` for writes.
- Repeating a completed batch ID reuses its existing tagged invoices rather than adding duplicates.
- Writes a secret-free JSON audit report to `Documents\Tarangini Batch Reports` on the machine running the launcher.

## Deployment

- The installer includes `Run Web Invoice Batch.cmd`, `run-web-invoice-batch.ps1`, and `WEB_INVOICE_BATCH_CREATOR.md` in its `resources` folder.
- No Node.js installation is required on the second desktop; the launcher invokes the installed Tarangini application directly.

## Validation

- Added automated coverage for operator-role invoice creation, re-run idempotency, dry-run non-writing behavior, verification ownership, and report secret exclusion.
- Performed a live local proof as `operator1`: three tagged invoices were created and a repeat run reused all three.
