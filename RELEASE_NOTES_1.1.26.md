# Tarangini Workflow Suite 1.1.26

## Store Main Batch Preset

- Added `Run Web Invoice Batch - Store Main.cmd` to the installed `resources` folder.
- The launcher targets `http://192.168.0.104:3000` with default user `operator1` and organization `1`.
- It remains dry-run by default. Add `--count 50 --batch-id QA-STORE-001 --commit` only after reviewing a dry-run report.
