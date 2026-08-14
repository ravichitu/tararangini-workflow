const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.capacity-test');
fs.rmSync(dataDir, { recursive: true, force: true });
process.env.TARANGINI_DATA_DIR = dataDir;

const dbApi = require('../src/db/db');

function insertMany(db, sql, count, values) {
  const statement = db.prepare(sql);
  for (let index = 1; index <= count; index += 1) {
    statement.run(...values(index));
  }
}

function timedQuery(db, sql) {
  const started = performance.now();
  const result = db.prepare(sql).all();
  return { milliseconds: Number((performance.now() - started).toFixed(2)), rows: result.length };
}

const scalar = (db, sql) => Object.values(db.prepare(sql).get())[0];

(async () => {
  const started = performance.now();
  await dbApi.initDB();
  dbApi.initializeDB();
  const db = dbApi.getDB();
  db.run(`INSERT INTO orgs (display_name,registered_name,gst_type) VALUES ('Capacity Test','Capacity Test','regular')`);
  const orgId = scalar(db, 'SELECT last_insert_rowid()');
  require('../src/accounting/accounting').ensureAccounts(orgId);
  const expenseAccount = scalar(db, `SELECT id FROM accounts WHERE org_id=${orgId} AND type='expense' LIMIT 1`);
  const itemJson = JSON.stringify([{ item_id: 1, item_name: 'Capacity Item', qty: 1, unit: 'NOS', rate: 100, amount: 100, gst_rate: 18 }]);

  db.run('BEGIN');
  insertMany(db, `INSERT INTO parties (org_id,type,name,phone,email,address,gstin) VALUES (?,?,?,?,?,?,?)`, 5000,
    i => [orgId, i % 3 === 0 ? 'supplier' : 'customer', `Capacity Party ${i}`, `90000${String(i).padStart(5, '0')}`,
      `party${i}@example.com`, `Address ${i}`, i % 10 === 0 ? `37ABCDE${String(i).padStart(4, '0')}F1Z5` : null]);
  insertMany(db, `INSERT INTO items (org_id,name,item_code,model_number,unit,gst_rate,last_sale_price,last_purchase_price,mrp,barcode,opening_stock)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, 5000,
    i => [orgId, `Capacity Item ${i}`, `CAP-${i}`, `MODEL-${i}`, 'NOS', 18, 100 + i % 20, 60 + i % 10,
      120 + i % 20, `890${String(i).padStart(10, '0')}`, 100]);
  insertMany(db, `INSERT INTO bills
    (org_id,format,bill_number,bill_date,fy,party_id,items_json,subtotal,taxable_amount,cgst,sgst,total_tax,grand_total,status,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, 40000,
    i => [orgId, i % 8 === 0 ? 'PP' : 'SALE', `CAP/SB/2026-27/${i}`, `2026-${String(4 + i % 9).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}`,
      '2026-27', 1 + i % 5000, itemJson, 100, 100, 9, 9, 18, 118, 'saved', 1]);
  insertMany(db, `INSERT INTO payments
    (org_id,payment_number,payment_date,fy,party_id,type,mode,amount,reference,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, 15000,
    i => [orgId, `CAP/PR/2026-27/${i}`, '2026-06-07', '2026-27', 1 + i % 5000,
      i % 2 ? 'received' : 'paid', i % 3 ? 'cash' : 'account', 118, `REF-${i}`, 1]);
  insertMany(db, `INSERT INTO purchases
    (org_id,purchase_number,purchase_date,fy,party_id,items_json,taxable_amount,cgst,sgst,total_tax,grand_total,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, 10000,
    i => [orgId, `CAP/PUR/2026-27/${i}`, '2026-06-07', '2026-27', 1 + i % 5000, itemJson, 100, 9, 9, 18, 118, 1]);
  insertMany(db, `INSERT INTO expenses
    (org_id,expense_number,expense_date,fy,party_id,account_id,payment_mode,amount,gst_amount,reference,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, 8000,
    i => [orgId, `CAP/EXP/2026-27/${i}`, '2026-06-07', '2026-27', 1 + i % 5000, expenseAccount, 'cash', 50, 0, `EXP-${i}`, 1]);
  insertMany(db, `INSERT INTO credit_debit_notes
    (org_id,note_number,note_date,fy,note_type,party_id,items_json,taxable_amount,tax_amount,grand_total,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, 7000,
    i => [orgId, `CAP/CN/2026-27/${i}`, '2026-06-07', '2026-27', i % 2 ? 'credit' : 'debit',
      1 + i % 5000, itemJson, 100, 18, 118, 1]);
  insertMany(db, `INSERT INTO purchase_orders
    (org_id,po_number,po_date,fy,party_id,items_json,subtotal,status,created_by)
    VALUES (?,?,?,?,?,?,?,?,?)`, 5000,
    i => [orgId, `CAP/PO/2026-27/${i}`, '2026-06-07', '2026-27', 1 + i % 5000, itemJson, 100, 'open', 1]);
  db.run(`INSERT INTO bank_statement_imports (org_id,file_name,file_hash) VALUES (${orgId},'capacity.xlsx','capacity-test')`);
  const importId = scalar(db, 'SELECT last_insert_rowid()');
  insertMany(db, `INSERT INTO bank_statement_rows
    (import_id,org_id,transaction_date,description,reference,debit,credit,balance)
    VALUES (?,?,?,?,?,?,?,?)`, 5000,
    i => [importId, orgId, '2026-06-07', `Capacity transaction ${i}`, `BANK-${i}`, i % 2 ? 50 : 0, i % 2 ? 0 : 118, i * 68]);
  db.run('COMMIT');
  dbApi.saveDB();

  const total = scalar(db, `SELECT
    (SELECT COUNT(*) FROM parties WHERE org_id=${orgId})+
    (SELECT COUNT(*) FROM items WHERE org_id=${orgId})+
    (SELECT COUNT(*) FROM bills WHERE org_id=${orgId})+
    (SELECT COUNT(*) FROM payments WHERE org_id=${orgId})+
    (SELECT COUNT(*) FROM purchases WHERE org_id=${orgId})+
    (SELECT COUNT(*) FROM expenses WHERE org_id=${orgId})+
    (SELECT COUNT(*) FROM credit_debit_notes WHERE org_id=${orgId})+
    (SELECT COUNT(*) FROM purchase_orders WHERE org_id=${orgId})+
    (SELECT COUNT(*) FROM bank_statement_rows WHERE org_id=${orgId})`);
  assert.strictEqual(total, 100000);
  const integrity = scalar(db, 'PRAGMA integrity_check');
  assert.strictEqual(integrity, 'ok');

  const results = {
    tested_at: new Date().toISOString(),
    isolated_database: dbApi.getDBPath(),
    records: total,
    insertion_and_save_seconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    database_size_mb: Number((fs.statSync(dbApi.getDBPath()).size / 1024 / 1024).toFixed(2)),
    integrity,
    queries: {
      invoice_search: timedQuery(db, `SELECT id,bill_number FROM bills WHERE org_id=${orgId} AND bill_number LIKE '%39999%' LIMIT 50`),
      monthly_sales: timedQuery(db, `SELECT substr(bill_date,1,7),SUM(grand_total) FROM bills WHERE org_id=${orgId} GROUP BY substr(bill_date,1,7)`),
      party_balance_inputs: timedQuery(db, `SELECT party_id,SUM(grand_total) FROM bills WHERE org_id=${orgId} GROUP BY party_id`),
      stock_inputs: timedQuery(db, `SELECT COUNT(*),SUM(opening_stock) FROM items WHERE org_id=${orgId}`),
      bank_search: timedQuery(db, `SELECT id FROM bank_statement_rows WHERE org_id=${orgId} AND reference='BANK-4999'`)
    }
  };
  fs.writeFileSync(path.join(__dirname, 'capacity-100k-results.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
