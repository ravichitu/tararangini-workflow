const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'output', 'pdf', 'invoice-themes');
const reviewDir = path.join(root, 'tmp', 'invoice-theme-review');

const themes = [
  ['classic', 'Classic', '#222222', '#666666', '#b7791f', '#f6e8c9', '#f0f0f0', '#fafafa', '#cccccc'],
  ['sapphire', 'Sapphire', '#1746a2', '#6c3bcf', '#0ea5e9', '#e0f2fe', '#e8f0ff', '#f4f0ff', '#9ab3e5'],
  ['emerald', 'Emerald', '#087f5b', '#0b7285', '#84cc16', '#ecfccb', '#dff7ed', '#e8f7f8', '#8dcdb8'],
  ['sunset', 'Sunset', '#d9480f', '#c2255c', '#f59f00', '#fff3bf', '#fff0df', '#fff0f5', '#e8aa84'],
  ['common-gst', 'Common GST', '#111111', '#444444', '#1d4ed8', '#e8f0ff', '#ececec', '#f8f8f8', '#333333'],
  ['gst-invoice', 'GST Invoice', '#075985', '#0284c7', '#0f766e', '#ccfbf1', '#e0f2fe', '#f0fdfa', '#7dd3fc'],
  ['tally', 'Tally', '#315c38', '#638b4d', '#b7791f', '#fff3c4', '#edf4e8', '#fffdf1', '#94a77c'],
  ['modern-wave', 'Modern Wave', '#1f2937', '#e11d48', '#fb7185', '#ffe4e6', '#f8fafc', '#fff1f2', '#cbd5e1'],
  ['retail-grid', 'Retail Grid', '#a45108', '#d97706', '#f59e0b', '#fed7aa', '#fff7ed', '#fffaf2', '#c7a27d'],
  ['corporate-tax', 'Corporate Tax', '#1e426d', '#315f91', '#0f766e', '#d9eff7', '#eef8fc', '#f8fcfe', '#88a9c6'],
  ['commercial-red', 'Commercial Red', '#be123c', '#e11d48', '#fb7185', '#ffe4e6', '#fff1f2', '#fffafb', '#e7a7b5'],
  ['statutory-gst', 'Statutory GST', '#111827', '#374151', '#f59e0b', '#fef3c7', '#f9fafb', '#ffffff', '#111827'],
  ['royal-navy', 'Royal Navy', '#0b2e59', '#1f6fb2', '#10b981', '#d1fae5', '#e6f1ff', '#eff7ff', '#8aaed1'],
  ['plum', 'Plum', '#5a235f', '#9b4d96', '#ec4899', '#fce7f3', '#f7eafa', '#fdf3fc', '#cda4cf'],
  ['ruby', 'Ruby', '#9d1d35', '#e05062', '#f97316', '#ffedd5', '#ffe9ec', '#fff4f5', '#dea0aa'],
  ['marigold', 'Marigold', '#9a5b00', '#df9a00', '#ea580c', '#ffedd5', '#fff4d7', '#fff9e9', '#e5be6c'],
  ['ocean', 'Ocean', '#005f82', '#00a3b5', '#2563eb', '#dbeafe', '#ddf6f8', '#edfcfd', '#82c8d2'],
  ['forest', 'Forest', '#1d5a3a', '#4b9b65', '#ca8a04', '#fef3c7', '#e5f5e8', '#f1faf2', '#96c8a2'],
  ['graphite', 'Graphite', '#323a46', '#667789', '#0891b2', '#cffafe', '#ecf0f3', '#f6f8fa', '#aeb8c1'],
  ['terracotta', 'Terracotta', '#93422d', '#c8754f', '#b45309', '#fef3c7', '#f9e8df', '#fff5f0', '#d7a28c'],
  ['indigo', 'Indigo', '#363c8f', '#7680c9', '#9333ea', '#f3e8ff', '#e9ebfb', '#f5f5ff', '#abb0df'],
  ['slate', 'Slate', '#40566d', '#7892a7', '#0f766e', '#ccfbf1', '#e6eef3', '#f4f8fa', '#a5b7c3']
].map(([key, name, primary, secondary, accent, highlight, soft, pale, border]) => ({
  key, name, primary, secondary, accent, highlight, soft, pale, border,
  commonGst: key === 'common-gst', gstInvoice: key === 'gst-invoice', tally: key === 'tally',
  modernWave: key === 'modern-wave', retailGrid: key === 'retail-grid', corporateTax: key === 'corporate-tax',
  commercialRed: key === 'commercial-red', statutoryGst: key === 'statutory-gst'
}));

function sampleInvoice(theme) {
  const commonClass = theme.commonGst ? ' common-gst' : '';
  const gstClass = theme.gstInvoice ? ' gst-invoice' : '';
  const tallyClass = theme.tally ? ' tally' : '';
  const referenceClass = [theme.modernWave && 'modern-wave', theme.retailGrid && 'retail-grid', theme.corporateTax && 'corporate-tax', theme.commercialRed && 'commercial-red', theme.statutoryGst && 'statutory-gst'].filter(Boolean).join(' ');
  const title = theme.commonGst || theme.statutoryGst ? 'TAX INVOICE' : 'SALE INVOICE';
  return `<section class="invoice theme-${theme.key}${commonClass}${gstClass}${tallyClass} ${referenceClass}" style="--primary:${theme.primary};--secondary:${theme.secondary};--accent:${theme.accent};--highlight:${theme.highlight};--soft:${theme.soft};--pale:${theme.pale};--border:${theme.border}">
    <header>
      <div class="brand"><div class="mark">T</div><div><h1>TARANGINI DEMO WORKS</h1><p>Professional Billing and Production Services</p></div></div>
      <div class="theme-tag">${theme.name} Theme</div>
    </header>
    <div class="address-line">Subhadra Arcade, Kakinada, Andhra Pradesh - 533001 | Phone: 99850 65665 | GSTIN: 37AABCT1234A1Z5</div>
    <div class="document-title">${title}</div>
    ${theme.gstInvoice || theme.statutoryGst ? `<div class="${theme.statutoryGst ? 'statutory-strip' : 'gst-strip'}"><span><b>GSTIN:</b> 37AABCT1234A1Z5</span><span><b>Reverse Charge:</b> No</span><span><b>Copy:</b> Original for Recipient</span></div>` : ''}
    <div class="meta">
      <div><span>BILL TO</span><strong>Ravi Teja Enterprises</strong><p>Door No. 12-45, Main Road<br>Kakinada, Andhra Pradesh - 533001<br>Phone: 96767 34474</p></div>
      <div class="number"><p><span>Invoice No.</span><strong>TAR/SB/26/0001</strong></p><p><span>Invoice Date</span><strong>03 Aug 2026</strong></p><p><span>Payment Mode</span><strong>Credit - 30 Days</strong></p></div>
    </div>
    <table><thead><tr><th>#</th><th>Description</th><th>HSN</th><th class="right">Qty</th><th class="right">Rate</th><th class="right">Amount</th></tr></thead>
    <tbody><tr><td>1</td><td>Colour Brochure Printing - A4, 170 GSM</td><td>4911</td><td class="right">100</td><td class="right">25.00</td><td class="right">2,500.00</td></tr>
    <tr><td>2</td><td>Perfect Binding Service</td><td>9989</td><td class="right">10</td><td class="right">75.00</td><td class="right">750.00</td></tr></tbody></table>
    <div class="lower"><div class="tax"><h3>HSN / SAC TAX SUMMARY</h3><div class="tax-row"><b>HSN/SAC</b><b>Taxable</b><b>CGST 9%</b><b>SGST 9%</b></div><div class="tax-row"><span>4911 / 9989</span><span>3,250.00</span><span>292.50</span><span>292.50</span></div></div>
    <div class="totals"><div><span>Subtotal</span><b>3,250.00</b></div><div><span>CGST</span><b>292.50</b></div><div><span>SGST</span><b>292.50</b></div><div class="grand"><span>Grand Total</span><b>Rs. 3,835.00</b></div></div></div>
    <div class="words"><b>Amount in words:</b> Rupees Three Thousand Eight Hundred Thirty Five Only</div>
    <footer><div><b>Bank Details</b><br>Tarangini Demo Works<br>Bank / UPI: 1234567890 / tarangini@upi</div><div class="signature"><p>For Tarangini Demo Works</p><div>Authorised Signatory</div></div></footer>
    <div class="note">This is a theme preview using sample data only. It does not represent a live invoice.</div>
  </section>`;
}

function documentHtml(body, title) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
    @page { size: A4; margin: 10mm; }
    * { box-sizing: border-box; } body { margin:0; color:#1d2730; font-family:Arial,Helvetica,sans-serif; font-size:10px; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    .invoice { min-height:277mm; padding:4mm; background:#fff; border-top:6px solid var(--primary); border-bottom:6px solid var(--accent); page-break-after:always; }
    .invoice:last-child { page-break-after:auto; } header { display:flex; justify-content:space-between; gap:10mm; align-items:flex-start; border-bottom:3px solid var(--primary); padding-bottom:3.5mm; }
    .brand { display:flex; gap:3mm; align-items:center; } .mark { width:12mm; height:12mm; border-radius:50%; background:linear-gradient(135deg,var(--primary),var(--secondary)); color:white; display:grid; place-items:center; font-size:20px; font-weight:bold; }
    h1 { margin:0; color:var(--primary); font-size:18px; letter-spacing:.2px; } .brand p { margin:1.5mm 0 0; color:#53606b; font-size:10px; } .theme-tag { border:1px solid var(--border); border-radius:12px; padding:2mm 3mm; background:var(--pale); color:var(--primary); font-weight:bold; }
    .address-line { margin:2mm 0; color:#4d5861; font-size:9px; } .document-title { margin:2.5mm 0 0; padding:2.7mm; text-align:center; color:#fff; font-size:14px; font-weight:bold; letter-spacing:.6px; background:linear-gradient(100deg,var(--primary) 0%,var(--secondary) 56%,var(--accent) 100%); }
    .meta { display:grid; grid-template-columns:1.2fr .8fr; border:1px solid var(--border); margin-bottom:3.5mm; } .meta > div { padding:3mm; } .meta > div:first-child { border-right:1px solid var(--border); } .meta span { display:block; color:#59636d; font-size:8px; letter-spacing:.4px; text-transform:uppercase; } .meta strong { display:block; margin:1.2mm 0; font-size:11px; } .meta p { margin:0; line-height:1.45; } .meta .number p { display:flex; justify-content:space-between; gap:4mm; margin-bottom:1.8mm; } .meta .number span { font-size:9px; text-transform:none; letter-spacing:0; }
    table { width:100%; border-collapse:collapse; font-size:9px; } th { background:linear-gradient(90deg,var(--soft) 0%,var(--pale) 72%,var(--highlight) 100%); color:var(--primary); border:1px solid var(--border); padding:2mm; text-transform:uppercase; text-align:left; font-size:8px; letter-spacing:.3px; } th:first-child { border-left:4px solid var(--accent); } td { border:1px solid var(--border); padding:2mm; } .right { text-align:right; }
    .lower { display:grid; grid-template-columns:1fr 60mm; gap:4mm; margin-top:3.5mm; align-items:start; } .tax { border:1px solid var(--border); } .tax h3 { margin:0; padding:2mm; color:var(--primary); background:var(--pale); font-size:8px; } .tax-row { display:grid; grid-template-columns:1.2fr 1fr 1fr 1fr; gap:1mm; padding:1.5mm 2mm; border-top:1px solid var(--border); text-align:right; } .tax-row > :first-child { text-align:left; }
    .totals { border:1px solid var(--border); } .totals > div { display:flex; justify-content:space-between; padding:1.8mm 2.4mm; border-bottom:1px solid var(--border); } .totals .grand { color:var(--primary); background:linear-gradient(90deg,var(--soft),var(--highlight)); font-size:12px; font-weight:bold; border-top:2px solid var(--primary); border-right:4px solid var(--accent); border-bottom:0; }
    .words { margin-top:3.5mm; border:1px solid var(--border); background:var(--pale); padding:2mm 2.5mm; font-style:italic; } footer { display:grid; grid-template-columns:1fr 1fr; gap:8mm; margin-top:6mm; font-size:9px; line-height:1.55; } .signature { text-align:right; } .signature p { margin:0 0 12mm; color:var(--primary); font-weight:bold; } .signature div { border-top:1px solid var(--primary); padding-top:1.2mm; font-weight:bold; } .note { margin-top:3mm; padding-top:2mm; border-top:1px dashed var(--border); color:#59636d; font-size:8px; }
    .theme-sapphire header,.theme-ocean header { padding:3mm; border:1px solid var(--border); border-bottom:3px solid var(--primary); border-radius:14px 14px 0 0; background:linear-gradient(120deg,var(--pale),var(--soft)); } .theme-sapphire .document-title { margin:3mm 0; border-radius:9px 22px; } .theme-ocean .document-title { margin:0 0 3mm; border-radius:0 0 16px 16px; }
    .theme-royal-navy header,.theme-indigo header { padding:3mm; border:0; border-left:5mm solid var(--accent); background:linear-gradient(90deg,var(--soft),#fff); } .theme-royal-navy .document-title { text-align:left; padding-left:5mm; border-radius:3px; } .theme-indigo .document-title { border-radius:12px; box-shadow:3mm 3mm 0 var(--highlight); }
    .theme-emerald header,.theme-forest header { padding:3mm; border:2px solid var(--primary); border-radius:16px 16px 0 0; background:linear-gradient(135deg,var(--pale),#fff); } .theme-emerald .document-title { margin:0; border-radius:0 0 16px 16px; } .theme-forest .document-title { margin:3mm 0; border-radius:4px; border-left:5mm solid var(--accent); text-align:left; padding-left:5mm; }
    .theme-sunset header,.theme-ruby header,.theme-terracotta header,.theme-marigold header { padding:3mm; border-left:5mm solid var(--accent); border-bottom:1px dashed var(--secondary); background:linear-gradient(100deg,var(--pale),#fff); } .theme-sunset .document-title,.theme-ruby .document-title { margin:3mm 0; border-radius:0 16px 0 16px; } .theme-marigold .document-title { margin:3mm 0; border-radius:20px; color:#4a3100; background:linear-gradient(100deg,var(--highlight),#ffe59a,var(--accent)); } .theme-terracotta { background:#fffaf5; } .theme-terracotta .document-title { margin:3mm 0; border-radius:4px; box-shadow:3mm 3mm 0 var(--highlight); }
    .theme-plum header { padding:3mm; border:0; border-radius:16px; background:linear-gradient(135deg,var(--soft),var(--pale)); } .theme-plum .document-title { margin:3mm 0; border-radius:99px; } .theme-plum .meta,.theme-plum table { border-radius:9px; overflow:hidden; }
    .theme-graphite,.theme-slate { background:#fbfcfd; } .theme-graphite header,.theme-slate header { padding:3mm; border:1px solid var(--border); background:#fff; } .theme-graphite .document-title { margin:0 0 3mm; border-radius:0; text-align:left; padding-left:5mm; } .theme-slate .document-title { margin:3mm 0; border-radius:4px; letter-spacing:1px; }
    .gst-invoice { padding:0; border:2px solid var(--primary); border-top:5mm solid var(--primary); } .gst-invoice header { padding:3mm; border:0; border-bottom:3px solid var(--accent); background:linear-gradient(90deg,var(--soft),var(--pale)); } .gst-invoice .document-title { margin:0; border-radius:0; } .gst-strip { display:grid; grid-template-columns:1fr 1fr 1fr; border:1px solid var(--primary); border-top:0; background:var(--highlight); color:#073b4c; font-size:8px; } .gst-strip span { padding:2mm; border-right:1px solid var(--border); } .gst-strip span:last-child { border-right:0; } .gst-invoice .meta { margin-top:0; border-top:0; } .gst-invoice table { border:1px solid var(--primary); }
    .tally { padding:3mm; border:2px double var(--primary); border-top:5mm solid var(--primary); background:#fffdf5; font-family:"Courier New",monospace; } .tally header { padding:3mm; border:1px solid var(--primary); border-bottom:0; background:var(--highlight); text-align:center; } .tally .brand { justify-content:center; } .tally .document-title { margin:0; border:1px solid var(--primary); border-radius:0; background:var(--primary); letter-spacing:1px; } .tally .meta,.tally table { border:1px solid var(--primary); } .tally th { color:#1c4727; background:#e5efd8; border-color:var(--primary); } .tally td { border-color:#9cad85; } .tally .grand { color:#1c4727; background:var(--highlight); border-right:0; }
    .modern-wave { padding:0; border:0; border-top:5mm solid var(--primary); border-bottom:5mm solid var(--secondary); } .modern-wave header { margin:0; padding:4mm; border:0; border-radius:0 0 16mm 0; background:linear-gradient(112deg,var(--primary) 0 49%,var(--secondary) 49% 100%); } .modern-wave h1,.modern-wave .brand p,.modern-wave .theme-tag { color:#fff; } .modern-wave .theme-tag { border-color:transparent; background:transparent; } .modern-wave .document-title { margin:4mm; color:var(--primary); background:#fff; border-bottom:1mm solid var(--secondary); text-align:left; padding:2mm 0; } .modern-wave .meta,.modern-wave table,.modern-wave .lower,.modern-wave .words,.modern-wave footer { margin-left:4mm; margin-right:4mm; } .modern-wave .grand { color:#fff; background:var(--secondary); border-right:0; }
    .retail-grid { padding:4mm; border:1mm solid var(--primary); background:linear-gradient(90deg,#fffaf0 0 6mm,#fff 6mm calc(100% - 6mm),#fffaf0 calc(100% - 6mm)); } .retail-grid header { padding:3mm; border:0; background:#fff0e5; } .retail-grid .document-title { margin:0; border-radius:0; background:var(--primary); } .retail-grid .meta,.retail-grid table,.retail-grid .tax,.retail-grid .totals { border-color:var(--primary); } .retail-grid th { color:#3f2208; background:#fed7aa; border-color:var(--primary); } .retail-grid .grand { color:#3f2208; background:#fed7aa; border-right:0; }
    .corporate-tax { padding:4mm; border:1px solid var(--primary); } .corporate-tax header { padding:3mm; border:0; border-bottom:1mm solid var(--primary); } .corporate-tax .document-title { margin:0; border-radius:0; text-align:left; padding-left:5mm; background:var(--primary); } .corporate-tax .meta { margin-top:0; background:var(--highlight); border-color:var(--primary); } .corporate-tax .meta > div:first-child,.corporate-tax th { border-color:var(--primary); } .corporate-tax th { color:var(--primary); background:#fff; } .corporate-tax td { border-color:#8da7bd; } .corporate-tax .words { border-radius:0; background:#fff; border-left:2mm solid var(--primary); }
    .commercial-red { padding:4mm; border-top:5mm solid var(--secondary); border-bottom:1mm solid var(--secondary); } .commercial-red header { padding:3mm 0; border:0; border-bottom:1mm solid var(--secondary); } .commercial-red .document-title { margin:0 0 3mm; color:var(--primary); background:#fff; border:0; border-bottom:2mm solid var(--secondary); border-radius:0; text-align:right; padding:2mm 0; } .commercial-red .meta { border-color:var(--secondary); } .commercial-red th { color:#fff; background:var(--secondary); border-color:var(--secondary); } .commercial-red th:first-child { border-left:1px solid var(--secondary); } .commercial-red .grand { color:#fff; background:var(--secondary); border-right:0; }
    .statutory-gst { padding:0; border:1.5px solid var(--primary); border-top:2mm solid var(--primary); } .statutory-gst header { padding:3mm; border:0; border-bottom:1.5px solid var(--primary); } .statutory-gst .document-title { margin:0; color:var(--primary); background:#fff; border:0; border-bottom:1.5px solid var(--primary); border-radius:0; } .statutory-gst .meta,.statutory-gst table,.statutory-gst .tax,.statutory-gst .totals { border-color:var(--primary); } .statutory-gst .meta > div:first-child,.statutory-gst th { border-color:var(--primary); } .statutory-gst th { color:var(--primary); background:#fff; } .statutory-gst th:first-child { border-left:1px solid var(--primary); } .statutory-gst td { border-color:#4b5563; } .statutory-gst .grand { color:#fff; background:var(--primary); border-right:0; } .statutory-gst .words { color:var(--primary); background:#fff; border-color:var(--primary); border-radius:0; } .statutory-strip { display:grid; grid-template-columns:1fr 1fr 1fr; border:1.5px solid var(--primary); border-top:0; background:#fff; color:var(--primary); font-size:8px; } .statutory-strip span { padding:2mm; border-right:1px solid var(--primary); } .statutory-strip span:last-child { border-right:0; }
    .common-gst { border:2px solid #111; border-top:2px solid #111; border-bottom:2px solid #111; padding:0; } .common-gst header { border-bottom:0; padding:3mm; } .common-gst .document-title { color:#111; background:#e6e6e6; border-top:2px solid #111; border-bottom:2px solid #111; } .common-gst .meta { margin:0 0 3.5mm; border:0; border-bottom:2px solid #111; } .common-gst th { color:#111; background:#e6e6e6; border-color:#222; } .common-gst td { border-color:#555; } .common-gst .tax,.common-gst .totals,.common-gst .words { border-color:#222; background:#fff; } .common-gst .totals .grand { color:#111; background:#e6e6e6; border-color:#222; }
  </style></head><body>${body}</body></html>`;
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(reviewDir, { recursive: true });
  // Prefer a complete local browser; keep the renderer offline.
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const electronPath = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(chromePath) ? chromePath : electronPath
  });
  try {
    for (const theme of themes) {
      const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
      await page.setContent(documentHtml(sampleInvoice(theme), `${theme.name} Invoice Theme`), { waitUntil: 'load' });
      await page.pdf({
        path: path.join(outputDir, `Tarangini_Invoice_Theme_${theme.key}.pdf`),
        format: 'A4', printBackground: true, preferCSSPageSize: true
      });
      if (['classic', 'common-gst', 'gst-invoice', 'tally', 'slate', 'modern-wave', 'retail-grid', 'corporate-tax', 'commercial-red', 'statutory-gst'].includes(theme.key)) {
        await page.screenshot({ path: path.join(reviewDir, `${theme.key}.png`), fullPage: true });
      }
      await page.close();
    }
    const catalogue = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
    await catalogue.setContent(documentHtml(themes.map(sampleInvoice).join(''), 'Tarangini Invoice Theme Catalogue'), { waitUntil: 'load' });
    await catalogue.pdf({
      path: path.join(outputDir, 'Tarangini_Invoice_Theme_Catalogue_All_22_Themes.pdf'),
      format: 'A4', printBackground: true, preferCSSPageSize: true
    });
    await catalogue.close();
  } finally {
    await browser.close();
  }
  console.log(`Generated ${themes.length} theme PDFs and one catalogue in ${outputDir}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
