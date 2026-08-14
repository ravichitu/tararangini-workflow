# Transaction Recording Automation

Run the complete reference recording suite with:

```powershell
npm.cmd run record:transactions
```

The recorder starts an isolated Tarangini server and database. It does not use or modify the live accounting database.

Artifacts are written to `output/playwright/transaction-recordings/<timestamp>/`:

- `index.html`: visual pass/fail report with links to every artifact.
- `diagnostic-report.json`: machine-readable errors, failed requests and timings.
- `videos/*.webm`: one video per transaction or intake flow.
- `screenshots/*.png`: final or failure screen for each flow.
- `traces/*.zip`: Playwright trace for detailed debugging.
- `isolated-test-data/`: the sample database used by that recording run.

The `LATEST.txt` file points to the newest recording directory.

Full traces use substantially more memory and disk space, so they are disabled for normal recording runs. Enable them only while isolating selected failures:

```powershell
$env:TARANGINI_RECORDING_TRACE='1'
$env:TARANGINI_RECORDING_FLOWS='04-proforma-invoice'
npm.cmd run record:transactions
```

Run one or more selected flows while diagnosing an issue:

```powershell
$env:TARANGINI_RECORDING_FLOWS='03-delivery-challan,04-proforma-invoice'
npm.cmd run record:transactions
```

Chrome is used from `C:\Program Files\Google\Chrome\Application\chrome.exe`. Override it when needed:

```powershell
$env:TARANGINI_RECORDING_CHROME='D:\Apps\Chrome\chrome.exe'
npm.cmd run record:transactions
```

The output contains sample customer, party and transaction information only. Do not replace the isolated database path with the live data directory.
