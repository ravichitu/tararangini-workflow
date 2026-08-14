const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.advanced-test');
const reportDir = path.join(dataDir, 'reports');
const port = 3199;
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
  try { payload = JSON.parse(text); } catch (_) { payload = text; }
  if (!response.ok && !expectFailure) throw new Error(`${method} ${route}: ${payload.error || response.status}\n${output}`);
  return { response, payload };
}

async function waitForServer() {
  for (let i = 0; i < 180; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(output);
}

(async () => {
  try {
    await waitForServer();
    const login = (await request('POST', '/auth/login', { username: 'owner1', password: 'owner123' })).payload;
    const token = login.token;
    const org = (await request('POST', '/orgs', {
      display_name: 'Advanced Test', registered_name: 'Advanced Test', gst_type: 'regular',
      invoice_qr_enabled: true, negative_stock_allowed: false
    }, token)).payload;
    const jobOperator = (await request('POST', '/auth/users', {
      name: 'Advanced Job Operator', username: 'advanced-job-operator', pin: '5505',
      role: 'operator', org_access: JSON.stringify([org.id]),
      permissions: { billing: true, pos: true, inventory: true, reports: true, jobs_operations: true, jobs_assign: true }
    }, token)).payload;
    const operatorLogin = (await request('POST', '/auth/login', {
      username: 'advanced-job-operator', pin: '5505'
    })).payload;
    const customer = (await request('POST', '/parties', {
      org_id: org.id, type: 'customer', name: 'POS Customer', phone: '9999999999'
    }, token)).payload;
    const supplier = (await request('POST', '/parties', {
      org_id: org.id, type: 'supplier', name: 'Paper Supplier'
    }, token)).payload;
    const item = (await request('POST', '/items', {
      org_id: org.id, name: 'A4 Paper Pack', hsn_code: '48025690', unit: 'PKT', gst_rate: 18,
      last_sale_price: 100, last_purchase_price: 60, opening_stock: 2, barcode: 'TEST1001'
    }, token)).payload;

    const shift = (await request('POST', '/advanced/shifts/open', {
      org_id: org.id, counter_name: 'Counter 1', opening_cash: 500
    }, token)).payload.shift;
    assert.strictEqual(shift.status, 'open');
    const adjustedShift = (await request('PUT', `/advanced/shifts/${shift.id}/cash`, {
      cash_added: 500, cash_removed: 0, reason: 'Cash float added'
    }, token)).payload.shift;
    assert.strictEqual(Number(adjustedShift.cash_added), 500);
    await request('PUT', `/advanced/shifts/${shift.id}/cash`, {
      cash_added: 0, cash_removed: 100, reason: 'Petty cash removed'
    }, token);

    const held = (await request('POST', '/advanced/held-bills', {
      org_id: org.id, shift_id: shift.id, hold_name: 'Customer waiting',
      cart: { items: [{ item_id: item.id, qty: 1 }] }
    }, token)).payload;
    assert.ok(held.id);
    assert.strictEqual((await request('GET', `/advanced/held-bills?org_id=${org.id}`, undefined, token)).payload.length, 1);

    const sale = (await request('POST', '/bills', {
      org_id: org.id, format: 'SALE', bill_date: '2026-06-07', party_id: customer.id,
      payment_mode: 'split', shift_id: shift.id,
      split_payments: [{ mode: 'cash', amount: 59 }, { mode: 'upi', amount: 59 }],
      items: [{ item_id: item.id, item_name: 'A4 Paper Pack', qty: 1, unit: 'PKT', rate: 100, amount: 100, gst_rate: 18 }]
    }, token)).payload.bill;
    assert.strictEqual(sale.grand_total, 118);
    assert.strictEqual(JSON.parse(sale.split_payments).length, 2);
    assert.strictEqual(sale.cost_total, 60);

    const concurrentSales = await Promise.all([1, 2, 3].map(index => request('POST', '/bills', {
      org_id: org.id, format: 'SALE', bill_date: '2026-06-07', party_id: customer.id,
      payment_mode: 'cash',
      items: [{ item_name: `Concurrent Service ${index}`, qty: 1, unit: 'NOS',
        rate: 10 * index, amount: 10 * index, gst_rate: 18 }]
    }, token)));
    const concurrentNumbers = concurrentSales.map(result => result.payload.bill.bill_number);
    assert.strictEqual(new Set(concurrentNumbers).size, 3);
    const firstPagedBill = (await request('GET', `/bills?org_id=${org.id}&fy=2026-27&limit=1&offset=0`, undefined, token)).payload;
    const secondPagedBill = (await request('GET', `/bills?org_id=${org.id}&fy=2026-27&limit=1&offset=1`, undefined, token)).payload;
    assert.strictEqual(firstPagedBill.length, 1);
    assert.strictEqual(secondPagedBill.length, 1);
    assert.notStrictEqual(firstPagedBill[0].id, secondPagedBill[0].id);
    const searchedBills = (await request('GET', `/bills?org_id=${org.id}&fy=2026-27&search=${encodeURIComponent('POS Customer')}&limit=10`, undefined, token)).payload;
    assert.ok(searchedBills.some(row => Number(row.party_id) === Number(customer.id)));
    const previousYearQuotation = (await request('POST', '/bills', {
      org_id: org.id, format: 'QUOT', bill_date: '2025-02-15', party_id: customer.id,
      payment_mode: 'credit', description: 'Historical search reference LEGACY-BILL-2025',
      items: [{ item_name: 'Historical Service', qty: 1, unit: 'NOS', rate: 75, amount: 75, gst_rate: 18 }]
    }, token)).payload.bill;
    const allYearBillSearch = (await request(
      'GET', `/bills?org_id=${org.id}&format=QUOT&search=${encodeURIComponent(previousYearQuotation.bill_number)}&limit=10`, undefined, token
    )).payload;
    assert.ok(allYearBillSearch.some(row => Number(row.id) === Number(previousYearQuotation.id)));
    const allYearGlobalSearch = (await request(
      'GET', `/advanced/transaction-search?org_id=${org.id}&q=${encodeURIComponent(previousYearQuotation.bill_number)}`, undefined, token
    )).payload;
    assert.ok(allYearGlobalSearch.some(row => row.source === 'bill' && Number(row.id) === Number(previousYearQuotation.id)));

    const negativeStockSale = await request('POST', '/bills', {
      org_id: org.id, format: 'SALE', bill_date: '2026-06-07', party_id: customer.id,
      items: [{ item_id: item.id, item_name: 'A4 Paper Pack', qty: 2, unit: 'PKT', rate: 100, amount: 200 }]
    }, token);
    assert.strictEqual(negativeStockSale.response.status, 200);
    assert.strictEqual(negativeStockSale.payload.stock_warnings.length, 1);

    const returned = (await request('POST', '/advanced/returns', {
      org_id: org.id, bill_id: sale.id, note_date: '2026-06-07', refund_mode: 'cash', shift_id: shift.id,
      items: [{ item_id: item.id, item_name: 'A4 Paper Pack', qty: 1, unit: 'PKT', rate: 100 }]
    }, token)).payload;
    assert.ok(returned.note.id);

    const po = (await request('POST', '/advanced/purchase-orders', {
      org_id: org.id, po_date: '2026-06-07', party_id: supplier.id,
      items: [{ item_id: item.id, item_name: 'A4 Paper Pack', qty: 5, unit: 'PKT', rate: 55, gst_rate: 18 }]
    }, token)).payload.purchase_order;
    assert.strictEqual(po.status, 'open');
    const purchase = (await request('POST', `/advanced/purchase-orders/${po.id}/convert`, {
      purchase_date: '2026-06-07', payment_mode: 'credit'
    }, token)).payload.purchase;
    assert.ok(purchase.id);

    const duplicateSale = (await request('POST', '/advanced/duplicate', {
      type: 'bill', id: sale.id, org_id: org.id, date: '2026-06-08'
    }, token)).payload;
    assert.match(duplicateSale.number, /^ADV-SB\/26\/\d{4}$/);
    const globalSearch = (await request('GET', `/advanced/transaction-search?org_id=${org.id}&fy=2026-27&q=POS%20Customer`, undefined, token)).payload;
    assert.ok(globalSearch.some(row => row.source === 'bill' && Number(row.id) === Number(sale.id)));
    const duplicateNote = (await request('POST', '/advanced/duplicate', {
      type: 'note', id: returned.note.id, org_id: org.id, date: '2026-06-08'
    }, token)).payload;
    assert.ok(duplicateNote.id);
    const duplicatePurchase = (await request('POST', '/advanced/duplicate', {
      type: 'purchase', id: purchase.id, org_id: org.id, date: '2026-06-08'
    }, token)).payload;
    assert.ok(duplicatePurchase.id);
    const duplicatePo = (await request('POST', '/advanced/duplicate', {
      type: 'purchase_order', id: po.id, org_id: org.id, date: '2026-06-08'
    }, token)).payload;
    assert.ok(duplicatePo.id);

    const payments = (await request('GET', `/payments?org_id=${org.id}&type=paid`, undefined, token)).payload;
    const duplicatePayment = (await request('POST', '/advanced/duplicate', {
      type: 'payment', id: payments[0].id, org_id: org.id, date: '2026-06-08'
    }, token)).payload;
    assert.ok(duplicatePayment.id);

    const personalLedger = (await request('POST', '/accounting/accounts', {
      org_id: org.id, code: '1025', name: 'Owner Personal Collection Account',
      type: 'asset', subtype: 'bank'
    }, token)).payload;
    const personalReceipt = (await request('POST', '/payments', {
      org_id: org.id, payment_date: '2026-06-08', party_id: customer.id,
      type: 'received', mode: 'account', deposit_account_id: personalLedger.id,
      amount: 75, reference: 'PERSONAL-UPI-1', narration: 'Received into owner personal account'
    }, token)).payload;
    assert.ok(personalReceipt.id);
    const receiptRows = (await request('GET', `/payments?org_id=${org.id}&type=received&fy=2026-27`, undefined, token)).payload;
    const personalReceiptRow = receiptRows.find(row => row.payment_number === personalReceipt.payment_number);
    assert.strictEqual(personalReceiptRow.deposit_account_name, 'Owner Personal Collection Account');
    const accountingReport = (await request('GET', `/accounting/reports?org_id=${org.id}&fy=2026-27`, undefined, token)).payload;
    const personalTrialBalance = accountingReport.trial_balance.find(row => row.account_id === personalLedger.id);
    assert.strictEqual(Number(personalTrialBalance.debit), 75);

    const accounts = (await request('GET', `/accounting/accounts?org_id=${org.id}`, undefined, token)).payload;
    const cash = accounts.find(account => account.system_key === 'cash');
    const expenseAccount = accounts.find(account => account.type === 'expense');
    const expense = (await request('POST', '/business/expenses', {
      org_id: org.id, expense_date: '2026-06-07', account_id: expenseAccount.id,
      payment_mode: 'cash', amount: 100, gst_amount: 0, narration: 'Test expense'
    }, token)).payload.expense;
    assert.ok((await request('POST', '/advanced/duplicate', {
      type: 'expense', id: expense.id, org_id: org.id, date: '2026-06-08'
    }, token)).payload.id);

    const journal = (await request('POST', '/accounting/journals', {
      org_id: org.id, entry_date: '2026-06-07', voucher_type: 'JOURNAL', narration: 'Test journal',
      lines: [
        { account_id: expenseAccount.id, debit: 25, credit: 0 },
        { account_id: cash.id, debit: 0, credit: 25 }
      ]
    }, token)).payload;
    const journalRows = (await request('GET', `/accounting/journals?org_id=${org.id}&fy=2026-27`, undefined, token)).payload;
    const journalEntry = journalRows.find(row => row.voucher_number === journal.voucher_number);
    const duplicateJournal = (await request('POST', '/advanced/duplicate', {
      type: 'journal', id: journalEntry.id, org_id: org.id, date: '2026-06-08'
    }, token)).payload;
    assert.ok(duplicateJournal.id);

    const purchaseToEdit = (await request('GET', `/business/purchases/${duplicatePurchase.id}`, undefined, token)).payload;
    const purchaseEdit = await request('PATCH', `/business/purchases/${duplicatePurchase.id}`, {
      org_id: org.id, purchase_date: purchaseToEdit.purchase_date, due_date: purchaseToEdit.due_date,
      party_id: purchaseToEdit.party_id, supplier_invoice: 'SUP-CORRECTED-1', payment_mode: 'credit',
      narration: 'Corrected purchase quantity', tax_inclusive: Boolean(purchaseToEdit.tax_inclusive),
      round_off_enabled: true, items: purchaseToEdit.items.map((row, index) => ({ ...row, qty: index ? row.qty : 3 })),
      reason: 'Corrected supplier purchase quantity'
    }, token);
    assert.strictEqual(purchaseEdit.payload.purchase.purchase_number, purchaseToEdit.purchase_number);
    assert.strictEqual(purchaseEdit.payload.purchase.supplier_invoice, 'SUP-CORRECTED-1');
    const operatorPurchaseEdit = await request('PATCH', `/business/purchases/${duplicatePurchase.id}`, {
      org_id: org.id, reason: 'Operator must not edit this purchase'
    }, operatorLogin.token, true);
    assert.strictEqual(operatorPurchaseEdit.response.status, 403);
    const purchaseDeleteWithoutReason = await request('DELETE', `/business/purchases/${duplicatePurchase.id}`, {}, token, true);
    assert.strictEqual(purchaseDeleteWithoutReason.response.status, 400);
    assert.strictEqual((await request('DELETE', `/business/purchases/${duplicatePurchase.id}`, {
      reason: 'Duplicate purchase entered during testing'
    }, token)).response.status, 200);

    const expenseEdit = await request('PATCH', `/business/expenses/${expense.id}`, {
      org_id: org.id, expense_date: expense.expense_date, party_id: null, account_id: expense.account_id,
      payment_mode: 'cash', amount: 125, gst_amount: 0, gst_rate: 0, tax_inclusive: false,
      round_off_enabled: true, reference: 'EXP-CORRECTED', narration: 'Corrected expense amount',
      reason: 'Corrected office expense amount'
    }, token);
    assert.strictEqual(expenseEdit.payload.expense.expense_number, expense.expense_number);
    assert.strictEqual(Number(expenseEdit.payload.expense.amount), 125);
    assert.strictEqual((await request('DELETE', `/business/expenses/${expense.id}`, {
      reason: 'Duplicate expense entered during testing'
    }, token)).response.status, 200);

    const noteToEdit = (await request('GET', `/business/notes/${duplicateNote.id}`, undefined, token)).payload;
    const noteEdit = await request('PATCH', `/business/notes/${duplicateNote.id}`, {
      org_id: org.id, note_date: noteToEdit.note_date, note_type: noteToEdit.note_type,
      party_id: noteToEdit.party_id, narration: 'Corrected return quantity',
      tax_inclusive: Boolean(noteToEdit.tax_inclusive), round_off_enabled: true,
      items: noteToEdit.items.map((row, index) => ({ ...row, qty: index ? row.qty : 2 })),
      reason: 'Corrected customer return quantity'
    }, token);
    assert.strictEqual(noteEdit.payload.note.note_number, noteToEdit.note_number);
    assert.strictEqual((await request('DELETE', `/business/notes/${duplicateNote.id}`, {
      reason: 'Duplicate return note entered during testing'
    }, token)).response.status, 200);

    const poToEdit = (await request('GET', `/advanced/purchase-orders/${duplicatePo.id}`, undefined, token)).payload;
    const poEdit = await request('PATCH', `/advanced/purchase-orders/${duplicatePo.id}`, {
      org_id: org.id, po_date: poToEdit.po_date, expected_date: '2026-06-20', party_id: poToEdit.party_id,
      narration: 'Corrected purchase order schedule', tax_inclusive: Boolean(poToEdit.tax_inclusive),
      round_off_enabled: true, items: poToEdit.items,
      reason: 'Corrected expected supplier delivery date'
    }, token);
    assert.strictEqual(poEdit.payload.purchase_order.po_number, poToEdit.po_number);
    assert.strictEqual(poEdit.payload.purchase_order.expected_date, '2026-06-20');
    assert.strictEqual((await request('DELETE', `/advanced/purchase-orders/${duplicatePo.id}`, {
      reason: 'Duplicate purchase order entered during testing'
    }, token)).response.status, 200);

    const journalToEdit = (await request('GET', `/accounting/journals/${duplicateJournal.id}`, undefined, token)).payload;
    const journalEdit = await request('PATCH', `/accounting/journals/${duplicateJournal.id}`, {
      org_id: org.id, entry_date: journalToEdit.entry_date, voucher_type: journalToEdit.voucher_type,
      narration: 'Corrected manual journal narration', lines: journalToEdit.lines,
      reason: 'Corrected manual journal narration'
    }, token);
    assert.strictEqual(journalEdit.payload.journal.voucher_number, journalToEdit.voucher_number);
    assert.strictEqual((await request('DELETE', `/accounting/journals/${duplicateJournal.id}`, {
      reason: 'Duplicate manual journal entered during testing'
    }, token)).response.status, 200);
    const transactionAudits = (await request('GET', `/advanced/audit-log?org_id=${org.id}`, undefined, token)).payload;
    assert.ok(transactionAudits.some(row => row.action === 'UPDATE_PURCHASE'));
    assert.ok(transactionAudits.some(row => row.action === 'DELETE_JOURNAL'));

    const catalog = (await request('GET', `/jobs/catalog?org_id=${org.id}`, undefined, token)).payload;
    const job = (await request('POST', '/jobs', {
      org_id: org.id,
      party_id: customer.id,
      priority: 'HIGH',
      promised_delivery_at: '2026-06-25T18:00:00.000Z',
      customer_commitment: 'Print and finish the urgent store sample.',
      items: [{
        service_id: catalog.services[0].id,
        description: 'Urgent store sample',
        specifications: { size: 'A4', finish: 'Gloss' },
        quantity: 1,
        unit: 'NOS'
      }],
      estimate_lines: [{
        description: 'Urgent store sample',
        quantity: 1,
        unit: 'NOS',
        unit_price: 250,
        tax_rate: 0,
        line_total: 250
      }]
    }, token)).payload;
    const assignment = (await request('POST', `/jobs/${job.id}/assign`, {
      employee_id: jobOperator.id,
      handoff_type: 'INITIAL_ASSIGNMENT',
      reason: 'Operator handling direct sample workflow'
    }, token)).payload;
    await request('POST', `/jobs/assignments/${assignment.id}/respond`, { decision: 'ACCEPT' }, operatorLogin.token);
    await request('POST', `/jobs/${job.id}/materials`, {
      item_id: item.id,
      quantity: 2,
      notes: 'Two packs consumed for the urgent sample.'
    }, operatorLogin.token);
    await request('POST', `/jobs/${job.id}/additions`, {
      reason: 'Customer requested gloss protective finishing'
    }, operatorLogin.token);
    const jobAfterAddition = (await request('GET', `/jobs/${job.id}`, undefined, token)).payload;
    const addition = jobAfterAddition.additions[0];
    await request('PUT', `/jobs/additions/${addition.id}/price`, {
      customer_description: 'Gloss protective finishing',
      quantity: 2,
      unit: 'NOS',
      unit_price: 40,
      tax_rate: 0
    }, token);
    await request('POST', `/jobs/additions/${addition.id}/approval`, {
      decision: 'APPROVED',
      method: 'VERBAL_RECORDED',
      approver_name: 'POS Customer',
      evidence_text: 'Approved during counter confirmation'
    }, token);
    for (const status of ['IN_PROGRESS', 'QUALITY_CHECK', 'COMPLETED', 'READY_FOR_DELIVERY']) {
      await request('POST', `/jobs/${job.id}/status`, { status, reason: `Move to ${status}` }, operatorLogin.token);
    }
    const deliveredJob = (await request('POST', `/jobs/${job.id}/deliver`, {
      receiver_name: 'POS Customer',
      acknowledgement_method: 'OTP',
      service_notes: 'Urgent sample completed and handed over.',
      warranty_notes: 'No warranty',
      payments: [{ mode: 'cash', amount: 330 }]
    }, token)).payload;
    assert.ok(deliveredJob.bill_id);

    const profit = (await request('GET', `/advanced/profitability?org_id=${org.id}&fy=2026-27`, undefined, token)).payload;
    assert.strictEqual(profit.invoices.length, 7);
    assert.strictEqual(profit.totals.cost, 240);
    assert.strictEqual(profit.jobs.length, 1);
    assert.strictEqual(profit.job_totals.projected_revenue, 330);
    assert.strictEqual(profit.job_totals.material_cost, 120);
    assert.strictEqual(profit.job_totals.projected_margin, 210);
    assert.strictEqual(profit.job_totals.final_revenue, 330);
    assert.strictEqual(profit.job_totals.final_margin, 210);
    assert.strictEqual(profit.jobs[0].job_token, job.token);
    assert.strictEqual(profit.jobs[0].final_bill_number, deliveredJob.bill_number);

    const qr = await fetch(`http://127.0.0.1:${port}/api/advanced/invoice-qr/${sale.id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(qr.status, 200);
    assert.strictEqual(qr.headers.get('content-type'), 'image/png');

    await request('POST', '/advanced/presence', {
      org_id: org.id, client_id: 'test-client', client_name: 'Test Computer', page: 'pos'
    }, token);
    const network = (await request('GET', '/advanced/network-status', undefined, token)).payload;
    assert.strictEqual(network.connected_clients, 1);

    const bankPayload = {
      org_id: org.id, file_name: 'bank.xlsx', file_hash: 'test-file-hash',
      mapping: { transaction_date: 'Date', debit: 'Withdrawal', credit: 'Deposit' },
      rows: [{ transaction_date: '2026-06-07', description: 'Test', debit: 10, credit: 0, balance: 90 }]
    };
    assert.strictEqual((await request('POST', '/business/bank-statements/import', bankPayload, token)).payload.imported, 1);
    const duplicateBank = await request('POST', '/business/bank-statements/import', bankPayload, token, true);
    assert.strictEqual(duplicateBank.response.status, 409);

    const schedule = (await request('POST', '/advanced/report-schedules', {
      org_id: org.id, recipient_email: 'owner@example.com', day_of_month: 1, output_directory: reportDir
    }, token)).payload;
    const report = (await request('POST', `/advanced/report-schedules/${schedule.id}/run`, {}, token)).payload;
    assert.ok(fs.existsSync(report.file));
    assert.strictEqual(report.emailed, false);

    const integrity = (await request('GET', '/advanced/integrity', undefined, token)).payload;
    assert.strictEqual(integrity.checks.database, 'ok');

    const creditBill = (await request('POST', '/bills', {
      org_id: org.id, format: 'SALE', bill_date: '2026-06-07', party_id: customer.id,
      payment_mode: 'credit', items: [{ item_name: 'Correction Test Service', qty: 1,
        unit: 'NOS', rate: 100, amount: 100, gst_rate: 0 }]
    }, token)).payload.bill;
    const excessReceipt = (await request('POST', '/payments', {
      org_id: org.id, payment_date: '2026-06-07', party_id: customer.id,
      type: 'received', mode: 'cash', amount: 150,
      linked_bills: [{ bill_id: creditBill.id, amount: 150 }], narration: 'Excess receipt correction test'
    }, token)).payload;
    assert.strictEqual(Number(excessReceipt.unallocated_amount), 32);
    const correctedReceipt = await request('PATCH', `/payments/${excessReceipt.id}`, {
      amount: 120, mode: 'cash', payment_date: '2026-06-07',
      narration: 'Corrected excess receipt', reason: 'Corrected amount after cash counter verification'
    }, token);
    assert.strictEqual(correctedReceipt.response.status, 200);
    assert.strictEqual(correctedReceipt.payload.payment.payment_number, excessReceipt.payment_number);
    assert.strictEqual(Number(correctedReceipt.payload.unallocated_amount), 2);
    assert.strictEqual(correctedReceipt.payload.payment.party_name, 'POS Customer');
    const operatorCorrection = await request('PATCH', `/payments/${excessReceipt.id}`, {
      amount: 121, reason: 'Operator must not edit vouchers'
    }, operatorLogin.token, true);
    assert.strictEqual(operatorCorrection.response.status, 403);

    const savedPaymentVoucher = (await request('POST', '/payments', {
      org_id: org.id, payment_date: '2026-06-07', party_id: supplier.id,
      type: 'paid', mode: 'cash', amount: 75, narration: 'Saved vendor payment voucher'
    }, token)).payload;
    const correctedPaymentVoucher = await request('PATCH', `/payments/${savedPaymentVoucher.id}`, {
      payment_date: '2026-06-08', amount: 80, mode: 'account', reference: 'PV-CORRECTION-001',
      narration: 'Corrected saved vendor payment voucher',
      reason: 'Corrected payment voucher after vendor confirmation'
    }, token);
    assert.strictEqual(correctedPaymentVoucher.response.status, 200);
    assert.strictEqual(correctedPaymentVoucher.payload.payment.payment_number, savedPaymentVoucher.payment_number);
    assert.strictEqual(Number(correctedPaymentVoucher.payload.payment.amount), 80);
    assert.strictEqual(correctedPaymentVoucher.payload.payment.type, 'paid');
    assert.strictEqual(correctedPaymentVoucher.payload.payment.reference, 'PV-CORRECTION-001');
    assert.strictEqual(correctedPaymentVoucher.payload.payment.party_name, 'Paper Supplier');

    const reversedReceipt = await request('POST', `/payments/${excessReceipt.id}/reverse`, {
      reversal_date: '2026-06-09', reason: 'Owner confirmed this receipt voucher must be deleted'
    }, token);
    assert.strictEqual(reversedReceipt.response.status, 200);
    const activeReceipts = (await request('GET', `/payments?org_id=${org.id}&type=received`, undefined, token)).payload;
    assert.ok(!activeReceipts.some(row => Number(row.id) === Number(excessReceipt.id)));

    // A legacy receipt can have no posted source journal. It must still be
    // deletable: the API rebuilds the source, creates its reversal, and hides it.
    const legacyReceipt = (await request('POST', '/payments', {
      org_id: org.id, payment_date: '2026-06-09', party_id: customer.id,
      type: 'received', mode: 'cash', amount: 45, narration: 'Legacy receipt recovery test'
    }, token)).payload;
    const repairDb = new DatabaseSync(path.join(dataDir, 'tarangini.db'));
    const legacySource = repairDb.prepare(
      'SELECT id FROM journal_entries WHERE org_id=? AND source_type=? AND source_id=?'
    ).get(org.id, 'payment', legacyReceipt.id);
    assert.ok(legacySource, 'Test receipt source journal must exist before simulating a legacy record');
    repairDb.prepare('DELETE FROM journal_lines WHERE entry_id=?').run(legacySource.id);
    repairDb.prepare('DELETE FROM journal_entries WHERE id=?').run(legacySource.id);
    repairDb.close();
    const reversedLegacyReceipt = await request('POST', `/payments/${legacyReceipt.id}/reverse`, {
      reversal_date: '2026-06-09', reason: 'Delete legacy receipt without original journal entry'
    }, token);
    assert.strictEqual(reversedLegacyReceipt.response.status, 200);
    const activeAfterLegacyDelete = (await request('GET', `/payments?org_id=${org.id}&type=received`, undefined, token)).payload;
    assert.ok(!activeAfterLegacyDelete.some(row => Number(row.id) === Number(legacyReceipt.id)));

    const encrypted = await fetch(`http://127.0.0.1:${port}/api/advanced/encrypted-backup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'strong-test-password' })
    });
    assert.strictEqual(encrypted.status, 200);
    const encryptedBytes = Buffer.from(await encrypted.arrayBuffer());
    assert.strictEqual(encryptedBytes.subarray(0, 13).toString(), 'TARANGINIENC1');

    const closed = (await request('PUT', `/advanced/shifts/${shift.id}/close`, {
      counted_cash: 559
    }, token)).payload;
    assert.strictEqual(typeof closed.variance, 'number');
    const closedShiftPayment = await request('POST', '/payments', {
      org_id: org.id,
      payment_date: '2026-06-07',
      type: 'received',
      mode: 'cash',
      amount: 10,
      shift_id: shift.id
    }, token, true);
    assert.strictEqual(closedShiftPayment.response.status, 423);

    const multiYearParty = (await request('POST', '/parties', {
      org_id: org.id, type: 'customer', name: 'Multi Year Statement Customer'
    }, token)).payload;
    const oldYearBill = (await request('POST', '/bills', {
      org_id: org.id, format: 'SALE', bill_date: '2025-05-02', party_id: multiYearParty.id,
      payment_mode: 'credit', items: [{ item_name: 'Prior Year Service', qty: 1, unit: 'NOS', rate: 100, amount: 100, gst_rate: 0 }]
    }, token)).payload.bill;
    await request('POST', '/payments', {
      org_id: org.id, payment_date: '2025-05-03', party_id: multiYearParty.id,
      type: 'received', mode: 'cash', amount: oldYearBill.grand_total,
      linked_bills: [{ bill_id: oldYearBill.id, amount: oldYearBill.grand_total }]
    }, token);
    const currentYearBill = (await request('POST', '/bills', {
      org_id: org.id, format: 'SALE', bill_date: '2026-05-02', party_id: multiYearParty.id,
      payment_mode: 'credit', items: [{ item_name: 'Current Year Service', qty: 1, unit: 'NOS', rate: 200, amount: 200, gst_rate: 0 }]
    }, token)).payload.bill;
    await request('POST', '/payments', {
      org_id: org.id, payment_date: '2026-05-03', party_id: multiYearParty.id,
      type: 'received', mode: 'cash', amount: currentYearBill.grand_total,
      linked_bills: [{ bill_id: currentYearBill.id, amount: currentYearBill.grand_total }]
    }, token);
    const currentYearStatement = (await request('GET',
      `/reports/party-statement?party_id=${multiYearParty.id}&org_id=${org.id}&fy=2026-27`, undefined, token)).payload;
    assert.strictEqual(currentYearStatement.entries.length, 2);
    assert.strictEqual(Number(currentYearStatement.opening_balance), 0);
    assert.strictEqual(Number(currentYearStatement.closing_balance), 0);

    const creditPolicyCustomer = (await request('POST', '/parties', {
      org_id: org.id, type: 'customer', name: 'Credit Policy Customer', phone: '9888888888'
    }, token)).payload;
    const savedCreditPolicy = await request('PUT', `/reports/credit-policies/${creditPolicyCustomer.id}`, {
      org_id: org.id, credit_limit: 150, credit_days: 30, on_hold: false, hold_reason: ''
    }, token);
    assert.strictEqual(savedCreditPolicy.response.status, 200);
    const firstCreditPolicyBill = (await request('POST', '/bills', {
      org_id: org.id, format: 'SALE', bill_date: '2026-06-10', party_id: creditPolicyCustomer.id,
      payment_mode: 'credit', items: [{ item_name: 'Credit Policy Service', qty: 1, unit: 'NOS', rate: 100, amount: 100, gst_rate: 18 }]
    }, token)).payload.bill;
    assert.strictEqual(firstCreditPolicyBill.due_date, '2026-07-10');
    const limitedCreditSale = await request('POST', '/bills', {
      org_id: org.id, format: 'SALE', bill_date: '2026-06-10', party_id: creditPolicyCustomer.id,
      payment_mode: 'credit', items: [{ item_name: 'Credit Limit Block Test', qty: 1, unit: 'NOS', rate: 50, amount: 50, gst_rate: 18 }]
    }, token, true);
    assert.strictEqual(limitedCreditSale.response.status, 423);
    assert.strictEqual(limitedCreditSale.payload.code, 'CREDIT_LIMIT_EXCEEDED');
    const collections = (await request('GET', `/reports/collections?org_id=${org.id}`, undefined, token)).payload;
    const collectionRow = collections.rows.find(row => Number(row.bill_id) === Number(firstCreditPolicyBill.id));
    assert.ok(collectionRow);
    assert.ok(['Current', '1-30 days', '31-60 days', '61-90 days', '90+ days'].includes(collectionRow.age_bucket));
    const collectionFollowUp = await request('POST', '/reports/collections/followups', {
      org_id: org.id, party_id: creditPolicyCustomer.id, bill_id: firstCreditPolicyBill.id,
      follow_up_date: '2026-06-11', next_follow_up_date: '2026-06-15', outcome: 'PROMISE_TO_PAY',
      promised_amount: 118, promise_date: '2026-06-15', notes: 'Customer confirmed payment on Friday.'
    }, token);
    assert.strictEqual(collectionFollowUp.response.status, 200);
    const collectionHistory = (await request('GET', `/reports/collections/followups?org_id=${org.id}&party_id=${creditPolicyCustomer.id}&bill_id=${firstCreditPolicyBill.id}`, undefined, token)).payload;
    assert.strictEqual(collectionHistory.length, 1);
    assert.strictEqual(collectionHistory[0].outcome, 'PROMISE_TO_PAY');
    const reportCatalog = (await request('GET', `/reports/catalog?org_id=${org.id}`, undefined, token)).payload;
    assert.ok(reportCatalog.reports.some(row => row.id === 'receivables_ageing'));
    const salesCsv = await request('GET', `/reports/export/sales_register?org_id=${org.id}&fy=2026-27`, undefined, token);
    assert.ok(String(salesCsv.payload).includes(firstCreditPolicyBill.bill_number));
    assert.match(String(salesCsv.response.headers.get('content-type')), /text\/csv/);
    const salesPrintView = await request('GET', `/reports/print/sales_register?org_id=${org.id}&fy=2026-27`, undefined, token);
    assert.ok(String(salesPrintView.payload).includes(firstCreditPolicyBill.bill_number));
    assert.match(String(salesPrintView.response.headers.get('content-type')), /text\/html/);
    const ageingCsv = await request('GET', `/reports/export/receivables_ageing?org_id=${org.id}&fy=2026-27`, undefined, token);
    assert.ok(String(ageingCsv.payload).includes('Credit Policy Customer'));
    const blockedCreditPolicyEdit = await request('PUT', `/reports/credit-policies/${creditPolicyCustomer.id}`, {
      org_id: org.id, credit_limit: 0, credit_days: 0
    }, operatorLogin.token, true);
    assert.strictEqual(blockedCreditPolicyEdit.response.status, 403);

    const stockCount = (await request('POST', '/business/stock-counts', {
      org_id: org.id, count_date: '2026-06-10', notes: 'Quarterly physical stock-count test'
    }, token)).payload.stock_count;
    assert.ok(stockCount.lines.length > 0);
    const targetStockLine = stockCount.lines.find(line => Number(line.item_id) === Number(item.id));
    assert.ok(targetStockLine);
    const countedLines = stockCount.lines.map(line => ({
      id: line.id,
      counted_qty: Number(line.id) === Number(targetStockLine.id)
        ? Math.max(0, Number(line.system_qty || 0) + 2)
        : Math.max(0, Number(line.system_qty || 0)),
      notes: Number(line.id) === Number(targetStockLine.id) ? 'Physical count found two extra packs' : ''
    }));
    const savedStockCount = await request('PUT', `/business/stock-counts/${stockCount.id}/lines`, {
      org_id: org.id, lines: countedLines
    }, token);
    assert.strictEqual(savedStockCount.payload.stock_count.summary.counted_lines, stockCount.lines.length);
    assert.strictEqual((await request('POST', `/business/stock-counts/${stockCount.id}/submit`, { org_id: org.id }, token)).payload.stock_count.status, 'SUBMITTED');
    const blockedStockCountApproval = await request('POST', `/business/stock-counts/${stockCount.id}/approve`, {
      org_id: org.id, reason: 'Operator should not approve stock adjustments'
    }, operatorLogin.token, true);
    assert.strictEqual(blockedStockCountApproval.response.status, 403);
    const approvedStockCount = await request('POST', `/business/stock-counts/${stockCount.id}/approve`, {
      org_id: org.id, reason: 'Owner approved the documented physical stock-count variance'
    }, token);
    assert.strictEqual(approvedStockCount.payload.stock_count.status, 'APPROVED');
    assert.strictEqual(approvedStockCount.payload.stock_count.summary.variance_lines > 0, true);
    const stockMovementAfterCount = (await request('GET', `/business/stock/${item.id}/movements?org_id=${org.id}`, undefined, token)).payload;
    assert.ok(stockMovementAfterCount.some(row => row.source_type === 'stock_count' && Number(row.source_id) === Number(stockCount.id)));

    const staleCount = (await request('POST', '/business/stock-counts', {
      org_id: org.id, count_date: '2026-06-11', notes: 'Stale stock-count protection test'
    }, token)).payload.stock_count;
    await request('PUT', `/business/stock-counts/${staleCount.id}/lines`, {
      org_id: org.id, lines: staleCount.lines.map(line => ({ id: line.id, counted_qty: Math.max(0, Number(line.system_qty || 0)) }))
    }, token);
    await request('POST', `/business/stock-counts/${staleCount.id}/submit`, { org_id: org.id }, token);
    await request('POST', '/bills', {
      org_id: org.id, format: 'SALE', bill_date: '2026-06-11', party_id: customer.id,
      payment_mode: 'cash', items: [{ item_id: item.id, item_name: 'A4 Paper Pack', qty: 1, unit: 'PKT', rate: 100, amount: 100, gst_rate: 18 }]
    }, token);
    const staleApproval = await request('POST', `/business/stock-counts/${staleCount.id}/approve`, {
      org_id: org.id, reason: 'Owner attempted approval after a sale was posted'
    }, token, true);
    assert.strictEqual(staleApproval.response.status, 409);
    assert.strictEqual(staleApproval.payload.code, 'STOCK_COUNT_STALE');

    const stockReconciliation = (await request('GET',
      `/business/stock/reconciliation?org_id=${org.id}`, undefined, token)).payload;
    assert.strictEqual(stockReconciliation.org_id, org.id);
    assert.ok(Array.isArray(stockReconciliation.by_source));
    assert.ok(stockReconciliation.summary.movement_count > 0);

    const attention = (await request('GET', `/reports/attention?org_id=${org.id}`, undefined, token)).payload;
    assert.strictEqual(typeof attention.summary.backup_attention, 'boolean');
    assert.ok(Array.isArray(attention.overdue_invoices));
    assert.ok(Array.isArray(attention.low_stock));

    await request('PUT', '/business/locks/2025-26', { org_id: org.id, locked: true }, token);
    const blockedRepair = await request('POST', '/advanced/integrity/repair', {}, token, true);
    assert.strictEqual(blockedRepair.response.status, 423);
    const recoveredRepair = await request('POST', '/advanced/integrity/repair', {
      closed_year_recovery: true,
      recovery_reason: 'Rebuild accounting after controlled owner review of a test protected financial year.'
    }, token);
    assert.strictEqual(recoveredRepair.payload.closed_year_recovery, true);
    const stockMovementAfterRepair = (await request('GET', `/business/stock/${item.id}/movements?org_id=${org.id}`, undefined, token)).payload;
    assert.ok(stockMovementAfterRepair.some(row => row.source_type === 'stock_count' && Number(row.source_id) === Number(stockCount.id)));
    const repairAudit = new DatabaseSync(path.join(dataDir, 'tarangini.db'));
    const repairAuditRow = repairAudit.prepare(
      "SELECT action FROM audit_log WHERE action='INTEGRITY_REPAIR_CLOSED_YEAR_RECOVERY' ORDER BY id DESC LIMIT 1"
    ).get();
    repairAudit.close();
    assert.ok(repairAuditRow);

    console.log('Advanced upgrade integration tests passed');
  } finally {
    server.kill();
    setTimeout(() => fs.rmSync(dataDir, { recursive: true, force: true }), 200);
  }
})().catch(error => {
  console.error(error);
  console.error(output);
  process.exitCode = 1;
});
