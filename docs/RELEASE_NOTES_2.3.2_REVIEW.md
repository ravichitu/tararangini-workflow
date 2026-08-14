# Tarangini Billing 2.3.2 Review Release

Review completed: June 13, 2026

## Transaction Entry

- Every priced transaction for a regular taxpayer offers Rates Include GST entry.
- Sale, POS, project printing, purchase, expense, note, return, purchase order and job estimate paths persist the inclusive-tax choice.
- Every taxpayer type offers nearest-rupee round-off, enabled by default.
- Non-zero round-off is printed and posted to the dedicated Rounding Adjustment ledger.
- Exact-paise totals remain available by clearing the round-off control.

## Deployment And Reliability

- Optional HTTPS startup using PEM or PFX certificates.
- Optional HTTP-to-HTTPS redirect listener.
- Health and diagnostics expose secure transport and database maintenance information.
- Retention-safe owner maintenance removes expired sessions and old revoked customer links only.
- Database indexes improve reporting and maintenance performance.
- Electron distribution uses ASAR packaging.

## Validation

`npm.cmd run test:review` passed on June 13, 2026, including security, backup,
HTTPS deployment, inclusive GST, round-off accounting, jobs, offline sync and
real Chrome responsive/mobile tests.

Release artifacts are built only after this gate and are verified separately.

## Release Verification

- Installer SHA-256: `42A7F270D5047CA513EB517A2FB359C0C7A5F8821157521C239A312B4242E80D`
- ASAR contains the server and `app-2.3.2.js`; excluded projects are absent.
- Authenticode status: unsigned because no trusted code-signing certificate is configured.
- Packaged-runtime launch smoke check was blocked by the execution environment quota and is
  not represented as passed.
