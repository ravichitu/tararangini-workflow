const express = require('express');
const router = express.Router();
const { get, run, all, transaction } = require('../db/db');
const {
  authMiddleware, checkOrgAccess, rejectLockedPeriod, isPeriodLocked,
  requirePermission, requireOrgAccess
} = require('../middleware/auth');
const { ensureAccounts, getFY } = require('../accounting/accounting');
const { defaultControl, parseJson } = require('../business/transaction-controls');

router.use(authMiddleware);
router.use(checkOrgAccess);

function fyDates(fy) {
  const startYear = Number(String(fy).split('-')[0]);
  return {
    start: `${startYear}-04-01`,
    end: `${startYear + 1}-03-31`
  };
}

function round(value) {
  return Number(Number(value || 0).toFixed(2));
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

function journalNumberParts(orgId, voucherType, dateValue) {
  const fy = getFY(dateValue);
  const cleanType = String(voucherType || 'JOURNAL').toUpperCase();
  const prefixes = {
    JOURNAL: 'JV', PURCHASE: 'PUR', EXPENSE: 'EXP',
    CONTRA: 'CV', CAPITAL: 'CAP', ADJUSTMENT: 'ADJ'
  };
  const prefix = prefixes[cleanType] || 'JV';
  const org = get('SELECT display_name FROM orgs WHERE id=?', [orgId]);
  const orgCode = org ? org.display_name.substring(0,3).toUpperCase() : 'ORG';
  return { fy, cleanType, prefix, orgCode, sequenceFormat: `JOURNAL_${cleanType}` };
}

function transactionRequiredFields(orgId, type) {
  const row = get('SELECT required_fields FROM transaction_control_settings WHERE org_id=? AND transaction_type=?', [orgId, type]);
  if (row) return parseJson(row.required_fields || '{}', {});
  const org = get('SELECT invoice_print_options FROM orgs WHERE id=?', [orgId]);
  return defaultControl(type, parseJson(org?.invoice_print_options || '{}', {})).required_fields;
}

function requireJournalControlFields(orgId, body) {
  const required = transactionRequiredFields(orgId, 'JOURNAL');
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const missing = [];
  if (required.voucher_type && !body.voucher_type) missing.push('Voucher Type');
  if (required.account_codes && !lines.every(line => Number(line.account_id))) missing.push('Account Codes');
  if (required.debit_credit_lines && !(lines.length >= 2 && lines.some(line => Number(line.debit) > 0) && lines.some(line => Number(line.credit) > 0))) {
    missing.push('Debit / Credit Lines');
  }
  if (required.footer && !body.narration) missing.push('Narration');
  if (missing.length) throw new Error(`JOURNAL required field missing: ${missing.join(', ')}`);
}

router.get('/next-number', requirePermission('accounting'), (req, res) => {
  const { org_id, voucher_type, date } = req.query;
  if (!org_id) return res.status(400).json({ error: 'org_id required' });
  const parts = journalNumberParts(org_id, voucher_type, date);
  const seq = get('SELECT last_number FROM bill_sequences WHERE org_id=? AND format=? AND fy=?',
    [org_id, parts.sequenceFormat, parts.fy]);
  const nextNum = Number(seq?.last_number || 0) + 1;
  res.json({
    number: `${parts.orgCode}/${parts.prefix}/${parts.fy}/${String(nextNum).padStart(4, '0')}`,
    fy: parts.fy
  });
});

router.get('/accounts', requirePermission('accounting'), (req, res) => {
  if (!req.query.org_id) return res.status(400).json({ error: 'org_id required' });
  ensureAccounts(req.query.org_id);
  res.json(all(
    `SELECT * FROM accounts WHERE org_id=? AND active=1
     ORDER BY CASE type WHEN 'asset' THEN 1 WHEN 'liability' THEN 2 WHEN 'equity' THEN 3 WHEN 'income' THEN 4 ELSE 5 END, code`,
    [req.query.org_id]
  ));
});

router.post('/accounts', requirePermission('accounting'), (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  const { org_id, code, name, type, subtype } = req.body;
  if (!org_id || !code || !name || !['asset', 'liability', 'equity', 'income', 'expense'].includes(type)) {
    return res.status(400).json({ error: 'Valid organization, code, name, and account type are required' });
  }
  try {
    const result = run(
      'INSERT INTO accounts (org_id,code,name,type,subtype) VALUES (?,?,?,?,?)',
      [org_id, code, name, type, subtype || 'custom']
    );
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (error) {
    res.status(400).json({ error: 'Account code already exists' });
  }
});

router.get('/journals', requirePermission('accounting'), (req, res) => {
  const { org_id, fy, search } = req.query;
  const page = pageParams(req.query);
  let sql = `SELECT je.*, u.name created_by_name,
    COALESCE(SUM(jl.debit),0) total_debit, COALESCE(SUM(jl.credit),0) total_credit
    FROM journal_entries je
    LEFT JOIN journal_lines jl ON jl.entry_id=je.id
    LEFT JOIN users u ON u.id=je.created_by
    WHERE je.org_id=? AND je.deleted=0`;
  const params = [org_id];
  if (fy) { sql += ' AND je.fy=?'; params.push(fy); }
  if (search) {
    sql += ` AND (je.voucher_number LIKE ? OR je.voucher_type LIKE ? OR je.narration LIKE ?)`;
    const s = `%${cleanText(search, 120)}%`;
    params.push(s, s, s);
  }
  sql += ' GROUP BY je.id ORDER BY je.entry_date DESC, je.id DESC LIMIT ? OFFSET ?';
  params.push(page.limit, page.offset);
  res.json(all(sql, params));
});

router.get('/journals/:id', requirePermission('accounting'), (req, res) => {
  const entry = get(`SELECT * FROM journal_entries WHERE id=? AND deleted=0 AND source_type='manual'`, [req.params.id]);
  if (!entry) return res.status(404).json({ error: 'Manual journal entry not found' });
  if (!requireOrgAccess(req, res, entry.org_id)) return;
  entry.lines = all('SELECT * FROM journal_lines WHERE entry_id=? ORDER BY id', [entry.id]);
  res.json(entry);
});

router.post('/journals', requirePermission('accounting'), rejectLockedPeriod, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  const { org_id, entry_date, voucher_type, narration, lines } = req.body;
  if (!org_id || !entry_date || !Array.isArray(lines) || lines.length < 2) {
    return res.status(400).json({ error: 'Date and at least two journal lines are required' });
  }
  try {
    requireJournalControlFields(org_id, req.body);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const cleanLines = lines
    .map(line => ({
      account_id: Number(line.account_id),
      party_id: line.party_id ? Number(line.party_id) : null,
      debit: round(line.debit),
      credit: round(line.credit),
      narration: line.narration || ''
    }))
    .filter(line => line.account_id && (line.debit > 0 || line.credit > 0));
  const debit = round(cleanLines.reduce((sum, line) => sum + line.debit, 0));
  const credit = round(cleanLines.reduce((sum, line) => sum + line.credit, 0));
  if (cleanLines.length < 2 || debit <= 0 || Math.abs(debit - credit) > 0.01) {
    return res.status(400).json({ error: `Entry must balance. Debit ${debit.toFixed(2)}, Credit ${credit.toFixed(2)}` });
  }
  const invalid = cleanLines.find(line => !get('SELECT id FROM accounts WHERE id=? AND org_id=?', [line.account_id, org_id]));
  if (invalid) return res.status(400).json({ error: 'Invalid account selected' });

  const parts = journalNumberParts(org_id, voucher_type, entry_date);
  const sequence = get('SELECT last_number FROM bill_sequences WHERE org_id=? AND format=? AND fy=?',
    [org_id, parts.sequenceFormat, parts.fy]);
  const nextNum = Number(sequence?.last_number || 0) + 1;
  const voucherNumber = `${parts.orgCode}/${parts.prefix}/${parts.fy}/${String(nextNum).padStart(4, '0')}`;
  const entryId = transaction(() => {
    if (sequence) {
      run('UPDATE bill_sequences SET last_number=? WHERE org_id=? AND format=? AND fy=?',
        [nextNum, org_id, parts.sequenceFormat, parts.fy]);
    } else {
      run('INSERT INTO bill_sequences (org_id,format,fy,prefix,last_number) VALUES (?,?,?,?,?)',
        [org_id, parts.sequenceFormat, parts.fy, parts.prefix, nextNum]);
    }
    const entry = run(
      `INSERT INTO journal_entries
       (org_id,entry_date,fy,voucher_type,voucher_number,narration,source_type,source_id,created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [org_id, entry_date, parts.fy, parts.cleanType, voucherNumber, narration || '', 'manual', Date.now(), req.user.id]
    );
    cleanLines.forEach(line => run(
      `INSERT INTO journal_lines (entry_id,account_id,party_id,debit,credit,narration)
       VALUES (?,?,?,?,?,?)`,
      [entry.lastInsertRowid, line.account_id, line.party_id, line.debit, line.credit, line.narration]
    ));
    return entry.lastInsertRowid;
  });
  res.json({ success: true, id: entryId, voucher_number: voucherNumber });
});

router.patch('/journals/:id', requirePermission('accounting'), (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  const entry = get(`SELECT * FROM journal_entries WHERE id=? AND deleted=0 AND source_type='manual'`, [req.params.id]);
  if (!entry) return res.status(404).json({ error: 'Manual journal entry not found' });
  if (!requireOrgAccess(req, res, entry.org_id)) return;
  const reason = cleanText(req.body.reason, 500);
  if (reason.length < 5) return res.status(400).json({ error: 'Enter an edit reason of at least 5 characters' });
  if (Number(req.body.org_id) !== Number(entry.org_id)) return res.status(400).json({ error: 'Company cannot be changed while editing' });
  if (isPeriodLocked(entry.org_id, entry.entry_date)) return res.status(423).json({ error: `Financial year ${entry.fy} is locked` });
  if (getFY(req.body.entry_date) !== entry.fy) return res.status(400).json({ error: 'Journal date cannot be moved to another financial year' });
  try { requireJournalControlFields(entry.org_id, req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const lines = (req.body.lines || []).map(line => ({
    account_id: Number(line.account_id), party_id: line.party_id ? Number(line.party_id) : null,
    debit: round(line.debit), credit: round(line.credit), narration: cleanText(line.narration)
  })).filter(line => line.account_id && (line.debit > 0 || line.credit > 0));
  const debit = round(lines.reduce((sum, line) => sum + line.debit, 0));
  const credit = round(lines.reduce((sum, line) => sum + line.credit, 0));
  if (lines.length < 2 || debit <= 0 || Math.abs(debit - credit) > 0.01) {
    return res.status(400).json({ error: `Entry must balance. Debit ${debit.toFixed(2)}, Credit ${credit.toFixed(2)}` });
  }
  if (lines.some(line => !get('SELECT id FROM accounts WHERE id=? AND org_id=?', [line.account_id, entry.org_id]))) {
    return res.status(400).json({ error: 'Invalid account selected' });
  }
  const oldLines = all('SELECT * FROM journal_lines WHERE entry_id=? ORDER BY id', [entry.id]);
  const updated = transaction(() => {
    run('UPDATE journal_entries SET entry_date=?,voucher_type=?,narration=? WHERE id=?',
      [req.body.entry_date, cleanText(req.body.voucher_type, 40).toUpperCase(), cleanText(req.body.narration), entry.id]);
    run('DELETE FROM journal_lines WHERE entry_id=?', [entry.id]);
    lines.forEach(line => run(
      'INSERT INTO journal_lines (entry_id,account_id,party_id,debit,credit,narration) VALUES (?,?,?,?,?,?)',
      [entry.id, line.account_id, line.party_id, line.debit, line.credit, line.narration]
    ));
    const row = get('SELECT * FROM journal_entries WHERE id=?', [entry.id]);
    run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,old_data,new_data,ip_address) VALUES (?,?,?,?,?,?,?,?)',
      [req.user.id, entry.org_id, 'UPDATE_JOURNAL', 'journal_entries', entry.id,
        JSON.stringify({ ...entry, lines: oldLines }), JSON.stringify({ reason, transaction: { ...row, lines } }), req.ip]);
    return row;
  });
  res.json({ success: true, journal: updated });
});

router.delete('/journals/:id', requirePermission('accounting'), (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  const entry = get(`SELECT * FROM journal_entries WHERE id=? AND source_type='manual'`, [req.params.id]);
  if (!entry) return res.status(404).json({ error: 'Only manual journal entries can be deleted' });
  if (!requireOrgAccess(req, res, entry.org_id)) return;
  const reason = cleanText(req.body.reason, 500);
  if (reason.length < 5) return res.status(400).json({ error: 'Enter a deletion reason of at least 5 characters' });
  if (isPeriodLocked(entry.org_id, entry.entry_date)) {
    return res.status(423).json({ error: `Financial year ${entry.fy} is locked` });
  }
  transaction(() => {
    run('UPDATE journal_entries SET deleted=1 WHERE id=?', [entry.id]);
    run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,old_data,new_data,ip_address) VALUES (?,?,?,?,?,?,?,?)',
      [req.user.id, entry.org_id, 'DELETE_JOURNAL', 'journal_entries', entry.id,
        JSON.stringify({ ...entry, lines: all('SELECT * FROM journal_lines WHERE entry_id=? ORDER BY id', [entry.id]) }),
        JSON.stringify({ reason }), req.ip]);
  });
  res.json({ success: true });
});

router.get('/reports', requirePermission('reports'), (req, res) => {
  const { org_id, fy } = req.query;
  if (!org_id || !fy) return res.status(400).json({ error: 'org_id and fy required' });
  ensureAccounts(org_id);
  const { start, end } = fyDates(fy);

  const trialBalance = all(
    `SELECT a.id account_id,a.code,a.name,a.type,a.subtype,a.system_key,
      COALESCE(SUM(jl.debit),0) debit,COALESCE(SUM(jl.credit),0) credit
     FROM journal_lines jl
     JOIN journal_entries je ON je.id=jl.entry_id
     JOIN accounts a ON a.id=jl.account_id
     WHERE a.org_id=? AND a.active=1 AND je.deleted=0 AND je.entry_date BETWEEN ? AND ?
     GROUP BY a.id HAVING ABS(SUM(jl.debit))>0.004 OR ABS(SUM(jl.credit))>0.004 ORDER BY a.code`,
    [org_id, start, end]
  ).map(row => ({ ...row, debit: round(row.debit), credit: round(row.credit) }));

  const cumulative = all(
    `SELECT a.id account_id,a.code,a.name,a.type,a.subtype,a.system_key,
      COALESCE(SUM(jl.debit),0) debit,COALESCE(SUM(jl.credit),0) credit
     FROM journal_lines jl
     JOIN journal_entries je ON je.id=jl.entry_id
     JOIN accounts a ON a.id=jl.account_id
     WHERE a.org_id=? AND a.active=1 AND je.deleted=0 AND je.entry_date<=?
     GROUP BY a.id ORDER BY a.code`,
    [org_id, end]
  );

  const income = trialBalance
    .filter(row => row.type === 'income')
    .map(row => ({ ...row, amount: round(row.credit - row.debit) }));
  const expenses = trialBalance
    .filter(row => row.type === 'expense')
    .map(row => ({ ...row, amount: round(row.debit - row.credit) }));
  const totalIncome = round(income.reduce((sum, row) => sum + row.amount, 0));
  const totalExpenses = round(expenses.reduce((sum, row) => sum + row.amount, 0));
  const netProfit = round(totalIncome - totalExpenses);

  const assets = cumulative
    .filter(row => row.type === 'asset')
    .map(row => ({ ...row, amount: round(row.debit - row.credit) }))
    .filter(row => Math.abs(row.amount) > 0.004);
  const liabilities = cumulative
    .filter(row => row.type === 'liability')
    .map(row => ({ ...row, amount: round(row.credit - row.debit) }))
    .filter(row => Math.abs(row.amount) > 0.004);
  const equity = cumulative
    .filter(row => row.type === 'equity')
    .map(row => ({ ...row, amount: round(row.credit - row.debit) }))
    .filter(row => Math.abs(row.amount) > 0.004);

  const lifetimeIncome = cumulative.filter(row => row.type === 'income')
    .reduce((sum, row) => sum + Number(row.credit) - Number(row.debit), 0);
  const lifetimeExpense = cumulative.filter(row => row.type === 'expense')
    .reduce((sum, row) => sum + Number(row.debit) - Number(row.credit), 0);
  const retainedProfit = round(lifetimeIncome - lifetimeExpense);
  const totalAssets = round(assets.reduce((sum, row) => sum + row.amount, 0));
  const totalLiabilities = round(liabilities.reduce((sum, row) => sum + row.amount, 0));
  const totalEquity = round(equity.reduce((sum, row) => sum + row.amount, 0) + retainedProfit);

  const dayBook = all(
    `SELECT je.id,je.entry_date,je.voucher_type,je.voucher_number,je.narration,
      COALESCE(SUM(jl.debit),0) debit,COALESCE(SUM(jl.credit),0) credit
     FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id
     WHERE je.org_id=? AND je.deleted=0 AND je.entry_date BETWEEN ? AND ?
     GROUP BY je.id ORDER BY je.entry_date,je.id`,
    [org_id, start, end]
  );

  const cashBank = cumulative
    .filter(row => ['cash', 'bank'].includes(row.system_key))
    .map(row => ({ ...row, amount: round(row.debit - row.credit) }));

  const partyBalances = all(
    `SELECT p.id party_id,p.name,p.type,
      a.system_key,COALESCE(SUM(jl.debit),0) debit,COALESCE(SUM(jl.credit),0) credit
     FROM journal_lines jl
     JOIN journal_entries je ON je.id=jl.entry_id AND je.deleted=0
     JOIN accounts a ON a.id=jl.account_id
     JOIN parties p ON p.id=jl.party_id
     WHERE je.org_id=? AND je.entry_date<=? AND a.system_key IN ('accounts_receivable','accounts_payable')
     GROUP BY p.id,a.system_key ORDER BY p.name`,
    [org_id, end]
  );
  const receivables = partyBalances
    .filter(row => row.system_key === 'accounts_receivable' && row.debit - row.credit > 0.004)
    .map(row => ({ ...row, amount: round(row.debit - row.credit) }));
  const payables = partyBalances
    .filter(row => row.system_key === 'accounts_payable' && row.credit - row.debit > 0.004)
    .map(row => ({ ...row, amount: round(row.credit - row.debit) }));

  const gst = get(
    `SELECT COALESCE(SUM(taxable_amount),0) taxable,
      COALESCE(SUM(cgst),0) cgst,COALESCE(SUM(sgst),0) sgst,
      COALESCE(SUM(igst),0) igst,COALESCE(SUM(total_tax),0) total_tax
     FROM bills WHERE org_id=? AND format IN ('SALE','PP') AND deleted=0 AND status='saved' AND bill_date BETWEEN ? AND ?`,
    [org_id, start, end]
  );
  const inputGst = get(
    `SELECT COALESCE(SUM(total_tax),0) total_tax FROM purchases
     WHERE org_id=? AND deleted=0 AND purchase_date BETWEEN ? AND ?`,
    [org_id, start, end]
  );

  const salesRegister = all(
    `SELECT b.bill_date,b.bill_number,p.name party_name,b.payment_mode,b.taxable_amount,
      b.cgst,b.sgst,b.igst,b.total_tax,b.grand_total
     FROM bills b LEFT JOIN parties p ON p.id=b.party_id
     WHERE b.org_id=? AND b.format IN ('SALE','PP') AND b.deleted=0 AND b.status='saved'
       AND b.bill_date BETWEEN ? AND ? ORDER BY b.bill_date,b.id`,
    [org_id, start, end]
  );
  const paymentRegister = all(
    `SELECT py.payment_date,py.payment_number,p.name party_name,py.type,py.mode,py.amount,py.reference,py.narration
     FROM payments py LEFT JOIN parties p ON p.id=py.party_id
     WHERE py.org_id=? AND py.deleted=0 AND py.payment_date BETWEEN ? AND ?
     ORDER BY py.payment_date,py.id`,
    [org_id, start, end]
  );
  const expenseRegister = all(
    `SELECT je.entry_date,je.voucher_number,je.voucher_type,je.narration,
      a.name account_name,p.name party_name,SUM(jl.debit) amount
     FROM journal_entries je
     JOIN journal_lines jl ON jl.entry_id=je.id AND jl.debit>0
     JOIN accounts a ON a.id=jl.account_id AND a.type='expense'
     LEFT JOIN parties p ON p.id=jl.party_id
     WHERE je.org_id=? AND je.deleted=0 AND je.entry_date BETWEEN ? AND ?
     GROUP BY je.id,a.id,p.id ORDER BY je.entry_date,je.id`,
    [org_id, start, end]
  );

  res.json({
    fy,
    period: { start, end },
    trial_balance: trialBalance,
    profit_loss: { income, expenses, total_income: totalIncome, total_expenses: totalExpenses, net_profit: netProfit },
    balance_sheet: {
      assets,
      liabilities,
      equity,
      retained_profit: retainedProfit,
      total_assets: totalAssets,
      total_liabilities: totalLiabilities,
      total_equity: totalEquity,
      total_liabilities_equity: round(totalLiabilities + totalEquity),
      difference: round(totalAssets - totalLiabilities - totalEquity)
    },
    day_book: dayBook,
    cash_bank: cashBank,
    receivables,
    payables,
    gst: {
      taxable: round(gst?.taxable),
      cgst: round(gst?.cgst),
      sgst: round(gst?.sgst),
      igst: round(gst?.igst),
      total_tax: round(gst?.total_tax)
      ,input_tax_credit: round(inputGst?.total_tax)
      ,net_tax_payable: round(Number(gst?.total_tax || 0) - Number(inputGst?.total_tax || 0))
    },
    sales_register: salesRegister,
    payment_register: paymentRegister,
    expense_register: expenseRegister
  });
});

router.get('/ledger/:accountId', requirePermission('reports'), (req, res) => {
  const { org_id, fy } = req.query;
  const { start, end } = fyDates(fy);
  const account = get('SELECT * FROM accounts WHERE id=? AND org_id=?', [req.params.accountId, org_id]);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const entries = all(
    `SELECT je.entry_date,je.voucher_type,je.voucher_number,je.narration,
      p.name party_name,jl.debit,jl.credit
     FROM journal_lines jl
     JOIN journal_entries je ON je.id=jl.entry_id
     LEFT JOIN parties p ON p.id=jl.party_id
     WHERE jl.account_id=? AND je.org_id=? AND je.deleted=0 AND je.entry_date BETWEEN ? AND ?
     ORDER BY je.entry_date,je.id,jl.id`,
    [req.params.accountId, org_id, start, end]
  );
  let balance = 0;
  entries.forEach(entry => {
    balance = round(balance + Number(entry.debit) - Number(entry.credit));
    entry.balance = balance;
  });
  res.json({ account, entries, closing_balance: balance });
});

module.exports = router;
