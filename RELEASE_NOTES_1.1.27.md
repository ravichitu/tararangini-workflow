# Tarangini Workflow Suite 1.1.27

## Batch Error Visibility

- Fixed Windows batch-runner reporting for client desktops.
- The launcher passes a Documents-based JSON report path directly to the app, so it does not depend on environment propagation.
- Failed runs now display the precise first error in the command window and preserve the full safe audit report.
