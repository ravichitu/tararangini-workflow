# Tarangini Workflow Suite 1.1.23 Release Notes

Date: 2026-08-07

## Included

- Owner-approved Physical Stock Count workflow with immutable item snapshots, variance calculations, stale-snapshot protection, stock movements, cancellation controls, and audit records.
- Recorded isolated encrypted-backup restore drills with owner notes, review interval, retained evidence, and current/due status.
- Report Centre print/PDF views for operational registers, while CSV remains the complete large-register export.
- Integrity rebuild now retains approved physical stock-count movements rather than silently dropping them.

## Safety Rules

- Only owners can approve or cancel a physical stock count. Approval requires a reason and fails safely if stock moved after the snapshot.
- A restore drill never restores over the live database. It decrypts and validates a temporary copy, records the evidence, then removes the temporary files.
- The printed report view is limited to 2,000 rows. Use CSV for larger periods or source data.
- Existing invoices, payments, ledger history, jobs, and customer portal records are not rewritten by this upgrade.

## Release Validation

The release gate includes focused stock, backup, dashboard, offline, security, workflow, responsive, capacity, customer-portal, operational-audit, and packaging checks. Final commands and artifact checks are recorded in the release-readiness report generated with the installer.

## Deliberately Not Included

- Batch/expiry/godown inventory model.
- GST e-invoice/e-way bill gateway connection.
- SMS/email gateway connection.
- Android or public website publishing.
- A second writable accounting server or unrestricted offline final invoice/payment posting.
