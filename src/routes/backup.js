const express = require('express');
const router = express.Router();
const { get, run, all, saveDB } = require('../db/db');
const {
  authMiddleware, requirePermission, checkOrgAccess, canAccessOrg, requireAdminNetworkAccess
} = require('../middleware/auth');
const fs = require('fs');
const path = require('path');
const { rebuildAccounting } = require('../accounting/accounting');
const {
  createAutomaticBackup, backupDirectory, startAutomaticBackups, automaticBackupRecoveryKey,
  verifyAutomaticBackup, backupRetentionCount, backupStorageHealth
} = require('../services/automatic-backup');
const { getDBPath } = require('../db/db');
const { decryptAutomaticBackup } = require('../security/backup-crypto');
const {
  beginDataShiftBatch, recordDataShiftEntityMap, finishDataShiftBatch
} = require('../services/data-shift');
const { exportAttachmentRecord, importAttachmentRecord } = require('../services/attachment-storage');

router.use(authMiddleware);
router.use(checkOrgAccess);
router.use(requirePermission('backup'));

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function restoreDrillIntervalDays() {
  return Math.max(7, Math.min(365, Number(get('SELECT value FROM system_settings WHERE key=?', ['automatic_backup_restore_drill_days'])?.value || 90)));
}

function restoreDrillHealth(latest, intervalDays = restoreDrillIntervalDays()) {
  if (!latest || latest.status !== 'PASSED') {
    return { due: true, status: latest?.status || 'NOT_RUN', interval_days: intervalDays, days_since: null };
  }
  const performedAt = new Date(`${latest.performed_at}Z`).getTime();
  const daysSince = Number.isFinite(performedAt) ? Math.max(0, Math.floor((Date.now() - performedAt) / 86400000)) : null;
  return {
    due: daysSince === null || daysSince >= intervalDays,
    status: 'PASSED', interval_days: intervalDays, days_since: daysSince,
    next_due_in_days: daysSince === null ? 0 : Math.max(0, intervalDays - daysSince)
  };
}

function requireGlobalBackupOwner(req, res) {
  if (req.user.role === 'owner' && req.user.org_access === 'all') return true;
  res.status(403).json({ error: 'Global owner access is required for full-database restore drills' });
  return false;
}

function resolveUserId(userId, fallbackUserId) {
  const candidate = Number(userId || 0);
  if (candidate > 0 && get('SELECT id FROM users WHERE id=?', [candidate])) return candidate;
  return fallbackUserId || null;
}

function recordShiftMap(batchId, config) {
  if (!batchId) return;
  try {
    recordDataShiftEntityMap(config);
  } catch (_) {}
}

function mapJobEntityId(entityType, sourceEntityId, maps) {
  const rawId = Number(sourceEntityId || 0);
  if (!rawId) return null;
  switch (String(entityType || '').toUpperCase()) {
    case 'JOB':
      return maps.jobIdMap.get(rawId) || rawId;
    case 'JOB_ITEM':
      return maps.jobItemIdMap.get(rawId) || rawId;
    case 'ATTACHMENT':
      return maps.attachmentIdMap.get(rawId) || rawId;
    case 'ESTIMATE':
      return maps.estimateIdMap.get(rawId) || rawId;
    case 'ASSIGNMENT':
      return maps.assignmentIdMap.get(rawId) || rawId;
    case 'WORK_REPORT':
      return maps.workReportIdMap.get(rawId) || rawId;
    case 'ADDITION':
      return maps.additionIdMap.get(rawId) || rawId;
    case 'CONVERSATION':
      return maps.conversationIdMap.get(rawId) || rawId;
    case 'MESSAGE':
      return maps.messageIdMap.get(rawId) || rawId;
    case 'INTAKE':
      return maps.intakeIdMap.get(rawId) || rawId;
    default:
      return rawId;
  }
}

// Export backup for a financial year
router.get('/export', (req, res) => {
  const { org_id, fy } = req.query;
  if (!org_id && req.user.org_access !== 'all') {
    return res.status(400).json({ error: 'Select a company for this backup' });
  }
  if (org_id && !canAccessOrg(req.user, org_id)) {
    return res.status(403).json({ error: 'No access to this organization' });
  }

  try {
    const data = {
      version: '1.0.0',
      profile: 'merged-billing-workflow',
      exported_at: new Date().toISOString(),
      exported_by: req.user.name,
      org_id: org_id ? parseInt(org_id) : 'all',
      fy: fy || 'all',
      orgs: org_id ? all('SELECT * FROM orgs WHERE id=?', [org_id]) : all('SELECT * FROM orgs'),
      audit_log: org_id
        ? all('SELECT * FROM audit_log WHERE org_id=? ORDER BY id', [org_id])
        : all('SELECT * FROM audit_log ORDER BY id'),
      registered_devices: org_id
        ? all('SELECT * FROM registered_devices WHERE org_id=? ORDER BY id', [org_id])
        : all('SELECT * FROM registered_devices ORDER BY id'),
      sync_cursors: org_id
        ? all('SELECT * FROM sync_cursors WHERE org_id=? ORDER BY id', [org_id])
        : all('SELECT * FROM sync_cursors ORDER BY id'),
      sync_outbox: org_id
        ? all('SELECT * FROM sync_outbox WHERE org_id=? ORDER BY created_at,change_id', [org_id])
        : all('SELECT * FROM sync_outbox ORDER BY created_at,change_id'),
      sync_conflicts: org_id
        ? all('SELECT * FROM sync_conflicts WHERE org_id=? ORDER BY id', [org_id])
        : all('SELECT * FROM sync_conflicts ORDER BY id'),
      sync_replay: org_id
        ? all('SELECT * FROM sync_replay WHERE org_id=? ORDER BY id', [org_id])
        : all('SELECT * FROM sync_replay ORDER BY id'),
      offline_financial_drafts: org_id
        ? all('SELECT * FROM offline_financial_drafts WHERE org_id=? ORDER BY id', [org_id])
        : all('SELECT * FROM offline_financial_drafts ORDER BY id'),
      parties: org_id ? all('SELECT * FROM parties WHERE org_id=?', [org_id]) : all('SELECT * FROM parties'),
      party_org_links: org_id
        ? all('SELECT * FROM party_org_links WHERE org_id=?', [org_id])
        : all('SELECT * FROM party_org_links'),
      party_addresses: org_id
        ? all('SELECT * FROM party_addresses WHERE org_id=?', [org_id])
        : all('SELECT * FROM party_addresses'),
      items: org_id ? all('SELECT * FROM items WHERE org_id=?', [org_id]) : all('SELECT * FROM items'),
      item_categories: org_id ? all('SELECT * FROM item_categories WHERE org_id=?', [org_id]) : all('SELECT * FROM item_categories'),
      bill_sequences: (() => {
        let sql = 'SELECT * FROM bill_sequences';
        const p = [];
        if (org_id) { sql += ' WHERE org_id=?'; p.push(org_id); }
        if (fy) { sql += org_id ? ' AND fy=?' : ' WHERE fy=?'; p.push(fy); }
        return all(sql, p);
      })(),
      bills: (() => {
        let sql = 'SELECT * FROM bills WHERE deleted=0';
        const p = [];
        if (org_id) { sql += ' AND org_id=?'; p.push(org_id); }
        if (fy) { sql += ' AND fy=?'; p.push(fy); }
        return all(sql, p);
      })(),
      payments: (() => {
        let sql = 'SELECT * FROM payments WHERE deleted=0';
        const p = [];
        if (org_id) { sql += ' AND org_id=?'; p.push(org_id); }
        if (fy) { sql += ' AND fy=?'; p.push(fy); }
        return all(sql, p);
      })(),
      purchases: org_id ? all('SELECT * FROM purchases WHERE org_id=? AND deleted=0', [org_id]) : all('SELECT * FROM purchases WHERE deleted=0'),
      expenses: org_id ? all('SELECT * FROM expenses WHERE org_id=? AND deleted=0', [org_id]) : all('SELECT * FROM expenses WHERE deleted=0'),
      credit_debit_notes: org_id ? all('SELECT * FROM credit_debit_notes WHERE org_id=? AND deleted=0', [org_id]) : all('SELECT * FROM credit_debit_notes WHERE deleted=0'),
      stock_movements: org_id ? all('SELECT * FROM stock_movements WHERE org_id=?', [org_id]) : all('SELECT * FROM stock_movements'),
      warranty_replacements: org_id
        ? all('SELECT * FROM warranty_replacements WHERE org_id=?', [org_id])
        : all('SELECT * FROM warranty_replacements'),
      warranty_service_centers: org_id
        ? all('SELECT * FROM warranty_service_centers WHERE org_id=?', [org_id])
        : all('SELECT * FROM warranty_service_centers'),
      payment_allocations: org_id
        ? all(`SELECT pa.* FROM payment_allocations pa
               JOIN payments p ON p.id=pa.payment_id
               JOIN bills b ON b.id=pa.bill_id
               WHERE p.org_id=? AND b.org_id=?`, [org_id, org_id])
        : all('SELECT * FROM payment_allocations'),
      financial_year_locks: org_id ? all('SELECT * FROM financial_year_locks WHERE org_id=?', [org_id]) : all('SELECT * FROM financial_year_locks'),
      pos_shifts: org_id ? all('SELECT * FROM pos_shifts WHERE org_id=?', [org_id]) : all('SELECT * FROM pos_shifts'),
      held_bills: org_id ? all('SELECT * FROM held_bills WHERE org_id=?', [org_id]) : all('SELECT * FROM held_bills'),
      purchase_orders: org_id ? all('SELECT * FROM purchase_orders WHERE org_id=?', [org_id]) : all('SELECT * FROM purchase_orders'),
      scheduled_reports: org_id ? all('SELECT * FROM scheduled_reports WHERE org_id=?', [org_id]) : all('SELECT * FROM scheduled_reports'),
      bank_reconciliation: org_id ? all('SELECT * FROM bank_reconciliation WHERE org_id=?', [org_id]) : all('SELECT * FROM bank_reconciliation'),
      bank_statement_imports: org_id ? all('SELECT * FROM bank_statement_imports WHERE org_id=?', [org_id]) : all('SELECT * FROM bank_statement_imports'),
      bank_statement_rows: org_id ? all('SELECT * FROM bank_statement_rows WHERE org_id=?', [org_id]) : all('SELECT * FROM bank_statement_rows'),
      gstr2b_imports: org_id ? all('SELECT * FROM gstr2b_imports WHERE org_id=?', [org_id]) : all('SELECT * FROM gstr2b_imports'),
      gstr2b_rows: org_id ? all('SELECT * FROM gstr2b_rows WHERE org_id=?', [org_id]) : all('SELECT * FROM gstr2b_rows'),
      invoice_correction_requests: org_id
        ? all('SELECT * FROM invoice_correction_requests WHERE org_id=?', [org_id])
        : all('SELECT * FROM invoice_correction_requests'),
      transaction_control_settings: org_id
        ? all('SELECT * FROM transaction_control_settings WHERE org_id=?', [org_id])
        : all('SELECT * FROM transaction_control_settings'),
      accounts: org_id ? all('SELECT * FROM accounts WHERE org_id=?', [org_id]) : all('SELECT * FROM accounts'),
      journal_entries: (() => {
        let sql = 'SELECT * FROM journal_entries WHERE deleted=0';
        const p = [];
        if (org_id) { sql += ' AND org_id=?'; p.push(org_id); }
        if (fy) { sql += ' AND fy=?'; p.push(fy); }
        return all(sql, p);
      })(),
      journal_lines: (() => {
        let sql = `SELECT jl.* FROM journal_lines jl
          JOIN journal_entries je ON je.id=jl.entry_id WHERE je.deleted=0`;
        const p = [];
        if (org_id) { sql += ' AND je.org_id=?'; p.push(org_id); }
        if (fy) { sql += ' AND je.fy=?'; p.push(fy); }
        return all(sql, p);
      })(),
      system_settings: all('SELECT * FROM system_settings'),
      job_service_categories: org_id
        ? all('SELECT * FROM job_service_categories WHERE org_id=? ORDER BY id', [org_id])
        : all('SELECT * FROM job_service_categories ORDER BY id'),
      job_service_subcategories: org_id
        ? all('SELECT * FROM job_service_subcategories WHERE org_id=? ORDER BY id', [org_id])
        : all('SELECT * FROM job_service_subcategories ORDER BY id'),
      job_services: org_id
        ? all('SELECT * FROM job_services WHERE org_id=? ORDER BY id', [org_id])
        : all('SELECT * FROM job_services ORDER BY id'),
      job_sequences: (() => {
        let sql = 'SELECT * FROM job_sequences';
        const p = [];
        if (org_id) { sql += ' WHERE org_id=?'; p.push(org_id); }
        return all(sql, p);
      })(),
      job_orders: org_id
        ? all('SELECT * FROM job_orders WHERE org_id=? ORDER BY id', [org_id])
        : all('SELECT * FROM job_orders ORDER BY id'),
      job_items: org_id
        ? all(`SELECT ji.* FROM job_items ji
               JOIN job_orders jo ON jo.id=ji.job_id
               WHERE jo.org_id=? ORDER BY ji.id`, [org_id])
        : all(`SELECT ji.* FROM job_items ji
               JOIN job_orders jo ON jo.id=ji.job_id
               ORDER BY ji.id`),
      job_estimates: org_id
        ? all(`SELECT je.* FROM job_estimates je
               JOIN job_orders jo ON jo.id=je.job_id
               WHERE jo.org_id=? ORDER BY je.id`, [org_id])
        : all(`SELECT je.* FROM job_estimates je
               JOIN job_orders jo ON jo.id=je.job_id
               ORDER BY je.id`),
      job_assignments: org_id
        ? all(`SELECT ja.* FROM job_assignments ja
               JOIN job_orders jo ON jo.id=ja.job_id
               WHERE jo.org_id=? ORDER BY ja.id`, [org_id])
        : all(`SELECT ja.* FROM job_assignments ja
               JOIN job_orders jo ON jo.id=ja.job_id
               ORDER BY ja.id`),
      job_status_events: org_id
        ? all(`SELECT jse.* FROM job_status_events jse
               JOIN job_orders jo ON jo.id=jse.job_id
               WHERE jo.org_id=? ORDER BY jse.id`, [org_id])
        : all(`SELECT jse.* FROM job_status_events jse
               JOIN job_orders jo ON jo.id=jse.job_id
               ORDER BY jse.id`),
      job_work_reports: org_id
        ? all(`SELECT jwr.* FROM job_work_reports jwr
               JOIN job_orders jo ON jo.id=jwr.job_id
               WHERE jo.org_id=? ORDER BY jwr.id`, [org_id])
        : all(`SELECT jwr.* FROM job_work_reports jwr
               JOIN job_orders jo ON jo.id=jwr.job_id
               ORDER BY jwr.id`),
      operator_daily_logs: org_id
        ? all('SELECT * FROM operator_daily_logs WHERE org_id=? ORDER BY id', [org_id])
        : all('SELECT * FROM operator_daily_logs ORDER BY id'),
      operator_log_entries: org_id
        ? all('SELECT * FROM operator_log_entries WHERE org_id=? ORDER BY id', [org_id])
        : all('SELECT * FROM operator_log_entries ORDER BY id'),
      job_material_consumptions: org_id
        ? all(`SELECT jmc.* FROM job_material_consumptions jmc
               JOIN job_orders jo ON jo.id=jmc.job_id
               WHERE jo.org_id=? ORDER BY jmc.id`, [org_id])
        : all(`SELECT jmc.* FROM job_material_consumptions jmc
               JOIN job_orders jo ON jo.id=jmc.job_id
               ORDER BY jmc.id`),
      job_additions: org_id
        ? all(`SELECT ja.* FROM job_additions ja
               JOIN job_orders jo ON jo.id=ja.job_id
               WHERE jo.org_id=? ORDER BY ja.id`, [org_id])
        : all(`SELECT ja.* FROM job_additions ja
               JOIN job_orders jo ON jo.id=ja.job_id
               ORDER BY ja.id`),
      job_attachments: (org_id
        ? all(`SELECT ja.* FROM job_attachments ja
               JOIN job_orders jo ON jo.id=ja.job_id
               WHERE jo.org_id=? ORDER BY ja.id`, [org_id])
        : all(`SELECT ja.* FROM job_attachments ja
               JOIN job_orders jo ON jo.id=ja.job_id
               ORDER BY ja.id`)).map(exportAttachmentRecord),
      job_customer_approvals: org_id
        ? all(`SELECT jca.* FROM job_customer_approvals jca
               JOIN job_additions jad ON jad.id=jca.job_addition_id
               JOIN job_orders jo ON jo.id=jad.job_id
               WHERE jo.org_id=? ORDER BY jca.id`, [org_id])
        : all(`SELECT jca.* FROM job_customer_approvals jca
               JOIN job_additions jad ON jad.id=jca.job_addition_id
               JOIN job_orders jo ON jo.id=jad.job_id
               ORDER BY jca.id`),
      job_customer_access_tokens: org_id
        ? all(`SELECT jcat.* FROM job_customer_access_tokens jcat
               JOIN job_orders jo ON jo.id=jcat.job_id
               WHERE jo.org_id=? ORDER BY jcat.id`, [org_id])
        : all(`SELECT jcat.* FROM job_customer_access_tokens jcat
               JOIN job_orders jo ON jo.id=jcat.job_id
               ORDER BY jcat.id`),
      job_intake_requests: org_id
        ? all('SELECT * FROM job_intake_requests WHERE org_id=? ORDER BY id', [org_id])
        : all('SELECT * FROM job_intake_requests ORDER BY id'),
      job_intake_attachments: (org_id
        ? all(`SELECT jia.* FROM job_intake_attachments jia
               JOIN job_intake_requests jir ON jir.id=jia.intake_request_id
               WHERE jir.org_id=? ORDER BY jia.id`, [org_id])
        : all(`SELECT jia.* FROM job_intake_attachments jia
               JOIN job_intake_requests jir ON jir.id=jia.intake_request_id
               ORDER BY jia.id`)).map(exportAttachmentRecord),
      job_delivery_acknowledgements: org_id
        ? all(`SELECT jda.* FROM job_delivery_acknowledgements jda
               JOIN job_orders jo ON jo.id=jda.job_id
               WHERE jo.org_id=? ORDER BY jda.id`, [org_id])
        : all(`SELECT jda.* FROM job_delivery_acknowledgements jda
               JOIN job_orders jo ON jo.id=jda.job_id
               ORDER BY jda.id`),
      job_communication_consents: org_id
        ? all(`SELECT jcc.* FROM job_communication_consents jcc
               JOIN parties p ON p.id=jcc.party_id
               WHERE p.org_id=? ORDER BY jcc.id`, [org_id])
        : all(`SELECT jcc.* FROM job_communication_consents jcc
               JOIN parties p ON p.id=jcc.party_id
               ORDER BY jcc.id`),
      job_conversations: org_id
        ? all(`SELECT jc.* FROM job_conversations jc
               JOIN job_orders jo ON jo.id=jc.job_id
               WHERE jo.org_id=? ORDER BY jc.id`, [org_id])
        : all(`SELECT jc.* FROM job_conversations jc
               JOIN job_orders jo ON jo.id=jc.job_id
               ORDER BY jc.id`),
      job_messages: org_id
        ? all(`SELECT jm.* FROM job_messages jm
               JOIN job_conversations jc ON jc.id=jm.conversation_id
               JOIN job_orders jo ON jo.id=jc.job_id
               WHERE jo.org_id=? ORDER BY jm.id`, [org_id])
        : all(`SELECT jm.* FROM job_messages jm
               JOIN job_conversations jc ON jc.id=jm.conversation_id
               JOIN job_orders jo ON jo.id=jc.job_id
               ORDER BY jm.id`),
      job_internal_notes: org_id
        ? all('SELECT * FROM job_internal_notes WHERE org_id=? ORDER BY id', [org_id])
        : all('SELECT * FROM job_internal_notes ORDER BY id'),
      job_audit_events: org_id
        ? all('SELECT * FROM job_audit_events WHERE org_id=? ORDER BY id', [org_id])
        : all('SELECT * FROM job_audit_events ORDER BY id')
    };

    const json = JSON.stringify(data);
    const orgName = org_id ? (data.orgs[0]?.display_name || 'org') : 'all-orgs';
    const fileName = `tarangini-backup-${orgName.replace(/\s+/g,'-')}-${fy || 'all'}-${Date.now()}.json`;

    // Log backup
    run('INSERT INTO backup_log (org_id,fy,file_name,created_by) VALUES (?,?,?,?)',
      [org_id || null, fy || 'all', fileName, req.user.id]);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(json);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Import backup
router.post('/import', requireAdminNetworkAccess, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  if (req.user.org_access !== 'all') {
    return res.status(403).json({ error: 'Full company access is required to restore a backup' });
  }

  let shiftBatchId = null;
  try {
    const data = req.body;
    if (!data.version || !data.orgs) return res.status(400).json({ error: 'Invalid backup file' });

    shiftBatchId = beginDataShiftBatch({
      sourceApp: String(data.profile || 'tarangini-backup'),
      sourceVersion: String(data.version || ''),
      sourceInstance: String(data.exported_at || ''),
      orgId: Number(data.org_id) || null,
      shiftMode: 'IMPORT',
      entityScope: data.org_id === 'all' ? 'FULL_BACKUP' : 'ORG_BACKUP',
      notes: `Backup import requested by ${req.user.name}`,
      createdBy: req.user.id
    });

    let imported = {
      orgs: 0, parties: 0, party_org_links: 0, party_addresses: 0, items: 0,
      bills: 0, payments: 0, purchases: 0, expenses: 0, credit_debit_notes: 0,
      stock_movements: 0, warranty_replacements: 0, warranty_service_centers: 0, purchase_orders: 0,
      financial_year_locks: 0, bank_statement_imports: 0, bank_statement_rows: 0,
      bank_reconciliation: 0, gstr2b_imports: 0, gstr2b_rows: 0, journals: 0,
      job_service_categories: 0, job_service_subcategories: 0, job_services: 0,
      jobs: 0, job_items: 0, job_estimates: 0, job_assignments: 0, job_status_events: 0,
      job_work_reports: 0, operator_daily_logs: 0, operator_log_entries: 0,
      job_material_consumptions: 0, job_additions: 0, job_attachments: 0, job_customer_approvals: 0,
      job_customer_access_tokens: 0, job_intake_requests: 0, job_intake_attachments: 0,
      job_delivery_acknowledgements: 0,
      job_communication_consents: 0, job_conversations: 0, job_messages: 0, job_internal_notes: 0,
      job_audit_events: 0, audit_log: 0, offline_financial_drafts: 0,
      registered_devices: 0, sync_cursors: 0, sync_outbox: 0, sync_conflicts: 0, sync_replay: 0
    };
    const orgIdMap = new Map();
    const categoryIdMap = new Map();
    const partyIdMap = new Map();
    const itemIdMap = new Map();
    const billIdMap = new Map();
    const paymentIdMap = new Map();
    const purchaseIdMap = new Map();
    const expenseIdMap = new Map();
    const purchaseOrderIdMap = new Map();
    const noteIdMap = new Map();
    const gstr2bImportIdMap = new Map();
    const bankImportIdMap = new Map();
    const journalEntryIdMap = new Map();
    const journalLineIdMap = new Map();
    const jobCategoryIdMap = new Map();
    const jobSubcategoryIdMap = new Map();
    const jobServiceIdMap = new Map();
    const jobIdMap = new Map();
    const intakeIdMap = new Map();
    const jobItemIdMap = new Map();
    const estimateIdMap = new Map();
    const assignmentIdMap = new Map();
    const workReportIdMap = new Map();
    const operatorDailyLogIdMap = new Map();
    const additionIdMap = new Map();
    const attachmentIdMap = new Map();
    const conversationIdMap = new Map();
    const messageIdMap = new Map();

    (data.orgs || []).forEach(org => {
      let local = get('SELECT id FROM orgs WHERE display_name=?', [org.display_name]);
      if (!local) {
        try {
          const result = run(
            `INSERT INTO orgs
             (display_name,registered_name,address,phone,email,gstin,gst_type,bank_name,account_no,branch,
              ifsc,upi_id,logo_base64,note_header,note_footer,quotation_fixed_note,delivery_challan_fixed_note,
              proforma_fixed_note,invoice_description,project_bw_rate,
              project_colour_rate,project_book_rate,signature_name,signature_image,invoice_qr_enabled,
              negative_stock_allowed,default_tax_inclusive,invoice_prefixes,invoice_theme,invoice_print_options,active,created_at)
             VALUES (${Array.from({ length: 32 }, () => '?').join(',')})`,
            [org.display_name, org.registered_name, org.address, org.phone, org.email, org.gstin,
             org.gst_type || 'regular', org.bank_name, org.account_no, org.branch, org.ifsc, org.upi_id,
             org.logo_base64, org.note_header || '', org.note_footer || '', org.quotation_fixed_note || '',
             org.delivery_challan_fixed_note || '', org.proforma_fixed_note || '', org.invoice_description || '',
             org.project_bw_rate || 0, org.project_colour_rate || 0, org.project_book_rate || 0,
             org.signature_name, org.signature_image, org.invoice_qr_enabled ?? 1,
             org.negative_stock_allowed ?? 1, org.default_tax_inclusive ?? 0,
             org.invoice_prefixes || '{}', org.invoice_theme || 'classic', org.invoice_print_options || '{}', org.active ?? 1,
             org.created_at || new Date().toISOString()]
          );
          local = { id: result.lastInsertRowid };
          imported.orgs++;
        } catch (_) {}
      }
      if (local) orgIdMap.set(org.id, local.id);
      recordShiftMap(shiftBatchId, {
        batchId: shiftBatchId,
        entityType: 'ORG',
        sourceTable: 'orgs',
        sourceId: org.id,
        sourceRef: org.display_name,
        targetTable: 'orgs',
        targetId: local?.id || null,
        targetRef: org.display_name
      });
    });

    (data.audit_log || []).forEach(entry => {
      const orgId = entry.org_id ? orgIdMap.get(entry.org_id) : null;
      if (entry.org_id && !orgId) return;
      const duplicate = get(
        `SELECT id FROM audit_log WHERE action=? AND table_name=? AND record_id IS ? AND timestamp=? AND org_id IS ?`,
        [entry.action || '', entry.table_name || '', entry.record_id ?? null, entry.timestamp, orgId]
      );
      if (duplicate) return;
      run(
        `INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,old_data,new_data,ip_address,timestamp)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [resolveUserId(entry.user_id, req.user.id), orgId, entry.action || '', entry.table_name || '', entry.record_id ?? null,
         entry.old_data || null, entry.new_data || null, entry.ip_address || null, entry.timestamp || new Date().toISOString()]
      );
      imported.audit_log++;
    });

    (data.registered_devices || []).forEach(device => {
      const orgId = orgIdMap.get(device.org_id);
      if (!orgId || !device.device_id) return;
      run(`INSERT INTO registered_devices
        (org_id,device_id,device_name,assigned_to,fingerprint,mac_references,status,registered_by,registered_at,
         revoked_by,revoked_at,wipe_requested_at,wipe_acknowledged_at,wipe_reason,last_sync_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(org_id,device_id) DO UPDATE SET
          device_name=excluded.device_name,assigned_to=excluded.assigned_to,fingerprint=excluded.fingerprint,
          mac_references=excluded.mac_references,status=excluded.status,registered_at=excluded.registered_at,
          revoked_at=excluded.revoked_at,wipe_requested_at=excluded.wipe_requested_at,
          wipe_acknowledged_at=excluded.wipe_acknowledged_at,wipe_reason=excluded.wipe_reason,last_sync_at=excluded.last_sync_at`,
      [orgId, device.device_id, device.device_name || '', device.assigned_to || '', device.fingerprint || '',
       device.mac_references || '[]', device.status === 'revoked' ? 'revoked' : 'active',
       resolveUserId(device.registered_by, req.user.id), device.registered_at || new Date().toISOString(),
       resolveUserId(device.revoked_by, null), device.revoked_at || null, device.wipe_requested_at || null,
       device.wipe_acknowledged_at || null, device.wipe_reason || '', device.last_sync_at || null]);
      imported.registered_devices++;
    });

    (data.sync_cursors || []).forEach(cursor => {
      const orgId = orgIdMap.get(cursor.org_id);
      if (!orgId || !cursor.device_id) return;
      run(`INSERT INTO sync_cursors (org_id,device_id,last_pulled_revision,last_pushed_at,updated_at)
        VALUES (?,?,0,?,?) ON CONFLICT(org_id,device_id) DO UPDATE SET
          last_pulled_revision=0,last_pushed_at=excluded.last_pushed_at,updated_at=excluded.updated_at`,
      [orgId, cursor.device_id, cursor.last_pushed_at || null, new Date().toISOString()]);
      imported.sync_cursors++;
    });

    (data.sync_outbox || []).forEach(change => {
      const orgId = orgIdMap.get(change.org_id);
      if (!orgId || !change.change_id || get('SELECT change_id FROM sync_outbox WHERE change_id=?', [change.change_id])) return;
      run(`INSERT INTO sync_outbox
        (change_id,org_id,device_id,entity_type,entity_id,operation,base_version,payload,created_by,created_at,status,error,synced_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [change.change_id, orgId, change.device_id || '', change.entity_type || '', change.entity_id || '',
       change.operation || 'INSERT', change.base_version ?? null, change.payload || '{}',
       resolveUserId(change.created_by, req.user.id), change.created_at || new Date().toISOString(),
       change.status || 'pending', change.error || null, change.synced_at || null]);
      imported.sync_outbox++;
    });

    (data.sync_conflicts || []).forEach(conflict => {
      const orgId = orgIdMap.get(conflict.org_id);
      if (!orgId || !conflict.change_id) return;
      const duplicate = get(`SELECT id FROM sync_conflicts
        WHERE org_id=? AND change_id=? AND entity_type=? AND entity_id=?`,
      [orgId, conflict.change_id, conflict.entity_type || '', conflict.entity_id || '']);
      if (duplicate) return;
      run(`INSERT INTO sync_conflicts
        (change_id,org_id,entity_type,entity_id,main_snapshot,incoming_snapshot,status,resolved_by,
         resolution_reason,resolved_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [conflict.change_id, orgId, conflict.entity_type || '', conflict.entity_id || '',
       conflict.main_snapshot || '{}', conflict.incoming_snapshot || '{}', conflict.status || 'pending',
       resolveUserId(conflict.resolved_by, null), conflict.resolution_reason || null,
       conflict.resolved_at || null, conflict.created_at || new Date().toISOString()]);
      imported.sync_conflicts++;
    });

    (data.sync_replay || []).forEach(replay => {
      const orgId = orgIdMap.get(replay.org_id);
      if (!orgId || !replay.conflict_id || get('SELECT id FROM sync_replay WHERE conflict_id=?', [replay.conflict_id])) return;
      const conflict = get('SELECT id,change_id,entity_type,entity_id FROM sync_conflicts WHERE org_id=? AND change_id=?',
        [orgId, replay.change_id || '']);
      if (!conflict) return;
      run(`INSERT INTO sync_replay
        (conflict_id,change_id,org_id,entity_type,entity_id,replay_reference,reason,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      [conflict.id, conflict.change_id, orgId, conflict.entity_type, conflict.entity_id,
       replay.replay_reference || 'IMPORTED-REPLAY', replay.reason || 'Imported replay record',
       resolveUserId(replay.created_by, null), replay.created_at || new Date().toISOString()]);
      imported.sync_replay++;
    });

    (data.offline_financial_drafts || []).forEach(draft => {
      const orgId = orgIdMap.get(draft.org_id);
      if (!orgId || !draft.draft_id) return;
      const existing = get('SELECT id FROM offline_financial_drafts WHERE draft_id=?', [draft.draft_id]);
      if (existing) return;
      const state = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'POSTED'].includes(draft.state)
        ? draft.state : 'SUBMITTED';
      run(`INSERT INTO offline_financial_drafts
        (draft_id,org_id,device_id,entity_type,provisional_number,payload,state,base_version,created_by,
         submitted_at,reviewed_by,reviewed_at,review_reason,posted_entity_id,posted_number,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [draft.draft_id, orgId, draft.device_id || '', draft.entity_type || 'UNKNOWN', draft.provisional_number || '',
       draft.payload || '{}', state, draft.base_version ?? null, resolveUserId(draft.created_by, req.user.id),
       draft.submitted_at || null, resolveUserId(draft.reviewed_by, null), draft.reviewed_at || null,
       draft.review_reason || '', draft.posted_entity_id ?? null, draft.posted_number || '',
       draft.created_at || new Date().toISOString(), draft.updated_at || new Date().toISOString()]);
      imported.offline_financial_drafts++;
    });

    (data.transaction_control_settings || []).forEach(row => {
      const orgId = orgIdMap.get(row.org_id);
      if (!orgId || !row.transaction_type) return;
      try {
        run(`INSERT INTO transaction_control_settings
          (org_id,transaction_type,form_options,required_fields,print_options,updated_by,updated_at)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(org_id,transaction_type) DO UPDATE SET
            form_options=excluded.form_options,
            required_fields=excluded.required_fields,
            print_options=excluded.print_options,
            updated_by=excluded.updated_by,
            updated_at=excluded.updated_at`,
          [orgId, row.transaction_type, row.form_options || '{}', row.required_fields || '{}',
           row.print_options || '{}', row.updated_by || req.user.id,
           row.updated_at || new Date().toISOString()]
        );
      } catch (_) {}
    });

    (data.item_categories || []).forEach(category => {
      const orgId = orgIdMap.get(category.org_id);
      if (!orgId) return;
      let local = get('SELECT id FROM item_categories WHERE org_id=? AND name=?', [orgId, category.name]);
      if (!local) {
        try {
          const result = run(
            'INSERT INTO item_categories (org_id,name,hsn_code,created_at) VALUES (?,?,?,?)',
            [orgId, category.name, category.hsn_code, category.created_at || new Date().toISOString()]
          );
          local = { id: result.lastInsertRowid };
        } catch (_) {}
      }
      if (local) categoryIdMap.set(category.id, local.id);
    });

    // Import parties (skip if exists by name+org)
    (data.parties || []).forEach(p => {
      const orgId = orgIdMap.get(p.org_id);
      if (!orgId) return;
      const exists = get('SELECT id FROM parties WHERE org_id=? AND name=?', [orgId, p.name]);
      if (exists) {
        partyIdMap.set(p.id, exists.id);
      } else {
        try {
          const result = run(`INSERT INTO parties (org_id,shared,type,name,registered_name,phone,email,address,city,state,pincode,gstin,gst_type,delivery_addresses,digital_signature_required,opening_balance,balance_type,active)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [orgId, p.shared||0, p.type||'both', p.name, p.registered_name, p.phone, p.email,
             p.address, p.city, p.state, p.pincode, p.gstin, p.gst_type, p.delivery_addresses||'[]',
             p.digital_signature_required ? 1 : 0, p.opening_balance||0, p.balance_type||'cr', p.active||1]);
          partyIdMap.set(p.id, result.lastInsertRowid);
          imported.parties++;
        } catch(e) {}
      }
      recordShiftMap(shiftBatchId, {
        batchId: shiftBatchId,
        entityType: 'PARTY',
        sourceTable: 'parties',
        sourceId: p.id,
        sourceRef: p.name,
        targetTable: 'parties',
        targetId: partyIdMap.get(p.id) || null,
        targetRef: p.name
      });
    });

    // Import items
    (data.party_org_links || []).forEach(link => {
      const partyId = partyIdMap.get(link.party_id);
      const orgId = orgIdMap.get(link.org_id);
      if (!partyId || !orgId) return;
      try {
        run('INSERT OR IGNORE INTO party_org_links (party_id,org_id) VALUES (?,?)', [partyId, orgId]);
        imported.party_org_links++;
      } catch (_) {}
    });

    (data.party_addresses || []).forEach(address => {
      const partyId = partyIdMap.get(address.party_id);
      const orgId = orgIdMap.get(address.org_id);
      if (!partyId || !orgId) return;
      const exists = get(
        `SELECT id FROM party_addresses
         WHERE party_id=? AND label=? AND COALESCE(address,'')=COALESCE(?, '') AND active=?`,
        [partyId, address.label, address.address || '', address.active ?? 1]
      );
      if (exists) return;
      try {
        run(
          `INSERT INTO party_addresses
           (party_id,org_id,label,address_type,contact_person,phone,email,address,city,district,state,pincode,gstin,
            is_default_billing,is_default_delivery,active,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            partyId, orgId, address.label || 'Main Address', address.address_type || 'billing_delivery',
            address.contact_person || null, address.phone || null, address.email || null,
            address.address || '', address.city || null, address.district || null,
            address.state || 'Andhra Pradesh', address.pincode || null, address.gstin || null,
            address.is_default_billing ? 1 : 0, address.is_default_delivery ? 1 : 0,
            address.active ?? 1, address.created_at || new Date().toISOString(),
            address.updated_at || address.created_at || new Date().toISOString()
          ]
        );
        imported.party_addresses++;
      } catch (_) {}
    });

    // Import items
    (data.items || []).forEach(item => {
      const orgId = orgIdMap.get(item.org_id);
      if (!orgId) return;
      const exists = get('SELECT id FROM items WHERE org_id=? AND name=?', [orgId, item.name]);
      if (exists) {
        itemIdMap.set(item.id, exists.id);
      } else {
        try {
          const result = run(`INSERT INTO items
              (org_id,category_id,name,hsn_code,unit,gst_rate,last_sale_price,last_purchase_price,
               description,item_code,model_number,mrp,barcode,opening_stock,reorder_level,active,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [orgId, categoryIdMap.get(item.category_id) || null, item.name, item.hsn_code, item.unit, item.gst_rate,
             item.last_sale_price||0, item.last_purchase_price||0, item.description||'',
             item.item_code || null, item.model_number || '', item.mrp || 0, item.barcode || null,
             item.opening_stock || 0, item.reorder_level || 0, item.active ?? 1,
             item.created_at || new Date().toISOString()]);
          itemIdMap.set(item.id, result.lastInsertRowid);
          imported.items++;
        } catch(e) {}
      }
      recordShiftMap(shiftBatchId, {
        batchId: shiftBatchId,
        entityType: 'ITEM',
        sourceTable: 'items',
        sourceId: item.id,
        sourceRef: item.item_code || item.name,
        targetTable: 'items',
        targetId: itemIdMap.get(item.id) || null,
        targetRef: item.item_code || item.name
      });
    });

    // Import bills (skip if bill_number exists)
    (data.bills || []).forEach(b => {
      const orgId = orgIdMap.get(b.org_id);
      if (!orgId) return;
      const exists = get('SELECT id FROM bills WHERE bill_number=? AND org_id=?', [b.bill_number, orgId]);
      if (exists) {
        billIdMap.set(b.id, exists.id);
      } else {
        try {
          const remappedItems = JSON.parse(b.items_json || '[]').map(row => ({
            ...row,
            item_id: itemIdMap.get(row.item_id) || row.item_id || null
          }));
          const result = run(`INSERT INTO bills
              (org_id,format,bill_number,bill_date,fy,party_id,party_snapshot,delivery_address,delivery_info,
               po_number,po_date,credit_days,due_date,payment_mode,items_json,subtotal,discount,taxable_amount,
               tax_rate,cgst,sgst,igst,total_tax,grand_total,round_off,total_in_words,note_header,note_footer,description,
               swipe_charge,custom_data,split_payments,cost_total,shift_id,return_of,bank_details,status,
               converted_to,converted_from,offline_id,offline_device,offline_created_at,tax_inclusive,
               digital_signature_required,digital_signature_note,digital_signature_status,digital_signature_signed_at,
               digital_signature_signed_by,created_by,edited_by,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [orgId, b.format, b.bill_number, b.bill_date, b.fy, partyIdMap.get(b.party_id) || null, b.party_snapshot,
             b.delivery_address || null, b.delivery_info || '{}', b.po_number || null, b.po_date || null,
             b.credit_days || 0, b.due_date || null, b.payment_mode||'cash', JSON.stringify(remappedItems),
             b.subtotal, b.discount||0, b.taxable_amount, b.tax_rate, b.cgst, b.sgst, b.igst || 0,
             b.total_tax, b.grand_total, b.round_off || 0, b.total_in_words, b.note_header || '', b.note_footer || '',
             b.description || '', b.swipe_charge || 0, b.custom_data || '{}', b.split_payments || '[]',
             b.cost_total || 0, b.shift_id || null, b.return_of || null, b.bank_details, b.status||'saved',
             b.converted_to || null, b.converted_from || null, b.offline_id||null, b.offline_device||null,
             b.offline_created_at||null, b.tax_inclusive ? 1 : 0,
             b.digital_signature_required ? 1 : 0, b.digital_signature_note || '',
             b.digital_signature_status || (b.digital_signature_required ? 'pending' : 'not_required'),
             b.digital_signature_signed_at || null, b.digital_signature_signed_by || null, b.created_by || req.user.id,
             b.edited_by || null, b.created_at || new Date().toISOString(),
             b.updated_at || b.created_at || new Date().toISOString()]);
          billIdMap.set(b.id, result.lastInsertRowid);
          imported.bills++;
        } catch(e) {}
      }
      recordShiftMap(shiftBatchId, {
        batchId: shiftBatchId,
        entityType: 'BILL',
        sourceTable: 'bills',
        sourceId: b.id,
        sourceRef: b.bill_number,
        targetTable: 'bills',
        targetId: billIdMap.get(b.id) || null,
        targetRef: b.bill_number
      });
    });

    // Import payments
    (data.payments || []).forEach(p => {
      const orgId = orgIdMap.get(p.org_id);
      if (!orgId) return;
      const exists = get('SELECT id FROM payments WHERE payment_number=? AND org_id=?', [p.payment_number, orgId]);
      if (exists) {
        paymentIdMap.set(p.id, exists.id);
      } else {
        try {
          const linkedBills = JSON.parse(p.linked_bills || '[]').map(row => ({
            ...row,
            bill_id: billIdMap.get(row.bill_id) || row.bill_id
          }));
          const exportedDepositAccount = (data.accounts || []).find(account => Number(account.id) === Number(p.deposit_account_id));
          const depositAccountId = exportedDepositAccount
            ? get('SELECT id FROM accounts WHERE org_id=? AND code=?', [orgId, exportedDepositAccount.code])?.id || null
            : null;
          const result = run(`INSERT INTO payments
              (org_id,payment_number,payment_date,fy,party_id,party_snapshot,type,mode,deposit_account_id,amount,reference,
               linked_bills,narration,shift_id,created_by,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [orgId, p.payment_number, p.payment_date, p.fy, partyIdMap.get(p.party_id) || null, p.party_snapshot,
             p.type, p.mode, depositAccountId, p.amount, p.reference, JSON.stringify(linkedBills), p.narration,
             p.shift_id || null, p.created_by || req.user.id, p.created_at || new Date().toISOString()]);
          paymentIdMap.set(p.id, result.lastInsertRowid);
          imported.payments++;
        } catch(e) {}
      }
      recordShiftMap(shiftBatchId, {
        batchId: shiftBatchId,
        entityType: 'PAYMENT',
        sourceTable: 'payments',
        sourceId: p.id,
        sourceRef: p.payment_number || p.reference,
        targetTable: 'payments',
        targetId: paymentIdMap.get(p.id) || null,
        targetRef: p.payment_number || p.reference
      });
    });

    (data.payment_allocations || []).forEach(allocation => {
      const paymentId = paymentIdMap.get(allocation.payment_id);
      const billId = billIdMap.get(allocation.bill_id);
      if (!paymentId || !billId) return;
      if (!get('SELECT id FROM payment_allocations WHERE payment_id=? AND bill_id=?', [paymentId, billId])) {
        run('INSERT INTO payment_allocations (payment_id,bill_id,amount) VALUES (?,?,?)',
          [paymentId, billId, allocation.amount || 0]);
      }
    });

    (data.purchases || []).forEach(purchase => {
      const orgId = orgIdMap.get(purchase.org_id);
      if (!orgId) return;
      const exists = get('SELECT id FROM purchases WHERE org_id=? AND purchase_number=?', [orgId, purchase.purchase_number]);
      if (exists) {
        purchaseIdMap.set(purchase.id, exists.id);
        return;
      }
      try {
        const remappedItems = parseJsonArray(purchase.items_json).map(row => ({
          ...row,
          item_id: itemIdMap.get(row.item_id) || row.item_id || null
        }));
        const result = run(
          `INSERT INTO purchases
           (org_id,purchase_number,supplier_invoice,purchase_date,due_date,fy,party_id,items_json,
            taxable_amount,cgst,sgst,igst,total_tax,grand_total,round_off,payment_mode,narration,tax_inclusive,created_by,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            orgId, purchase.purchase_number, purchase.supplier_invoice || '', purchase.purchase_date,
            purchase.due_date || null, purchase.fy, partyIdMap.get(purchase.party_id) || null,
            JSON.stringify(remappedItems), purchase.taxable_amount || 0, purchase.cgst || 0,
            purchase.sgst || 0, purchase.igst || 0, purchase.total_tax || 0, purchase.grand_total || 0,
            purchase.round_off || 0, purchase.payment_mode || 'credit', purchase.narration || '',
            purchase.tax_inclusive ? 1 : 0, resolveUserId(purchase.created_by, req.user.id),
            purchase.created_at || new Date().toISOString()
          ]
        );
        purchaseIdMap.set(purchase.id, result.lastInsertRowid);
        imported.purchases++;
      } catch (_) {}
    });

    (data.purchase_orders || []).forEach(order => {
      const orgId = orgIdMap.get(order.org_id);
      if (!orgId) return;
      const exists = get('SELECT id FROM purchase_orders WHERE org_id=? AND po_number=?', [orgId, order.po_number]);
      if (exists) {
        purchaseOrderIdMap.set(order.id, exists.id);
        return;
      }
      try {
        const remappedItems = parseJsonArray(order.items_json).map(row => ({
          ...row,
          item_id: itemIdMap.get(row.item_id) || row.item_id || null
        }));
        const result = run(
          `INSERT INTO purchase_orders
           (org_id,po_number,po_date,expected_date,fy,party_id,items_json,subtotal,round_off,status,
            converted_purchase_id,narration,tax_inclusive,created_by,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            orgId, order.po_number, order.po_date, order.expected_date || null, order.fy,
            partyIdMap.get(order.party_id) || null, JSON.stringify(remappedItems), order.subtotal || 0,
            order.round_off || 0, order.status || 'open', purchaseIdMap.get(order.converted_purchase_id) || null,
            order.narration || '', order.tax_inclusive ? 1 : 0, resolveUserId(order.created_by, req.user.id),
            order.created_at || new Date().toISOString()
          ]
        );
        purchaseOrderIdMap.set(order.id, result.lastInsertRowid);
        imported.purchase_orders++;
      } catch (_) {}
    });

    (data.financial_year_locks || []).forEach(lock => {
      const orgId = orgIdMap.get(lock.org_id);
      if (!orgId || !lock.fy) return;
      try {
        const existing = get('SELECT id FROM financial_year_locks WHERE org_id=? AND fy=?', [orgId, lock.fy]);
        if (existing) {
          run(
            `UPDATE financial_year_locks SET locked=?,locked_by=?,locked_at=?,closed=?,closed_by=?,closed_at=?,
             close_note=?,close_snapshot_json=?,reopened_by=?,reopened_at=?,reopen_reason=? WHERE id=?`,
            [
              lock.locked ? 1 : 0, resolveUserId(lock.locked_by, req.user.id), lock.locked_at || null,
              lock.closed ? 1 : 0, resolveUserId(lock.closed_by, req.user.id), lock.closed_at || null,
              lock.close_note || '', lock.close_snapshot_json || '{}',
              resolveUserId(lock.reopened_by, req.user.id), lock.reopened_at || null,
              lock.reopen_reason || '', existing.id
            ]
          );
        } else {
          run(
            `INSERT INTO financial_year_locks
             (org_id,fy,locked,locked_by,locked_at,closed,closed_by,closed_at,close_note,close_snapshot_json,
              reopened_by,reopened_at,reopen_reason)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              orgId, lock.fy, lock.locked ? 1 : 0, resolveUserId(lock.locked_by, req.user.id),
              lock.locked_at || null, lock.closed ? 1 : 0, resolveUserId(lock.closed_by, req.user.id),
              lock.closed_at || null, lock.close_note || '', lock.close_snapshot_json || '{}',
              resolveUserId(lock.reopened_by, req.user.id), lock.reopened_at || null, lock.reopen_reason || ''
            ]
          );
          imported.financial_year_locks++;
        }
      } catch (_) {}
    });

    (data.gstr2b_imports || []).forEach(importRow => {
      const orgId = orgIdMap.get(importRow.org_id);
      if (!orgId) return;
      let local = get(
        'SELECT id FROM gstr2b_imports WHERE org_id=? AND fy=? AND file_name=? AND imported_at=?',
        [orgId, importRow.fy, importRow.file_name || null, importRow.imported_at]
      );
      if (!local) {
        try {
          const result = run(
            `INSERT INTO gstr2b_imports (org_id,fy,file_name,source_format,imported_by,imported_at)
             VALUES (?,?,?,?,?,?)`,
            [
              orgId, importRow.fy, importRow.file_name || null, importRow.source_format || 'json',
              resolveUserId(importRow.imported_by, req.user.id), importRow.imported_at || new Date().toISOString()
            ]
          );
          local = { id: result.lastInsertRowid };
          imported.gstr2b_imports++;
        } catch (_) {}
      }
      if (local) gstr2bImportIdMap.set(importRow.id, local.id);
    });

    (data.gstr2b_rows || []).forEach(row => {
      const orgId = orgIdMap.get(row.org_id);
      const importId = gstr2bImportIdMap.get(row.import_id);
      if (!orgId || !importId) return;
      const exists = get(
        `SELECT id FROM gstr2b_rows
         WHERE org_id=? AND fy=? AND COALESCE(supplier_gstin,'')=COALESCE(?, '')
           AND COALESCE(invoice_number,'')=COALESCE(?, '') AND COALESCE(invoice_date,'')=COALESCE(?, '')`,
        [orgId, row.fy, row.supplier_gstin || '', row.invoice_number || '', row.invoice_date || '']
      );
      if (exists) return;
      try {
        run(
          `INSERT INTO gstr2b_rows
           (import_id,org_id,fy,supplier_gstin,supplier_name,invoice_number,invoice_date,taxable_amount,
            igst,cgst,sgst,cess,total_tax,raw_json,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            importId, orgId, row.fy, row.supplier_gstin || null, row.supplier_name || null,
            row.invoice_number || null, row.invoice_date || null, row.taxable_amount || 0,
            row.igst || 0, row.cgst || 0, row.sgst || 0, row.cess || 0,
            row.total_tax || 0, row.raw_json || '{}', row.created_at || new Date().toISOString()
          ]
        );
        imported.gstr2b_rows++;
      } catch (_) {}
    });

    rebuildAccounting();

    const accountIdMap = new Map();
    (data.accounts || []).forEach(account => {
      const orgId = orgIdMap.get(account.org_id);
      if (!orgId) return;
      let local = get('SELECT id FROM accounts WHERE org_id=? AND code=?', [orgId, account.code]);
      if (!local) {
        try {
          const result = run(
            `INSERT INTO accounts (org_id,code,name,type,subtype,system_key,active) VALUES (?,?,?,?,?,?,?)`,
            [orgId, account.code, account.name, account.type, account.subtype, account.system_key, account.active ?? 1]
          );
          local = { id: result.lastInsertRowid };
        } catch (_) {}
      }
      if (local) accountIdMap.set(account.id, local.id);
    });

    (data.expenses || []).forEach(expense => {
      const orgId = orgIdMap.get(expense.org_id);
      const accountId = accountIdMap.get(expense.account_id);
      if (!orgId || !accountId) return;
      const exists = get('SELECT id FROM expenses WHERE org_id=? AND expense_number=?', [orgId, expense.expense_number]);
      if (exists) {
        expenseIdMap.set(expense.id, exists.id);
        return;
      }
      try {
        const result = run(
          `INSERT INTO expenses
           (org_id,expense_number,expense_date,fy,party_id,account_id,payment_mode,amount,gst_amount,gst_rate,
            tax_inclusive,round_off,reference,narration,created_by,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            orgId, expense.expense_number, expense.expense_date, expense.fy,
            partyIdMap.get(expense.party_id) || null, accountId, expense.payment_mode || 'cash',
            expense.amount || 0, expense.gst_amount || 0, expense.gst_rate || 0,
            expense.tax_inclusive ? 1 : 0, expense.round_off || 0, expense.reference || '',
            expense.narration || '', resolveUserId(expense.created_by, req.user.id),
            expense.created_at || new Date().toISOString()
          ]
        );
        expenseIdMap.set(expense.id, result.lastInsertRowid);
        imported.expenses++;
      } catch (_) {}
    });

    (data.credit_debit_notes || []).forEach(note => {
      const orgId = orgIdMap.get(note.org_id);
      if (!orgId) return;
      const exists = get('SELECT id FROM credit_debit_notes WHERE org_id=? AND note_number=?', [orgId, note.note_number]);
      if (exists) {
        noteIdMap.set(note.id, exists.id);
        return;
      }
      try {
        const remappedItems = parseJsonArray(note.items_json).map(row => ({
          ...row,
          item_id: itemIdMap.get(row.item_id) || row.item_id || null
        }));
        const result = run(
          `INSERT INTO credit_debit_notes
           (org_id,note_number,note_date,fy,note_type,party_id,linked_bill_id,linked_purchase_id,items_json,
            taxable_amount,tax_amount,grand_total,round_off,narration,tax_inclusive,created_by,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            orgId, note.note_number, note.note_date, note.fy, note.note_type,
            partyIdMap.get(note.party_id) || null, billIdMap.get(note.linked_bill_id) || null,
            purchaseIdMap.get(note.linked_purchase_id) || null, JSON.stringify(remappedItems),
            note.taxable_amount || 0, note.tax_amount || 0, note.grand_total || 0,
            note.round_off || 0, note.narration || '', note.tax_inclusive ? 1 : 0,
            resolveUserId(note.created_by, req.user.id), note.created_at || new Date().toISOString()
          ]
        );
        noteIdMap.set(note.id, result.lastInsertRowid);
        imported.credit_debit_notes++;
      } catch (_) {}
    });

    const warrantyServiceCenterIdMap = new Map();
    (data.warranty_service_centers || []).forEach(center => {
      const orgId = orgIdMap.get(center.org_id);
      if (!orgId) return;
      const existing = get(
        `SELECT id FROM warranty_service_centers
         WHERE org_id=? AND name=? AND COALESCE(category,'')=COALESCE(?, '') AND COALESCE(brand,'')=COALESCE(?, '')`,
        [orgId, center.name, center.category || '', center.brand || '']
      );
      if (existing) {
        warrantyServiceCenterIdMap.set(center.id, existing.id);
        return;
      }
      try {
        const result = run(
          `INSERT INTO warranty_service_centers
           (org_id,name,category,brand,contact_person,phone,address,courier_instructions,active,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [orgId, center.name, center.category || '', center.brand || '', center.contact_person || '',
           center.phone || '', center.address || '', center.courier_instructions || '', center.active ?? 1,
           center.created_at || new Date().toISOString(), center.updated_at || center.created_at || new Date().toISOString()]
        );
        warrantyServiceCenterIdMap.set(center.id, result.lastInsertRowid);
        imported.warranty_service_centers++;
      } catch (_) {}
    });

    (data.warranty_replacements || []).forEach(warranty => {
      const orgId = orgIdMap.get(warranty.org_id);
      const partyId = partyIdMap.get(warranty.party_id);
      const billId = billIdMap.get(warranty.delivery_bill_id);
      const originalSaleBillId = billIdMap.get(warranty.original_sale_bill_id) || null;
      const itemId = itemIdMap.get(warranty.product_item_id);
      const serviceCenterId = warrantyServiceCenterIdMap.get(warranty.service_center_id) || null;
      if (!orgId || !partyId || !billId || !itemId) return;
      const exists = get(
        'SELECT id FROM warranty_replacements WHERE org_id=? AND replacement_number=?',
        [orgId, warranty.replacement_number]
      );
      if (exists) return;
      try {
        run(
          `INSERT INTO warranty_replacements
           (org_id,replacement_number,party_id,customer_mode,common_customer_slot,customer_name,customer_phone,customer_email,customer_address,
            original_sale_bill_id,delivery_bill_id,product_item_id,product_name,serial_number,
            quantity,request_date,status,issue_summary,vendor_reference,service_center_id,courier_vendor,
            courier_tracking_number,sent_date,expected_return_date,rma_number,service_center_contact,
            service_center_ack_status,follow_up_date,resolution_notes,closed_at,created_by,updated_by,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            orgId, warranty.replacement_number, partyId, warranty.customer_mode || 'PARTY', warranty.common_customer_slot || null,
            warranty.customer_name || '', warranty.customer_phone || '', warranty.customer_email || '', warranty.customer_address || '',
            originalSaleBillId, billId, itemId, warranty.product_name || '',
            warranty.serial_number, warranty.quantity || 1, warranty.request_date,
            warranty.status || 'OPEN', warranty.issue_summary || '', warranty.vendor_reference || '',
            serviceCenterId, warranty.courier_vendor || '', warranty.courier_tracking_number || '',
            warranty.sent_date || null, warranty.expected_return_date || null, warranty.rma_number || '',
            warranty.service_center_contact || '', warranty.service_center_ack_status || '',
            warranty.follow_up_date || null, warranty.resolution_notes || '', warranty.closed_at || null,
            resolveUserId(warranty.created_by, req.user.id), resolveUserId(warranty.updated_by, req.user.id),
            warranty.created_at || new Date().toISOString(),
            warranty.updated_at || warranty.created_at || new Date().toISOString()
          ]
        );
        imported.warranty_replacements++;
      } catch (_) {}
    });

    (data.journal_entries || []).filter(entry => entry.source_type === 'manual').forEach((entry, index) => {
      const orgId = orgIdMap.get(entry.org_id);
      if (!orgId) return;
      const exists = get(
        'SELECT id FROM journal_entries WHERE org_id=? AND voucher_number=? AND source_type=?',
        [orgId, entry.voucher_number, 'manual']
      );
      if (exists) {
        journalEntryIdMap.set(entry.id, exists.id);
        return;
      }
      try {
        const result = run(
          `INSERT INTO journal_entries
           (org_id,entry_date,fy,voucher_type,voucher_number,narration,source_type,source_id,created_by)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [orgId, entry.entry_date, entry.fy, entry.voucher_type, entry.voucher_number,
           entry.narration, 'manual', Date.now() + index, req.user.id]
        );
        journalEntryIdMap.set(entry.id, result.lastInsertRowid);
        (data.journal_lines || []).filter(line => line.entry_id === entry.id).forEach(line => {
          const accountId = accountIdMap.get(line.account_id);
          if (!accountId) return;
          const lineResult = run(
            `INSERT INTO journal_lines (entry_id,account_id,party_id,debit,credit,narration) VALUES (?,?,?,?,?,?)`,
            [result.lastInsertRowid, accountId, partyIdMap.get(line.party_id) || line.party_id || null,
             line.debit || 0, line.credit || 0, line.narration || '']
          );
          journalLineIdMap.set(line.id, lineResult.lastInsertRowid);
        });
        imported.journals++;
      } catch (_) {}
    });

    (data.system_settings || [])
      .filter(setting => ['auto_lock_enabled','auto_lock_minutes','auto_lock_warning_seconds','future_transaction_control_profile'].includes(setting.key))
      .forEach(setting => run(
        `INSERT INTO system_settings (key,value,updated_by,updated_at) VALUES (?,?,?,datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=datetime('now')`,
        [setting.key, setting.value, req.user.id]
      ));

    (data.bill_sequences || []).forEach(sequence => {
      const orgId = orgIdMap.get(sequence.org_id);
      if (!orgId) return;
      const existing = get(
        'SELECT id,last_number FROM bill_sequences WHERE org_id=? AND format=? AND fy=?',
        [orgId, sequence.format, sequence.fy]
      );
      if (existing) {
        if (Number(sequence.last_number || 0) > Number(existing.last_number || 0)) {
          run('UPDATE bill_sequences SET prefix=?,last_number=? WHERE id=?',
            [sequence.prefix, sequence.last_number, existing.id]);
        }
      } else {
        run(
          'INSERT INTO bill_sequences (org_id,format,fy,prefix,last_number) VALUES (?,?,?,?,?)',
          [orgId, sequence.format, sequence.fy, sequence.prefix, sequence.last_number || 0]
        );
      }
    });

    rebuildAccounting();

    function mappedSourceId(entry) {
      switch (entry?.source_type) {
        case 'bill': return billIdMap.get(entry.source_id) || null;
        case 'payment': return paymentIdMap.get(entry.source_id) || null;
        case 'purchase': return purchaseIdMap.get(entry.source_id) || null;
        case 'expense': return expenseIdMap.get(entry.source_id) || null;
        case 'note': return noteIdMap.get(entry.source_id) || null;
        default: return entry?.source_id || null;
      }
    }

    (data.journal_entries || [])
      .filter(entry => entry.source_type !== 'manual')
      .forEach(entry => {
        const orgId = orgIdMap.get(entry.org_id);
        const sourceId = mappedSourceId(entry);
        if (!orgId || !entry.source_type || !sourceId) return;
        const local = get(
          'SELECT id FROM journal_entries WHERE org_id=? AND source_type=? AND source_id=?',
          [orgId, entry.source_type, sourceId]
        );
        if (local) journalEntryIdMap.set(entry.id, local.id);
      });

    (data.journal_lines || []).forEach(line => {
      if (journalLineIdMap.has(line.id)) return;
      const entryId = journalEntryIdMap.get(line.entry_id);
      const accountId = accountIdMap.get(line.account_id);
      if (!entryId || !accountId) return;
      const local = get(
        `SELECT id FROM journal_lines
         WHERE entry_id=? AND account_id=? AND COALESCE(party_id,0)=COALESCE(?,0)
           AND ABS(COALESCE(debit,0)-?)<0.01 AND ABS(COALESCE(credit,0)-?)<0.01
         ORDER BY id LIMIT 1`,
        [entryId, accountId, partyIdMap.get(line.party_id) || line.party_id || null,
         line.debit || 0, line.credit || 0]
      );
      if (local) journalLineIdMap.set(line.id, local.id);
    });

    function mappedStockSourceId(movement) {
      switch (movement.source_type) {
        case 'bill': return billIdMap.get(movement.source_id) || null;
        case 'purchase': return purchaseIdMap.get(movement.source_id) || null;
        case 'note': return noteIdMap.get(movement.source_id) || null;
        case 'job_material': return jobIdMap.get(movement.source_id) || movement.source_id || null;
        default: return movement.source_id || null;
      }
    }

    (data.stock_movements || []).forEach(movement => {
      const orgId = orgIdMap.get(movement.org_id);
      const itemId = itemIdMap.get(movement.item_id);
      const sourceId = mappedStockSourceId(movement);
      if (!orgId || !itemId || !sourceId) return;
      const exists = get(
        `SELECT id FROM stock_movements
         WHERE org_id=? AND item_id=? AND movement_date=? AND source_type=? AND source_id=?`,
        [orgId, itemId, movement.movement_date, movement.source_type, sourceId]
      );
      if (exists) return;
      try {
        run(
          `INSERT INTO stock_movements
           (org_id,item_id,movement_date,source_type,source_id,ref_number,qty_in,qty_out,rate,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            orgId, itemId, movement.movement_date, movement.source_type, sourceId,
            movement.ref_number || null, movement.qty_in || 0, movement.qty_out || 0,
            movement.rate || 0, movement.created_at || new Date().toISOString()
          ]
        );
        imported.stock_movements++;
      } catch (_) {}
    });

    (data.bank_statement_imports || []).forEach(importRow => {
      const orgId = orgIdMap.get(importRow.org_id);
      if (!orgId) return;
      let local = get(
        'SELECT id FROM bank_statement_imports WHERE org_id=? AND COALESCE(file_hash,\'\')=COALESCE(?,\'\') AND file_name=?',
        [orgId, importRow.file_hash || '', importRow.file_name]
      );
      if (!local) {
        try {
          const result = run(
            `INSERT INTO bank_statement_imports
             (org_id,file_name,imported_by,file_hash,mapping_json,imported_at)
             VALUES (?,?,?,?,?,?)`,
            [
              orgId, importRow.file_name, resolveUserId(importRow.imported_by, req.user.id),
              importRow.file_hash || null, importRow.mapping_json || '{}',
              importRow.imported_at || new Date().toISOString()
            ]
          );
          local = { id: result.lastInsertRowid };
          imported.bank_statement_imports++;
        } catch (_) {}
      }
      if (local) bankImportIdMap.set(importRow.id, local.id);
    });

    (data.bank_statement_rows || []).forEach(row => {
      const orgId = orgIdMap.get(row.org_id);
      const importId = bankImportIdMap.get(row.import_id);
      if (!orgId || !importId) return;
      const exists = get(
        `SELECT id FROM bank_statement_rows
         WHERE import_id=? AND transaction_date=? AND COALESCE(reference,'')=COALESCE(?, '')
           AND COALESCE(description,'')=COALESCE(?, '') AND debit=? AND credit=?`,
        [importId, row.transaction_date || null, row.reference || '', row.description || '',
         row.debit || 0, row.credit || 0]
      );
      if (exists) return;
      try {
        run(
          `INSERT INTO bank_statement_rows
           (import_id,org_id,transaction_date,description,reference,debit,credit,balance,journal_line_id,matched,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [
            importId, orgId, row.transaction_date || null, row.description || null, row.reference || null,
            row.debit || 0, row.credit || 0, row.balance || null,
            journalLineIdMap.get(row.journal_line_id) || null, row.matched ? 1 : 0,
            row.created_at || new Date().toISOString()
          ]
        );
        imported.bank_statement_rows++;
      } catch (_) {}
    });

    (data.bank_reconciliation || []).forEach(reconciliation => {
      const orgId = orgIdMap.get(reconciliation.org_id);
      const journalLineId = journalLineIdMap.get(reconciliation.journal_line_id);
      if (!orgId || !journalLineId) return;
      if (get('SELECT id FROM bank_reconciliation WHERE org_id=? AND journal_line_id=?', [orgId, journalLineId])) return;
      try {
        run(
          `INSERT INTO bank_reconciliation
           (org_id,journal_line_id,statement_date,statement_reference,matched,matched_by,matched_at)
           VALUES (?,?,?,?,?,?,?)`,
          [
            orgId, journalLineId, reconciliation.statement_date || null,
            reconciliation.statement_reference || null, reconciliation.matched ? 1 : 0,
            resolveUserId(reconciliation.matched_by, req.user.id),
            reconciliation.matched_at || new Date().toISOString()
          ]
        );
        imported.bank_reconciliation++;
      } catch (_) {}
    });

    (data.job_service_categories || []).forEach(category => {
      const orgId = orgIdMap.get(category.org_id);
      if (!orgId) return;
      let local = get('SELECT id FROM job_service_categories WHERE org_id=? AND code=?', [orgId, category.code]);
      if (!local) {
        local = get('SELECT id FROM job_service_categories WHERE org_id=? AND name=?', [orgId, category.name]);
      }
      if (!local) {
        try {
          const result = run(
            `INSERT INTO job_service_categories
             (org_id,code,name,description,sort_order,active,created_by,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [
              orgId, category.code, category.name, category.description || '', category.sort_order || 0,
              category.active ?? 1, resolveUserId(category.created_by, req.user.id),
              category.created_at || new Date().toISOString(),
              category.updated_at || category.created_at || new Date().toISOString()
            ]
          );
          local = { id: result.lastInsertRowid };
          imported.job_service_categories++;
        } catch (_) {}
      }
      if (local) jobCategoryIdMap.set(category.id, local.id);
    });

    (data.job_service_subcategories || []).forEach(subcategory => {
      const orgId = orgIdMap.get(subcategory.org_id);
      const categoryId = jobCategoryIdMap.get(subcategory.category_id);
      if (!orgId || !categoryId) return;
      let local = get('SELECT id FROM job_service_subcategories WHERE org_id=? AND code=?', [orgId, subcategory.code]);
      if (!local) {
        local = get(
          'SELECT id FROM job_service_subcategories WHERE category_id=? AND name=?',
          [categoryId, subcategory.name]
        );
      }
      if (!local) {
        try {
          const result = run(
            `INSERT INTO job_service_subcategories
             (org_id,category_id,code,name,description,sort_order,active,created_by,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [
              orgId, categoryId, subcategory.code, subcategory.name, subcategory.description || '',
              subcategory.sort_order || 0, subcategory.active ?? 1,
              resolveUserId(subcategory.created_by, req.user.id),
              subcategory.created_at || new Date().toISOString(),
              subcategory.updated_at || subcategory.created_at || new Date().toISOString()
            ]
          );
          local = { id: result.lastInsertRowid };
          imported.job_service_subcategories++;
        } catch (_) {}
      }
      if (local) jobSubcategoryIdMap.set(subcategory.id, local.id);
    });

    (data.job_services || []).forEach(service => {
      const orgId = orgIdMap.get(service.org_id);
      const categoryId = jobCategoryIdMap.get(service.category_id);
      if (!orgId || !categoryId) return;
      let local = get('SELECT id FROM job_services WHERE org_id=? AND code=?', [orgId, service.code]);
      if (!local) {
        local = get('SELECT id FROM job_services WHERE org_id=? AND name=?', [orgId, service.name]);
      }
      if (!local) {
        try {
          const result = run(
            `INSERT INTO job_services
             (org_id,category_id,subcategory_id,code,name,description,specification_schema,allowed_units,
              default_unit,default_sla_minutes,estimate_guidance,sort_order,active,created_by,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              orgId, categoryId, jobSubcategoryIdMap.get(service.subcategory_id) || null, service.code,
              service.name, service.description || '', service.specification_schema || '{}',
              service.allowed_units || '[]', service.default_unit || 'NOS', service.default_sla_minutes || null,
              service.estimate_guidance || '{}', service.sort_order || 0, service.active ?? 1,
              resolveUserId(service.created_by, req.user.id),
              service.created_at || new Date().toISOString(),
              service.updated_at || service.created_at || new Date().toISOString()
            ]
          );
          local = { id: result.lastInsertRowid };
          imported.job_services++;
        } catch (_) {}
      }
      if (local) jobServiceIdMap.set(service.id, local.id);
    });

    (data.job_sequences || []).forEach(sequence => {
      const orgId = orgIdMap.get(sequence.org_id);
      if (!orgId) return;
      const existing = get('SELECT last_number FROM job_sequences WHERE org_id=? AND fy=?', [orgId, sequence.fy]);
      if (existing) {
        if (Number(sequence.last_number || 0) > Number(existing.last_number || 0)) {
          run('UPDATE job_sequences SET last_number=? WHERE org_id=? AND fy=?',
            [sequence.last_number || 0, orgId, sequence.fy]);
        }
      } else {
        run('INSERT INTO job_sequences (org_id,fy,last_number) VALUES (?,?,?)',
          [orgId, sequence.fy, sequence.last_number || 0]);
      }
    });

    (data.job_orders || []).forEach(job => {
      const orgId = orgIdMap.get(job.org_id);
      if (!orgId) return;
      let local = job.job_token ? get('SELECT id FROM job_orders WHERE job_token=?', [job.job_token]) : null;
      if (!local && job.offline_id) {
        local = get('SELECT id FROM job_orders WHERE offline_id=?', [job.offline_id]);
      }
      if (!local && job.provisional_token) {
        local = get('SELECT id FROM job_orders WHERE provisional_token=?', [job.provisional_token]);
      }
      if (!local) {
        try {
          const result = run(
            `INSERT INTO job_orders
             (org_id,job_token,provisional_token,offline_id,offline_device,offline_created_at,party_id,party_snapshot,
              priority,promised_delivery_at,current_status,financial_status,customer_commitment,counter_note,
              advance_paise,advance_payment_ids,pre_bill_id,pre_billed_at,final_bill_id,delivered_at,closed_at,version,created_by,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              orgId, job.job_token || null, job.provisional_token || null, job.offline_id || null,
              job.offline_device || null, job.offline_created_at || null, partyIdMap.get(job.party_id) || null,
              job.party_snapshot || '{}', job.priority || 'NORMAL', job.promised_delivery_at,
              job.current_status || 'WAITING', job.financial_status || 'OPEN', job.customer_commitment || '',
              job.counter_note || '', job.advance_paise || 0,
              JSON.stringify(parseJsonArray(job.advance_payment_ids).map(id => paymentIdMap.get(id) || id)),
              billIdMap.get(job.pre_bill_id) || null, job.pre_billed_at || null,
              billIdMap.get(job.final_bill_id) || null, job.delivered_at || null, job.closed_at || null,
              job.version || 1, resolveUserId(job.created_by, req.user.id),
              job.created_at || new Date().toISOString(),
              job.updated_at || job.created_at || new Date().toISOString()
            ]
          );
          local = { id: result.lastInsertRowid };
          imported.jobs++;
        } catch (_) {}
      }
      if (local) {
        jobIdMap.set(job.id, local.id);
        recordShiftMap(shiftBatchId, {
          batchId: shiftBatchId,
          entityType: 'JOB',
          sourceTable: 'job_orders',
          sourceId: job.id,
          sourceRef: job.job_token || job.provisional_token,
          targetTable: 'job_orders',
          targetId: local.id,
          targetRef: job.job_token || job.provisional_token
        });
      }
    });

    (data.job_intake_requests || []).forEach(intake => {
      const orgId = orgIdMap.get(intake.org_id);
      if (!orgId) return;
      let local = intake.request_token
        ? get('SELECT id FROM job_intake_requests WHERE request_token=?', [intake.request_token])
        : null;
      if (!local && intake.request_number) {
        local = get('SELECT id FROM job_intake_requests WHERE request_number=?', [intake.request_number]);
      }
      if (!local) {
        try {
          const result = run(
            `INSERT INTO job_intake_requests
             (org_id,request_token,request_number,client_request_id,source_channel,status,party_id,converted_job_id,
              converted_by,reviewed_by,reviewed_at,converted_at,customer_name,customer_phone,customer_email,
              customer_address,preferred_contact,service_id,service_name_snapshot,item_type,item_name,device_brand,
              device_model,device_serial,quantity,issue_summary,issue_details,requested_delivery_at,consent_status,
              consent_text,internal_notes,metadata_json,source_ip,source_user_agent,submitted_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              orgId,
              intake.request_token,
              intake.request_number,
              intake.client_request_id || null,
              intake.source_channel || 'QR',
              intake.status || 'SUBMITTED',
              partyIdMap.get(intake.party_id) || null,
              jobIdMap.get(intake.converted_job_id) || null,
              resolveUserId(intake.converted_by, req.user.id),
              resolveUserId(intake.reviewed_by, req.user.id),
              intake.reviewed_at || null,
              intake.converted_at || null,
              intake.customer_name,
              intake.customer_phone,
              intake.customer_email || null,
              intake.customer_address || null,
              intake.preferred_contact || 'PHONE',
              jobServiceIdMap.get(intake.service_id) || null,
              intake.service_name_snapshot || null,
              intake.item_type || '',
              intake.item_name || '',
              intake.device_brand || '',
              intake.device_model || '',
              intake.device_serial || '',
              intake.quantity || 1,
              intake.issue_summary,
              intake.issue_details || '',
              intake.requested_delivery_at || null,
              intake.consent_status || 'PENDING',
              intake.consent_text || '',
              intake.internal_notes || '',
              intake.metadata_json || '{}',
              intake.source_ip || null,
              intake.source_user_agent || null,
              intake.submitted_at || new Date().toISOString(),
              intake.updated_at || intake.submitted_at || new Date().toISOString()
            ]
          );
          local = { id: result.lastInsertRowid };
          imported.job_intake_requests++;
        } catch (_) {}
      }
      if (local) {
        intakeIdMap.set(intake.id, local.id);
        recordShiftMap(shiftBatchId, {
          batchId: shiftBatchId,
          entityType: 'INTAKE',
          sourceTable: 'job_intake_requests',
          sourceId: intake.id,
          sourceRef: intake.request_number || intake.request_token,
          targetTable: 'job_intake_requests',
          targetId: local.id,
          targetRef: intake.request_number || intake.request_token
        });
      }
    });

    (data.job_intake_attachments || []).forEach(attachment => {
      const intakeId = intakeIdMap.get(attachment.intake_request_id);
      if (!intakeId) return;
      const existing = get(
        `SELECT id FROM job_intake_attachments
         WHERE intake_request_id=? AND file_name=? AND COALESCE(sha256,'')=COALESCE(?, '')`,
        [intakeId, attachment.file_name, attachment.sha256 || '']
      );
      if (!existing) {
        try {
          const stored = importAttachmentRecord({
            scope: 'intake',
            file_name: attachment.file_name,
            sha256: attachment.sha256,
            content_base64: attachment.content_base64 || ''
          });
          run(
            `INSERT INTO job_intake_attachments
             (intake_request_id,file_name,mime_type,byte_size,sha256,storage_path,content_base64,pixel_width,pixel_height,
              pdf_page_count,analysis_status,analysis_error,metadata_json,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              intakeId,
              attachment.file_name,
              attachment.mime_type || null,
              attachment.byte_size || 0,
              attachment.sha256 || null,
              stored.storage_path,
              stored.content_base64,
              attachment.pixel_width || null,
              attachment.pixel_height || null,
              attachment.pdf_page_count || null,
              attachment.analysis_status || 'PENDING',
              attachment.analysis_error || null,
              attachment.metadata_json || '{}',
              attachment.created_at || new Date().toISOString()
            ]
          );
          imported.job_intake_attachments++;
        } catch (_) {}
      }
    });

    (data.job_items || []).forEach(item => {
      const jobId = jobIdMap.get(item.job_id);
      const serviceId = jobServiceIdMap.get(item.service_id);
      if (!jobId || !serviceId) return;
      let local = get(
        'SELECT id FROM job_items WHERE job_id=? AND sort_order=? AND description=? AND quantity=?',
        [jobId, item.sort_order || 0, item.description, item.quantity]
      );
      if (!local) {
        try {
          const result = run(
            `INSERT INTO job_items
             (job_id,service_id,category_snapshot,subcategory_snapshot,service_snapshot,description,specification_json,
              quantity,unit,sort_order,active,created_by,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              jobId, serviceId, item.category_snapshot || '{}', item.subcategory_snapshot || null,
              item.service_snapshot || '{}', item.description, item.specification_json || '{}',
              item.quantity, item.unit, item.sort_order || 0, item.active ?? 1,
              resolveUserId(item.created_by, req.user.id), item.created_at || new Date().toISOString()
            ]
          );
          local = { id: result.lastInsertRowid };
          imported.job_items++;
        } catch (_) {}
      }
      if (local) jobItemIdMap.set(item.id, local.id);
    });

    (data.job_estimates || []).forEach(estimate => {
      const jobId = jobIdMap.get(estimate.job_id);
      if (!jobId) return;
      let local = get('SELECT id FROM job_estimates WHERE job_id=? AND revision_no=?', [jobId, estimate.revision_no]);
      if (!local) {
        try {
          const result = run(
            `INSERT INTO job_estimates
             (job_id,revision_no,status,subtotal_paise,tax_paise,total_paise,round_off_paise,lines_json,tax_inclusive,created_by,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [
              jobId, estimate.revision_no, estimate.status || 'DRAFT', estimate.subtotal_paise || 0,
              estimate.tax_paise || 0, estimate.total_paise || 0, estimate.round_off_paise || 0,
              estimate.lines_json || '[]', estimate.tax_inclusive ? 1 : 0,
              resolveUserId(estimate.created_by, req.user.id), estimate.created_at || new Date().toISOString()
            ]
          );
          local = { id: result.lastInsertRowid };
          imported.job_estimates++;
        } catch (_) {}
      }
      if (local) estimateIdMap.set(estimate.id, local.id);
    });

    (data.job_assignments || []).forEach(assignment => {
      const jobId = jobIdMap.get(assignment.job_id);
      if (!jobId) return;
      let local = assignment.assigned_at
        ? get(
          `SELECT id FROM job_assignments
           WHERE job_id=? AND employee_id=? AND assigned_role=? AND assigned_at=?`,
          [jobId, resolveUserId(assignment.employee_id, req.user.id), assignment.assigned_role, assignment.assigned_at]
        )
        : null;
      if (!local) {
        try {
          const result = run(
            `INSERT INTO job_assignments
             (job_id,employee_id,assigned_role,assigned_by,source_assignment_id,handoff_type,handoff_reason,instructions,
              status,assigned_at,accepted_at,declined_at,decline_reason,released_at,release_reason,completed_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              jobId, resolveUserId(assignment.employee_id, req.user.id), assignment.assigned_role,
              resolveUserId(assignment.assigned_by, req.user.id), assignment.source_assignment_id || null,
              assignment.handoff_type, assignment.handoff_reason, assignment.instructions || '',
              assignment.status || 'PENDING_ACCEPTANCE', assignment.assigned_at || new Date().toISOString(),
              assignment.accepted_at || null, assignment.declined_at || null, assignment.decline_reason || null,
              assignment.released_at || null, assignment.release_reason || null, assignment.completed_at || null
            ]
          );
          local = { id: result.lastInsertRowid };
          imported.job_assignments++;
        } catch (_) {}
      }
      if (local) assignmentIdMap.set(assignment.id, local.id);
    });

    (data.job_status_events || []).forEach(event => {
      const jobId = jobIdMap.get(event.job_id);
      if (!jobId) return;
      let local = event.operation_id
        ? get('SELECT id FROM job_status_events WHERE operation_id=?', [event.operation_id])
        : get(
          'SELECT id FROM job_status_events WHERE job_id=? AND to_status=? AND occurred_at=?',
          [jobId, event.to_status, event.occurred_at]
        );
      if (!local) {
        try {
          const result = run(
            `INSERT INTO job_status_events
             (job_id,from_status,to_status,reason,actor_user_id,operation_id,occurred_at)
             VALUES (?,?,?,?,?,?,?)`,
            [
              jobId, event.from_status || null, event.to_status, event.reason || null,
              resolveUserId(event.actor_user_id, req.user.id), event.operation_id || null,
              event.occurred_at || new Date().toISOString()
            ]
          );
          local = { id: result.lastInsertRowid };
          imported.job_status_events++;
        } catch (_) {}
      }
    });

    (data.job_work_reports || []).forEach(report => {
      const jobId = jobIdMap.get(report.job_id);
      if (!jobId) return;
      let local = get(
        'SELECT id FROM job_work_reports WHERE job_id=? AND report_type=? AND created_at=?',
        [jobId, report.report_type, report.created_at]
      );
      if (!local) {
        try {
          const result = run(
            `INSERT INTO job_work_reports
             (job_id,employee_id,report_type,progress_percent,report_text,checklist_json,started_at,completed_at,created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [
              jobId, resolveUserId(report.employee_id, req.user.id), report.report_type,
              report.progress_percent || null, report.report_text, report.checklist_json || '{}',
              report.started_at || null, report.completed_at || null,
              report.created_at || new Date().toISOString()
            ]
          );
          local = { id: result.lastInsertRowid };
          imported.job_work_reports++;
        } catch (_) {}
      }
      if (local) workReportIdMap.set(report.id, local.id);
    });

    (data.operator_daily_logs || []).forEach(log => {
      const orgId = orgIdMap.get(log.org_id) || Number(log.org_id || 0);
      const userId = resolveUserId(log.user_id, req.user.id);
      if (!orgId || !userId || !get('SELECT id FROM orgs WHERE id=?', [orgId])) return;
      let local = get(
        'SELECT id FROM operator_daily_logs WHERE org_id=? AND user_id=? AND work_date=?',
        [orgId, userId, log.work_date]
      );
      if (!local) {
        try {
          const result = run(
            `INSERT INTO operator_daily_logs
             (org_id,user_id,work_date,status,daily_summary,pending_summary,submitted_at,reviewed_by,
              reviewed_at,review_status,review_note,reopened_by,reopened_at,reopen_reason,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [orgId, userId, log.work_date, log.status || 'DRAFT', log.daily_summary || '',
              log.pending_summary || '', log.submitted_at || null,
              resolveUserId(log.reviewed_by, null), log.reviewed_at || null,
              log.review_status || 'PENDING', log.review_note || '',
              resolveUserId(log.reopened_by, null), log.reopened_at || null, log.reopen_reason || '',
              log.created_at || new Date().toISOString(), log.updated_at || log.created_at || new Date().toISOString()]
          );
          local = { id: result.lastInsertRowid };
          imported.operator_daily_logs++;
        } catch (_) {}
      }
      if (local) operatorDailyLogIdMap.set(log.id, local.id);
    });

    (data.operator_log_entries || []).forEach(entry => {
      const dailyLogId = operatorDailyLogIdMap.get(entry.daily_log_id);
      if (!dailyLogId) return;
      const dailyLog = get('SELECT org_id,user_id,work_date FROM operator_daily_logs WHERE id=?', [dailyLogId]);
      if (!dailyLog) return;
      const linkedJobId = entry.linked_job_id ? (jobIdMap.get(entry.linked_job_id) || null) : null;
      const existing = get(
        'SELECT id FROM operator_log_entries WHERE daily_log_id=? AND title=? AND created_at=?',
        [dailyLogId, entry.title, entry.created_at]
      );
      if (existing) return;
      try {
        run(
          `INSERT INTO operator_log_entries
           (daily_log_id,org_id,user_id,work_date,entry_type,title,work_done,pending_work,linked_job_id,
            started_at,completed_at,duration_minutes,file_names_json,notes,created_by,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [dailyLogId, dailyLog.org_id, dailyLog.user_id, dailyLog.work_date,
            entry.entry_type || 'MISCELLANEOUS', entry.title, entry.work_done, entry.pending_work || '',
            linkedJobId, entry.started_at || null, entry.completed_at || null,
            Number(entry.duration_minutes || 0), JSON.stringify(parseJsonArray(entry.file_names_json)),
            entry.notes || '', resolveUserId(entry.created_by, dailyLog.user_id),
            entry.created_at || new Date().toISOString(), entry.updated_at || entry.created_at || new Date().toISOString()]
        );
        imported.operator_log_entries++;
      } catch (_) {}
    });

    (data.job_material_consumptions || []).forEach(material => {
      const jobId = jobIdMap.get(material.job_id);
      const itemId = itemIdMap.get(material.item_id);
      if (!jobId || !itemId) return;
      let local = get(
        `SELECT id FROM job_material_consumptions
         WHERE job_id=? AND item_id=? AND quantity=? AND created_at=?`,
        [jobId, itemId, material.quantity, material.created_at]
      );
      if (!local) {
        try {
          const result = run(
            `INSERT INTO job_material_consumptions
             (job_id,item_id,item_name_snapshot,item_code_snapshot,quantity,unit,rate,notes,consumed_by,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [
              jobId, itemId, material.item_name_snapshot, material.item_code_snapshot || '',
              material.quantity, material.unit || 'NOS', material.rate || 0, material.notes || '',
              resolveUserId(material.consumed_by, req.user.id),
              material.created_at || new Date().toISOString()
            ]
          );
          local = { id: result.lastInsertRowid };
          imported.job_material_consumptions++;
        } catch (_) {}
      }
    });

    (data.job_additions || []).forEach(addition => {
      const jobId = jobIdMap.get(addition.job_id);
      if (!jobId) return;
      let local = get(
        'SELECT id FROM job_additions WHERE job_id=? AND revision_no=? AND internal_reason=? AND created_at=?',
        [jobId, addition.revision_no || 1, addition.internal_reason, addition.created_at]
      );
      if (!local) {
        try {
          const result = run(
            `INSERT INTO job_additions
             (job_id,proposed_by,internal_reason,customer_description,quantity,unit,unit_price_paise,tax_rate,total_paise,
              revision_no,evidence_hash,state,priced_by,priced_at,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              jobId, resolveUserId(addition.proposed_by, req.user.id), addition.internal_reason,
              addition.customer_description || '', addition.quantity || 1, addition.unit || 'NOS',
              addition.unit_price_paise || 0, addition.tax_rate || 0, addition.total_paise || 0,
              addition.revision_no || 1, addition.evidence_hash || null, addition.state || 'PROPOSED',
              resolveUserId(addition.priced_by, req.user.id), addition.priced_at || null,
              addition.created_at || new Date().toISOString(),
              addition.updated_at || addition.created_at || new Date().toISOString()
            ]
          );
          local = { id: result.lastInsertRowid };
          imported.job_additions++;
        } catch (_) {}
      }
      if (local) additionIdMap.set(addition.id, local.id);
    });

    (data.job_attachments || []).forEach(attachment => {
      const jobId = jobIdMap.get(attachment.job_id);
      if (!jobId) return;
      const entityId = mapJobEntityId(attachment.entity_type, attachment.entity_id, {
        jobIdMap, jobItemIdMap, attachmentIdMap, estimateIdMap,
        assignmentIdMap, workReportIdMap, additionIdMap, conversationIdMap, messageIdMap
      });
      let local = get(
        `SELECT id FROM job_attachments
         WHERE job_id=? AND entity_type=? AND COALESCE(entity_id,0)=COALESCE(?,0) AND file_name=? AND COALESCE(sha256,'')=COALESCE(?, '')`,
        [jobId, attachment.entity_type || 'JOB', entityId || null, attachment.file_name, attachment.sha256 || '']
      );
      if (!local) {
        try {
          const stored = importAttachmentRecord({
            scope: 'job',
            file_name: attachment.file_name,
            sha256: attachment.sha256,
            content_base64: attachment.content_base64 || ''
          });
          const result = run(
            `INSERT INTO job_attachments
             (job_id,entity_type,entity_id,purpose,upload_origin,file_name,mime_type,byte_size,sha256,storage_path,
               content_base64,visible_to_customer,pixel_width,pixel_height,pdf_page_count,analysis_status,analysis_error,
               metadata_json,created_by,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              jobId, attachment.entity_type || 'JOB', entityId || null, attachment.purpose || 'OTHER',
              attachment.upload_origin || 'STAFF', attachment.file_name, attachment.mime_type || null,
              attachment.byte_size || 0, attachment.sha256 || null, stored.storage_path,
              stored.content_base64, attachment.visible_to_customer ? 1 : 0,
              attachment.pixel_width || null, attachment.pixel_height || null, attachment.pdf_page_count || null,
              attachment.analysis_status || 'PENDING', attachment.analysis_error || null, attachment.metadata_json || '{}',
              resolveUserId(attachment.created_by, req.user.id), attachment.created_at || new Date().toISOString()
            ]
          );
          local = { id: result.lastInsertRowid };
          imported.job_attachments++;
        } catch (_) {}
      }
      if (local) attachmentIdMap.set(attachment.id, local.id);
    });

    (data.job_customer_approvals || []).forEach(approval => {
      const additionId = additionIdMap.get(approval.job_addition_id);
      if (!additionId) return;
      let local = get(
        'SELECT id FROM job_customer_approvals WHERE job_addition_id=? AND addition_revision_no=? AND decided_at=?',
        [additionId, approval.addition_revision_no, approval.decided_at]
      );
      if (!local) {
        try {
          run(
            `INSERT INTO job_customer_approvals
             (job_addition_id,addition_revision_no,decision,method,approver_name,approver_contact_masked,evidence_text,
              evidence_attachment_id,evidence_hash,recorded_by,decided_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [
              additionId, approval.addition_revision_no, approval.decision, approval.method, approval.approver_name,
              approval.approver_contact_masked || null, approval.evidence_text || null,
              attachmentIdMap.get(approval.evidence_attachment_id) || null, approval.evidence_hash,
              resolveUserId(approval.recorded_by, req.user.id), approval.decided_at || new Date().toISOString()
            ]
          );
          imported.job_customer_approvals++;
        } catch (_) {}
      }
    });

    (data.job_customer_access_tokens || []).forEach(token => {
      const jobId = jobIdMap.get(token.job_id);
      if (!jobId) return;
      const existing = get('SELECT id FROM job_customer_access_tokens WHERE token_hash=?', [token.token_hash]);
      if (!existing) {
        try {
          run(
            `INSERT INTO job_customer_access_tokens
             (job_id,token_hash,expires_at,created_by,created_at,last_accessed_at,revoked_at)
             VALUES (?,?,?,?,?,?,?)`,
            [
              jobId, token.token_hash, token.expires_at,
              resolveUserId(token.created_by, req.user.id), token.created_at || new Date().toISOString(),
              token.last_accessed_at || null, token.revoked_at || null
            ]
          );
          imported.job_customer_access_tokens++;
        } catch (_) {}
      }
    });

    (data.job_delivery_acknowledgements || []).forEach(delivery => {
      const jobId = jobIdMap.get(delivery.job_id);
      if (!jobId) return;
      const existing = get('SELECT id FROM job_delivery_acknowledgements WHERE job_id=?', [jobId]);
      if (!existing) {
        try {
          run(
            `INSERT INTO job_delivery_acknowledgements
             (job_id,receiver_name,receiver_contact_masked,method,evidence_text,warranty_notes,service_notes,
              outstanding_paise,outstanding_terms,acknowledged_at,recorded_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [
              jobId, delivery.receiver_name, delivery.receiver_contact_masked || null, delivery.method,
              delivery.evidence_text || null, delivery.warranty_notes || '', delivery.service_notes || '',
              delivery.outstanding_paise || 0, delivery.outstanding_terms || '',
              delivery.acknowledged_at || new Date().toISOString(),
              resolveUserId(delivery.recorded_by, req.user.id)
            ]
          );
          imported.job_delivery_acknowledgements++;
        } catch (_) {}
      }
    });

    (data.job_communication_consents || []).forEach(consent => {
      const partyId = partyIdMap.get(consent.party_id);
      if (!partyId) return;
      const existing = get(
        `SELECT id FROM job_communication_consents
         WHERE party_id=? AND channel=? AND purpose=? AND effective_at=?`,
        [partyId, consent.channel, consent.purpose, consent.effective_at]
      );
      if (!existing) {
        try {
          run(
            `INSERT INTO job_communication_consents
             (party_id,channel,purpose,consent_status,source,evidence,recorded_by,effective_at,revoked_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [
              partyId, consent.channel, consent.purpose, consent.consent_status, consent.source,
              consent.evidence || null, resolveUserId(consent.recorded_by, req.user.id),
              consent.effective_at || new Date().toISOString(), consent.revoked_at || null
            ]
          );
          imported.job_communication_consents++;
        } catch (_) {}
      }
    });

    (data.job_conversations || []).forEach(conversation => {
      const jobId = jobIdMap.get(conversation.job_id);
      const partyId = partyIdMap.get(conversation.party_id);
      if (!jobId || !partyId) return;
      let local = conversation.external_ref
        ? get('SELECT id FROM job_conversations WHERE external_ref=?', [conversation.external_ref])
        : get(
          'SELECT id FROM job_conversations WHERE job_id=? AND party_id=? AND channel=? AND created_at=?',
          [jobId, partyId, conversation.channel, conversation.created_at]
        );
      if (!local) {
        try {
          const result = run(
            `INSERT INTO job_conversations
             (job_id,party_id,channel,assigned_staff_user_id,status,external_ref,last_message_at,created_at,closed_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [
              jobId, partyId, conversation.channel || 'WHATSAPP',
              resolveUserId(conversation.assigned_staff_user_id, req.user.id), conversation.status || 'OPEN',
              conversation.external_ref || null, conversation.last_message_at || null,
              conversation.created_at || new Date().toISOString(), conversation.closed_at || null
            ]
          );
          local = { id: result.lastInsertRowid };
          imported.job_conversations++;
        } catch (_) {}
      }
      if (local) conversationIdMap.set(conversation.id, local.id);
    });

    (data.job_messages || []).forEach(message => {
      const conversationId = conversationIdMap.get(message.conversation_id);
      if (!conversationId) return;
      let local = message.external_message_ref
        ? get('SELECT id FROM job_messages WHERE external_message_ref=?', [message.external_message_ref])
        : get(
          'SELECT id FROM job_messages WHERE conversation_id=? AND direction=? AND created_at=?',
          [conversationId, message.direction, message.created_at]
        );
      if (!local) {
        try {
          const result = run(
            `INSERT INTO job_messages
             (conversation_id,direction,message_type,template_code,body_text,workflow_intent,delivery_status,external_message_ref,
              failure_reason,sender_user_id,sent_at,delivered_at,read_at,received_at,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              conversationId, message.direction, message.message_type || 'TEXT', message.template_code || null,
              message.body_text || null, message.workflow_intent || 'INFORMATION', message.delivery_status || 'QUEUED',
              message.external_message_ref || null, message.failure_reason || null,
              resolveUserId(message.sender_user_id, req.user.id), message.sent_at || null,
              message.delivered_at || null, message.read_at || null, message.received_at || null,
              message.created_at || new Date().toISOString()
            ]
          );
          local = { id: result.lastInsertRowid };
          imported.job_messages++;
        } catch (_) {}
      }
      if (local) messageIdMap.set(message.id, local.id);
    });

    (data.job_internal_notes || []).forEach(note => {
      const orgId = orgIdMap.get(note.org_id);
      const jobId = jobIdMap.get(note.job_id);
      if (!orgId || !jobId) return;
      const existing = get(`SELECT id FROM job_internal_notes
        WHERE job_id=? AND author_user_id=? AND note_type=? AND created_at=?`,
      [jobId, resolveUserId(note.author_user_id, req.user.id), note.note_type || 'INSTRUCTION', note.created_at]);
      if (existing) return;
      try {
        run(`INSERT INTO job_internal_notes
          (job_id,org_id,author_user_id,note_type,note_text,file_names_json,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?)`,
        [jobId, orgId, resolveUserId(note.author_user_id, req.user.id), note.note_type || 'INSTRUCTION',
         note.note_text || '', note.file_names_json || '[]', note.created_at || new Date().toISOString(),
         note.updated_at || note.created_at || new Date().toISOString()]);
        imported.job_internal_notes++;
      } catch (_) {}
    });

    (data.job_audit_events || []).forEach(event => {
      const orgId = orgIdMap.get(event.org_id);
      if (!orgId) return;
      const jobId = jobIdMap.get(event.job_id) || null;
      const mappedEntityId = mapJobEntityId(event.entity_type, event.entity_id, {
        jobIdMap, intakeIdMap, jobItemIdMap, attachmentIdMap, estimateIdMap,
        assignmentIdMap, workReportIdMap, additionIdMap, conversationIdMap, messageIdMap
      });
      const existing = get(
        `SELECT id FROM job_audit_events
         WHERE org_id=? AND COALESCE(job_id,0)=COALESCE(?,0) AND entity_type=? AND action=? AND created_at=?`,
        [orgId, jobId || null, event.entity_type, event.action, event.created_at]
      );
      if (!existing) {
        try {
          run(
            `INSERT INTO job_audit_events
             (job_id,org_id,entity_type,entity_id,action,actor_user_id,actor_role,reason,old_data,new_data,operation_id,ip_address,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              jobId, orgId, event.entity_type, mappedEntityId || event.entity_id || null, event.action,
              resolveUserId(event.actor_user_id, req.user.id), event.actor_role || null, event.reason || null,
              event.old_data || null, event.new_data || null, event.operation_id || null,
              event.ip_address || null, event.created_at || new Date().toISOString()
            ]
          );
          imported.job_audit_events++;
        } catch (_) {}
      }
    });

    saveDB();
    finishDataShiftBatch(shiftBatchId, { status: 'COMPLETED', counts: imported });
    res.json({ success: true, imported, shift_batch_id: shiftBatchId });
  } catch(e) {
    finishDataShiftBatch(shiftBatchId, {
      status: 'FAILED',
      counts: { error: e.message },
      notes: String(e.message || '').slice(0, 2000)
    });
    res.status(500).json({ error: e.message });
  }
});

// Backup status (last backup date per org)
router.get('/status', (req, res) => {
  const { org_id } = req.query;
  const lastBackup = get(
    'SELECT * FROM backup_log WHERE org_id=? ORDER BY backup_date DESC LIMIT 1',
    [org_id || null]
  );
  const daysSince = lastBackup
    ? Math.floor((Date.now() - new Date(lastBackup.backup_date).getTime()) / (1000 * 60 * 60 * 24))
    : 999;
  res.json({
    last_backup: lastBackup,
    days_since: daysSince,
    warning: daysSince > 75,    // 75 days = ~2.5 months, start showing warning
    critical: daysSince > 90    // 90 days = 3 months, critical highlight
  });
});

router.get('/automatic-settings', (req, res) => {
  const enabled = get('SELECT value FROM system_settings WHERE key=?', ['automatic_backup_enabled'])?.value !== '0';
  const hours = Number(get('SELECT value FROM system_settings WHERE key=?', ['automatic_backup_hours'])?.value || 24);
  const directory = get('SELECT value FROM system_settings WHERE key=?', ['automatic_backup_directory'])?.value || '';
  const minimumFreeMb = Number(get('SELECT value FROM system_settings WHERE key=?', ['automatic_backup_min_free_mb'])?.value || 2048);
  const latestVerification = get(`SELECT id,backup_log_id,backup_file,status,integrity_result,
    schema_table_count,database_size_bytes,summary_json,error,verified_at
    FROM backup_verification_log ORDER BY id DESC LIMIT 1`);
  const latestRestoreDrill = get(`SELECT rd.*,u.name performed_by_name,u.username performed_by_username
    FROM backup_restore_drills rd LEFT JOIN users u ON u.id=rd.performed_by
    ORDER BY rd.id DESC LIMIT 1`);
  const restoreDrillDays = restoreDrillIntervalDays();
  res.json({
    enabled, hours, directory, effective_directory: backupDirectory(),
    retention_count: backupRetentionCount(), minimum_free_mb: minimumFreeMb, restore_drill_days: restoreDrillDays,
    storage_health: backupStorageHealth(),
    encrypted: true, format: 'AES-256-GCM .tbe',
    latest_verification: latestVerification ? {
      ...latestVerification,
      summary: parseJson(latestVerification.summary_json, {})
    } : null,
    latest_restore_drill: latestRestoreDrill ? {
      ...latestRestoreDrill,
      evidence: parseJson(latestRestoreDrill.evidence_json, {})
    } : null,
    restore_drill_health: restoreDrillHealth(latestRestoreDrill, restoreDrillDays)
  });
});

router.put('/automatic-settings', requireAdminNetworkAccess, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const hours = Math.max(1, Math.min(720, Number(req.body.hours || 24)));
  const retentionCount = Math.max(1, Math.min(365, Number(req.body.retention_count || 30)));
  const minimumFreeMb = Math.max(128, Math.min(1048576, Number(req.body.minimum_free_mb || 2048)));
  const restoreDrillDays = Math.max(7, Math.min(365, Number(req.body.restore_drill_days || 90)));
  [
    ['automatic_backup_enabled', req.body.enabled ? '1' : '0'],
    ['automatic_backup_hours', String(hours)],
    ['automatic_backup_directory', String(req.body.directory || '').trim()],
    ['automatic_backup_retention_count', String(retentionCount)],
    ['automatic_backup_min_free_mb', String(minimumFreeMb)],
    ['automatic_backup_restore_drill_days', String(restoreDrillDays)]
  ].forEach(([key, value]) => run(
    `INSERT INTO system_settings (key,value,updated_by,updated_at) VALUES (?,?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=datetime('now')`,
    [key, value, req.user.id]
  ));
  startAutomaticBackups();
  res.json({
    success: true, enabled: Boolean(req.body.enabled), hours, directory: req.body.directory || '',
    retention_count: retentionCount, minimum_free_mb: minimumFreeMb, restore_drill_days: restoreDrillDays,
    storage_health: backupStorageHealth()
  });
});

router.post('/run-automatic', requireAdminNetworkAccess, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const result = createAutomaticBackup(req.user.id);
  if (!result.success) return res.status(500).json(result);
  res.json(result);
});

router.post('/verify-automatic', requireAdminNetworkAccess, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const requestedId = Number(req.body.backup_log_id || 0);
  const backup = requestedId
    ? get(`SELECT id,file_name,backup_date FROM backup_log WHERE id=? AND fy='automatic'`, [requestedId])
    : get(`SELECT id,file_name,backup_date FROM backup_log WHERE fy='automatic' ORDER BY id DESC LIMIT 1`);
  if (!backup) return res.status(404).json({ error: 'No automatic backup is available to verify' });
  const verification = verifyAutomaticBackup(backup.file_name, backup.id, req.user.id);
  res.status(verification.success ? 200 : 400).json({ ...verification, backup });
});

router.get('/restore-drills', requireAdminNetworkAccess, (req, res) => {
  if (!requireGlobalBackupOwner(req, res)) return;
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
  const drills = all(`SELECT rd.*,bl.file_name,bl.backup_date,u.name performed_by_name,u.username performed_by_username
    FROM backup_restore_drills rd
    LEFT JOIN backup_log bl ON bl.id=rd.backup_log_id
    LEFT JOIN users u ON u.id=rd.performed_by
    ORDER BY rd.id DESC LIMIT ?`, [limit]);
  res.json(drills.map(drill => ({ ...drill, evidence: parseJson(drill.evidence_json, {}) })));
});

router.post('/restore-drills', requireAdminNetworkAccess, (req, res) => {
  if (!requireGlobalBackupOwner(req, res)) return;
  const notes = String(req.body.notes || '').trim().slice(0, 1500);
  if (notes.length < 5) return res.status(400).json({ error: 'Record a short restore-drill note before running the drill' });
  const requestedId = Number(req.body.backup_log_id || 0);
  const backup = requestedId
    ? get(`SELECT id,file_name,backup_date FROM backup_log WHERE id=? AND fy='automatic'`, [requestedId])
    : get(`SELECT id,file_name,backup_date FROM backup_log WHERE fy='automatic' ORDER BY id DESC LIMIT 1`);
  if (!backup) return res.status(404).json({ error: 'No automatic encrypted backup is available for a restore drill' });
  const verification = verifyAutomaticBackup(backup.file_name, backup.id, req.user.id);
  const result = run(`INSERT INTO backup_restore_drills
    (backup_log_id,verification_id,status,drill_type,notes,evidence_json,performed_by)
    VALUES (?,?,?,?,?,?,?)`, [backup.id, verification.verification_id || null, verification.success ? 'PASSED' : 'FAILED',
    'ISOLATED_RESTORE', notes, JSON.stringify({ backup_date: backup.backup_date, verification }), req.user.id]);
  run(`INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address)
    VALUES (?,?,?,?,?,?,?)`, [req.user.id, null, verification.success ? 'BACKUP_RESTORE_DRILL_PASSED' : 'BACKUP_RESTORE_DRILL_FAILED',
    'backup_restore_drills', result.lastInsertRowid, JSON.stringify({ backup_log_id: backup.id, verification_id: verification.verification_id || null, notes }), req.ip]);
  res.status(verification.success ? 200 : 400).json({
    success: verification.success, drill_id: result.lastInsertRowid, status: verification.success ? 'PASSED' : 'FAILED', backup, verification
  });
});

router.get('/verification-history', (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
  const history = all(`SELECT id,backup_log_id,backup_file,status,integrity_result,
    schema_table_count,database_size_bytes,summary_json,error,verified_by,verified_at
    FROM backup_verification_log ORDER BY id DESC LIMIT ?`, [limit]);
  res.json(history.map(row => ({ ...row, summary: parseJson(row.summary_json, {}) })));
});

router.get('/automatic-recovery-key', requireAdminNetworkAccess, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tarangini-automatic-backup-recovery-key.txt"');
  res.send([
    'Tarangini Automatic Backup Recovery Key',
    'Keep this file separately from the automatic .tbe backups.',
    '',
    automaticBackupRecoveryKey(),
    ''
  ].join('\n'));
});

router.post('/restore-automatic',
  express.raw({ type: 'application/octet-stream', limit: '500mb' }),
  requireAdminNetworkAccess,
  (req, res) => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
    try {
      const key = Buffer.from(String(req.headers['x-backup-recovery-key'] || '').trim(), 'base64url');
      const decrypted = decryptAutomaticBackup(req.body, key);
      if (decrypted.subarray(0, 16).toString() !== 'SQLite format 3\u0000') {
        throw new Error('Backup is not a valid Tarangini database');
      }
      saveDB();
      const target = getDBPath();
      const recovery = `${target}.before-automatic-restore-${Date.now()}`;
      fs.copyFileSync(target, recovery);
      fs.writeFileSync(`${target}.restore`, decrypted);
      fs.renameSync(`${target}.restore`, target);
      run('INSERT INTO audit_log (user_id,action,table_name,new_data,ip_address) VALUES (?,?,?,?,?)',
        [req.user.id, 'RESTORE_ENCRYPTED_AUTOMATIC_BACKUP', 'backup_log',
         JSON.stringify({ recovery_backup: recovery }), req.ip]);
      res.json({ success: true, restart_required: true, recovery_backup: recovery });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
);

module.exports = router;
