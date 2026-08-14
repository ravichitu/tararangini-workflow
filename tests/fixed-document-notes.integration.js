const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.fixed-document-notes-test');
const port = 3256;
fs.rmSync(dataDir, { recursive: true, force: true });

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), TARANGINI_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });

async function request(method, route, body, token, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch (_) { payload = text; }
  assert.strictEqual(response.status, expected, `${method} ${route}: ${text}\n${output}`);
  return payload;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Fixed-document note test server did not start:\n${output}`);
}

(async () => {
  try {
    await waitForServer();
    const owner = await request('POST', '/auth/login', { username: 'owner1', password: 'owner123' });
    const org = await request('POST', '/orgs', {
      display_name: 'Fixed Note Company', registered_name: 'Fixed Note Company', gst_type: 'regular',
      note_footer: 'General company footer', quotation_fixed_note: 'Quotation terms apply',
      delivery_challan_fixed_note: 'Delivery challan acknowledgement required',
      proforma_fixed_note: 'Proforma invoice only - not a tax invoice'
    }, owner.token);
    const party = await request('POST', '/parties', {
      org_id: org.id, type: 'customer', name: 'Fixed Note Customer'
    }, owner.token);

    const createBill = async format => request('POST', '/bills', {
      org_id: org.id, format, bill_date: '2026-07-27', party_id: party.id, payment_mode: 'credit',
      items: [{ item_name: `${format} Fixed Note Service`, hsn_code: '998313', unit: 'NOS', qty: 1, rate: 100, amount: 100, gst_rate: format === 'DC' ? 0 : 18 }]
    }, owner.token);
    const quotation = await createBill('QUOT');
    const challan = await createBill('DC');
    const proforma = await createBill('PI');
    const sale = await createBill('SALE');
    assert.strictEqual(quotation.bill.note_footer, 'Quotation terms apply\nGeneral company footer');
    assert.strictEqual(challan.bill.note_footer, 'Delivery challan acknowledgement required\nGeneral company footer');
    assert.strictEqual(proforma.bill.note_footer, 'Proforma invoice only - not a tax invoice\nGeneral company footer');
    assert.strictEqual(sale.bill.note_footer, 'General company footer');

    const editPayload = { ...quotation.bill, description: 'Edited quotation description', items: quotation.bill.items };
    const updated = await request('PUT', `/bills/${quotation.id}`, editPayload, owner.token);
    assert.strictEqual(updated.bill.note_footer, 'Quotation terms apply\nGeneral company footer');
    console.log('Fixed-document note integration tests passed');
  } finally {
    server.kill();
    await new Promise(resolve => {
      if (server.exitCode !== null) return resolve();
      const timeout = setTimeout(resolve, 1500);
      server.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
