# Tarangini Workflow Suite: Google Flow Training Script

Version: 1.1.10  
Instructor: Jaya  
Audience: Owner, operator, engineer, accountant, and customer  
Purpose: Complete screen-by-screen product demonstration with narration, dialogs, data-entry examples, editing rules, job workflow, and success confirmations.

## Recorded Video Requirement

Recorded on 2026-07-20 at the user's request:

- Create one training-video scene for every major transaction and workflow.
- Keep all scenes equal in duration, aspect ratio, camera framing, caption style, and transition style.
- Include screen capture, step-by-step entry, saved result, audit/status proof, Jaya narration, on-screen labels, and a success condition in every scene.
- Cover the 18-scene sequence: login/dashboard; party and addresses; item/service/HSN/GST setup; quotation; sales invoice; purchase/stock; payment voucher and ledger; transaction search/edit/duplicate/delete; delivery challan; warranty replacement; customer QR intake; uploads/PDF analysis; job estimate and approval; assignment and production; operator daily log; job completion and linked invoice; offline sync; backup and owner review.
- Use fictional sample data only. Do not capture passwords, PINs, recovery keys, DSC PINs, real customer files, or other private information.
- Google Flow project: https://labs.google/fx/tools/flow/project/66dd36b4-1bd3-48be-b914-c8924a1d181b
- Current status: the equal-scene prompt is staged in the Flow project; final video generation remains pending because Flow's agent Create control was disabled during automation.

## Production Direction

Use a calm, practical instructor voice. Show the real Tarangini Workflow Suite screen before describing it. Keep customer information fictional. Never display passwords, PINs, recovery keys, DSC PINs, or real customer files. Use the sample company `Bits and Binary Demo`, customer `AIWC Kakinada Demo`, and phone `9000000000`.

Each scene should show:

1. The full application screen.
2. The exact control being selected.
3. The saved result or success message.
4. The audit, preview, or status screen that proves completion.

## Opening Statement

**Jaya says:**

"Welcome to Tarangini Workflow Suite. This application connects billing, accounting, job production, customer intake, operator work logs, warranty tracking, offline work, backups, and customer status updates. We will first sign in as the owner, then create and edit transactions, create a customer job, follow it through production, show the customer portal, and finish with synchronization and backup verification."

**Screenshot 01:** Login screen showing username, PIN field, Sign In button, and application title.

## Roles And Access

**Jaya says:**

"The owner controls companies, users, permissions, transaction corrections, deletion, backups, synchronization, conflicts, and final accounting. Operators work only within their assigned permissions and record daily work. Engineers update assigned production work. Customers use the intake and status portal without accessing accounting data."

Show the role matrix:

| Role | Main abilities | Restricted actions |
| --- | --- | --- |
| Owner | All organizations, users, transactions, corrections, deletion, duplicate, backup, sync, reports | None within application policy |
| Operator | Assigned jobs, production updates, notes, daily log, permitted entries | Cannot delete owner bills or view restricted owner transactions |
| Engineer | Assigned production stages, work notes, completion response | Cannot change accounting or payment records |
| Customer | Service selection, contact details, uploads, quotation decision, status tracking | No accounting, internal notes, or download of restricted output |

**Screenshot 02:** Owner dashboard with company selector, navigation, connection status, customer QR, and job dashboard.

## Owner Dashboard And Company Selection

**Jaya says:**

"The dashboard begins with the selected organization. Always confirm the company before creating or editing a record. The connection indicator shows Main Online, Main Offline, Local Mode, Sync Pending, or Sync Conflict. The customer landing QR opens the service-selection page for the selected organization."

Actions:

1. Select `Bits and Binary Demo`.
2. Show the connection chip.
3. Open the company selector.
4. Open the customer landing QR.

**Success statement:** "The selected organization, user role, connection state, and customer QR are visible before work begins."

**Screenshot 03:** Company selector and connection status panel.

## Party And Address Entry

**Jaya says:**

"A party is a customer, vendor, or both. The party master stores identity and the address master stores separate billing and delivery addresses. This prevents two offices with the same name from being confused."

Example entry:

| Field | Example |
| --- | --- |
| Name | AIWC Kakinada Demo |
| Type | Customer |
| Phone | 9000000000 |
| Email | demo@example.com |
| GSTIN | 37ABCDE1234F1Z5 |
| Address label | Kakinada Branch |
| Billing address | Main Road, Kakinada |
| Delivery address | Service Centre Road, Kakinada |

Actions:

1. Open Parties.
2. Select Add Party.
3. Save the party.
4. Add a billing and delivery address.
5. Mark defaults.
6. Edit the address and save.

**Success statement:** "Party added. Address added. The selected billing and delivery addresses are now available in transactions."

**Error statement:** "If required identity details are missing, the form remains open and the missing field is identified."

**Screenshot 04:** Add Party form.
**Screenshot 05:** Party address list with billing and delivery defaults.

## Common Customer And Walk-In Customer

**Jaya says:**

"For a warranty visitor who is not already in the party master, select Common Customer or Walk-In Customer. Enter the visitor name and phone in the transaction. The record remains traceable without creating an uncertain permanent party."

**Screenshot 06:** Common Customer selection with visitor details.

## Item, HSN, And Service Catalog

**Jaya says:**

"Items contain product identity, HSN code, tax rate, stock settings, serial information, and price. Job services are organization-specific, so each company can maintain its own service categories and department boards."

Example item:

| Field | Example |
| --- | --- |
| Item name | A4 Colour Print |
| Item code | PRINT-A4-COLOR |
| HSN/SAC | 9989 |
| GST rate | 18% |
| Unit | Page |
| Opening stock | 1000 |

Actions:

1. Open Items and add an item.
2. Open Job Catalog.
3. Add category `Computer Services`.
4. Add service `Colour Printing`.
5. Assign the service to its department board.

**Screenshot 07:** Item form with HSN and GST fields.
**Screenshot 08:** Organization service category and department board.

## Quotation Entry

**Jaya says:**

"A quotation records the proposed work and price before customer approval. Select the correct company, party, address, item or service, quantity, rate, tax, terms, and validity. The quotation number is generated by the selected organization."

Quotation example:

| Field | Example |
| --- | --- |
| Customer | AIWC Kakinada Demo |
| Service | Colour Printing |
| Quantity | 100 pages |
| Rate | 5.00 |
| Tax | 18% |
| Remarks | Deliver by Friday |

Actions:

1. Select New Quotation.
2. Select customer and address.
3. Add service lines.
4. Review tax and total.
5. Save.
6. Open the preview pane.

**Success statement:** "Quotation saved with its organization, party, address, line items, tax calculation, total, and audit information."

**Screenshot 09:** New Quotation entry screen.
**Screenshot 10:** Saved quotation preview with HSN/tax breakup.

## Invoice, Proforma, Challan, And Project Invoice

**Jaya says:**

"The same controlled entry pattern is used for Sale Invoice, Proforma Invoice, Delivery Challan, and Project Printing Invoice. The document label changes according to the transaction type, while party, address, item, tax, totals, and audit rules remain consistent."

Show these transaction types:

| Transaction | Main purpose |
| --- | --- |
| Sale Invoice | Final sale and accounting entry |
| Proforma Invoice | Preliminary commercial document |
| Delivery Challan | Delivery without sale posting |
| Project Printing Invoice | Project or printing work billing |
| POS Receipt | Immediate counter sale |

**Success statement:** "Transaction saved. The preview is opened and the saved history can be used for review."

**Screenshot 11:** Sale Invoice entry.
**Screenshot 12:** Invoice HSN summary, tax breakup, final total, and bank details.
**Screenshot 13:** Delivery Challan with item and serial number.

## Payment Received And Payment Voucher

**Jaya says:**

"Payment Received records money collected from a customer. Payment Voucher records money paid to a vendor or other account. Select the party, date, amount, payment mode, reference, linked bill, and narration. Excess receipt remains as an unallocated credit in the party ledger."

Payment modes include cash, bank/account, UPI, and card according to enabled settings.

**Success statement:** "Payment saved with a voucher number, ledger effect, linked bills, payment mode, and audit record."

**Editing statement:** "Owner editing requires a correction reason. The original voucher number is retained, the ledger is rebuilt atomically, and the correction is audited."

**Screenshot 14:** Payment Received entry.
**Screenshot 15:** Payment Voucher entry.
**Screenshot 16:** Payment edit modal with mandatory correction reason.

## Purchases, Expenses, Notes, And Journals

**Jaya says:**

"Purchases increase stock or record vendor liability. Expenses record operating costs. Credit and Debit Notes adjust an earlier transaction. Manual Journal records a balanced debit and credit entry. Each form validates required values before saving."

**Success statements:**

- "Purchase saved and stock updated."
- "Expense saved and ledger updated."
- "Credit or Debit Note saved with its linked adjustment."
- "Balanced Journal saved with equal debit and credit totals."

**Screenshot 17:** Purchase entry.
**Screenshot 18:** Expense Voucher entry.
**Screenshot 19:** Credit/Debit Note entry.
**Screenshot 20:** Balanced Journal entry.

## Edit, Delete, And Duplicate Rules

**Jaya says:**

"Open All Transactions to search by company, document number, party, phone, date, or transaction type. Owners can edit, delete safely, and duplicate. Operators do not receive owner deletion rights."

Editing sequence:

1. Search the transaction.
2. Select Edit.
3. Correct the fields.
4. Enter the mandatory reason.
5. Save the correction.
6. Review the retained number and audit history.

Deletion sequence:

1. Select Delete.
2. Enter the deletion reason.
3. Confirm.
4. Review the cancellation state and unchanged number.

Duplication sequence:

1. Select Duplicate.
2. Select the target organization if allowed.
3. Confirm date, party, address, and lines.
4. Save the new transaction.

**Success statement:** "Correction saved. Original number retained. Audit reason recorded."  
**Delete statement:** "Transaction cancelled safely. Its number and audit history remain available."  
**Duplicate statement:** "Duplicate created with a new number and the selected party and address."

**Screenshot 21:** All Transactions search and register.
**Screenshot 22:** Edit reason dialog.
**Screenshot 23:** Delete reason dialog.
**Screenshot 24:** Duplicate transaction dialog.

## Customer Portal And Intake

**Jaya says:**

"The customer scans the QR code and first sees the service-selection page. The customer enters name, phone, email, address, service, subject, remarks, and files. The portal assigns a unique order ID and preserves the selected service."

Customer steps:

1. Open the QR landing page.
2. Select a service.
3. Enter customer details.
4. Upload one or more files.
5. Preview the selected file.
6. Confirm PDF analysis where available.
7. Submit the request.
8. Record the order ID.
9. Use Track Order to check status.

**Success statement:** "Request submitted. Your order ID is shown. Keep this ID for tracking."

**Validation statement:** "Please correct the highlighted details. Your entered values remain on the form so you can continue where you stopped."

**Screenshot 25:** Customer service-selection landing page.
**Screenshot 26:** Customer details and upload form.
**Screenshot 27:** File preview and PDF analysis result.
**Screenshot 28:** Order ID success screen.
**Screenshot 29:** Customer tracking page.

## Job Intake And Production Workflow

**Jaya says:**

"The owner converts or creates the customer request as a job order. The job keeps the customer, device or item details where applicable, service, estimate, attachments, remarks, consent, and audit history together."

Job stages:

1. New intake
2. Accepted
3. Estimate prepared
4. Customer approval pending
5. Approved
6. Assigned
7. In production
8. Waiting for material or clarification
9. Quality review
10. Ready for delivery
11. Delivered
12. Closed

**Owner dialogue:**

"I am reviewing the customer request, confirming the service, checking the file analysis, and assigning the work to the correct department and operator."

**Operator dialogue:**

"I have opened my assigned job. I will record the work started, materials used, current stage, pending requirement, and completion response in the job record."

**Engineer dialogue:**

"I am recording the technical work, device or serial details, test result, and next production stage."

**Customer dialogue:**

"I can see my order ID, quotation decision, current status, remarks requested from me, and delivery update without seeing internal notes or accounting data."

**Screenshot 30:** Owner job dashboard.
**Screenshot 31:** Job detail with customer, service, estimate, attachments, and audit history.
**Screenshot 32:** Assignment and production stage screen.
**Screenshot 33:** Operator work response and pending work.
**Screenshot 34:** Customer status view.
**Screenshot 35:** Completion and delivery acknowledgement.

## Estimate, Approval, Addition, And Consent

**Jaya says:**

"The owner prepares the estimate and sends the customer-facing quotation. If the customer requests an addition, the addition is recorded separately. The customer approves or rejects it, and the decision is included in the audit history."

**Success statements:**

- "Estimate saved and displayed to the customer."
- "Customer approval recorded with date and decision."
- "Addition created and waiting for customer consent."
- "Consent history saved and visible to the owner."

**Screenshot 36:** Estimate lines and customer approval status.
**Screenshot 37:** Addition request and consent history.

## Materials, Stock, Warranty, And Delivery

**Jaya says:**

"Materials consumed on a job are linked to billing items and stock movements. Warranty replacement records include party, product, serial number, service centre, RMA number, delivery challan, courier vendor, tracking number, and follow-up date."

**Screenshot 38:** Job material consumption and stock linkage.
**Screenshot 39:** Warranty replacement form.
**Screenshot 40:** Delivery challan, courier tracking, and follow-up.

## Operator Daily Work Log

**Jaya says:**

"The Daily Work Log records automatic job events and miscellaneous work. The operator records start time, completed work, pending work, duration, job reference, notes, and file names. The owner reviews the submitted daily report."

**Success statement:** "Daily report submitted. Work completed, pending items, duration, and miscellaneous entries are now visible to the owner."

**Screenshot 41:** Operator Daily Work Log.
**Screenshot 42:** Owner review of operator activity.

## Offline Work And Synchronization

**Jaya says:**

"When the Main System is unavailable, the header shows the connection state. Permitted jobs, quotations, drafts, and customer intake can continue locally. The system assigns a device ID, local UUID, and provisional number. Final accounting posting remains controlled by the Main System."

Sync sequence:

1. Device creates a protected local record.
2. The local queue survives application or Windows restart.
3. The device reconnects through the authenticated API.
4. The server validates organization, device, user, version, and idempotency key.
5. The server assigns the official number where permitted.
6. Duplicate retries return the same result.
7. Conflicts are sent to owner review.

**Success statement:** "Sync completed. The local record is linked to its central record."  
**Conflict statement:** "This record changed in another place. It is locked for owner review; no data was silently overwritten."

**Screenshot 43:** Offline header status and local queue.
**Screenshot 44:** Sync history and official-number mapping.
**Screenshot 45:** Owner conflict-resolution screen.

## Backup, Restore Verification, And Diagnostics

**Jaya says:**

"Automatic backups are encrypted using AES-256-GCM. The application performs a non-destructive restore drill in a temporary database, checks SQLite integrity and required tables, records the result, and removes the temporary files."

**Success statement:** "Backup created and restore-verified. The live database was not replaced."  
**Failure statement:** "Backup verification failed. The backup is not reported as successful and remains available for investigation."

**Screenshot 46:** Automatic backup settings.
**Screenshot 47:** Latest restore verification result.
**Screenshot 48:** Diagnostics and storage locations.

## Final Demonstration Close

**Jaya says:**

"This demonstration showed the complete working path: organization selection, party and address entry, item and service setup, quotation, invoice, payments, purchase, expense, notes, journals, editing, deletion, duplication, customer intake, file preview, PDF analysis, job assignment, production, operator logs, warranty tracking, delivery, offline queue, synchronization, and encrypted backup verification."

"The owner remains the authority for accounting corrections, final financial posting, conflict resolution, and controlled recovery. Customer and staff access is limited to the information required for their work."

**Screenshot 49:** Owner dashboard showing completed job, saved transaction, sync state, and backup verification.

## Feature Status To State On Screen

Do not present these as fully deployed unless the required external setup has been completed:

| Feature | Current status |
| --- | --- |
| Full writable encrypted take-home replica | Partial; controlled snapshot and queue exist |
| Physical elevated firewall validation | Partial; lifecycle and tests exist |
| Live GST e-invoice/e-way bill | External credentials and certification required |
| DSC token signing | External middleware and architecture proof required |
| Native Android APK | Pending; responsive PWA/API foundation exists |
| Public customer website hosting | Pending deployment |
| Multi-day soak and sustained ten-client hardware test | Pending physical test |

## Screenshot Capture Checklist

Capture each numbered screenshot from the tested 1.1.10 build. Use 16:9, 1920x1080 where possible. Hide real names, phone numbers, email addresses, recovery keys, and tokens. Keep the cursor visible only when it identifies the control being demonstrated. After each save, capture both the success toast and the resulting history, preview, audit, or status screen.

## Google Flow Prompt

"Create a professional step-by-step training video for Tarangini Workflow Suite version 1.1.10. Use an instructor named Jaya. Follow the numbered scenes in this script exactly. Show the real screen before explaining it. Use fictional demo data only. Narrate every field, button, validation message, success message, edit rule, delete reason, duplicate rule, customer portal step, job stage, operator work-log entry, synchronization state, and backup verification result. Use clear callouts around the selected controls. Include the screenshot number as a small lower-third label. Explain that owners control accounting corrections and official financial posting, operators update assigned work, engineers record technical stages, and customers see only their own portal status. Do not show passwords, PINs, DSC secrets, recovery keys, or real customer files. Do not claim pending or externally dependent features are complete. End with the owner dashboard showing a completed job, saved transaction, synchronized status, and verified encrypted backup."
