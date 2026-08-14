from pathlib import Path
from textwrap import wrap

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
PDF_PATH = ROOT / "output" / "pdf" / "Tarangini_All_Transaction_UML.pdf"
MD_PATH = ROOT / "docs" / "ALL_TRANSACTION_UML.md"
PAGE_W, PAGE_H = landscape(A4)

NAVY = colors.HexColor("#102A43")
TEAL = colors.HexColor("#087F8C")
TEAL_LIGHT = colors.HexColor("#DDF3F4")
GOLD = colors.HexColor("#E9A23B")
GOLD_LIGHT = colors.HexColor("#FFF2D8")
INK = colors.HexColor("#243B53")
MUTED = colors.HexColor("#627D98")
LINE = colors.HexColor("#BCCCDC")
PAPER = colors.HexColor("#F7FAFC")
WHITE = colors.white
GREEN = colors.HexColor("#2F855A")
RED = colors.HexColor("#C53030")


TRANSACTIONS = [
    {
        "area": "Access and organization",
        "title": "Login, Session and Role Authorization",
        "status": "IMPLEMENTED",
        "actors": "Owner, counter, finance, operator, engineer",
        "description": "Authenticates the user, creates a server session and applies company and role permissions to every protected request.",
        "steps": ["Enter username and password/PIN", "Verify active user and credential hash", "Create session and return token", "Check permission and organization scope", "Allow request or return 401/403", "Write security/audit metadata"],
        "accounting": "None",
        "stock": "None",
        "records": "users, sessions, audit_log",
        "controls": "Expiry, role permissions, org scope, owner-only actions"
    },
    {
        "area": "Masters",
        "title": "Company, User and Permission Administration",
        "status": "IMPLEMENTED",
        "actors": "Owner1",
        "description": "Creates companies and staff accounts, assigns organization access and limits billing, accounting, reporting and job functions.",
        "steps": ["Owner opens administration", "Create/update organization or user", "Assign role and organization access", "Set transaction permissions", "Validate privileged action", "Save and audit change"],
        "accounting": "No direct posting",
        "stock": "No direct movement",
        "records": "orgs, users, transaction_control_settings, audit_log",
        "controls": "Owner-only administration; no cross-org access without permission"
    },
    {
        "area": "Masters",
        "title": "Party, Shared Organization and Address Book",
        "status": "IMPLEMENTED",
        "actors": "Owner, permitted billing staff",
        "description": "Creates a customer/vendor, optionally shares it with selected companies and stores multiple billing, delivery, branch or site addresses.",
        "steps": ["Search existing party", "Create or select party", "Capture GST/contact details", "Add address-book locations", "Link permitted organizations", "Save stable party/address identity"],
        "accounting": "Opening balance may post receivable/payable",
        "stock": "None",
        "records": "parties, party_org_links, party_addresses, journal_entries",
        "controls": "Same-name parties distinguished by ID, GSTIN, phone and address"
    },
    {
        "area": "Masters and inventory",
        "title": "Item, Service, Barcode and Opening Stock",
        "status": "IMPLEMENTED",
        "actors": "Owner, inventory staff",
        "description": "Creates products/services with HSN/SAC, rates, barcode, opening stock and reorder level for billing and job material use.",
        "steps": ["Select category", "Enter product/service identity", "Set HSN/SAC, UQC and GST", "Set sale/purchase price", "Set barcode and opening stock", "Save item and expose to permitted flows"],
        "accounting": "No direct journal from item master",
        "stock": "Opening stock becomes stock-report baseline",
        "records": "item_categories, items",
        "controls": "Organization ownership, unique item identity, active/inactive state"
    },
    {
        "area": "Billing",
        "title": "Quotation Transaction",
        "status": "IMPLEMENTED",
        "actors": "Owner, counter, permitted operator",
        "description": "Records a priced offer using a stable party and address snapshot without posting accounting or reducing stock.",
        "steps": ["Select customer and exact address", "Add items/services and taxes", "Validate required fields", "Reserve quotation number", "Save QUOT document and snapshot", "Print, duplicate or later convert"],
        "accounting": "None until converted to SALE",
        "stock": "None until converted to SALE",
        "records": "bills(format=QUOT), bill_sequences, audit_log",
        "controls": "FY numbering, party snapshot, operator edit reason"
    },
    {
        "area": "Billing",
        "title": "Delivery Challan Transaction",
        "status": "IMPLEMENTED",
        "actors": "Owner, counter",
        "description": "Records goods delivered or dispatched with delivery-party details and can later become the linked sale invoice.",
        "steps": ["Select party and delivery address", "Add dispatch items and serial details", "Validate document controls", "Save DC number", "Print/dispatch goods", "Convert to SALE when billing is due"],
        "accounting": "None until converted",
        "stock": "Current implementation posts stock on resulting SALE",
        "records": "bills(format=DC), bill_sequences, audit_log",
        "controls": "Document number never reused; stable delivery snapshot"
    },
    {
        "area": "Billing",
        "title": "Proforma Invoice Transaction",
        "status": "IMPLEMENTED",
        "actors": "Owner, finance, counter",
        "description": "Creates a non-accounting advance invoice document that can later be converted into the final sale invoice.",
        "steps": ["Select customer/address", "Add commercial lines", "Calculate tax presentation", "Save PI number", "Send for customer reference", "Convert once supply is confirmed"],
        "accounting": "None until converted",
        "stock": "None until converted",
        "records": "bills(format=PI), bill_sequences, audit_log",
        "controls": "Conversion creates a new SALE and preserves source reference"
    },
    {
        "area": "Billing and accounting",
        "title": "Sale, POS and Project-Printing Invoice",
        "status": "IMPLEMENTED",
        "actors": "Owner, counter, permitted operator",
        "description": "Creates the fiscal sale document, posts tax and receivable/cash/bank journals, and reduces stock for product lines.",
        "steps": ["Select party/address or cash customer", "Add product/service/project lines", "Calculate GST, discount and round-off", "Validate FY, stock and payment split", "Save permanent invoice number", "Post journal and stock movement", "Show saved history/print"],
        "accounting": "Debit cash/bank/receivable; credit sales and output GST",
        "stock": "SALE quantity out for inventory items",
        "records": "bills, journal_entries, journal_lines, stock_movements, audit_log",
        "controls": "Atomic save, FY lock, number non-reuse, org/party validation"
    },
    {
        "area": "Billing controls",
        "title": "Invoice Edit, Owner Delete and Invoice Correction",
        "status": "IMPLEMENTED",
        "actors": "Creator with reason; Owner for delete/approval",
        "description": "Controls changes to saved invoices, protects numbering and rebuilds the related accounting/stock effects safely.",
        "steps": ["Open saved invoice", "Choose edit, delete or correction request", "Check role, FY and delivered/offline locks", "Require reason and owner action where applicable", "Repost or create approved credit note", "Keep original number and full audit trail"],
        "accounting": "Repost journal or post credit-note reversal",
        "stock": "Replace/remove movements or return stock where applicable",
        "records": "bills, invoice_correction_requests, credit_debit_notes, audit_log",
        "controls": "Soft delete; mandatory reason; numbers never renumbered"
    },
    {
        "area": "Billing productivity",
        "title": "Duplicate and Cross-Organization Voucher",
        "status": "IMPLEMENTED",
        "actors": "Owner, permitted staff",
        "description": "Copies an existing voucher as a new draft/transaction while requiring valid target-company party, address, item and account identities.",
        "steps": ["Select source transaction", "Choose duplicate or target company", "Map party, addresses, items and accounts", "Generate new target sequence", "Save independent transaction", "Post target accounting/stock and audit"],
        "accounting": "New posting only for accounting voucher types",
        "stock": "New movement only for stock-changing types",
        "records": "bills/payments/purchases/expenses/notes/journals/PO, audit_log",
        "controls": "No source ID reuse; cross-org mapping validation"
    },
    {
        "area": "Payments",
        "title": "Payment Received and Invoice Allocation",
        "status": "IMPLEMENTED",
        "actors": "Owner, finance, counter",
        "description": "Records money received, optionally into a personal/bank/cash ledger, and allocates it to one or more invoices.",
        "steps": ["Select party and receipt mode", "Choose deposit ledger and reference", "Enter amount", "Allocate against open invoices", "Save receipt number", "Post cash/bank debit and receivable credit", "Recalculate invoice settlement"],
        "accounting": "Debit selected cash/bank; credit receivable or other income",
        "stock": "None",
        "records": "payments(type=received), payment_allocations, journal_entries",
        "controls": "Allocation cannot exceed valid amount; FY/shift controls"
    },
    {
        "area": "Payments",
        "title": "Payment Paid / Expense Settlement",
        "status": "IMPLEMENTED",
        "actors": "Owner, finance",
        "description": "Records outgoing cash/bank payment to a vendor or general expense destination.",
        "steps": ["Select vendor/payee", "Choose cash/bank ledger", "Enter amount and reference", "Validate FY and permissions", "Save payment voucher", "Post payable/expense debit and money credit", "Show in ledger/history"],
        "accounting": "Debit payable/general expense; credit cash/bank",
        "stock": "None",
        "records": "payments(type=paid), journal_entries, journal_lines",
        "controls": "Owner/finance permission, immutable number, audit"
    },
    {
        "area": "Payments",
        "title": "Owner Approval for Payment Corrections",
        "status": "PROPOSED - NOT BUILT",
        "actors": "Requester: operator/counter; Approver: owner",
        "description": "Proposed controlled correction that preserves the original payment and applies a reversal plus corrected replacement only after owner approval.",
        "steps": ["Requester opens saved payment", "Submit reason and proposed values", "Capture old/new snapshots and impact", "Owner approves, rejects or returns", "On approval reverse original posting", "Create corrected replacement and allocations", "Notify requester and seal audit"],
        "accounting": "Reversal plus replacement; never silent in-place overwrite",
        "stock": "None",
        "records": "Proposed payment_correction_requests plus existing payment/journal tables",
        "controls": "Owner re-authentication, idempotency, closed-FY exception handling"
    },
    {
        "area": "Purchasing",
        "title": "Purchase Order to Purchase Voucher",
        "status": "IMPLEMENTED",
        "actors": "Owner, purchase/finance staff",
        "description": "Creates a vendor order without accounting impact, then converts accepted supply into a purchase voucher.",
        "steps": ["Select vendor", "Create PO lines and expected terms", "Save open PO", "Receive supplier invoice/goods", "Convert PO to purchase", "Post purchase/input GST/payable", "Increase stock and mark PO converted"],
        "accounting": "At conversion: debit purchase/input GST; credit payable/cash/bank",
        "stock": "Purchase quantity in",
        "records": "purchase_orders, purchases, journal_entries, stock_movements",
        "controls": "Only open PO converts; new purchase number generated"
    },
    {
        "area": "Purchasing",
        "title": "Direct Purchase Voucher",
        "status": "IMPLEMENTED",
        "actors": "Owner, finance/purchase staff",
        "description": "Records supplier goods/services, input tax, payable or immediate payment and inventory receipt.",
        "steps": ["Select vendor and supplier invoice", "Add purchase lines", "Calculate input GST and round-off", "Validate FY and duplicate references", "Save purchase number", "Post purchase journal", "Increase item stock"],
        "accounting": "Debit purchases/input GST; credit payable/cash/bank",
        "stock": "Quantity in for inventory lines",
        "records": "purchases, journal_entries, journal_lines, stock_movements",
        "controls": "Organization, date/FY, vendor and item validation"
    },
    {
        "area": "Accounting",
        "title": "Expense Voucher",
        "status": "IMPLEMENTED",
        "actors": "Owner, finance",
        "description": "Records operating expense, optional input GST and the selected cash/bank payment source.",
        "steps": ["Select expense account/payee", "Enter amount, GST and reference", "Choose cash or bank", "Validate FY/permissions", "Save expense number", "Post balanced expense journal", "Expose in reports and ledger"],
        "accounting": "Debit expense/input GST; credit cash/bank",
        "stock": "None",
        "records": "expenses, journal_entries, journal_lines, audit_log",
        "controls": "Balanced posting, FY lock, role permission"
    },
    {
        "area": "Returns and adjustments",
        "title": "Credit Note, Sales Return and Refund",
        "status": "IMPLEMENTED",
        "actors": "Owner, finance",
        "description": "Reduces a customer sale, tax and outstanding amount; optional refund payment and stock return are linked to the original invoice.",
        "steps": ["Select original sale/customer", "Choose returned items and reason", "Calculate taxable/tax reversal", "Save credit-note number", "Post sales/tax/receivable reversal", "Return stock where applicable", "Create refund payment if required"],
        "accounting": "Debit sales/output tax; credit receivable; optional refund posting",
        "stock": "Quantity in for returned inventory",
        "records": "credit_debit_notes(note_type=credit), payments, stock_movements",
        "controls": "Original bill link, amount validation, owner controls"
    },
    {
        "area": "Returns and adjustments",
        "title": "Debit Note and Purchase Return",
        "status": "IMPLEMENTED",
        "actors": "Owner, finance",
        "description": "Records goods/value returned to a supplier and reduces purchase/input-tax or payable effects.",
        "steps": ["Select vendor/purchase context", "Enter return lines and reason", "Calculate value/tax", "Save debit-note number", "Post payable/purchase/input-tax reversal", "Reduce stock for returned goods", "Update vendor ledger"],
        "accounting": "Debit payable; credit purchases/input GST",
        "stock": "Quantity out for purchase return lines",
        "records": "credit_debit_notes(note_type=debit), journal_entries, stock_movements",
        "controls": "FY lock, balanced journal, audit and number non-reuse"
    },
    {
        "area": "Accounting",
        "title": "Manual Journal and Financial-Year Closing",
        "status": "IMPLEMENTED",
        "actors": "Owner, accountant",
        "description": "Posts controlled debit/credit adjustments and locks completed financial years against later transaction changes.",
        "steps": ["Prepare journal lines", "Verify debit equals credit", "Save voucher with narration", "Review trial balance and reports", "Create backup before close", "Owner locks financial year", "Block later dated edits unless controlled reopening"],
        "accounting": "Direct balanced journal and year-end adjustments",
        "stock": "None unless separately rebuilt from source documents",
        "records": "journal_entries, journal_lines, financial_year_locks, backup_log",
        "controls": "Owner/accountant only, balanced totals, lock audit"
    },
    {
        "area": "Banking",
        "title": "Bank Statement Import and Reconciliation",
        "status": "IMPLEMENTED",
        "actors": "Owner, accountant",
        "description": "Imports XLSX/CSV statement rows with duplicate protection and matches each row to a recorded journal line.",
        "steps": ["Upload bank statement", "Hash and reject duplicate import", "Parse statement rows", "Search matching software entry", "Confirm journal-line match", "Store reconciliation state", "Review unmatched rows"],
        "accounting": "No new posting from match itself",
        "stock": "None",
        "records": "bank_statement_imports, bank_statement_rows, bank_reconciliation",
        "controls": "File hash, organization scope, reversible match audit"
    },
    {
        "area": "GST compliance",
        "title": "GST Reports and GSTR-2B Matching",
        "status": "IMPLEMENTED",
        "actors": "Owner, accountant",
        "description": "Builds sales GST summaries and compares imported GSTR-2B purchase rows with Tarangini purchase records.",
        "steps": ["Read saved tax invoices and notes", "Group GSTIN, HSN and tax values", "Import GSTR-2B data", "Match supplier invoice/date/value", "Flag matched and unmatched rows", "Export reports for review", "Accountant files outside Tarangini"],
        "accounting": "Reports existing postings; no automatic filing journal",
        "stock": "None",
        "records": "bills, purchases, credit_debit_notes, gstr2b_imports/rows",
        "controls": "GSTIN/date/value validation and accountant review"
    },
    {
        "area": "GST compliance",
        "title": "GST E-Invoice Registration",
        "status": "PROPOSED - NOT BUILT",
        "actors": "Owner/finance, IRP or authorized GSP",
        "description": "Proposed online submission of an eligible saved invoice to obtain IRN, acknowledgement and signed QR data.",
        "steps": ["Create and validate eligible invoice", "Owner confirms GST submission", "Send idempotent JSON to IRP/GSP", "Receive or reconcile IRN response", "Store IRN, acknowledgement and signed QR", "Lock GST-critical invoice fields", "Print invoice with official QR"],
        "accounting": "Uses existing saved invoice posting",
        "stock": "Uses existing invoice stock movement",
        "records": "Proposed GST submission/request/response records linked to bill_id",
        "controls": "Online only, encrypted credentials, duplicate reconciliation, cancellation rules"
    },
    {
        "area": "GST compliance",
        "title": "GST E-Way Bill Generation and Cancellation",
        "status": "PROPOSED - NOT BUILT",
        "actors": "Owner/dispatch, transporter, E-Way Bill API",
        "description": "Proposed goods-movement process using invoice/challan, dispatch, transporter, vehicle and distance details.",
        "steps": ["Check applicability/exemption", "Capture dispatch/ship-to and transporter", "Validate vehicle, distance and document", "Submit idempotent EWB request", "Store EWB number and validity", "Print/share movement document", "Update vehicle or cancel under permitted rules"],
        "accounting": "No additional journal",
        "stock": "References existing dispatch/sale movement",
        "records": "Proposed EWB request/response/history linked to bill/DC",
        "controls": "Online API, state/job-work rules, expiry and cancellation audit"
    },
    {
        "area": "Customer intake",
        "title": "Customer QR Intake, Upload and PDF Analysis",
        "status": "IMPLEMENTED",
        "actors": "Customer, owner/counter",
        "description": "Accepts a LAN customer request, contact details, service selection, consent and files, then returns a unique order ID.",
        "steps": ["Scan QR/open service page", "Select service and enter customer details", "Upload and preview files", "Analyze PDF pages/colour hints", "Validate consent and required fields", "Create/reuse party and intake request", "Return unique order ID"],
        "accounting": "None",
        "stock": "None",
        "records": "job_intake_requests, job_intake_attachments, parties, analysis jobs",
        "controls": "Idempotency key, file limits, metadata/hash, required-field focus"
    },
    {
        "area": "Job orders",
        "title": "Intake Review and Job Creation",
        "status": "IMPLEMENTED",
        "actors": "Owner, counter",
        "description": "Reviews the customer submission, corrects commercial details and converts it once into a uniquely numbered job order.",
        "steps": ["Open intake review queue", "Verify party/service/files", "Add job item and estimate details", "Convert intake", "Create job token, items and estimate", "Copy attachment metadata", "Link intake to job and audit"],
        "accounting": "None until job billing",
        "stock": "None until material consumption",
        "records": "job_orders, job_items, job_estimates, job_attachments",
        "controls": "One conversion per intake; organization and party linkage"
    },
    {
        "area": "Job orders",
        "title": "Estimate, Quotation and Customer Approval",
        "status": "IMPLEMENTED",
        "actors": "Owner/finance, customer",
        "description": "Stores job estimate versions and exposes the accepted quotation and later additional-work decisions to the customer portal.",
        "steps": ["Prepare estimate lines", "Owner/finance sets customer price", "Publish accepted quotation", "Customer opens secure portal", "Customer reviews amount/terms", "Record approval/rejection and consent", "Preserve estimate/audit history"],
        "accounting": "None until first/final bill",
        "stock": "None",
        "records": "job_estimates, job_customer_approvals, job_audit_events",
        "controls": "Version/history, secure token, immutable decision evidence"
    },
    {
        "area": "Production",
        "title": "Job Assignment and Operator Response",
        "status": "IMPLEMENTED",
        "actors": "Owner/senior operator, assigned employee",
        "description": "Routes a job to the responsible operator/engineer and records acceptance, decline, handoff and instructions.",
        "steps": ["Owner selects job and employee", "Create pending assignment", "Notify/show employee queue", "Employee accepts or declines", "Record response/reason", "Activate accepted responsibility", "Write status and audit event"],
        "accounting": "None",
        "stock": "None",
        "records": "job_assignments, job_status_events, job_audit_events",
        "controls": "Assigned-user visibility, delivered-job lock, response history"
    },
    {
        "area": "Production",
        "title": "Production Status, Work Report and Daily Log",
        "status": "IMPLEMENTED",
        "actors": "Operator, engineer, owner",
        "description": "Tracks job progress, work performed, pending work, file names and miscellaneous employee activity through daily submission and owner review.",
        "steps": ["Start accepted job", "Update allowed production status", "Add work-done/pending report", "Auto-collect job and billing events", "Add miscellaneous work if needed", "Submit daily report", "Owner reviews, returns or reopens"],
        "accounting": "None directly",
        "stock": "Only when separate material transaction is recorded",
        "records": "job_status_events, job_work_reports, operator_daily_logs/entries",
        "controls": "Status transition rules, assignment check, submitted-log lock"
    },
    {
        "area": "Production and inventory",
        "title": "Job Material Consumption",
        "status": "IMPLEMENTED",
        "actors": "Assigned operator/engineer",
        "description": "Links inventory consumed during production to the specific job and reduces available stock.",
        "steps": ["Open assigned active job", "Select inventory item", "Enter consumed quantity and note", "Validate assignment and stock", "Save job material record", "Create stock quantity-out movement", "Audit and show stock warning"],
        "accounting": "No direct cost journal in current flow",
        "stock": "Quantity out linked to job material source",
        "records": "job_material_consumptions, stock_movements, job_audit_events",
        "controls": "Accepted assignment, delivered-job lock, item/org validation"
    },
    {
        "area": "Production",
        "title": "Additional Work, Evidence and Customer Decision",
        "status": "IMPLEMENTED",
        "actors": "Operator, finance/owner, customer",
        "description": "Captures unexpected additional work, prices it, requests customer approval and includes only approved value in final billing.",
        "steps": ["Operator proposes addition with reason", "Attach evidence metadata", "Finance sets description, tax and price", "Publish awaiting-customer request", "Customer approves or rejects", "Store decision and evidence hash", "Include approved addition in final bill"],
        "accounting": "None until included in bill",
        "stock": "Separate material records handle consumption",
        "records": "job_additions, job_attachments, job_customer_approvals",
        "controls": "Price permission, secure customer token, decision audit"
    },
    {
        "area": "Job billing and delivery",
        "title": "First Bill, Final Invoice, Delivery and Collection",
        "status": "IMPLEMENTED",
        "actors": "Owner, finance, counter, customer",
        "description": "Links job and invoice IDs, reuses a matching first bill, prevents duplicate final billing, records delivery and applies receipt payments.",
        "steps": ["Create optional first bill from estimate", "Complete production and quality check", "Mark ready for delivery", "Compare accepted estimate/additions to first bill", "Reuse bill or create one final SALE", "Record receiver and payment", "Set DELIVERED and schedule retention"],
        "accounting": "Sale posting plus any receipt postings",
        "stock": "Invoice product lines/material transactions retain their movements",
        "records": "job_orders, bills, payments, delivery acknowledgements, audit",
        "controls": "One final_bill_id, amount comparison, delivered-job lock"
    },
    {
        "area": "Customer portal",
        "title": "Order Tracking, Quotation and Output Preview",
        "status": "IMPLEMENTED",
        "actors": "Customer",
        "description": "Lets the customer use order ID/secure token to see status, quotation, approvals, invoice/payment state and permitted inline previews.",
        "steps": ["Enter tracking identity/open secure link", "Validate order/token and expiry", "Load job timeline and quotation", "Show invoice/payment status", "Show customer-visible attachment metadata", "Stream retained file inline", "Record customer decision/upload audit"],
        "accounting": "Read-only visibility of linked invoice/payment state",
        "stock": "None",
        "records": "job access tokens, job status, approvals, attachments, messages",
        "controls": "No cross-job access, no download button, visibility/retention checks"
    },
    {
        "area": "Files",
        "title": "Attachment Analysis, Archive and Retention",
        "status": "IMPLEMENTED",
        "actors": "Customer, operator, owner, retention worker",
        "description": "Stores controlled job files, retains metadata, analyzes PDF/images and deletes non-archived bytes seven days after completed delivery.",
        "steps": ["Receive and hash upload", "Store bytes and metadata", "Analyze pages/colour/dimensions", "Mark customer preview visibility", "Owner optionally archives important file", "Retention worker finds expired files", "Delete bytes but retain filename/hash/audit"],
        "accounting": "None",
        "stock": "None",
        "records": "job_attachments, intake_attachments, attachment_analysis_jobs",
        "controls": "File limits, path safety, archive exception, metadata retention"
    },
    {
        "area": "Warranty",
        "title": "Warranty Replacement and Service-Center Tracking",
        "status": "IMPLEMENTED",
        "actors": "Owner, counter, operator, vendor/service center",
        "description": "Tracks a faulty sold product from customer receipt through delivery challan, courier/RMA follow-up and final resolution.",
        "steps": ["Select customer and original sale", "Record product, serial and fault", "Check warranty/service-center category", "Create/link delivery challan", "Record courier tracking and RMA", "Follow status/date with vendor", "Resolve and return/close case"],
        "accounting": "No automatic journal; linked billing remains separate",
        "stock": "No automatic movement beyond linked transaction",
        "records": "warranty_replacements, warranty_service_centers, bills, audit_log",
        "controls": "Unique WR number, party/bill validation, serial required"
    },
    {
        "area": "POS",
        "title": "Shift, Held Bill and Day-End Acceptance",
        "status": "IMPLEMENTED",
        "actors": "Cashier, owner",
        "description": "Tracks counter opening, parked carts, shift-linked invoices/payments, counted cash, variance and owner acceptance.",
        "steps": ["Open shift with opening cash", "Create/resume held carts", "Save invoices and collections to shift", "Calculate promised versus collected modes", "Cashier enters closing counts", "Close shift and show variance", "Owner accepts and audits"],
        "accounting": "Invoices/payments post normally; shift summarizes them",
        "stock": "Invoices post normal stock movements",
        "records": "pos_shifts, held_bills, bills, payments",
        "controls": "One active shift rules, close/accept states, owner review"
    },
    {
        "area": "Network continuity",
        "title": "Client Offline Queue and Main-System Synchronization",
        "status": "IMPLEMENTED - LIMITED SAFE SCOPE",
        "actors": "Client PC, Main System, owner",
        "description": "Allows approved document drafts such as quotations to queue locally, then synchronizes idempotently when the single Main System returns.",
        "steps": ["Client health check fails", "Enter limited offline mode", "Save permitted local document with device identity", "Show pending item in local register", "Discover/reconnect Main System", "Replay with idempotency and unique numbering", "Mark synced or conflict for owner"],
        "accounting": "Final accounting writes remain Main-System controlled",
        "stock": "Stock-changing offline writes remain restricted",
        "records": "Client queue/cache plus server bills/audit after sync",
        "controls": "Stable device ID, retry idempotency, one Main System, conflict lock"
    },
    {
        "area": "Backup and recovery",
        "title": "Manual Migration Backup, Encrypted Backup and Restore",
        "status": "IMPLEMENTED",
        "actors": "Owner, automatic backup service",
        "description": "Creates migration JSON or encrypted full-database backups, verifies history and rebuilds mappings/accounting during controlled restore.",
        "steps": ["Checkpoint/validate live database", "Choose JSON export or encrypted DB backup", "Write to separate backup location", "Record hash/result in backup log", "Select verified backup for restore", "Restore/map entities and rebuild journals", "Run integrity and restore tests"],
        "accounting": "All accounting data preserved/rebuilt",
        "stock": "All source movements preserved/rebuilt",
        "records": "All business tables, backup_log, data_shift batches/maps",
        "controls": "Recovery key, separate disk, pre-upgrade backup, integrity check"
    },
    {
        "area": "Online rollout",
        "title": "Public Customer Website Transaction",
        "status": "PROPOSED - NOT BUILT",
        "actors": "Internet customer, cloud API, Main System",
        "description": "Proposed public HTTPS intake and tracking service that syncs controlled records without exposing SQLite or the LAN server to the internet.",
        "steps": ["Customer opens HTTPS website", "OTP/rate-limit and organization selection", "Submit intake using idempotency key", "Upload to private object storage", "Cloud queue validates and scans", "Controlled connector syncs to Main System", "Customer tracks status from safe projection"],
        "accounting": "No public direct accounting write in first rollout",
        "stock": "No public direct stock write",
        "records": "Proposed cloud intake/upload/status projection plus mapped local IDs",
        "controls": "HTTPS, WAF/rate limit, org isolation, signed preview, conflict queue"
    },
    {
        "area": "Online rollout",
        "title": "Android Customer and Staff Application",
        "status": "PROPOSED - NOT BUILT",
        "actors": "Customer/staff app, public API, Main System",
        "description": "Proposed Android client using the same versioned APIs as the website with an encrypted local cache and controlled background synchronization.",
        "steps": ["Install signed Android app", "Authenticate customer or staff role", "Read/write only permitted API resources", "Cache safe data locally", "Queue permitted offline action", "Background sync with idempotency/version check", "Resolve conflict or refresh server truth"],
        "accounting": "Remote billing only after separate approval/security phase",
        "stock": "No unsafe offline stock writes",
        "records": "Same API IDs: org, party, item, job, bill and payment references",
        "controls": "HTTPS, token rotation, device security, RBAC, no shared database"
    },
]


def safe_text(value):
    return str(value).replace("&", "and").replace("<", "").replace(">", "")


def draw_wrapped(c, text, x, y, width, font="Helvetica", size=8, color=INK, leading=10, max_lines=None):
    c.setFont(font, size)
    c.setFillColor(color)
    words = safe_text(text).split()
    lines, current = [], ""
    for word in words:
        trial = f"{current} {word}".strip()
        if stringWidth(trial, font, size) <= width:
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    if max_lines and len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = lines[-1][:-3] + "..." if len(lines[-1]) > 3 else "..."
    for index, line in enumerate(lines):
        c.drawString(x, y - index * leading, line)
    return y - len(lines) * leading


def pill(c, text, x, y, fill, text_color=WHITE):
    width = stringWidth(text, "Helvetica-Bold", 7) + 16
    c.setFillColor(fill)
    c.roundRect(x, y - 12, width, 17, 8, fill=1, stroke=0)
    c.setFillColor(text_color)
    c.setFont("Helvetica-Bold", 7)
    c.drawCentredString(x + width / 2, y - 7, text)
    return width


def arrow(c, x1, y1, x2, y2):
    c.setStrokeColor(TEAL)
    c.setFillColor(TEAL)
    c.setLineWidth(1.5)
    c.line(x1, y1, x2, y2)
    angle = 5
    if abs(x2 - x1) >= abs(y2 - y1):
        direction = 1 if x2 > x1 else -1
        c.line(x2, y2, x2 - direction * 7, y2 + angle)
        c.line(x2, y2, x2 - direction * 7, y2 - angle)
    else:
        direction = 1 if y2 > y1 else -1
        c.line(x2, y2, x2 + angle, y2 - direction * 7)
        c.line(x2, y2, x2 - angle, y2 - direction * 7)


def step_box(c, number, text, x, y, width, height, proposed=False):
    fill = GOLD_LIGHT if proposed else WHITE
    stroke = GOLD if proposed else LINE
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(1)
    c.roundRect(x, y, width, height, 7, fill=1, stroke=1)
    c.setFillColor(GOLD if proposed else TEAL)
    c.circle(x + 15, y + height - 15, 9, fill=1, stroke=0)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 8)
    c.drawCentredString(x + 15, y + height - 18, str(number))
    draw_wrapped(c, text, x + 9, y + height - 34, width - 18, "Helvetica-Bold", 7.5, INK, 9, 4)


def footer(c, page_no):
    c.setStrokeColor(LINE)
    c.line(28, 24, PAGE_W - 28, 24)
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 7)
    c.drawString(30, 12, "Tarangini Workflow Suite - All Transaction UML")
    c.drawRightString(PAGE_W - 30, 12, f"Page {page_no}")


def cover(c, page_no):
    c.setFillColor(NAVY)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(TEAL)
    c.circle(PAGE_W - 85, PAGE_H - 70, 85, fill=1, stroke=0)
    c.setFillColor(GOLD)
    c.circle(PAGE_W - 35, 55, 45, fill=1, stroke=0)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 27)
    c.drawString(55, PAGE_H - 135, "Tarangini Workflow Suite")
    c.setFont("Helvetica-Bold", 22)
    c.drawString(55, PAGE_H - 175, "Every Transaction UML and Control Map")
    draw_wrapped(c, "Implemented billing, accounting, inventory, customer intake, production, warranty, sync and backup flows - plus clearly marked proposed payment, GST and online rollout designs.", 58, PAGE_H - 220, 560, "Helvetica", 11, colors.HexColor("#D9E2EC"), 16)
    c.setFillColor(colors.HexColor("#D9E2EC"))
    c.setFont("Helvetica", 9)
    c.drawString(58, 80, f"Generated from the current source architecture | {len(TRANSACTIONS)} transaction diagrams")
    footer(c, page_no)
    c.showPage()


def overview(c, page_no):
    c.setFillColor(PAPER)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 20)
    c.drawString(38, PAGE_H - 52, "End-to-End Transaction Spine")
    pill(c, "OVERVIEW", PAGE_W - 110, PAGE_H - 43, TEAL)
    nodes = [
        ("Customer / Party", "Identity and addresses"),
        ("Quote / Intake", "Commercial request"),
        ("Job / Supply", "Production or delivery"),
        ("Invoice", "Permanent fiscal document"),
        ("Payment", "Settlement and allocation"),
        ("Ledger / Stock", "Accounting truth"),
        ("Audit / Backup", "Evidence and recovery"),
    ]
    x, y, w, h, gap = 32, 330, 100, 78, 14
    for idx, (title, sub) in enumerate(nodes):
        step_box(c, idx + 1, f"{title}\n{sub}", x + idx * (w + gap), y, w, h)
        if idx < len(nodes) - 1:
            arrow(c, x + idx * (w + gap) + w, y + h / 2, x + (idx + 1) * (w + gap) - 2, y + h / 2)
    c.setFillColor(WHITE)
    c.setStrokeColor(LINE)
    c.roundRect(38, 100, PAGE_W - 76, 170, 10, fill=1, stroke=1)
    c.setFillColor(TEAL)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(55, 245, "Rules that connect every transaction")
    rules = [
        "org_id separates each company and controls access.",
        "party_id and address snapshots preserve the exact customer/vendor used.",
        "item_id connects invoices, purchases, stock and job material consumption.",
        "job_id, bill_id and payment allocations connect production to accounting.",
        "Financial numbers are never reused after save or soft deletion.",
        "Audit records identify user, reason, device/time and before/after impact.",
        "Only one Main System is the accounting and stock source of truth.",
        "PROPOSED diagrams are designs only and do not claim existing functionality.",
    ]
    for index, rule in enumerate(rules):
        col = 0 if index < 4 else 1
        row = index if index < 4 else index - 4
        bx = 58 + col * 370
        by = 215 - row * 32
        c.setFillColor(GOLD if index == 7 else TEAL)
        c.circle(bx, by + 2, 4, fill=1, stroke=0)
        draw_wrapped(c, rule, bx + 12, by + 6, 330, "Helvetica", 8.5, INK, 11, 2)
    footer(c, page_no)
    c.showPage()


def index_page(c, page_no, entries, heading):
    c.setFillColor(PAPER)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 20)
    c.drawString(38, PAGE_H - 52, heading)
    pill(c, "INDEX", PAGE_W - 100, PAGE_H - 43, TEAL)
    c.setFillColor(WHITE)
    c.setStrokeColor(LINE)
    c.roundRect(38, 62, PAGE_W - 76, PAGE_H - 145, 10, fill=1, stroke=1)
    row_height = 23
    start_y = PAGE_H - 113
    for row_index, (number, txn, pdf_page) in enumerate(entries):
        y = start_y - row_index * row_height
        if row_index % 2:
            c.setFillColor(colors.HexColor("#F0F4F8"))
            c.rect(47, y - 15, PAGE_W - 94, row_height, fill=1, stroke=0)
        c.setFillColor(GOLD if txn["status"].startswith("PROPOSED") else TEAL)
        c.setFont("Helvetica-Bold", 8)
        c.drawString(57, y - 5, f"{number:02d}")
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 8.2)
        c.drawString(88, y - 5, safe_text(txn["title"]))
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 7.5)
        c.drawString(455, y - 5, safe_text(txn["area"]))
        c.setFillColor(GOLD if txn["status"].startswith("PROPOSED") else GREEN)
        c.setFont("Helvetica-Bold", 7)
        status = "PROPOSED" if txn["status"].startswith("PROPOSED") else "IMPLEMENTED"
        c.drawString(650, y - 5, status)
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 8)
        c.drawRightString(PAGE_W - 58, y - 5, str(pdf_page))
    footer(c, page_no)
    c.showPage()


def transaction_page(c, txn, page_no, number):
    proposed = txn["status"].startswith("PROPOSED")
    c.setFillColor(PAPER)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.rect(0, PAGE_H - 92, PAGE_W, 92, fill=1, stroke=0)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(38, PAGE_H - 30, f"{number:02d}  |  {txn['area'].upper()}")
    c.setFont("Helvetica-Bold", 18)
    c.drawString(38, PAGE_H - 61, safe_text(txn["title"]))
    badge_fill = GOLD if proposed else GREEN
    pill(c, txn["status"], PAGE_W - stringWidth(txn["status"], "Helvetica-Bold", 7) - 65, PAGE_H - 36, badge_fill)

    c.setFillColor(TEAL_LIGHT if not proposed else GOLD_LIGHT)
    c.roundRect(38, PAGE_H - 146, PAGE_W - 76, 38, 8, fill=1, stroke=0)
    c.setFillColor(TEAL if not proposed else colors.HexColor("#9C6500"))
    c.setFont("Helvetica-Bold", 8)
    c.drawString(50, PAGE_H - 123, "ACTORS")
    draw_wrapped(c, txn["actors"], 105, PAGE_H - 122, 250, "Helvetica", 8.5, INK, 10, 2)
    c.setFont("Helvetica-Bold", 8)
    c.setFillColor(TEAL if not proposed else colors.HexColor("#9C6500"))
    c.drawString(385, PAGE_H - 123, "PURPOSE")
    draw_wrapped(c, txn["description"], 435, PAGE_H - 116, 350, "Helvetica", 8, INK, 10, 3)

    steps = txn["steps"]
    box_w, box_h = 96, 72
    start_x, top_y, gap_x = 38, 316, 16
    first_count = min(4, len(steps))
    positions = []
    for i in range(first_count):
        positions.append((start_x + i * (box_w + gap_x), top_y))
    if len(steps) > 4:
        second = len(steps) - 4
        for i in range(second):
            positions.append((start_x + (second - 1 - i) * (box_w + gap_x), 210))
    for i, (step, pos) in enumerate(zip(steps, positions)):
        step_box(c, i + 1, step, pos[0], pos[1], box_w, box_h, proposed)
        if i:
            prev_x, prev_y = positions[i - 1]
            cur_x, cur_y = pos
            if prev_y == cur_y:
                if cur_x > prev_x:
                    arrow(c, prev_x + box_w, prev_y + box_h / 2, cur_x - 2, cur_y + box_h / 2)
                else:
                    arrow(c, prev_x, prev_y + box_h / 2, cur_x + box_w + 2, cur_y + box_h / 2)
            else:
                arrow(c, prev_x + box_w / 2, prev_y, cur_x + box_w / 2, cur_y + box_h + 2)

    panel_y, panel_h = 54, 122
    c.setFillColor(WHITE)
    c.setStrokeColor(LINE)
    c.roundRect(38, panel_y, PAGE_W - 76, panel_h, 9, fill=1, stroke=1)
    labels = [
        ("ACCOUNTING EFFECT", txn["accounting"]),
        ("STOCK EFFECT", txn["stock"]),
        ("MAIN RECORDS", txn["records"]),
        ("KEY CONTROLS", txn["controls"]),
    ]
    col_w = (PAGE_W - 100) / 4
    for i, (label, value) in enumerate(labels):
        px = 50 + i * col_w
        if i:
            c.setStrokeColor(LINE)
            c.line(px - 8, panel_y + 12, px - 8, panel_y + panel_h - 12)
        c.setFillColor(GOLD if proposed else TEAL)
        c.setFont("Helvetica-Bold", 7.5)
        c.drawString(px, panel_y + panel_h - 23, label)
        draw_wrapped(c, value, px, panel_y + panel_h - 43, col_w - 17, "Helvetica", 7.5, INK, 10, 6)
    footer(c, page_no)
    c.showPage()


def generate_markdown():
    lines = [
        "# Tarangini Workflow Suite - All Transaction UML",
        "",
        "Generated from the current source architecture. `IMPLEMENTED` means the workflow exists in the present application. `PROPOSED - NOT BUILT` is a reviewed future design only.",
        "",
        "## End-to-End Transaction Spine",
        "",
        "```mermaid",
        "flowchart LR",
        '  A["Customer / Party"] --> B["Quote / Intake"] --> C["Job / Supply"] --> D["Invoice"] --> E["Payment"] --> F["Ledger / Stock"] --> G["Audit / Backup"]',
        "```",
        "",
    ]
    for index, txn in enumerate(TRANSACTIONS, 1):
        lines.extend([
            f"## {index}. {txn['title']}",
            "",
            f"**Status:** {txn['status']}  ",
            f"**Actors:** {txn['actors']}  ",
            f"**Purpose:** {txn['description']}",
            "",
            "```mermaid",
            "flowchart LR",
        ])
        for step_index, step in enumerate(txn["steps"], 1):
            label = safe_text(step).replace('"', "'")
            lines.append(f'  S{step_index}["{step_index}. {label}"]')
        if len(txn["steps"]) > 1:
            lines.append("  " + " --> ".join(f"S{i}" for i in range(1, len(txn["steps"]) + 1)))
        if txn["status"].startswith("PROPOSED"):
            lines.extend([
                "  classDef proposed fill:#fff2d8,stroke:#e9a23b,color:#243b53;",
                "  class " + ",".join(f"S{i}" for i in range(1, len(txn["steps"]) + 1)) + " proposed;",
            ])
        lines.extend([
            "```",
            "",
            f"- Accounting effect: {txn['accounting']}",
            f"- Stock effect: {txn['stock']}",
            f"- Main records: {txn['records']}",
            f"- Key controls: {txn['controls']}",
            "",
        ])
    MD_PATH.write_text("\n".join(lines), encoding="utf-8")


def generate_pdf():
    PDF_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(PDF_PATH), pagesize=landscape(A4))
    c.setTitle("Tarangini All Transaction UML")
    c.setAuthor("Tarangini Workflow Suite")
    page_no = 1
    cover(c, page_no)
    page_no += 1
    overview(c, page_no)
    page_no += 1
    transaction_start_page = 5
    indexed = [
        (number, txn, transaction_start_page + number - 1)
        for number, txn in enumerate(TRANSACTIONS, 1)
    ]
    index_page(c, page_no, indexed[:20], "Transaction Index - Part 1")
    page_no += 1
    index_page(c, page_no, indexed[20:], "Transaction Index - Part 2")
    page_no += 1
    for number, txn in enumerate(TRANSACTIONS, 1):
        transaction_page(c, txn, page_no, number)
        page_no += 1
    c.save()


if __name__ == "__main__":
    generate_markdown()
    generate_pdf()
    print(MD_PATH)
    print(PDF_PATH)
