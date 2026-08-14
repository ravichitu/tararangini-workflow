const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const root = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputRoot = path.join(root, 'output', 'playwright', 'transaction-recordings', stamp);
const videosDir = path.join(outputRoot, 'videos');
const screenshotsDir = path.join(outputRoot, 'screenshots');
const tracesDir = path.join(outputRoot, 'traces');
const fixturesDir = path.join(outputRoot, 'fixtures');
const dataDir = path.join(outputRoot, 'isolated-test-data');
const port = Number(process.env.TARANGINI_RECORDING_PORT || 3299);
const baseUrl = `http://127.0.0.1:${port}`;
const chromePath = process.env.TARANGINI_RECORDING_CHROME ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const shortPause = Number(process.env.TARANGINI_RECORDING_STEP_MS || 500);
const captureTraces = process.env.TARANGINI_RECORDING_TRACE === '1';

for (const directory of [videosDir, screenshotsDir, tracesDir, fixturesDir, dataDir]) {
  fs.mkdirSync(directory, { recursive: true });
}

let serverOutput = '';
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    TARANGINI_DATA_DIR: dataDir,
    TARANGINI_ALLOW_INSECURE_LAN: '1',
    TARANGINI_TRUST_PROXY: '0'
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});
server.stdout.on('data', chunk => { serverOutput += chunk; });
server.stderr.on('data', chunk => { serverOutput += chunk; });
server.on('exit', (code, signal) => {
  serverOutput += `\n[recording-runner] Server exited with code=${code} signal=${signal}\n`;
});

async function waitForServer() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Recording server did not start.\n${serverOutput}`);
}

async function api(method, route, body, token) {
  const response = await fetch(`${baseUrl}/api${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch (_) { payload = text; }
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status}): ${text}`);
  return payload;
}

async function createFixturePdf() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([595, 842]);
  page.drawText('Tarangini Customer Intake Recording', { x: 54, y: 760, size: 22, font, color: rgb(0.03, 0.45, 0.5) });
  page.drawText('Page 1 includes colour artwork and black text for PDF analysis.', { x: 54, y: 720, size: 12, font });
  page.drawRectangle({ x: 54, y: 600, width: 200, height: 80, color: rgb(0.95, 0.35, 0.12) });
  page.drawRectangle({ x: 270, y: 600, width: 200, height: 80, color: rgb(0.1, 0.55, 0.35) });
  const second = document.addPage([595, 842]);
  second.drawText('Tarangini black and white reference page', { x: 54, y: 760, size: 18, font });
  second.drawText('This page is intentionally monochrome.', { x: 54, y: 720, size: 12, font });
  const fixture = path.join(fixturesDir, 'customer-print-sample.pdf');
  fs.writeFileSync(fixture, await document.save());
  return fixture;
}

async function seedData() {
  const owner = await api('POST', '/auth/login', { username: 'owner1', password: 'owner123' });
  const orgs = await api('GET', '/orgs', undefined, owner.token);
  const org = orgs[0];
  assert.ok(org?.id, 'Default organization is unavailable');
  await api('GET', `/jobs/catalog?org_id=${org.id}`, undefined, owner.token);
  const suffix = stamp.slice(-9).replace(/-/g, '');
  const customer = await api('POST', '/parties', {
    org_id: org.id, type: 'customer', name: `Recording Customer ${suffix}`,
    phone: `90000${String(Date.now()).slice(-5)}`, email: 'recording.customer@example.test',
    address: 'Demo Street, Kakinada', city: 'Kakinada', state: 'Andhra Pradesh'
  }, owner.token);
  const supplier = await api('POST', '/parties', {
    org_id: org.id, type: 'supplier', name: `Recording Supplier ${suffix}`,
    phone: `80000${String(Date.now()).slice(-5)}`, email: 'recording.supplier@example.test',
    address: 'Supplier Road, Vijayawada', city: 'Vijayawada', state: 'Andhra Pradesh'
  }, owner.token);
  const item = await api('POST', '/items', {
    org_id: org.id, name: `Recording Laptop SSD ${suffix}`, item_code: `REC-SSD-${suffix}`,
    hsn_code: '84717020', unit: 'NOS', gst_rate: 18, opening_stock: 100,
    last_purchase_price: 2200, last_sale_price: 3000, reorder_level: 5
  }, owner.token);
  const catalog = await api('GET', `/jobs/catalog?org_id=${org.id}`, undefined, owner.token);
  const service = catalog.services[0];
  return {
    owner, org, customer: { id: customer.id, name: `Recording Customer ${suffix}` },
    supplier: { id: supplier.id, name: `Recording Supplier ${suffix}` },
    item: { id: item.id, name: `Recording Laptop SSD ${suffix}` }, service,
    created: {}
  };
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

async function addCaption(page, text, tone = 'info') {
  await page.evaluate(({ text, tone }) => {
    document.getElementById('__tarangini_recording_caption')?.remove();
    const caption = document.createElement('div');
    caption.id = '__tarangini_recording_caption';
    caption.textContent = text;
    Object.assign(caption.style, {
      position: 'fixed', left: '50%', top: '18px', transform: 'translateX(-50%)',
      zIndex: '2147483647', maxWidth: '78vw', padding: '12px 20px', borderRadius: '12px',
      color: '#fff', font: '700 16px Segoe UI, sans-serif', letterSpacing: '.01em',
      background: tone === 'success' ? '#16784b' : tone === 'error' ? '#b52c25' : '#075f71',
      boxShadow: '0 10px 34px rgba(0,0,0,.26)', textAlign: 'center'
    });
    document.body.appendChild(caption);
  }, { text, tone });
  await page.waitForTimeout(shortPause);
}

async function fill(page, selector, value, label) {
  const locator = page.locator(selector).first();
  if (!await locator.count()) return;
  await locator.waitFor({ state: 'attached', timeout: 10000 });
  if (!await locator.isVisible()) return;
  await addCaption(page, label || `Enter ${selector}`);
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
  await locator.fill('');
  await locator.pressSequentially(String(value), { delay: 18 });
  await page.waitForTimeout(180);
}

async function select(page, selector, value, label) {
  const locator = page.locator(selector).first();
  if (!await locator.count()) return;
  await locator.waitFor({ state: 'attached', timeout: 10000 });
  if (!await locator.isVisible()) return;
  await addCaption(page, label || `Select ${selector}`);
  await locator.selectOption(String(value));
  await page.waitForTimeout(250);
}

async function clickAndWaitForResponse(page, button, matcher, timeout = 30000) {
  const [response] = await Promise.all([
    page.waitForResponse(matcher, { timeout }),
    button.click()
  ]);
  return response;
}

async function navigate(page, pageKey, expectedSelector) {
  await addCaption(page, `Open ${pageKey.replaceAll('-', ' ')}`);
  const nav = page.locator(`[data-page="${pageKey}"]`).first();
  await nav.scrollIntoViewIfNeeded();
  await nav.click();
  await page.locator(expectedSelector).first().waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(300);
}

async function selectBillParty(page, party) {
  await fill(page, '#bf-party-search', party.name.slice(0, 18), 'Search and select the customer');
  await page.locator('#party-autocomplete .autocomplete-item').first().waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#party-autocomplete .autocomplete-item').first().click();
  await page.waitForTimeout(350);
}

async function selectPaymentParty(page, party) {
  await fill(page, '#pay-party-search', party.name.slice(0, 18), 'Search and select the party');
  await page.locator('#pay-party-ac .autocomplete-item').first().waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#pay-party-ac .autocomplete-item').first().click();
  await page.waitForTimeout(450);
}

async function fillBill(page, state, format, pageKey) {
  const titleSelector = format === 'SALE' ? '#bf-billno' : '#bf-billno';
  await navigate(page, pageKey, titleSelector);
  await selectBillParty(page, state.customer);
  await fill(page, '#bf-delivery-addr', 'Demo Street, Kakinada', 'Enter delivery address');
  await fill(page, '#bf-recipient-name', 'Reference Customer', 'Enter recipient name');
  await fill(page, '#bf-recipient-phone', '9000012345', 'Enter recipient phone');
  await fill(page, '#bf-transport-name', 'Reference Delivery', 'Enter transport details');
  await fill(page, '#bf-tracking-id', `TRACK-${format}-${Date.now().toString().slice(-5)}`, 'Enter tracking reference');
  if (await page.locator('#bf-dispatch-date').count()) await page.locator('#bf-dispatch-date').fill(new Date().toISOString().slice(0, 10));
  await fill(page, '#bf-pono', `PO-REF-${format}`, 'Enter purchase-order reference');
  await fill(page, '#item-name-0', `${state.item.name} ${format}`, 'Enter item or service name');
  await fill(page, '#item-description-0', `${format} reference recording`, 'Enter line description');
  await fill(page, '#item-hsn-0', '84717020', 'Enter HSN code');
  await fill(page, '#item-qty-0', '1', 'Enter quantity');
  await fill(page, '#item-rate-base-0', format === 'DC' ? '3000' : '3000', format === 'DC' ? 'Enter internal DC rate' : 'Enter selling rate');
  if (await page.locator('#bf-description').count()) await fill(page, '#bf-description', `${format} created by the automated reference recorder.`, 'Enter transaction description');
  await addCaption(page, `Save ${format}`);
  const response = await clickAndWaitForResponse(
    page,
    page.getByRole('button', { name: /Save/ }).first(),
    row => row.request().method() === 'POST' && row.url().includes('/api/bills'),
    15000
  );
  const result = await response.json();
  if (!response.ok()) throw new Error(result.error || `${format} save failed`);
  state.created[format] = result.bill;
  await addCaption(page, `${format} saved: ${result.bill?.bill_number || 'success'}`, 'success');
}

async function fillBusinessItem(page, state, rate = 2200) {
  await select(page, '#bi-item-0', state.item.id, 'Select stock item');
  await fill(page, '#bi-qty-0', '1', 'Enter quantity');
  await fill(page, '#bi-rate-0', rate, 'Enter transaction rate');
}

async function saveBusiness(page, endpoint, buttonName) {
  await addCaption(page, buttonName);
  const response = await clickAndWaitForResponse(
    page,
    page.getByRole('button', { name: buttonName }),
    row => row.request().method() === 'POST' && row.url().includes(endpoint),
    15000
  );
  const payload = await response.json();
  if (!response.ok()) throw new Error(payload.error || `${buttonName} failed`);
  await addCaption(page, `${buttonName} completed successfully`, 'success');
  return payload;
}

async function appPage(context, state) {
  const login = await api('POST', '/auth/login', { username: 'owner1', password: 'owner123' });
  await context.addCookies([{
    url: baseUrl, name: 'tarangini_session', value: login.token,
    httpOnly: true, sameSite: 'Strict', expires: Math.floor(Date.now() / 1000) + 28800
  }]);
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(user => localStorage.setItem('user', JSON.stringify(user)), login.user);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForFunction(() => Boolean(window.STATE?.currentOrg && document.querySelector('#content')?.innerText.trim()), null, { timeout: 20000 });
  state.owner = login;
  return page;
}

function htmlEscape(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

async function run() {
  await waitForServer();
  const fixturePdf = await createFixturePdf();
  const state = await seedData();
  state.fixturePdf = fixturePdf;
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const results = [];
  let intakeResult = null;

  const flows = [
    { name: '01-sale-invoice', title: 'Sale Invoice', run: page => fillBill(page, state, 'SALE', 'sale') },
    { name: '02-quotation', title: 'Quotation', run: page => fillBill(page, state, 'QUOT', 'quotation') },
    { name: '03-delivery-challan', title: 'Delivery Challan with Internal Prices', run: page => fillBill(page, state, 'DC', 'challan') },
    { name: '04-proforma-invoice', title: 'Proforma Invoice', run: page => fillBill(page, state, 'PI', 'proforma') },
    {
      name: '05-project-printing', title: 'Project Printing Invoice', run: async page => {
        await navigate(page, 'project-printing', '#pp-billno');
        await selectBillParty(page, state.customer);
        await fill(page, '#pp-bw-rate', '2', 'Enter B/W print rate');
        await fill(page, '#pp-colour-rate', '10', 'Enter colour print rate');
        await fill(page, '#pp-book-rate', '50', 'Enter binding rate');
        await fill(page, '#pp-file-0', 'Customer Project.pdf', 'Enter project filename');
        await fill(page, '#pp-bw-0', '8', 'Enter B/W pages');
        await fill(page, '#pp-colour-0', '2', 'Enter colour pages');
        await fill(page, '#pp-books-0', '2', 'Enter number of books');
        const saved = await clickAndWaitForResponse(
          page,
          page.getByRole('button', { name: 'Save Project Printing Invoice' }),
          row => row.request().method() === 'POST' && row.url().includes('/api/bills')
        );
        const body = await saved.json();
        if (!saved.ok()) throw new Error(body.error || 'Project printing invoice failed');
        state.created.PP = body.bill;
        await addCaption(page, `Project invoice saved: ${body.bill?.bill_number}`, 'success');
      }
    },
    {
      name: '06-payment-received', title: 'Payment Received', run: async page => {
        await navigate(page, 'payment-received', '#pay-voucher-number');
        await selectPaymentParty(page, state.customer);
        await fill(page, '#pay-amount', '3000', 'Enter received amount');
        await fill(page, '#pay-ref', 'UPI-REFERENCE-001', 'Enter payment reference');
        await fill(page, '#pay-narration', 'Advance received for reference order', 'Enter narration');
        const checkbox = page.locator('#linkable-bills input[type=checkbox]').first();
        if (await checkbox.count() && await checkbox.isVisible()) await checkbox.check();
        const result = await saveBusiness(page, '/api/payments', 'Save Payment');
        state.created.PR = result.payment || result;
      }
    },
    {
      name: '07-payment-voucher', title: 'Payment Voucher', run: async page => {
        await navigate(page, 'payment-voucher', '#pay-voucher-number');
        await selectPaymentParty(page, state.supplier);
        await fill(page, '#pay-amount', '750', 'Enter paid amount');
        await fill(page, '#pay-ref', 'BANK-OUT-001', 'Enter voucher reference');
        await fill(page, '#pay-narration', 'Vendor advance for recording', 'Enter narration');
        await saveBusiness(page, '/api/payments', 'Save Voucher');
      }
    },
    {
      name: '08-purchase-order', title: 'Purchase Order', run: async page => {
        await navigate(page, 'purchase-orders', '#po-party');
        await select(page, '#po-party', state.supplier.id, 'Select supplier');
        await page.locator('#po-expected').fill(new Date(Date.now() + 86400000).toISOString().slice(0, 10));
        await fillBusinessItem(page, state, 2200);
        await fill(page, '#po-narration', 'Purchase order generated for reference recording', 'Enter purchase-order narration');
        const result = await saveBusiness(page, '/api/advanced/purchase-orders', 'Save Purchase Order');
        state.created.PO = result.purchase_order || result;
      }
    },
    {
      name: '09-purchase-bill', title: 'Purchase Bill', run: async page => {
        await navigate(page, 'purchase', '#purchase-party');
        await select(page, '#purchase-party', state.supplier.id, 'Select vendor');
        await fill(page, '#purchase-supplier-invoice', `SUP-${Date.now().toString().slice(-6)}`, 'Enter supplier invoice number');
        await fillBusinessItem(page, state, 2200);
        await fill(page, '#purchase-narration', 'Stock purchase for reference recording', 'Enter purchase narration');
        await saveBusiness(page, '/api/business/purchases', 'Save Purchase Bill');
      }
    },
    {
      name: '10-expense-voucher', title: 'Expense Voucher', run: async page => {
        await navigate(page, 'expense', '#expense-account');
        await select(page, '#expense-party', state.supplier.id, 'Select expense payee');
        await fill(page, '#expense-amount-base', '500', 'Enter expense amount');
        await fill(page, '#expense-reference', 'EXP-REF-001', 'Enter expense reference');
        await fill(page, '#expense-narration', 'Office consumables expense', 'Enter expense narration');
        await saveBusiness(page, '/api/business/expenses', 'Save Expense Voucher');
      }
    },
    {
      name: '11-credit-note', title: 'Credit Note', run: async page => {
        await navigate(page, 'notes', '#note-type');
        await select(page, '#note-type', 'credit', 'Select credit note');
        await select(page, '#note-party', state.customer.id, 'Select customer');
        await fillBusinessItem(page, state, 3000);
        await fill(page, '#note-narration', 'Customer return reference', 'Enter credit-note reason');
        await saveBusiness(page, '/api/business/notes', 'Save Note and Adjust Stock');
      }
    },
    {
      name: '12-debit-note', title: 'Debit Note', run: async page => {
        await navigate(page, 'notes', '#note-type');
        await select(page, '#note-type', 'debit', 'Select debit note');
        await select(page, '#note-party', state.supplier.id, 'Select vendor');
        await fillBusinessItem(page, state, 2200);
        await fill(page, '#note-narration', 'Vendor return reference', 'Enter debit-note reason');
        await saveBusiness(page, '/api/business/notes', 'Save Note and Adjust Stock');
      }
    },
    {
      name: '13-return-refund', title: 'Return and Refund', run: async page => {
        await navigate(page, 'returns', '#return-bill');
        await select(page, '#return-bill', state.created.SALE.id, 'Select original sale invoice');
        await page.locator('#ret-use-0').waitFor({ state: 'visible' });
        await page.locator('#ret-use-0').check();
        await fill(page, '#ret-qty-0', '1', 'Enter returned quantity');
        await fill(page, '#return-reason', 'Reference return due to compatibility check', 'Enter return reason');
        await saveBusiness(page, '/api/advanced/returns', 'Save Return');
      }
    },
    {
      name: '14-journal-entry', title: 'Journal Entry', run: async page => {
        await navigate(page, 'journal-entry', '#journal-lines');
        const accounts = await page.locator('.jl-account').first().locator('option').all();
        const values = [];
        for (const option of accounts) {
          const value = await option.getAttribute('value');
          if (value) values.push(value);
        }
        assert.ok(values.length >= 2, 'Journal accounts are unavailable');
        await select(page, '.jl-account >> nth=0', values[0], 'Select debit account');
        await select(page, '.jl-account >> nth=1', values[1], 'Select credit account');
        await fill(page, '.jl-debit >> nth=0', '500', 'Enter debit amount');
        await fill(page, '.jl-credit >> nth=1', '500', 'Enter credit amount');
        await fill(page, '#journal-narration', 'Balanced reference journal', 'Enter journal narration');
        await saveBusiness(page, '/api/accounting/journals', 'Save Balanced Entry');
      }
    },
    {
      name: '15-fast-pos', title: 'Fast POS Sale', run: async page => {
        await api('POST', '/advanced/shifts/open', {
          org_id: state.org.id, counter_name: 'Recording Counter', opening_cash: 1000
        }, state.owner.token).catch(() => null);
        await navigate(page, 'pos', '#pos-scan');
        await page.evaluate(itemId => addPOSItem(itemId), state.item.id);
        await select(page, '#pos-party', state.customer.id, 'Select POS customer');
        const totalText = await page.locator('#pos-total').innerText();
        await addCaption(page, `Review POS total: ${totalText}`);
        await fill(page, '#pos-pay-cash', '3000', 'Allocate the POS total to cash');
        const saved = await clickAndWaitForResponse(
          page,
          page.getByRole('button', { name: /Pay & Save/ }),
          row => row.request().method() === 'POST' && row.url().includes('/api/bills')
        );
        const body = await saved.json();
        if (!saved.ok()) throw new Error(body.error || 'POS save failed');
        await addCaption(page, `POS invoice saved: ${body.bill?.bill_number}`, 'success');
      }
    },
    {
      name: '16-job-order', title: 'Job Order', run: async page => {
        await navigate(page, 'job-new', '#job-party');
        await select(page, '#job-party', state.customer.id, 'Select job customer');
        await fill(page, '#job-commitment', 'Complete after customer approval and quality check', 'Enter customer commitment');
        await fill(page, '#job-description', 'Laptop SSD installation and testing', 'Enter work description');
        await fill(page, '#job-specifications', 'Back up data, install SSD, test boot and obtain approval', 'Enter specifications');
        await fill(page, '#job-unit-price-base', '1500', 'Enter estimated price');
        const saved = await clickAndWaitForResponse(
          page,
          page.getByRole('button', { name: 'Create Job and Token' }),
          row => row.request().method() === 'POST' && /\/api\/jobs$/.test(row.url())
        );
        const body = await saved.json();
        if (!saved.ok()) throw new Error(body.error || 'Job save failed');
        state.created.JOB = body;
        await addCaption(page, `Job created: ${body.token}`, 'success');
      }
    },
    {
      name: '17-warranty-replacement', title: 'Warranty Replacement', run: async page => {
        await navigate(page, 'warranty-replacements', '#wr-party');
        await select(page, '#wr-party', state.customer.id, 'Select warranty customer');
        await select(page, '#wr-delivery', state.created.DC.id, 'Link delivery challan');
        await select(page, '#wr-original-sale', state.created.SALE.id, 'Link original invoice');
        await select(page, '#wr-product', state.item.id, 'Select warranty product');
        await fill(page, '#wr-serial', `SN-${Date.now().toString().slice(-7)}`, 'Enter serial number');
        await fill(page, '#wr-vendor-ref', 'VENDOR-WARRANTY-REF', 'Enter vendor reference');
        await fill(page, '#wr-courier-vendor', 'Reference Courier', 'Enter courier vendor');
        await fill(page, '#wr-courier-tracking', 'COURIER-TRACK-001', 'Enter courier tracking number');
        await fill(page, '#wr-issue', 'SSD intermittently not detected under warranty', 'Enter customer complaint');
        const saved = await clickAndWaitForResponse(
          page,
          page.getByRole('button', { name: 'Save Warranty Case' }),
          row => row.request().method() === 'POST' && /\/api\/warranty-replacements$/.test(row.url())
        );
        const body = await saved.json();
        if (!saved.ok()) throw new Error(body.error || 'Warranty save failed');
        await addCaption(page, `Warranty case saved: ${body.replacement?.replacement_number}`, 'success');
      }
    },
    {
      name: '18-customer-intake', title: 'Customer Intake and PDF Analysis', publicPage: true, run: async page => {
        await page.goto(`${baseUrl}/customer-intake.html?org=${state.org.id}`, { waitUntil: 'networkidle' });
        await addCaption(page, 'Customer opens the intake page from the QR code');
        await page.getByRole('button', { name: 'Create New Request' }).click();
        await page.locator('#intake-service').waitFor({ state: 'visible' });
        const serviceValue = await page.locator('#intake-service option').evaluateAll(options =>
          options.map(option => option.value).find(Boolean));
        await select(page, '#intake-service', serviceValue, 'Select exact service');
        await page.locator('#intake-name').waitFor({ state: 'visible' });
        await fill(page, '#intake-name', 'Portal Recording Customer', 'Enter customer name');
        await fill(page, '#intake-phone', '9123456789', 'Enter customer phone');
        await fill(page, '#intake-email', 'portal.recording@example.test', 'Enter customer email');
        await fill(page, '#intake-address', 'Customer Wi-Fi intake demonstration address', 'Enter customer address');
        await fill(page, '#intake-item-type', 'PDF Project', 'Enter item type');
        await fill(page, '#intake-item-name', 'Customer Print Sample', 'Enter item name');
        await fill(page, '#intake-summary', 'Print the uploaded PDF with colour pages confirmed', 'Enter short request summary');
        await fill(page, '#intake-details', 'Please review the PDF page analysis before quotation.', 'Enter full instructions');
        await addCaption(page, 'Upload the PDF for automatic page and colour analysis');
        await page.locator('#intake-files').setInputFiles(state.fixturePdf);
        await page.waitForTimeout(1800);
        const confirm = page.locator('[id^="intake-pdf-confirm-"]').first();
        if (await confirm.count() && await confirm.isVisible()) await confirm.check();
        await page.locator('#intake-consent').check();
        await addCaption(page, 'Submit the customer request');
        const saved = await clickAndWaitForResponse(
          page,
          page.locator('#intake-submit-button'),
          row => row.request().method() === 'POST' && row.url().includes('/api/job-intake/submit-multipart'),
          30000
        );
        intakeResult = await saved.json();
        if (!saved.ok()) throw new Error(intakeResult.error || 'Customer intake failed');
        await page.getByText(/Unique Order ID/i).waitFor({ state: 'visible', timeout: 15000 });
        await addCaption(page, `Customer Order ID: ${intakeResult.order_id || intakeResult.request_number}`, 'success');
      }
    },
    {
      name: '19-customer-order-tracking', title: 'Customer Order Tracking', publicPage: true, run: async page => {
        assert.ok(intakeResult, 'Customer intake must succeed before tracking');
        await page.goto(`${baseUrl}/customer-intake.html?org=${state.org.id}`, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: 'Track Existing Order' }).click();
        await fill(page, '#lookup-order-id', intakeResult.order_id || intakeResult.request_number, 'Enter Order ID');
        await fill(page, '#lookup-phone', '9123456789', 'Enter customer phone');
        const checked = await clickAndWaitForResponse(
          page,
          page.getByRole('button', { name: 'Check Status' }),
          row => row.request().method() === 'GET' && row.url().includes('/api/job-intake/status')
        );
        const body = await checked.json();
        if (!checked.ok()) throw new Error(body.error || 'Order tracking failed');
        await page.locator('#lookup-result').getByText(/Order ID/i).first().waitFor({ state: 'visible' });
        await addCaption(page, 'Order status displayed successfully', 'success');
      }
    },
    {
      name: '20-owner-daily-log', title: 'Owner Daily Log', run: async page => {
        await navigate(page, 'operator-log', '#operator-work-title');
        await fill(page, '#operator-work-title', 'Review tomorrow production schedule', 'Enter owner task title');
        await select(page, '#operator-work-type', 'ADMIN', 'Select owner task type');
        await fill(page, '#operator-work-done', 'Reviewed operator assignments and priority customer deliveries.', 'Enter completed work');
        await fill(page, '#operator-work-pending', 'Confirm one customer quotation tomorrow morning.', 'Enter pending work');
        await fill(page, '#operator-work-minutes', '25', 'Enter duration');
        const saved = await clickAndWaitForResponse(
          page,
          page.getByRole('button', { name: 'Add to Daily Log' }),
          row => row.request().method() === 'POST' && row.url().includes('/api/operator-logs/entries')
        );
        const body = await saved.json();
        if (!saved.ok()) throw new Error(body.error || 'Owner log save failed');
        await addCaption(page, 'Owner daily task saved successfully', 'success');
      }
    }
  ];

  const requestedFlows = String(process.env.TARANGINI_RECORDING_FLOWS || '')
    .split(',').map(value => value.trim()).filter(Boolean);
  const selectedFlows = requestedFlows.length
    ? flows.filter(flow => requestedFlows.includes(flow.name))
    : flows;
  if (!selectedFlows.length) throw new Error(`No recording flows matched: ${requestedFlows.join(', ')}`);

  for (const flow of selectedFlows) {
    console.log(`Recording ${flow.name}: ${flow.title}`);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      recordVideo: { dir: videosDir, size: { width: 1440, height: 900 } },
      acceptDownloads: true
    });
    if (captureTraces) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    }
    const issues = [];
    const failedRequests = [];
    let page;
    let flowFailed = false;
    const startedAt = Date.now();
    try {
      page = flow.publicPage ? await context.newPage() : await appPage(context, state);
      page.on('pageerror', error => issues.push(`Page error: ${error.message}`));
      page.on('console', message => {
        if (['error', 'warning'].includes(message.type())) {
          const location = message.location();
          const source = location.url ? ` (${location.url}:${location.lineNumber}:${location.columnNumber})` : '';
          issues.push(`Console ${message.type()}: ${message.text()}${source}`);
        }
      });
      page.on('response', response => {
        if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.request().method()} ${response.url()}`);
      });
      await addCaption(page, flow.title);
      await flow.run(page);
      await page.waitForTimeout(900);
      await page.screenshot({ path: path.join(screenshotsDir, `${flow.name}.png`), fullPage: false });
      results.push({ name: flow.name, title: flow.title, status: 'PASS', duration_ms: Date.now() - startedAt, issues, failed_requests: failedRequests });
    } catch (error) {
      flowFailed = true;
      issues.push(error.stack || error.message);
      if (page) {
        await addCaption(page, `FAILED: ${error.message}`, 'error').catch(() => {});
        await page.screenshot({ path: path.join(screenshotsDir, `${flow.name}-failed.png`), fullPage: false }).catch(() => {});
      }
      results.push({ name: flow.name, title: flow.title, status: 'FAIL', duration_ms: Date.now() - startedAt, issues, failed_requests: failedRequests });
    } finally {
      if (captureTraces) {
        if (flowFailed) await context.tracing.stop({ path: path.join(tracesDir, `${flow.name}.zip`) }).catch(() => {});
        else await context.tracing.stop().catch(() => {});
      }
      if (page) {
        const video = page.video();
        await page.close().catch(() => {});
        if (video) {
          const destination = path.join(videosDir, `${flow.name}.webm`);
          const original = await video.path().catch(() => '');
          await video.saveAs(destination).catch(() => {});
          if (original && path.resolve(original) !== path.resolve(destination)) {
            fs.rmSync(original, { force: true });
          }
        }
      }
      await context.close().catch(() => {});
    }
  }

  await browser.close();
  const report = {
    generated_at: new Date().toISOString(), base_url: baseUrl,
    isolated_database: dataDir, total: results.length,
    passed: results.filter(row => row.status === 'PASS').length,
    failed: results.filter(row => row.status === 'FAIL').length,
    results
  };
  fs.writeFileSync(path.join(outputRoot, 'diagnostic-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outputRoot, 'server-output.log'), serverOutput);
  const rows = results.map(row => {
    const tracePath = path.join(tracesDir, `${row.name}.zip`);
    return `<tr class="${row.status.toLowerCase()}"><td>${htmlEscape(row.status)}</td><td>${htmlEscape(row.title)}</td><td>${(row.duration_ms / 1000).toFixed(1)}s</td><td><a href="videos/${row.name}.webm">Video</a> | <a href="screenshots/${row.name}${row.status === 'FAIL' ? '-failed' : ''}.png">Screenshot</a>${fs.existsSync(tracePath) ? ` | <a href="traces/${row.name}.zip">Failure trace</a>` : ''}</td><td>${htmlEscape([...row.issues, ...row.failed_requests].join('\n') || 'None')}</td></tr>`;
  }).join('');
  fs.writeFileSync(path.join(outputRoot, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Tarangini Transaction Recording Report</title><style>body{font-family:Segoe UI,sans-serif;margin:30px;background:#f4f8fa;color:#102a3b}h1{margin-bottom:4px}.summary{display:flex;gap:12px;margin:20px 0}.summary div{padding:14px 22px;background:#fff;border-radius:10px;box-shadow:0 3px 12px #0001}table{border-collapse:collapse;width:100%;background:#fff}th,td{border:1px solid #d9e4e9;padding:10px;text-align:left;vertical-align:top}th{background:#075f71;color:#fff}.pass td:first-child{color:#16844b;font-weight:700}.fail td:first-child{color:#c9362b;font-weight:700}td:last-child{white-space:pre-wrap;font:12px Consolas,monospace}a{color:#075f71}</style></head><body><h1>Tarangini Transaction Recording Report</h1><p>${htmlEscape(report.generated_at)}</p><div class="summary"><div>Total <strong>${report.total}</strong></div><div>Passed <strong>${report.passed}</strong></div><div>Failed <strong>${report.failed}</strong></div></div><table><thead><tr><th>Status</th><th>Flow</th><th>Duration</th><th>Artifacts</th><th>Problems found</th></tr></thead><tbody>${rows}</tbody></table></body></html>`);
  fs.writeFileSync(path.join(root, 'output', 'playwright', 'transaction-recordings', 'LATEST.txt'), outputRoot);
  console.log(JSON.stringify(report, null, 2));
  console.log(`Recording report: ${path.join(outputRoot, 'index.html')}`);
  if (report.failed) process.exitCode = 1;
}

run().catch(error => {
  console.error(error);
  console.error(serverOutput);
  process.exitCode = 1;
}).finally(async () => {
  server.kill();
  await new Promise(resolve => {
    server.once('exit', resolve);
    setTimeout(resolve, 2000);
  });
});
