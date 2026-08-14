const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const APP_VERSION = require('../package.json').version;

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.v23-test');
const installer = path.join(dataDir, `Tarangini Workflow Suite Setup ${APP_VERSION}.exe`);
const port = 3203;
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
  for (let i = 0; i < 180; i += 1) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (health.ok) {
        assert.strictEqual((await health.json()).version, APP_VERSION);
        return;
      }
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(output);
}

function accountBalance(report, key) {
  const row = report.trial_balance.find(account => account.system_key === key);
  return Number(row?.debit || 0) - Number(row?.credit || 0);
}

(async () => {
  try {
    await waitForServer();
    const owner = await request('POST', '/auth/login', { username: 'owner1', password: 'owner123' });
    const org = await request('POST', '/orgs', {
      display_name: 'V23 Integration', registered_name: 'V23 Integration', gst_type: 'regular'
    }, owner.token);
    const customer = await request('POST', '/parties', {
      org_id: org.id, type: 'customer', name: 'V23 Customer'
    }, owner.token);
    const item = await request('POST', '/items', {
      org_id: org.id, name: 'Serialized Product', hsn_code: '84716040', unit: 'NOS', gst_rate: 18,
      last_sale_price: 100, last_purchase_price: 50, opening_stock: 10, barcode: 'V23BARCODE'
    }, owner.token);
    const operatorUser = await request('POST', '/auth/users', {
      name: 'V23 Operator', username: 'v23operator', password: 'operator123',
      role: 'operator', org_access: JSON.stringify([org.id]),
      permissions: { billing: true, inventory: true, reports: true, shifts: true, pos: true }
    }, owner.token);
    await request('PUT', `/auth/users/${operatorUser.id}`, {
      name: 'V23 Operator Updated', username: 'v23operator', role: 'operator',
      org_access: JSON.stringify([org.id]),
      permissions: { billing: true, inventory: true, reports: false, shifts: true, pos: true },
      active: true
    }, owner.token);
    const updatedOperator = (await request('GET', '/auth/users', undefined, owner.token))
      .find(user => Number(user.id) === Number(operatorUser.id));
    assert.strictEqual(updatedOperator.name, 'V23 Operator Updated');
    assert.strictEqual(updatedOperator.active, 1);
    assert.strictEqual(JSON.parse(updatedOperator.permissions).reports, false);
    const operator = await request('POST', '/auth/login', { username: 'v23operator', password: 'operator123' });

    const before = await request('GET', `/accounting/reports?org_id=${org.id}&fy=2026-27`, undefined, owner.token);
    const bankBill = (await request('POST', '/bills', {
      org_id: org.id, format: 'SALE', bill_date: '2026-06-08', party_id: customer.id,
      payment_mode: 'upi', credit_days: 3650,
      delivery_address: 'Delivery Street',
      delivery_info: {
        recipient_name: 'Recipient', recipient_phone: '9999999999',
        transport_name: 'Courier', tracking_id: 'LR-230', dispatch_date: '2026-06-09'
      },
      items: [{
        item_id: item.id, item_name: 'Serialized Product', item_description: 'Serial SN-230',
        qty: 2, unit: 'NOS', rate: 100, amount: 200, gst_rate: 18
      }]
    }, operator.token)).bill;
    assert.strictEqual(bankBill.grand_total, 236);

    const afterInvoice = await request('GET', `/accounting/reports?org_id=${org.id}&fy=2026-27`, undefined, owner.token);
    assert.strictEqual(accountBalance(afterInvoice, 'bank') - accountBalance(before, 'bank'), 0);
    assert.strictEqual(accountBalance(afterInvoice, 'accounts_receivable') - accountBalance(before, 'accounts_receivable'), 236);
    let settlement = await request('GET', `/bills/${bankBill.id}`, undefined, operator.token);
    assert.strictEqual(settlement.payment_status, 'unpaid');

    await request('POST', '/payments', {
      org_id: org.id, payment_date: '2026-06-08', party_id: customer.id,
      type: 'received', mode: 'upi', amount: 236, reference: 'UPI-230',
      linked_bills: [{ bill_id: bankBill.id, amount: 236 }]
    }, operator.token);
    const afterReceipt = await request('GET', `/accounting/reports?org_id=${org.id}&fy=2026-27`, undefined, owner.token);
    assert.strictEqual(accountBalance(afterReceipt, 'bank') - accountBalance(before, 'bank'), 236);
    settlement = await request('GET', `/bills/${bankBill.id}`, undefined, operator.token);
    assert.strictEqual(settlement.payment_status, 'paid');

    const splitBill = (await request('POST', '/bills', {
      org_id: org.id, format: 'SALE', bill_date: '2026-06-08', party_id: customer.id,
      payment_mode: 'split',
      split_payments: [{ mode: 'cash', amount: 59 }, { mode: 'card', amount: 59 }],
      items: [{ item_name: 'Split Service', item_description: 'Manual serial', qty: 1, unit: 'NOS', rate: 100, amount: 100 }]
    }, operator.token)).bill;
    settlement = await request('GET', `/bills/${splitBill.id}`, undefined, operator.token);
    assert.strictEqual(settlement.payment_status, 'partly paid');
    assert.strictEqual(settlement.paid_amount, 59);
    await request('POST', '/payments', {
      org_id: org.id, payment_date: '2026-06-08', party_id: customer.id,
      type: 'received', mode: 'card', amount: 59, reference: 'CARD-230',
      linked_bills: [{ bill_id: splitBill.id, amount: 59 }]
    }, operator.token);
    assert.strictEqual((await request('GET', `/bills/${splitBill.id}`, undefined, operator.token)).payment_status, 'paid');

    const duplicate = await request('POST', '/advanced/duplicate', {
      type: 'bill', id: bankBill.id, org_id: org.id, date: '2026-06-08'
    }, owner.token);
    const duplicateBill = await request('GET', `/bills/${duplicate.id}/full`, undefined, owner.token);
    assert.strictEqual(duplicateBill.items[0].item_description, 'Serial SN-230');
    assert.strictEqual(duplicateBill.delivery.tracking_id, 'LR-230');

    await request('POST', `/bills/${bankBill.id}/correction-request`, {
      reason: 'Remove one damaged serialized unit',
      proposed_items: [{ ...duplicateBill.items[0], qty: 1 }]
    }, operator.token);
    const corrections = await request('GET', `/bills/corrections/list?org_id=${org.id}&status=pending`, undefined, owner.token);
    const approved = await request('PUT', `/bills/corrections/${corrections[0].id}/review`, {
      decision: 'approve', review_note: 'Approved after verification', note_date: '2026-06-08'
    }, owner.token);
    assert.ok(approved.credit_note.id);
    settlement = await request('GET', `/bills/${bankBill.id}`, undefined, owner.token);
    assert.strictEqual(settlement.credit_note_amount, 118);
    const stock = await request('GET', `/business/stock?org_id=${org.id}`, undefined, owner.token);
    assert.strictEqual(stock.items.find(row => row.id === item.id).current_stock, 7);
    const stockJournal = await request(
      'GET', `/business/stock-movements?org_id=${org.id}`, undefined, owner.token
    );
    assert.ok(stockJournal.some(row => row.ref_number === approved.credit_note.note_number && Number(row.qty_in) === 1));
    assert.ok(stockJournal.some(row => row.ref_number === bankBill.bill_number && Number(row.qty_out) === 2));
    const mobileLogin = await request('GET', '/advanced/mobile-login-qr', undefined, owner.token);
    assert.match(mobileLogin.url, new RegExp(`^http://[^/]+:\\d+/mobile-${APP_VERSION.replace(/\./g, '\\.')}$`));
    assert.match(mobileLogin.qr_data_url, /^data:image\/png;base64,/);
    assert.ok(!mobileLogin.url.includes(owner.token), 'Mobile QR must not contain an authentication token');

    const shift = (await request('POST', '/advanced/shifts/open', {
      org_id: org.id, counter_name: 'Mobile Counter', opening_cash: 100
    }, operator.token)).shift;
    await request('POST', '/bills', {
      org_id: org.id, format: 'SALE', bill_date: '2026-06-08', party_id: customer.id,
      payment_mode: 'upi', shift_id: shift.id,
      items: [{ item_name: 'Pending UPI', qty: 1, unit: 'NOS', rate: 100, amount: 100 }]
    }, operator.token);
    const shiftReport = await request('GET', `/advanced/shifts/${shift.id}/report`, undefined, operator.token);
    assert.strictEqual(shiftReport.collections.upi, 0);
    assert.strictEqual(shiftReport.pending_amount, 118);

    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(installer, `${APP_VERSION} installer fixture`);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex').toUpperCase();
    await request('POST', '/advanced/presence', {
      org_id: org.id, client_id: 'unsafe-client', client_name: 'Offline Client',
      app_version: '2.2.1', pending_sync: 1, sync_conflicts: 0, page: 'sale'
    }, operator.token);
    await request('POST', '/advanced/update-packages', {
      version: APP_VERSION, file_path: installer, sha256
    }, owner.token, 409);
    await request('POST', '/advanced/presence', {
      org_id: org.id, client_id: 'unsafe-client', client_name: 'Offline Client',
      app_version: APP_VERSION, pending_sync: 0, sync_conflicts: 0, page: 'dashboard'
    }, operator.token);
    await request('POST', '/advanced/update-packages', {
      version: APP_VERSION, file_path: installer, sha256: 'A'.repeat(64)
    }, owner.token, 400);
    const published = await request('POST', '/advanced/update-packages', {
      version: APP_VERSION, file_path: installer, sha256, release_notes: `${APP_VERSION} integration fixture`
    }, owner.token);
    assert.ok(fs.existsSync(published.recovery_backup));

    console.log('Version 2.3 upgrade integration tests passed');
  } finally {
    server.kill();
    setTimeout(() => fs.rmSync(dataDir, { recursive: true, force: true }), 200);
  }
})().catch(error => {
  console.error(error);
  console.error(output);
  process.exitCode = 1;
});
