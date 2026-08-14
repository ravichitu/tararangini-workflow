const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PER_TYPE = 1_000_000;
const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.capacity-million-test');
const resultsPath = path.join(__dirname, 'capacity-million-each-results.json');
fs.rmSync(dataDir, { recursive: true, force: true });
process.env.TARANGINI_DATA_DIR = dataDir;

const dbApi = require('../src/db/db');

function insertMany(db, label, sql, count, values) {
  const started = performance.now();
  const statement = db.prepare(sql);
  for (let index = 1; index <= count; index += 1) {
    statement.run(...values(index));
    if (index % 100000 === 0) {
      console.log(`${label}: ${index.toLocaleString('en-IN')} inserted`);
    }
  }
  return Number(((performance.now() - started) / 1000).toFixed(2));
}

function query(db, sql) {
  const started = performance.now();
  const result = db.prepare(sql).all();
  return {
    milliseconds: Number((performance.now() - started).toFixed(2)),
    rows: result.length,
    first: result[0] || null
  };
}

const scalar = (db, sql) => Object.values(db.prepare(sql).get())[0];

(async () => {
  const overallStarted = performance.now();
  await dbApi.initDB();
  dbApi.initializeDB();
  const db = dbApi.getDB();
  db.run(`INSERT INTO orgs (display_name,registered_name,gst_type) VALUES ('Million Test','Million Test','regular')`);
  const orgId = scalar(db, 'SELECT last_insert_rowid()');
  require('../src/accounting/accounting').ensureAccounts(orgId);
  const accounts = db.prepare(`SELECT id FROM accounts WHERE org_id=${orgId} ORDER BY id LIMIT 2`).all().map(row => row.id);
  const expenseAccount = scalar(db, `SELECT id FROM accounts WHERE org_id=${orgId} AND type='expense' LIMIT 1`);
  const itemJson = '[{"item_id":1,"item_name":"Load Item","qty":1,"unit":"NOS","rate":100,"amount":100,"gst_rate":18}]';
  const timings = {};

  db.run(`INSERT INTO parties (org_id,type,name,phone) VALUES (${orgId},'both','Load Test Party','9000000000')`);
  const partyId = scalar(db, 'SELECT last_insert_rowid()');
  db.run(`INSERT INTO items (org_id,name,item_code,unit,gst_rate,last_sale_price,last_purchase_price,opening_stock)
    VALUES (${orgId},'Load Item','LOAD-1','NOS',18,100,60,999999999)`);

  db.run('BEGIN');
  timings.bills = insertMany(db, 'Bills', `INSERT INTO bills
    (org_id,format,bill_number,bill_date,fy,party_id,items_json,subtotal,taxable_amount,cgst,sgst,total_tax,grand_total,status,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, PER_TYPE,
    i => [orgId, i % 10 === 0 ? 'PP' : 'SALE', `MIL/SB/2026-27/${i}`, `2026-${String(4 + i % 9).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}`,
      '2026-27', partyId, itemJson, 100, 100, 9, 9, 18, 118, 'saved', 1]);

  timings.payments = insertMany(db, 'Payments', `INSERT INTO payments
    (org_id,payment_number,payment_date,fy,party_id,type,mode,amount,reference,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, PER_TYPE,
    i => [orgId, `MIL/PR/2026-27/${i}`, '2026-06-07', '2026-27', partyId,
      i % 2 ? 'received' : 'paid', i % 3 ? 'cash' : 'account', 118, `R${i}`, 1]);

  timings.purchases = insertMany(db, 'Purchases', `INSERT INTO purchases
    (org_id,purchase_number,purchase_date,fy,party_id,items_json,taxable_amount,cgst,sgst,total_tax,grand_total,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, PER_TYPE,
    i => [orgId, `MIL/PUR/2026-27/${i}`, '2026-06-07', '2026-27', partyId, itemJson, 100, 9, 9, 18, 118, 1]);

  timings.expenses = insertMany(db, 'Expenses', `INSERT INTO expenses
    (org_id,expense_number,expense_date,fy,party_id,account_id,payment_mode,amount,gst_amount,reference,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, PER_TYPE,
    i => [orgId, `MIL/EXP/2026-27/${i}`, '2026-06-07', '2026-27', partyId, expenseAccount, 'cash', 50, 0, `E${i}`, 1]);

  timings.notes = insertMany(db, 'Notes', `INSERT INTO credit_debit_notes
    (org_id,note_number,note_date,fy,note_type,party_id,items_json,taxable_amount,tax_amount,grand_total,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, PER_TYPE,
    i => [orgId, `MIL/CN/2026-27/${i}`, '2026-06-07', '2026-27', i % 2 ? 'credit' : 'debit', partyId, itemJson, 100, 18, 118, 1]);

  timings.purchase_orders = insertMany(db, 'Purchase orders', `INSERT INTO purchase_orders
    (org_id,po_number,po_date,fy,party_id,items_json,subtotal,status,created_by)
    VALUES (?,?,?,?,?,?,?,?,?)`, PER_TYPE,
    i => [orgId, `MIL/PO/2026-27/${i}`, '2026-06-07', '2026-27', partyId, itemJson, 100, 'open', 1]);

  db.run(`INSERT INTO bank_statement_imports (org_id,file_name,file_hash) VALUES (${orgId},'million.xlsx','million-test')`);
  const importId = scalar(db, 'SELECT last_insert_rowid()');
  timings.bank_rows = insertMany(db, 'Bank rows', `INSERT INTO bank_statement_rows
    (import_id,org_id,transaction_date,description,reference,debit,credit,balance)
    VALUES (?,?,?,?,?,?,?,?)`, PER_TYPE,
    i => [importId, orgId, '2026-06-07', `Transaction ${i}`, `B${i}`, i % 2 ? 50 : 0, i % 2 ? 0 : 118, i * 68]);

  const journalIdOffset = scalar(db, 'SELECT COALESCE(MAX(id),0) FROM journal_entries');
  timings.journals = insertMany(db, 'Journals', `INSERT INTO journal_entries
    (org_id,entry_date,fy,voucher_type,voucher_number,narration,source_type,source_id,created_by)
    VALUES (?,?,?,?,?,?,?,?,?)`, PER_TYPE,
    i => [orgId, '2026-06-07', '2026-27', 'JOURNAL', `MIL/JV/2026-27/${i}`, `Journal ${i}`, 'manual', i, 1]);

  const journalLineStarted = performance.now();
  const lineStatement = db.prepare(`INSERT INTO journal_lines
    (entry_id,account_id,party_id,debit,credit,narration) VALUES (?,?,?,?,?,?)`);
  for (let index = 1; index <= PER_TYPE; index += 1) {
    lineStatement.run(journalIdOffset + index, accounts[0], partyId, 50, 0, 'Load debit');
    lineStatement.run(journalIdOffset + index, accounts[1], partyId, 0, 50, 'Load credit');
    if (index % 100000 === 0) console.log(`Journal lines: ${(index * 2).toLocaleString('en-IN')} inserted`);
  }
  timings.journal_lines = Number(((performance.now() - journalLineStarted) / 1000).toFixed(2));
  db.run('COMMIT');

  const saveStarted = performance.now();
  dbApi.saveDB();
  timings.database_save = Number(((performance.now() - saveStarted) / 1000).toFixed(2));

  const countSql = {
    bills: 'bills', payments: 'payments', purchases: 'purchases', expenses: 'expenses',
    notes: 'credit_debit_notes', purchase_orders: 'purchase_orders',
    bank_rows: 'bank_statement_rows', journals: 'journal_entries'
  };
  const counts = Object.fromEntries(Object.entries(countSql).map(([name, table]) => [
    name, scalar(db, `SELECT COUNT(*) FROM ${table} WHERE org_id=${orgId}`)
  ]));
  Object.values(counts).forEach(count => assert.strictEqual(count, PER_TYPE));
  const journalLines = scalar(db, `SELECT COUNT(*) FROM journal_lines jl
    JOIN journal_entries je ON je.id=jl.entry_id WHERE je.org_id=${orgId}`);
  assert.strictEqual(journalLines, PER_TYPE * 2);

  const integrityStarted = performance.now();
  const integrity = scalar(db, 'PRAGMA integrity_check');
  const integritySeconds = Number(((performance.now() - integrityStarted) / 1000).toFixed(2));
  assert.strictEqual(integrity, 'ok');

  const results = {
    tested_at: new Date().toISOString(),
    scope: '10 lakh records in each of 8 primary transaction categories, simultaneously',
    primary_transactions: PER_TYPE * 8,
    journal_lines: journalLines,
    total_transaction_rows: PER_TYPE * 8 + journalLines,
    counts,
    insertion_seconds_by_type: timings,
    total_seconds: Number(((performance.now() - overallStarted) / 1000).toFixed(2)),
    database_size_mb: Number((fs.statSync(dbApi.getDBPath()).size / 1024 / 1024).toFixed(2)),
    integrity,
    integrity_check_seconds: integritySeconds,
    memory_mb: Object.fromEntries(Object.entries(process.memoryUsage()).map(([key, value]) => [key, Number((value / 1024 / 1024).toFixed(2))])),
    queries: {
      invoice_exact_search: query(db, `SELECT id,bill_number FROM bills WHERE org_id=${orgId} AND bill_number='MIL/SB/2026-27/999999'`),
      invoice_text_search: query(db, `SELECT id,bill_number FROM bills WHERE org_id=${orgId} AND bill_number LIKE '%999999%' LIMIT 50`),
      monthly_sales: query(db, `SELECT substr(bill_date,1,7),SUM(grand_total) FROM bills WHERE org_id=${orgId} GROUP BY substr(bill_date,1,7)`),
      party_balance_inputs: query(db, `SELECT party_id,SUM(grand_total) FROM bills WHERE org_id=${orgId} GROUP BY party_id`),
      payment_summary: query(db, `SELECT type,mode,COUNT(*),SUM(amount) FROM payments WHERE org_id=${orgId} GROUP BY type,mode`),
      expense_summary: query(db, `SELECT account_id,COUNT(*),SUM(amount) FROM expenses WHERE org_id=${orgId} GROUP BY account_id`),
      journal_trial_input: query(db, `SELECT jl.account_id,SUM(jl.debit),SUM(jl.credit)
        FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
        WHERE je.org_id=${orgId} GROUP BY jl.account_id`),
      bank_exact_search: query(db, `SELECT id FROM bank_statement_rows WHERE org_id=${orgId} AND reference='B999999'`)
    }
  };
  fs.writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
