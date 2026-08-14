const { get, run, all, transaction } = require('../db/db');

const DEFAULT_ACCOUNTS = [
  ['1000', 'Cash in Hand', 'asset', 'cash', 'cash'],
  ['1010', 'Bank / UPI', 'asset', 'bank', 'bank'],
  ['1100', 'Accounts Receivable', 'asset', 'receivable', 'accounts_receivable'],
  ['1200', 'Input GST Credit', 'asset', 'tax', 'input_gst'],
  ['1500', 'Fixed Assets', 'asset', 'fixed_asset', 'fixed_assets'],
  ['2000', 'Accounts Payable', 'liability', 'payable', 'accounts_payable'],
  ['2100', 'Output CGST', 'liability', 'tax', 'output_cgst'],
  ['2110', 'Output SGST', 'liability', 'tax', 'output_sgst'],
  ['2120', 'Output IGST', 'liability', 'tax', 'output_igst'],
  ['2200', 'Loans and Borrowings', 'liability', 'loan', 'loans'],
  ['3000', 'Owner Capital', 'equity', 'capital', 'capital'],
  ['4000', 'Sales', 'income', 'sales', 'sales'],
  ['4100', 'Other Income', 'income', 'other_income', 'other_income'],
  ['5000', 'Purchases / Direct Costs', 'expense', 'purchase', 'purchases'],
  ['6000', 'General Expenses', 'expense', 'general', 'general_expense'],
  ['6100', 'Salaries and Wages', 'expense', 'salary', 'salaries'],
  ['6200', 'Rent', 'expense', 'rent', 'rent'],
  ['6300', 'Utilities', 'expense', 'utilities', 'utilities'],
  ['6400', 'Transport and Delivery', 'expense', 'transport', 'transport'],
  ['6500', 'Depreciation', 'expense', 'depreciation', 'depreciation'],
  ['6600', 'Rounding Adjustment', 'expense', 'rounding', 'round_off']
];

function getFY(dateValue) {
  const date = new Date(`${dateValue || new Date().toISOString().slice(0, 10)}T00:00:00`);
  const year = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return `${year}-${String(year + 1).slice(-2)}`;
}

function ensureAccounts(orgId) {
  DEFAULT_ACCOUNTS.forEach(([code, name, type, subtype, systemKey]) => {
    run(
      `INSERT OR IGNORE INTO accounts (org_id,code,name,type,subtype,system_key) VALUES (?,?,?,?,?,?)`,
      [orgId, code, name, type, subtype, systemKey]
    );
  });
}

function accountId(orgId, systemKey) {
  ensureAccounts(orgId);
  const account = get('SELECT id FROM accounts WHERE org_id=? AND system_key=?', [orgId, systemKey]);
  if (!account) throw new Error(`Missing accounting account: ${systemKey}`);
  return account.id;
}

function replaceSourceEntry({ orgId, date, voucherType, voucherNumber, narration, sourceType, sourceId, createdBy, lines }) {
  const debit = lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
  const credit = lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
  if (Math.abs(debit - credit) > 0.01 || debit <= 0) {
    throw new Error(`Unbalanced journal entry: debit ${debit.toFixed(2)}, credit ${credit.toFixed(2)}`);
  }

  return transaction(() => {
    const old = get(
      'SELECT id FROM journal_entries WHERE org_id=? AND source_type=? AND source_id=?',
      [orgId, sourceType, sourceId]
    );
    if (old) {
      run('DELETE FROM journal_lines WHERE entry_id=?', [old.id]);
      run('DELETE FROM journal_entries WHERE id=?', [old.id]);
    }
    const entry = run(
      `INSERT INTO journal_entries
       (org_id,entry_date,fy,voucher_type,voucher_number,narration,source_type,source_id,created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [orgId, date, getFY(date), voucherType, voucherNumber, narration || '', sourceType, sourceId, createdBy || null]
    );
    lines.forEach(line => run(
      `INSERT INTO journal_lines (entry_id,account_id,party_id,debit,credit,narration)
       VALUES (?,?,?,?,?,?)`,
      [entry.lastInsertRowid, line.accountId, line.partyId || null, Number(line.debit || 0), Number(line.credit || 0), line.narration || '']
    ));
    return entry.lastInsertRowid;
  });
}

function removeSourceEntry(orgId, sourceType, sourceId) {
  const entry = get(
    'SELECT id FROM journal_entries WHERE org_id=? AND source_type=? AND source_id=?',
    [orgId, sourceType, sourceId]
  );
  if (!entry) return;
  transaction(() => {
    run('DELETE FROM journal_lines WHERE entry_id=?', [entry.id]);
    run('DELETE FROM journal_entries WHERE id=?', [entry.id]);
  });
}

function postBill(bill) {
  if (!bill || bill.deleted || bill.status !== 'saved' || !['SALE', 'PP'].includes(bill.format)) {
    if (bill) removeSourceEntry(bill.org_id, 'bill', bill.id);
    return;
  }
  let splitPayments = [];
  try { splitPayments = JSON.parse(bill.split_payments || '[]'); } catch (_) {}
  const lines = [];
  if (splitPayments.length) {
    splitPayments.filter(payment => Number(payment.amount) > 0).forEach(payment => {
      const key = payment.mode === 'cash' ? 'cash' : 'accounts_receivable';
      lines.push({
        accountId: accountId(bill.org_id, key), partyId: bill.party_id,
        debit: Number(payment.amount)
      });
    });
  } else {
    const moneyAccount = bill.payment_mode === 'cash'
      ? accountId(bill.org_id, 'cash')
      : accountId(bill.org_id, 'accounts_receivable');
    lines.push({ accountId: moneyAccount, partyId: bill.party_id, debit: bill.grand_total });
  }
  lines.push({ accountId: accountId(bill.org_id, 'sales'), credit: bill.taxable_amount });
  if (Number(bill.cgst) > 0) lines.push({ accountId: accountId(bill.org_id, 'output_cgst'), credit: bill.cgst });
  if (Number(bill.sgst) > 0) lines.push({ accountId: accountId(bill.org_id, 'output_sgst'), credit: bill.sgst });
  if (Number(bill.igst) > 0) lines.push({ accountId: accountId(bill.org_id, 'output_igst'), credit: bill.igst });
  if (Number(bill.swipe_charge) > 0) {
    lines.push({ accountId: accountId(bill.org_id, 'other_income'), credit: Number(bill.swipe_charge) });
  }
  const roundOff = Number(bill.round_off || 0);
  if (roundOff > 0.001) lines.push({ accountId: accountId(bill.org_id, 'round_off'), credit: roundOff });
  if (roundOff < -0.001) lines.push({ accountId: accountId(bill.org_id, 'round_off'), debit: Math.abs(roundOff) });
  replaceSourceEntry({
    orgId: bill.org_id,
    date: bill.bill_date,
    voucherType: 'SALE',
    voucherNumber: bill.bill_number,
    narration: `Sale bill ${bill.bill_number}`,
    sourceType: 'bill',
    sourceId: bill.id,
    createdBy: bill.created_by,
    lines
  });
}

function immediateCashAmount(bill) {
  let split = [];
  try { split = JSON.parse(bill.split_payments || '[]'); } catch (_) {}
  if (split.length) {
    return split
      .filter(payment => payment.mode === 'cash')
      .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  }
  return bill.payment_mode === 'cash' ? Number(bill.grand_total || 0) : 0;
}

function billSettlement(bill) {
  const allocated = get(
    `SELECT COALESCE(SUM(pa.amount),0) paid
     FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id
     WHERE pa.bill_id=? AND p.deleted=0 AND p.type='received'`,
    [bill.id]
  )?.paid || 0;
  const credited = get(
    `SELECT COALESCE(SUM(grand_total),0) credited
     FROM credit_debit_notes
     WHERE linked_bill_id=? AND note_type='credit' AND deleted=0`,
    [bill.id]
  )?.credited || 0;
  const paid = Math.min(
    Number(bill.grand_total || 0),
    immediateCashAmount(bill) + Number(allocated) + Number(credited)
  );
  const outstanding = Math.max(0, Number(bill.grand_total || 0) - paid);
  return {
    paid_amount: Number(paid.toFixed(2)),
    receipt_amount: Number(Number(allocated).toFixed(2)),
    credit_note_amount: Number(Number(credited).toFixed(2)),
    outstanding: Number(outstanding.toFixed(2)),
    payment_status: outstanding <= 0.01 ? 'paid' : paid > 0 ? 'partly paid'
      : bill.due_date && bill.due_date < new Date().toISOString().slice(0, 10) ? 'overdue' : 'unpaid'
  };
}

function postPayment(payment) {
  if (!payment || payment.deleted) {
    if (payment) removeSourceEntry(payment.org_id, 'payment', payment.id);
    return;
  }
  const selectedDeposit = Number(payment.deposit_account_id || 0)
    ? get('SELECT id FROM accounts WHERE id=? AND org_id=? AND active=1', [payment.deposit_account_id, payment.org_id])
    : null;
  const cashBank = selectedDeposit?.id || (payment.mode === 'cash'
    ? accountId(payment.org_id, 'cash')
    : accountId(payment.org_id, 'bank'));
  const amount = Number(payment.amount || 0);
  const hasBillAllocation = Boolean(get(
    'SELECT id FROM payment_allocations WHERE payment_id=? LIMIT 1',
    [payment.id]
  ));
  let lines;
  if (payment.type === 'received') {
    const creditAccount = payment.party_id || hasBillAllocation
      ? accountId(payment.org_id, 'accounts_receivable')
      : accountId(payment.org_id, 'other_income');
    lines = [
      { accountId: cashBank, debit: amount },
      { accountId: creditAccount, partyId: payment.party_id, credit: amount }
    ];
  } else {
    const debitAccount = payment.party_id
      ? accountId(payment.org_id, 'accounts_payable')
      : accountId(payment.org_id, 'general_expense');
    lines = [
      { accountId: debitAccount, partyId: payment.party_id, debit: amount },
      { accountId: cashBank, credit: amount }
    ];
  }
  replaceSourceEntry({
    orgId: payment.org_id,
    date: payment.payment_date,
    voucherType: payment.type === 'received' ? 'RECEIPT' : 'PAYMENT',
    voucherNumber: payment.payment_number,
    narration: payment.narration || payment.reference || '',
    sourceType: 'payment',
    sourceId: payment.id,
    createdBy: payment.created_by,
    lines
  });
}

function postPurchase(purchase) {
  if (!purchase || purchase.deleted) {
    if (purchase) removeSourceEntry(purchase.org_id, 'purchase', purchase.id);
    return;
  }
  const moneyAccount = purchase.payment_mode === 'credit'
    ? accountId(purchase.org_id, 'accounts_payable')
    : purchase.payment_mode === 'cash'
      ? accountId(purchase.org_id, 'cash')
      : accountId(purchase.org_id, 'bank');
  const lines = [
    { accountId: accountId(purchase.org_id, 'purchases'), partyId: purchase.party_id, debit: purchase.taxable_amount }
  ];
  if (Number(purchase.total_tax) > 0) {
    lines.push({ accountId: accountId(purchase.org_id, 'input_gst'), debit: purchase.total_tax });
  }
  const roundOff = Number(purchase.round_off || 0);
  if (roundOff > 0.001) lines.push({ accountId: accountId(purchase.org_id, 'round_off'), debit: roundOff });
  if (roundOff < -0.001) lines.push({ accountId: accountId(purchase.org_id, 'round_off'), credit: Math.abs(roundOff) });
  lines.push({ accountId: moneyAccount, partyId: purchase.party_id, credit: purchase.grand_total });
  replaceSourceEntry({
    orgId: purchase.org_id, date: purchase.purchase_date, voucherType: 'PURCHASE',
    voucherNumber: purchase.purchase_number, narration: purchase.narration || `Purchase ${purchase.purchase_number}`,
    sourceType: 'purchase', sourceId: purchase.id, createdBy: purchase.created_by, lines
  });
}

function postExpense(expense) {
  if (!expense || expense.deleted) {
    if (expense) removeSourceEntry(expense.org_id, 'expense', expense.id);
    return;
  }
  const moneyAccount = expense.payment_mode === 'cash'
    ? accountId(expense.org_id, 'cash') : accountId(expense.org_id, 'bank');
  const roundOff = Number(expense.round_off || 0);
  const lines = [
    { accountId: expense.account_id, partyId: expense.party_id,
      debit: Number(expense.amount) - Number(expense.gst_amount || 0) - roundOff }
  ];
  if (Number(expense.gst_amount) > 0) {
    lines.push({ accountId: accountId(expense.org_id, 'input_gst'), debit: expense.gst_amount });
  }
  if (roundOff > 0.001) lines.push({ accountId: accountId(expense.org_id, 'round_off'), debit: roundOff });
  if (roundOff < -0.001) lines.push({ accountId: accountId(expense.org_id, 'round_off'), credit: Math.abs(roundOff) });
  lines.push({ accountId: moneyAccount, credit: expense.amount });
  replaceSourceEntry({
    orgId: expense.org_id, date: expense.expense_date, voucherType: 'EXPENSE',
    voucherNumber: expense.expense_number, narration: expense.narration || expense.reference || '',
    sourceType: 'expense', sourceId: expense.id, createdBy: expense.created_by, lines
  });
}

function postNote(note) {
  if (!note || note.deleted) {
    if (note) removeSourceEntry(note.org_id, 'note', note.id);
    return;
  }
  const isSalesReturn = note.note_type === 'credit';
  const lines = isSalesReturn ? [
    { accountId: accountId(note.org_id, 'sales'), debit: note.taxable_amount },
    { accountId: accountId(note.org_id, 'output_cgst'), debit: Number(note.tax_amount || 0) / 2 },
    { accountId: accountId(note.org_id, 'output_sgst'), debit: Number(note.tax_amount || 0) / 2 },
    { accountId: accountId(note.org_id, 'accounts_receivable'), partyId: note.party_id, credit: note.grand_total }
  ] : [
    { accountId: accountId(note.org_id, 'accounts_payable'), partyId: note.party_id, debit: note.grand_total },
    { accountId: accountId(note.org_id, 'purchases'), credit: note.taxable_amount },
    { accountId: accountId(note.org_id, 'input_gst'), credit: note.tax_amount }
  ];
  const roundOff = Number(note.round_off || 0);
  if (roundOff > 0.001) {
    lines.push({
      accountId: accountId(note.org_id, 'round_off'),
      [isSalesReturn ? 'debit' : 'credit']: roundOff
    });
  } else if (roundOff < -0.001) {
    lines.push({
      accountId: accountId(note.org_id, 'round_off'),
      [isSalesReturn ? 'credit' : 'debit']: Math.abs(roundOff)
    });
  }
  replaceSourceEntry({
    orgId: note.org_id, date: note.note_date,
    voucherType: isSalesReturn ? 'CREDIT_NOTE' : 'DEBIT_NOTE',
    voucherNumber: note.note_number, narration: note.narration || '',
    sourceType: 'note', sourceId: note.id, createdBy: note.created_by,
    lines: lines.filter(line => Number(line.debit || line.credit) > 0)
  });
}

function postOpeningBalance(party) {
  removeSourceEntry(party.org_id, 'party_opening', party.id);
  const amount = Number(party.opening_balance || 0);
  if (!amount) return;
  const isDebit = party.balance_type === 'dr';
  replaceSourceEntry({
    orgId: party.org_id,
    date: '2000-04-01',
    voucherType: 'OPENING',
    voucherNumber: `OPEN-${party.id}`,
    narration: `Opening balance: ${party.name}`,
    sourceType: 'party_opening',
    sourceId: party.id,
    lines: isDebit ? [
      { accountId: accountId(party.org_id, 'accounts_receivable'), partyId: party.id, debit: amount },
      { accountId: accountId(party.org_id, 'capital'), credit: amount }
    ] : [
      { accountId: accountId(party.org_id, 'capital'), debit: amount },
      { accountId: accountId(party.org_id, 'accounts_payable'), partyId: party.id, credit: amount }
    ]
  });
}

function rebuildAccounting() {
  all('SELECT id FROM orgs WHERE active=1').forEach(org => ensureAccounts(org.id));
  all('SELECT * FROM parties WHERE active=1').forEach(postOpeningBalance);
  all(`SELECT * FROM bills WHERE format IN ('SALE','PP')`).forEach(postBill);
  all('SELECT * FROM payments').forEach(postPayment);
  all('SELECT * FROM purchases').forEach(postPurchase);
  all('SELECT * FROM expenses').forEach(postExpense);
  all('SELECT * FROM credit_debit_notes').forEach(postNote);
}

module.exports = {
  getFY,
  ensureAccounts,
  accountId,
  replaceSourceEntry,
  removeSourceEntry,
  postBill,
  immediateCashAmount,
  billSettlement,
  postPayment,
  postPurchase,
  postExpense,
  postNote,
  postOpeningBalance,
  rebuildAccounting
};
