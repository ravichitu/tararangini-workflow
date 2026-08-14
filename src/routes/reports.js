const express = require('express');
const router = express.Router();
const { get, run, all, transaction } = require('../db/db');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { checkOrgAccess, requireOrgAccess } = require('../middleware/auth');
const { postPayment, billSettlement, replaceSourceEntry } = require('../accounting/accounting');
const { rejectLockedPeriod, isPeriodLocked } = require('../middleware/auth');
const { lowStockSummary } = require('../business/stock');
const { defaultControl, parseJson } = require('../business/transaction-controls');
const { partyForOrg } = require('../business/parties');
const { backupStorageHealth } = require('../services/automatic-backup');

router.use(authMiddleware);
router.use(checkOrgAccess);
router.use(requirePermission('billing'));

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function paymentNumberParts(orgId, type, dateValue) {
  const effectiveDate = dateValue || new Date().toISOString().split('T')[0];
  const now = new Date(`${effectiveDate}T00:00:00`);
  const fy = now.getMonth() >= 3 ? `${now.getFullYear()}-${String(now.getFullYear()+1).slice(-2)}` : `${now.getFullYear()-1}-${String(now.getFullYear()).slice(-2)}`;
  const orgRow = get('SELECT display_name FROM orgs WHERE id=?', [orgId]);
  const orgCode = orgRow ? orgRow.display_name.substring(0,3).toUpperCase() : 'ORG';
  const prefix = type === 'received' ? 'PR' : 'PV';
  return { effectiveDate, fy, orgCode, prefix };
}

function cleanText(value, limit = 500) {
  return String(value || '').trim().slice(0, limit);
}

function pageParams(query, defaultLimit = 200, maxLimit = 500) {
  const requested = Number(query.limit || defaultLimit);
  const limit = Math.max(1, Math.min(maxLimit, Number.isFinite(requested) ? requested : defaultLimit));
  const offset = Math.max(0, Number(query.offset || 0) || 0);
  return { limit, offset };
}

function financialYearStart(fy) {
  const match = /^(\d{4})-\d{2}$/.exec(String(fy || ''));
  return match ? `${match[1]}-04-01` : null;
}

function partyOpeningBalance(party, statementOrgId) {
  if (Number(party?.org_id) !== Number(statementOrgId)) return 0;
  const amount = Number(party?.opening_balance || 0);
  return String(party?.balance_type || 'cr').toLowerCase() === 'cr' ? -amount : amount;
}

function transactionRequiredFields(orgId, type) {
  const row = get('SELECT required_fields FROM transaction_control_settings WHERE org_id=? AND transaction_type=?', [orgId, type]);
  if (row) return parseJson(row.required_fields || '{}', {});
  const org = get('SELECT invoice_print_options FROM orgs WHERE id=?', [orgId]);
  return defaultControl(type, parseJson(org?.invoice_print_options || '{}', {})).required_fields;
}

function transactionFormOptions(orgId, type) {
  const row = get('SELECT form_options FROM transaction_control_settings WHERE org_id=? AND transaction_type=?', [orgId, type]);
  if (row) return parseJson(row.form_options || '{}', {});
  const org = get('SELECT invoice_print_options FROM orgs WHERE id=?', [orgId]);
  return defaultControl(type, parseJson(org?.invoice_print_options || '{}', {})).form_options;
}

function requirePaymentControlFields(orgId, type, body) {
  const required = transactionRequiredFields(orgId, type);
  const missing = [];
  if (required.party && !body.party_id) missing.push(type === 'PV' ? 'Payee / Vendor' : 'Party');
  if (required.payment_mode && !body.mode) missing.push('Payment Mode');
  if (required.reference && !body.reference) missing.push('Reference Number / UTR');
  if (required.bank_reference && body.mode !== 'cash' && !body.reference) missing.push('Bank Reference');
  if (required.linked_bills && !(Array.isArray(body.linked_bills) && body.linked_bills.length)) missing.push('Linked Bills');
  if (required.amount && !Number(body.amount || 0)) missing.push('Amount');
  if (required.footer && !body.narration) missing.push('Narration');
  if (missing.length) throw new Error(`${type} required field missing: ${missing.join(', ')}`);
}

router.get('/payments/next-number', (req, res) => {
  const { org_id, type, date } = req.query;
  if (!org_id) return res.status(400).json({ error: 'org_id required' });
  const { fy, orgCode, prefix } = paymentNumberParts(org_id, type, date);
  const seq = get('SELECT last_number FROM bill_sequences WHERE org_id=? AND format=? AND fy=?', [org_id, prefix, fy]);
  const nextNum = Number(seq?.last_number || 0) + 1;
  res.json({ number: `${orgCode}/${prefix}/${fy}/${String(nextNum).padStart(4,'0')}`, fy });
});

// PAYMENTS
router.get('/payments', (req, res) => {
  const { org_id, party_id, fy, type, search } = req.query;
  const page = pageParams(req.query);
  if (!org_id) return res.status(400).json({ error: 'org_id required' });
  let sql = `SELECT py.*, p.name as party_name, a.name as deposit_account_name
    FROM payments py
    LEFT JOIN parties p ON py.party_id=p.id
    LEFT JOIN accounts a ON a.id=py.deposit_account_id
    WHERE py.deleted=0`;
  const params = [];
  if (org_id) { sql += ' AND py.org_id=?'; params.push(org_id); }
  if (party_id) { sql += ' AND py.party_id=?'; params.push(party_id); }
  if (fy) { sql += ' AND py.fy=?'; params.push(fy); }
  if (type) { sql += ' AND py.type=?'; params.push(type); }
  if (search) {
    sql += ` AND (py.payment_number LIKE ? OR p.name LIKE ? OR py.reference LIKE ? OR py.narration LIKE ?)`;
    const s = `%${cleanText(search, 120)}%`;
    params.push(s, s, s, s);
  }
  sql += ' ORDER BY py.payment_date DESC, py.created_at DESC LIMIT ? OFFSET ?';
  params.push(page.limit, page.offset);
  res.json(all(sql, params));
});

router.get('/payments/:id', (req, res) => {
  const payment = get(
    `SELECT py.*, p.name party_name, a.name deposit_account_name
     FROM payments py LEFT JOIN parties p ON p.id=py.party_id
     LEFT JOIN accounts a ON a.id=py.deposit_account_id
     WHERE py.id=? AND py.deleted=0`, [req.params.id]
  );
  if (!payment) return res.status(404).json({ error: 'Payment voucher not found' });
  if (!requireOrgAccess(req, res, payment.org_id)) return;
  res.json(payment);
});

router.patch('/payments/:id', rejectLockedPeriod, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access required to correct a payment voucher' });
  const payment = get('SELECT * FROM payments WHERE id=? AND deleted=0', [req.params.id]);
  if (!payment) return res.status(404).json({ error: 'Payment voucher not found' });
  if (!requireOrgAccess(req, res, payment.org_id)) return;

  const reason = cleanText(req.body.reason, 500);
  if (reason.length < 10) return res.status(400).json({ error: 'Correction reason must be at least 10 characters' });
  const nextAmount = Number(req.body.amount ?? payment.amount);
  if (!Number.isFinite(nextAmount) || nextAmount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero' });
  const nextDate = cleanText(req.body.payment_date || payment.payment_date, 20);
  const nextMode = cleanText(req.body.mode || payment.mode || 'cash', 20).toLowerCase();
  const nextReference = cleanText(req.body.reference ?? payment.reference, 200) || null;
  const nextNarration = cleanText(req.body.narration ?? payment.narration, 500) || null;
  const nextPartyId = req.body.party_id === undefined ? payment.party_id : (Number(req.body.party_id) || null);
  const nextAccountId = req.body.deposit_account_id === undefined
    ? payment.deposit_account_id : (Number(req.body.deposit_account_id) || null);
  const linkedBills = Array.isArray(req.body.linked_bills)
    ? req.body.linked_bills.map(row => ({ bill_id: Number(row.bill_id), amount: Number(row.amount || 0) }))
      .filter(row => row.bill_id && row.amount > 0)
    : JSON.parse(payment.linked_bills || '[]');
  const controlType = payment.type === 'paid' ? 'PV' : 'PR';
  try {
    requirePaymentControlFields(payment.org_id, controlType, {
      party_id: nextPartyId, mode: nextMode, reference: nextReference,
      linked_bills: linkedBills, amount: nextAmount, narration: nextNarration
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  if (nextPartyId && !partyForOrg(nextPartyId, payment.org_id)) {
    return res.status(400).json({ error: 'Customer or vendor does not belong to this company' });
  }
  if (nextAccountId) {
    const account = get(
      `SELECT id FROM accounts WHERE id=? AND org_id=? AND active=1 AND type IN ('asset','liability','equity')`,
      [nextAccountId, payment.org_id]
    );
    if (!account) return res.status(400).json({ error: 'Selected deposit/payment account is invalid for this company' });
  }
  if (payment.type === 'received' && nextMode !== 'cash' && !nextReference) {
    return res.status(400).json({ error: 'Bank / UPI / Card receipt reference is required' });
  }
  const requested = linkedBills.reduce((sum, row) => sum + row.amount, 0);
  if (requested > nextAmount + 0.01) return res.status(400).json({ error: 'Linked invoice allocation cannot exceed receipt amount' });

  try {
    const updated = transaction(() => {
      const actualAllocations = [];
      let allocatedTotal = 0;
      for (const allocation of linkedBills) {
        const bill = get('SELECT * FROM bills WHERE id=? AND org_id=? AND deleted=0', [allocation.bill_id, payment.org_id]);
        if (!bill) throw new Error(`Invoice ${allocation.bill_id} was not found`);
        const currentAllocation = get('SELECT COALESCE(SUM(amount),0) amount FROM payment_allocations WHERE bill_id=? AND payment_id=?', [bill.id, payment.id]);
        const available = Math.max(0, Number(billSettlement(bill).outstanding) + Number(currentAllocation?.amount || 0));
        const amount = Math.min(allocation.amount, available);
        if (amount > 0) {
          actualAllocations.push({ bill_id: bill.id, amount: Number(amount.toFixed(2)) });
          allocatedTotal += amount;
        }
      }
      const party = nextPartyId ? partyForOrg(nextPartyId, payment.org_id) : null;
      const oldData = { ...payment, allocations: JSON.parse(payment.linked_bills || '[]') };
      run(`UPDATE payments SET payment_date=?,party_id=?,party_snapshot=?,mode=?,deposit_account_id=?,amount=?,reference=?,linked_bills=?,narration=? WHERE id=?`, [
        nextDate, nextPartyId, party ? JSON.stringify({ name: party.name, address: party.address, gstin: party.gstin }) : null,
        nextMode, nextAccountId, nextAmount, nextReference, JSON.stringify(actualAllocations), nextNarration, payment.id
      ]);
      run('DELETE FROM payment_allocations WHERE payment_id=?', [payment.id]);
      actualAllocations.forEach(row => run('INSERT INTO payment_allocations (payment_id,bill_id,amount) VALUES (?,?,?)', [payment.id, row.bill_id, row.amount]));
      const nextPayment = get(`SELECT py.*, p.name party_name, a.name deposit_account_name
        FROM payments py
        LEFT JOIN parties p ON p.id=py.party_id
        LEFT JOIN accounts a ON a.id=py.deposit_account_id
        WHERE py.id=?`, [payment.id]);
      postPayment(nextPayment);
      run(`INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,old_data,new_data,ip_address) VALUES (?,?,?,?,?,?,?,?)`, [
        req.user.id, payment.org_id, 'PAYMENT_CORRECTION', 'payments', payment.id,
        JSON.stringify(oldData), JSON.stringify({ ...nextPayment, allocations: actualAllocations, correction_reason: reason }), req.ip
      ]);
      return { payment: nextPayment, allocated_total: Number(allocatedTotal.toFixed(2)), unallocated_amount: Number((nextAmount - allocatedTotal).toFixed(2)) };
    });
    res.json({ success: true, ...updated });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/payments/:id/reverse', (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access required to reverse a payment voucher' });
  const payment = get('SELECT * FROM payments WHERE id=? AND deleted=0', [req.params.id]);
  if (!payment) return res.status(404).json({ error: 'Active payment voucher not found' });
  if (!requireOrgAccess(req, res, payment.org_id)) return;
  const reason = cleanText(req.body.reason, 500);
  const reversalDate = cleanText(req.body.reversal_date, 20) || new Date().toISOString().slice(0, 10);
  if (reason.length < 10) return res.status(400).json({ error: 'Reversal reason must be at least 10 characters' });
  if (isPeriodLocked(payment.org_id, reversalDate)) return res.status(423).json({ error: 'The reversal date is in a locked financial year' });
  const reversalNumber = `REV-${payment.payment_number}`;
  try {
    const result = transaction(() => {
      let source = get(`SELECT je.id,je.voucher_number FROM journal_entries je
        WHERE je.org_id=? AND je.source_type='payment' AND je.source_id=? AND je.deleted=0`, [payment.org_id, payment.id]);
      let sourceLines = source
        ? all('SELECT account_id,party_id,debit,credit,narration FROM journal_lines WHERE entry_id=? ORDER BY id', [source.id])
        : [];

      // Older receipt records may predate accounting posting. Rebuild their
      // source entry first so deletion always leaves an auditable reversal.
      if (!source || !sourceLines.length) {
        postPayment(payment);
        source = get(`SELECT je.id,je.voucher_number FROM journal_entries je
          WHERE je.org_id=? AND je.source_type='payment' AND je.source_id=? AND je.deleted=0`, [payment.org_id, payment.id]);
        sourceLines = source
          ? all('SELECT account_id,party_id,debit,credit,narration FROM journal_lines WHERE entry_id=? ORDER BY id', [source.id])
          : [];
      }
      if (!source || !sourceLines.length) {
        throw new Error('Payment accounting entry could not be restored for deletion');
      }
      run(`UPDATE payments SET deleted=1,reversal_number=?,reversed_at=?,reversed_by=?,reversal_reason=? WHERE id=?`,
        [reversalNumber, new Date().toISOString(), req.user.id, reason, payment.id]);
      run('DELETE FROM payment_allocations WHERE payment_id=?', [payment.id]);
      const reversalId = replaceSourceEntry({
        orgId: payment.org_id,
        date: reversalDate,
        voucherType: 'PAYMENT_REVERSAL',
        voucherNumber: reversalNumber,
        narration: `Reversal of ${payment.payment_number}: ${reason}`,
        sourceType: 'payment_reversal',
        sourceId: payment.id,
        createdBy: req.user.id,
        lines: sourceLines.map(line => ({
          accountId: line.account_id, partyId: line.party_id,
          debit: Number(line.credit || 0), credit: Number(line.debit || 0), narration: line.narration
        }))
      });
      run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,old_data,new_data,ip_address) VALUES (?,?,?,?,?,?,?,?)',
        [req.user.id, payment.org_id, 'PAYMENT_REVERSAL', 'payments', payment.id,
          JSON.stringify({ payment_number: payment.payment_number, amount: payment.amount, deleted: 0 }),
          JSON.stringify({ reversal_number: reversalNumber, reversal_date: reversalDate, reason, reversal_journal_id: reversalId }), req.ip]);
      return { reversal_number: reversalNumber, reversal_journal_id: reversalId };
    });
    res.json({ success: true, original_payment_number: payment.payment_number, ...result });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post('/payments', rejectLockedPeriod, (req, res) => {
  const { org_id, payment_date, party_id, type, mode, amount, reference, linked_bills, narration, shift_id, deposit_account_id } = req.body;
  if (!org_id || !amount) return res.status(400).json({ error: 'org_id and amount required' });
  try {
    requirePaymentControlFields(org_id, (type || 'received') === 'paid' ? 'PV' : 'PR', req.body);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const { effectiveDate, fy, orgCode, prefix } = paymentNumberParts(org_id, type, payment_date);
  let seq = get('SELECT * FROM bill_sequences WHERE org_id=? AND format=? AND fy=?', [org_id, prefix, fy]);
  if (!seq) { run('INSERT INTO bill_sequences (org_id,format,fy,prefix,last_number) VALUES (?,?,?,?,0)', [org_id, prefix, fy, prefix]); seq = {last_number:0}; }
  const nextNum = (seq.last_number || 0) + 1;
  run('UPDATE bill_sequences SET last_number=? WHERE org_id=? AND format=? AND fy=?', [nextNum, org_id, prefix, fy]);
  const paymentNumber = `${orgCode}/${prefix}/${fy}/${String(nextNum).padStart(4,'0')}`;

  const party = party_id ? partyForOrg(party_id, org_id) : null;
  if (party_id && !party) return res.status(400).json({ error: 'Customer does not belong to this company' });
  const partySnapshot = party ? JSON.stringify({ name: party.name, address: party.address, gstin: party.gstin }) : null;
  const depositAccountId = Number(deposit_account_id || 0) || null;
  if (depositAccountId) {
    const account = get(
      `SELECT id FROM accounts
       WHERE id=? AND org_id=? AND active=1 AND type IN ('asset','liability','equity')`,
      [depositAccountId, org_id]
    );
    if (!account) return res.status(400).json({ error: 'Selected deposit/payment account does not belong to this company' });
  }

  const allocations = linked_bills || [];
  const controlType = (type || 'received') === 'paid' ? 'PV' : 'PR';
  const formOptions = transactionFormOptions(org_id, controlType);
  const referenceVisible = formOptions.reference !== false || formOptions.bank_reference !== false;
  if ((type || 'received') === 'received' && mode !== 'cash' && referenceVisible && !reference) {
    return res.status(400).json({ error: 'Bank / UPI / Card receipt reference is required' });
  }
  let requestedAllocation = allocations.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  if (requestedAllocation > Number(amount) + 0.01) {
    return res.status(400).json({ error: 'Linked invoice allocation cannot exceed receipt amount' });
  }
  const actualAllocations = [];
  for (const allocation of allocations) {
    const bill = get('SELECT * FROM bills WHERE id=? AND org_id=? AND deleted=0', [allocation.bill_id, org_id]);
    if (!bill) return res.status(400).json({ error: `Invoice ${allocation.bill_id} was not found` });
    const settlement = billSettlement(bill);
    const allocatable = Math.min(Number(allocation.amount || 0), Number(settlement.outstanding || 0));
    if (allocatable > 0) actualAllocations.push({ bill_id: bill.id, amount: Number(allocatable.toFixed(2)) });
  }

  let linkedShift = null;
  if (shift_id) {
    const shift = get('SELECT id,status,user_id,org_id FROM pos_shifts WHERE id=? AND org_id=?', [shift_id, org_id]);
    if (!shift) return res.status(400).json({ error: 'Selected POS shift was not found for this company' });
    if (shift.status !== 'open') {
      return res.status(423).json({ error: 'This POS shift is closed. Create a new/open shift before recording more payments.' });
    }
    if (Number(shift.user_id) !== Number(req.user.id) && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'You can record payments only in your own open shift' });
    }
    linkedShift = shift.id;
  } else {
    linkedShift = get(
    `SELECT id FROM pos_shifts WHERE org_id=? AND user_id=? AND status='open' ORDER BY id DESC LIMIT 1`,
    [org_id, req.user.id]
    )?.id || null;
  }
  const result = run(
    `INSERT INTO payments (org_id,payment_number,payment_date,fy,party_id,party_snapshot,type,mode,deposit_account_id,amount,reference,linked_bills,narration,shift_id,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [org_id, paymentNumber, effectiveDate, fy,
     party_id || null, partySnapshot, type || 'received', mode || 'cash', depositAccountId,
     parseFloat(amount), reference || null, JSON.stringify(actualAllocations), narration || null, linkedShift, req.user.id]
  );
  let remaining = Number(amount);
  actualAllocations.forEach(allocation => {
    if (remaining <= 0) return;
    const bill = get('SELECT grand_total FROM bills WHERE id=? AND org_id=?', [allocation.bill_id, org_id]);
    if (!bill) return;
    const allocated = Math.min(remaining, Number(allocation.amount || bill.grand_total));
    if (allocated > 0) {
      run('INSERT INTO payment_allocations (payment_id,bill_id,amount) VALUES (?,?,?)',
        [result.lastInsertRowid, allocation.bill_id, allocated]);
      remaining -= allocated;
    }
  });
  postPayment(get('SELECT * FROM payments WHERE id=?', [result.lastInsertRowid]));
  res.json({
    success: true, id: result.lastInsertRowid, payment_number: paymentNumber,
    unallocated_amount: Number(Math.max(0, remaining).toFixed(2)),
    settlements: actualAllocations.map(row => {
      const bill = get('SELECT * FROM bills WHERE id=?', [row.bill_id]);
      return bill ? { bill_id: bill.id, bill_number: bill.bill_number, ...billSettlement(bill) } : null;
    }).filter(Boolean)
  });
});

// REPORTS ROUTER
const reportsRouter = express.Router();
reportsRouter.use(authMiddleware);
reportsRouter.use(checkOrgAccess);
reportsRouter.use(requirePermission('reports'));

reportsRouter.get('/dashboard', (req, res) => {
  const { org_id, fy } = req.query;
  if (!org_id) return res.status(400).json({ error: 'org_id required' });

  const fyFilter = fy || (() => { const n=new Date(); const y=n.getMonth()>=3?n.getFullYear():n.getFullYear()-1; return `${y}-${String(y+1).slice(-2)}`; })();

  const billSummary = get(
    `SELECT
       COALESCE(SUM(CASE WHEN format IN ('SALE','PP') AND status='saved' THEN grand_total ELSE 0 END),0) total_sales,
       COALESCE(SUM(CASE WHEN format IN ('SALE','PP') THEN 1 ELSE 0 END),0) total_bills,
       COALESCE(SUM(CASE WHEN format IN ('SALE','PP') AND payment_mode='cash' THEN grand_total ELSE 0 END),0) cash_sales,
       COALESCE(SUM(CASE WHEN format IN ('SALE','PP') AND payment_mode='credit' THEN grand_total ELSE 0 END),0) credit_sales,
       COALESCE(SUM(CASE WHEN format='QUOT' THEN 1 ELSE 0 END),0) total_quotations
     FROM bills WHERE org_id=? AND fy=? AND deleted=0`,
    [org_id, fyFilter]
  );
  const cashReceived = get(`SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE org_id=? AND type='received' AND mode='cash' AND fy=? AND deleted=0`, [org_id, fyFilter]);
  const aging = get(
    `SELECT
       COALESCE(SUM(CASE WHEN b.payment_mode='credit'
         THEN b.grand_total-COALESCE(pa.paid,0) ELSE 0 END),0) receivable,
       COALESCE(SUM(CASE WHEN b.due_date<date('now') AND b.grand_total-COALESCE(pa.paid,0)>0.01
         THEN 1 ELSE 0 END),0) overdue_count,
       COALESCE(SUM(CASE WHEN b.due_date<date('now') AND b.grand_total-COALESCE(pa.paid,0)>0.01
         THEN b.grand_total-COALESCE(pa.paid,0) ELSE 0 END),0) overdue_total
     FROM bills b
     LEFT JOIN (
       SELECT pa.bill_id,SUM(pa.amount) paid
       FROM payment_allocations pa
       JOIN bills allocated_bill ON allocated_bill.id=pa.bill_id
       WHERE allocated_bill.org_id=? AND allocated_bill.format IN ('SALE','PP')
         AND allocated_bill.deleted=0 AND allocated_bill.status='saved'
       GROUP BY pa.bill_id
     ) pa ON pa.bill_id=b.id
     WHERE b.org_id=? AND b.format IN ('SALE','PP') AND b.deleted=0 AND b.status='saved'`,
    [org_id, org_id]
  );
  const lowStock = lowStockSummary(org_id);
  const backup = get('SELECT backup_date FROM backup_log WHERE org_id=? OR org_id IS NULL ORDER BY backup_date DESC LIMIT 1', [org_id]);
  const cashBank = all(
    `SELECT a.system_key,COALESCE(SUM(jl.debit-jl.credit),0) balance
     FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id=a.id
     LEFT JOIN journal_entries je ON je.id=jl.entry_id
     WHERE a.org_id=? AND a.system_key IN ('cash','bank')
       AND (jl.id IS NULL OR je.deleted=0)
     GROUP BY a.id`,
    [org_id]
  );

  // Monthly sales
  const monthlySales = all(`SELECT strftime('%m',bill_date) as month, COALESCE(SUM(grand_total),0) as total, COUNT(*) as count
    FROM bills WHERE org_id=? AND format IN ('SALE','PP') AND fy=? AND deleted=0 GROUP BY month ORDER BY month`, [org_id, fyFilter]);

  // Top parties
  const topParties = all(`SELECT p.name, COUNT(b.id) as bill_count, COALESCE(SUM(b.grand_total),0) as total
    FROM bills b JOIN parties p ON b.party_id=p.id WHERE b.org_id=? AND b.format IN ('SALE','PP') AND b.fy=? AND b.deleted=0
    GROUP BY b.party_id ORDER BY total DESC LIMIT 10`, [org_id, fyFilter]);

  // Top items
  const topItems = all(`SELECT item_name, COALESCE(SUM(qty),0) as total_qty, COALESCE(SUM(amount),0) as total_amount
    FROM (SELECT json_each.value->>'item_name' as item_name, CAST(json_each.value->>'qty' as REAL) as qty, CAST(json_each.value->>'amount' as REAL) as amount
    FROM bills, json_each(bills.items_json) WHERE bills.org_id=? AND bills.format IN ('SALE','PP') AND bills.fy=? AND bills.deleted=0)
    GROUP BY item_name ORDER BY total_amount DESC LIMIT 10`, [org_id, fyFilter]);

  res.json({
    fy: fyFilter,
    total_sales: billSummary?.total_sales || 0,
    total_bills: billSummary?.total_bills || 0,
    cash_sales: billSummary?.cash_sales || 0,
    credit_sales: billSummary?.credit_sales || 0,
    cash_balance: cashReceived?.total || 0,
    total_quotations: billSummary?.total_quotations || 0,
    receivable: aging?.receivable || 0,
    overdue_count: aging?.overdue_count || 0,
    overdue_total: aging?.overdue_total || 0,
    low_stock_count: lowStock.length,
    low_stock: lowStock.slice(0, 10),
    backup_date: backup?.backup_date || null,
    cash_bank: cashBank,
    monthly_sales: monthlySales,
    top_parties: topParties,
    top_items: topItems
  });
});

reportsRouter.get('/attention', (req, res) => {
  const orgId = Number(req.query.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  const org = get('SELECT gst_type FROM orgs WHERE id=?', [orgId]);
  if (!org) return res.status(404).json({ error: 'Company not found' });
  const overdueInvoices = all(
    `SELECT b.id,b.bill_number,b.bill_date,b.due_date,b.grand_total,p.name party_name,
      ROUND(b.grand_total-COALESCE(pa.paid,0),2) pending_amount
     FROM bills b
     LEFT JOIN parties p ON p.id=b.party_id
     LEFT JOIN (
       SELECT bill_id,SUM(amount) paid FROM payment_allocations GROUP BY bill_id
     ) pa ON pa.bill_id=b.id
     WHERE b.org_id=? AND b.format IN ('SALE','PP') AND b.deleted=0 AND b.status='saved'
       AND b.due_date<date('now') AND b.grand_total-COALESCE(pa.paid,0)>0.01
     ORDER BY b.due_date,b.id LIMIT 20`,
    [orgId]
  );
  const lowStock = lowStockSummary(orgId).slice(0, 20);
  const missingHsn = String(org.gst_type || '').toLowerCase() === 'regular'
    ? all(`SELECT id,item_code,name FROM items
       WHERE org_id=? AND active=1 AND TRIM(COALESCE(hsn_code,''))='' ORDER BY name LIMIT 20`, [orgId])
    : [];
  const storageHealth = backupStorageHealth();
  const latestBackup = get(`SELECT bl.backup_date,bv.status,bv.verified_at
    FROM backup_log bl LEFT JOIN backup_verification_log bv ON bv.backup_log_id=bl.id
    WHERE bl.fy='automatic' ORDER BY bl.id DESC LIMIT 1`);

  res.json({
    generated_at: new Date().toISOString(),
    summary: {
      overdue_invoices: overdueInvoices.length,
      low_stock: lowStock.length,
      missing_hsn: missingHsn.length,
      backup_attention: !storageHealth.healthy || latestBackup?.status !== 'PASSED'
    },
    overdue_invoices: overdueInvoices,
    low_stock: lowStock,
    missing_hsn: missingHsn,
    backup: { latest: latestBackup || null, storage_health: storageHealth }
  });
});

const REPORT_CATALOG = [
  { id: 'sales_register', title: 'Sales Register', description: 'Saved sale and project-printing invoices with customer, tax, payment mode, and totals.' },
  { id: 'quotation_register', title: 'Quotation Register', description: 'Issued quotations, their customer, value, and current status.' },
  { id: 'delivery_challan_register', title: 'Delivery Challan Register', description: 'Delivery challans with dispatch and recipient tracking information.' },
  { id: 'purchase_register', title: 'Purchase Register', description: 'Supplier purchase bills, tax breakup, and payment mode.' },
  { id: 'receipt_register', title: 'Receipt Register', description: 'Payment-received vouchers, references, and linked customer details.' },
  { id: 'payment_voucher_register', title: 'Payment Voucher Register', description: 'Payment-out vouchers, references, and payee details.' },
  { id: 'expense_register', title: 'Expense Register', description: 'Expense vouchers with account, party, GST, and payment details.' },
  { id: 'credit_debit_note_register', title: 'Credit / Debit Note Register', description: 'All saved note transactions and linked document references.' },
  { id: 'receivables_ageing', title: 'Receivables Ageing', description: 'Open credit invoices grouped by due-age bucket and follow-up status.' },
  { id: 'stock_summary', title: 'Stock Summary', description: 'Opening, received, issued, and current stock by item.' },
  { id: 'stock_movement_register', title: 'Stock Movement Register', description: 'Every stock in and stock out movement with source reference.' },
  { id: 'cash_bank_book', title: 'Cash / Bank Book', description: 'Posted cash and bank ledger entries from the accounting journal.' },
  { id: 'gst_sales_register', title: 'GST Sales Register', description: 'Taxable value, CGST, SGST, IGST, customer GSTIN, and invoice totals.' },
  { id: 'profitability_register', title: 'Profitability Register', description: 'Invoice revenue, recorded cost, gross margin, and margin percentage.' },
  { id: 'party_master', title: 'Party Master', description: 'Customers and vendors available to the selected company.' }
];

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // Prevent spreadsheet formulas from executing when a CSV is opened.
  if (/^[=+\-@]/.test(text.trim())) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function sendCsv(res, filename, headings, rows) {
  const content = [headings, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
  const safeName = String(filename).replace(/[^a-z0-9._-]/gi, '-');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/csv; charset=utf-8').send(`\ufeff${content}`);
}

function htmlCell(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function printableReportHtml(report, org, query) {
  const printLimit = 2000;
  const rows = report.rows.slice(0, printLimit);
  const truncated = report.rows.length > rows.length;
  const fontSize = report.headings.length > 12 ? '7px' : report.headings.length > 8 ? '8px' : '9px';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${htmlCell(report.filename)}</title>
  <style>@page{size:landscape;margin:10mm}body{font-family:Arial,sans-serif;color:#14213d;margin:0}h1{font-size:18px;margin:0 0 3px}p{margin:0 0 12px;color:#52606d;font-size:10px}.notice{padding:7px;background:#fff5d6;border:1px solid #edc86c;margin-bottom:10px;font-size:10px}table{width:100%;border-collapse:collapse;table-layout:auto;font-size:${fontSize}}th{background:#12395b;color:#fff;text-align:left}th,td{border:1px solid #b7c1ca;padding:4px;vertical-align:top;word-break:break-word}tr:nth-child(even){background:#f5f8fa}.footer{margin-top:10px;font-size:9px;color:#52606d}@media print{.no-print{display:none}}</style></head><body>
  <h1>${htmlCell(org?.display_name || org?.registered_name || 'Tarangini')} - ${htmlCell(report.filename.replace(/-/g, ' ').replace(/\b\w/g, char => char.toUpperCase()))}</h1>
  <p>Generated ${htmlCell(new Date().toLocaleString('en-IN'))}${query.fy ? ` | Financial Year ${htmlCell(query.fy)}` : ''}${query.from || query.to ? ` | Period ${htmlCell(query.from || 'start')} to ${htmlCell(query.to || 'today')}` : ''}</p>
  ${truncated ? `<div class="notice">Print view contains the first ${printLimit.toLocaleString('en-IN')} rows of ${report.rows.length.toLocaleString('en-IN')}. Download CSV from Report Centre for the full register.</div>` : ''}
  <table><thead><tr>${report.headings.map(heading => `<th>${htmlCell(heading)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${htmlCell(value)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${report.headings.length}">No records found for this selection.</td></tr>`}</tbody></table>
  <div class="footer">Generated by Tarangini Workflow Suite. Use Print and select Save as PDF if a PDF copy is required.</div></body></html>`;
}

function safeReportDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function reportPeriodWhere(query, column, params, { alias = '', allowFy = true } = {}) {
  const prefix = alias ? `${alias}.` : '';
  const from = safeReportDate(query.from);
  const to = safeReportDate(query.to);
  if (allowFy && query.fy) {
    params.push(String(query.fy));
    return `${prefix}fy=?`;
  }
  if (from && to) {
    params.push(from, to);
    return `${prefix}${column} BETWEEN ? AND ?`;
  }
  if (from) {
    params.push(from);
    return `${prefix}${column}>=?`;
  }
  if (to) {
    params.push(to);
    return `${prefix}${column}<=?`;
  }
  return '1=1';
}

function collectionRows(orgId, partyId = null) {
  const params = [Number(orgId)];
  let partyWhere = '';
  if (partyId) {
    partyWhere = ' AND b.party_id=?';
    params.push(Number(partyId));
  }
  const rows = all(
    `SELECT b.id bill_id,b.bill_number,b.bill_date,b.fy,b.due_date,b.party_id,b.grand_total,
      p.name party_name,p.phone party_phone,p.email party_email,
      COALESCE(cp.credit_limit,0) credit_limit,COALESCE(cp.credit_days,0) credit_days,
      COALESCE(cp.on_hold,0) on_hold,COALESCE(cp.hold_reason,'') hold_reason,
      ROUND(b.grand_total-COALESCE(pa.paid,0),2) outstanding
     FROM bills b
     LEFT JOIN parties p ON p.id=b.party_id
     LEFT JOIN party_credit_policies cp ON cp.org_id=b.org_id AND cp.party_id=b.party_id
     LEFT JOIN (
       SELECT bill_id,SUM(amount) paid FROM payment_allocations GROUP BY bill_id
     ) pa ON pa.bill_id=b.id
     WHERE b.org_id=? AND b.format IN ('SALE','PP') AND b.payment_mode='credit'
       AND b.deleted=0 AND b.status='saved' AND b.grand_total-COALESCE(pa.paid,0)>0.01${partyWhere}
     ORDER BY COALESCE(b.due_date,b.bill_date),b.id`,
    params
  );
  const followUps = all(
    `SELECT cf.*,u.name created_by_name,u.username created_by_username
     FROM party_collection_followups cf
     LEFT JOIN users u ON u.id=cf.created_by
     WHERE cf.org_id=?${partyId ? ' AND cf.party_id=?' : ''}
     ORDER BY cf.created_at DESC,cf.id DESC`,
    partyId ? [Number(orgId), Number(partyId)] : [Number(orgId)]
  );
  const latestByBill = new Map();
  followUps.forEach(row => {
    const key = Number(row.bill_id || 0) || `party-${row.party_id}`;
    if (!latestByBill.has(key)) latestByBill.set(key, row);
  });
  const now = new Date();
  return rows.map(row => {
    const due = safeReportDate(row.due_date) || safeReportDate(row.bill_date);
    const ageDays = due ? Math.max(0, Math.floor((now - new Date(`${due}T00:00:00`)) / 86400000)) : 0;
    const latest = latestByBill.get(Number(row.bill_id)) || latestByBill.get(`party-${row.party_id}`) || null;
    return {
      ...row,
      outstanding: Number(row.outstanding || 0),
      age_days: ageDays,
      age_bucket: ageDays === 0 ? 'Current' : ageDays <= 30 ? '1-30 days' : ageDays <= 60 ? '31-60 days' : ageDays <= 90 ? '61-90 days' : '90+ days',
      latest_follow_up: latest
    };
  });
}

function receivableSummary(rows) {
  const buckets = { Current: 0, '1-30 days': 0, '31-60 days': 0, '61-90 days': 0, '90+ days': 0 };
  rows.forEach(row => { buckets[row.age_bucket] += Number(row.outstanding || 0); });
  return {
    invoice_count: rows.length,
    total_outstanding: Number(rows.reduce((sum, row) => sum + Number(row.outstanding || 0), 0).toFixed(2)),
    overdue_amount: Number(rows.filter(row => row.age_days > 0).reduce((sum, row) => sum + Number(row.outstanding || 0), 0).toFixed(2)),
    buckets: Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, Number(value.toFixed(2))]))
  };
}

function exportReportRows(reportId, orgId, query) {
  const dateParams = [Number(orgId)];
  const billPeriod = reportPeriodWhere(query, 'bill_date', dateParams, { alias: 'b' });
  const billRegisters = {
    sales_register: { formats: ['SALE', 'PP'], title: 'sales-register' },
    quotation_register: { formats: ['QUOT'], title: 'quotation-register' },
    delivery_challan_register: { formats: ['DC'], title: 'delivery-challan-register' }
  };
  if (billRegisters[reportId]) {
    const config = billRegisters[reportId];
    const rows = all(
      `SELECT b.bill_number,b.bill_date,b.fy,b.format,b.status,p.name party_name,p.phone party_phone,
        b.po_number,b.po_date,b.payment_mode,b.due_date,b.taxable_amount,b.cgst,b.sgst,b.igst,b.total_tax,b.grand_total,
        b.delivery_address,b.delivery_info
       FROM bills b LEFT JOIN parties p ON p.id=b.party_id
       WHERE b.org_id=? AND b.deleted=0 AND b.format IN (${config.formats.map(() => '?').join(',')}) AND ${billPeriod}
       ORDER BY b.bill_date,b.id`,
      [Number(orgId), ...config.formats, ...dateParams.slice(1)]
    );
    return {
      filename: config.title,
      headings: ['Number', 'Date', 'FY', 'Format', 'Status', 'Party', 'Phone', 'PO Number', 'PO Date', 'Payment Mode', 'Due Date', 'Taxable Amount', 'CGST', 'SGST', 'IGST', 'Total Tax', 'Grand Total', 'Delivery Address', 'Delivery Info'],
      rows: rows.map(row => [row.bill_number, row.bill_date, row.fy, row.format, row.status, row.party_name, row.party_phone, row.po_number, row.po_date, row.payment_mode, row.due_date, row.taxable_amount, row.cgst, row.sgst, row.igst, row.total_tax, row.grand_total, row.delivery_address, row.delivery_info])
    };
  }
  if (reportId === 'purchase_register') {
    const params = [Number(orgId)];
    const period = reportPeriodWhere(query, 'purchase_date', params, { alias: 'pu' });
    const rows = all(`SELECT pu.purchase_number,pu.supplier_invoice,pu.purchase_date,pu.fy,p.name supplier_name,p.gstin,pu.payment_mode,pu.due_date,pu.taxable_amount,pu.cgst,pu.sgst,pu.igst,pu.total_tax,pu.grand_total
      FROM purchases pu LEFT JOIN parties p ON p.id=pu.party_id WHERE pu.org_id=? AND pu.deleted=0 AND ${period} ORDER BY pu.purchase_date,pu.id`, params);
    return { filename: 'purchase-register', headings: ['Purchase Number','Supplier Invoice','Date','FY','Supplier','GSTIN','Payment Mode','Due Date','Taxable Amount','CGST','SGST','IGST','Total Tax','Grand Total'], rows: rows.map(row => [row.purchase_number,row.supplier_invoice,row.purchase_date,row.fy,row.supplier_name,row.gstin,row.payment_mode,row.due_date,row.taxable_amount,row.cgst,row.sgst,row.igst,row.total_tax,row.grand_total]) };
  }
  if (reportId === 'receipt_register' || reportId === 'payment_voucher_register') {
    const params = [Number(orgId), reportId === 'receipt_register' ? 'received' : 'paid'];
    const period = reportPeriodWhere(query, 'payment_date', params, { alias: 'py' });
    const rows = all(`SELECT py.payment_number,py.payment_date,py.fy,py.type,py.mode,p.name party_name,p.phone,py.amount,py.reference,py.narration,py.linked_bills
      FROM payments py LEFT JOIN parties p ON p.id=py.party_id WHERE py.org_id=? AND py.type=? AND py.deleted=0 AND ${period} ORDER BY py.payment_date,py.id`, params);
    return { filename: reportId.replace(/_/g, '-'), headings: ['Voucher Number','Date','FY','Type','Mode','Party','Phone','Amount','Reference','Narration','Linked Bills'], rows: rows.map(row => [row.payment_number,row.payment_date,row.fy,row.type,row.mode,row.party_name,row.phone,row.amount,row.reference,row.narration,row.linked_bills]) };
  }
  if (reportId === 'expense_register') {
    const params = [Number(orgId)];
    const period = reportPeriodWhere(query, 'expense_date', params, { alias: 'e' });
    const rows = all(`SELECT e.expense_number,e.expense_date,e.fy,p.name party_name,a.name account_name,e.payment_mode,e.amount,e.gst_rate,e.gst_amount,e.reference,e.narration
      FROM expenses e LEFT JOIN parties p ON p.id=e.party_id LEFT JOIN accounts a ON a.id=e.account_id WHERE e.org_id=? AND e.deleted=0 AND ${period} ORDER BY e.expense_date,e.id`, params);
    return { filename: 'expense-register', headings: ['Expense Number','Date','FY','Party','Account','Payment Mode','Amount','GST Rate','GST Amount','Reference','Narration'], rows: rows.map(row => [row.expense_number,row.expense_date,row.fy,row.party_name,row.account_name,row.payment_mode,row.amount,row.gst_rate,row.gst_amount,row.reference,row.narration]) };
  }
  if (reportId === 'credit_debit_note_register') {
    const params = [Number(orgId)];
    const period = reportPeriodWhere(query, 'note_date', params, { alias: 'n' });
    const rows = all(`SELECT n.note_number,n.note_date,n.fy,n.note_type,p.name party_name,b.bill_number linked_bill_number,pu.purchase_number linked_purchase_number,n.taxable_amount,n.tax_amount,n.grand_total,n.narration
      FROM credit_debit_notes n LEFT JOIN parties p ON p.id=n.party_id LEFT JOIN bills b ON b.id=n.linked_bill_id LEFT JOIN purchases pu ON pu.id=n.linked_purchase_id WHERE n.org_id=? AND n.deleted=0 AND ${period} ORDER BY n.note_date,n.id`, params);
    return { filename: 'credit-debit-note-register', headings: ['Note Number','Date','FY','Type','Party','Linked Bill','Linked Purchase','Taxable Amount','Tax Amount','Grand Total','Narration'], rows: rows.map(row => [row.note_number,row.note_date,row.fy,row.note_type,row.party_name,row.linked_bill_number,row.linked_purchase_number,row.taxable_amount,row.tax_amount,row.grand_total,row.narration]) };
  }
  if (reportId === 'receivables_ageing') {
    const rows = collectionRows(orgId, query.party_id).filter(row => !query.fy || String(row.fy) === String(query.fy));
    return { filename: 'receivables-ageing', headings: ['Invoice Number','Invoice Date','Due Date','Party','Phone','Outstanding','Age Days','Age Bucket','Credit Limit','Credit Hold','Hold Reason','Latest Follow-up','Follow-up Outcome','Promise Date','Follow-up Notes'], rows: rows.map(row => [row.bill_number,row.bill_date,row.due_date,row.party_name,row.party_phone,row.outstanding,row.age_days,row.age_bucket,row.credit_limit,row.on_hold ? 'Yes' : 'No',row.hold_reason,row.latest_follow_up?.follow_up_date || '',row.latest_follow_up?.outcome || '',row.latest_follow_up?.promise_date || '',row.latest_follow_up?.notes || '']) };
  }
  if (reportId === 'stock_summary') {
    const rows = all(`SELECT i.item_code,i.name,i.category,i.unit,i.hsn_code,i.opening_stock,i.reorder_level,
      COALESCE(SUM(sm.qty_in),0) qty_in,COALESCE(SUM(sm.qty_out),0) qty_out,
      ROUND(COALESCE(i.opening_stock,0)+COALESCE(SUM(sm.qty_in),0)-COALESCE(SUM(sm.qty_out),0),2) current_stock
      FROM items i LEFT JOIN stock_movements sm ON sm.item_id=i.id AND sm.org_id=i.org_id
      WHERE i.org_id=? AND i.active=1 GROUP BY i.id ORDER BY i.name`, [Number(orgId)]);
    return { filename: 'stock-summary', headings: ['Item Code','Item Name','Category','Unit','HSN','Opening Stock','Stock In','Stock Out','Current Stock','Reorder Level'], rows: rows.map(row => [row.item_code,row.name,row.category,row.unit,row.hsn_code,row.opening_stock,row.qty_in,row.qty_out,row.current_stock,row.reorder_level]) };
  }
  if (reportId === 'stock_movement_register') {
    const params = [Number(orgId)];
    const period = reportPeriodWhere(query, 'movement_date', params, { alias: 'sm', allowFy: false });
    const rows = all(`SELECT sm.movement_date,sm.source_type,sm.ref_number,sm.qty_in,sm.qty_out,sm.rate,i.item_code,i.name item_name,i.unit
      FROM stock_movements sm JOIN items i ON i.id=sm.item_id WHERE sm.org_id=? AND ${period} ORDER BY sm.movement_date,sm.id`, params);
    return { filename: 'stock-movement-register', headings: ['Date','Source Type','Reference','Item Code','Item Name','Unit','Quantity In','Quantity Out','Rate'], rows: rows.map(row => [row.movement_date,row.source_type,row.ref_number,row.item_code,row.item_name,row.unit,row.qty_in,row.qty_out,row.rate]) };
  }
  if (reportId === 'cash_bank_book') {
    const params = [Number(orgId)];
    const period = reportPeriodWhere(query, 'entry_date', params, { alias: 'je' });
    const rows = all(`SELECT je.entry_date,je.voucher_type,je.voucher_number,a.name account_name,a.system_key,jl.debit,jl.credit,jl.narration
      FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id JOIN accounts a ON a.id=jl.account_id
      WHERE je.org_id=? AND je.deleted=0 AND a.system_key IN ('cash','bank') AND ${period} ORDER BY je.entry_date,je.id,jl.id`, params);
    return { filename: 'cash-bank-book', headings: ['Date','Voucher Type','Voucher Number','Account','Account Type','Debit','Credit','Narration'], rows: rows.map(row => [row.entry_date,row.voucher_type,row.voucher_number,row.account_name,row.system_key,row.debit,row.credit,row.narration]) };
  }
  if (reportId === 'gst_sales_register' || reportId === 'profitability_register') {
    const params = [Number(orgId)];
    const period = reportPeriodWhere(query, 'bill_date', params, { alias: 'b' });
    const rows = all(`SELECT b.bill_number,b.bill_date,b.fy,p.name party_name,p.gstin,b.taxable_amount,b.cgst,b.sgst,b.igst,b.total_tax,b.grand_total,b.cost_total
      FROM bills b LEFT JOIN parties p ON p.id=b.party_id WHERE b.org_id=? AND b.format IN ('SALE','PP') AND b.deleted=0 AND b.status='saved' AND ${period} ORDER BY b.bill_date,b.id`, params);
    if (reportId === 'gst_sales_register') return { filename: 'gst-sales-register', headings: ['Invoice Number','Date','FY','Party','GSTIN','Taxable Amount','CGST','SGST','IGST','Total Tax','Grand Total'], rows: rows.map(row => [row.bill_number,row.bill_date,row.fy,row.party_name,row.gstin,row.taxable_amount,row.cgst,row.sgst,row.igst,row.total_tax,row.grand_total]) };
    return { filename: 'profitability-register', headings: ['Invoice Number','Date','FY','Party','Revenue','Recorded Cost','Gross Margin','Margin %'], rows: rows.map(row => { const revenue=Number(row.grand_total||0); const cost=Number(row.cost_total||0); const margin=revenue-cost; return [row.bill_number,row.bill_date,row.fy,row.party_name,revenue,cost,margin,revenue ? Number((margin/revenue*100).toFixed(2)) : 0]; }) };
  }
  if (reportId === 'party_master') {
    const rows = all(`SELECT DISTINCT p.id,p.name,p.registered_name,p.type,p.phone,p.email,p.gstin,p.gst_type,p.address,p.city,p.state,p.pincode,p.opening_balance,p.balance_type,p.active
      FROM parties p LEFT JOIN party_org_links pol ON pol.party_id=p.id AND pol.org_id=?
      WHERE (p.org_id=? OR pol.org_id=?) ORDER BY p.name`, [Number(orgId), Number(orgId), Number(orgId)]);
    return { filename: 'party-master', headings: ['Party ID','Name','Registered Name','Type','Phone','Email','GSTIN','GST Type','Address','City','State','Pincode','Opening Balance','Balance Type','Active'], rows: rows.map(row => [row.id,row.name,row.registered_name,row.type,row.phone,row.email,row.gstin,row.gst_type,row.address,row.city,row.state,row.pincode,row.opening_balance,row.balance_type,row.active ? 'Yes' : 'No']) };
  }
  return null;
}

reportsRouter.get('/catalog', (req, res) => {
  const orgId = Number(req.query.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  res.json({ reports: REPORT_CATALOG, export_format: 'CSV', generated_at: new Date().toISOString() });
});

reportsRouter.get('/export/:reportId', (req, res) => {
  const orgId = Number(req.query.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  if (!REPORT_CATALOG.some(report => report.id === req.params.reportId)) return res.status(404).json({ error: 'Unknown report export' });
  try {
    const report = exportReportRows(req.params.reportId, orgId, req.query);
    if (!report) return res.status(404).json({ error: 'Report export is not available' });
    sendCsv(res, `${report.filename}-${req.query.fy || new Date().toISOString().slice(0, 10)}`, report.headings, report.rows);
  } catch (error) {
    console.error('Report export error:', error.message);
    res.status(500).json({ error: 'Could not build the report export' });
  }
});

reportsRouter.get('/print/:reportId', (req, res) => {
  const orgId = Number(req.query.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  if (!REPORT_CATALOG.some(report => report.id === req.params.reportId)) return res.status(404).json({ error: 'Unknown report print view' });
  try {
    const report = exportReportRows(req.params.reportId, orgId, req.query);
    if (!report) return res.status(404).json({ error: 'Report print view is not available' });
    const org = get('SELECT display_name,registered_name FROM orgs WHERE id=?', [orgId]);
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(printableReportHtml(report, org, req.query));
  } catch (error) {
    console.error('Report print error:', error.message);
    res.status(500).json({ error: 'Could not build the report print view' });
  }
});

reportsRouter.get('/collections', (req, res) => {
  const orgId = Number(req.query.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  const rows = collectionRows(orgId, req.query.party_id);
  res.json({ generated_at: new Date().toISOString(), summary: receivableSummary(rows), rows });
});

reportsRouter.get('/collections/followups', (req, res) => {
  const orgId = Number(req.query.org_id);
  const partyId = Number(req.query.party_id);
  if (!orgId || !partyId) return res.status(400).json({ error: 'org_id and party_id required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  const params = [orgId, partyId];
  let billWhere = '';
  if (req.query.bill_id) { billWhere = ' AND cf.bill_id=?'; params.push(Number(req.query.bill_id)); }
  const rows = all(`SELECT cf.*,u.name created_by_name,u.username created_by_username
    FROM party_collection_followups cf LEFT JOIN users u ON u.id=cf.created_by
    WHERE cf.org_id=? AND cf.party_id=?${billWhere} ORDER BY cf.created_at DESC,cf.id DESC`, params);
  res.json(rows);
});

reportsRouter.post('/collections/followups', (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access is required for collection follow-ups' });
  const orgId = Number(req.body.org_id);
  const partyId = Number(req.body.party_id);
  const billId = req.body.bill_id ? Number(req.body.bill_id) : null;
  if (!orgId || !partyId) return res.status(400).json({ error: 'Company and party are required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  if (!partyForOrg(partyId, orgId)) return res.status(400).json({ error: 'Party does not belong to this company' });
  if (billId && !get(`SELECT id FROM bills WHERE id=? AND org_id=? AND party_id=? AND deleted=0`, [billId, orgId, partyId])) {
    return res.status(400).json({ error: 'Invoice does not belong to the selected party in this company' });
  }
  const outcomes = ['OPEN', 'PROMISE_TO_PAY', 'PAID_CONFIRMED', 'NO_RESPONSE', 'DISPUTED', 'ESCALATED'];
  const outcome = String(req.body.outcome || 'OPEN').toUpperCase();
  const notes = String(req.body.notes || '').trim().slice(0, 1500);
  if (!outcomes.includes(outcome)) return res.status(400).json({ error: 'Invalid collection outcome' });
  if (notes.length < 3) return res.status(400).json({ error: 'Enter a short follow-up note' });
  const followUpDate = safeReportDate(req.body.follow_up_date) || new Date().toISOString().slice(0, 10);
  const nextFollowUp = safeReportDate(req.body.next_follow_up_date);
  const promiseDate = safeReportDate(req.body.promise_date);
  const result = run(`INSERT INTO party_collection_followups
    (org_id,party_id,bill_id,follow_up_date,next_follow_up_date,outcome,promised_amount,promise_date,notes,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [orgId, partyId, billId, followUpDate, nextFollowUp, outcome, Math.max(0, Number(req.body.promised_amount || 0)), promiseDate, notes, req.user.id]);
  run(`INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address)
    VALUES (?,?,?,?,?,?,?)`, [req.user.id, orgId, 'COLLECTION_FOLLOW_UP', 'party_collection_followups', result.lastInsertRowid,
    JSON.stringify({ party_id: partyId, bill_id: billId, outcome, follow_up_date: followUpDate, next_follow_up_date: nextFollowUp, promised_amount: Number(req.body.promised_amount || 0) }), req.ip]);
  res.json({ success: true, id: result.lastInsertRowid });
});

reportsRouter.get('/credit-policies', (req, res) => {
  const orgId = Number(req.query.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  const rows = all(`WITH allocations AS (SELECT bill_id,SUM(amount) paid FROM payment_allocations GROUP BY bill_id),
    exposure AS (SELECT b.party_id,SUM(b.grand_total-COALESCE(a.paid,0)) outstanding FROM bills b LEFT JOIN allocations a ON a.bill_id=b.id
      WHERE b.org_id=? AND b.format IN ('SALE','PP') AND b.payment_mode='credit' AND b.deleted=0 AND b.status='saved' GROUP BY b.party_id)
    SELECT DISTINCT p.id party_id,p.name,p.phone,p.type,COALESCE(cp.credit_limit,0) credit_limit,COALESCE(cp.credit_days,0) credit_days,
      COALESCE(cp.on_hold,0) on_hold,COALESCE(cp.hold_reason,'') hold_reason,COALESCE(e.outstanding,0) outstanding,cp.updated_at
    FROM parties p LEFT JOIN party_org_links pol ON pol.party_id=p.id AND pol.org_id=?
      LEFT JOIN party_credit_policies cp ON cp.org_id=? AND cp.party_id=p.id LEFT JOIN exposure e ON e.party_id=p.id
    WHERE p.active=1 AND (p.org_id=? OR pol.org_id=?) ORDER BY p.name`, [orgId, orgId, orgId, orgId, orgId]);
  res.json(rows.map(row => ({ ...row, credit_limit: Number(row.credit_limit || 0), credit_days: Number(row.credit_days || 0), on_hold: Number(row.on_hold || 0), outstanding: Number(row.outstanding || 0) })));
});

reportsRouter.put('/credit-policies/:partyId', (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access is required to change credit policy' });
  const orgId = Number(req.body.org_id);
  const partyId = Number(req.params.partyId);
  if (!orgId || !partyId) return res.status(400).json({ error: 'Company and party are required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  if (!partyForOrg(partyId, orgId)) return res.status(400).json({ error: 'Party does not belong to this company' });
  const creditLimit = Math.max(0, Math.min(999999999999, Number(req.body.credit_limit || 0)));
  const creditDays = Math.max(0, Math.min(3650, Math.floor(Number(req.body.credit_days || 0))));
  const onHold = req.body.on_hold ? 1 : 0;
  const holdReason = String(req.body.hold_reason || '').trim().slice(0, 500);
  if (onHold && holdReason.length < 5) return res.status(400).json({ error: 'Explain why this party is on credit hold' });
  run(`INSERT INTO party_credit_policies (org_id,party_id,credit_limit,credit_days,on_hold,hold_reason,updated_by,updated_at)
    VALUES (?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(org_id,party_id) DO UPDATE SET
      credit_limit=excluded.credit_limit,credit_days=excluded.credit_days,on_hold=excluded.on_hold,hold_reason=excluded.hold_reason,
      updated_by=excluded.updated_by,updated_at=datetime('now')`, [orgId, partyId, creditLimit, creditDays, onHold, holdReason, req.user.id]);
  run(`INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address)
    VALUES (?,?,?,?,?,?,?)`, [req.user.id, orgId, 'PARTY_CREDIT_POLICY', 'party_credit_policies', partyId,
    JSON.stringify({ party_id: partyId, credit_limit: creditLimit, credit_days: creditDays, on_hold: onHold, hold_reason: holdReason }), req.ip]);
  res.json({ success: true, policy: { org_id: orgId, party_id: partyId, credit_limit: creditLimit, credit_days: creditDays, on_hold: onHold, hold_reason: holdReason } });
});

reportsRouter.get('/party-statement', (req, res) => {
  const { party_id, org_id, fy } = req.query;
  if (!party_id) return res.status(400).json({ error: 'party_id required' });

  const targetOrgId = Number(org_id || 0);
  const party = targetOrgId
    ? partyForOrg(party_id, targetOrgId)
    : get('SELECT * FROM parties WHERE id=? AND active=1', [party_id]);
  if (!party) return res.status(404).json({ error: 'Party not found' });
  const statementOrgId = targetOrgId || Number(party.org_id);
  if (!requireOrgAccess(req, res, statementOrgId)) return;
  let billSql = `SELECT id, bill_number as ref_number, bill_date as date, format, grand_total as amount, payment_mode, status FROM bills WHERE party_id=? AND deleted=0`;
  const params = [party_id];
  if (statementOrgId) { billSql += ' AND org_id=?'; params.push(statementOrgId); }
  if (fy) { billSql += ' AND fy=?'; params.push(fy); }

  const bills = all(billSql + ' ORDER BY bill_date', params);
  let paymentSql = `SELECT id, payment_number as ref_number, payment_date as date, type, amount, mode
    FROM payments WHERE party_id=? AND org_id=? AND deleted=0`;
  const paymentParams = [party_id, statementOrgId];
  if (fy) { paymentSql += ' AND fy=?'; paymentParams.push(fy); }
  const payments = all(paymentSql + ' ORDER BY payment_date', paymentParams);

  // Earlier records become the opening balance, keeping the selected year clean.
  let openingBalance = partyOpeningBalance(party, statementOrgId);
  const fyStart = financialYearStart(fy);
  if (fyStart) {
    const priorBills = get(
      `SELECT COALESCE(SUM(CASE WHEN format IN ('SALE','PP','PI') THEN grand_total ELSE 0 END),0) total
       FROM bills WHERE party_id=? AND org_id=? AND deleted=0 AND bill_date<?`,
      [party_id, statementOrgId, fyStart]
    );
    const priorPayments = get(
      `SELECT COALESCE(SUM(CASE WHEN type='received' THEN amount ELSE 0 END),0) total
       FROM payments WHERE party_id=? AND org_id=? AND deleted=0 AND payment_date<?`,
      [party_id, statementOrgId, fyStart]
    );
    openingBalance += Number(priorBills?.total || 0) - Number(priorPayments?.total || 0);
  }

  // Merge and sort by date
  const entries = [
    ...bills.map(b => ({ ...b, entry_type: 'bill', debit: ['SALE','PP','PI'].includes(b.format) ? b.amount : 0, credit: 0 })),
    ...payments.map(p => ({ ...p, entry_type: 'payment', debit: 0, credit: p.type === 'received' ? p.amount : 0 }))
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  let balance = openingBalance;
  entries.forEach(e => {
    balance += (e.debit || 0) - (e.credit || 0);
    e.balance = balance;
    e.balance_type = balance >= 0 ? 'Dr' : 'Cr';
    e.balance_display = Math.abs(balance);
  });

  res.json({ party, fy: fy || null, opening_balance: openingBalance, entries, closing_balance: balance });
});

reportsRouter.get('/sales-monthly', (req, res) => {
  const { org_id, fy } = req.query;
  const months = all(`SELECT strftime('%m-%Y',bill_date) as period, COALESCE(SUM(grand_total),0) as total,
    COUNT(*) as count FROM bills WHERE org_id=? AND format IN ('SALE','PP') AND fy=? AND deleted=0
    GROUP BY period ORDER BY bill_date`, [org_id, fy]);
  res.json(months);
});

reportsRouter.get('/invoice-status', (req, res) => {
  const rows = all(
    `SELECT b.*,p.name party_name
     FROM bills b LEFT JOIN parties p ON p.id=b.party_id
     WHERE b.org_id=? AND b.format IN ('SALE','PP') AND b.deleted=0 AND b.status='saved'
     ORDER BY b.bill_date DESC,b.id DESC`,
    [req.query.org_id]
  ).map(row => ({ ...row, ...billSettlement(row) }));
  res.json(rows);
});

reportsRouter.get('/gst', (req, res) => {
  const { org_id, fy } = req.query;
  const sales = all(
    `SELECT b.bill_number,b.bill_date,p.gstin,p.name party_name,b.taxable_amount,b.cgst,b.sgst,b.igst,b.total_tax,b.grand_total
     FROM bills b LEFT JOIN parties p ON p.id=b.party_id
     WHERE b.org_id=? AND b.fy=? AND b.format IN ('SALE','PP') AND b.deleted=0 AND b.status='saved'
     ORDER BY b.bill_date,b.id`, [org_id, fy]
  );
  const purchases = all(
    `SELECT purchase_number,purchase_date,taxable_amount,cgst,sgst,igst,total_tax,grand_total
     FROM purchases WHERE org_id=? AND fy=? AND deleted=0 ORDER BY purchase_date,id`, [org_id, fy]
  );
  const hsn = all(
    `SELECT json_extract(j.value,'$.hsn_code') hsn,
      SUM(CAST(json_extract(j.value,'$.qty') AS REAL)) quantity,
      SUM(CAST(json_extract(j.value,'$.amount') AS REAL)) taxable
     FROM bills b,json_each(b.items_json) j
     WHERE b.org_id=? AND b.fy=? AND b.format IN ('SALE','PP') AND b.deleted=0
     GROUP BY hsn ORDER BY hsn`, [org_id, fy]
  );
  const outputTax = sales.reduce((sum, row) => sum + Number(row.total_tax || 0), 0);
  const inputTax = purchases.reduce((sum, row) => sum + Number(row.total_tax || 0), 0);
  res.json({
    gstr1: sales,
    gstr3b: {
      taxable_sales: roundSum(sales, 'taxable_amount'),
      output_tax: roundValue(outputTax),
      taxable_purchases: roundSum(purchases, 'taxable_amount'),
      input_tax_credit: roundValue(inputTax),
      net_tax_payable: roundValue(outputTax - inputTax)
    },
    hsn
  });
});

function gstJsonPayload(orgId, fy) {
  const org = get('SELECT * FROM orgs WHERE id=?', [orgId]);
  const sales = all(
    `SELECT b.bill_number,b.bill_date,b.taxable_amount,b.cgst,b.sgst,b.igst,b.total_tax,b.grand_total,
      p.gstin,p.name party_name,b.items_json
     FROM bills b LEFT JOIN parties p ON p.id=b.party_id
     WHERE b.org_id=? AND b.fy=? AND b.format IN ('SALE','PP') AND b.deleted=0 AND b.status='saved'
     ORDER BY b.bill_date,b.id`, [orgId, fy]
  );
  const purchases = all(
    `SELECT pu.purchase_number,pu.supplier_invoice,pu.purchase_date,pu.taxable_amount,pu.cgst,pu.sgst,
      pu.igst,pu.total_tax,pu.grand_total,p.gstin,p.name supplier_name
     FROM purchases pu LEFT JOIN parties p ON p.id=pu.party_id
     WHERE pu.org_id=? AND pu.fy=? AND pu.deleted=0 ORDER BY pu.purchase_date,pu.id`, [orgId, fy]
  );
  return { org, sales, purchases };
}

const GST_STATE_CODES = {
  'Jammu and Kashmir': '01', 'Himachal Pradesh': '02', Punjab: '03', Chandigarh: '04',
  Uttarakhand: '05', Haryana: '06', Delhi: '07', Rajasthan: '08', 'Uttar Pradesh': '09',
  Bihar: '10', Sikkim: '11', 'Arunachal Pradesh': '12', Nagaland: '13', Manipur: '14',
  Mizoram: '15', Tripura: '16', Meghalaya: '17', Assam: '18', 'West Bengal': '19',
  Jharkhand: '20', Odisha: '21', Chhattisgarh: '22', 'Madhya Pradesh': '23', Gujarat: '24',
  'Daman and Diu': '25', 'Dadra and Nagar Haveli and Daman and Diu': '26',
  Maharashtra: '27', 'Andhra Pradesh (Old)': '28', Karnataka: '29', Goa: '30',
  Lakshadweep: '31', Kerala: '32', 'Tamil Nadu': '33', Puducherry: '34',
  'Andaman and Nicobar Islands': '35', Telangana: '36', 'Andhra Pradesh': '37',
  Ladakh: '38', 'Other Territory': '97', 'Centre Jurisdiction': '99'
};

const GST_CODEPOINTS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function validGstin(value) {
  const gstin = String(value || '').trim().toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(gstin)) return false;
  let factor = 1;
  let sum = 0;
  for (let index = 0; index < 14; index += 1) {
    const product = factor * GST_CODEPOINTS.indexOf(gstin[index]);
    factor = factor === 2 ? 1 : 2;
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GST_CODEPOINTS[(36 - (sum % 36)) % 36] === gstin[14];
}

function gstPortalDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : '';
}

function gstReturnPeriod(period) {
  const match = String(period || '').match(/^(\d{4})-(\d{2})$/);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return '';
  return `${match[2]}${match[1]}`;
}

function gstStateCode(party, supplierCode) {
  const recipientCode = String(party?.gstin || '').slice(0, 2);
  if (/^\d{2}$/.test(recipientCode)) return recipientCode;
  const normalized = String(party?.state || '').trim().toLowerCase();
  const state = Object.entries(GST_STATE_CODES)
    .find(([name]) => name.toLowerCase() === normalized);
  return state?.[1] || supplierCode;
}

function gstInvoiceLines(row, errors) {
  let items;
  try { items = JSON.parse(row.items_json || '[]'); }
  catch (_) {
    errors.push(`Invoice ${row.bill_number}: item data is not valid JSON`);
    return [];
  }
  if (!items.length) {
    errors.push(`Invoice ${row.bill_number}: no invoice items`);
    return [];
  }
  const subtotal = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  if (subtotal <= 0) {
    errors.push(`Invoice ${row.bill_number}: taxable item value must be greater than zero`);
    return [];
  }
  const taxableFactor = Number(row.taxable_amount || 0) / subtotal;
  const grouped = new Map();
  items.forEach(item => {
    const hsn = String(item.hsn_code || '').replace(/\s+/g, '');
    const rate = Number(item.gst_rate ?? row.tax_rate ?? 0);
    if (!/^\d{4}(\d{2})?(\d{2})?$/.test(hsn)) {
      errors.push(`Invoice ${row.bill_number}: invalid or missing HSN/SAC for ${item.item_name || 'item'}`);
    }
    if (!Number.isFinite(rate) || rate < 0) {
      errors.push(`Invoice ${row.bill_number}: invalid GST rate for ${item.item_name || 'item'}`);
    }
    const key = String(rate);
    const line = grouped.get(key) || {
      rt: rate, txval: 0, qty: 0, hsnRows: []
    };
    const txval = Number(item.amount || 0) * taxableFactor;
    line.txval += txval;
    line.qty += Number(item.qty || 0);
    line.hsnRows.push({
      hsn, rate, txval, qty: Number(item.qty || 0),
      uqc: String(item.unit || 'NOS').toUpperCase(),
      description: String(item.item_description || item.item_name || '').slice(0, 30)
    });
    grouped.set(key, line);
  });

  const totalTaxable = Number(row.taxable_amount || 0);
  const totalCgst = Number(row.cgst || 0);
  const totalSgst = Number(row.sgst || 0);
  const totalIgst = Number(row.igst || 0);
  const lines = Array.from(grouped.values());
  let allocatedTx = 0;
  let allocatedCgst = 0;
  let allocatedSgst = 0;
  let allocatedIgst = 0;
  return lines.map((line, index) => {
    const last = index === lines.length - 1;
    const txval = last ? roundValue(totalTaxable - allocatedTx) : roundValue(line.txval);
    const ratio = totalTaxable ? txval / totalTaxable : 0;
    const camt = last ? roundValue(totalCgst - allocatedCgst) : roundValue(totalCgst * ratio);
    const samt = last ? roundValue(totalSgst - allocatedSgst) : roundValue(totalSgst * ratio);
    const iamt = last ? roundValue(totalIgst - allocatedIgst) : roundValue(totalIgst * ratio);
    allocatedTx = roundValue(allocatedTx + txval);
    allocatedCgst = roundValue(allocatedCgst + camt);
    allocatedSgst = roundValue(allocatedSgst + samt);
    allocatedIgst = roundValue(allocatedIgst + iamt);
    return { rt: line.rt, txval, camt, samt, iamt, csamt: 0, hsnRows: line.hsnRows };
  });
}

function addHsnRows(target, lines, registered) {
  lines.forEach(line => line.hsnRows.forEach(item => {
    const key = `${item.hsn}|${item.rate}|${item.uqc}`;
    const current = target.get(key) || {
      hsn_sc: item.hsn, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0,
      desc: '', user_desc: item.description, uqc: item.uqc || 'NOS', qty: 0, rt: item.rate
    };
    current.txval += item.txval;
    current.qty += item.qty;
    const lineTaxable = line.hsnRows.reduce((sum, row) => sum + row.txval, 0);
    const ratio = lineTaxable ? item.txval / lineTaxable : 0;
    current.iamt += line.iamt * ratio;
    current.camt += line.camt * ratio;
    current.samt += line.samt * ratio;
    target.set(key, current);
  }));
}

function finalizeHsn(map) {
  return Array.from(map.values()).map((row, index) => ({
    num: index + 1, hsn_sc: row.hsn_sc, txval: roundValue(row.txval),
    iamt: roundValue(row.iamt), camt: roundValue(row.camt), samt: roundValue(row.samt),
    csamt: roundValue(row.csamt), desc: row.desc, user_desc: row.user_desc,
    uqc: row.uqc, qty: roundValue(row.qty), rt: row.rt
  }));
}

function buildPortalGstr1(orgId, period) {
  const fp = gstReturnPeriod(period);
  if (!fp) return { errors: ['Select a valid GSTR-1 month'] };
  const org = get('SELECT * FROM orgs WHERE id=?', [orgId]);
  if (!org) return { errors: ['Company not found'] };
  const errors = [];
  const gstin = String(org.gstin || '').trim().toUpperCase();
  if (org.gst_type !== 'regular') errors.push('GST Portal GSTR-1 export is available only for a Regular taxpayer');
  if (!validGstin(gstin)) errors.push('Company GSTIN is missing or invalid');
  const supplierCode = gstin.slice(0, 2);
  const sales = all(
    `SELECT b.*,p.gstin,p.gst_type party_gst_type,p.name party_name,p.state party_state
     FROM bills b LEFT JOIN parties p ON p.id=b.party_id
     WHERE b.org_id=? AND substr(b.bill_date,1,7)=? AND b.format IN ('SALE','PP')
       AND b.deleted=0 AND b.status='saved'
     ORDER BY b.bill_date,b.id`, [orgId, period]
  );
  const issued = all(
    `SELECT bill_number,bill_date,deleted,status FROM bills
     WHERE org_id=? AND substr(bill_date,1,7)=? AND format IN ('SALE','PP')
     ORDER BY bill_date,id`, [orgId, period]
  );
  if (!sales.length) errors.push(`No saved sales invoices found for ${period}`);

  const b2b = new Map();
  const b2cl = new Map();
  const b2cs = new Map();
  const hsnB2b = new Map();
  const hsnB2c = new Map();

  sales.forEach(row => {
    const recipientGstin = String(row.gstin || '').trim().toUpperCase();
    const registered = row.party_gst_type === 'regular' || Boolean(recipientGstin);
    if (registered && !validGstin(recipientGstin)) {
      errors.push(`Invoice ${row.bill_number}: registered customer GSTIN is missing or invalid`);
    }
    if (!/^[A-Za-z0-9/-]{1,16}$/.test(String(row.bill_number || ''))) {
      errors.push(`Invoice ${row.bill_number || '(blank)'}: invoice number must be 1-16 characters using letters, numbers, / or -`);
    }
    const idt = gstPortalDate(row.bill_date);
    if (!idt) errors.push(`Invoice ${row.bill_number}: invalid invoice date`);
    const lines = gstInvoiceLines(row, errors);
    const interstate = Number(row.igst || 0) > 0;
    const party = { gstin: recipientGstin, state: row.party_state };
    const pos = interstate ? gstStateCode(party, supplierCode) : supplierCode;
    const invoice = {
      inum: String(row.bill_number), idt, val: roundValue(row.grand_total),
      pos, rchrg: 'N', inv_typ: 'R',
      itms: lines.map((line, index) => ({
        num: index + 1,
        itm_det: {
          txval: line.txval, rt: line.rt, iamt: line.iamt,
          camt: line.camt, samt: line.samt, csamt: 0
        }
      }))
    };
    if (registered) {
      const group = b2b.get(recipientGstin) || [];
      group.push(invoice);
      b2b.set(recipientGstin, group);
      addHsnRows(hsnB2b, lines, true);
    } else {
      addHsnRows(hsnB2c, lines, false);
      if (interstate && Number(row.grand_total || 0) > 100000) {
        const group = b2cl.get(pos) || [];
        group.push(invoice);
        b2cl.set(pos, group);
      } else {
        lines.forEach(line => {
          const key = `${interstate ? 'INTER' : 'INTRA'}|${pos}|${line.rt}`;
          const summary = b2cs.get(key) || {
            typ: 'OE', sply_ty: interstate ? 'INTER' : 'INTRA', rt: line.rt,
            pos, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0
          };
          summary.txval += line.txval;
          summary.iamt += line.iamt;
          summary.camt += line.camt;
          summary.samt += line.samt;
          b2cs.set(key, summary);
        });
      }
    }
  });

  if (errors.length) return { errors: [...new Set(errors)] };
  const payload = {
    gstin, fp,
    b2b: Array.from(b2b, ([ctin, inv]) => ({ ctin, inv })),
    b2cs: Array.from(b2cs.values()).map(row => ({
      ...row, txval: roundValue(row.txval), iamt: roundValue(row.iamt),
      camt: roundValue(row.camt), samt: roundValue(row.samt), csamt: 0
    })),
    hsn: { hsn_b2b: finalizeHsn(hsnB2b), hsn_b2c: finalizeHsn(hsnB2c) },
    doc_issue: {
      doc_det: [{
        doc_num: 1,
        docs: [{
          cancel: issued.filter(row => row.deleted || row.status === 'cancelled').length,
          from: String(issued[0]?.bill_number || ''),
          net_issue: sales.length,
          num: 1,
          to: String(issued[issued.length - 1]?.bill_number || ''),
          totnum: issued.length
        }]
      }]
    }
  };
  if (b2cl.size) payload.b2cl = Array.from(b2cl, ([pos, inv]) => ({ pos, inv }));
  return { payload };
}

function buildEinvoicePreflight(billId) {
  const row = get(`SELECT b.*,p.name party_name,p.gstin party_gstin,p.gst_type party_gst_type,
      p.address party_address,p.state party_state,p.pincode party_pincode
    FROM bills b LEFT JOIN parties p ON p.id=b.party_id
    WHERE b.id=? AND b.deleted=0`, [billId]);
  if (!row) return { errors: ['Active invoice was not found'] };
  const org = get('SELECT * FROM orgs WHERE id=? AND active=1', [row.org_id]);
  if (!org) return { errors: ['Company was not found'] };
  const errors = [];
  const sellerGstin = String(org.gstin || '').trim().toUpperCase();
  const buyerGstin = String(row.party_gstin || '').trim().toUpperCase();
  if (org.gst_type !== 'regular') errors.push('E-invoice preflight requires a Regular taxpayer company');
  if (!validGstin(sellerGstin)) errors.push('Company GSTIN is missing or invalid');
  if (!/^[A-Za-z0-9/-]{1,16}$/.test(String(row.bill_number || ''))) {
    errors.push('Invoice number must be 1-16 characters using letters, numbers, / or -');
  }
  const invoiceDate = gstPortalDate(row.bill_date);
  if (!invoiceDate) errors.push('Invoice date is invalid');
  if (row.format !== 'SALE' && row.format !== 'PP') errors.push('Only Sale or Proforma-to-Sale invoices are eligible');
  const lines = gstInvoiceLines(row, errors);
  if (row.party_id && row.party_gst_type === 'regular' && !validGstin(buyerGstin)) {
    errors.push('Registered buyer GSTIN is missing or invalid');
  }
  let items = [];
  try { items = JSON.parse(row.items_json || '[]'); } catch (_) {}
  const transport = parseJson(row.delivery_info || '{}', {});
  const payload = {
    schema: 'TARANGINI_EINVOICE_PREFLIGHT_V1',
    live_submission: false,
    document: { number: row.bill_number, date: invoiceDate, type: 'INV', category: 'REG' },
    seller: { gstin: sellerGstin, legal_name: org.registered_name || org.display_name, state: org.state || '' },
    buyer: { gstin: buyerGstin, name: row.party_name || 'Cash Customer', state: row.party_state || '', pincode: row.party_pincode || '' },
    values: {
      taxable_value: roundValue(row.taxable_amount),
      cgst: roundValue(row.cgst), sgst: roundValue(row.sgst), igst: roundValue(row.igst),
      total_tax: roundValue(row.total_tax), total_value: roundValue(row.grand_total)
    },
    items: items.map((item, index) => ({
      number: index + 1,
      description: String(item.item_description || item.item_name || '').slice(0, 300),
      hsn_sac: String(item.hsn_code || '').replace(/\s+/g, ''),
      quantity: Number(item.qty || 0), unit: String(item.unit || 'NOS').toUpperCase(),
      taxable_value: roundValue(item.amount), gst_rate: Number(item.gst_rate || 0)
    })),
    transport: {
      transporter_name: String(transport.transport_name || '').slice(0, 100),
      transport_document_number: String(transport.tracking_id || '').slice(0, 50),
      vehicle_number: String(transport.vehicle_number || '').slice(0, 20),
      distance_km: Number(transport.distance_km || 0)
    }
  };
  return {
    ready: errors.length === 0,
    errors: [...new Set(errors)],
    live_submission: false,
    credentials: {
      configured: Boolean(process.env.GST_GSP_BASE_URL && process.env.GST_GSP_CLIENT_ID && process.env.GST_GSP_CLIENT_SECRET),
      base_url_configured: Boolean(process.env.GST_GSP_BASE_URL),
      client_id_configured: Boolean(process.env.GST_GSP_CLIENT_ID),
      secret_configured: Boolean(process.env.GST_GSP_CLIENT_SECRET)
    },
    payload
  };
}

reportsRouter.get('/gst/einvoice/preflight', (req, res) => {
  const billId = Number(req.query.bill_id || 0);
  if (!billId) return res.status(400).json({ error: 'bill_id is required' });
  const bill = get('SELECT org_id FROM bills WHERE id=? AND deleted=0', [billId]);
  if (!bill || !requireOrgAccess(req, res, bill.org_id)) return;
  const result = buildEinvoicePreflight(billId);
  res.status(result.ready ? 200 : 422).json(result);
});

reportsRouter.get('/gst/ewaybill/preflight', (req, res) => {
  const billId = Number(req.query.bill_id || 0);
  if (!billId) return res.status(400).json({ error: 'bill_id is required' });
  const bill = get('SELECT org_id,format,bill_number,grand_total,delivery_info FROM bills WHERE id=? AND deleted=0', [billId]);
  if (!bill || !requireOrgAccess(req, res, bill.org_id)) return;
  let delivery = parseJson(bill.delivery_info || '{}', {});
  const distanceKm = Number(req.query.distance_km || delivery.distance_km || 0);
  const vehicleNumber = String(req.query.vehicle_number || delivery.vehicle_number || '').trim().toUpperCase();
  const transporterDocNumber = String(
    req.query.transporter_doc_number || delivery.tracking_id || delivery.transport_document_number || ''
  ).trim();
  const errors = [];
  if (!['SALE', 'PP', 'DC'].includes(String(bill.format || '').toUpperCase())) {
    errors.push('Only Sale, Proforma-to-Sale, or Delivery Challan documents can be reviewed for e-way bill preparation');
  }
  if (!Number.isFinite(distanceKm) || distanceKm < 0) errors.push('Distance must be zero or a positive number of kilometres');
  if (!vehicleNumber && !transporterDocNumber) errors.push('Vehicle number or transporter document number is required');
  const result = {
    ready: errors.length === 0,
    errors,
    live_submission: false,
    manual_review_required: true,
    credentials: {
      configured: Boolean(process.env.GST_GSP_BASE_URL && process.env.GST_GSP_CLIENT_ID && process.env.GST_GSP_CLIENT_SECRET),
      base_url_configured: Boolean(process.env.GST_GSP_BASE_URL),
      client_id_configured: Boolean(process.env.GST_GSP_CLIENT_ID),
      secret_configured: Boolean(process.env.GST_GSP_CLIENT_SECRET)
    },
    payload: {
      schema: 'TARANGINI_EWAYBILL_PREFLIGHT_V1',
      live_submission: false,
      document: { number: bill.bill_number, type: String(bill.format || '').toUpperCase(), value: roundValue(bill.grand_total) },
      movement: {
        distance_km: distanceKm,
        vehicle_number: vehicleNumber,
        transporter_document_number: transporterDocNumber,
        transporter_name: String(req.query.transporter_name || delivery.transport_name || '').slice(0, 100)
      }
    }
  };
  res.status(result.ready ? 200 : 422).json(result);
});

reportsRouter.get('/gst/export', (req, res) => {
  const { org_id, fy, period, type = 'gstr1' } = req.query;
  const { org, sales, purchases } = gstJsonPayload(org_id, fy);
  if (!org) return res.status(404).json({ error: 'Company not found' });
  const generatedAt = new Date().toISOString();
  let payload;
  if (type === 'gstr3b') {
    const outputTax = roundSum(sales, 'total_tax');
    const inputTax = roundSum(purchases, 'total_tax');
    payload = {
      format: 'TARANGINI_GSTR3B_JSON_V1', gstin: org.gstin || '', fy, generated_at: generatedAt,
      outward_supplies: {
        taxable_value: roundSum(sales, 'taxable_amount'),
        igst: roundSum(sales, 'igst'), cgst: roundSum(sales, 'cgst'), sgst: roundSum(sales, 'sgst'),
        total_tax: outputTax
      },
      inward_supplies: {
        taxable_value: roundSum(purchases, 'taxable_amount'),
        igst: roundSum(purchases, 'igst'), cgst: roundSum(purchases, 'cgst'), sgst: roundSum(purchases, 'sgst'),
        input_tax_credit: inputTax
      },
      net_tax_payable: roundValue(outputTax - inputTax)
    };
  } else {
    const result = buildPortalGstr1(org_id, period);
    if (result.errors) {
      return res.status(400).json({
        error: 'GSTR-1 export validation failed',
        details: result.errors
      });
    }
    payload = result.payload;
  }
  const stamp = generatedAt.replace(/\D/g, '').slice(0, 14);
  const filePeriod = type === 'gstr1' ? gstReturnPeriod(period) : fy;
  res.setHeader('Content-Disposition', `attachment; filename="${org.gstin || 'GST'}_${type.toUpperCase()}_${filePeriod}_${stamp}.json"`);
  res.type('application/json').send(JSON.stringify(payload, null, 2));
});

reportsRouter.get('/tally/regular-parties.xml', (req, res) => {
  const orgId = Number(req.query.org_id);
  if (!orgId) return res.status(400).json({ error: 'Company is required' });
  const org = get('SELECT * FROM orgs WHERE id=? AND active=1', [orgId]);
  if (!org) return res.status(404).json({ error: 'Company not found' });
  const tallyCompany = String(req.query.tally_company || org.registered_name || org.display_name || '').trim();
  if (!tallyCompany) return res.status(400).json({ error: 'Tally company name is required' });

  const parties = all(
    `SELECT * FROM parties
     WHERE active=1 AND gst_type='regular' AND TRIM(COALESCE(gstin,''))<>''
       AND (org_id=? OR shared=1 OR id IN (SELECT party_id FROM party_org_links WHERE org_id=?))
       AND type IN ('customer','supplier','both')
     ORDER BY type,name`,
    [orgId, orgId]
  );
  const ledgers = [];
  parties.forEach(party => {
    const roles = party.type === 'both'
      ? [
          { parent: 'Sundry Debtors', suffix: ' - Customer' },
          { parent: 'Sundry Creditors', suffix: ' - Vendor' }
        ]
      : [{ parent: party.type === 'supplier' ? 'Sundry Creditors' : 'Sundry Debtors', suffix: '' }];
    roles.forEach(role => {
      const ledgerName = `${party.name}${role.suffix}`;
      ledgers.push(`<TALLYMESSAGE xmlns:UDF="TallyUDF">
  <LEDGER NAME="${xmlEscape(ledgerName)}" ACTION="Create">
    <NAME>${xmlEscape(ledgerName)}</NAME>
    <PARENT>${role.parent}</PARENT>
    <ISBILLWISEON>Yes</ISBILLWISEON>
    <AFFECTSSTOCK>No</AFFECTSSTOCK>
    <MAILINGNAME>${xmlEscape(party.registered_name || party.name)}</MAILINGNAME>
    <ADDRESS.LIST TYPE="String">
      <ADDRESS>${xmlEscape(party.address || '')}</ADDRESS>
      <ADDRESS>${xmlEscape([party.city, party.pincode].filter(Boolean).join(' - '))}</ADDRESS>
    </ADDRESS.LIST>
    <COUNTRYNAME>India</COUNTRYNAME>
    <STATENAME>${xmlEscape(party.state || '')}</STATENAME>
    <PINCODE>${xmlEscape(party.pincode || '')}</PINCODE>
    <GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>
    <PARTYGSTIN>${xmlEscape(String(party.gstin).toUpperCase())}</PARTYGSTIN>
    <LEDGERPHONE>${xmlEscape(party.phone || '')}</LEDGERPHONE>
    <EMAIL>${xmlEscape(party.email || '')}</EMAIL>
  </LEDGER>
</TALLYMESSAGE>`);
    });
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${xmlEscape(tallyCompany)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
${ledgers.join('\n')}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
  const safeName = tallyCompany.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'tally-company';
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}-regular-gst-parties.xml"`);
  res.setHeader('X-Tarangini-Ledger-Count', String(ledgers.length));
  res.type('application/xml').send(xml);
});

function findInvoiceRows(value, rows = []) {
  if (Array.isArray(value)) {
    value.forEach(item => findInvoiceRows(item, rows));
  } else if (value && typeof value === 'object') {
    const invoiceNumber = value.invoice_number || value.inum || value.inv_num || value.invoiceNo;
    const gstin = value.supplier_gstin || value.gstin || value.ctin || value.supplierGstin;
    if (invoiceNumber || (gstin && (value.taxable_amount || value.txval || value.val))) rows.push(value);
    else Object.values(value).forEach(item => findInvoiceRows(item, rows));
  }
  return rows;
}

reportsRouter.post('/gst/gstr2b/import', (req, res) => {
  const { org_id, fy, file_name, json } = req.body;
  if (!org_id || !fy || !json) return res.status(400).json({ error: 'Company, financial year and JSON are required' });
  const sourceRows = findInvoiceRows(json);
  if (!sourceRows.length) return res.status(400).json({ error: 'No invoice rows found in the supplied GSTR-2B JSON' });
  const importResult = run(
    `INSERT INTO gstr2b_imports (org_id,fy,file_name,imported_by) VALUES (?,?,?,?)`,
    [org_id, fy, file_name || 'gstr2b.json', req.user.id]
  );
  sourceRows.forEach(row => {
    const taxable = Number(row.taxable_amount ?? row.txval ?? row.taxableValue ?? 0);
    const igst = Number(row.igst ?? row.iamt ?? 0);
    const cgst = Number(row.cgst ?? row.camt ?? 0);
    const sgst = Number(row.sgst ?? row.samt ?? 0);
    const cess = Number(row.cess ?? row.csamt ?? 0);
    run(
      `INSERT INTO gstr2b_rows
       (import_id,org_id,fy,supplier_gstin,supplier_name,invoice_number,invoice_date,
        taxable_amount,igst,cgst,sgst,cess,total_tax,raw_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [importResult.lastInsertRowid, org_id, fy,
       row.supplier_gstin || row.gstin || row.ctin || row.supplierGstin || '',
       row.supplier_name || row.trdnm || row.supplierName || '',
       row.invoice_number || row.inum || row.inv_num || row.invoiceNo || '',
       row.invoice_date || row.idt || row.inv_date || row.invoiceDate || null,
       taxable, igst, cgst, sgst, cess, roundValue(igst + cgst + sgst + cess), JSON.stringify(row)]
    );
  });
  res.json({ success: true, import_id: importResult.lastInsertRowid, imported: sourceRows.length });
});

reportsRouter.get('/gst/gstr2b', (req, res) => {
  const rows = all(
    `SELECT g.*,
      pu.id purchase_id,pu.purchase_number,pu.taxable_amount book_taxable,pu.total_tax book_tax
     FROM gstr2b_rows g
     LEFT JOIN parties p ON p.org_id=g.org_id AND p.gstin=g.supplier_gstin
     LEFT JOIN purchases pu ON pu.org_id=g.org_id AND pu.party_id=p.id
       AND (pu.supplier_invoice=g.invoice_number OR pu.purchase_number=g.invoice_number) AND pu.deleted=0
     WHERE g.org_id=? AND g.fy=? ORDER BY g.invoice_date DESC,g.id DESC`,
    [req.query.org_id, req.query.fy]
  ).map(row => ({
    ...row,
    match_status: !row.purchase_id ? 'missing in books'
      : Math.abs(Number(row.taxable_amount) - Number(row.book_taxable)) <= 1 &&
        Math.abs(Number(row.total_tax) - Number(row.book_tax)) <= 1 ? 'matched' : 'value mismatch'
  }));
  res.json(rows);
});

function roundValue(value) { return Number(Number(value || 0).toFixed(2)); }
function roundSum(rows, key) { return roundValue(rows.reduce((sum, row) => sum + Number(row[key] || 0), 0)); }

module.exports = { paymentsRouter: router, reportsRouter };
