const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.tax-inclusive-test');
const port = 3237;
fs.rmSync(dataDir, { recursive: true, force: true });

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), TARANGINI_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Tax-inclusive test server did not start:\n${output}`);
}

async function request(method, route, body, token, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
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
  assert.strictEqual(response.status, expected, `${method} ${route}: ${text}\n${output}`);
  return payload;
}

function assertInclusive118(record, taxField = 'total_tax') {
  assert.strictEqual(Number(record.taxable_amount), 100);
  assert.strictEqual(Number(record[taxField]), 18);
  assert.strictEqual(Number(record.grand_total), 118);
  assert.strictEqual(Number(record.tax_inclusive), 1);
}

(async () => {
  try {
    await waitForServer();
    const owner = await request('POST', '/auth/login', {
      username: 'owner1', password: 'owner123'
    });
    const org = await request('POST', '/orgs', {
      display_name: 'Inclusive GST Company', registered_name: 'Inclusive GST Company',
      gst_type: 'regular', default_tax_inclusive: true
    }, owner.token);
    const vendor = await request('POST', '/parties', {
      org_id: org.id, type: 'both', name: 'Inclusive GST Party'
    }, owner.token);
    const item = await request('POST', '/items', {
      org_id: org.id, name: 'Inclusive Item', hsn_code: '84716040', unit: 'NOS',
      gst_rate: 18, last_sale_price: 118, last_purchase_price: 100
    }, owner.token);
    const itemLine = {
      item_id: item.id, item_name: 'Inclusive Item', qty: 1,
      unit: 'NOS', rate: 118, gst_rate: 18
    };

    const purchase = (await request('POST', '/business/purchases', {
      org_id: org.id, purchase_date: '2026-06-13', party_id: vendor.id,
      payment_mode: 'credit', tax_inclusive: true, items: [itemLine]
    }, owner.token)).purchase;
    assertInclusive118(purchase);
    const purchaseItems = JSON.parse(purchase.items_json);
    assert.strictEqual(purchaseItems[0].entered_rate, 118);
    assert.strictEqual(purchaseItems[0].rate, 100);

    const note = (await request('POST', '/business/notes', {
      org_id: org.id, note_date: '2026-06-13', note_type: 'credit',
      party_id: vendor.id, tax_inclusive: true, items: [itemLine]
    }, owner.token)).note;
    assertInclusive118(note, 'tax_amount');

    const accounts = await request(
      'GET', `/accounting/accounts?org_id=${org.id}`, undefined, owner.token
    );
    const expenseAccount = accounts.find(account => account.type === 'expense');
    const expense = (await request('POST', '/business/expenses', {
      org_id: org.id, expense_date: '2026-06-13', account_id: expenseAccount.id,
      payment_mode: 'cash', amount: 118, gst_amount: 18, gst_rate: 18,
      tax_inclusive: true
    }, owner.token)).expense;
    assert.strictEqual(Number(expense.amount), 118);
    assert.strictEqual(Number(expense.gst_amount), 18);
    assert.strictEqual(Number(expense.tax_inclusive), 1);

    const order = (await request('POST', '/advanced/purchase-orders', {
      org_id: org.id, po_date: '2026-06-13', party_id: vendor.id,
      tax_inclusive: true, items: [itemLine]
    }, owner.token)).purchase_order;
    assert.strictEqual(Number(order.subtotal), 118);
    assert.strictEqual(Number(order.tax_inclusive), 1);
    const converted = (await request('POST', `/advanced/purchase-orders/${order.id}/convert`, {
      purchase_date: '2026-06-13', supplier_invoice: 'INC-PO-1'
    }, owner.token)).purchase;
    assertInclusive118(converted);

    const fractionalLine = {
      item_id: item.id, item_name: 'Fractional GST Item', qty: 1,
      unit: 'NOS', rate: 99, gst_rate: 18
    };
    const roundedBill = (await request('POST', '/bills', {
      org_id: org.id, format: 'SALE', bill_date: '2026-06-13',
      party_id: vendor.id, payment_mode: 'credit', items: [fractionalLine]
    }, owner.token)).bill;
    assert.strictEqual(Number(roundedBill.taxable_amount), 99);
    assert.strictEqual(Number(roundedBill.total_tax), 17.82);
    assert.strictEqual(Number(roundedBill.round_off), 0.18);
    assert.strictEqual(Number(roundedBill.grand_total), 117);
    const preflight = await request(
      'GET', `/reports/gst/einvoice/preflight?bill_id=${roundedBill.id}`, undefined, owner.token, 422
    );
    assert.strictEqual(preflight.live_submission, false);
    assert.strictEqual(preflight.payload.live_submission, false);
    assert.ok(preflight.errors.length > 0);
    assert.ok(!preflight.errors.some(error => /HSN|SAC/i.test(error)));
    const ewayPreflight = await request(
      'GET', `/reports/gst/ewaybill/preflight?bill_id=${roundedBill.id}`, undefined, owner.token, 422
    );
    assert.strictEqual(ewayPreflight.live_submission, false);
    assert.strictEqual(ewayPreflight.manual_review_required, true);
    assert.ok(ewayPreflight.errors.some(error => /vehicle|transporter/i.test(error)));

    const unroundedBill = (await request('POST', '/bills', {
      org_id: org.id, format: 'SALE', bill_date: '2026-06-13',
      party_id: vendor.id, payment_mode: 'credit', round_off_enabled: false,
      items: [fractionalLine]
    }, owner.token)).bill;
    assert.strictEqual(Number(unroundedBill.round_off), 0);
    assert.strictEqual(Number(unroundedBill.grand_total), 116.82);

    const roundedPurchase = (await request('POST', '/business/purchases', {
      org_id: org.id, purchase_date: '2026-06-13', party_id: vendor.id,
      payment_mode: 'credit', items: [fractionalLine]
    }, owner.token)).purchase;
    assert.strictEqual(Number(roundedPurchase.round_off), 0.18);
    assert.strictEqual(Number(roundedPurchase.grand_total), 117);

    const roundedNote = (await request('POST', '/business/notes', {
      org_id: org.id, note_date: '2026-06-13', note_type: 'credit',
      party_id: vendor.id, items: [fractionalLine]
    }, owner.token)).note;
    assert.strictEqual(Number(roundedNote.round_off), 0.18);
    assert.strictEqual(Number(roundedNote.grand_total), 117);

    const roundedExpense = (await request('POST', '/business/expenses', {
      org_id: org.id, expense_date: '2026-06-13', account_id: expenseAccount.id,
      payment_mode: 'cash', amount: 116.82, gst_amount: 17.82, gst_rate: 18
    }, owner.token)).expense;
    assert.strictEqual(Number(roundedExpense.round_off), 0.18);
    assert.strictEqual(Number(roundedExpense.amount), 117);

    const roundedOrder = (await request('POST', '/advanced/purchase-orders', {
      org_id: org.id, po_date: '2026-06-13', party_id: vendor.id,
      items: [fractionalLine]
    }, owner.token)).purchase_order;
    assert.strictEqual(Number(roundedOrder.round_off), 0.18);
    assert.strictEqual(Number(roundedOrder.subtotal), 117);

    const report = await request(
      'GET', `/accounting/reports?org_id=${org.id}&fy=2026-27`, undefined, owner.token
    );
    const totalDebit = report.trial_balance.reduce((sum, row) => sum + Number(row.debit), 0);
    const totalCredit = report.trial_balance.reduce((sum, row) => sum + Number(row.credit), 0);
    assert.strictEqual(Number(totalDebit.toFixed(2)), Number(totalCredit.toFixed(2)));
    assert.ok(report.trial_balance.some(row => row.system_key === 'round_off'));

    console.log('Tax-inclusive and universal round-off integration tests passed');
  } finally {
    if (!server.killed) {
      server.kill();
      await new Promise(resolve => {
        server.once('exit', resolve);
        setTimeout(resolve, 2000);
      });
    }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => {
  console.error(error);
  console.error(output);
  process.exitCode = 1;
});
