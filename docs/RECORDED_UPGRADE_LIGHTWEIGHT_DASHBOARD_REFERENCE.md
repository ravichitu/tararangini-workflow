# Recorded Upgrade - Lightweight Dashboard Reference

Date: 2026-08-06
Status: Recorded only. No live dashboard behavior or styling was changed by this record.

## Reference Intent

The supplied dashboard is a usability reference. The requested direction is a dashboard that feels clean, light, compact, quick to scan, and suitable for everyday billing work. It must use Tarangini's own identity and data model; it must not copy the third-party product's branding, assets, labels, or layout verbatim.

## What To Carry Forward

- Keep a narrow, stable left navigation with clear module groups and short labels.
- Use a bright, low-clutter content area with simple white cards and restrained borders.
- Show the active company and active financial year prominently at the top of the workspace.
- Put the most important operating values first: cash, bank, receivables, payables, inventory value, and current-period sales/receipts.
- Add a clearly separated attention area for actionable exceptions, such as overdue receivables, low stock, sync failures, pending approvals, unassigned jobs, and failed backups.
- Use one compact monthly sales-versus-receipts chart and one receivables-ageing chart. Each chart must have a text/table alternative for accessibility and printing.
- Add direct click-through from every summary card to its properly filtered Tarangini report or transaction list.
- Keep quick-create actions visible but permission-aware: owners see all permitted transactions; operators see only their allowed actions; customer portal actions never appear in internal navigation.
- Prefer lazy-loaded charts, aggregate queries, pagination, and cached organization-scoped summaries so the dashboard remains responsive with long financial history.
- Use concise labels, readable currency, visible empty states, keyboard focus, mobile/tablet layout, and no decorative animation that delays work.

## Tarangini-Specific Dashboard Groups

1. Financial summary: sales, receipts, cash, bank, receivables, payables, tax due, and stock value.
2. Attention queue: unpaid/overdue invoices, low stock, pending payment corrections, financial drafts awaiting owner review, conflicts, sync errors, backup failures, and financial-year close tasks.
3. Workflow queue: new customer intake, estimates awaiting approval, jobs waiting for assignment, work in progress, delivery-ready jobs, warranty follow-ups, and daily-log exceptions.
4. Trends and reports: monthly sales/receipt comparison, ageing buckets, top parties/items/services, and a compact day book.
5. Quick actions: create the transaction types enabled for the selected company and active role.

## Safety And Privacy Rules

- Every widget and drill-down must filter by the active organization and authorized financial year.
- Restricted owners and operators must not see all-company balances, diagnostics, payments, or invoices outside their permissions.
- The customer portal must not expose financial summary information.
- Counts and monetary values must use server-side aggregate queries; browser-side full-record loading is not acceptable for production dashboards.
- A missing chart or zero-data state must show a clear neutral message, never an error or stale value.

## Acceptance Criteria For A Future Implementation

- Page remains usable at 1366 x 768, tablet width, and mobile width without horizontal overflow.
- Initial summary data is organization-scoped and does not load all bills, payments, parties, or stock rows into the browser.
- Every summary card opens the matching filtered report.
- Empty data, permission-denied states, server-offline state, and partial dashboard API failures are displayed safely.
- Existing dashboard regression, responsive UI, role/organization isolation, pagination, and performance tests are extended before release.

## Explicitly Out Of Scope For This Record

- No alteration to the current dashboard.
- No change to accounting calculations, roles, reports, or customer portal behavior.
- No use of the reference product's logo, icons, text, screenshots, or color identity.
