const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.duplicate-exact-test');
const port = 3215;
const today = new Date().toISOString().slice(0, 10);
fs.rmSync(dataDir, { recursive: true, force: true });

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), TARANGINI_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });

async function request(method, route, body, token, expectedStatus = 200) {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch (_) { payload = text; }
  assert.strictEqual(response.status, expectedStatus, `${method} ${route}: ${text}\n${output}`);
  return payload;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start\n${output}`);
}

(async () => {
  try {
    await waitForServer();
    const owner = await request('POST', '/auth/login', { username: 'owner1', password: 'owner123' });
    const org = await request('POST', '/orgs', {
      display_name: 'Exact Copy Test', registered_name: 'Exact Copy Test', gst_type: 'regular',
      note_header: 'Prepared for exact-copy verification', note_footer: 'Original quotation note'
    }, owner.token);
    const otherOrg = await request('POST', '/orgs', {
      display_name: 'Other Company', registered_name: 'Other Company', gst_type: 'regular'
    }, owner.token);
    const party = await request('POST', '/parties', {
      org_id: org.id, type: 'customer', name: 'Exact Copy Customer', phone: '9000000001',
      address: '7 Original Road', city: 'Kakinada', state: 'Andhra Pradesh'
    }, owner.token);
    const item = await request('POST', '/items', {
      org_id: org.id, name: 'Exact Copy Service', hsn_code: '998313', unit: 'NOS', gst_rate: 18,
      last_sale_price: 120
    }, owner.token);
    const created = await request('POST', '/bills', {
      org_id: org.id, format: 'QUOT', bill_date: today, party_id: party.id,
      payment_mode: 'credit', credit_days: 30, delivery_address: 'Delivery Desk, Kakinada',
      delivery_info: {
        recipient_name: 'Jaya', recipient_phone: '9000000001',
        transport_name: 'Tarangini Courier', tracking_id: 'TRACK-EXACT-1', dispatch_date: today
      },
      po_number: 'PO-EXACT-001', po_date: today, description: 'Keep every quotation value',
      swipe_charge: 3.5, tax_inclusive: false,
      items: [{
        item_id: item.id, item_name: 'Exact Copy Service', item_description: 'Colour print and binding',
        qty: 2, unit: 'NOS', rate: 120, amount: 240, gst_rate: 18
      }]
    }, owner.token);
    const source = await request('GET', `/bills/${created.bill.id}/full`, undefined, owner.token);
    const duplicateResult = await request('POST', '/advanced/duplicate', {
      type: 'bill', id: source.id, org_id: org.id
    }, owner.token);
    const duplicate = await request('GET', `/bills/${duplicateResult.id}/full`, undefined, owner.token);

    assert.notStrictEqual(duplicate.id, source.id);
    assert.notStrictEqual(duplicate.bill_number, source.bill_number);
    [
      'org_id', 'format', 'bill_date', 'party_id', 'party_snapshot', 'delivery_address', 'delivery_info',
      'po_number', 'po_date', 'credit_days', 'due_date', 'payment_mode', 'items_json', 'subtotal', 'discount',
      'taxable_amount', 'cgst', 'sgst', 'igst', 'total_tax', 'grand_total', 'round_off', 'total_in_words',
      'note_header', 'note_footer', 'description', 'swipe_charge', 'custom_data', 'split_payments',
      'cost_total', 'bank_details', 'tax_inclusive'
    ].forEach(field => assert.deepStrictEqual(duplicate[field], source[field], `Duplicate changed ${field}`));
    assert.strictEqual(duplicate.digital_signature_signed_at, null);
    assert.strictEqual(duplicate.digital_signature_signed_by, null);
    assert.strictEqual(duplicate.payment_status, 'unpaid');
    const auditRows = await request('GET', `/advanced/audit-log?org_id=${org.id}&action=DUPLICATE_TRANSACTION`, undefined, owner.token);
    const duplicateAudit = auditRows.find(row => Number(row.record_id) === Number(duplicate.id));
    assert.ok(duplicateAudit, 'Duplicate creation must be recorded in the audit log');
    assert.strictEqual(JSON.parse(duplicateAudit.old_data).source_id, source.id);

    const rejected = await request('POST', '/advanced/duplicate', {
      type: 'bill', id: source.id, org_id: otherOrg.id
    }, owner.token, 400);
    assert.match(rejected.error, /original company/i);

    console.log('Duplicate exact-copy integration test passed.');
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    // Windows can retain SQLite handles briefly; wait for the child process before cleanup.
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 2000);
      server.once('exit', () => { clearTimeout(timeout); resolve(); });
      server.kill();
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})();
