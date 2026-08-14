from __future__ import annotations

import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    KeepTogether,
    ListFlowable,
    ListItem,
    LongTable,
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "COMPLETE_TOOL_UML.md"
OUTPUT = ROOT / "output" / "pdf" / "Tarangini_Complete_Tool_UML_And_Process_Map.pdf"


def clean_inline(text: str) -> str:
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"`([^`]+)`", r"<font name='Courier'>\1</font>", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    return text


def wrap_code(text: str, max_len: int = 108) -> str:
    wrapped: list[str] = []
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line:
            wrapped.append("")
            continue
        indent = len(line) - len(line.lstrip(" "))
        prefix = " " * min(indent, 10)
        remaining = line
        while len(remaining) > max_len:
            cut = remaining.rfind(" ", 0, max_len)
            if cut < 35:
                cut = max_len
            wrapped.append(remaining[:cut].rstrip())
            remaining = prefix + "  " + remaining[cut:].lstrip()
        wrapped.append(remaining)
    return "\n".join(wrapped)


def parse_markdown(markdown: str):
    blocks = []
    lines = markdown.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("# "):
            blocks.append(("title", line[2:].strip()))
        elif line.startswith("## "):
            blocks.append(("h2", line[3:].strip()))
        elif line.startswith("### "):
            blocks.append(("h3", line[4:].strip()))
        elif line.startswith("```"):
            fence = line[3:].strip() or "code"
            i += 1
            code_lines = []
            while i < len(lines) and not lines[i].startswith("```"):
                code_lines.append(lines[i])
                i += 1
            blocks.append(("code", fence, "\n".join(code_lines)))
        elif line.startswith("|"):
            table_lines = []
            while i < len(lines) and lines[i].startswith("|"):
                table_lines.append(lines[i])
                i += 1
            i -= 1
            blocks.append(("table", table_lines))
        elif re.match(r"^\d+\.\s+", line):
            items = []
            while i < len(lines) and re.match(r"^\d+\.\s+", lines[i]):
                items.append(re.sub(r"^\d+\.\s+", "", lines[i]).strip())
                i += 1
            i -= 1
            blocks.append(("ordered_list", items))
        elif line.strip():
            para = [line.strip()]
            while i + 1 < len(lines):
                nxt = lines[i + 1]
                if (
                    not nxt.strip()
                    or nxt.startswith("#")
                    or nxt.startswith("```")
                    or nxt.startswith("|")
                    or re.match(r"^\d+\.\s+", nxt)
                ):
                    break
                para.append(nxt.strip())
                i += 1
            blocks.append(("paragraph", " ".join(para)))
        i += 1
    return blocks


def parse_table(table_lines: list[str]) -> list[list[str]]:
    rows = []
    for line in table_lines:
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if cells and all(re.fullmatch(r":?-{3,}:?", cell or "") for cell in cells):
            continue
        rows.append(cells)
    return rows


def add_header_footer(canvas, doc):
    canvas.saveState()
    width, height = landscape(A4)
    canvas.setFillColor(colors.HexColor("#1f2933"))
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawString(16 * mm, height - 10 * mm, "Tarangini Workflow Suite - Complete UML And Process Map")
    canvas.setFont("Helvetica", 8)
    canvas.drawRightString(width - 16 * mm, 9 * mm, f"Page {doc.page}")
    canvas.setStrokeColor(colors.HexColor("#d9e2ec"))
    canvas.line(16 * mm, height - 12 * mm, width - 16 * mm, height - 12 * mm)
    canvas.line(16 * mm, 13 * mm, width - 16 * mm, 13 * mm)
    canvas.restoreState()


def build_pdf():
    markdown = SOURCE.read_text(encoding="utf-8")
    blocks = parse_markdown(markdown)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)

    doc = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=landscape(A4),
        rightMargin=14 * mm,
        leftMargin=14 * mm,
        topMargin=17 * mm,
        bottomMargin=17 * mm,
        title="Tarangini Complete Tool UML And Process Map",
        author="Tarangini Workflow Suite",
    )

    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="CoverTitle",
            parent=styles["Title"],
            fontName="Helvetica-Bold",
            fontSize=25,
            leading=31,
            alignment=TA_CENTER,
            textColor=colors.HexColor("#102a43"),
            spaceAfter=12,
        )
    )
    styles.add(
        ParagraphStyle(
            name="CoverSubtitle",
            parent=styles["BodyText"],
            fontSize=12,
            leading=18,
            alignment=TA_CENTER,
            textColor=colors.HexColor("#334e68"),
            spaceAfter=16,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SectionHeading",
            parent=styles["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=14,
            leading=18,
            textColor=colors.HexColor("#0b7285"),
            spaceBefore=8,
            spaceAfter=6,
            keepWithNext=True,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SmallHeading",
            parent=styles["Heading3"],
            fontName="Helvetica-Bold",
            fontSize=11,
            leading=14,
            textColor=colors.HexColor("#243b53"),
            spaceBefore=6,
            spaceAfter=4,
        )
    )
    styles.add(
        ParagraphStyle(
            name="BodyCustom",
            parent=styles["BodyText"],
            fontSize=9,
            leading=13,
            textColor=colors.HexColor("#243b53"),
            spaceAfter=5,
        )
    )
    code_style = ParagraphStyle(
        name="Code",
        fontName="Courier",
        fontSize=6.3,
        leading=8,
        textColor=colors.HexColor("#102a43"),
        backColor=colors.HexColor("#f0f4f8"),
        borderColor=colors.HexColor("#bcccdc"),
        borderPadding=6,
        borderWidth=0.4,
        leftIndent=0,
        rightIndent=0,
        spaceBefore=2,
        spaceAfter=7,
    )
    cell_style = ParagraphStyle(
        name="Cell",
        parent=styles["BodyText"],
        fontSize=6.1,
        leading=7.3,
        textColor=colors.HexColor("#243b53"),
    )
    header_cell_style = ParagraphStyle(
        name="HeaderCell",
        parent=cell_style,
        fontName="Helvetica-Bold",
        textColor=colors.white,
        alignment=TA_LEFT,
    )

    story = []
    story.append(Spacer(1, 38 * mm))
    story.append(Paragraph("Tarangini Workflow Suite", styles["CoverTitle"]))
    story.append(Paragraph("Complete Tool UML And Transaction Process Explanation", styles["CoverTitle"]))
    story.append(
        Paragraph(
            "Billing, accounting, inventory, job order workflow, customer portal, security, backup, sync and deployment.",
            styles["CoverSubtitle"],
        )
    )
    story.append(
        Table(
            [[
                Paragraph("<b>Purpose</b>", styles["BodyCustom"]),
                Paragraph(
                    "Department-wise explanation PDF for owner review, operator training, customer portal flow, and end-to-end transaction verification.",
                    styles["BodyCustom"],
                ),
            ]],
            colWidths=[35 * mm, 190 * mm],
            style=[
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#d9f0f4")),
                ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#0b7285")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ],
        )
    )
    story.append(PageBreak())

    story.append(Paragraph("How To Read This PDF", styles["SectionHeading"]))
    intro_items = [
        "Sections 1-3 explain the complete application architecture, permissions and database entities.",
        "Sections 4-11 explain customer intake, owner review, operator assignment, production, delivery and job billing.",
        "Sections 12-19 explain billing, accounting, payments, inventory and bank transactions.",
        "Sections 20-26 explain reports, customer portal, file retention, backup, security, sync and installer/update flow.",
        "Section 27 is the transaction checklist: every major action, API, table, accounting effect, stock effect and audit effect.",
    ]
    story.append(
        ListFlowable(
            [ListItem(Paragraph(clean_inline(item), styles["BodyCustom"])) for item in intro_items],
            bulletType="1",
            start="1",
        )
    )
    story.append(PageBreak())

    for block in blocks:
        kind = block[0]
        if kind == "title":
            continue
        if kind == "h2":
            story.append(Paragraph(clean_inline(block[1]), styles["SectionHeading"]))
        elif kind == "h3":
            story.append(Paragraph(clean_inline(block[1]), styles["SmallHeading"]))
        elif kind == "paragraph":
            story.append(Paragraph(clean_inline(block[1]), styles["BodyCustom"]))
        elif kind == "ordered_list":
            story.append(
                ListFlowable(
                    [ListItem(Paragraph(clean_inline(item), styles["BodyCustom"])) for item in block[1]],
                    bulletType="1",
                    start="1",
                )
            )
            story.append(Spacer(1, 4))
        elif kind == "code":
            fence, code = block[1], block[2]
            label = f"UML / {fence} definition"
            story.append(Paragraph(label, styles["SmallHeading"]))
            story.append(Preformatted(wrap_code(code), code_style, maxLineLength=112))
        elif kind == "table":
            rows = parse_table(block[1])
            if not rows:
                continue
            data = []
            for r_index, row in enumerate(rows):
                style = header_cell_style if r_index == 0 else cell_style
                data.append([Paragraph(clean_inline(cell), style) for cell in row])
            col_count = max(len(row) for row in data)
            for row in data:
                while len(row) < col_count:
                    row.append(Paragraph("", cell_style))
            total_width = 267 * mm
            if col_count == 7:
                col_widths = [24 * mm, 36 * mm, 44 * mm, 48 * mm, 48 * mm, 32 * mm, 35 * mm]
            else:
                col_widths = [total_width / col_count] * col_count
            table = LongTable(data, colWidths=col_widths, repeatRows=1)
            table.setStyle(
                TableStyle(
                    [
                        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0b7285")),
                        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#bcccdc")),
                        ("VALIGN", (0, 0), (-1, -1), "TOP"),
                        ("LEFTPADDING", (0, 0), (-1, -1), 3),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
                        ("TOPPADDING", (0, 0), (-1, -1), 3),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fbff")]),
                    ]
                )
            )
            story.append(table)
            story.append(Spacer(1, 8))

    doc.build(story, onFirstPage=add_header_footer, onLaterPages=add_header_footer)


if __name__ == "__main__":
    build_pdf()
    print(OUTPUT)
