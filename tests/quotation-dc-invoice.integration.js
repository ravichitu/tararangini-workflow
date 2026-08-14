const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.quotation-dc-invoice-test');
const port = 3217;
fs.rmSync(dataDir, { recursive: true, force: true });
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), TARANGINI_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });

async function request(method, route, body, token, expectFailure = false) {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch (_) { payload = { text }; }
  if (!response.ok && !expectFailure) throw new Error(`${method} ${route}: ${payload.error || response.status}\n${output}`);
  return { response, payload };
}

async function waitForServer() {
  for (let i = 0; i < 160; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(output);
}

(async () => {
  try {
    await waitForServer();
    const login = (await request('POST', '/auth/login', { username: 'owner1', password: 'owner123' })).payload;
    const token = login.token;
    const org = (await request('POST', '/orgs', { display_name: 'Flow Test', registered_name: 'Flow Test', gst_type: 'regular' }, token)).payload;
    const party = (await request('POST', '/parties', { org_id: org.id, type: 'customer', name: 'Flow Customer' }, token)).payload;
    const quotation = (await request('POST', '/bills', {
      org_id: org.id, format: 'QUOT', bill_date: '2026-07-21', party_id: party.id,
      items: [{ item_name: 'Design Service', qty: 5, unit: 'JOB', rate: 100, amount: 500 }]
    }, token)).payload.bill;
    const dc = (await request('POST', `/bills/${quotation.id}/derive`, {
      target_format: 'DC', items: [{ source_line_key: '0', qty: 2 }]
    }, token)).payload.bill;
    assert.strictEqual(dc.format, 'DC');
    assert.strictEqual(JSON.parse(dc.items_json)[0].qty, 2);
    assert.strictEqual(Number(dc.total_tax), 0);
    const dcOnlyDashboard = (await request('GET', `/reports/dashboard?org_id=${org.id}&fy=2026-27`, undefined, token)).payload;
    assert.strictEqual(Number(dcOnlyDashboard.receivable), 0, 'Delivery Challans must not post customer ledger balances');
    const over = await request('POST', `/bills/${quotation.id}/derive`, {
      target_format: 'DC', items: [{ source_line_key: '0', qty: 4 }]
    }, token, true);
    assert.strictEqual(over.response.status, 400);
    const invoice = (await request('POST', `/bills/${dc.id}/derive`, {
      target_format: 'SALE', payment_mode: 'credit'
    }, token)).payload.bill;
    assert.strictEqual(invoice.format, 'SALE');
    assert.strictEqual(JSON.parse(invoice.items_json)[0].qty, 2);
    assert.ok(Number(invoice.grand_total) > 0);
    const invoiceDashboard = (await request('GET', `/reports/dashboard?org_id=${org.id}&fy=2026-27`, undefined, token)).payload;
    assert.strictEqual(Number(invoiceDashboard.receivable), Number(invoice.grand_total));
    const full = (await request('GET', `/bills/${quotation.id}/full`, undefined, token)).payload;
    assert.ok(full.linked_documents.some(row => Number(row.id) === Number(dc.id)));
    const legacySource = (await request('POST', '/bills', {
      org_id: org.id, format: 'QUOT', bill_date: '2026-07-21', party_id: party.id,
      items: [{ item_name: 'Legacy Service', qty: 1, unit: 'JOB', rate: 50, amount: 50 }]
    }, token)).payload.bill;
    const legacy = (await request('POST', `/bills/${legacySource.id}/convert`, {}, token)).payload.bill;
    const legacyFull = (await request('GET', `/bills/${legacy.id}/full`, undefined, token)).payload;
    assert.ok(legacyFull.linked_documents.some(row => Number(row.id) === Number(legacySource.id)));
    console.log('Quotation/DC/invoice integration tests passed');
  } finally {
    server.kill();
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
