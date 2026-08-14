# TARANGINI WORKFLOW SUITE
## Merged Billing, Production Workflow And Customer Portal

---

## WINDOWS DESKTOP INSTALLATION (3 COMPUTERS)

Current source version: `1.0.0`

Installer: `dist/Tarangini Workflow Suite Setup 1.0.0.exe`
ZIP package: `dist/Tarangini Workflow Suite-1.0.0-win.zip`

Version 1.0.0 establishes the merged Tarangini Workflow Suite baseline:

- Billing, accounting, POS and stock remain integrated.
- Job intake, production workflow and customer portal remain integrated.
- Backup import/export now carries job workflow, customer portal state and attachment metadata without permanently backing up normal attachment bytes.
- Data-shift tracking is stored for safer recovery and migration reviews.
- Jobs can be first-billed from an accepted estimate and later delivered against the same linked invoice when the amount has not changed.

1. Install the same setup file on all three Windows computers.
2. On exactly one computer, choose **MAIN SYSTEM** on the startup selector.
3. Keep the main computer switched on whenever the billing software is in use.
4. On the other two computers, choose **CLIENT SYSTEM** and click **Find Main System Automatically**.
5. If automatic discovery does not find it, run `ipconfig` on the main computer and manually enter its IPv4 Address, for example `192.168.1.10`.
6. Allow Tarangini Workflow Suite through Windows Firewall if Windows asks.

All three computers use the one database stored on the main computer. Saved changes are written immediately and open clients refresh automatically after another computer changes data.
Recorded storage direction: keep accounting and job orders in one linked business database to avoid sync collisions. Store large customer uploads in active filesystem attachment storage, keep permanent metadata in the database, and only separately archive/back up files the owner marks important.

Production direction: use exactly one active **Main System** as the source of truth. The earlier two-main-PC active sync idea is stopped for now because independent Main PCs can create invoice-number, payment, stock, GST and ledger conflicts. Use clients/browser access for other PCs, and add always-on Main System service mode plus strong backups before considering any future high-availability design.

The installer creates a **Tarangini Workflow Suite** Desktop shortcut and Start Menu shortcut.
The ZIP package is provided as a portable/manual distribution artifact for review, copying and controlled deployment checks.

The selector appears at every desktop startup. It can also be reopened using **Main / Client Setup** in the sidebar or application menu.
Use **Test Connection** on a client computer before saving. Owner2 can sign in with `owner2` / `owner123` until Owner1 assigns a daily PIN; each client must complete one online login to the Main System before offline login is available.

Current network behavior: one Main System server must remain running for customer QR intake, status lookup, operator pages and client computers to work. The implemented Always-On Windows Service mode can keep that server and portal active before login and while the desktop window is closed.

### Always-On Windows Service Mode

On the one Main System PC, open **Main / Client Setup**, select **MAIN SYSTEM**, verify the database, attachment and backup folders, then use **Always-On Windows Service > Install / Enable**. Windows may ask for administrator permission.

This service runs the Tarangini server, customer portal, automatic backup and attachment workers without opening the desktop window. Owners and operators can still open the desktop app or browser separately. Do not enable this on client PCs, and do not enable it as a second Main System.

If no custom database folder is selected, the service uses the same saved Main-System app-data database folder from the desktop setup. For production, prefer an explicit database folder such as `D:\Tarangini\Database` and a backup folder on another drive.

---

## INTERNET DEPLOYMENT

Tarangini Workflow Suite can now be exposed for secure remote invoice and workflow access over the internet.

Recommended production settings:

- `TARANGINI_INTERNET_MODE=1`
- `TARANGINI_PUBLIC_BASE_URL=https://your-domain.example`
- `TARANGINI_HTTPS_PFX` and `TARANGINI_HTTPS_PFX_PASSPHRASE`
  or `TARANGINI_HTTPS_KEY` and `TARANGINI_HTTPS_CERT`
- `TARANGINI_ALLOWED_HOSTS=your-domain.example`
- `TARANGINI_ALLOWED_ORIGINS=https://your-domain.example`
- `TARANGINI_ADMIN_ALLOWED_IPS=` followed by trusted office/static IPs for owner-only administration

Internet mode protections:

- refuses insecure public startup without HTTPS
- generates customer portal and mobile login URLs from the configured public base URL
- rejects unexpected host headers
- supports optional owner/admin IP restrictions for high-risk operations

Online-readiness foundation added in version `1.0.0`:

- deployment and upload limits are now environment-configurable instead of desktop-only hard-coded values
- customer intake supports `X-Idempotency-Key` retry protection for future Android app and website submissions
- `/api/health` and diagnostics now expose the active deployment profile, target concurrency and storage mode
- current default target profile is prepared for `100-200` concurrent customer sessions, but attachment growth planning is still required for public internet scale
- deployment profiles are now available for `lan`, `store`, and `public`
- attachment storage now supports both `inline-db` and `filesystem` modes
- attachment analysis now supports both `sync` and `async` modes, with customer PDF print-confirmation flows forced through synchronous validation when needed
- async attachment analysis uses a persistent queue with startup recovery and owner diagnostics
- normal attachments use a 7-day post-delivery retention policy by default; archived attachments are excluded from auto-delete

Recommended extra settings for future Android app and website rollout:

- `TARANGINI_TARGET_CONCURRENT_CUSTOMERS=200`
- `TARANGINI_REQUEST_BODY_LIMIT_MB=50`
- `TARANGINI_CUSTOMER_UPLOAD_LIMIT_MB=15`
- `TARANGINI_STAFF_UPLOAD_LIMIT_MB=10`
- `TARANGINI_CUSTOMER_PORTAL_RATE_LIMIT_MAX=600`

---

## CUSTOMER QR INTAKE FLOW

Counter staff can now open **Jobs > Customer Intake QR** to generate a public QR code and shareable link for the selected company.

Customer-side flow:

- customer scans the QR code
- customer lands on a cleaner Home page with buttons for Track Order and New Request
- customer can open a dedicated tracking page using Order ID and phone number
- customer selects a service family, which opens its own service-specific request page
- customer selects the exact service before the detailed form opens
- customer enters name, phone, job or device details, requested delivery, and instructions
- customer uploads PDF, JPG, PNG, or WebP files with preview and delete-before-submit controls
- Tarangini keeps original file bytes while the work is active, permanently keeps metadata, verifies PDF page count, and records best-effort PDF colour-page hints

Staff-side flow:

- the request appears in **Jobs > Customer QR Requests**
- counter staff reviews the uploaded details and files
- owner/operator can download active uploaded files for one request as a ZIP bundle while those files are retained
- staff can link the request to an existing customer or create a new customer automatically
- staff converts the request into a normal job order with estimate, service, and promised delivery
- customer uploads are copied into the final job record, remain previewable while retained, and remain as metadata-only history after cleanup
- owner/finance can create a first bill from the accepted estimate before production is complete
- delivery reuses the linked first bill when the final job amount still matches, preventing duplicate invoices

Backup import and export now include QR intake requests and attachment metadata. Normal attachment bytes are not permanently backed up unless the owner archives them separately.

---

## FINANCIAL REPORTS AND BALANCE SHEET

Open **Reports > Financial Reports** for:

- Balance Sheet with automatic balance check
- Profit and Loss
- Trial Balance with account-ledger drill-down
- Day Book
- Cash and Bank balances
- Receivables and Payables
- GST summary
- Sales Register
- Payment Register
- Expenses and Purchases Register

Sales bills, receipts, and payment vouchers post automatically to the accounts.

Use **Reports > Journal Entry** to record purchases, operating expenses, fixed assets, loans, owner capital, depreciation, and accounting adjustments. Every journal must have equal debit and credit totals.

Common entries:

- Expense paid: Debit the expense account, Credit Cash or Bank
- Credit purchase: Debit Purchases, Credit Accounts Payable and select the vendor
- Asset purchased: Debit Fixed Assets, Credit Cash, Bank, or Loans
- Capital introduced: Debit Cash or Bank, Credit Owner Capital

Balance Sheet accuracy depends on entering all business transactions, including purchases, expenses, assets, loans, and capital.

---

## AUTOMATIC SECURITY LOCK

Owners can open **Settings > Auto Lock** to:

- Enable or disable automatic locking
- Choose the inactivity timeout
- Choose how many seconds before locking the warning appears
- Lock the application immediately for testing

The lock applies to all connected computers. Each computer measures its own user activity. The current user's password is required to unlock, and the open billing screen remains preserved behind the lock.

---

## COMPANY SELECTION IN VOUCHERS

Every Sale Bill, Project Printing Invoice, Quotation, Delivery Challan, Proforma Invoice, Receipt, Payment Voucher, and Journal Entry includes a prominent **Voucher Company** selector.

Changing the company:

- Updates the sidebar company context
- Loads that company's parties, items, GST setup, and accounts
- Refreshes the displayed voucher number
- Uses an independent company, voucher-type, and financial-year sequence

Voucher numbers also refresh when the voucher date or journal voucher type changes. Sequence counters are included in backups so restored data continues from the correct number.

---

## 🚀 QUICK START

### Requirements
- Node.js v18 or higher → https://nodejs.org

### Installation
```bash
# 1. Extract this folder anywhere on your computer
# 2. Open Command Prompt / Terminal in this folder
# 3. Install dependencies (one time only):
npm install

# 4. Start the application:
npm start
# OR
node server.js

# 5. Open browser and go to:
http://localhost:3000
```

### Network Access (Other computers on same WiFi)
```
Find your PC's IP address:
  Windows: ipconfig → look for IPv4 Address
  e.g. 192.168.1.5

Other computers open: http://192.168.1.5:3000
```

---

## 🔐 DEFAULT LOGINS

| Username   | Password     | Role     | Access            |
|------------|--------------|----------|-------------------|
| owner1     | owner123     | Owner    | All organizations |
| owner2     | owner123     | Owner    | All organizations |
| operator1  | operator123  | Operator | Org 1 only        |
| operator2  | operator123  | Operator | Org 2 only        |

⚠️ **CHANGE ALL PASSWORDS AFTER FIRST LOGIN!**
Settings → Change Password

---

## 🏪 ORGANIZATIONS PRELOADED

1. **TARANGINI PAPER AND BOOK BINDING WORKS**
   - GSTIN: 37AVKPP7059B1ZB | Type: Composition (2% Tax)
   - 44 items preloaded across 6 categories

2. **BITS & BINARY (Shri Lakshmi Kalyani International)**
   - Type: Regular (18% GST)
   - Update address/GSTIN in Settings → Organizations

3. **THE PRINTS MEN**
   - Type: Composition
   - Update details in Settings → Organizations

---

## 📋 FEATURES

### Bill Formats
- ✅ Sale Bill (Tax Invoice / Bill of Supply)
- ✅ Quotation (convert to Sale Bill)
- ✅ Delivery Challan (convert to Sale Bill)
- ✅ Proforma Invoice (convert to Sale Bill)
- ✅ Payment Received
- ✅ Payment Voucher

### After Saving Any Bill
- 📄 A4 preview opens automatically
- 🖨️ Direct print button (Ctrl+P)
- ⬇️ Save as PDF (Print → Save as PDF)

### Key Features
- Auto bill numbering (e.g. TAR/SB/2025-26/0001)
- Last price memory per item
- GST auto-calculation (Composition 2% / Regular 18%)
- Tax inclusive / exclusive entry on every priced transaction for regular taxpayers
- Optional nearest-rupee round-off on every taxpayer transaction, enabled by default
- Amount in words (Indian numbering)
- HSN code support
- Party GSTIN auto-fetch (requires internet)
- Vendor/Party statement
- Dashboard with monthly charts
- Financial year wise data
- Backup / Restore (JSON)
- Backup reminder every 90 days

---

## 💾 BACKUP

**Export:** Settings → Backup → Download Backup
**Import:** Settings → Backup → Import (select .json file)

**Recommended:** Backup every 3 months. Store in Google Drive + Pen Drive.

---

## 🔄 AUTO-START ON WINDOWS BOOT

```bash
# Install PM2 globally
npm install -g pm2

# Start with PM2
pm2 start server.js --name tarangini

# Auto-start on Windows boot
pm2 startup
pm2 save
```

---

## 📁 DATA LOCATION

Database: `database/tarangini.db`
Back this file up regularly as an extra precaution.

---

## ⚙️ CONFIGURATION

Port (default 3000): Set environment variable PORT=xxxx
JWT Secret: Set environment variable JWT_SECRET=your-secret

Optional HTTPS:

```powershell
$env:TARANGINI_HTTPS_KEY='C:\certs\server-key.pem'
$env:TARANGINI_HTTPS_CERT='C:\certs\server-cert.pem'
$env:TARANGINI_HTTP_REDIRECT_PORT='3000'
npm.cmd run start:server
```

PFX is also supported with `TARANGINI_HTTPS_PFX` and
`TARANGINI_HTTPS_PFX_PASSPHRASE`. For public/cloud testing, a trusted HTTPS reverse
proxy is recommended.

---

## 🆘 TROUBLESHOOTING

**Port in use:** Change PORT in server.js or set PORT=3001 node server.js
**Forgot password:** Delete database/tarangini.db and restart (all data lost)
**Node not found:** Download from https://nodejs.org and install

---

Built for: Tarangini Paper & Book Binding Works, Bits & Binary, The Prints Men
Location: Kakinada, Andhra Pradesh
