from pathlib import Path
from textwrap import wrap

from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf"
PDF_PATH = OUTPUT / "Tarangini_Full_System_UML_Roles_Departments.pdf"
PAGE_W, PAGE_H = landscape(A4)

NAVY = HexColor("#12233F")
BLUE = HexColor("#2563EB")
CYAN = HexColor("#0891B2")
TEAL = HexColor("#0F766E")
GREEN = HexColor("#15803D")
AMBER = HexColor("#D97706")
RED = HexColor("#B91C1C")
PURPLE = HexColor("#7E22CE")
SLATE = HexColor("#475569")
MID = HexColor("#94A3B8")
LIGHT = HexColor("#E2E8F0")
PALE = HexColor("#F8FAFC")
PALE_BLUE = HexColor("#EFF6FF")
PALE_GREEN = HexColor("#F0FDF4")
PALE_AMBER = HexColor("#FFFBEB")
PALE_RED = HexColor("#FEF2F2")


def fit_text(text, max_width, font="Helvetica", max_size=9, min_size=6):
    size = max_size
    while size > min_size and stringWidth(text, font, size) > max_width:
        size -= 0.25
    return size


def wrapped_lines(text, width, font_size=8.2):
    chars = max(14, int(width / (font_size * 0.51)))
    result = []
    for paragraph in str(text).split("\n"):
        result.extend(wrap(paragraph, width=chars) or [""])
    return result


def draw_wrapped(c, text, x, y, width, font_size=8.2, leading=None, color=NAVY,
                 font="Helvetica", max_lines=None):
    leading = leading or font_size * 1.25
    lines = wrapped_lines(text, width, font_size)
    if max_lines:
        lines = lines[:max_lines]
    c.setFont(font, font_size)
    c.setFillColor(color)
    for line in lines:
        c.drawString(x, y, line)
        y -= leading
    return y


def header(c, page_no, title, subtitle):
    c.setFillColor(NAVY)
    c.rect(0, PAGE_H - 58, PAGE_W, 58, stroke=0, fill=1)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 17)
    c.drawString(28, PAGE_H - 31, title)
    c.setFont("Helvetica", 8.2)
    c.setFillColor(HexColor("#CBD5E1"))
    c.drawString(29, PAGE_H - 46, subtitle)
    c.setFillColor(PALE)
    c.setFont("Helvetica-Bold", 8)
    c.drawRightString(PAGE_W - 28, PAGE_H - 33, "TARANGINI BILLING v2.4.0")
    c.setFillColor(SLATE)
    c.setFont("Helvetica", 7)
    c.drawString(28, 16, "System UML and operational reference | Generated 19 June 2026")
    c.drawRightString(PAGE_W - 28, 16, f"Page {page_no}")


def box(c, x, y, w, h, title, body="", fill=white, stroke=LIGHT,
        title_color=NAVY, body_color=SLATE, radius=8, title_size=9.2,
        body_size=7.5):
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(0.8)
    c.roundRect(x, y, w, h, radius, stroke=1, fill=1)
    c.setFillColor(title_color)
    c.setFont("Helvetica-Bold", fit_text(title, w - 16, "Helvetica-Bold", title_size, 6.5))
    c.drawString(x + 8, y + h - 16, title)
    if body:
        draw_wrapped(c, body, x + 8, y + h - 29, w - 16, body_size,
                     body_size * 1.22, body_color, max_lines=max(1, int((h - 35) / (body_size * 1.22))))


def pill(c, x, y, text, fill=BLUE, text_color=white, width=None):
    width = width or max(50, stringWidth(text, "Helvetica-Bold", 7) + 16)
    c.setFillColor(fill)
    c.roundRect(x, y, width, 16, 8, stroke=0, fill=1)
    c.setFillColor(text_color)
    c.setFont("Helvetica-Bold", 7)
    c.drawCentredString(x + width / 2, y + 5, text)
    return width


def arrow(c, x1, y1, x2, y2, label=None, color=SLATE, dashed=False):
    import math

    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(1.25)
    c.setDash(4, 3) if dashed else c.setDash()
    c.line(x1, y1, x2, y2)
    angle = math.atan2(y2 - y1, x2 - x1)
    size = 6
    for offset in (2.55, -2.55):
        c.line(x2, y2, x2 + size * math.cos(angle + offset),
               y2 + size * math.sin(angle + offset))
    c.setDash()
    if label:
        mx, my = (x1 + x2) / 2, (y1 + y2) / 2
        tw = stringWidth(label, "Helvetica-Bold", 6.8)
        c.setFillColor(white)
        c.rect(mx - tw / 2 - 3, my - 5, tw + 6, 11, stroke=0, fill=1)
        c.setFillColor(color)
        c.setFont("Helvetica-Bold", 6.8)
        c.drawCentredString(mx, my - 2, label)


def actor(c, x, y, name, caption="", color=BLUE):
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(1.5)
    c.circle(x, y + 31, 7, stroke=1, fill=0)
    c.line(x, y + 24, x, y + 4)
    c.line(x - 11, y + 17, x + 11, y + 17)
    c.line(x, y + 4, x - 9, y - 9)
    c.line(x, y + 4, x + 9, y - 9)
    c.setFont("Helvetica-Bold", 7.5)
    c.drawCentredString(x, y - 22, name)
    if caption:
        c.setFillColor(SLATE)
        c.setFont("Helvetica", 6.5)
        c.drawCentredString(x, y - 32, caption)


def diamond(c, x, y, w, h, text, fill=PALE_AMBER, stroke=AMBER):
    points = [(x, y + h / 2), (x + w / 2, y + h), (x + w, y + h / 2), (x + w / 2, y)]
    p = c.beginPath()
    p.moveTo(*points[0])
    for point in points[1:]:
        p.lineTo(*point)
    p.close()
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.drawPath(p, stroke=1, fill=1)
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 7.2)
    c.drawCentredString(x + w / 2, y + h / 2 - 2, text)


def page_cover(c):
    c.setFillColor(NAVY)
    c.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    c.setFillColor(BLUE)
    c.circle(PAGE_W - 120, PAGE_H - 90, 145, stroke=0, fill=1)
    c.setFillColor(CYAN)
    c.circle(PAGE_W - 52, 56, 105, stroke=0, fill=1)
    c.setFillColor(HexColor("#1E3A5F"))
    c.roundRect(44, 54, 530, 470, 18, stroke=0, fill=1)
    pill(c, 72, 475, "SYSTEM REFERENCE", CYAN, width=112)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 31)
    c.drawString(72, 422, "Tarangini Billing")
    c.setFont("Helvetica-Bold", 25)
    c.drawString(72, 387, "Full UML Manual")
    c.setFillColor(HexColor("#CBD5E1"))
    c.setFont("Helvetica", 12)
    c.drawString(73, 354, "Roles, departments, transactions, workflows and architecture")
    sections = [
        "Owner and staff permission model",
        "Billing, POS, GST, inventory and accounting",
        "Job order production and quality workflow",
        "Mobile LAN, offline sync, backup and update system",
    ]
    y = 306
    for text in sections:
        c.setFillColor(CYAN)
        c.circle(80, y + 3, 3, stroke=0, fill=1)
        c.setFillColor(white)
        c.setFont("Helvetica", 10.5)
        c.drawString(92, y, text)
        y -= 34
    c.setFillColor(HexColor("#94A3B8"))
    c.setFont("Helvetica", 8.5)
    c.drawString(72, 82, "Version 2.4.0 | Prepared from the current application source")
    c.showPage()


def page_scope(c, n):
    header(c, n, "1. System Scope and UML Legend",
           "A single map of the application boundary, actors and diagram notation")
    box(c, 28, 383, 240, 128, "System Boundary",
        "Tarangini is an Electron desktop billing suite with a Node/Express API, SQLite data store, LAN browser access, offline client queue, GST exports, accounting, inventory, job workflow, backup and in-place updates.",
        PALE_BLUE, HexColor("#BFDBFE"), BLUE, NAVY, body_size=8)
    box(c, 284, 383, 248, 128, "Important Modeling Note",
        "Roles are configured identities and permissions. Departments in this manual are logical functional areas inferred from workflows. The current database does not maintain a separate department master.",
        PALE_AMBER, HexColor("#FDE68A"), AMBER, NAVY, body_size=8)
    box(c, 548, 383, 266, 128, "Authority Rule",
        "Owner has full system access. Owner1 is the protected primary owner. Other staff receive role defaults plus optional per-user permission overrides. Company access and current organization context are always enforced.",
        PALE_GREEN, HexColor("#BBF7D0"), GREEN, NAVY, body_size=8)

    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(28, 354, "Diagram Legend")
    actor(c, 72, 273, "Actor", "human user", BLUE)
    box(c, 132, 267, 126, 58, "Use Case", "User-visible capability", PALE_BLUE, BLUE)
    box(c, 286, 267, 126, 58, "Component", "Deployable service", PALE_GREEN, GREEN)
    box(c, 440, 267, 126, 58, "Data Entity", "Persisted record", PALE_AMBER, AMBER)
    diamond(c, 598, 270, 88, 52, "Decision")
    arrow(c, 708, 296, 798, 296, "flow", PURPLE)

    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(28, 220, "External Actors and Systems")
    items = [
        ("Customer", "Receives quotations, invoices, delivery and job updates", BLUE),
        ("Vendor", "Supplies items and purchase documents", TEAL),
        ("Bank", "Statements, receipt references and reconciliation", GREEN),
        ("GST Portal", "GSTR exports and compliance upload", AMBER),
        ("WhatsApp", "Job/customer communication channel", PURPLE),
        ("LAN Device", "Mobile/tablet POS and operational access", CYAN),
    ]
    x, y = 28, 128
    for title, body, color in items:
        box(c, x, y, 124, 70, title, body, white, color, color, SLATE, body_size=6.7)
        x += 133
    c.showPage()


def page_departments(c, n):
    header(c, n, "2. Logical Departments and Responsibility Map",
           "Functional areas, primary actors and the information they own")
    departments = [
        ("Ownership / Admin", "Owner, Owner1", "Companies, users, permissions, settings, audit", BLUE),
        ("Front Counter", "Counter", "Customer intake, quotations, advances, job creation", CYAN),
        ("Sales & Billing", "Owner, Counter, Operator", "Invoices, POS, returns, delivery documents", TEAL),
        ("Accounts & Finance", "Owner, Counter", "Receipts, payments, journal, ledgers, handover", GREEN),
        ("Purchases", "Owner", "Vendors, purchase bills, orders and expenses", PURPLE),
        ("Inventory / Stock", "Owner, billing staff", "Items, HSN, stock movement and valuation", AMBER),
        ("Production", "Operator, Senior Operator, Engineer", "Assignments, work reports and job status", BLUE),
        ("Quality Control", "Senior Operator, Owner", "Inspection, rework, completion approval", RED),
        ("Delivery / Dispatch", "Counter, Owner", "Delivery details, challans, acknowledgement", CYAN),
        ("GST / Compliance", "Owner", "Tax reports, GSTR-1, GSTR-2B and Tally export", AMBER),
        ("IT / System Admin", "Owner", "LAN clients, backup, updates, diagnostics, security", SLATE),
        ("Customer Service", "Counter, Owner", "Party master, shared organizations, messages", PURPLE),
    ]
    x_positions = [28, 230, 432, 634]
    y_positions = [400, 274, 148]
    for idx, (title, actors, body, color) in enumerate(departments):
        x = x_positions[idx % 4]
        y = y_positions[idx // 4]
        box(c, x, y, 180, 98, title, f"Primary: {actors}\n{body}",
            white, color, color, SLATE, body_size=7.2)

    arrow(c, 118, 400, 320, 372, "sales data", BLUE, True)
    arrow(c, 522, 400, 320, 372, "financial posting", GREEN, True)
    arrow(c, 724, 400, 522, 372, "stock impact", AMBER, True)
    arrow(c, 320, 274, 522, 246, "material demand", PURPLE, True)
    arrow(c, 522, 274, 724, 246, "quality gate", RED, True)
    arrow(c, 724, 274, 118, 246, "delivery billing", CYAN, True)

    c.setFillColor(SLATE)
    c.setFont("Helvetica-Oblique", 7.5)
    c.drawString(28, 78, "Cross-department rule: every material change is organization-scoped and attributable to an authenticated user.")
    c.showPage()


def page_roles(c, n):
    header(c, n, "3. Role Hierarchy and Access Model",
           "Default authority, protected ownership and configurable overrides")
    actor(c, 70, 418, "Owner1", "protected root owner", BLUE)
    actor(c, 200, 418, "Owner", "full organization control", PURPLE)
    actor(c, 390, 418, "Counter", "front desk and finance", CYAN)
    actor(c, 510, 418, "Operator", "billing and production", TEAL)
    actor(c, 640, 418, "Senior Operator", "production lead", AMBER)
    actor(c, 760, 418, "Engineer", "assigned production", GREEN)
    arrow(c, 87, 451, 183, 451, "administers", BLUE)
    c.setStrokeColor(PURPLE)
    c.setLineWidth(1.25)
    c.line(200, 462, 200, 500)
    c.line(200, 500, 760, 500)
    for x in (390, 510, 640, 760):
        arrow(c, x, 500, x, 462, "assigns" if x == 510 else None, PURPLE)

    box(c, 28, 280, 250, 92, "Owner1 Safeguards",
        "Must remain an active owner. Has access to all organizations. Protected from ordinary removal or demotion. Controls sensitive owner and user administration paths.",
        PALE_BLUE, BLUE, BLUE, NAVY, body_size=7.7)
    box(c, 296, 280, 250, 92, "Role Defaults",
        "Each role starts with a known permission set. Owner receives all permissions. Counter focuses on front desk, POS, shifts and job finance. Production roles focus on assigned work.",
        PALE_GREEN, GREEN, GREEN, NAVY, body_size=7.7)
    box(c, 564, 280, 250, 92, "Per-User Overrides",
        "Owner may grant or restrict individual permissions. Overrides supplement the role model but do not bypass company membership, authentication or Owner1 safeguards.",
        PALE_AMBER, AMBER, AMBER, NAVY, body_size=7.7)

    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(28, 248, "Authentication and Authorization Sequence")
    steps = [
        ("1. Login", "Username/password or configured PIN"),
        ("2. Token", "Server issues authenticated session/JWT"),
        ("3. Company", "Current organization membership checked"),
        ("4. Permission", "Role default plus user overrides evaluated"),
        ("5. Audit", "Actor, role, time and change recorded"),
    ]
    x = 28
    for i, (title, body) in enumerate(steps):
        box(c, x, 133, 140, 78, title, body, white, BLUE if i < 2 else TEAL,
            BLUE if i < 2 else TEAL, SLATE, body_size=7)
        if i < len(steps) - 1:
            arrow(c, x + 140, 172, x + 154, 172, None, SLATE)
        x += 158
    c.showPage()


def page_permissions(c, n):
    header(c, n, "4. Default Permission Matrix",
           "Owner can customize staff permissions; this table shows built-in defaults")
    columns = ["Capability", "Owner", "Counter", "Operator", "Senior Op.", "Engineer"]
    rows = [
        ("Billing / invoices", "YES", "YES", "YES", "-", "-"),
        ("Inventory visibility", "YES", "YES", "YES", "-", "-"),
        ("Reports", "YES", "YES", "YES", "-", "-"),
        ("POS billing", "YES", "YES", "YES", "-", "-"),
        ("Shift collection", "YES", "YES", "YES", "-", "-"),
        ("Purchases / expenses", "YES", "-", "-", "-", "-"),
        ("Accounting / journals", "YES", "-", "-", "-", "-"),
        ("Settings / user admin", "YES", "-", "-", "-", "-"),
        ("Delete / diagnostics", "YES", "-", "-", "-", "-"),
        ("Backup / update", "YES", "-", "-", "-", "-"),
        ("Job counter intake", "YES", "YES", "-", "-", "-"),
        ("Job operations", "YES", "-", "YES", "YES", "YES"),
        ("Assign jobs", "YES", "YES", "YES", "YES", "YES"),
        ("Assign any job", "YES", "-", "-", "YES", "-"),
        ("Job finance", "YES", "YES", "-", "-", "-"),
        ("Job catalog", "YES", "-", "-", "-", "-"),
        ("Job WhatsApp", "YES", "YES", "-", "-", "-"),
    ]
    widths = [254, 86, 94, 94, 104, 94]
    x0, y0, row_h = 28, 497, 24
    x = x0
    for label, width in zip(columns, widths):
        c.setFillColor(NAVY)
        c.rect(x, y0, width, row_h, stroke=0, fill=1)
        c.setFillColor(white)
        c.setFont("Helvetica-Bold", 7.5)
        c.drawCentredString(x + width / 2, y0 + 8, label)
        x += width
    for r, row in enumerate(rows):
        y = y0 - (r + 1) * row_h
        c.setFillColor(white if r % 2 == 0 else PALE)
        c.rect(x0, y, sum(widths), row_h, stroke=0, fill=1)
        x = x0
        for col, (text, width) in enumerate(zip(row, widths)):
            c.setStrokeColor(LIGHT)
            c.rect(x, y, width, row_h, stroke=1, fill=0)
            if col == 0:
                c.setFillColor(NAVY)
                c.setFont("Helvetica-Bold", 7.2)
                c.drawString(x + 7, y + 8, text)
            else:
                allowed = text == "YES"
                c.setFillColor(GREEN if allowed else MID)
                c.setFont("Helvetica-Bold", 7.2)
                c.drawCentredString(x + width / 2, y + 8, text)
            x += width
    c.setFillColor(SLATE)
    c.setFont("Helvetica-Oblique", 7)
    c.drawString(28, 58, "Custom user permissions may alter staff access. Company membership, Owner1 protection and server-side authorization still apply.")
    c.showPage()


def page_transactions(c, n):
    header(c, n, "5. Billing and Transaction Use Cases",
           "Owner-controlled forms, required fields and printed output per company")
    actors = [
        (62, 405, "Owner", "configure and approve", BLUE),
        (62, 280, "Counter", "sales and collections", CYAN),
        (62, 155, "Operator", "billing and POS", TEAL),
    ]
    for item in actors:
        actor(c, *item)

    groups = [
        (160, 390, 190, 110, "Sales Documents",
         "Sale Invoice\nProject Printing Invoice\nQuotation / Proforma\nDelivery Challan\nPOS Bill", BLUE),
        (374, 390, 190, 110, "Accounting Vouchers",
         "Receipt Voucher\nPayment Voucher\nJournal Voucher\nExpense Voucher", GREEN),
        (588, 390, 226, 110, "Purchase Documents",
         "Purchase Bill\nPurchase Order\nVendor GST and item HSN\nTax-inclusive rates", PURPLE),
        (160, 220, 190, 110, "Adjustments",
         "Credit Note\nDebit Note\nSales Return\nInvoice correction request", RED),
        (374, 220, 190, 110, "Common Controls",
         "Party, GSTIN, delivery, PO details, HSN, serial, discount, round off, tax and payment split", AMBER),
        (588, 220, 226, 110, "Output Controls",
         "Logo, bank details, QR, signature image, DSC status, terms, operator and direct PDF output", CYAN),
    ]
    for x, y, w, h, title, body, color in groups:
        box(c, x, y, w, h, title, body, white, color, color, SLATE, body_size=7.3)
    for ay in (434, 309, 184):
        arrow(c, 92, ay, 154, 445 if ay > 350 else 275, "uses", SLATE, True)

    box(c, 160, 92, 654, 86, "Per-Company Transaction Controls",
        "For each transaction type, Owner selects Show, Required and Print. Disabled means hidden in entry, not required and omitted from preview, print and PDF. Existing stored data remains available if the control is re-enabled. Defaults preserve current behavior.",
        PALE_BLUE, HexColor("#BFDBFE"), BLUE, NAVY, body_size=8.2)
    c.showPage()


def page_payment(c, n):
    header(c, n, "6. Invoice Payment and Accounting Activity",
           "Cash posts immediately; bank, UPI and card require a linked receipt voucher")
    stages = [
        (32, 408, 132, 66, "Save Invoice", "Create receivable and stock/tax postings", BLUE),
        (206, 408, 132, 66, "Payment Split", "Cash plus bank, UPI or card", AMBER),
        (380, 408, 132, 66, "Cash Portion", "Post cash ledger immediately", GREEN),
        (554, 408, 132, 66, "Non-Cash Portion", "Remain receivable pending receipt", PURPLE),
        (728, 408, 82, 66, "Status", "Paid / Partly / Unpaid", CYAN),
    ]
    for x, y, w, h, title, body, color in stages:
        box(c, x, y, w, h, title, body, white, color, color, SLATE, body_size=6.8)
    arrow(c, 164, 441, 206, 441, None, BLUE)
    arrow(c, 338, 441, 380, 441, "cash", GREEN)
    arrow(c, 338, 425, 554, 425, "bank / UPI / card", PURPLE)
    arrow(c, 512, 441, 728, 450, None, GREEN)
    arrow(c, 686, 425, 728, 432, None, PURPLE)

    diamond(c, 65, 288, 140, 68, "Payment received?")
    box(c, 248, 287, 170, 70, "YES: Receipt Voucher",
        "Capture mode, transaction reference and bill allocation.", PALE_GREEN, GREEN, GREEN, NAVY, body_size=7.2)
    box(c, 248, 184, 170, 70, "NO: Payment Pending",
        "Leave non-cash amount in customer receivable.", PALE_AMBER, AMBER, AMBER, NAVY, body_size=7.2)
    box(c, 480, 287, 160, 70, "Bank Statement",
        "Import rows and match receipt references.", PALE_BLUE, BLUE, BLUE, NAVY, body_size=7.2)
    box(c, 692, 287, 118, 70, "Reconciled",
        "Receipt and bank row linked.", PALE_GREEN, GREEN, GREEN, NAVY, body_size=7.2)
    arrow(c, 205, 322, 248, 322, "YES", GREEN)
    arrow(c, 135, 288, 248, 219, "NO", AMBER)
    arrow(c, 418, 322, 480, 322, "reference", BLUE)
    arrow(c, 640, 322, 692, 322, "match", GREEN)

    box(c, 480, 184, 330, 70, "Shift Collection and Handover",
        "Report cash, bank, UPI and card separately; credit/pending, refunds, expected cash, actual handover, variance, bank references and Owner acceptance note/time.",
        white, CYAN, CYAN, SLATE, body_size=7.2)
    box(c, 32, 84, 778, 62, "Accounting Invariant",
        "An invoice never directly increases the bank ledger. Only cash is immediate. Bank, UPI and card enter the bank ledger through an authenticated linked Receipt Voucher, preserving reconciliation and auditability.",
        PALE_RED, HexColor("#FECACA"), RED, NAVY, body_size=8.3)
    c.showPage()


def page_jobs(c, n):
    header(c, n, "7. Job Order Production Workflow",
           "State machine, assignment authority and finance/customer checkpoints")
    states = [
        (28, 420, 106, 52, "WAITING", BLUE),
        (164, 420, 106, 52, "ACCEPTED", CYAN),
        (300, 420, 106, 52, "IN_PROGRESS", TEAL),
        (436, 478, 130, 52, "WAITING_FOR_MATERIAL", AMBER),
        (436, 364, 130, 52, "QUALITY_CHECK", PURPLE),
        (596, 364, 106, 52, "COMPLETED", GREEN),
        (596, 250, 130, 52, "READY_FOR_DELIVERY", CYAN),
        (756, 250, 58, 52, "DELIVERED", GREEN),
    ]
    for x, y, w, h, title, color in states:
        box(c, x, y, w, h, title, "", white, color, color)
    arrow(c, 134, 446, 164, 446, None, BLUE)
    arrow(c, 270, 446, 300, 446, None, CYAN)
    arrow(c, 406, 455, 436, 504, None, AMBER)
    arrow(c, 501, 478, 365, 472, None, TEAL)
    arrow(c, 406, 430, 436, 390, None, PURPLE)
    arrow(c, 566, 390, 596, 390, "pass", GREEN)
    arrow(c, 436, 374, 375, 420, None, RED, True)
    arrow(c, 649, 364, 661, 302, "approve", CYAN)
    arrow(c, 726, 276, 756, 276, None, GREEN)
    arrow(c, 229, 420, 83, 406, "return", SLATE, True)
    c.setFont("Helvetica-Bold", 6.8)
    c.setFillColor(AMBER)
    c.drawString(409, 481, "material needed")
    c.setFillColor(TEAL)
    c.drawString(422, 468, "resume")
    c.setFillColor(PURPLE)
    c.drawString(412, 402, "submit")
    c.setFillColor(RED)
    c.drawString(392, 382, "rework")
    c.drawString(570, 348, "Completed work may also return to IN_PROGRESS")

    boxes = [
        (28, 245, 174, 112, "Counter / Front Desk",
         "Create intake, customer and items\nPrepare estimate and commitment\nRecord advance\nInitial assignment\nFinal invoice and delivery", CYAN),
        (218, 245, 174, 112, "Production Users",
         "Operator / Senior Operator / Engineer\nAccept assignments\nAdd work reports and attachments\nRequest additions\nMove permitted job states", TEAL),
        (408, 130, 174, 112, "Senior Operator",
         "Production lead\nMay assign any job by default\nCoordinates quality and rework\nStill requires explicit finance grants", AMBER),
        (598, 130, 216, 112, "Owner",
         "Full workflow visibility and override\nCatalog and finance control\nCustomer approval oversight\nAudit, communication and delivery governance", BLUE),
    ]
    for x, y, w, h, title, body, color in boxes:
        box(c, x, y, w, h, title, body, white, color, color, SLATE, body_size=7.1)
    c.showPage()


def page_corrections(c, n):
    header(c, n, "8. Corrections, Returns, Stock and Audit Flow",
           "Approved invoice corrections create linked accounting documents; history is never erased")
    actor(c, 68, 406, "Operator", "requests correction", TEAL)
    box(c, 142, 390, 150, 82, "Correction Request",
        "Select item or quantity removal and provide reason.", white, TEAL, TEAL, SLATE, body_size=7.2)
    actor(c, 368, 406, "Owner", "reviews", BLUE)
    diamond(c, 432, 397, 124, 68, "Approve?")
    box(c, 602, 425, 190, 64, "Rejected",
        "Request closes with decision and reason. Invoice remains unchanged.", PALE_RED, RED, RED, NAVY, body_size=6.8)
    box(c, 602, 325, 190, 76, "Approved Credit Note",
        "Linked to original invoice and correction request.", PALE_GREEN, GREEN, GREEN, NAVY, body_size=7)
    arrow(c, 93, 438, 142, 431, None, TEAL)
    arrow(c, 292, 431, 344, 438, "review", BLUE)
    arrow(c, 392, 438, 432, 431, None, BLUE)
    arrow(c, 556, 431, 602, 457, "NO", RED)
    arrow(c, 494, 397, 602, 363, "YES", GREEN)

    impacts = [
        ("Stock", "Reverse approved quantity movement", AMBER),
        ("GST", "Reduce taxable value and tax", PURPLE),
        ("Customer", "Reduce balance / receivable", BLUE),
        ("Ledger", "Post linked credit-note entries", GREEN),
        ("Audit", "Preserve request, reviewer and before/after", RED),
    ]
    x = 28
    for title, body, color in impacts:
        box(c, x, 183, 146, 82, title, body, white, color, color, SLATE, body_size=7)
        x += 158
    arrow(c, 696, 325, 696, 272, "post impacts", GREEN)

    box(c, 28, 83, 764, 65, "Stock Journal Visibility",
        "Stock movement is maintained in stock_movements and linked transaction postings. Sale, purchase, return, correction and job material events should be traced by source document, organization, item, quantity direction, user and timestamp.",
        PALE_AMBER, HexColor("#FDE68A"), AMBER, NAVY, body_size=8)
    c.showPage()


def page_deployment(c, n):
    header(c, n, "9. Deployment and Mobile/LAN Component Diagram",
           "Desktop host, browser clients, offline queue, synchronization and direct PDF")
    box(c, 28, 370, 176, 112, "Main Electron Desktop",
        "Owner workstation\nElectron main process\nStarts central server\nDirect printToPDF IPC\nInstaller and update manager",
        PALE_BLUE, BLUE, BLUE, NAVY, body_size=7.2)
    box(c, 254, 370, 176, 112, "Node / Express API",
        "Port 3000 on main system\nAuthentication and permissions\nBusiness validation\nSSE change notifications\nREST endpoints",
        PALE_GREEN, GREEN, GREEN, NAVY, body_size=7.2)
    box(c, 480, 370, 146, 112, "SQLite Database",
        "Organizations\nTransactions\nLedgers and stock\nJobs and audit\nBackup source",
        PALE_AMBER, AMBER, AMBER, NAVY, body_size=7.2)
    box(c, 676, 370, 138, 112, "File Storage",
        "Attachments\nLogos/signatures\nBackups\nUpdate packages\nExported PDFs",
        white, PURPLE, PURPLE, SLATE, body_size=7.2)
    arrow(c, 204, 426, 254, 426, "IPC / HTTP", BLUE)
    arrow(c, 430, 426, 480, 426, "SQL", GREEN)
    arrow(c, 626, 426, 676, 426, "files", PURPLE)

    box(c, 28, 195, 176, 108, "LAN Desktop Client",
        "Connects to main server IP\nMay use local proxy on port 3001\nMaintains pending sync queue\nShows version mismatch warning",
        white, CYAN, CYAN, SLATE, body_size=7.2)
    box(c, 254, 195, 176, 108, "Mobile / Tablet Browser",
        "QR login from dashboard\nResponsive POS and billing\nHeld bills and shifts\nBarcode/manual scanning\nRequires LAN reachability",
        white, CYAN, CYAN, SLATE, body_size=7.2)
    box(c, 480, 195, 146, 108, "Offline Queue",
        "Draft/pending writes\nRetry and conflict handling\nUpgrade blocked when unsafe pending invoices exist",
        PALE_RED, RED, RED, NAVY, body_size=7.2)
    box(c, 676, 195, 138, 108, "External Services",
        "Bank statement files\nGST Portal export\nWhatsApp channel\nEmail reports",
        white, SLATE, SLATE, SLATE, body_size=7.2)
    arrow(c, 204, 249, 254, 249, "same LAN", CYAN, True)
    arrow(c, 342, 303, 342, 370, "HTTPS / HTTP", CYAN)
    arrow(c, 480, 249, 430, 249, "sync", RED)
    arrow(c, 553, 303, 342, 370, "replay", RED)
    arrow(c, 676, 249, 626, 249, "import/export", SLATE)

    box(c, 28, 89, 786, 65, "Mobile Rule",
        "Mobile is a browser client of the main system, not a separate database. The main PC must be running, port 3000 must be reachable through Windows Firewall, and the phone must use the same LAN. Authentication state is stored through the application-safe storage wrapper.",
        PALE_BLUE, HexColor("#BFDBFE"), BLUE, NAVY, body_size=8)
    c.showPage()


def page_entities(c, n):
    header(c, n, "10. Data Model - Entity Relationship Overview",
           "Domain-level ER map; arrows represent principal ownership or transaction linkage")
    domains = [
        (28, 382, 180, 112, "Identity and Governance",
         "orgs\nusers, sessions\naudit_log\nsystem_settings\ntransaction_control_settings", BLUE),
        (232, 382, 180, 112, "Parties and Catalog",
         "parties, party_org_links\nitem_categories\nitems\naccounts", CYAN),
        (436, 382, 180, 112, "Sales and Settlement",
         "bills\npayments\npayment_allocations\nheld_bills\ninvoice_correction_requests", GREEN),
        (640, 382, 174, 112, "Purchase and Adjustments",
         "purchases\npurchase_orders\nexpenses\ncredit_debit_notes\nsales returns", PURPLE),
        (28, 202, 180, 112, "Accounting and Stock",
         "ledger\njournal_entries\njournal_lines\nstock_movements\nfinancial_year_locks", AMBER),
        (232, 202, 180, 112, "Bank and GST",
         "bank_reconciliation\nstatement imports/rows\nGSTR-2B imports/rows\nGST exports", TEAL),
        (436, 202, 180, 112, "POS and Operations",
         "pos_shifts\nbill_sequences\nscheduled_reports\nbackup_log\nupdate_packages", RED),
        (640, 202, 174, 112, "Job Workflow",
         "job_orders, job_items\nestimates, assignments\nstatus/work/additions\napprovals, delivery\nmessages and job audit", BLUE),
    ]
    for x, y, w, h, title, body, color in domains:
        box(c, x, y, w, h, title, body, white, color, color, SLATE, body_size=7.1)
    arrow(c, 208, 438, 232, 438, "org_id", BLUE)
    arrow(c, 412, 438, 436, 438, "party/item", CYAN)
    arrow(c, 616, 438, 640, 438, "source docs", PURPLE)
    arrow(c, 526, 382, 118, 314, "postings", AMBER)
    arrow(c, 526, 382, 322, 314, "receipts", TEAL)
    arrow(c, 526, 382, 526, 314, "POS", RED)
    arrow(c, 727, 382, 727, 314, "job billing", BLUE)

    box(c, 28, 91, 786, 67, "Key Relationship Rules",
        "Every business record is organization-scoped. Bills link parties and items; payments allocate bills; stock and ledger entries point back to source documents; corrections link the original invoice and credit note; job orders link customer, items, estimates, assignments, approvals, delivery and final billing.",
        PALE, LIGHT, NAVY, NAVY, body_size=8)
    c.showPage()


def page_controls(c, n):
    header(c, n, "11. Security, Backup, Update and Audit Controls",
           "Operational safeguards that keep data recoverable and changes attributable")
    controls = [
        ("Authentication", "Password/PIN login, session token, protected storage wrapper and expiry handling.", BLUE),
        ("Authorization", "Server-side permission checks, organization access and Owner1 safeguards.", PURPLE),
        ("Audit", "Actor, role, time, reason, operation ID, IP and before/after details where applicable.", RED),
        ("Backup", "Database and settings included; backup log records result and location.", GREEN),
        ("Restore", "Validated backup import preserves company configuration and transaction controls.", TEAL),
        ("Updates", "Current/latest version, LAN package distribution and SHA-256 verification.", CYAN),
        ("Upgrade Safety", "Backup before upgrade; block unsafe update while offline invoices are pending.", AMBER),
        ("Rollback Foundation", "Retain prior package/data recovery path and client mismatch warning.", SLATE),
    ]
    x_positions = [28, 230, 432, 634]
    y_positions = [352, 207]
    for idx, (title, body, color) in enumerate(controls):
        x = x_positions[idx % 4]
        y = y_positions[idx // 4]
        box(c, x, y, 180, 112, title, body, white, color, color, SLATE, body_size=7.5)

    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(28, 177, "Recommended Operational Ownership")
    recommendations = [
        ("Daily", "Counter closes shifts; Owner reviews variance and pending non-cash receipts."),
        ("Weekly", "Owner verifies bank matches, backup result, failed sync and audit exceptions."),
        ("Monthly", "Owner locks completed periods, reviews GST reports and tests backup readability."),
        ("Before Update", "Resolve pending offline invoices, take backup, verify package SHA-256, then upgrade clients."),
    ]
    y = 145
    for cadence, text in recommendations:
        pill(c, 28, y - 3, cadence, BLUE, width=72)
        c.setFillColor(SLATE)
        c.setFont("Helvetica", 8.2)
        c.drawString(112, y, text)
        y -= 28
    c.showPage()


def build():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(PDF_PATH), pagesize=(PAGE_W, PAGE_H))
    c.setTitle("Tarangini Full System UML - Roles and Departments")
    c.setAuthor("Tarangini")
    c.setSubject("Roles, departments, workflows, data model and deployment architecture")
    page_cover(c)
    page_scope(c, 2)
    page_departments(c, 3)
    page_roles(c, 4)
    page_permissions(c, 5)
    page_transactions(c, 6)
    page_payment(c, 7)
    page_jobs(c, 8)
    page_corrections(c, 9)
    page_deployment(c, 10)
    page_entities(c, 11)
    page_controls(c, 12)
    c.save()
    print(PDF_PATH)


if __name__ == "__main__":
    build()
