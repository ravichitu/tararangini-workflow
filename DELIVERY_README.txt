TARANGINI BILLING 2.4.1 - COMPLETE DELIVERY PACKAGE

INSTALLATION
1. Run "Tarangini Billing Setup 2.4.1.exe" on all computers.
2. On exactly one computer, select MAIN SYSTEM.
3. Keep the Main System switched on while billing is in use.
4. On the other computers, select CLIENT SYSTEM and click "Find Main System Automatically",
   or manually enter the Main System IPv4 address.
5. Allow Tarangini Billing through Windows Firewall when requested.

The Main System / Client System selector appears whenever the desktop app starts.
It can also be opened from the "Main / Client Setup" button inside the application.
Use "Test Connection" on client computers before saving the client setup.

INITIAL RECOVERY LOGIN
Owner 1: owner1 / owner123
Owner 2: owner2 / owner123
Operator: operator1 / operator123

Owner1 must assign a unique 4-6 digit PIN to every owner and operator.
Use username + PIN for daily login. Keep the recovery password only for recovery.
For owner2, login first with recovery password owner123 if no PIN has been assigned yet.
Client computers must connect to the Main System for the first login before offline login can work.

PACKAGE CONTENTS
- Standalone Windows installer
- Electron desktop and network setup files
- Billing, accounting, inventory, reporting, backup, and barcode source
- Database schema and seed data; no customer transaction database is shipped
- Logo and Windows icon assets
- Package configuration and dependency lock file
- Upgrade list and project documentation
- Visual User Manual in PDF and Word formats

BARCODE PRINTING
- 100 mm roll printer
- 1-up and 2-up layouts
- A4 label sheets
- Configurable label size, quantity, columns, gaps, and margins

INVOICE PRINTING
- Invoice is constrained and automatically scaled to one complete A4 page.
- Composition taxpayers use Bill of Supply with no collected GST.
- Regular taxpayers use Tax Invoice.
- Project Printing Invoice supports B/W, colour, books, book cost, and optional charges.

BANK STATEMENTS
- Upload Excel (.xlsx and .xls) or CSV statements.
- Imported transactions are retained and can be automatically or manually matched.
- Duplicate statement files are blocked and detected column mappings are recorded.

POS AND COUNTER
- Barcode-first POS billing with keyboard shortcuts.
- Cash, card, UPI, credit, and split payments for owners and operators.
- Cash posts immediately; bank, UPI, and card post only through linked Receipt Vouchers.
- Phone/tablet intranet sales portal with manual, USB, photo, and supported live-camera barcode scanning.
- Hold/resume bills and 58 mm / 80 mm thermal receipts.
- Counter shifts with collection/handover report, bank references, variance, and owner acceptance.
- Invoice-linked returns, credit notes, and optional refunds.

VERSION 2.3 BILLING CONTROLS
- Paid, Partly Paid, Unpaid, and Overdue invoice status.
- Per-row invoice description or serial number, preserved on edit, print, and duplicate.
- Separate Bill To and Delivery To details, courier, tracking/LR number, and dispatch date.
- Operator correction requests with owner approval/rejection and linked Credit Notes.
- Update Manager with pre-upgrade backup, SHA-256 verification, LAN distribution,
  pending-offline-invoice blocking, version mismatch warning, and rollback foundation.
- Owner1-controlled PIN assignment/reset for Owner2 and operators.
- Stock Movement Journal with source reference, quantity, rate, and movement value.
- Preloaded searchable Help & FAQ that works without internet.
- Dashboard QR code for mobile operator login on the same LAN.
- Mobile POS fix: reliable state initialization, POS-only operator shifts, held-bill display/resume,
  visible save errors, safe recovery from damaged login state, and a revised frontend asset URL
  that prevents phones from retaining the older token-handling script.
- Android Chrome follow-up: isolated application state, a new physical frontend filename,
  compatibility for older /app.js requests, sticky mobile Sale/POS save controls, operator
  creator names in All Bills, and startup rejection when an older server still owns port 3000.
- Version 2.3.1 adds per-company invoice themes (Classic, Sapphire, Emerald, Sunset and
  Common GST), GST-inclusive rate defaults, GST-safe company invoice prefixes, logo crop/resize,
  and Tally Prime XML export for regular-GST customer and vendor ledgers.
- Bits & Binary includes an idempotent starter catalogue of common computer products with
  unique part codes and 8-digit HSN codes. Prices, stock and reorder levels start at zero.
- Version 2.3.2 provides an inclusive-GST entry control on every priced transaction for
  regular taxpayers: invoices, POS, project printing, purchases, expenses, notes, returns,
  purchase orders and job estimates.
- Every taxpayer type has an optional nearest-rupee round-off control, enabled by default.
  Non-zero adjustments are stored, printed and posted to the Rounding Adjustment ledger.
- HTTPS can be configured with PEM or PFX certificates; camera scanning and PWA installation
  require HTTPS for non-localhost mobile access.
- Desktop source is packaged into app.asar, with database diagnostics, retention-safe
  maintenance and additional performance indexes.
- Version 2.3.3 places a Held Bills button in the Mobile POS top-right header. It shows
  the current held-bill count and opens the existing resume list without scrolling manually.
- Version 2.4.0 adds audited per-company Transaction Controls for entry visibility,
  required validation and print output across invoices, POS, vouchers, journals,
  purchases, notes, returns and purchase orders.
- Version 2.4.1 adds HttpOnly browser/mobile sessions, cross-origin write protection,
  optional remote HTTPS enforcement, encrypted automatic .tbe backups with a separate
  recovery key, secure-storage enforcement for packaged offline clients, audited shift
  cash additions/removals, and an uninstall choice to keep or permanently remove data.

BUSINESS CONTROLS
- Negative-stock prevention.
- Purchase orders and supplier outstanding payments.
- Invoice, item, and customer profitability.
- Live network/client dashboard.
- Granular user permissions.
- Signature image and QR code on invoices.
- Scheduled monthly CSV/email reports.
- Encrypted backups and database integrity/repair tools.

INVOICE SETTINGS
- Header note, footer note, bottom description, and project printing default prices.
- Optional swipe/card charges are available on invoices.
- New customer names can be created and selected directly from invoice entry.

SOURCE REBUILD
1. Install Node.js 20 or later.
2. Run: npm install
3. Run: npm run dist

DATA
Operational data is stored on the selected Main System and is not included in this installer or ZIP.
Use automatic backup and Backup & Restore from within the application.
