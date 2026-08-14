const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const APP_DATA_DIR = process.env.TARANGINI_DATA_DIR || path.join(__dirname, '../../database');
const DB_PATH = path.join(APP_DATA_DIR, 'tarangini.db');
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const BUNDLED_DB_PATH = path.join(__dirname, '../../database/tarangini.db');
if (!fs.existsSync(DB_PATH) && DB_PATH !== BUNDLED_DB_PATH && fs.existsSync(BUNDLED_DB_PATH)) {
  fs.copyFileSync(BUNDLED_DB_PATH, DB_PATH);
}

let db = null;
let transactionDepth = 0;

function saveDB() {
  if (!db) return;
  try {
    db.exec('PRAGMA wal_checkpoint(FULL)');
  } catch (e) {
    console.error('Save error:', e.message);
    throw e;
  }
}

async function initDB() {
  db = new DatabaseSync(DB_PATH);
  db.run = (sql, params = []) => db.prepare(sql).run(...params);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA temp_store = MEMORY');
  return db;
}

function getDB() { return db; }

function run(sql, params = []) {
  try {
    const result = db.prepare(sql).run(...params);
    return {
      changes: result.changes,
      lastInsertRowid: Number(result.lastInsertRowid || 0)
    };
  } catch (e) {
    console.error('DB run error:', e.message, '\n', sql.substring(0,120));
    throw e;
  }
}

function get(sql, params = []) {
  try {
    return db.prepare(sql).get(...params);
  } catch (e) {
    console.error('DB get error:', e.message, sql.substring(0,100));
    throw e;
  }
}

function all(sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch (e) {
    console.error('DB all error:', e.message, sql.substring(0,100));
    throw e;
  }
}

function safeAll(sql, params = [], fallback = []) {
  try {
    return all(sql, params);
  } catch (_) {
    return fallback;
  }
}

function exec(sql) {
  try {
    db.exec(sql);
  } catch (e) { /* ignore */ }
}

function transaction(fn) {
  const savepoint = `tarangini_nested_${transactionDepth}`;
  try {
    transactionDepth += 1;
    if (transactionDepth === 1) db.exec('BEGIN IMMEDIATE');
    else db.exec(`SAVEPOINT ${savepoint}`);
    const result = fn();
    if (transactionDepth === 1) db.exec('COMMIT');
    else db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    transactionDepth -= 1;
    return result;
  } catch (e) {
    try {
      if (transactionDepth === 1) db.exec('ROLLBACK');
      else db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    } catch (_) {}
    transactionDepth = Math.max(0, transactionDepth - 1);
    throw e;
  }
}

function recordSchemaMigration(migrationKey, description) {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO schema_migrations (migration_key, description)
       VALUES (?, ?)`
    ).run(migrationKey, description);
  } catch (_) {}
}

function setAppMetadata(key, value) {
  try {
    db.prepare(
      `INSERT INTO app_metadata (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value=excluded.value,
         updated_at=datetime('now')`
    ).run(key, String(value));
  } catch (_) {}
}

function initializeDB() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const seed = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');

  schema.split(';').filter(s => s.trim()).forEach(stmt => {
    try { db.run(stmt); } catch(e) { }
  });

  [
    `ALTER TABLE users ADD COLUMN permissions TEXT DEFAULT '{}'`,
    `CREATE TABLE IF NOT EXISTS registered_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL DEFAULT '',
      assigned_to TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL DEFAULT '',
      mac_references TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      registered_by INTEGER,
      registered_at TEXT DEFAULT (datetime('now')),
      revoked_by INTEGER,
      revoked_at TEXT,
      wipe_requested_at TEXT,
      wipe_acknowledged_at TEXT,
      wipe_reason TEXT NOT NULL DEFAULT '',
      last_sync_at TEXT,
      UNIQUE(org_id, device_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_registered_devices_org_status
      ON registered_devices(org_id, status)`,
    `ALTER TABLE registered_devices ADD COLUMN wipe_requested_at TEXT`,
    `ALTER TABLE registered_devices ADD COLUMN wipe_acknowledged_at TEXT`,
    `ALTER TABLE registered_devices ADD COLUMN wipe_reason TEXT NOT NULL DEFAULT ''`,
    `CREATE TABLE IF NOT EXISTS sync_cursors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      last_pulled_revision INTEGER NOT NULL DEFAULT 0,
      last_pushed_at TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(org_id, device_id)
    )`,
    `CREATE TABLE IF NOT EXISTS sync_outbox (
      change_id TEXT PRIMARY KEY,
      org_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      base_version INTEGER,
      payload TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      synced_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sync_outbox_device_status
      ON sync_outbox(org_id, device_id, status, created_at)`,
    `CREATE TABLE IF NOT EXISTS sync_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_id TEXT NOT NULL,
      org_id INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
       entity_id TEXT NOT NULL,
       main_snapshot TEXT NOT NULL,
       incoming_snapshot TEXT NOT NULL,
       merged_snapshot TEXT,
       status TEXT NOT NULL DEFAULT 'pending',
      resolved_by INTEGER,
      resolution_reason TEXT,
      resolved_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sync_conflicts_org_status
      ON sync_conflicts(org_id, status, created_at)`,
    `ALTER TABLE sync_conflicts ADD COLUMN merged_snapshot TEXT`,
    `CREATE TABLE IF NOT EXISTS sync_replay (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conflict_id INTEGER NOT NULL UNIQUE,
      change_id TEXT NOT NULL,
      org_id INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      replay_reference TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sync_replay_org_created
      ON sync_replay(org_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS sync_revisions (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      record_version INTEGER,
      changed_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sync_revisions_org_revision
      ON sync_revisions(org_id, revision)`,
    `CREATE TABLE IF NOT EXISTS backup_verification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      backup_log_id INTEGER,
      backup_file TEXT NOT NULL,
      status TEXT NOT NULL,
      integrity_result TEXT,
      schema_table_count INTEGER DEFAULT 0,
      database_size_bytes INTEGER DEFAULT 0,
      summary_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      verified_by INTEGER,
      verified_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_backup_verification_status_date
      ON backup_verification_log(status, verified_at)`,
    `CREATE TABLE IF NOT EXISTS offline_financial_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id TEXT NOT NULL UNIQUE,
      org_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      provisional_number TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL DEFAULT 'DRAFT',
      base_version INTEGER,
      created_by INTEGER,
      submitted_at TEXT,
      reviewed_by INTEGER,
      reviewed_at TEXT,
      review_reason TEXT NOT NULL DEFAULT '',
      posted_entity_id INTEGER,
      posted_number TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      CHECK (state IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','POSTED'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_offline_financial_drafts_org_state
      ON offline_financial_drafts(org_id, state, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_offline_financial_drafts_device
      ON offline_financial_drafts(org_id, device_id, draft_id)`,
    `ALTER TABLE users ADD COLUMN pin_hash TEXT`,
    `ALTER TABLE items ADD COLUMN item_code TEXT`,
    `ALTER TABLE items ADD COLUMN model_number TEXT`,
    `ALTER TABLE items ADD COLUMN mrp REAL DEFAULT 0`,
    `ALTER TABLE items ADD COLUMN barcode TEXT`,
    `ALTER TABLE items ADD COLUMN opening_stock REAL DEFAULT 0`,
    `ALTER TABLE items ADD COLUMN reorder_level REAL DEFAULT 0`,
    `ALTER TABLE bills ADD COLUMN due_date TEXT`,
    `ALTER TABLE bills ADD COLUMN description TEXT DEFAULT ''`,
    `ALTER TABLE bills ADD COLUMN swipe_charge REAL DEFAULT 0`,
    `ALTER TABLE bills ADD COLUMN custom_data TEXT DEFAULT '{}'`,
    `ALTER TABLE orgs ADD COLUMN invoice_description TEXT DEFAULT ''`,
    `ALTER TABLE orgs ADD COLUMN quotation_fixed_note TEXT DEFAULT ''`,
    `ALTER TABLE orgs ADD COLUMN delivery_challan_fixed_note TEXT DEFAULT ''`,
    `ALTER TABLE orgs ADD COLUMN proforma_fixed_note TEXT DEFAULT ''`,
    `ALTER TABLE orgs ADD COLUMN project_bw_rate REAL DEFAULT 0`,
    `ALTER TABLE orgs ADD COLUMN project_colour_rate REAL DEFAULT 0`,
    `ALTER TABLE orgs ADD COLUMN project_book_rate REAL DEFAULT 0`,
    `ALTER TABLE orgs ADD COLUMN signature_image TEXT`,
    `ALTER TABLE orgs ADD COLUMN invoice_qr_enabled INTEGER DEFAULT 1`,
    `ALTER TABLE orgs ADD COLUMN negative_stock_allowed INTEGER DEFAULT 1`,
    `ALTER TABLE orgs ADD COLUMN default_tax_inclusive INTEGER DEFAULT 0`,
    `ALTER TABLE orgs ADD COLUMN invoice_prefixes TEXT DEFAULT '{}'`,
    `ALTER TABLE orgs ADD COLUMN invoice_theme TEXT DEFAULT 'classic'`,
    `ALTER TABLE orgs ADD COLUMN invoice_print_options TEXT DEFAULT '{}'`,
    `ALTER TABLE orgs ADD COLUMN job_catalog_auto_seed INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE parties ADD COLUMN digital_signature_required INTEGER DEFAULT 0`,
    `ALTER TABLE parties ADD COLUMN is_common_ledger INTEGER DEFAULT 0`,
    `ALTER TABLE parties ADD COLUMN common_ledger_slot INTEGER`,
    `ALTER TABLE bills ADD COLUMN split_payments TEXT DEFAULT '[]'`,
    `ALTER TABLE bills ADD COLUMN cost_total REAL DEFAULT 0`,
    `ALTER TABLE bills ADD COLUMN shift_id INTEGER`,
    `ALTER TABLE bills ADD COLUMN return_of INTEGER`,
    `ALTER TABLE bills ADD COLUMN offline_id TEXT`,
    `ALTER TABLE bills ADD COLUMN offline_device TEXT`,
    `ALTER TABLE bills ADD COLUMN offline_created_at TEXT`,
    `ALTER TABLE bills ADD COLUMN delivery_info TEXT DEFAULT '{}'`,
    `ALTER TABLE bills ADD COLUMN billing_address_id INTEGER`,
    `ALTER TABLE bills ADD COLUMN billing_address_snapshot TEXT`,
    `ALTER TABLE bills ADD COLUMN delivery_address_id INTEGER`,
    `ALTER TABLE bills ADD COLUMN delivery_address_snapshot TEXT`,
    `ALTER TABLE bills ADD COLUMN tax_inclusive INTEGER DEFAULT 0`,
    `ALTER TABLE bills ADD COLUMN digital_signature_required INTEGER DEFAULT 0`,
    `ALTER TABLE bills ADD COLUMN digital_signature_note TEXT DEFAULT ''`,
    `ALTER TABLE bills ADD COLUMN digital_signature_status TEXT DEFAULT 'not_required'`,
    `ALTER TABLE bills ADD COLUMN digital_signature_signed_at TEXT`,
    `ALTER TABLE bills ADD COLUMN digital_signature_signed_by INTEGER`,
    `ALTER TABLE bills ADD COLUMN round_off REAL DEFAULT 0`,
    `ALTER TABLE warranty_replacements ADD COLUMN customer_mode TEXT NOT NULL DEFAULT 'PARTY'`,
    `ALTER TABLE warranty_replacements ADD COLUMN common_customer_slot INTEGER`,
    `ALTER TABLE warranty_replacements ADD COLUMN customer_name TEXT DEFAULT ''`,
    `ALTER TABLE warranty_replacements ADD COLUMN customer_phone TEXT DEFAULT ''`,
    `ALTER TABLE warranty_replacements ADD COLUMN customer_email TEXT DEFAULT ''`,
    `ALTER TABLE warranty_replacements ADD COLUMN customer_address TEXT DEFAULT ''`,
    `CREATE TABLE IF NOT EXISTS warranty_replacements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL,
      replacement_number TEXT NOT NULL,
      party_id INTEGER NOT NULL,
      original_sale_bill_id INTEGER,
      delivery_bill_id INTEGER NOT NULL,
      product_item_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      serial_number TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      request_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      issue_summary TEXT NOT NULL,
      vendor_reference TEXT DEFAULT '',
      service_center_id INTEGER,
      courier_vendor TEXT DEFAULT '',
      courier_tracking_number TEXT DEFAULT '',
      sent_date TEXT,
      expected_return_date TEXT,
      rma_number TEXT DEFAULT '',
      service_center_contact TEXT DEFAULT '',
      service_center_ack_status TEXT DEFAULT '',
      follow_up_date TEXT,
      resolution_notes TEXT DEFAULT '',
      closed_at TEXT,
      created_by INTEGER,
      updated_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(org_id, replacement_number)
    )`,
    `CREATE TABLE IF NOT EXISTS warranty_service_centers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      category TEXT DEFAULT '',
      brand TEXT DEFAULT '',
      contact_person TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      courier_instructions TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(org_id, name, category, brand)
    )`,
    `ALTER TABLE warranty_replacements ADD COLUMN service_center_id INTEGER`,
    `ALTER TABLE warranty_replacements ADD COLUMN original_sale_bill_id INTEGER`,
    `ALTER TABLE warranty_replacements ADD COLUMN courier_vendor TEXT DEFAULT ''`,
    `ALTER TABLE warranty_replacements ADD COLUMN courier_tracking_number TEXT DEFAULT ''`,
    `ALTER TABLE warranty_replacements ADD COLUMN sent_date TEXT`,
    `ALTER TABLE warranty_replacements ADD COLUMN expected_return_date TEXT`,
    `ALTER TABLE warranty_replacements ADD COLUMN rma_number TEXT DEFAULT ''`,
    `ALTER TABLE warranty_replacements ADD COLUMN service_center_contact TEXT DEFAULT ''`,
    `ALTER TABLE warranty_replacements ADD COLUMN service_center_ack_status TEXT DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS idx_warranty_replacements_org_status
      ON warranty_replacements(org_id,status,follow_up_date)`,
    `CREATE INDEX IF NOT EXISTS idx_warranty_replacements_party
      ON warranty_replacements(party_id)`,
    `CREATE TABLE IF NOT EXISTS transaction_control_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL,
      transaction_type TEXT NOT NULL,
      form_options TEXT DEFAULT '{}',
      required_fields TEXT DEFAULT '{}',
      print_options TEXT DEFAULT '{}',
      updated_by INTEGER,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(org_id, transaction_type)
    )`,
    `CREATE TABLE IF NOT EXISTS party_addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      party_id INTEGER NOT NULL,
      org_id INTEGER NOT NULL,
      label TEXT NOT NULL DEFAULT 'Main Address',
      address_type TEXT NOT NULL DEFAULT 'billing_delivery',
      contact_person TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      city TEXT,
      district TEXT,
      state TEXT DEFAULT 'Andhra Pradesh',
      pincode TEXT,
      gstin TEXT,
      is_default_billing INTEGER DEFAULT 0,
      is_default_delivery INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_party_addresses_party
      ON party_addresses(party_id,active)`,
    `ALTER TABLE payments ADD COLUMN shift_id INTEGER`,
    `ALTER TABLE payments ADD COLUMN deposit_account_id INTEGER`,
    `ALTER TABLE payments ADD COLUMN reversal_number TEXT`,
    `ALTER TABLE payments ADD COLUMN reversed_at TEXT`,
    `ALTER TABLE payments ADD COLUMN reversed_by INTEGER`,
    `ALTER TABLE payments ADD COLUMN reversal_reason TEXT DEFAULT ''`,
    `CREATE TABLE IF NOT EXISTS job_internal_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      org_id INTEGER NOT NULL,
      author_user_id INTEGER NOT NULL,
      note_type TEXT NOT NULL DEFAULT 'INSTRUCTION',
      note_text TEXT NOT NULL,
      file_names_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_job_internal_notes_job
      ON job_internal_notes(job_id,created_at,id)`,
    `ALTER TABLE pos_shifts ADD COLUMN owner_accepted INTEGER DEFAULT 0`,
    `ALTER TABLE pos_shifts ADD COLUMN accepted_by INTEGER`,
    `ALTER TABLE pos_shifts ADD COLUMN accepted_at TEXT`,
    `ALTER TABLE pos_shifts ADD COLUMN acceptance_note TEXT`,
    `ALTER TABLE bank_statement_imports ADD COLUMN file_hash TEXT`,
    `ALTER TABLE bank_statement_imports ADD COLUMN mapping_json TEXT DEFAULT '{}'`,
    `ALTER TABLE purchases ADD COLUMN tax_inclusive INTEGER DEFAULT 0`,
    `ALTER TABLE purchases ADD COLUMN round_off REAL DEFAULT 0`,
    `ALTER TABLE expenses ADD COLUMN gst_rate REAL DEFAULT 0`,
    `ALTER TABLE expenses ADD COLUMN tax_inclusive INTEGER DEFAULT 0`,
    `ALTER TABLE expenses ADD COLUMN round_off REAL DEFAULT 0`,
    `ALTER TABLE credit_debit_notes ADD COLUMN tax_inclusive INTEGER DEFAULT 0`,
    `ALTER TABLE credit_debit_notes ADD COLUMN round_off REAL DEFAULT 0`,
    `ALTER TABLE purchase_orders ADD COLUMN tax_inclusive INTEGER DEFAULT 0`,
    `ALTER TABLE purchase_orders ADD COLUMN round_off REAL DEFAULT 0`,
    `ALTER TABLE financial_year_locks ADD COLUMN closed INTEGER DEFAULT 0`,
    `ALTER TABLE financial_year_locks ADD COLUMN closed_by INTEGER`,
    `ALTER TABLE financial_year_locks ADD COLUMN closed_at TEXT`,
    `ALTER TABLE financial_year_locks ADD COLUMN close_note TEXT DEFAULT ''`,
    `ALTER TABLE financial_year_locks ADD COLUMN close_snapshot_json TEXT DEFAULT '{}'`,
    `ALTER TABLE financial_year_locks ADD COLUMN reopened_by INTEGER`,
    `ALTER TABLE financial_year_locks ADD COLUMN reopened_at TEXT`,
    `ALTER TABLE financial_year_locks ADD COLUMN reopen_reason TEXT DEFAULT ''`,
    `ALTER TABLE job_estimates ADD COLUMN tax_inclusive INTEGER DEFAULT 0`,
    `ALTER TABLE job_estimates ADD COLUMN round_off_paise INTEGER DEFAULT 0`,
    `ALTER TABLE job_orders ADD COLUMN offline_id TEXT`,
    `ALTER TABLE job_orders ADD COLUMN offline_device TEXT`,
    `ALTER TABLE job_orders ADD COLUMN offline_created_at TEXT`,
    `ALTER TABLE job_orders ADD COLUMN pre_bill_id INTEGER`,
    `ALTER TABLE job_orders ADD COLUMN pre_billed_at TEXT`,
    `ALTER TABLE job_attachments ADD COLUMN upload_origin TEXT NOT NULL DEFAULT 'STAFF'`,
    `ALTER TABLE job_attachments ADD COLUMN pixel_width INTEGER`,
    `ALTER TABLE job_attachments ADD COLUMN pixel_height INTEGER`,
    `ALTER TABLE job_attachments ADD COLUMN pdf_page_count INTEGER`,
    `ALTER TABLE job_attachments ADD COLUMN analysis_status TEXT NOT NULL DEFAULT 'PENDING'`,
    `ALTER TABLE job_attachments ADD COLUMN analysis_error TEXT`,
    `ALTER TABLE job_attachments ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE job_attachments ADD COLUMN retention_policy TEXT NOT NULL DEFAULT 'AUTO_DELETE'`,
    `ALTER TABLE job_attachments ADD COLUMN retention_state TEXT NOT NULL DEFAULT 'ACTIVE'`,
    `ALTER TABLE job_attachments ADD COLUMN retention_delete_after TEXT`,
    `ALTER TABLE job_attachments ADD COLUMN archived_at TEXT`,
    `ALTER TABLE job_attachments ADD COLUMN archived_by INTEGER`,
    `ALTER TABLE job_attachments ADD COLUMN archive_reason TEXT`,
    `ALTER TABLE job_attachments ADD COLUMN physical_deleted_at TEXT`,
    `ALTER TABLE job_attachments ADD COLUMN physical_deleted_by INTEGER`,
    `ALTER TABLE job_attachments ADD COLUMN physical_delete_reason TEXT`,
    `ALTER TABLE job_intake_attachments ADD COLUMN storage_path TEXT`,
    `ALTER TABLE job_intake_attachments ADD COLUMN retention_policy TEXT NOT NULL DEFAULT 'AUTO_DELETE'`,
    `ALTER TABLE job_intake_attachments ADD COLUMN retention_state TEXT NOT NULL DEFAULT 'ACTIVE'`,
    `ALTER TABLE job_intake_attachments ADD COLUMN retention_delete_after TEXT`,
    `ALTER TABLE job_intake_attachments ADD COLUMN archived_at TEXT`,
    `ALTER TABLE job_intake_attachments ADD COLUMN archived_by INTEGER`,
    `ALTER TABLE job_intake_attachments ADD COLUMN archive_reason TEXT`,
    `ALTER TABLE job_intake_attachments ADD COLUMN physical_deleted_at TEXT`,
    `ALTER TABLE job_intake_attachments ADD COLUMN physical_delete_reason TEXT`,
    `CREATE TABLE IF NOT EXISTS attachment_analysis_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_table TEXT NOT NULL,
      attachment_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      UNIQUE(source_table, attachment_id)
    )`,
    `CREATE TABLE IF NOT EXISTS operator_daily_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      work_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      daily_summary TEXT DEFAULT '',
      pending_summary TEXT DEFAULT '',
      submitted_at TEXT,
      reviewed_by INTEGER,
      reviewed_at TEXT,
      review_status TEXT NOT NULL DEFAULT 'PENDING',
      review_note TEXT DEFAULT '',
      reopened_by INTEGER,
      reopened_at TEXT,
      reopen_reason TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(org_id,user_id,work_date)
    )`,
    `CREATE TABLE IF NOT EXISTS operator_log_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      daily_log_id INTEGER NOT NULL,
      org_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      work_date TEXT NOT NULL,
      entry_type TEXT NOT NULL DEFAULT 'MISCELLANEOUS',
      title TEXT NOT NULL,
      work_done TEXT NOT NULL,
      pending_work TEXT DEFAULT '',
      linked_job_id INTEGER,
      started_at TEXT,
      completed_at TEXT,
      duration_minutes INTEGER NOT NULL DEFAULT 0,
      file_names_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT DEFAULT '',
      created_by INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_operator_daily_logs_org_date
      ON operator_daily_logs(org_id,work_date,status,user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_operator_log_entries_user_date
      ON operator_log_entries(org_id,user_id,work_date,created_at)`
  ].forEach(stmt => {
    try { db.run(stmt); } catch (_) {}
  });
  const revisionTables = [
    ['parties', 'org_id', 'id', null], ['party_addresses', 'org_id', 'id', null],
    ['item_categories', 'org_id', 'id', null], ['items', 'org_id', 'id', null],
    ['bills', 'org_id', 'id', null], ['payments', 'org_id', 'id', null],
    ['purchases', 'org_id', 'id', null], ['expenses', 'org_id', 'id', null],
    ['credit_debit_notes', 'org_id', 'id', null], ['stock_movements', 'org_id', 'id', null],
    ['purchase_orders', 'org_id', 'id', null], ['accounts', 'org_id', 'id', null],
    ['journal_entries', 'org_id', 'id', null],
    ['job_service_categories', 'org_id', 'id', null],
    ['job_service_subcategories', 'org_id', 'id', null], ['job_services', 'org_id', 'id', null],
    ['job_orders', 'org_id', 'id', 'version'], ['operator_daily_logs', 'org_id', 'id', null],
    ['operator_log_entries', 'org_id', 'id', null], ['job_intake_requests', 'org_id', 'id', null],
    ['job_internal_notes', 'org_id', 'id', null], ['warranty_replacements', 'org_id', 'id', null],
    ['warranty_service_centers', 'org_id', 'id', null], ['offline_financial_drafts', 'org_id', 'id', null]
  ];
  for (const [table, orgColumn, idColumn, versionColumn] of revisionTables) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = operation === 'DELETE' ? 'OLD' : 'NEW';
      const trigger = `sync_revision_${table}_${operation.toLowerCase()}`;
      try {
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${trigger} AFTER ${operation} ON ${table}
          BEGIN
            INSERT INTO sync_revisions (org_id,entity_type,entity_id,operation,record_version)
            VALUES (${row}.${orgColumn},'${table}',CAST(${row}.${idColumn} AS TEXT),'${operation}',${versionColumn ? `${row}.${versionColumn}` : 'NULL'});
          END`);
      } catch (_) {}
    }
  }
  const jobVersionChildren = [
    ['job_items', 'job_id'], ['job_attachments', 'job_id'], ['job_estimates', 'job_id'],
    ['job_assignments', 'job_id'], ['job_status_events', 'job_id'], ['job_work_reports', 'job_id'],
    ['job_material_consumptions', 'job_id'], ['job_additions', 'job_id'],
    ['job_delivery_acknowledgements', 'job_id'], ['job_internal_notes', 'job_id']
  ];
  for (const [table, jobColumn] of jobVersionChildren) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = operation === 'DELETE' ? 'OLD' : 'NEW';
      try {
        db.exec(`CREATE TRIGGER IF NOT EXISTS sync_job_version_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON ${table}
          BEGIN
            UPDATE job_orders SET version=version+1,updated_at=datetime('now') WHERE id=${row}.${jobColumn};
          END`);
      } catch (_) {}
    }
  }
  try {
    db.run(`CREATE TABLE IF NOT EXISTS job_material_consumptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      item_name_snapshot TEXT NOT NULL,
      item_code_snapshot TEXT DEFAULT '',
      quantity REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'NOS',
      rate REAL DEFAULT 0,
      notes TEXT DEFAULT '',
      consumed_by INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  } catch (_) {}
  try { db.run('UPDATE orgs SET negative_stock_allowed=1'); } catch (_) {}
  try { db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_bills_offline_id ON bills(offline_id) WHERE offline_id IS NOT NULL'); } catch (_) {}
  try { db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_job_orders_offline_id ON job_orders(offline_id) WHERE offline_id IS NOT NULL'); } catch (_) {}
  try { db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_job_intake_org_client_request ON job_intake_requests(org_id,client_request_id) WHERE client_request_id IS NOT NULL'); } catch (_) {}
  try { db.run('ALTER TABLE purchase_orders ADD COLUMN deleted INTEGER DEFAULT 0'); } catch (_) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_correction_bill ON invoice_correction_requests(bill_id,status)'); } catch (_) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS party_credit_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL,
    party_id INTEGER NOT NULL,
    credit_limit REAL NOT NULL DEFAULT 0,
    credit_days INTEGER NOT NULL DEFAULT 0,
    on_hold INTEGER NOT NULL DEFAULT 0,
    hold_reason TEXT NOT NULL DEFAULT '',
    updated_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(org_id,party_id)
  )`); } catch (_) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS party_collection_followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL,
    party_id INTEGER NOT NULL,
    bill_id INTEGER,
    follow_up_date TEXT NOT NULL,
    next_follow_up_date TEXT,
    outcome TEXT NOT NULL DEFAULT 'OPEN',
    promised_amount REAL NOT NULL DEFAULT 0,
    promise_date TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`); } catch (_) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS stock_counts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL,
    count_number TEXT NOT NULL,
    count_date TEXT NOT NULL,
    fy TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    notes TEXT NOT NULL DEFAULT '',
    created_by INTEGER NOT NULL,
    submitted_by INTEGER,
    submitted_at TEXT,
    approved_by INTEGER,
    approved_at TEXT,
    approval_reason TEXT NOT NULL DEFAULT '',
    cancelled_by INTEGER,
    cancelled_at TEXT,
    cancel_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(org_id,count_number)
  )`); } catch (_) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS stock_count_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    count_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    item_code_snapshot TEXT NOT NULL DEFAULT '',
    item_name_snapshot TEXT NOT NULL,
    unit_snapshot TEXT NOT NULL DEFAULT 'NOS',
    system_qty REAL NOT NULL DEFAULT 0,
    counted_qty REAL,
    variance_qty REAL NOT NULL DEFAULT 0,
    rate_snapshot REAL NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(count_id,item_id)
  )`); } catch (_) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS backup_restore_drills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    backup_log_id INTEGER,
    verification_id INTEGER,
    status TEXT NOT NULL,
    drill_type TEXT NOT NULL DEFAULT 'ISOLATED_RESTORE',
    notes TEXT NOT NULL DEFAULT '',
    evidence_json TEXT NOT NULL DEFAULT '{}',
    performed_by INTEGER NOT NULL,
    performed_at TEXT DEFAULT (datetime('now'))
  )`); } catch (_) {}
  [
    'CREATE INDEX IF NOT EXISTS idx_bills_org_fy_date ON bills(org_id,fy,bill_date,deleted,status)',
    'CREATE INDEX IF NOT EXISTS idx_bills_party_date ON bills(party_id,bill_date,deleted)',
    'CREATE INDEX IF NOT EXISTS idx_bills_org_date_total ON bills(org_id,bill_date,grand_total)',
    'CREATE INDEX IF NOT EXISTS idx_bills_org_party_total ON bills(org_id,party_id,grand_total)',
    'CREATE INDEX IF NOT EXISTS idx_payments_org_fy_date ON payments(org_id,fy,payment_date,deleted)',
    'CREATE INDEX IF NOT EXISTS idx_payments_party_date ON payments(party_id,payment_date,deleted)',
    'CREATE INDEX IF NOT EXISTS idx_stock_org_item_date ON stock_movements(org_id,item_id,movement_date)',
    'CREATE INDEX IF NOT EXISTS idx_journal_entries_org_fy_date ON journal_entries(org_id,fy,entry_date,deleted)',
    'CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id)',
    'CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_active_expiry ON sessions(active,expires_at)',
    'CREATE INDEX IF NOT EXISTS idx_backup_log_date ON backup_log(backup_date)',
    'CREATE INDEX IF NOT EXISTS idx_job_materials_job ON job_material_consumptions(job_id,created_at)',
    'CREATE INDEX IF NOT EXISTS idx_job_materials_item ON job_material_consumptions(item_id,created_at)',
    'CREATE INDEX IF NOT EXISTS idx_attachment_analysis_jobs_status ON attachment_analysis_jobs(status,updated_at,id)',
    'CREATE INDEX IF NOT EXISTS idx_job_intake_attachment_request ON job_intake_attachments(intake_request_id,created_at)',
    'CREATE INDEX IF NOT EXISTS idx_job_attachments_job_visible ON job_attachments(job_id,visible_to_customer,id)',
    'CREATE INDEX IF NOT EXISTS idx_job_attachments_retention ON job_attachments(retention_state,retention_delete_after)',
    'CREATE INDEX IF NOT EXISTS idx_parties_org_active_name ON parties(org_id,active,name)',
    'CREATE INDEX IF NOT EXISTS idx_items_org_active_name ON items(org_id,active,name)',
    'CREATE INDEX IF NOT EXISTS idx_job_orders_org_status_due ON job_orders(org_id,current_status,promised_delivery_at)',
    'CREATE INDEX IF NOT EXISTS idx_job_intake_org_status_created ON job_intake_requests(org_id,status,created_at)',
    'CREATE INDEX IF NOT EXISTS idx_party_credit_policy_org_hold ON party_credit_policies(org_id,on_hold,party_id)',
    'CREATE INDEX IF NOT EXISTS idx_party_collection_org_party_date ON party_collection_followups(org_id,party_id,follow_up_date,created_at)',
    'CREATE INDEX IF NOT EXISTS idx_party_collection_org_bill_date ON party_collection_followups(org_id,bill_id,created_at)'
    ,'CREATE INDEX IF NOT EXISTS idx_stock_counts_org_status_date ON stock_counts(org_id,status,count_date,created_at)'
    ,'CREATE INDEX IF NOT EXISTS idx_stock_count_lines_count_item ON stock_count_lines(count_id,item_id)'
    ,'CREATE INDEX IF NOT EXISTS idx_backup_restore_drills_date ON backup_restore_drills(performed_at,status)'
  ].forEach(stmt => {
    try { db.run(stmt); } catch (_) {}
  });
  try { db.run(`CREATE TABLE IF NOT EXISTS transaction_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    relationship TEXT NOT NULL DEFAULT 'derived_from',
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(org_id,source_type,source_id,target_type,target_id,relationship)
  )`); } catch (_) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_transaction_links_source ON transaction_links(org_id,source_type,source_id,relationship)`); } catch (_) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_transaction_links_target ON transaction_links(org_id,target_type,target_id,relationship)`); } catch (_) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS transaction_line_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    source_line_key TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    target_line_key TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(org_id,source_type,source_id,source_line_key,target_type,target_id,target_line_key)
  )`); } catch (_) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_transaction_alloc_source ON transaction_line_allocations(org_id,source_type,source_id,source_line_key)`); } catch (_) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_transaction_alloc_target ON transaction_line_allocations(org_id,target_type,target_id,target_line_key)`); } catch (_) {}
  recordSchemaMigration(
    '2026-07-21-quotation-dc-invoice-links',
    'Quotation, Delivery Challan, invoice document links and partial line allocations'
  );
  try {
    const quotationPrintMigration = db.prepare(
      `SELECT 1 FROM schema_migrations WHERE migration_key=?`
    ).get('2026-07-13-quotation-print-defaults');
    if (!quotationPrintMigration) {
      const rows = db.prepare(
        `SELECT id, print_options FROM transaction_control_settings
         WHERE transaction_type='QUOT'`
      ).all();
      rows.forEach(row => {
        let print = {};
        try { print = JSON.parse(row.print_options || '{}'); } catch (_) {}
        print.payment_status = false;
        print.operator = false;
        print.digital_signature = false;
        db.prepare(
          `UPDATE transaction_control_settings SET print_options=?, updated_at=datetime('now') WHERE id=?`
        ).run(JSON.stringify(print), row.id);
      });
      recordSchemaMigration(
        '2026-07-13-quotation-print-defaults',
        'Quotation print defaults hide payment status, prepared by, and digital signature while retaining owner controls'
      );
    }
  } catch (_) {}

  recordSchemaMigration(
    '2026-06-21-merged-db-foundation',
    'Merged workflow database foundation with migration tracking, metadata registry, data shift tables, and integration indexes'
  );
  recordSchemaMigration(
    '2026-06-22-customer-intake-flow',
    'Customer QR intake requests, attachment analysis storage, and staff conversion flow'
  );
  recordSchemaMigration(
    '2026-06-24-job-material-consumption',
    'Job-linked material consumption records with inventory movement linkage and backup coverage'
  );
  recordSchemaMigration(
    '2026-06-24-online-readiness-foundation',
    'Deployment profile configuration, intake idempotency protection, and future web/mobile online readiness baseline'
  );
  recordSchemaMigration(
    '2026-06-24-durable-attachment-analysis-worker',
    'Persistent attachment analysis queue with startup recovery for customer and job uploads'
  );
  recordSchemaMigration(
    '2026-06-26-attachment-retention-archive',
    'Attachment lifecycle policy with metadata-only backups, owner archive option, and seven-day post-delivery cleanup'
  );
  recordSchemaMigration(
    '2026-07-01-job-pre-billing-link',
    'Job order first-bill linkage with duplicate final invoice protection'
  );
  recordSchemaMigration(
    '2026-07-03-financial-year-closing',
    'Financial year closing metadata, audit snapshots, pre-close checks, and safe reopen tracking'
  );
  recordSchemaMigration(
    '2026-07-13-operator-daily-log',
    'Append-only operator daily logs, miscellaneous work entries, submission review, and filename-only activity reporting'
  );
  recordSchemaMigration(
    '2026-07-15-common-warranty-customer-ledgers',
    'Three organization-scoped common warranty ledgers with per-case walk-in customer snapshots'
  );
  recordSchemaMigration(
    '2026-08-07-owner-report-centre-and-credit-controls',
    'Owner report exports, receivable collection follow-ups, and organization-scoped party credit policies'
  );
  recordSchemaMigration(
    '2026-08-07-physical-stock-count-approval',
    'Physical stock-count sessions with snapshot conflict protection, owner approval, and audited quantity adjustments'
  );
  recordSchemaMigration(
    '2026-08-07-backup-restore-drills',
    'Recorded isolated backup restore drills with verification evidence and owner review interval'
  );
  setAppMetadata('app_flavor', 'merged-billing-workflow');
  setAppMetadata('db_baseline', '1.0.0-merged');
  setAppMetadata('data_shift_ready', '1');
  setAppMetadata('last_startup_mode', 'initializeDB');

  seed.split(';').filter(s => s.trim()).forEach(stmt => {
    try { db.run(stmt); } catch(e) { }
  });

  try {
    const computerOrg = get(
      `SELECT id FROM orgs
       WHERE UPPER(display_name)=? OR UPPER(registered_name)=?
       ORDER BY id LIMIT 1`,
      ['BITS & BINARY', 'SHRI LAKSHMI KALYANI INTERNATIONAL']
    );
    if (computerOrg) {
      const categories = {
        input: ['Input Devices', '84716040'],
        audio: ['Audio & Headsets', '85183000'],
        cables: ['Computer Cables', '85444299'],
        display: ['Displays & Projectors', '85285200'],
        printers: ['Printers & Consumables', '84433240'],
        storage: ['Storage Media', '85235100'],
        parts: ['Computer Parts', '84733099'],
        power: ['Power & Cooling', '85076000'],
        network: ['Networking', '85176290']
      };
      const categoryIds = {};
      Object.entries(categories).forEach(([key, [name, hsn]]) => {
        let category = get('SELECT id FROM item_categories WHERE org_id=? AND name=?', [computerOrg.id, name]);
        if (!category) {
          category = {
            id: run('INSERT INTO item_categories (org_id,name,hsn_code) VALUES (?,?,?)',
              [computerOrg.id, name, hsn]).lastInsertRowid
          };
        }
        categoryIds[key] = category.id;
      });
      const catalogue = [
        ['COM-MOU-001', 'Optical USB Mouse', '84716060', 'input'],
        ['COM-KBD-001', 'USB Keyboard', '84716040', 'input'],
        ['COM-HDP-001', 'Wired Headphones', '85183000', 'audio'],
        ['COM-HST-001', 'USB Headset with Microphone', '85183000', 'audio'],
        ['COM-SPK-001', 'Computer Speakers (Pair)', '85182200', 'audio'],
        ['COM-MIC-001', 'Computer Microphone', '85181000', 'audio'],
        ['COM-CAB-001', 'HDMI Cable', '85444299', 'cables'],
        ['COM-CAB-002', 'USB Data Cable', '85444299', 'cables'],
        ['COM-CAB-003', 'Computer Power Cable', '85444299', 'cables'],
        ['COM-PRO-001', 'Computer Multimedia Projector', '85286200', 'display'],
        ['COM-MON-001', 'LED Computer Monitor', '85285200', 'display'],
        ['COM-PRN-001', 'Laser Printer', '84433240', 'printers'],
        ['COM-PRN-002', 'Inkjet Printer', '84433250', 'printers'],
        ['COM-PRN-003', 'Multifunction Printer', '84433100', 'printers'],
        ['COM-CDR-001', 'Blank Recordable CD', '85234100', 'storage'],
        ['COM-DVD-001', 'Blank Recordable DVD', '85234100', 'storage'],
        ['COM-SSD-001', 'Solid State Drive (SSD)', '85235100', 'storage'],
        ['COM-HDD-001', 'Hard Disk Drive (HDD)', '84717020', 'storage'],
        ['COM-USB-001', 'USB Pen Drive', '85235100', 'storage'],
        ['COM-CAS-001', 'Desktop Computer Cabinet', '84733099', 'parts'],
        ['COM-RAM-001', 'Computer RAM Module', '84733030', 'parts'],
        ['COM-FAN-001', 'Computer Cooling Fan', '84145990', 'power'],
        ['COM-PWB-001', 'USB Power Bank', '85076000', 'power'],
        ['COM-UPS-001', 'Computer UPS', '85044090', 'power'],
        ['COM-RTR-001', 'Wi-Fi Router', '85176290', 'network'],
        ['COM-WBC-001', 'USB Webcam', '85258900', 'input']
      ];
      catalogue.forEach(([itemCode, name, hsn, category]) => {
        const existing = get(
          'SELECT id FROM items WHERE org_id=? AND (item_code=? OR LOWER(name)=LOWER(?)) LIMIT 1',
          [computerOrg.id, itemCode, name]
        );
        if (existing) return;
        run(
          `INSERT INTO items
           (org_id,category_id,name,hsn_code,unit,gst_rate,last_sale_price,last_purchase_price,
            description,item_code,model_number,mrp,barcode,opening_stock,reorder_level)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [computerOrg.id, categoryIds[category], name, hsn, 'NOS', 18, 0, 0,
           'Preloaded computer catalogue item. Confirm classification for the exact product model before filing GST.',
           itemCode, '', 0, itemCode, 0, 0]
        );
      });
    }
  } catch (e) {
    console.error('Computer catalogue preload error:', e.message);
  }

  try {
    db.run(
      `UPDATE bills SET cost_total=COALESCE((
        SELECT SUM(CAST(json_extract(j.value,'$.qty') AS REAL)*COALESCE(i.last_purchase_price,0))
        FROM json_each(bills.items_json) j
        LEFT JOIN items i ON i.id=CAST(json_extract(j.value,'$.item_id') AS INTEGER)
      ),0) WHERE COALESCE(cost_total,0)=0`
    );
  } catch (_) {}

  const bcrypt = require('bcryptjs');
  const ownerHash = bcrypt.hashSync('owner123', 10);
  const operatorHash = bcrypt.hashSync('operator123', 10);
  try {
    db.run(
      `UPDATE users SET password_hash=? WHERE password_hash=?`,
      [ownerHash, '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TiGX1ZW5bQH2jYT0HGd1HGBiPyiO']
    );
    db.run(
      `UPDATE users SET password_hash=? WHERE password_hash=?`,
      [operatorHash, '$2a$12$eImiTXuWVxfM37uY9mDIgeUE5B1WXpUGAQRPlZqpqFhWuFMFuFpqy']
    );
  } catch(e) {}

  try {
    require('../accounting/accounting').rebuildAccounting();
  } catch (e) {
    console.error('Accounting rebuild error:', e.message);
  }

  try {
    const orgs = all('SELECT id,display_name FROM orgs');
    orgs.forEach(org => {
      const code = String(org.display_name || 'ORG').replace(/[^A-Z0-9]/gi, '').substring(0, 3).toUpperCase();
      all('SELECT id,item_code,barcode FROM items WHERE org_id=? ORDER BY id', [org.id]).forEach((item, index) => {
        const itemCode = item.item_code || `${code}-ITEM-${String(index + 1).padStart(5, '0')}`;
        const barcode = item.barcode || `${String(org.id).padStart(2, '0')}${String(item.id).padStart(10, '0')}${String(index + 1).padStart(3, '0')}`;
        db.run('UPDATE items SET item_code=?,barcode=?,mrp=CASE WHEN COALESCE(mrp,0)=0 THEN last_sale_price ELSE mrp END WHERE id=?',
          [itemCode, barcode, item.id]);
      });
    });
  } catch (e) {
    console.error('Item code migration error:', e.message);
  }

  try {
    const { replaceStockMovements } = require('../business/stock');
    all(`SELECT * FROM bills WHERE format='SALE' AND deleted=0 AND status='saved'`).forEach(bill => {
      replaceStockMovements({
        orgId: bill.org_id, sourceType: 'bill', sourceId: bill.id, date: bill.bill_date,
        refNumber: bill.bill_number, items: JSON.parse(bill.items_json || '[]'), direction: 'out'
      });
    });
    all('SELECT * FROM purchases WHERE deleted=0').forEach(purchase => {
      replaceStockMovements({
        orgId: purchase.org_id, sourceType: 'purchase', sourceId: purchase.id, date: purchase.purchase_date,
        refNumber: purchase.purchase_number, items: JSON.parse(purchase.items_json || '[]'), direction: 'in'
      });
    });
    all('SELECT * FROM credit_debit_notes WHERE deleted=0').forEach(note => {
      replaceStockMovements({
        orgId: note.org_id, sourceType: 'note', sourceId: note.id, date: note.note_date,
        refNumber: note.note_number, items: JSON.parse(note.items_json || '[]'),
        direction: note.note_type === 'credit' ? 'in' : 'out'
      });
    });
  } catch (e) {
    console.error('Stock rebuild error:', e.message);
  }

  saveDB();
  console.log('✅ Database ready at', DB_PATH);
}

module.exports = {
  initDB, getDB, run, get, all, safeAll, exec, transaction, initializeDB, saveDB,
  getDBPath: () => DB_PATH,
  getAppDataDir: () => APP_DATA_DIR
};
