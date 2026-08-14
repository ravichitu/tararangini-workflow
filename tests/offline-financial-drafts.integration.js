const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.offline-financial-drafts-test');
const port = 3231;
process.env.TARANGINI_DATA_DIR = dataDir;
const dbApi = require('../src/db/db');
fs.rmSync(dataDir, { recursive: true, force: true });

let server;
let output = '';
async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start: ${output}`);
}

async function request(method, route, body, token) {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = {};
  try { payload = await response.json(); } catch (_) {}
  return { response, payload };
}

(async () => {
  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: root, env: { ...process.env, PORT: String(port), TARANGINI_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => { output += chunk; });
    server.stderr.on('data', chunk => { output += chunk; });
    await waitForServer();
    await dbApi.initDB();

    const owner = (await request('POST', '/auth/login', { username: 'owner1', password: 'owner123' })).payload;
    const operator = (await request('POST', '/auth/login', { username: 'operator1', password: 'operator123' })).payload;
    const org = (await request('POST', '/orgs', {
      display_name: 'Offline Financial Draft Test', negative_stock_allowed: false
    }, owner.token)).payload;
    const unregisteredDraft = await request('POST', '/advanced/offline-financial-drafts', {
      org_id: org.id, draft_id: 'UNREGISTERED-001', device_id: 'DEV-UNKNOWN-001',
      entity_type: 'PAYMENT_RECEIVED', payload: { amount: 10 }
    }, owner.token);
    assert.strictEqual(unregisteredDraft.response.status, 403);
    assert.strictEqual(unregisteredDraft.payload.code, 'DEVICE_NOT_REGISTERED');
    const deviceRegistration = await request('POST', '/advanced/registered-devices', {
      org_id: org.id, device_id: 'DEV-OFFLINE-001', device_name: 'Offline Finance Test Device'
    }, owner.token);
    assert.strictEqual(deviceRegistration.response.status, 201);
    dbApi.run(`INSERT INTO sync_conflicts
      (change_id,org_id,entity_type,entity_id,main_snapshot,incoming_snapshot,status)
      VALUES (?,?,?,?,?,?,?)`,
    ['CHANGE-CONFLICT-001', org.id, 'BILL', 'BILL-001',
      JSON.stringify({ total: 100, status: 'saved' }), JSON.stringify({ total: 120, status: 'edited' }), 'pending']);
    const conflicts = await request('GET', `/advanced/sync-conflicts?org_id=${org.id}`, undefined, owner.token);
    assert.strictEqual(conflicts.response.status, 200);
    assert.strictEqual(conflicts.payload.length, 1);
    assert.strictEqual((await request('GET', `/advanced/sync-conflicts?org_id=${org.id}`, undefined, operator.token)).response.status, 403);
    const resolvedConflict = await request('POST', `/advanced/sync-conflicts/${conflicts.payload[0].id}/resolve`, {
      decision: 'MARK_FOR_REPLAY', reason: 'Incoming record requires controlled replay'
    }, owner.token);
    assert.strictEqual(resolvedConflict.response.status, 200);
    assert.strictEqual(resolvedConflict.payload.conflict.status, 'queued_for_replay');
    assert.strictEqual(resolvedConflict.payload.applied, false);
    const replayed = await request('POST', `/advanced/sync-conflicts/${conflicts.payload[0].id}/complete-replay`, {
      replay_reference: 'BILL-REPLAY-001', reason: 'Owner confirmed controlled replay completed'
    }, owner.token);
    assert.strictEqual(replayed.response.status, 200);
    assert.strictEqual(replayed.payload.conflict.status, 'replayed');
    assert.strictEqual(replayed.payload.applied, false);
    dbApi.run(`INSERT INTO sync_conflicts
      (change_id,org_id,entity_type,entity_id,main_snapshot,incoming_snapshot,status)
      VALUES (?,?,?,?,?,?,?)`,
    ['CHANGE-CONFLICT-MERGE-001', org.id, 'JOB', 'JOB-001',
      JSON.stringify({ title: 'Main job title', priority: 'normal', notes: 'Main note' }),
      JSON.stringify({ title: 'Incoming job title', priority: 'high', notes: 'Incoming note' }), 'pending']);
    const mergeConflict = (await request('GET', `/advanced/sync-conflicts?org_id=${org.id}&status=pending`, undefined, owner.token)).payload
      .find(row => row.change_id === 'CHANGE-CONFLICT-MERGE-001');
    const mergedConflict = await request('POST', `/advanced/sync-conflicts/${mergeConflict.id}/resolve`, {
      decision: 'MANUAL_MERGE',
      reason: 'Owner selected the incoming priority and retained the main job title',
      merged_snapshot: { title: 'Main job title', priority: 'high', notes: 'Incoming note' }
    }, owner.token);
    assert.strictEqual(mergedConflict.response.status, 200);
    assert.strictEqual(mergedConflict.payload.conflict.status, 'queued_for_replay');
    assert.deepStrictEqual(mergedConflict.payload.conflict.merged_snapshot,
      { title: 'Main job title', priority: 'high', notes: 'Incoming note' });
    const invalidMerge = await request('POST', `/advanced/sync-conflicts/${mergeConflict.id}/resolve`, {
      decision: 'MANUAL_MERGE', reason: 'This must not overwrite the queued merge', merged_snapshot: []
    }, owner.token);
    assert.strictEqual(invalidMerge.response.status, 400);
    const lock = await request('PUT', '/business/locks/2025-26', { org_id: org.id, locked: true }, owner.token);
    assert.strictEqual(lock.response.status, 200);
    const payment = await request('POST', '/payments', {
      org_id: org.id, payment_date: '2026-06-08', type: 'received', mode: 'cash', amount: 25,
      reference: 'DUPLICATE-OFFLINE-REF', narration: 'Existing receipt for duplicate guard'
    }, owner.token);
    assert.strictEqual(payment.response.status, 200);
    const draft = {
      org_id: org.id,
      draft_id: 'OFFLINE-DRAFT-001',
      device_id: 'DEV-OFFLINE-001',
      entity_type: 'PAYMENT_RECEIVED',
      provisional_number: 'OFF-PAY-001',
      base_version: 3,
      payload: { amount: 500, mode: 'CASH', party_id: null, note: 'Take-home receipt awaiting review' }
    };

    const submitted = await request('POST', '/advanced/offline-financial-drafts', draft, owner.token);
    assert.strictEqual(submitted.response.status, 201);
    assert.strictEqual(submitted.payload.draft.state, 'SUBMITTED');

    const duplicate = await request('POST', '/advanced/offline-financial-drafts', draft, owner.token);
    assert.strictEqual(duplicate.response.status, 200);
    assert.strictEqual(duplicate.payload.idempotent, true);
    assert.strictEqual(duplicate.payload.draft.id, submitted.payload.draft.id);

    const conflicting = await request('POST', '/advanced/offline-financial-drafts', {
      ...draft, payload: { ...draft.payload, amount: 900 }
    }, owner.token);
    assert.strictEqual(conflicting.response.status, 409);

    const operatorList = await request('GET', `/advanced/offline-financial-drafts?org_id=${org.id}`, undefined, operator.token);
    assert.strictEqual(operatorList.response.status, 403);

    const reviewed = await request('POST', `/advanced/offline-financial-drafts/${submitted.payload.draft.id}/review`, {
      decision: 'APPROVE', reason: 'Verified device record and receipt details'
    }, owner.token);
    assert.strictEqual(reviewed.response.status, 200);
    assert.strictEqual(reviewed.payload.draft.state, 'APPROVED');
    assert.strictEqual(reviewed.payload.ledger_posted, false);
    assert.strictEqual(reviewed.payload.draft.posted_entity_id, null);
    const posted = await request('POST', `/advanced/offline-financial-drafts/${submitted.payload.draft.id}/post`, {}, owner.token);
    assert.strictEqual(posted.response.status, 200);
    assert.strictEqual(posted.payload.idempotent, false);
    assert.match(posted.payload.payment_number, /\/PR\/2026-27\//);
    assert.strictEqual(posted.payload.draft.state, 'POSTED');
    const postedAgain = await request('POST', `/advanced/offline-financial-drafts/${submitted.payload.draft.id}/post`, {}, owner.token);
    assert.strictEqual(postedAgain.response.status, 200);
    assert.strictEqual(postedAgain.payload.idempotent, true);

    const paymentVoucherDraft = await request('POST', '/advanced/offline-financial-drafts', {
      ...draft, draft_id: 'OFFLINE-PAYMENT-VOUCHER-001', entity_type: 'PAYMENT_VOUCHER',
      provisional_number: 'OFF-PV-001', payload: {
        amount: 275, mode: 'account', reference: 'OFFLINE-PV-REF-001',
        payment_date: '2026-06-08', narration: 'Offline supplier payment awaiting owner review'
      }
    }, owner.token);
    assert.strictEqual(paymentVoucherDraft.response.status, 201);
    const approvedVoucher = await request('POST', `/advanced/offline-financial-drafts/${paymentVoucherDraft.payload.draft.id}/review`, {
      decision: 'APPROVE', reason: 'Verified offline supplier payment voucher details'
    }, owner.token);
    assert.strictEqual(approvedVoucher.response.status, 200);
    const postedVoucher = await request('POST', `/advanced/offline-financial-drafts/${paymentVoucherDraft.payload.draft.id}/post`, {}, owner.token);
    assert.strictEqual(postedVoucher.response.status, 200);
    assert.match(postedVoucher.payload.payment_number, /\/PV\/2026-27\//);
    assert.strictEqual(postedVoucher.payload.draft.state, 'POSTED');

    const saleItem = (await request('POST', '/items', {
      org_id: org.id, name: 'Controlled Offline Sale Item', hsn_code: '84716040', opening_stock: 10,
      gst_rate: 18, last_sale_price: 100, last_purchase_price: 60
    }, owner.token)).payload;
    const saleDraft = await request('POST', '/advanced/offline-financial-drafts', {
      ...draft, draft_id: 'OFFLINE-SALE-001', entity_type: 'SALE', provisional_number: 'LOCAL-SALE-001',
      payload: {
        bill_date: '2026-06-08', payment_mode: 'cash', tax_inclusive: false,
        items: [{ item_id: saleItem.id, item_name: 'Controlled Offline Sale Item', qty: 2, rate: 100, gst_rate: 18 }],
        narration: 'Controlled offline sale awaiting owner approval'
      }
    }, owner.token);
    assert.strictEqual(saleDraft.response.status, 201);
    const approvedSale = await request('POST', `/advanced/offline-financial-drafts/${saleDraft.payload.draft.id}/review`, {
      decision: 'APPROVE', reason: 'Verified offline sale item stock and customer details'
    }, owner.token);
    assert.strictEqual(approvedSale.response.status, 200);
    const postedSale = await request('POST', `/advanced/offline-financial-drafts/${saleDraft.payload.draft.id}/post`, {}, owner.token);
    assert.strictEqual(postedSale.response.status, 200);
    assert.strictEqual(postedSale.payload.entity_type, 'SALE');
    assert.match(postedSale.payload.bill_number, /\/26\/\d{4}$/);
    assert.strictEqual(postedSale.payload.draft.state, 'POSTED');
    const postedSaleAgain = await request('POST', `/advanced/offline-financial-drafts/${saleDraft.payload.draft.id}/post`, {}, owner.token);
    assert.strictEqual(postedSaleAgain.response.status, 200);
    assert.strictEqual(postedSaleAgain.payload.idempotent, true);
    assert.strictEqual(postedSaleAgain.payload.bill_number, postedSale.payload.bill_number);
    const saleStock = (await request('GET', `/business/stock?org_id=${org.id}`, undefined, owner.token)).payload;
    assert.strictEqual(Number(saleStock.items.find(row => Number(row.id) === Number(saleItem.id)).current_stock), 8);

    const supplier = (await request('POST', '/parties', {
      org_id: org.id, type: 'supplier', name: 'Controlled Offline Supplier'
    }, owner.token)).payload;
    const purchaseDraft = await request('POST', '/advanced/offline-financial-drafts', {
      ...draft, draft_id: 'OFFLINE-PURCHASE-001', entity_type: 'PURCHASE', provisional_number: 'LOCAL-PUR-001',
      payload: {
        purchase_date: '2026-06-08', party_id: supplier.id, supplier_invoice: 'SUP-OFFLINE-001',
        payment_mode: 'credit', tax_inclusive: false,
        items: [{ item_id: saleItem.id, item_name: 'Controlled Offline Sale Item', qty: 3, rate: 50, gst_rate: 18 }],
        narration: 'Controlled offline purchase awaiting owner approval'
      }
    }, owner.token);
    assert.strictEqual(purchaseDraft.response.status, 201);
    assert.strictEqual((await request('POST', `/advanced/offline-financial-drafts/${purchaseDraft.payload.draft.id}/review`, {
      decision: 'APPROVE', reason: 'Verified supplier invoice and received item quantity'
    }, owner.token)).response.status, 200);
    const postedPurchase = await request('POST', `/advanced/offline-financial-drafts/${purchaseDraft.payload.draft.id}/post`, {}, owner.token);
    assert.strictEqual(postedPurchase.response.status, 200);
    assert.strictEqual(postedPurchase.payload.entity_type, 'PURCHASE');
    assert.match(postedPurchase.payload.purchase_number, /\/PUR\/2026-27\//);
    const postedPurchaseAgain = await request('POST', `/advanced/offline-financial-drafts/${purchaseDraft.payload.draft.id}/post`, {}, owner.token);
    assert.strictEqual(postedPurchaseAgain.payload.idempotent, true);
    assert.strictEqual(postedPurchaseAgain.payload.purchase_number, postedPurchase.payload.purchase_number);
    const purchasedStock = (await request('GET', `/business/stock?org_id=${org.id}`, undefined, owner.token)).payload;
    assert.strictEqual(Number(purchasedStock.items.find(row => Number(row.id) === Number(saleItem.id)).current_stock), 11);

    const secondReview = await request('POST', `/advanced/offline-financial-drafts/${submitted.payload.draft.id}/review`, {
      decision: 'REJECT', reason: 'This state is already final for review'
    }, owner.token);
    assert.strictEqual(secondReview.response.status, 409);

    const listed = await request('GET', `/advanced/offline-financial-drafts?org_id=${org.id}&state=APPROVED`, undefined, owner.token);
    assert.strictEqual(listed.response.status, 200);
    assert.strictEqual(listed.payload.length, 0);

    const lockedDraft = await request('POST', '/advanced/offline-financial-drafts', {
      ...draft, draft_id: 'OFFLINE-DRAFT-LOCKED', provisional_number: 'OFF-PAY-LOCKED',
      payload: { ...draft.payload, payment_date: '2025-04-15' }
    }, owner.token);
    assert.strictEqual(lockedDraft.response.status, 201);
    const blocked = await request('POST', `/advanced/offline-financial-drafts/${lockedDraft.payload.draft.id}/review`, {
      decision: 'APPROVE', reason: 'Attempt approval against closed financial year'
    }, owner.token);
    assert.strictEqual(blocked.response.status, 422);
    assert.ok(blocked.payload.problems.some(problem => problem.includes('locked')));
    const unlocked = await request('PUT', '/business/locks/2025-26', { org_id: org.id, locked: false }, owner.token);
    assert.strictEqual(unlocked.response.status, 200);
    const recoveredApproval = await request('POST', `/advanced/offline-financial-drafts/${lockedDraft.payload.draft.id}/review`, {
      decision: 'APPROVE', reason: 'Financial year reopened and draft reviewed again'
    }, owner.token);
    assert.strictEqual(recoveredApproval.response.status, 200);
    assert.strictEqual(recoveredApproval.payload.draft.state, 'APPROVED');

    const duplicateReference = await request('POST', '/advanced/offline-financial-drafts', {
      ...draft, draft_id: 'OFFLINE-DRAFT-DUP-REF', provisional_number: 'OFF-PAY-DUP-REF',
      payload: { ...draft.payload, reference: 'DUPLICATE-OFFLINE-REF' }
    }, owner.token);
    assert.strictEqual(duplicateReference.response.status, 201);
    const duplicateBlocked = await request('POST', `/advanced/offline-financial-drafts/${duplicateReference.payload.draft.id}/review`, {
      decision: 'APPROVE', reason: 'Duplicate payment reference must remain blocked'
    }, owner.token);
    assert.strictEqual(duplicateBlocked.response.status, 422);
    assert.ok(duplicateBlocked.payload.problems.some(problem => problem.includes('already exists')));
    const reversed = await request('POST', `/payments/${payment.payload.id}/reverse`, {
      reversal_date: '2026-06-09', reason: 'Owner confirmed this receipt must be reversed'
    }, owner.token);
    assert.strictEqual(reversed.response.status, 200);
    assert.strictEqual(reversed.payload.original_payment_number, payment.payload.payment_number);
    assert.match(reversed.payload.reversal_number, /^REV-/);
    assert.strictEqual((await request('POST', `/payments/${payment.payload.id}/reverse`, {
      reversal_date: '2026-06-09', reason: 'Duplicate reversal must be blocked'
    }, owner.token)).response.status, 404);

    const item = (await request('POST', '/items', {
      org_id: org.id, name: 'Offline Stock Guard Item', hsn_code: '84716040', opening_stock: 0, gst_rate: 18
    }, owner.token)).payload;
    const stockDraft = await request('POST', '/advanced/offline-financial-drafts', {
      ...draft, draft_id: 'OFFLINE-DRAFT-STOCK', entity_type: 'STOCK_MOVEMENT', provisional_number: 'OFF-STOCK-001',
      payload: { items: [{ item_id: item.id, qty_out: 2 }], note: 'Stock movement beyond available quantity' }
    }, owner.token);
    assert.strictEqual(stockDraft.response.status, 201);
    const stockBlocked = await request('POST', `/advanced/offline-financial-drafts/${stockDraft.payload.draft.id}/review`, {
      decision: 'APPROVE', reason: 'Insufficient stock must remain blocked'
    }, owner.token);
    assert.strictEqual(stockBlocked.response.status, 422);
    assert.ok(stockBlocked.payload.problems.some(problem => problem.includes('stock')));
    const stockAdjustmentDraft = await request('POST', '/advanced/offline-financial-drafts', {
      ...draft, draft_id: 'OFFLINE-STOCK-ADJUSTMENT-001', entity_type: 'STOCK_MOVEMENT',
      provisional_number: 'LOCAL-SA-001', payload: {
        movement_date: '2026-06-08', note: 'Owner-verified stock receipt adjustment',
        items: [{ item_id: saleItem.id, qty_in: 4, rate: 50 }]
      }
    }, owner.token);
    assert.strictEqual(stockAdjustmentDraft.response.status, 201);
    assert.strictEqual((await request('POST', `/advanced/offline-financial-drafts/${stockAdjustmentDraft.payload.draft.id}/review`, {
      decision: 'APPROVE', reason: 'Verified physical stock receipt and item quantity'
    }, owner.token)).response.status, 200);
    const postedAdjustment = await request('POST', `/advanced/offline-financial-drafts/${stockAdjustmentDraft.payload.draft.id}/post`, {}, owner.token);
    assert.strictEqual(postedAdjustment.response.status, 200);
    assert.match(postedAdjustment.payload.stock_adjustment_number, /\/SA\/2026-27\//);
    const postedAdjustmentAgain = await request('POST', `/advanced/offline-financial-drafts/${stockAdjustmentDraft.payload.draft.id}/post`, {}, owner.token);
    assert.strictEqual(postedAdjustmentAgain.payload.idempotent, true);
    assert.strictEqual(postedAdjustmentAgain.payload.stock_adjustment_number, postedAdjustment.payload.stock_adjustment_number);
    const adjustedStock = (await request('GET', `/business/stock?org_id=${org.id}`, undefined, owner.token)).payload;
    assert.strictEqual(Number(adjustedStock.items.find(row => Number(row.id) === Number(saleItem.id)).current_stock), 15);
    const reconciliation = await request('GET', `/advanced/offline-financial-drafts/reconciliation?org_id=${org.id}`, undefined, owner.token);
    assert.strictEqual(reconciliation.response.status, 200);
    assert.ok(reconciliation.payload.total_drafts >= 4);
    assert.strictEqual(reconciliation.payload.final_posting_enabled, true);
    assert.strictEqual(reconciliation.payload.posting_capabilities.PAYMENT_RECEIVED, true);
    assert.strictEqual(reconciliation.payload.posting_capabilities.PAYMENT_VOUCHER, true);
    assert.strictEqual(reconciliation.payload.posting_capabilities.SALE, true);
    assert.strictEqual(reconciliation.payload.posting_capabilities.PURCHASE, true);
    assert.strictEqual(reconciliation.payload.posting_capabilities.STOCK_MOVEMENT, true);
    assert.ok(Number(reconciliation.payload.conflicts.replayed) >= 1);
    console.log('Offline financial draft integration tests passed');
  } finally {
    if (server) server.kill();
    try { dbApi.getDB()?.close(); } catch (_) {}
    setTimeout(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), 300);
  }
})().catch(error => { console.error(error); console.error(output); process.exitCode = 1; });
