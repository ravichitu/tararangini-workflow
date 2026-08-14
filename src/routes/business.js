const express = require('express');
const router = express.Router();
const { get, run, all, transaction } = require('../db/db');
const {
  authMiddleware, checkOrgAccess, requirePermission, requireOrgAccess, rejectLockedPeriod, isPeriodLocked
} = require('../middleware/auth');
const {
  getFY, ensureAccounts, postPurchase, postExpense, postNote, removeSourceEntry
} = require('../accounting/accounting');
const {
  replaceStockMovements, replaceStockCountMovements, removeStockMovements, stockSummary
} = require('../business/stock');
const { defaultControl, parseJson } = require('../business/transaction-controls');
const { partyForOrg } = require('../business/parties');

router.use(authMiddleware);
router.use(checkOrgAccess);

function round(value) {
  return Number(Number(value || 0).toFixed(2));
}

function cleanText(value, limit = 500) {
  return String(value || '').trim().slice(0, limit);
}

function requireOwnerReason(req, res, action = 'change') {
  if (req.user.role !== 'owner') {
    res.status(403).json({ error: 'Owner access required' });
    return null;
  }
  const reason = cleanText(req.body.reason, 500);
  if (reason.length < 5) {
    res.status(400).json({ error: `Enter a reason of at least 5 characters to ${action} this transaction` });
    return null;
  }
  return reason;
}

function auditBusinessChange(req, row, tableName, action, reason, updatedRow = null) {
  run(
    `INSERT INTO audit_log
     (user_id,org_id,action,table_name,record_id,old_data,new_data,ip_address)
     VALUES (?,?,?,?,?,?,?,?)`,
    [req.user.id, row.org_id, action, tableName, row.id, JSON.stringify(row),
     JSON.stringify({ reason, transaction: updatedRow }), req.ip]
  );
}

function validCalendarDate(value) {
  const date = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function canEditStockCount(req, count) {
  return req.user.role === 'owner' || Number(count.created_by) === Number(req.user.id);
}

function nextStockCountNumber(orgId, countDate) {
  const fy = getFY(countDate);
  let sequence = get('SELECT * FROM bill_sequences WHERE org_id=? AND format=? AND fy=?', [orgId, 'SC', fy]);
  if (!sequence) {
    run('INSERT INTO bill_sequences (org_id,format,fy,prefix,last_number) VALUES (?,?,?,?,0)', [orgId, 'SC', fy, 'SC']);
    sequence = { last_number: 0 };
  }
  const next = Number(sequence.last_number || 0) + 1;
  run('UPDATE bill_sequences SET last_number=? WHERE org_id=? AND format=? AND fy=?', [next, orgId, 'SC', fy]);
  const org = get('SELECT display_name FROM orgs WHERE id=?', [orgId]);
  const code = String(org?.display_name || 'ORG').replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'ORG';
  return { fy, number: `${code}/SC/${fy}/${String(next).padStart(4, '0')}` };
}

function stockCountWithLines(countId) {
  const count = get(`SELECT sc.*,creator.name created_by_name,submitter.name submitted_by_name,approver.name approved_by_name
    FROM stock_counts sc
    LEFT JOIN users creator ON creator.id=sc.created_by
    LEFT JOIN users submitter ON submitter.id=sc.submitted_by
    LEFT JOIN users approver ON approver.id=sc.approved_by
    WHERE sc.id=?`, [countId]);
  if (!count) return null;
  const current = new Map(stockSummary(count.org_id).map(item => [Number(item.id), Number(item.current_stock || 0)]));
  const lines = all(`SELECT * FROM stock_count_lines WHERE count_id=? ORDER BY item_name_snapshot,item_id`, [countId]).map(line => {
    const liveQty = Number(current.get(Number(line.item_id)) || 0);
    return { ...line, live_qty: liveQty, snapshot_drift: round(liveQty - Number(line.system_qty || 0)) };
  });
  return {
    ...count,
    lines,
    summary: {
      total_lines: lines.length,
      counted_lines: lines.filter(line => line.counted_qty !== null && line.counted_qty !== undefined).length,
      variance_lines: lines.filter(line => Math.abs(Number(line.variance_qty || 0)) > 0.0001).length,
      variance_quantity: round(lines.reduce((sum, line) => sum + Number(line.variance_qty || 0), 0)),
      snapshot_drift_lines: lines.filter(line => Math.abs(Number(line.snapshot_drift || 0)) > 0.0001).length
    }
  };
}

function transactionPeriodLocked(row, dateField, fyField = 'fy') {
  const fy = row[fyField] || getFY(row[dateField]);
  return Boolean(get('SELECT locked FROM financial_year_locks WHERE org_id=? AND fy=?', [row.org_id, fy])?.locked);
}

function calculateItemTransaction(orgId, rawItems, taxInclusive, roundOffEnabled) {
  let taxable = 0;
  let tax = 0;
  const inclusive = Boolean(taxInclusive && get('SELECT gst_type FROM orgs WHERE id=?', [orgId])?.gst_type === 'regular');
  const items = normalizeBusinessItems(orgId, rawItems).filter(item => Number(item.qty) > 0).map(item => {
    const clean = taxableLine(item, inclusive);
    taxable += clean.amount;
    tax += clean.tax;
    return clean;
  });
  if (!items.length) throw new Error('Add at least one item');
  const totalBeforeRound = round(taxable + tax);
  const roundOff = roundOffEnabled === false ? 0 : round(Math.round(totalBeforeRound) - totalBeforeRound);
  return { items, inclusive, taxable: round(taxable), tax: round(tax), roundOff, grandTotal: round(totalBeforeRound + roundOff) };
}

function pageParams(query, defaultLimit = 200, maxLimit = 500) {
  const requested = Number(query.limit || defaultLimit);
  const limit = Math.max(1, Math.min(maxLimit, Number.isFinite(requested) ? requested : defaultLimit));
  const offset = Math.max(0, Number(query.offset || 0) || 0);
  return { limit, offset };
}

function fyDates(fy) {
  const startYear = Number(String(fy || '').split('-')[0]);
  if (!Number.isFinite(startYear)) throw new Error('Valid financial year is required');
  return {
    start: `${startYear}-04-01`,
    end: `${startYear + 1}-03-31`,
    nextStart: `${startYear + 1}-04-01`,
    nextFy: `${startYear + 1}-${String(startYear + 2).slice(-2)}`
  };
}

function financialYearReport(orgId, fy) {
  ensureAccounts(orgId);
  const { start, end, nextStart, nextFy } = fyDates(fy);
  const trialRows = all(
    `SELECT a.id account_id,a.code,a.name,a.type,a.subtype,a.system_key,
      COALESCE(SUM(jl.debit),0) debit,COALESCE(SUM(jl.credit),0) credit
     FROM journal_lines jl
     JOIN journal_entries je ON je.id=jl.entry_id
     JOIN accounts a ON a.id=jl.account_id
     WHERE a.org_id=? AND a.active=1 AND je.deleted=0 AND je.entry_date BETWEEN ? AND ?
     GROUP BY a.id ORDER BY a.code`,
    [orgId, start, end]
  ).map(row => ({ ...row, debit: round(row.debit), credit: round(row.credit) }));
  const cumulativeRows = all(
    `SELECT a.id account_id,a.code,a.name,a.type,a.subtype,a.system_key,
      COALESCE(SUM(jl.debit),0) debit,COALESCE(SUM(jl.credit),0) credit
     FROM journal_lines jl
     JOIN journal_entries je ON je.id=jl.entry_id
     JOIN accounts a ON a.id=jl.account_id
     WHERE a.org_id=? AND a.active=1 AND je.deleted=0 AND je.entry_date<=?
     GROUP BY a.id ORDER BY a.code`,
    [orgId, end]
  ).map(row => ({ ...row, debit: round(row.debit), credit: round(row.credit) }));
  const totalDebit = round(trialRows.reduce((sum, row) => sum + Number(row.debit || 0), 0));
  const totalCredit = round(trialRows.reduce((sum, row) => sum + Number(row.credit || 0), 0));
  const income = trialRows.filter(row => row.type === 'income')
    .reduce((sum, row) => sum + Number(row.credit || 0) - Number(row.debit || 0), 0);
  const expenses = trialRows.filter(row => row.type === 'expense')
    .reduce((sum, row) => sum + Number(row.debit || 0) - Number(row.credit || 0), 0);
  const netProfit = round(income - expenses);
  const assets = cumulativeRows.filter(row => row.type === 'asset')
    .reduce((sum, row) => sum + Number(row.debit || 0) - Number(row.credit || 0), 0);
  const liabilities = cumulativeRows.filter(row => row.type === 'liability')
    .reduce((sum, row) => sum + Number(row.credit || 0) - Number(row.debit || 0), 0);
  const equity = cumulativeRows.filter(row => row.type === 'equity')
    .reduce((sum, row) => sum + Number(row.credit || 0) - Number(row.debit || 0), 0);
  const lifetimeIncome = cumulativeRows.filter(row => row.type === 'income')
    .reduce((sum, row) => sum + Number(row.credit || 0) - Number(row.debit || 0), 0);
  const lifetimeExpense = cumulativeRows.filter(row => row.type === 'expense')
    .reduce((sum, row) => sum + Number(row.debit || 0) - Number(row.credit || 0), 0);
  const retainedProfit = round(lifetimeIncome - lifetimeExpense);
  const totalAssets = round(assets);
  const totalLiabilitiesEquity = round(liabilities + equity + retainedProfit);
  return {
    fy,
    next_fy: nextFy,
    period: { start, end, next_start: nextStart },
    trial_balance: {
      total_debit: totalDebit,
      total_credit: totalCredit,
      difference: round(totalDebit - totalCredit),
      rows: trialRows
    },
    profit_loss: {
      total_income: round(income),
      total_expenses: round(expenses),
      net_profit: netProfit
    },
    balance_sheet: {
      total_assets: totalAssets,
      total_liabilities: round(liabilities),
      total_equity: round(equity + retainedProfit),
      retained_profit: retainedProfit,
      difference: round(totalAssets - totalLiabilitiesEquity)
    },
    opening_carry_forward: cumulativeRows
      .filter(row => ['asset', 'liability', 'equity'].includes(row.type))
      .map(row => {
        const debitBalance = ['asset'].includes(row.type)
          ? round(Number(row.debit || 0) - Number(row.credit || 0))
          : round(Number(row.debit || 0) - Number(row.credit || 0));
        return {
          account_id: row.account_id,
          code: row.code,
          name: row.name,
          type: row.type,
          debit: debitBalance > 0 ? debitBalance : 0,
          credit: debitBalance < 0 ? round(Math.abs(debitBalance)) : 0
        };
      })
      .filter(row => row.debit > 0.004 || row.credit > 0.004)
  };
}

function yearClosingStatus(orgId, fy) {
  const report = financialYearReport(orgId, fy);
  const { start, end } = report.period;
  const openShifts = get(
    `SELECT COUNT(*) count FROM pos_shifts
     WHERE org_id=? AND status='open' AND date(opened_at) BETWEEN ? AND ?`,
    [orgId, start, end]
  )?.count || 0;
  const pendingCorrections = get(
    `SELECT COUNT(*) count FROM invoice_correction_requests cr
     JOIN bills b ON b.id=cr.bill_id
     WHERE cr.org_id=? AND cr.status='pending' AND b.bill_date BETWEEN ? AND ?`,
    [orgId, start, end]
  )?.count || 0;
  const openPurchaseOrders = get(
    `SELECT COUNT(*) count FROM purchase_orders
     WHERE org_id=? AND fy=? AND status='open'`,
    [orgId, fy]
  )?.count || 0;
  const checks = [
    {
      code: 'TRIAL_BALANCE_MATCH',
      level: Math.abs(report.trial_balance.difference) > 0.01 ? 'blocker' : 'ok',
      message: `Trial Balance difference ${round(report.trial_balance.difference)}`
    },
    {
      code: 'BALANCE_SHEET_MATCH',
      level: Math.abs(report.balance_sheet.difference) > 0.01 ? 'blocker' : 'ok',
      message: `Balance Sheet difference ${round(report.balance_sheet.difference)}`
    },
    {
      code: 'OPEN_POS_SHIFTS',
      level: openShifts ? 'blocker' : 'ok',
      message: `${openShifts} open POS shift(s)`
    },
    {
      code: 'PENDING_CORRECTIONS',
      level: pendingCorrections ? 'blocker' : 'ok',
      message: `${pendingCorrections} pending invoice correction request(s)`
    },
    {
      code: 'OPEN_PURCHASE_ORDERS',
      level: openPurchaseOrders ? 'warning' : 'ok',
      message: `${openPurchaseOrders} open purchase order(s)`
    }
  ];
  const lock = get('SELECT * FROM financial_year_locks WHERE org_id=? AND fy=?', [orgId, fy]) || null;
  return {
    lock,
    report,
    checks,
    can_close: !checks.some(check => check.level === 'blocker')
  };
}

function taxableLine(item, taxInclusive) {
  const qty = Number(item.qty || 0);
  const enteredRate = Number(item.rate || 0);
  const gstRate = Number(item.gst_rate || 0);
  const gross = round(qty * enteredRate);
  const tax = taxInclusive && gstRate > 0
    ? round(gross * gstRate / (100 + gstRate))
    : round(gross * gstRate / 100);
  const taxable = taxInclusive ? round(gross - tax) : gross;
  const baseRate = qty > 0 ? round(taxable / qty) : 0;
  return {
    ...item, qty, entered_rate: enteredRate, rate: baseRate,
    amount: taxable, gross_amount: taxInclusive ? gross : round(gross + tax),
    gst_rate: gstRate, tax
  };
}

function normalizeBusinessItems(orgId, rawItems) {
  if (!Array.isArray(rawItems) || !rawItems.length) throw new Error('Add at least one item');
  return rawItems.map((item, index) => {
    const itemId = Number(item?.item_id || 0);
    const manualName = cleanText(item?.item_name, 240);
    if (!itemId) {
      if (!manualName) throw new Error(`Item name is required for line ${index + 1}`);
      return { ...item, item_id: null, item_name: manualName, unit: cleanText(item?.unit, 30) || 'NOS' };
    }
    const master = get(`SELECT id,name,hsn_code,unit,gst_rate FROM items
      WHERE id=? AND org_id=? AND active=1`, [itemId, orgId]);
    if (!master) throw new Error(`Item on line ${index + 1} does not belong to this company or is inactive`);
    return {
      ...item,
      item_id: master.id,
      item_name: manualName || master.name,
      hsn_code: cleanText(item?.hsn_code, 80) || master.hsn_code || '',
      unit: cleanText(item?.unit, 30) || master.unit || 'NOS',
      gst_rate: item?.gst_rate === undefined || item?.gst_rate === '' ? Number(master.gst_rate || 0) : item.gst_rate
    };
  });
}

function nextNumber(orgId, format, dateValue) {
  const fy = getFY(dateValue);
  const org = get('SELECT display_name FROM orgs WHERE id=?', [orgId]);
  const orgCode = org ? org.display_name.substring(0, 3).toUpperCase() : 'ORG';
  const seq = get('SELECT last_number FROM bill_sequences WHERE org_id=? AND format=? AND fy=?',
    [orgId, format, fy]);
  return { fy, orgCode, next: Number(seq?.last_number || 0) + 1 };
}

function takeNumber(orgId, format, dateValue) {
  const parts = nextNumber(orgId, format, dateValue);
  const prefix = { PURCHASE: 'PUR', EXPENSE: 'EXP', CREDIT_NOTE: 'CN', DEBIT_NOTE: 'DN' }[format] || format;
  const existing = get('SELECT id FROM bill_sequences WHERE org_id=? AND format=? AND fy=?',
    [orgId, format, parts.fy]);
  if (existing) {
    run('UPDATE bill_sequences SET last_number=?,prefix=? WHERE id=?', [parts.next, prefix, existing.id]);
  } else {
    run('INSERT INTO bill_sequences (org_id,format,fy,prefix,last_number) VALUES (?,?,?,?,?)',
      [orgId, format, parts.fy, prefix, parts.next]);
  }
  return { ...parts, number: `${parts.orgCode}/${prefix}/${parts.fy}/${String(parts.next).padStart(4, '0')}` };
}

function transactionRequiredFields(orgId, type) {
  const row = get('SELECT required_fields FROM transaction_control_settings WHERE org_id=? AND transaction_type=?', [orgId, type]);
  if (row) return parseJson(row.required_fields || '{}', {});
  const org = get('SELECT invoice_print_options FROM orgs WHERE id=?', [orgId]);
  return defaultControl(type, parseJson(org?.invoice_print_options || '{}', {})).required_fields;
}

function requireBusinessControlFields(orgId, type, body) {
  const required = transactionRequiredFields(orgId, type);
  const missing = [];
  const items = Array.isArray(body.items) ? body.items : [];
  const everyItem = key => items.length && items.every(item => Number(item[key] || 0) > 0);
  if (required.party && !body.party_id) missing.push('Party');
  if (required.supplier_invoice && !body.supplier_invoice) missing.push('Supplier Invoice / Reference');
  if (required.expected_date && !body.expected_date && !body.due_date) missing.push('Expected Date');
  if (required.account_codes && !body.account_id) missing.push('Account');
  if (required.payment_mode && !body.payment_mode) missing.push('Payment Mode');
  if (required.reference && !body.reference) missing.push('Reference Number');
  if (required.reason && !body.narration) missing.push('Reason / Narration');
  if (required.qty_unit && !items.every(item => Number(item.qty || 0) > 0)) missing.push('Qty / Unit');
  if (required.rate && !everyItem('rate')) missing.push('Rate');
  if (required.amount && type === 'EXPENSE' && !Number(body.amount || 0)) missing.push('Amount');
  if (required.amount && type !== 'EXPENSE' && !items.length) missing.push('Amount');
  if (required.footer && !body.narration) missing.push('Narration');
  if (missing.length) throw new Error(`${type} required field missing: ${missing.join(', ')}`);
}

router.get('/next-number', (req, res) => {
  const parts = nextNumber(req.query.org_id, req.query.type, req.query.date);
  const prefix = { PURCHASE: 'PUR', EXPENSE: 'EXP', CREDIT_NOTE: 'CN', DEBIT_NOTE: 'DN' }[req.query.type] || req.query.type;
  res.json({ number: `${parts.orgCode}/${prefix}/${parts.fy}/${String(parts.next).padStart(4, '0')}`, fy: parts.fy });
});

router.get('/purchases', requirePermission('purchases'), (req, res) => {
  const page = pageParams(req.query);
  const params = [req.query.org_id, req.query.fy || '', req.query.fy || ''];
  let sql = `SELECT pu.*,p.name party_name FROM purchases pu LEFT JOIN parties p ON p.id=pu.party_id
     WHERE pu.org_id=? AND pu.deleted=0 AND (?='' OR pu.fy=?)`;
  if (req.query.search) {
    sql += ` AND (pu.purchase_number LIKE ? OR pu.supplier_invoice LIKE ? OR p.name LIKE ? OR pu.narration LIKE ?)`;
    const s = `%${cleanText(req.query.search, 120)}%`;
    params.push(s, s, s, s);
  }
  sql += ' ORDER BY pu.purchase_date DESC,pu.id DESC LIMIT ? OFFSET ?';
  params.push(page.limit, page.offset);
  res.json(all(sql, params));
});

router.get('/purchases/:id', requirePermission('purchases'), (req, res) => {
  const purchase = get('SELECT * FROM purchases WHERE id=? AND deleted=0', [req.params.id]);
  if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
  if (!requireOrgAccess(req, res, purchase.org_id)) return;
  purchase.items = JSON.parse(purchase.items_json || '[]');
  res.json(purchase);
});

router.post('/purchases', requirePermission('purchases'), rejectLockedPeriod, (req, res) => {
  const {
    org_id, purchase_date, party_id, supplier_invoice, due_date,
    payment_mode, items, narration, tax_inclusive, round_off_enabled
  } = req.body;
  if (!org_id || !purchase_date || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Company, date and items are required' });
  }
  try { requireBusinessControlFields(org_id, 'PURCHASE', req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  if (party_id && !partyForOrg(party_id, org_id)) {
    return res.status(400).json({ error: 'Vendor does not belong to this company' });
  }
  let taxable = 0;
  let tax = 0;
  const inclusive = Boolean(tax_inclusive && get('SELECT gst_type FROM orgs WHERE id=?', [org_id])?.gst_type === 'regular');
  const cleanItems = normalizeBusinessItems(org_id, items).map(item => {
    const clean = taxableLine(item, inclusive);
    taxable += clean.amount;
    tax += clean.tax;
    if (item.item_id) run('UPDATE items SET last_purchase_price=? WHERE id=?', [clean.rate, item.item_id]);
    return clean;
  });
  const number = takeNumber(org_id, 'PURCHASE', purchase_date);
  const totalBeforeRound = round(taxable + tax);
  const roundOff = round_off_enabled === false ? 0 : round(Math.round(totalBeforeRound) - totalBeforeRound);
  const grandTotal = round(totalBeforeRound + roundOff);
  const result = run(
    `INSERT INTO purchases
     (org_id,purchase_number,supplier_invoice,purchase_date,due_date,fy,party_id,items_json,
      taxable_amount,cgst,sgst,total_tax,grand_total,round_off,payment_mode,narration,tax_inclusive,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [org_id, number.number, supplier_invoice || '', purchase_date, due_date || null, number.fy,
     party_id || null, JSON.stringify(cleanItems), round(taxable), round(tax / 2), round(tax / 2),
     round(tax), grandTotal, roundOff, payment_mode || 'credit', narration || '', inclusive ? 1 : 0, req.user.id]
  );
  const purchase = get('SELECT * FROM purchases WHERE id=?', [result.lastInsertRowid]);
  postPurchase(purchase);
  replaceStockMovements({
    orgId: Number(org_id), sourceType: 'purchase', sourceId: purchase.id,
    date: purchase_date, refNumber: number.number, items: cleanItems, direction: 'in'
  });
  res.json({ success: true, purchase });
});

router.patch('/purchases/:id', requirePermission('purchases'), (req, res) => {
  const purchase = get('SELECT * FROM purchases WHERE id=? AND deleted=0', [req.params.id]);
  if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
  if (!requireOrgAccess(req, res, purchase.org_id)) return;
  const reason = requireOwnerReason(req, res, 'edit');
  if (!reason) return;
  if (transactionPeriodLocked(purchase, 'purchase_date')) return res.status(423).json({ error: `Financial year ${purchase.fy} is locked` });
  if (Number(req.body.org_id) !== Number(purchase.org_id)) return res.status(400).json({ error: 'Company cannot be changed while editing' });
  if (req.body.party_id && !partyForOrg(req.body.party_id, purchase.org_id)) return res.status(400).json({ error: 'Vendor does not belong to this company' });
  try {
    requireBusinessControlFields(purchase.org_id, 'PURCHASE', req.body);
    const totals = calculateItemTransaction(purchase.org_id, req.body.items, req.body.tax_inclusive, req.body.round_off_enabled);
    const updated = transaction(() => {
      run(
        `UPDATE purchases SET purchase_date=?,due_date=?,party_id=?,supplier_invoice=?,items_json=?,
         taxable_amount=?,cgst=?,sgst=?,total_tax=?,grand_total=?,round_off=?,payment_mode=?,narration=?,tax_inclusive=? WHERE id=?`,
        [req.body.purchase_date, req.body.due_date || null, req.body.party_id || null,
         cleanText(req.body.supplier_invoice, 120), JSON.stringify(totals.items), totals.taxable,
         round(totals.tax / 2), round(totals.tax / 2), totals.tax, totals.grandTotal, totals.roundOff,
         req.body.payment_mode || 'credit', cleanText(req.body.narration), totals.inclusive ? 1 : 0, purchase.id]
      );
      const row = get('SELECT * FROM purchases WHERE id=?', [purchase.id]);
      postPurchase(row);
      replaceStockMovements({ orgId: row.org_id, sourceType: 'purchase', sourceId: row.id,
        date: row.purchase_date, refNumber: row.purchase_number, items: totals.items, direction: 'in' });
      auditBusinessChange(req, purchase, 'purchases', 'UPDATE_PURCHASE', reason, row);
      return row;
    });
    res.json({ success: true, purchase: updated });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.delete('/purchases/:id', requirePermission('delete'), (req, res) => {
  const purchase = get('SELECT * FROM purchases WHERE id=?', [req.params.id]);
  if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
  if (!requireOrgAccess(req, res, purchase.org_id)) return;
  const reason = requireOwnerReason(req, res, 'delete');
  if (!reason) return;
  if (transactionPeriodLocked(purchase, 'purchase_date')) return res.status(423).json({ error: `Financial year ${purchase.fy} is locked` });
  transaction(() => {
    run('UPDATE purchases SET deleted=1 WHERE id=?', [purchase.id]);
    removeSourceEntry(purchase.org_id, 'purchase', purchase.id);
    removeStockMovements(purchase.org_id, 'purchase', purchase.id);
    auditBusinessChange(req, purchase, 'purchases', 'DELETE_PURCHASE', reason);
  });
  res.json({ success: true });
});

router.get('/expenses', requirePermission('accounting'), (req, res) => {
  const page = pageParams(req.query);
  const params = [req.query.org_id, req.query.fy || '', req.query.fy || ''];
  let sql = `SELECT e.*,p.name party_name,a.name account_name FROM expenses e
     LEFT JOIN parties p ON p.id=e.party_id LEFT JOIN accounts a ON a.id=e.account_id
     WHERE e.org_id=? AND e.deleted=0 AND (?='' OR e.fy=?)`;
  if (req.query.search) {
    sql += ` AND (e.expense_number LIKE ? OR p.name LIKE ? OR a.name LIKE ? OR e.reference LIKE ? OR e.narration LIKE ?)`;
    const s = `%${cleanText(req.query.search, 120)}%`;
    params.push(s, s, s, s, s);
  }
  sql += ' ORDER BY e.expense_date DESC,e.id DESC LIMIT ? OFFSET ?';
  params.push(page.limit, page.offset);
  res.json(all(sql, params));
});

router.get('/expenses/:id', requirePermission('accounting'), (req, res) => {
  const expense = get('SELECT * FROM expenses WHERE id=? AND deleted=0', [req.params.id]);
  if (!expense) return res.status(404).json({ error: 'Expense not found' });
  if (!requireOrgAccess(req, res, expense.org_id)) return;
  res.json(expense);
});

router.post('/expenses', requirePermission('accounting'), rejectLockedPeriod, (req, res) => {
  const {
    org_id, expense_date, party_id, account_id, payment_mode, amount,
    gst_amount, gst_rate, tax_inclusive, round_off_enabled, reference, narration
  } = req.body;
  ensureAccounts(org_id);
  try { requireBusinessControlFields(org_id, 'EXPENSE', req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  if (party_id && !partyForOrg(party_id, org_id)) {
    return res.status(400).json({ error: 'Party does not belong to this company' });
  }
  if (!get(`SELECT id FROM accounts WHERE id=? AND org_id=? AND type='expense'`, [account_id, org_id])) {
    return res.status(400).json({ error: 'Select a valid expense account' });
  }
  const number = takeNumber(org_id, 'EXPENSE', expense_date);
  const enteredAmount = round(amount);
  const roundOff = round_off_enabled === false ? 0 : round(Math.round(enteredAmount) - enteredAmount);
  const finalAmount = round(enteredAmount + roundOff);
  const result = run(
    `INSERT INTO expenses
     (org_id,expense_number,expense_date,fy,party_id,account_id,payment_mode,amount,gst_amount,
      gst_rate,tax_inclusive,round_off,reference,narration,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [org_id, number.number, expense_date, number.fy, party_id || null, account_id,
     payment_mode || 'cash', finalAmount, round(gst_amount), Number(gst_rate || 0),
     tax_inclusive ? 1 : 0, roundOff, reference || '', narration || '', req.user.id]
  );
  const expense = get('SELECT * FROM expenses WHERE id=?', [result.lastInsertRowid]);
  postExpense(expense);
  res.json({ success: true, expense });
});

router.patch('/expenses/:id', requirePermission('accounting'), (req, res) => {
  const expense = get('SELECT * FROM expenses WHERE id=? AND deleted=0', [req.params.id]);
  if (!expense) return res.status(404).json({ error: 'Expense not found' });
  if (!requireOrgAccess(req, res, expense.org_id)) return;
  const reason = requireOwnerReason(req, res, 'edit');
  if (!reason) return;
  if (transactionPeriodLocked(expense, 'expense_date')) return res.status(423).json({ error: `Financial year ${expense.fy} is locked` });
  if (Number(req.body.org_id) !== Number(expense.org_id)) return res.status(400).json({ error: 'Company cannot be changed while editing' });
  if (req.body.party_id && !partyForOrg(req.body.party_id, expense.org_id)) return res.status(400).json({ error: 'Party does not belong to this company' });
  if (!get(`SELECT id FROM accounts WHERE id=? AND org_id=? AND type='expense'`, [req.body.account_id, expense.org_id])) return res.status(400).json({ error: 'Select a valid expense account' });
  try {
    requireBusinessControlFields(expense.org_id, 'EXPENSE', req.body);
    const enteredAmount = round(req.body.amount);
    const roundOff = req.body.round_off_enabled === false ? 0 : round(Math.round(enteredAmount) - enteredAmount);
    const updated = transaction(() => {
      run(
        `UPDATE expenses SET expense_date=?,party_id=?,account_id=?,payment_mode=?,amount=?,gst_amount=?,gst_rate=?,
         tax_inclusive=?,round_off=?,reference=?,narration=? WHERE id=?`,
        [req.body.expense_date, req.body.party_id || null, req.body.account_id, req.body.payment_mode || 'cash',
         round(enteredAmount + roundOff), round(req.body.gst_amount), Number(req.body.gst_rate || 0),
         req.body.tax_inclusive ? 1 : 0, roundOff, cleanText(req.body.reference, 120), cleanText(req.body.narration), expense.id]
      );
      const row = get('SELECT * FROM expenses WHERE id=?', [expense.id]);
      postExpense(row);
      auditBusinessChange(req, expense, 'expenses', 'UPDATE_EXPENSE', reason, row);
      return row;
    });
    res.json({ success: true, expense: updated });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.delete('/expenses/:id', requirePermission('delete'), (req, res) => {
  const expense = get('SELECT * FROM expenses WHERE id=? AND deleted=0', [req.params.id]);
  if (!expense) return res.status(404).json({ error: 'Expense not found' });
  if (!requireOrgAccess(req, res, expense.org_id)) return;
  const reason = requireOwnerReason(req, res, 'delete');
  if (!reason) return;
  if (transactionPeriodLocked(expense, 'expense_date')) return res.status(423).json({ error: `Financial year ${expense.fy} is locked` });
  transaction(() => {
    run('UPDATE expenses SET deleted=1 WHERE id=?', [expense.id]);
    removeSourceEntry(expense.org_id, 'expense', expense.id);
    auditBusinessChange(req, expense, 'expenses', 'DELETE_EXPENSE', reason);
  });
  res.json({ success: true });
});

router.get('/notes', requirePermission('billing'), (req, res) => {
  const page = pageParams(req.query);
  const params = [req.query.org_id, req.query.fy || '', req.query.fy || ''];
  let sql = `SELECT n.*,p.name party_name FROM credit_debit_notes n LEFT JOIN parties p ON p.id=n.party_id
     WHERE n.org_id=? AND n.deleted=0 AND (?='' OR n.fy=?)`;
  if (req.query.search) {
    sql += ` AND (n.note_number LIKE ? OR n.note_type LIKE ? OR p.name LIKE ? OR n.narration LIKE ?)`;
    const s = `%${cleanText(req.query.search, 120)}%`;
    params.push(s, s, s, s);
  }
  sql += ' ORDER BY n.note_date DESC,n.id DESC LIMIT ? OFFSET ?';
  params.push(page.limit, page.offset);
  res.json(all(sql, params));
});

router.get('/notes/:id', requirePermission('billing'), (req, res) => {
  const note = get('SELECT * FROM credit_debit_notes WHERE id=? AND deleted=0', [req.params.id]);
  if (!note) return res.status(404).json({ error: 'Credit/debit note not found' });
  if (!requireOrgAccess(req, res, note.org_id)) return;
  note.items = JSON.parse(note.items_json || '[]');
  res.json(note);
});

router.post('/notes', requirePermission('billing'), rejectLockedPeriod, (req, res) => {
  const {
    org_id, note_date, note_type, party_id, linked_bill_id,
    linked_purchase_id, items, narration, tax_inclusive, round_off_enabled
  } = req.body;
  if (!['credit', 'debit'].includes(note_type)) return res.status(400).json({ error: 'Invalid note type' });
  try { requireBusinessControlFields(org_id, note_type === 'credit' ? 'CN' : 'DN', req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  if (party_id && !partyForOrg(party_id, org_id)) {
    return res.status(400).json({ error: 'Party does not belong to this company' });
  }
  let taxable = 0;
  let tax = 0;
  const inclusive = Boolean(tax_inclusive && get('SELECT gst_type FROM orgs WHERE id=?', [org_id])?.gst_type === 'regular');
  const cleanItems = normalizeBusinessItems(org_id, items).map(item => {
    const clean = taxableLine(item, inclusive);
    taxable += clean.amount;
    tax += clean.tax;
    return clean;
  });
  if (!cleanItems.length) return res.status(400).json({ error: 'Add at least one returned item' });
  const sequenceType = note_type === 'credit' ? 'CREDIT_NOTE' : 'DEBIT_NOTE';
  const number = takeNumber(org_id, sequenceType, note_date);
  const totalBeforeRound = round(taxable + tax);
  const roundOff = round_off_enabled === false ? 0 : round(Math.round(totalBeforeRound) - totalBeforeRound);
  const grandTotal = round(totalBeforeRound + roundOff);
  const result = run(
    `INSERT INTO credit_debit_notes
     (org_id,note_number,note_date,fy,note_type,party_id,linked_bill_id,linked_purchase_id,
      items_json,taxable_amount,tax_amount,grand_total,round_off,narration,tax_inclusive,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [org_id, number.number, note_date, number.fy, note_type, party_id || null,
     linked_bill_id || null, linked_purchase_id || null, JSON.stringify(cleanItems),
     round(taxable), round(tax), grandTotal, roundOff, narration || '', inclusive ? 1 : 0, req.user.id]
  );
  const note = get('SELECT * FROM credit_debit_notes WHERE id=?', [result.lastInsertRowid]);
  postNote(note);
  replaceStockMovements({
    orgId: Number(org_id), sourceType: 'note', sourceId: note.id, date: note_date,
    refNumber: number.number, items: cleanItems, direction: note_type === 'credit' ? 'in' : 'out'
  });
  res.json({ success: true, note });
});

router.patch('/notes/:id', requirePermission('billing'), (req, res) => {
  const note = get('SELECT * FROM credit_debit_notes WHERE id=? AND deleted=0', [req.params.id]);
  if (!note) return res.status(404).json({ error: 'Credit/debit note not found' });
  if (!requireOrgAccess(req, res, note.org_id)) return;
  const reason = requireOwnerReason(req, res, 'edit');
  if (!reason) return;
  if (transactionPeriodLocked(note, 'note_date')) return res.status(423).json({ error: `Financial year ${note.fy} is locked` });
  if (Number(req.body.org_id) !== Number(note.org_id)) return res.status(400).json({ error: 'Company cannot be changed while editing' });
  if (!['credit', 'debit'].includes(req.body.note_type)) return res.status(400).json({ error: 'Invalid note type' });
  if (req.body.party_id && !partyForOrg(req.body.party_id, note.org_id)) return res.status(400).json({ error: 'Party does not belong to this company' });
  try {
    requireBusinessControlFields(note.org_id, req.body.note_type === 'credit' ? 'CN' : 'DN', req.body);
    const totals = calculateItemTransaction(note.org_id, req.body.items, req.body.tax_inclusive, req.body.round_off_enabled);
    const updated = transaction(() => {
      run(
        `UPDATE credit_debit_notes SET note_date=?,note_type=?,party_id=?,items_json=?,taxable_amount=?,tax_amount=?,
         grand_total=?,round_off=?,narration=?,tax_inclusive=? WHERE id=?`,
        [req.body.note_date, req.body.note_type, req.body.party_id || null, JSON.stringify(totals.items),
         totals.taxable, totals.tax, totals.grandTotal, totals.roundOff, cleanText(req.body.narration),
         totals.inclusive ? 1 : 0, note.id]
      );
      const row = get('SELECT * FROM credit_debit_notes WHERE id=?', [note.id]);
      postNote(row);
      replaceStockMovements({ orgId: row.org_id, sourceType: 'note', sourceId: row.id, date: row.note_date,
        refNumber: row.note_number, items: totals.items, direction: row.note_type === 'credit' ? 'in' : 'out' });
      auditBusinessChange(req, note, 'credit_debit_notes', 'UPDATE_NOTE', reason, row);
      return row;
    });
    res.json({ success: true, note: updated });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.delete('/notes/:id', requirePermission('delete'), (req, res) => {
  const note = get('SELECT * FROM credit_debit_notes WHERE id=? AND deleted=0', [req.params.id]);
  if (!note) return res.status(404).json({ error: 'Credit/debit note not found' });
  if (!requireOrgAccess(req, res, note.org_id)) return;
  const reason = requireOwnerReason(req, res, 'delete');
  if (!reason) return;
  if (transactionPeriodLocked(note, 'note_date')) return res.status(423).json({ error: `Financial year ${note.fy} is locked` });
  transaction(() => {
    run('UPDATE credit_debit_notes SET deleted=1 WHERE id=?', [note.id]);
    removeSourceEntry(note.org_id, 'note', note.id);
    removeStockMovements(note.org_id, 'note', note.id);
    auditBusinessChange(req, note, 'credit_debit_notes', 'DELETE_NOTE', reason);
  });
  res.json({ success: true });
});

router.get('/stock', requirePermission('inventory'), (req, res) => {
  const rows = stockSummary(req.query.org_id);
  res.json({
    items: rows,
    low_stock: rows.filter(item => Number(item.reorder_level) > 0 && Number(item.current_stock) <= Number(item.reorder_level))
  });
});

router.get('/stock-movements', requirePermission('inventory'), (req, res) => {
  res.json(all(
    `SELECT sm.id,sm.movement_date,sm.source_type,sm.source_id,sm.ref_number,
      sm.qty_in,sm.qty_out,sm.rate,i.name item_name,i.item_code,i.model_number,i.unit
     FROM stock_movements sm
     JOIN items i ON i.id=sm.item_id AND i.org_id=sm.org_id
     WHERE sm.org_id=? AND (?='' OR sm.movement_date>=?) AND (?='' OR sm.movement_date<=?)
     ORDER BY sm.movement_date DESC,sm.id DESC`,
    [req.query.org_id, req.query.from || '', req.query.from || '',
     req.query.to || '', req.query.to || '']
  ));
});

router.get('/stock-counts', requirePermission('inventory'), (req, res) => {
  const orgId = Number(req.query.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  const rows = all(`SELECT sc.*,u.name created_by_name,au.name approved_by_name,
    COUNT(scl.id) total_lines,
    SUM(CASE WHEN scl.counted_qty IS NOT NULL THEN 1 ELSE 0 END) counted_lines,
    SUM(CASE WHEN ABS(COALESCE(scl.variance_qty,0))>0.0001 THEN 1 ELSE 0 END) variance_lines
    FROM stock_counts sc
    JOIN users u ON u.id=sc.created_by
    LEFT JOIN users au ON au.id=sc.approved_by
    LEFT JOIN stock_count_lines scl ON scl.count_id=sc.id
    WHERE sc.org_id=? GROUP BY sc.id ORDER BY sc.created_at DESC,sc.id DESC LIMIT 100`, [orgId]);
  res.json(rows.map(row => ({ ...row, total_lines: Number(row.total_lines || 0), counted_lines: Number(row.counted_lines || 0), variance_lines: Number(row.variance_lines || 0) })));
});

router.post('/stock-counts', requirePermission('inventory'), (req, res) => {
  const orgId = Number(req.body.org_id);
  const countDate = validCalendarDate(req.body.count_date) || new Date().toISOString().slice(0, 10);
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  try {
    const result = transaction(() => {
      const items = stockSummary(orgId);
      if (!items.length) throw new Error('Add at least one active item before starting a physical stock count');
      const number = nextStockCountNumber(orgId, countDate);
      const created = run(`INSERT INTO stock_counts (org_id,count_number,count_date,fy,status,notes,created_by)
        VALUES (?,?,?,?,?,?,?)`, [orgId, number.number, countDate, number.fy, 'DRAFT', cleanText(req.body.notes, 2000), req.user.id]);
      items.forEach(item => run(`INSERT INTO stock_count_lines
        (count_id,item_id,item_code_snapshot,item_name_snapshot,unit_snapshot,system_qty,rate_snapshot)
        VALUES (?,?,?,?,?,?,?)`, [created.lastInsertRowid, item.id, item.item_code || '', item.name, item.unit || 'NOS',
        Number(item.current_stock || 0), Number(item.last_purchase_price || 0)]));
      run(`INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address)
        VALUES (?,?,?,?,?,?,?)`, [req.user.id, orgId, 'CREATE_STOCK_COUNT', 'stock_counts', created.lastInsertRowid,
        JSON.stringify({ count_number: number.number, count_date: countDate, item_count: items.length }), req.ip]);
      return created.lastInsertRowid;
    });
    res.json({ success: true, stock_count: stockCountWithLines(result) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.get('/stock-counts/:id', requirePermission('inventory'), (req, res) => {
  const count = stockCountWithLines(Number(req.params.id));
  if (!count) return res.status(404).json({ error: 'Stock count not found' });
  if (!requireOrgAccess(req, res, count.org_id)) return;
  res.json(count);
});

router.put('/stock-counts/:id/lines', requirePermission('inventory'), (req, res) => {
  const count = get('SELECT * FROM stock_counts WHERE id=?', [req.params.id]);
  if (!count) return res.status(404).json({ error: 'Stock count not found' });
  if (!requireOrgAccess(req, res, count.org_id)) return;
  if (!canEditStockCount(req, count)) return res.status(403).json({ error: 'Only the count creator or an owner can enter quantities' });
  if (count.status !== 'DRAFT') return res.status(409).json({ error: 'Only a draft stock count can be edited' });
  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  if (!lines.length) return res.status(400).json({ error: 'Enter at least one counted quantity' });
  try {
    transaction(() => {
      lines.forEach(input => {
        const line = get('SELECT * FROM stock_count_lines WHERE id=? AND count_id=?', [Number(input.id), count.id]);
        if (!line) throw new Error('One or more stock-count lines are invalid');
        const quantity = input.counted_qty === null || input.counted_qty === undefined || input.counted_qty === ''
          ? null : Number(input.counted_qty);
        if (quantity !== null && (!Number.isFinite(quantity) || quantity < 0 || quantity > 999999999)) {
          throw new Error(`Counted quantity for ${line.item_name_snapshot} is invalid`);
        }
        const variance = quantity === null ? 0 : round(quantity - Number(line.system_qty || 0));
        run(`UPDATE stock_count_lines SET counted_qty=?,variance_qty=?,notes=?,updated_at=datetime('now') WHERE id=?`,
          [quantity, variance, cleanText(input.notes, 1000), line.id]);
      });
      run(`UPDATE stock_counts SET notes=?,updated_at=datetime('now') WHERE id=?`, [cleanText(req.body.notes ?? count.notes, 2000), count.id]);
    });
    res.json({ success: true, stock_count: stockCountWithLines(count.id) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post('/stock-counts/:id/submit', requirePermission('inventory'), (req, res) => {
  const count = get('SELECT * FROM stock_counts WHERE id=?', [req.params.id]);
  if (!count) return res.status(404).json({ error: 'Stock count not found' });
  if (!requireOrgAccess(req, res, count.org_id)) return;
  if (!canEditStockCount(req, count)) return res.status(403).json({ error: 'Only the count creator or an owner can submit this count' });
  if (count.status !== 'DRAFT') return res.status(409).json({ error: 'Only a draft stock count can be submitted' });
  const missing = get('SELECT COUNT(*) count FROM stock_count_lines WHERE count_id=? AND counted_qty IS NULL', [count.id])?.count || 0;
  if (missing) return res.status(400).json({ error: `${missing} item(s) have no counted quantity. Complete the physical count before submitting.` });
  run(`UPDATE stock_counts SET status='SUBMITTED',submitted_by=?,submitted_at=datetime('now'),updated_at=datetime('now') WHERE id=?`, [req.user.id, count.id]);
  run(`INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address)
    VALUES (?,?,?,?,?,?,?)`, [req.user.id, count.org_id, 'SUBMIT_STOCK_COUNT', 'stock_counts', count.id,
    JSON.stringify({ count_number: count.count_number }), req.ip]);
  res.json({ success: true, stock_count: stockCountWithLines(count.id) });
});

router.post('/stock-counts/:id/approve', requirePermission('inventory'), (req, res) => {
  const reason = requireOwnerReason(req, res, 'approve this physical stock adjustment');
  if (!reason) return;
  const requested = get('SELECT * FROM stock_counts WHERE id=?', [req.params.id]);
  if (!requested) return res.status(404).json({ error: 'Stock count not found' });
  if (!requireOrgAccess(req, res, requested.org_id)) return;
  try {
    transaction(() => {
      const count = get('SELECT * FROM stock_counts WHERE id=?', [requested.id]);
      if (count.status !== 'SUBMITTED') throw new Error('Only a submitted stock count can be approved');
      if (isPeriodLocked(count.org_id, count.count_date)) {
        const error = new Error(`Financial year ${count.fy} is locked. Reopen it before approving this stock adjustment.`);
        error.statusCode = 423;
        throw error;
      }
      const lines = all('SELECT * FROM stock_count_lines WHERE count_id=? ORDER BY id', [count.id]);
      if (lines.some(line => line.counted_qty === null || line.counted_qty === undefined)) throw new Error('Every item must have a counted quantity before approval');
      const live = new Map(stockSummary(count.org_id).map(item => [Number(item.id), Number(item.current_stock || 0)]));
      const conflicts = lines.filter(line => Math.abs((live.get(Number(line.item_id)) || 0) - Number(line.system_qty || 0)) > 0.0001)
        .slice(0, 50).map(line => ({ item_id: line.item_id, item_name: line.item_name_snapshot, snapshot_qty: Number(line.system_qty || 0), live_qty: Number(live.get(Number(line.item_id)) || 0) }));
      if (conflicts.length) {
        const error = new Error('Stock changed after this count began. Start a fresh count or reconcile the listed items before approval.');
        error.statusCode = 409;
        error.code = 'STOCK_COUNT_STALE';
        error.conflicts = conflicts;
        throw error;
      }
      replaceStockCountMovements({ orgId: count.org_id, countId: count.id, countDate: count.count_date, countNumber: count.count_number, lines });
      run(`UPDATE stock_counts SET status='APPROVED',approved_by=?,approved_at=datetime('now'),approval_reason=?,updated_at=datetime('now') WHERE id=?`,
        [req.user.id, reason, count.id]);
      run(`INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,old_data,new_data,ip_address)
        VALUES (?,?,?,?,?,?,?,?)`, [req.user.id, count.org_id, 'APPROVE_STOCK_COUNT', 'stock_counts', count.id,
        JSON.stringify({ status: 'SUBMITTED' }), JSON.stringify({ status: 'APPROVED', reason, count_number: count.count_number }), req.ip]);
    });
    res.json({ success: true, stock_count: stockCountWithLines(requested.id) });
  } catch (error) { res.status(error.statusCode || 400).json({ error: error.message, code: error.code, conflicts: error.conflicts || [] }); }
});

router.post('/stock-counts/:id/cancel', requirePermission('inventory'), (req, res) => {
  const reason = requireOwnerReason(req, res, 'cancel this physical stock count');
  if (!reason) return;
  const count = get('SELECT * FROM stock_counts WHERE id=?', [req.params.id]);
  if (!count) return res.status(404).json({ error: 'Stock count not found' });
  if (!requireOrgAccess(req, res, count.org_id)) return;
  if (!['DRAFT', 'SUBMITTED'].includes(count.status)) return res.status(409).json({ error: 'An approved or cancelled stock count cannot be cancelled again' });
  run(`UPDATE stock_counts SET status='CANCELLED',cancelled_by=?,cancelled_at=datetime('now'),cancel_reason=?,updated_at=datetime('now') WHERE id=?`,
    [req.user.id, reason, count.id]);
  run(`INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address)
    VALUES (?,?,?,?,?,?,?)`, [req.user.id, count.org_id, 'CANCEL_STOCK_COUNT', 'stock_counts', count.id,
    JSON.stringify({ reason, count_number: count.count_number }), req.ip]);
  res.json({ success: true, stock_count: stockCountWithLines(count.id) });
});

router.get('/stock/reconciliation', requirePermission('inventory'), (req, res) => {
  const orgId = Number(req.query.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  if (!requireOrgAccess(req, res, orgId)) return;

  const items = stockSummary(orgId);
  const movementSummary = get(
    `SELECT COUNT(*) movement_count,COALESCE(SUM(qty_in),0) qty_in,COALESCE(SUM(qty_out),0) qty_out
     FROM stock_movements WHERE org_id=?`,
    [orgId]
  );
  const bySource = all(
    `SELECT source_type,COUNT(*) movement_count,ROUND(SUM(qty_in),3) qty_in,ROUND(SUM(qty_out),3) qty_out
     FROM stock_movements WHERE org_id=? GROUP BY source_type ORDER BY source_type`,
    [orgId]
  );
  const orphanSources = all(
    `SELECT sm.id,sm.source_type,sm.source_id,sm.ref_number,sm.movement_date,i.name item_name
     FROM stock_movements sm
     LEFT JOIN items i ON i.id=sm.item_id AND i.org_id=sm.org_id
     LEFT JOIN purchases p ON sm.source_type='purchase' AND p.id=sm.source_id
     LEFT JOIN bills b ON sm.source_type='bill' AND b.id=sm.source_id
     LEFT JOIN credit_debit_notes n ON sm.source_type='note' AND n.id=sm.source_id
     LEFT JOIN job_material_consumptions jm ON sm.source_type='job_material' AND jm.id=sm.source_id
     LEFT JOIN stock_counts sc ON sm.source_type='stock_count' AND sc.id=sm.source_id
     WHERE sm.org_id=? AND (
       i.id IS NULL OR
       (sm.source_type='purchase' AND (p.id IS NULL OR p.deleted=1)) OR
       (sm.source_type='bill' AND (b.id IS NULL OR b.deleted=1)) OR
       (sm.source_type='note' AND (n.id IS NULL OR n.deleted=1)) OR
       (sm.source_type='job_material' AND jm.id IS NULL) OR
       (sm.source_type='stock_count' AND (sc.id IS NULL OR sc.status<>'APPROVED'))
     ) ORDER BY sm.movement_date DESC,sm.id DESC LIMIT 100`,
    [orgId]
  );
  const jobMaterialMismatches = all(
    `SELECT jm.id,j.job_token,jm.item_name_snapshot,jm.quantity,
       COUNT(sm.id) movement_count,COALESCE(SUM(sm.qty_out),0) moved_quantity
     FROM job_material_consumptions jm
     JOIN job_orders j ON j.id=jm.job_id
     LEFT JOIN stock_movements sm ON sm.org_id=j.org_id AND sm.source_type='job_material' AND sm.source_id=jm.id
     WHERE j.org_id=?
     GROUP BY jm.id
     HAVING COUNT(sm.id)<>1 OR ABS(COALESCE(SUM(sm.qty_out),0)-jm.quantity)>0.0001
     ORDER BY jm.id DESC LIMIT 100`,
    [orgId]
  );
  const negativeItems = items.filter(item => Number(item.current_stock || 0) < -0.0001);

  res.json({
    generated_at: new Date().toISOString(),
    org_id: orgId,
    summary: {
      item_count: items.length,
      movement_count: Number(movementSummary?.movement_count || 0),
      qty_in: round(movementSummary?.qty_in || 0),
      qty_out: round(movementSummary?.qty_out || 0),
      negative_stock_count: negativeItems.length,
      orphan_source_count: orphanSources.length,
      job_material_mismatch_count: jobMaterialMismatches.length,
      reconciled: !orphanSources.length && !jobMaterialMismatches.length
    },
    by_source: bySource,
    negative_items: negativeItems.map(item => ({
      id: item.id, item_code: item.item_code, name: item.name, current_stock: Number(item.current_stock || 0)
    })),
    orphan_sources: orphanSources,
    job_material_mismatches: jobMaterialMismatches
  });
});

router.get('/stock/:itemId/movements', requirePermission('inventory'), (req, res) => {
  res.json(all(
    `SELECT * FROM stock_movements WHERE org_id=? AND item_id=? ORDER BY movement_date,id`,
    [req.query.org_id, req.params.itemId]
  ));
});

router.get('/bank', requirePermission('accounting'), (req, res) => {
  ensureAccounts(req.query.org_id);
  res.json(all(
    `SELECT jl.id journal_line_id,je.entry_date,je.voucher_type,je.voucher_number,je.narration,
      jl.debit,jl.credit,br.statement_date,br.statement_reference,COALESCE(br.matched,0) matched
     FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
     JOIN accounts a ON a.id=jl.account_id AND a.system_key='bank'
     LEFT JOIN bank_reconciliation br ON br.journal_line_id=jl.id AND br.org_id=je.org_id
     WHERE je.org_id=? AND je.deleted=0 AND (?='' OR je.fy=?)
     ORDER BY je.entry_date DESC,je.id DESC`,
    [req.query.org_id, req.query.fy || '', req.query.fy || '']
  ));
});

router.put('/bank/:journalLineId', requirePermission('accounting'), (req, res) => {
  const line = get(
    `SELECT je.org_id FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
     JOIN accounts a ON a.id=jl.account_id
     WHERE jl.id=? AND a.system_key='bank' AND je.deleted=0`,
    [req.params.journalLineId]
  );
  if (!line) return res.status(404).json({ error: 'Bank journal line not found' });
  if (!requireOrgAccess(req, res, line.org_id)) return;
  if (Number(req.body.org_id) !== Number(line.org_id)) {
    return res.status(400).json({ error: 'Bank journal line does not belong to this company' });
  }
  run(
    `INSERT INTO bank_reconciliation
     (org_id,journal_line_id,statement_date,statement_reference,matched,matched_by,matched_at)
     VALUES (?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(org_id,journal_line_id) DO UPDATE SET
       statement_date=excluded.statement_date,statement_reference=excluded.statement_reference,
       matched=excluded.matched,matched_by=excluded.matched_by,matched_at=datetime('now')`,
    [req.body.org_id, req.params.journalLineId, req.body.statement_date || null,
     req.body.statement_reference || '', req.body.matched ? 1 : 0, req.user.id]
  );
  res.json({ success: true });
});

router.get('/bank-statements', requirePermission('accounting'), (req, res) => {
  res.json(all(
    `SELECT bsr.*,bsi.file_name,bsi.imported_at,je.voucher_number,je.voucher_type
     FROM bank_statement_rows bsr
     JOIN bank_statement_imports bsi ON bsi.id=bsr.import_id
     LEFT JOIN journal_lines jl ON jl.id=bsr.journal_line_id
     LEFT JOIN journal_entries je ON je.id=jl.entry_id
     WHERE bsr.org_id=?
     ORDER BY bsr.transaction_date DESC,bsr.id DESC`,
    [req.query.org_id]
  ));
});

router.post('/bank-statements/import', requirePermission('bank_import'), (req, res) => {
  const { org_id, file_name, file_hash, mapping, rows } = req.body;
  if (!org_id || !Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'Company and statement rows are required' });
  }
  const cleanRows = rows.map(row => ({
    transaction_date: String(row.transaction_date || '').slice(0, 10),
    description: String(row.description || '').slice(0, 500),
    reference: String(row.reference || '').slice(0, 120),
    debit: round(row.debit),
    credit: round(row.credit),
    balance: round(row.balance)
  })).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.transaction_date));
  if (!cleanRows.length) return res.status(400).json({ error: 'No valid dated transactions were found' });
  if (file_hash && get('SELECT id FROM bank_statement_imports WHERE org_id=? AND file_hash=?', [org_id, file_hash])) {
    return res.status(409).json({ error: 'This bank statement file was already imported' });
  }

  let importId;
  let matchedCount = 0;
  transaction(() => {
    const imported = run(
      `INSERT INTO bank_statement_imports (org_id,file_name,imported_by,file_hash,mapping_json) VALUES (?,?,?,?,?)`,
      [org_id, String(file_name || 'bank-statement').slice(0, 255), req.user.id,
       file_hash || null, JSON.stringify(mapping || {})]
    );
    importId = imported.lastInsertRowid;
    cleanRows.forEach(row => {
      const candidates = all(
        `SELECT jl.id FROM journal_lines jl
         JOIN journal_entries je ON je.id=jl.entry_id
         JOIN accounts a ON a.id=jl.account_id AND a.system_key='bank'
         LEFT JOIN bank_reconciliation br ON br.org_id=je.org_id AND br.journal_line_id=jl.id
         WHERE je.org_id=? AND je.deleted=0 AND je.entry_date=? AND COALESCE(br.matched,0)=0
           AND ((? > 0 AND ABS(jl.credit-?) < 0.01) OR (? > 0 AND ABS(jl.debit-?) < 0.01))`,
        [org_id, row.transaction_date, row.debit, row.debit, row.credit, row.credit]
      );
      const journalLineId = candidates.length === 1 ? candidates[0].id : null;
      const inserted = run(
        `INSERT INTO bank_statement_rows
         (import_id,org_id,transaction_date,description,reference,debit,credit,balance,journal_line_id,matched)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [importId, org_id, row.transaction_date, row.description, row.reference,
         row.debit, row.credit, row.balance, journalLineId, journalLineId ? 1 : 0]
      );
      if (journalLineId) {
        matchedCount += 1;
        run(
          `INSERT INTO bank_reconciliation
           (org_id,journal_line_id,statement_date,statement_reference,matched,matched_by,matched_at)
           VALUES (?,?,?,?,1,?,datetime('now'))
           ON CONFLICT(org_id,journal_line_id) DO UPDATE SET
             statement_date=excluded.statement_date,statement_reference=excluded.statement_reference,
             matched=1,matched_by=excluded.matched_by,matched_at=datetime('now')`,
          [org_id, journalLineId, row.transaction_date, row.reference, req.user.id]
        );
      }
    });
  });
  res.json({ success: true, import_id: importId, imported: cleanRows.length, matched: matchedCount });
});

router.put('/bank-statements/:rowId/match', requirePermission('accounting'), (req, res) => {
  const row = get('SELECT * FROM bank_statement_rows WHERE id=?', [req.params.rowId]);
  if (!row) return res.status(404).json({ error: 'Statement row not found' });
  if (!requireOrgAccess(req, res, row.org_id)) return;
  const journalLineId = req.body.journal_line_id ? Number(req.body.journal_line_id) : null;
  if (journalLineId) {
    const line = get(
      `SELECT je.org_id FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
       JOIN accounts a ON a.id=jl.account_id
       WHERE jl.id=? AND a.system_key='bank' AND je.deleted=0`,
      [journalLineId]
    );
    if (!line || Number(line.org_id) !== Number(row.org_id)) {
      return res.status(400).json({ error: 'Select a bank transaction from the same company' });
    }
  }
  transaction(() => {
    run('UPDATE bank_statement_rows SET journal_line_id=?,matched=? WHERE id=?',
      [journalLineId, journalLineId ? 1 : 0, row.id]);
    if (journalLineId) {
      run(
        `INSERT INTO bank_reconciliation
         (org_id,journal_line_id,statement_date,statement_reference,matched,matched_by,matched_at)
         VALUES (?,?,?,?,1,?,datetime('now'))
         ON CONFLICT(org_id,journal_line_id) DO UPDATE SET
           statement_date=excluded.statement_date,statement_reference=excluded.statement_reference,
           matched=1,matched_by=excluded.matched_by,matched_at=datetime('now')`,
        [row.org_id, journalLineId, row.transaction_date, row.reference, req.user.id]
      );
    }
  });
  res.json({ success: true });
});

router.get('/locks', requirePermission('settings'), (req, res) => {
  res.json(all('SELECT * FROM financial_year_locks WHERE org_id=? ORDER BY fy DESC', [req.query.org_id]));
});

router.get('/locks/:fy/status', requirePermission('settings'), (req, res) => {
  const orgId = Number(req.query.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  try {
    res.json(yearClosingStatus(orgId, req.params.fy));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put('/locks/:fy', requirePermission('settings'), (req, res) => {
  const existing = get('SELECT closed FROM financial_year_locks WHERE org_id=? AND fy=?', [req.body.org_id, req.params.fy]);
  if (existing?.closed && !req.body.locked) {
    return res.status(409).json({ error: 'Financial year is closed. Use Reopen Year before unlocking.' });
  }
  run(
    `INSERT INTO financial_year_locks (org_id,fy,locked,locked_by,locked_at)
     VALUES (?,?,?,?,datetime('now'))
     ON CONFLICT(org_id,fy) DO UPDATE SET locked=excluded.locked,locked_by=excluded.locked_by,locked_at=datetime('now')`,
    [req.body.org_id, req.params.fy, req.body.locked ? 1 : 0, req.user.id]
  );
  run('INSERT INTO audit_log (user_id,org_id,action,table_name,new_data,ip_address) VALUES (?,?,?,?,?,?)',
    [req.user.id, req.body.org_id, req.body.locked ? 'LOCK_FY' : 'UNLOCK_FY',
     'financial_year_locks', JSON.stringify({ fy: req.params.fy }), req.ip]);
  res.json({ success: true });
});

router.post('/locks/:fy/close', requirePermission('settings'), (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  const orgId = Number(req.body.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  const status = yearClosingStatus(orgId, req.params.fy);
  if (!status.can_close && !req.body.force) {
    return res.status(409).json({ error: 'Resolve financial year closing blockers before closing', checks: status.checks });
  }
  const snapshot = {
    closed_at: new Date().toISOString(),
    closed_by: req.user.id,
    note: String(req.body.note || '').slice(0, 1000),
    report: status.report,
    checks: status.checks
  };
  transaction(() => {
    run(
      `INSERT INTO financial_year_locks
       (org_id,fy,locked,locked_by,locked_at,closed,closed_by,closed_at,close_note,close_snapshot_json)
       VALUES (?,?,?,?,datetime('now'),1,?,datetime('now'),?,?)
       ON CONFLICT(org_id,fy) DO UPDATE SET
         locked=1,locked_by=excluded.locked_by,locked_at=datetime('now'),
         closed=1,closed_by=excluded.closed_by,closed_at=datetime('now'),
         close_note=excluded.close_note,close_snapshot_json=excluded.close_snapshot_json`,
      [orgId, req.params.fy, 1, req.user.id, req.user.id, snapshot.note, JSON.stringify(snapshot)]
    );
    run('INSERT INTO audit_log (user_id,org_id,action,table_name,new_data,ip_address) VALUES (?,?,?,?,?,?)',
      [req.user.id, orgId, 'CLOSE_FY', 'financial_year_locks',
       JSON.stringify({ fy: req.params.fy, forced: Boolean(req.body.force), summary: status.report.profit_loss }),
       req.ip]);
  });
  res.json({ success: true, status: yearClosingStatus(orgId, req.params.fy) });
});

router.post('/locks/:fy/reopen', requirePermission('settings'), (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  const orgId = Number(req.body.org_id);
  const reason = String(req.body.reason || '').trim();
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  if (reason.length < 8) return res.status(400).json({ error: 'Reopen reason of at least 8 characters is required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  const existing = get('SELECT * FROM financial_year_locks WHERE org_id=? AND fy=?', [orgId, req.params.fy]);
  if (!existing?.closed) return res.status(400).json({ error: 'Financial year is not closed' });
  transaction(() => {
    run(
      `UPDATE financial_year_locks
       SET closed=0,locked=0,reopened_by=?,reopened_at=datetime('now'),reopen_reason=?
       WHERE org_id=? AND fy=?`,
      [req.user.id, reason.slice(0, 1000), orgId, req.params.fy]
    );
    run('INSERT INTO audit_log (user_id,org_id,action,table_name,old_data,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
      [req.user.id, orgId, 'REOPEN_FY', 'financial_year_locks',
       JSON.stringify({ fy: req.params.fy, closed_at: existing.closed_at }),
       JSON.stringify({ fy: req.params.fy, reason }),
       req.ip]);
  });
  res.json({ success: true, status: yearClosingStatus(orgId, req.params.fy) });
});

module.exports = router;
