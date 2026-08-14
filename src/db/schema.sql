CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  registered_name TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  gstin TEXT,
  gst_type TEXT DEFAULT 'regular',
  bank_name TEXT, account_no TEXT, branch TEXT, ifsc TEXT, upi_id TEXT,
  logo_base64 TEXT,
  note_header TEXT DEFAULT '',
  note_footer TEXT DEFAULT 'Thank you for your business!',
  quotation_fixed_note TEXT DEFAULT '',
  delivery_challan_fixed_note TEXT DEFAULT '',
  proforma_fixed_note TEXT DEFAULT '',
  invoice_description TEXT DEFAULT '',
  project_bw_rate REAL DEFAULT 0,
  project_colour_rate REAL DEFAULT 0,
  project_book_rate REAL DEFAULT 0,
  signature_name TEXT,
  signature_image TEXT,
  invoice_qr_enabled INTEGER DEFAULT 1,
  negative_stock_allowed INTEGER DEFAULT 1,
  default_tax_inclusive INTEGER DEFAULT 0,
  invoice_prefixes TEXT DEFAULT '{}',
  invoice_theme TEXT DEFAULT 'classic',
  invoice_print_options TEXT DEFAULT '{}',
  job_catalog_auto_seed INTEGER NOT NULL DEFAULT 1,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  pin_hash TEXT,
  role TEXT NOT NULL DEFAULT 'operator',
  org_access TEXT DEFAULT 'all',
  permissions TEXT DEFAULT '{}',
  active INTEGER DEFAULT 1,
  last_login TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  ip_address TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS registered_devices (
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
);

CREATE INDEX IF NOT EXISTS idx_registered_devices_org_status
  ON registered_devices(org_id, status);

CREATE TABLE IF NOT EXISTS sync_cursors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  last_pulled_revision INTEGER NOT NULL DEFAULT 0,
  last_pushed_at TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_id, device_id)
);

CREATE TABLE IF NOT EXISTS sync_outbox (
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
);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_device_status
  ON sync_outbox(org_id, device_id, status, created_at);

CREATE TABLE IF NOT EXISTS sync_conflicts (
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
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_org_status
  ON sync_conflicts(org_id, status, created_at);

CREATE TABLE IF NOT EXISTS sync_replay (
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
);

CREATE INDEX IF NOT EXISTS idx_sync_replay_org_created
  ON sync_replay(org_id, created_at);

CREATE TABLE IF NOT EXISTS sync_revisions (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  record_version INTEGER,
  changed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sync_revisions_org_revision
  ON sync_revisions(org_id, revision);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  org_id INTEGER,
  action TEXT,
  table_name TEXT,
  record_id INTEGER,
  old_data TEXT,
  new_data TEXT,
  ip_address TEXT,
  timestamp TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS warranty_replacements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  replacement_number TEXT NOT NULL,
  party_id INTEGER NOT NULL,
  customer_mode TEXT NOT NULL DEFAULT 'PARTY',
  common_customer_slot INTEGER,
  customer_name TEXT DEFAULT '',
  customer_phone TEXT DEFAULT '',
  customer_email TEXT DEFAULT '',
  customer_address TEXT DEFAULT '',
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
  UNIQUE(org_id, replacement_number),
  FOREIGN KEY(org_id) REFERENCES orgs(id),
  FOREIGN KEY(party_id) REFERENCES parties(id),
  FOREIGN KEY(original_sale_bill_id) REFERENCES bills(id),
  FOREIGN KEY(delivery_bill_id) REFERENCES bills(id),
  FOREIGN KEY(product_item_id) REFERENCES items(id)
);

CREATE TABLE IF NOT EXISTS warranty_service_centers (
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
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_by INTEGER,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transaction_control_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  transaction_type TEXT NOT NULL,
  form_options TEXT DEFAULT '{}',
  required_fields TEXT DEFAULT '{}',
  print_options TEXT DEFAULT '{}',
  updated_by INTEGER,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_id, transaction_type)
);

CREATE TABLE IF NOT EXISTS parties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  shared INTEGER DEFAULT 0,
  type TEXT DEFAULT 'both',
  name TEXT NOT NULL,
  registered_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  state TEXT DEFAULT 'Andhra Pradesh',
  pincode TEXT,
  gstin TEXT,
  gst_type TEXT DEFAULT 'unregistered',
  delivery_addresses TEXT DEFAULT '[]',
  digital_signature_required INTEGER DEFAULT 0,
  is_common_ledger INTEGER DEFAULT 0,
  common_ledger_slot INTEGER,
  opening_balance REAL DEFAULT 0,
  balance_type TEXT DEFAULT 'cr',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS party_org_links (
  party_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  PRIMARY KEY (party_id, org_id)
);

CREATE TABLE IF NOT EXISTS party_credit_policies (
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
  UNIQUE(org_id,party_id),
  FOREIGN KEY (org_id) REFERENCES orgs(id),
  FOREIGN KEY (party_id) REFERENCES parties(id)
);

CREATE TABLE IF NOT EXISTS party_collection_followups (
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
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (org_id) REFERENCES orgs(id),
  FOREIGN KEY (party_id) REFERENCES parties(id),
  FOREIGN KEY (bill_id) REFERENCES bills(id)
);

CREATE TABLE IF NOT EXISTS party_addresses (
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
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(party_id) REFERENCES parties(id)
);

CREATE TABLE IF NOT EXISTS item_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  hsn_code TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  category_id INTEGER,
  name TEXT NOT NULL,
  hsn_code TEXT,
  unit TEXT DEFAULT 'NOS',
  gst_rate REAL DEFAULT 18,
  last_sale_price REAL DEFAULT 0,
  last_purchase_price REAL DEFAULT 0,
  description TEXT,
  item_code TEXT,
  model_number TEXT,
  mrp REAL DEFAULT 0,
  barcode TEXT,
  opening_stock REAL DEFAULT 0,
  reorder_level REAL DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bill_sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  format TEXT NOT NULL,
  fy TEXT NOT NULL,
  prefix TEXT,
  last_number INTEGER DEFAULT 0,
  UNIQUE(org_id, format, fy)
);

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  format TEXT NOT NULL,
  bill_number TEXT,
  bill_date TEXT,
  fy TEXT,
  party_id INTEGER,
  party_snapshot TEXT,
  billing_address_id INTEGER,
  billing_address_snapshot TEXT,
  delivery_address_id INTEGER,
  delivery_address_snapshot TEXT,
  delivery_address TEXT,
  delivery_info TEXT DEFAULT '{}',
  po_number TEXT,
  po_date TEXT,
  credit_days INTEGER,
  due_date TEXT,
  payment_mode TEXT DEFAULT 'cash',
  items_json TEXT DEFAULT '[]',
  subtotal REAL DEFAULT 0,
  discount REAL DEFAULT 0,
  taxable_amount REAL DEFAULT 0,
  tax_rate REAL DEFAULT 0,
  cgst REAL DEFAULT 0,
  sgst REAL DEFAULT 0,
  igst REAL DEFAULT 0,
  total_tax REAL DEFAULT 0,
  grand_total REAL DEFAULT 0,
  round_off REAL DEFAULT 0,
  total_in_words TEXT,
  note_header TEXT DEFAULT '',
  note_footer TEXT DEFAULT '',
  description TEXT DEFAULT '',
  swipe_charge REAL DEFAULT 0,
  custom_data TEXT DEFAULT '{}',
  split_payments TEXT DEFAULT '[]',
  cost_total REAL DEFAULT 0,
  shift_id INTEGER,
  return_of INTEGER,
  bank_details TEXT,
  status TEXT DEFAULT 'saved',
  converted_to INTEGER,
  converted_from INTEGER,
  offline_id TEXT,
  offline_device TEXT,
  offline_created_at TEXT,
  tax_inclusive INTEGER DEFAULT 0,
  digital_signature_required INTEGER DEFAULT 0,
  digital_signature_note TEXT DEFAULT '',
  digital_signature_status TEXT DEFAULT 'not_required',
  digital_signature_signed_at TEXT,
  digital_signature_signed_by INTEGER,
  created_by INTEGER,
  edited_by INTEGER,
  deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transaction_links (
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
);

CREATE INDEX IF NOT EXISTS idx_transaction_links_source
  ON transaction_links(org_id,source_type,source_id,relationship);
CREATE INDEX IF NOT EXISTS idx_transaction_links_target
  ON transaction_links(org_id,target_type,target_id,relationship);

CREATE TABLE IF NOT EXISTS transaction_line_allocations (
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
);

CREATE INDEX IF NOT EXISTS idx_transaction_alloc_source
  ON transaction_line_allocations(org_id,source_type,source_id,source_line_key);
CREATE INDEX IF NOT EXISTS idx_transaction_alloc_target
  ON transaction_line_allocations(org_id,target_type,target_id,target_line_key);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  payment_number TEXT,
  payment_date TEXT,
  fy TEXT,
  party_id INTEGER,
  party_snapshot TEXT,
  type TEXT DEFAULT 'received',
  mode TEXT DEFAULT 'cash',
  deposit_account_id INTEGER,
  amount REAL DEFAULT 0,
  reference TEXT,
  linked_bills TEXT DEFAULT '[]',
  narration TEXT,
  shift_id INTEGER,
  reversal_number TEXT,
  reversed_at TEXT,
  reversed_by INTEGER,
  reversal_reason TEXT DEFAULT '',
  created_by INTEGER,
  deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL,
  bill_id INTEGER NOT NULL,
  amount REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  purchase_number TEXT NOT NULL,
  supplier_invoice TEXT,
  purchase_date TEXT NOT NULL,
  due_date TEXT,
  fy TEXT NOT NULL,
  party_id INTEGER,
  items_json TEXT DEFAULT '[]',
  taxable_amount REAL DEFAULT 0,
  cgst REAL DEFAULT 0,
  sgst REAL DEFAULT 0,
  igst REAL DEFAULT 0,
  total_tax REAL DEFAULT 0,
  grand_total REAL DEFAULT 0,
  round_off REAL DEFAULT 0,
  payment_mode TEXT DEFAULT 'credit',
  narration TEXT,
  tax_inclusive INTEGER DEFAULT 0,
  created_by INTEGER,
  deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  expense_number TEXT NOT NULL,
  expense_date TEXT NOT NULL,
  fy TEXT NOT NULL,
  party_id INTEGER,
  account_id INTEGER NOT NULL,
  payment_mode TEXT DEFAULT 'cash',
  amount REAL DEFAULT 0,
  gst_amount REAL DEFAULT 0,
  gst_rate REAL DEFAULT 0,
  tax_inclusive INTEGER DEFAULT 0,
  round_off REAL DEFAULT 0,
  reference TEXT,
  narration TEXT,
  created_by INTEGER,
  deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS credit_debit_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  note_number TEXT NOT NULL,
  note_date TEXT NOT NULL,
  fy TEXT NOT NULL,
  note_type TEXT NOT NULL,
  party_id INTEGER,
  linked_bill_id INTEGER,
  linked_purchase_id INTEGER,
  items_json TEXT DEFAULT '[]',
  taxable_amount REAL DEFAULT 0,
  tax_amount REAL DEFAULT 0,
  grand_total REAL DEFAULT 0,
  round_off REAL DEFAULT 0,
  narration TEXT,
  tax_inclusive INTEGER DEFAULT 0,
  created_by INTEGER,
  deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  movement_date TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  ref_number TEXT,
  qty_in REAL DEFAULT 0,
  qty_out REAL DEFAULT 0,
  rate REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_counts (
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
);

CREATE TABLE IF NOT EXISTS stock_count_lines (
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
  UNIQUE(count_id,item_id),
  FOREIGN KEY (count_id) REFERENCES stock_counts(id),
  FOREIGN KEY (item_id) REFERENCES items(id)
);

CREATE TABLE IF NOT EXISTS bank_reconciliation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  journal_line_id INTEGER NOT NULL,
  statement_date TEXT,
  statement_reference TEXT,
  matched INTEGER DEFAULT 1,
  matched_by INTEGER,
  matched_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_id, journal_line_id)
);

CREATE TABLE IF NOT EXISTS bank_statement_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  imported_by INTEGER,
  file_hash TEXT,
  mapping_json TEXT DEFAULT '{}',
  imported_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bank_statement_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  transaction_date TEXT,
  description TEXT,
  reference TEXT,
  debit REAL DEFAULT 0,
  credit REAL DEFAULT 0,
  balance REAL,
  journal_line_id INTEGER,
  matched INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gstr2b_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  fy TEXT NOT NULL,
  file_name TEXT,
  source_format TEXT DEFAULT 'json',
  imported_by INTEGER,
  imported_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gstr2b_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  fy TEXT NOT NULL,
  supplier_gstin TEXT,
  supplier_name TEXT,
  invoice_number TEXT,
  invoice_date TEXT,
  taxable_amount REAL DEFAULT 0,
  igst REAL DEFAULT 0,
  cgst REAL DEFAULT 0,
  sgst REAL DEFAULT 0,
  cess REAL DEFAULT 0,
  total_tax REAL DEFAULT 0,
  raw_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pos_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  counter_name TEXT DEFAULT 'Main Counter',
  opening_cash REAL DEFAULT 0,
  cash_added REAL DEFAULT 0,
  cash_removed REAL DEFAULT 0,
  expected_cash REAL DEFAULT 0,
  counted_cash REAL,
  variance REAL,
  status TEXT DEFAULT 'open',
  owner_accepted INTEGER DEFAULT 0,
  accepted_by INTEGER,
  accepted_at TEXT,
  acceptance_note TEXT,
  opened_at TEXT DEFAULT (datetime('now')),
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS invoice_correction_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  bill_id INTEGER NOT NULL,
  requested_by INTEGER NOT NULL,
  reason TEXT NOT NULL,
  requested_items TEXT DEFAULT '[]',
  proposed_items TEXT DEFAULT '[]',
  status TEXT DEFAULT 'pending',
  reviewed_by INTEGER,
  review_note TEXT,
  resolution_type TEXT,
  credit_note_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS update_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL UNIQUE,
  file_name TEXT,
  file_path TEXT,
  sha256 TEXT,
  release_notes TEXT,
  mandatory INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS held_bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  shift_id INTEGER,
  hold_name TEXT,
  cart_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  po_number TEXT NOT NULL,
  po_date TEXT NOT NULL,
  expected_date TEXT,
  fy TEXT NOT NULL,
  party_id INTEGER,
  items_json TEXT DEFAULT '[]',
  subtotal REAL DEFAULT 0,
  round_off REAL DEFAULT 0,
  status TEXT DEFAULT 'open',
  converted_purchase_id INTEGER,
  narration TEXT,
  tax_inclusive INTEGER DEFAULT 0,
  created_by INTEGER,
  deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scheduled_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  report_type TEXT NOT NULL DEFAULT 'monthly_summary',
  recipient_email TEXT NOT NULL,
  day_of_month INTEGER DEFAULT 1,
  output_directory TEXT,
  enabled INTEGER DEFAULT 1,
  last_run_at TEXT,
  last_status TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS financial_year_locks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  fy TEXT NOT NULL,
  locked INTEGER DEFAULT 1,
  locked_by INTEGER,
  locked_at TEXT DEFAULT (datetime('now')),
  closed INTEGER DEFAULT 0,
  closed_by INTEGER,
  closed_at TEXT,
  close_note TEXT DEFAULT '',
  close_snapshot_json TEXT DEFAULT '{}',
  reopened_by INTEGER,
  reopened_at TEXT,
  reopen_reason TEXT DEFAULT '',
  UNIQUE(org_id, fy)
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  party_id INTEGER NOT NULL,
  date TEXT,
  type TEXT,
  ref_id INTEGER,
  ref_number TEXT,
  debit REAL DEFAULT 0,
  credit REAL DEFAULT 0,
  balance REAL DEFAULT 0,
  narration TEXT,
  fy TEXT
);

CREATE TABLE IF NOT EXISTS backup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER,
  fy TEXT,
  backup_date TEXT DEFAULT (datetime('now')),
  file_name TEXT,
  created_by INTEGER
);

CREATE TABLE IF NOT EXISTS backup_verification_log (
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
);

CREATE TABLE IF NOT EXISTS backup_restore_drills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_log_id INTEGER,
  verification_id INTEGER,
  status TEXT NOT NULL,
  drill_type TEXT NOT NULL DEFAULT 'ISOLATED_RESTORE',
  notes TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  performed_by INTEGER NOT NULL,
  performed_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (backup_log_id) REFERENCES backup_log(id),
  FOREIGN KEY (verification_id) REFERENCES backup_verification_log(id)
);

CREATE INDEX IF NOT EXISTS idx_backup_verification_status_date
  ON backup_verification_log(status, verified_at);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  subtype TEXT,
  system_key TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_id, code),
  UNIQUE(org_id, system_key)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  entry_date TEXT NOT NULL,
  fy TEXT NOT NULL,
  voucher_type TEXT DEFAULT 'JOURNAL',
  voucher_number TEXT,
  narration TEXT,
  source_type TEXT,
  source_id INTEGER,
  created_by INTEGER,
  deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_id, source_type, source_id)
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  party_id INTEGER,
  debit REAL DEFAULT 0,
  credit REAL DEFAULT 0,
  narration TEXT
);

CREATE INDEX IF NOT EXISTS idx_bills_org ON bills(org_id, format, fy);
CREATE INDEX IF NOT EXISTS idx_bills_party ON bills(party_id);
CREATE INDEX IF NOT EXISTS idx_bills_number ON bills(org_id, bill_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bills_offline_id ON bills(offline_id) WHERE offline_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_parties_org ON parties(org_id);
CREATE INDEX IF NOT EXISTS idx_items_org ON items(org_id);
CREATE INDEX IF NOT EXISTS idx_ledger_party ON ledger(party_id, org_id, fy);
CREATE INDEX IF NOT EXISTS idx_payments_org ON payments(org_id, fy);
CREATE INDEX IF NOT EXISTS idx_payments_number ON payments(org_id, payment_number);
CREATE INDEX IF NOT EXISTS idx_accounts_org ON accounts(org_id, type);
CREATE INDEX IF NOT EXISTS idx_journal_entries_org ON journal_entries(org_id, fy, entry_date);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id, party_id);
CREATE INDEX IF NOT EXISTS idx_stock_item ON stock_movements(org_id, item_id, movement_date);
CREATE INDEX IF NOT EXISTS idx_purchases_org ON purchases(org_id, fy, purchase_date);
CREATE INDEX IF NOT EXISTS idx_purchases_number ON purchases(org_id, purchase_number);
CREATE INDEX IF NOT EXISTS idx_expenses_org ON expenses(org_id, fy, expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_number ON expenses(org_id, expense_number);
CREATE INDEX IF NOT EXISTS idx_notes_org ON credit_debit_notes(org_id, fy, note_date);
CREATE INDEX IF NOT EXISTS idx_notes_number ON credit_debit_notes(org_id, note_number);
CREATE INDEX IF NOT EXISTS idx_allocations_bill ON payment_allocations(bill_id);
CREATE INDEX IF NOT EXISTS idx_bank_statement_org ON bank_statement_rows(org_id, transaction_date);
CREATE INDEX IF NOT EXISTS idx_bank_statement_reference ON bank_statement_rows(org_id, reference);
CREATE INDEX IF NOT EXISTS idx_gstr2b_org ON gstr2b_rows(org_id, fy, supplier_gstin, invoice_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_import_hash ON bank_statement_imports(org_id, file_hash);
CREATE INDEX IF NOT EXISTS idx_pos_shifts_org ON pos_shifts(org_id, status, opened_at);
CREATE INDEX IF NOT EXISTS idx_held_bills_org ON held_bills(org_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_org ON purchase_orders(org_id, fy, po_date);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_number ON purchase_orders(org_id, po_number);
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_org ON scheduled_reports(org_id, enabled);
CREATE INDEX IF NOT EXISTS idx_correction_bill ON invoice_correction_requests(bill_id, status);

-- Job Order and Service Workflow
CREATE TABLE IF NOT EXISTS job_service_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_id, code),
  UNIQUE(org_id, name)
);

CREATE TABLE IF NOT EXISTS job_service_subcategories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_id, code),
  UNIQUE(category_id, name)
);

CREATE TABLE IF NOT EXISTS job_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  subcategory_id INTEGER,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  specification_schema TEXT DEFAULT '{}',
  allowed_units TEXT DEFAULT '[]',
  default_unit TEXT DEFAULT 'NOS',
  default_sla_minutes INTEGER,
  estimate_guidance TEXT DEFAULT '{}',
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(org_id, code)
);

CREATE TABLE IF NOT EXISTS job_sequences (
  org_id INTEGER NOT NULL,
  fy TEXT NOT NULL,
  last_number INTEGER DEFAULT 0,
  PRIMARY KEY(org_id, fy)
);

CREATE TABLE IF NOT EXISTS job_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  job_token TEXT UNIQUE,
  provisional_token TEXT UNIQUE,
  offline_id TEXT,
  offline_device TEXT,
  offline_created_at TEXT,
  party_id INTEGER NOT NULL,
  party_snapshot TEXT NOT NULL DEFAULT '{}',
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  promised_delivery_at TEXT NOT NULL,
  current_status TEXT NOT NULL DEFAULT 'WAITING',
  financial_status TEXT NOT NULL DEFAULT 'OPEN',
  customer_commitment TEXT DEFAULT '',
  counter_note TEXT DEFAULT '',
  advance_paise INTEGER DEFAULT 0,
  advance_payment_ids TEXT DEFAULT '[]',
  pre_bill_id INTEGER,
  pre_billed_at TEXT,
  final_bill_id INTEGER,
  delivered_at TEXT,
  closed_at TEXT,
  version INTEGER DEFAULT 1,
  created_by INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  service_id INTEGER NOT NULL,
  category_snapshot TEXT NOT NULL,
  subcategory_snapshot TEXT,
  service_snapshot TEXT NOT NULL,
  description TEXT NOT NULL,
  specification_json TEXT DEFAULT '{}',
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_by INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'JOB',
  entity_id INTEGER,
  purpose TEXT NOT NULL DEFAULT 'OTHER',
  upload_origin TEXT NOT NULL DEFAULT 'STAFF',
  file_name TEXT NOT NULL,
  mime_type TEXT,
  byte_size INTEGER DEFAULT 0,
  sha256 TEXT,
  storage_path TEXT,
  content_base64 TEXT,
  visible_to_customer INTEGER DEFAULT 0,
  pixel_width INTEGER,
  pixel_height INTEGER,
  pdf_page_count INTEGER,
  analysis_status TEXT NOT NULL DEFAULT 'PENDING',
  analysis_error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  retention_policy TEXT NOT NULL DEFAULT 'AUTO_DELETE',
  retention_state TEXT NOT NULL DEFAULT 'ACTIVE',
  retention_delete_after TEXT,
  archived_at TEXT,
  archived_by INTEGER,
  archive_reason TEXT,
  physical_deleted_at TEXT,
  physical_deleted_by INTEGER,
  physical_delete_reason TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_estimates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  revision_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  subtotal_paise INTEGER NOT NULL DEFAULT 0,
  tax_paise INTEGER NOT NULL DEFAULT 0,
  total_paise INTEGER NOT NULL DEFAULT 0,
  round_off_paise INTEGER DEFAULT 0,
  lines_json TEXT NOT NULL DEFAULT '[]',
  tax_inclusive INTEGER DEFAULT 0,
  created_by INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(job_id, revision_no)
);

CREATE TABLE IF NOT EXISTS job_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  assigned_role TEXT NOT NULL,
  assigned_by INTEGER NOT NULL,
  source_assignment_id INTEGER,
  handoff_type TEXT NOT NULL,
  handoff_reason TEXT NOT NULL,
  instructions TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING_ACCEPTANCE',
  assigned_at TEXT DEFAULT (datetime('now')),
  accepted_at TEXT,
  declined_at TEXT,
  decline_reason TEXT,
  released_at TEXT,
  release_reason TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS job_status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  actor_user_id INTEGER NOT NULL,
  operation_id TEXT UNIQUE,
  occurred_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_work_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  report_type TEXT NOT NULL,
  progress_percent INTEGER,
  report_text TEXT NOT NULL,
  checklist_json TEXT DEFAULT '{}',
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operator_daily_logs (
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
);

CREATE TABLE IF NOT EXISTS operator_log_entries (
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
);

CREATE TABLE IF NOT EXISTS job_material_consumptions (
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
);

CREATE TABLE IF NOT EXISTS job_additions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  proposed_by INTEGER NOT NULL,
  internal_reason TEXT NOT NULL,
  customer_description TEXT DEFAULT '',
  quantity REAL DEFAULT 1,
  unit TEXT DEFAULT 'NOS',
  unit_price_paise INTEGER DEFAULT 0,
  tax_rate REAL DEFAULT 0,
  total_paise INTEGER DEFAULT 0,
  revision_no INTEGER DEFAULT 1,
  evidence_hash TEXT,
  state TEXT NOT NULL DEFAULT 'PROPOSED',
  priced_by INTEGER,
  priced_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_customer_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_addition_id INTEGER NOT NULL,
  addition_revision_no INTEGER NOT NULL,
  decision TEXT NOT NULL,
  method TEXT NOT NULL,
  approver_name TEXT NOT NULL,
  approver_contact_masked TEXT,
  evidence_text TEXT,
  evidence_attachment_id INTEGER,
  evidence_hash TEXT NOT NULL,
  recorded_by INTEGER,
  decided_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_customer_access_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  last_accessed_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS job_intake_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  request_token TEXT NOT NULL UNIQUE,
  request_number TEXT NOT NULL UNIQUE,
  client_request_id TEXT,
  source_channel TEXT NOT NULL DEFAULT 'QR',
  status TEXT NOT NULL DEFAULT 'SUBMITTED',
  party_id INTEGER,
  converted_job_id INTEGER,
  converted_by INTEGER,
  reviewed_by INTEGER,
  reviewed_at TEXT,
  converted_at TEXT,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  customer_address TEXT,
  preferred_contact TEXT DEFAULT 'PHONE',
  service_id INTEGER,
  service_name_snapshot TEXT,
  item_type TEXT DEFAULT '',
  item_name TEXT DEFAULT '',
  device_brand TEXT DEFAULT '',
  device_model TEXT DEFAULT '',
  device_serial TEXT DEFAULT '',
  quantity REAL DEFAULT 1,
  issue_summary TEXT NOT NULL,
  issue_details TEXT DEFAULT '',
  requested_delivery_at TEXT,
  consent_status TEXT NOT NULL DEFAULT 'PENDING',
  consent_text TEXT DEFAULT '',
  internal_notes TEXT DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  source_ip TEXT,
  source_user_agent TEXT,
  submitted_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_intake_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intake_request_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  byte_size INTEGER DEFAULT 0,
  sha256 TEXT,
  storage_path TEXT,
  content_base64 TEXT,
  pixel_width INTEGER,
  pixel_height INTEGER,
  pdf_page_count INTEGER,
  analysis_status TEXT NOT NULL DEFAULT 'PENDING',
  analysis_error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  retention_policy TEXT NOT NULL DEFAULT 'AUTO_DELETE',
  retention_state TEXT NOT NULL DEFAULT 'ACTIVE',
  retention_delete_after TEXT,
  archived_at TEXT,
  archived_by INTEGER,
  archive_reason TEXT,
  physical_deleted_at TEXT,
  physical_delete_reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attachment_analysis_jobs (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_intake_org_client_request
ON job_intake_requests(org_id, client_request_id)
WHERE client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_delivery_acknowledgements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL UNIQUE,
  receiver_name TEXT NOT NULL,
  receiver_contact_masked TEXT,
  method TEXT NOT NULL,
  evidence_text TEXT,
  warranty_notes TEXT DEFAULT '',
  service_notes TEXT DEFAULT '',
  outstanding_paise INTEGER DEFAULT 0,
  outstanding_terms TEXT DEFAULT '',
  acknowledged_at TEXT DEFAULT (datetime('now')),
  recorded_by INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_communication_consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  purpose TEXT NOT NULL,
  consent_status TEXT NOT NULL,
  source TEXT NOT NULL,
  evidence TEXT,
  recorded_by INTEGER,
  effective_at TEXT DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS job_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  party_id INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'WHATSAPP',
  assigned_staff_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'OPEN',
  external_ref TEXT,
  last_message_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS job_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'TEXT',
  template_code TEXT,
  body_text TEXT,
  workflow_intent TEXT DEFAULT 'INFORMATION',
  delivery_status TEXT NOT NULL DEFAULT 'QUEUED',
  external_message_ref TEXT,
  failure_reason TEXT,
  sender_user_id INTEGER,
  sent_at TEXT,
  delivered_at TEXT,
  read_at TEXT,
  received_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_internal_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  author_user_id INTEGER NOT NULL,
  note_type TEXT NOT NULL DEFAULT 'INSTRUCTION',
  note_text TEXT NOT NULL,
  file_names_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  org_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  actor_user_id INTEGER,
  actor_role TEXT,
  reason TEXT,
  old_data TEXT,
  new_data TEXT,
  operation_id TEXT,
  ip_address TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  applied_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS data_shift_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_app TEXT NOT NULL DEFAULT 'legacy-tarangini',
  source_version TEXT,
  source_instance TEXT,
  org_id INTEGER,
  shift_mode TEXT NOT NULL DEFAULT 'IMPORT',
  entity_scope TEXT NOT NULL DEFAULT 'MERGED_APP',
  status TEXT NOT NULL DEFAULT 'PLANNED',
  notes TEXT DEFAULT '',
  counts_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  completed_at TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS data_shift_entity_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  source_table TEXT,
  source_id TEXT NOT NULL,
  source_ref TEXT,
  target_table TEXT NOT NULL,
  target_id INTEGER,
  target_ref TEXT,
  resolution_status TEXT NOT NULL DEFAULT 'MAPPED',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(batch_id, entity_type, source_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_active_assignment
  ON job_assignments(job_id)
  WHERE status IN ('PENDING_ACCEPTANCE','ACCEPTED');
CREATE INDEX IF NOT EXISTS idx_job_orders_org_status
  ON job_orders(org_id,current_status,promised_delivery_at);
CREATE INDEX IF NOT EXISTS idx_job_orders_party ON job_orders(party_id,created_at);
CREATE INDEX IF NOT EXISTS idx_job_orders_final_bill ON job_orders(final_bill_id,delivered_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_orders_offline_id
  ON job_orders(offline_id) WHERE offline_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_intake_org_status
  ON job_intake_requests(org_id,status,submitted_at);
CREATE INDEX IF NOT EXISTS idx_job_intake_phone
  ON job_intake_requests(org_id,customer_phone,submitted_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_intake_client_request
  ON job_intake_requests(org_id,client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_intake_attachment_request
  ON job_intake_attachments(intake_request_id,created_at);
CREATE INDEX IF NOT EXISTS idx_job_attachments_job_visible ON job_attachments(job_id,visible_to_customer,id);
CREATE INDEX IF NOT EXISTS idx_job_attachments_sha ON job_attachments(sha256);
CREATE INDEX IF NOT EXISTS idx_job_attachments_origin ON job_attachments(upload_origin,created_at);
CREATE INDEX IF NOT EXISTS idx_job_attachments_retention ON job_attachments(retention_state,retention_delete_after);
CREATE INDEX IF NOT EXISTS idx_attachment_analysis_jobs_status
  ON attachment_analysis_jobs(status, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_job_status_events ON job_status_events(job_id,occurred_at);
CREATE INDEX IF NOT EXISTS idx_job_assignments_employee ON job_assignments(employee_id,status,assigned_at);
CREATE INDEX IF NOT EXISTS idx_operator_daily_logs_org_date
  ON operator_daily_logs(org_id,work_date,status,user_id);
CREATE INDEX IF NOT EXISTS idx_operator_log_entries_user_date
  ON operator_log_entries(org_id,user_id,work_date,created_at);
CREATE INDEX IF NOT EXISTS idx_job_materials_job ON job_material_consumptions(job_id,created_at);
CREATE INDEX IF NOT EXISTS idx_job_materials_item ON job_material_consumptions(item_id,created_at);
CREATE INDEX IF NOT EXISTS idx_job_audit ON job_audit_events(job_id,created_at);
CREATE INDEX IF NOT EXISTS idx_job_messages ON job_messages(conversation_id,created_at);
CREATE INDEX IF NOT EXISTS idx_job_customer_access ON job_customer_access_tokens(job_id,expires_at);
CREATE INDEX IF NOT EXISTS idx_job_customer_access_token_hash ON job_customer_access_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_job_conversations_external_ref ON job_conversations(external_ref);
CREATE INDEX IF NOT EXISTS idx_job_messages_external_ref ON job_messages(external_message_ref);
CREATE INDEX IF NOT EXISTS idx_job_internal_notes_job ON job_internal_notes(job_id,created_at,id);
CREATE INDEX IF NOT EXISTS idx_data_shift_batches_status ON data_shift_batches(status,created_at);
CREATE INDEX IF NOT EXISTS idx_data_shift_entity_lookup ON data_shift_entity_map(entity_type,source_id,target_id);
CREATE INDEX IF NOT EXISTS idx_parties_org_active_name ON parties(org_id,active,name);
CREATE INDEX IF NOT EXISTS idx_items_org_active_name ON items(org_id,active,name);
CREATE INDEX IF NOT EXISTS idx_job_orders_org_status_due ON job_orders(org_id,current_status,promised_delivery_at);
CREATE INDEX IF NOT EXISTS idx_job_intake_org_status_created ON job_intake_requests(org_id,status,created_at);

CREATE INDEX IF NOT EXISTS idx_bills_org_fy_date
  ON bills(org_id,fy,bill_date,deleted,status);
CREATE INDEX IF NOT EXISTS idx_bills_party_date
  ON bills(party_id,bill_date,deleted);
CREATE INDEX IF NOT EXISTS idx_bills_org_date_total
  ON bills(org_id,bill_date,grand_total);
CREATE INDEX IF NOT EXISTS idx_bills_org_party_total
  ON bills(org_id,party_id,grand_total);
CREATE INDEX IF NOT EXISTS idx_payments_org_fy_date
  ON payments(org_id,fy,payment_date,deleted);
CREATE INDEX IF NOT EXISTS idx_payments_party_date
  ON payments(party_id,payment_date,deleted);
CREATE INDEX IF NOT EXISTS idx_stock_org_item_date
  ON stock_movements(org_id,item_id,movement_date);
CREATE INDEX IF NOT EXISTS idx_journal_entries_org_fy_date
  ON journal_entries(org_id,fy,entry_date,deleted);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry
  ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp
  ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_active_expiry
  ON sessions(active,expires_at);
CREATE INDEX IF NOT EXISTS idx_backup_log_date
  ON backup_log(backup_date);
