# Web Invoice Batch Creator

This tool creates a controlled batch of clearly marked **QA SALE invoices** through the normal, authenticated Tarangini API. It is for accessibility checks, role-permission checks, demonstrations, and controlled test data only. It does not write directly to the database.

## What it checks

- authenticates as the role you choose, such as `operator1`
- uses only a company the logged-in role can access
- creates invoices through `POST /api/bills`, so normal bill numbering, audit, party, stock, ledger, GST, and permission rules run
- verifies every created/reused invoice through `GET /api/bills/:id/full`
- creates a JSON audit report with no password, PIN, or token
- reuses invoices carrying the same batch ID instead of creating duplicates on a rerun

## On a second desktop

1. Install the same Tarangini Workflow Suite version.
2. Configure it as a **CLIENT SYSTEM** and confirm it can open the Main System normally.
3. Open the installation folder's `resources` folder. The default path is `C:\Program Files\Tarangini Workflow Suite\resources`.
4. For this store network, double-click `Run Web Invoice Batch - Store Main.cmd`. It is preconfigured for `http://192.168.0.104:3000`, `operator1`, and company `1`. The launcher securely asks for the password or PIN and does not save it.
5. Start with a dry run. It writes its report under `Documents\Tarangini Batch Reports`.

Dry-run example:

```text
Run Web Invoice Batch - Store Main.cmd --count 5 --batch-id QA-OPERATOR-AUG16 --dry-run
```

Commit example after reviewing the dry run:

```text
Run Web Invoice Batch - Store Main.cmd --count 5 --batch-id QA-OPERATOR-AUG16 --commit
```

## Safety rules

- `--dry-run` is the default. Only `--commit` writes invoices or a QA party.
- Use a new batch ID for each planned test. Reuse the same ID only to resume or verify that batch.
- Keep one batch process per batch ID at a time. A concurrent launch with the same ID cannot be treated as a guaranteed atomic operation.
- The default party and item are explicitly named `Web Batch Customer - <batch ID>` and `Web Batch Test Service`.
- Do not use the tool for real customer invoices. The normal invoice form remains the correct route for live sales.
- The role must already have billing permission and access to the selected company. The tool never grants permissions or bypasses owner controls.

## Results

The report records the selected role, accessible company, planned invoices, created invoice numbers, reused invoice numbers, server validation failures, and final verification. It deliberately excludes the password/PIN and session token.

Use `--help` to see all supported arguments. The default amount is `100`, date is today, and the default count is `5`.
