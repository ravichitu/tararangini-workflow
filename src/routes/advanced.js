const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const APP_VERSION = require('../../package.json').version;
const router = express.Router();
const { get, run, all, transaction, saveDB, getDBPath, getAppDataDir } = require('../db/db');
const {
  authMiddleware, checkOrgAccess, requirePermission, requireAnyPermission, requireOrgAccess,
  rejectLockedPeriod, requireAdminNetworkAccess, ownerOnly, isPeriodLocked
} = require('../middleware/auth');
const {
  getFY, postBill, postNote, postPayment, postPurchase, postExpense, billSettlement,
  replaceSourceEntry, rebuildAccounting
} = require('../accounting/accounting');
const { deploymentProfile } = require('../config/deployment-profile');
const { attachmentAnalysisWorkerStatus } = require('../services/attachment-processing');
const { attachmentRoot } = require('../services/attachment-storage');
const { backupDirectory, backupStorageHealth } = require('../services/automatic-backup');
const {
  replaceStockMovements, replaceStockCountMovements, stockSummary
} = require('../business/stock');
const { invoicePrefix, invoiceNumber } = require('../business/numbering');
const { partyForOrg } = require('../business/parties');
const { buildAbsoluteUrl, PUBLIC_BASE_URL, INTERNET_MODE, adminIpRestricted } = require('../security/runtime-config');

router.use(authMiddleware);
router.use(checkOrgAccess);

const activeClients = new Map();
const round = value => Number(Number(value || 0).toFixed(2));

function requireGlobalOwnerAccess(req, res) {
  if (req.user.role === 'owner' && req.user.org_access === 'all') return true;
  res.status(403).json({ error: 'Global diagnostics require owner access to all organizations' });
  return false;
}

router.get('/audit-log', ownerOnly, (req, res) => {
  const orgId = Number(req.query.org_id || 0);
  if (!orgId || !requireOrgAccess(req, res, orgId)) return;
  const requested = Number(req.query.limit || 200);
  const limit = Math.max(1, Math.min(500, Number.isFinite(requested) ? requested : 200));
  const action = String(req.query.action || '').trim().slice(0, 80);
  const tableName = String(req.query.table_name || '').trim().slice(0, 80);
  res.json(all(
    `SELECT a.id,a.org_id,a.action,a.table_name,a.record_id,a.old_data,a.new_data,a.ip_address,a.timestamp,
      u.username actor_username,u.name actor_name
     FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
     WHERE a.org_id=? AND (?='' OR a.action=?) AND (?='' OR a.table_name=?)
     ORDER BY a.id DESC LIMIT ?`,
    [orgId, action, action, tableName, tableName, limit]
  ));
});

router.get('/registered-devices', ownerOnly, (req, res) => {
  const orgId = Number(req.query.org_id || 0);
  if (!orgId || !requireOrgAccess(req, res, orgId)) return;
  res.json(all(`SELECT id,org_id,device_id,device_name,assigned_to,fingerprint,mac_references,
      status,registered_at,revoked_at,wipe_requested_at,wipe_acknowledged_at,wipe_reason,last_sync_at
    FROM registered_devices WHERE org_id=? ORDER BY status ASC, device_name ASC, id ASC`, [orgId])
    .map(row => {
      try { row.mac_references = JSON.parse(row.mac_references || '[]'); } catch (_) { row.mac_references = []; }
      return row;
    }));
});

router.post('/registered-devices', ownerOnly, (req, res) => {
  const orgId = Number(req.body.org_id || 0);
  const deviceId = String(req.body.device_id || '').trim().slice(0, 120);
  if (!orgId || !requireOrgAccess(req, res, orgId)) return;
  if (!/^DEV-[A-Z0-9-]{6,}$/i.test(deviceId)) {
    return res.status(400).json({ error: 'A valid device ID is required' });
  }
  const existing = get('SELECT * FROM registered_devices WHERE org_id=? AND device_id=?', [orgId, deviceId]);
  const now = new Date().toISOString();
  const deviceName = String(req.body.device_name || '').trim().slice(0, 120);
  const assignedTo = String(req.body.assigned_to || '').trim().slice(0, 120);
  const fingerprint = String(req.body.fingerprint || '').trim().slice(0, 120);
  const macReferences = JSON.stringify(Array.isArray(req.body.mac_references)
    ? req.body.mac_references.map(value => String(value).trim().slice(0, 40)).filter(Boolean).slice(0, 16)
    : []);
  if (existing?.status === 'active') return res.status(409).json({ error: 'This device is already registered' });
  if (existing) {
    run(`UPDATE registered_devices SET device_name=?,assigned_to=?,fingerprint=?,mac_references=?,
      status='active',registered_by=?,registered_at=?,revoked_by=NULL,revoked_at=NULL,
      wipe_requested_at=NULL,wipe_acknowledged_at=NULL,wipe_reason='' WHERE id=?`,
    [deviceName, assignedTo, fingerprint, macReferences, req.user.id, now, existing.id]);
  } else {
    run(`INSERT INTO registered_devices
      (org_id,device_id,device_name,assigned_to,fingerprint,mac_references,status,registered_by,registered_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,
    [orgId, deviceId, deviceName, assignedTo, fingerprint, macReferences, 'active', req.user.id, now]);
  }
  const saved = get('SELECT * FROM registered_devices WHERE org_id=? AND device_id=?', [orgId, deviceId]);
  run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
    [req.user.id, orgId, existing ? 'REACTIVATE_DEVICE' : 'REGISTER_DEVICE', 'registered_devices', saved.id,
      JSON.stringify({ device_id: deviceId, device_name: deviceName, assigned_to: assignedTo }), req.ip]);
  res.status(existing ? 200 : 201).json({ success: true, device: saved });
});

router.get('/registered-devices/policy', (req, res) => {
  const orgId = Number(req.query.org_id || 0);
  const deviceId = String(req.query.device_id || req.headers['x-tarangini-device-id'] || '').trim().slice(0, 120);
  if (!orgId || !requireOrgAccess(req, res, orgId)) return;
  if (!deviceId) return res.status(400).json({ error: 'device_id is required' });
  const device = get(`SELECT id,org_id,device_id,device_name,status,revoked_at,wipe_requested_at,
    wipe_acknowledged_at,wipe_reason,last_sync_at FROM registered_devices WHERE org_id=? AND device_id=?`, [orgId, deviceId]);
  if (!device) return res.status(403).json({ error: 'Device is not registered', registered: false, wipe_required: false });
  res.json({
    registered: true,
    active: device.status === 'active',
    wipe_required: device.status === 'revoked' && Boolean(device.wipe_requested_at) && !device.wipe_acknowledged_at,
    device
  });
});

router.post('/registered-devices/wipe-ack', (req, res) => {
  const orgId = Number(req.body.org_id || 0);
  const deviceId = String(req.body.device_id || req.headers['x-tarangini-device-id'] || '').trim().slice(0, 120);
  if (!orgId || !requireOrgAccess(req, res, orgId)) return;
  const device = get('SELECT * FROM registered_devices WHERE org_id=? AND device_id=?', [orgId, deviceId]);
  if (!device) return res.status(404).json({ error: 'Registered device not found' });
  if (!device.wipe_requested_at) return res.status(409).json({ error: 'No wipe is pending for this device' });
  const now = new Date().toISOString();
  run('UPDATE registered_devices SET wipe_acknowledged_at=? WHERE id=?', [now, device.id]);
  run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
    [req.user.id, orgId, 'DEVICE_WIPE_ACKNOWLEDGED', 'registered_devices', device.id,
      JSON.stringify({ device_id: deviceId, acknowledged_at: now }), req.ip]);
  res.json({ success: true, device_id: deviceId, wipe_acknowledged_at: now });
});

router.post('/registered-devices/:id/revoke', ownerOnly, (req, res) => {
  const id = Number(req.params.id || 0);
  const reason = String(req.body.reason || '').trim();
  if (!reason || reason.length < 5) return res.status(400).json({ error: 'A revocation reason of at least 5 characters is required' });
  const device = get('SELECT * FROM registered_devices WHERE id=?', [id]);
  if (!device) return res.status(404).json({ error: 'Registered device not found' });
  if (!requireOrgAccess(req, res, device.org_id)) return;
  const now = new Date().toISOString();
  run(`UPDATE registered_devices SET status='revoked',revoked_by=?,revoked_at=?,wipe_requested_at=?,
    wipe_acknowledged_at=NULL,wipe_reason=? WHERE id=?`, [req.user.id, now, now, reason.slice(0, 500), id]);
  run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,old_data,new_data,ip_address) VALUES (?,?,?,?,?,?,?,?)',
    [req.user.id, device.org_id, 'REVOKE_DEVICE', 'registered_devices', id, JSON.stringify({ status: device.status }),
      JSON.stringify({ status: 'revoked', reason }), req.ip]);
  res.json({ success: true, status: 'revoked', device_id: device.device_id });
});

const SNAPSHOT_SCHEMA_VERSION = 1;
const SNAPSHOT_ORG_TABLES = [
  'transaction_control_settings', 'parties', 'item_categories', 'items', 'bills', 'payments',
  'purchases', 'expenses', 'credit_debit_notes', 'stock_movements', 'purchase_orders',
  'financial_year_locks', 'accounts', 'journal_entries', 'job_service_categories',
  'job_service_subcategories', 'job_services', 'job_orders', 'operator_daily_logs',
  'job_intake_requests', 'warranty_replacements', 'warranty_service_centers'
];

function snapshotRows(table, orgId) {
  try { return all(`SELECT * FROM ${table} WHERE org_id=? ORDER BY id ASC`, [orgId]); }
  catch (_) { return []; }
}

function snapshotChildren(table, parentTable, foreignKey, orgId, selectedColumns = '*') {
  try {
    return all(`SELECT child.${selectedColumns} FROM ${table} child
      JOIN ${parentTable} parent ON parent.id=child.${foreignKey}
      WHERE parent.org_id=? ORDER BY child.id ASC`, [orgId]);
  } catch (_) { return []; }
}

router.get('/sync/snapshot', (req, res) => {
  const orgId = Number(req.query.org_id || 0);
  const deviceId = String(req.query.device_id || req.headers['x-tarangini-device-id'] || '').trim().slice(0, 120);
  if (!orgId || !requireOrgAccess(req, res, orgId)) return;
  const device = get('SELECT * FROM registered_devices WHERE org_id=? AND device_id=?', [orgId, deviceId]);
  if (!device || device.status !== 'active') {
    return res.status(403).json({ error: 'An active registered device is required', code: 'DEVICE_NOT_ACTIVE' });
  }
  const org = get(`SELECT id,display_name,registered_name,gstin,address,phone,email,gst_type,
    negative_stock_allowed,default_tax_inclusive,invoice_prefixes,invoice_theme,invoice_print_options,created_at
    FROM orgs WHERE id=?`, [orgId]);
  if (!org) return res.status(404).json({ error: 'Company not found' });
  const tables = Object.fromEntries(SNAPSHOT_ORG_TABLES.map(table => [table, snapshotRows(table, orgId)]));
  Object.assign(tables, {
    party_addresses: snapshotChildren('party_addresses', 'parties', 'party_id', orgId),
    payment_allocations: snapshotChildren('payment_allocations', 'payments', 'payment_id', orgId),
    journal_lines: snapshotChildren('journal_lines', 'journal_entries', 'entry_id', orgId),
    job_items: snapshotChildren('job_items', 'job_orders', 'job_id', orgId),
    job_estimates: snapshotChildren('job_estimates', 'job_orders', 'job_id', orgId),
    job_assignments: snapshotChildren('job_assignments', 'job_orders', 'job_id', orgId),
    job_status_events: snapshotChildren('job_status_events', 'job_orders', 'job_id', orgId),
    job_work_reports: snapshotChildren('job_work_reports', 'job_orders', 'job_id', orgId),
    job_material_consumptions: snapshotChildren('job_material_consumptions', 'job_orders', 'job_id', orgId),
    job_additions: snapshotChildren('job_additions', 'job_orders', 'job_id', orgId),
    job_customer_approvals: snapshotChildren('job_customer_approvals', 'job_orders', 'job_id', orgId),
    job_delivery_acknowledgements: snapshotChildren('job_delivery_acknowledgements', 'job_orders', 'job_id', orgId),
    job_internal_notes: snapshotChildren('job_internal_notes', 'job_orders', 'job_id', orgId),
    job_attachments: snapshotChildren('job_attachments', 'job_orders', 'job_id', orgId,
      'id,job_id,file_name,mime_type,byte_size,sha256,pixel_width,pixel_height,pdf_page_count,analysis_status,retention_state,created_at')
  });
  const revision = Number(get('SELECT COALESCE(MAX(revision),0) revision FROM sync_revisions WHERE org_id=?', [orgId])?.revision || 0);
  const generatedAt = new Date().toISOString();
  const payload = { schema_version: SNAPSHOT_SCHEMA_VERSION, org, revision, generated_at: generatedAt, tables };
  const checksum = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  transaction(() => {
    run(`INSERT INTO sync_cursors (org_id,device_id,last_pulled_revision,updated_at)
      VALUES (?,?,?,?) ON CONFLICT(org_id,device_id) DO UPDATE SET
      last_pulled_revision=excluded.last_pulled_revision,updated_at=excluded.updated_at`,
    [orgId, deviceId, revision, generatedAt]);
    run('UPDATE registered_devices SET last_sync_at=? WHERE id=?', [generatedAt, device.id]);
  });
  res.json({ ...payload, checksum_sha256: checksum });
});

router.get('/sync/delta', (req, res) => {
  const orgId = Number(req.query.org_id || 0);
  const deviceId = String(req.query.device_id || req.headers['x-tarangini-device-id'] || '').trim().slice(0, 120);
  const afterRevision = Math.max(0, Number(req.query.after_revision || 0));
  const requestedLimit = Number(req.query.limit || 500);
  const limit = Math.max(1, Math.min(1000, Number.isFinite(requestedLimit) ? requestedLimit : 500));
  if (!orgId || !requireOrgAccess(req, res, orgId)) return;
  const device = get("SELECT * FROM registered_devices WHERE org_id=? AND device_id=? AND status='active'", [orgId, deviceId]);
  if (!device) return res.status(403).json({ error: 'An active registered device is required', code: 'DEVICE_NOT_ACTIVE' });
  const currentRevision = Number(get(
    'SELECT COALESCE(MAX(revision),0) revision FROM sync_revisions WHERE org_id=?', [orgId]
  )?.revision || 0);
  const changes = all(`SELECT revision,entity_type,entity_id,operation,record_version,changed_at
    FROM sync_revisions WHERE org_id=? AND revision>? ORDER BY revision ASC LIMIT ?`,
  [orgId, afterRevision, limit]);
  const deliveredRevision = changes.length ? Number(changes[changes.length - 1].revision) : afterRevision;
  res.json({
    org_id: orgId,
    after_revision: afterRevision,
    delivered_revision: deliveredRevision,
    current_revision: currentRevision,
    has_more: deliveredRevision < currentRevision,
    snapshot_required: changes.length > 0,
    changes
  });
});

function parseConflict(row) {
  for (const key of ['main_snapshot', 'incoming_snapshot', 'merged_snapshot']) {
    try { row[key] = JSON.parse(row[key] || '{}'); } catch (_) { row[key] = {}; }
  }
  return row;
}

router.get('/sync-conflicts', ownerOnly, (req, res) => {
  const orgId = Number(req.query.org_id || 0);
  const status = String(req.query.status || 'pending').trim().toLowerCase();
  if (!orgId || !requireOrgAccess(req, res, orgId)) return;
  if (!['pending', 'resolved_main', 'queued_for_replay', 'replayed', 'all'].includes(status)) {
    return res.status(400).json({ error: 'Invalid conflict status' });
  }
  const rows = all(`SELECT c.*,r.replay_reference,r.reason replay_reason,r.created_at replay_created_at
    FROM sync_conflicts c LEFT JOIN sync_replay r ON r.conflict_id=c.id
    WHERE c.org_id=? ${status === 'all' ? '' : 'AND c.status=?'}
    ORDER BY CASE c.status WHEN 'pending' THEN 0 ELSE 1 END, c.created_at DESC`,
  status === 'all' ? [orgId] : [orgId, status]);
  res.json(rows.map(parseConflict));
});

router.post('/sync-conflicts/:id/resolve', ownerOnly, (req, res) => {
  const id = Number(req.params.id || 0);
  const decision = String(req.body.decision || '').trim().toUpperCase();
  const reason = String(req.body.reason || '').trim().slice(0, 1000);
  if (!id || !['KEEP_MAIN', 'MARK_FOR_REPLAY', 'MANUAL_MERGE'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be KEEP_MAIN, MARK_FOR_REPLAY or MANUAL_MERGE' });
  }
  if (reason.length < 10) return res.status(400).json({ error: 'A conflict reason of at least 10 characters is required' });
  let mergedSnapshot = null;
  if (decision === 'MANUAL_MERGE') {
    const candidate = req.body.merged_snapshot;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return res.status(400).json({ error: 'A merged object is required for manual merge' });
    }
    mergedSnapshot = JSON.stringify(candidate);
    if (mergedSnapshot.length > 100000) return res.status(400).json({ error: 'Merged snapshot is too large' });
  }
  const conflict = get('SELECT * FROM sync_conflicts WHERE id=?', [id]);
  if (!conflict) return res.status(404).json({ error: 'Sync conflict not found' });
  if (!requireOrgAccess(req, res, conflict.org_id)) return;
  if (conflict.status !== 'pending') return res.status(409).json({ error: 'Sync conflict is already resolved' });
  const nextStatus = decision === 'KEEP_MAIN' ? 'resolved_main' : 'queued_for_replay';
  const now = new Date().toISOString();
  run(`UPDATE sync_conflicts SET status=?,merged_snapshot=?,resolved_by=?,resolution_reason=?,resolved_at=? WHERE id=?`,
    [nextStatus, mergedSnapshot, req.user.id, reason, now, id]);
  run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,old_data,new_data,ip_address) VALUES (?,?,?,?,?,?,?,?)',
    [req.user.id, conflict.org_id, 'SYNC_CONFLICT_RESOLVED', 'sync_conflicts', id,
      JSON.stringify({ status: conflict.status }), JSON.stringify({ status: nextStatus, decision, reason, merged_snapshot: mergedSnapshot ? JSON.parse(mergedSnapshot) : null }), req.ip]);
  const saved = get('SELECT * FROM sync_conflicts WHERE id=?', [id]);
  res.json({ success: true, decision, applied: false, requires_replay: decision !== 'KEEP_MAIN', conflict: parseConflict(saved) });
});

router.post('/sync-conflicts/:id/complete-replay', ownerOnly, (req, res) => {
  const id = Number(req.params.id || 0);
  const reason = String(req.body.reason || '').trim().slice(0, 1000);
  const replayReference = String(req.body.replay_reference || '').trim().slice(0, 160);
  if (!id || reason.length < 10) return res.status(400).json({ error: 'A replay reason of at least 10 characters is required' });
  if (!replayReference) return res.status(400).json({ error: 'replay_reference is required' });
  const conflict = get('SELECT * FROM sync_conflicts WHERE id=?', [id]);
  if (!conflict) return res.status(404).json({ error: 'Sync conflict not found' });
  if (!requireOrgAccess(req, res, conflict.org_id)) return;
  if (conflict.status !== 'queued_for_replay') return res.status(409).json({ error: 'Conflict is not queued for replay' });
  const now = new Date().toISOString();
  run(`UPDATE sync_conflicts SET status='replayed',resolution_reason=?,resolved_by=?,resolved_at=? WHERE id=?`,
    [`${reason} | Replay: ${replayReference}`, req.user.id, now, id]);
  run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,old_data,new_data,ip_address) VALUES (?,?,?,?,?,?,?,?)',
    [req.user.id, conflict.org_id, 'SYNC_CONFLICT_REPLAY_COMPLETED', 'sync_conflicts', id,
      JSON.stringify({ status: conflict.status }), JSON.stringify({ status: 'replayed', replay_reference: replayReference, reason }), req.ip]);
  run(`INSERT INTO sync_replay
    (conflict_id,change_id,org_id,entity_type,entity_id,replay_reference,reason,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`,
  [conflict.id, conflict.change_id, conflict.org_id, conflict.entity_type, conflict.entity_id,
   replayReference, reason, req.user.id, now]);
  res.json({ success: true, applied: false, replay_recorded: true, conflict: parseConflict(get('SELECT * FROM sync_conflicts WHERE id=?', [id])) });
});

// Offline financial work is deliberately a review queue, not an offline ledger.
// A draft can be submitted and approved, but only a future controlled posting
// workflow may change payments, stock, or accounting journals.
const OFFLINE_FINANCIAL_TYPES = new Set(['PAYMENT_RECEIVED', 'PAYMENT_VOUCHER', 'SALE', 'STOCK_MOVEMENT', 'PURCHASE']);
const OFFLINE_FINANCIAL_STATES = new Set(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'POSTED']);

function parseDraftPayload(row) {
  try { row.payload = JSON.parse(row.payload || '{}'); } catch (_) { row.payload = {}; }
  return row;
}

function offlineFinancialPreflight(draft) {
  let payload = {};
  try { payload = JSON.parse(draft.payload || '{}'); } catch (_) {}
  const problems = [];
  const dateValue = payload.payment_date || payload.bill_date || payload.purchase_date || payload.date || '';
  if (dateValue && isPeriodLocked(draft.org_id, dateValue)) {
    problems.push(`Financial year ${getFY(dateValue)} is locked`);
  }
  if (['PAYMENT_RECEIVED', 'PAYMENT_VOUCHER'].includes(draft.entity_type) && payload.reference) {
    const duplicate = get(`SELECT id,payment_number FROM payments
      WHERE org_id=? AND deleted=0 AND lower(trim(reference))=lower(trim(?))`, [draft.org_id, String(payload.reference).trim()]);
    if (duplicate) problems.push(`Payment reference already exists (${duplicate.payment_number || duplicate.id})`);
  }
  if (['SALE', 'STOCK_MOVEMENT'].includes(draft.entity_type)) {
    const org = get('SELECT negative_stock_allowed FROM orgs WHERE id=?', [draft.org_id]);
    if (org && Number(org.negative_stock_allowed) === 0) {
      const lines = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.lines) ? payload.lines : [];
      lines.forEach(line => {
        const itemId = Number(line.item_id || line.id || 0);
        const qtyOut = Number(line.qty_out ?? line.quantity ?? line.qty ?? 0);
        if (!itemId || qtyOut <= 0) return;
        const item = get(`SELECT i.name, i.opening_stock + COALESCE(SUM(sm.qty_in-sm.qty_out),0) AS available
          FROM items i LEFT JOIN stock_movements sm ON sm.item_id=i.id AND sm.org_id=i.org_id
          WHERE i.id=? AND i.org_id=? GROUP BY i.id`, [itemId, draft.org_id]);
        if (!item) problems.push(`Item ${itemId} is not available in this company`);
        else if (Number(item.available) < qtyOut) problems.push(`${item.name}: stock ${item.available} is below requested ${qtyOut}`);
      });
    }
  }
  return problems;
}

router.post('/offline-financial-drafts', (req, res) => {
  const orgId = Number(req.body.org_id || 0);
  const draftId = cleanText(req.body.draft_id, 160);
  const deviceId = cleanText(req.body.device_id || req.headers['x-device-id'], 160);
  const entityType = cleanText(req.body.entity_type, 40).toUpperCase();
  const provisionalNumber = cleanText(req.body.provisional_number, 80);
  const payload = req.body.payload && typeof req.body.payload === 'object' ? req.body.payload : null;
  const baseVersion = req.body.base_version == null ? null : Number(req.body.base_version);
  if (!orgId || !requireOrgAccess(req, res, orgId)) return;
  if (!draftId || !deviceId || !OFFLINE_FINANCIAL_TYPES.has(entityType) || !payload) {
    return res.status(400).json({ error: 'draft_id, device_id, entity_type, and payload are required' });
  }
  const registeredDevice = get(`SELECT id,status FROM registered_devices
    WHERE org_id=? AND device_id=?`, [orgId, deviceId]);
  if (!registeredDevice || registeredDevice.status !== 'active') {
    return res.status(403).json({
      error: registeredDevice ? 'This device is revoked and cannot synchronize financial work' : 'Register this device before synchronizing financial work',
      code: registeredDevice ? 'DEVICE_REVOKED' : 'DEVICE_NOT_REGISTERED'
    });
  }
  if (JSON.stringify(payload).length > 500000) return res.status(413).json({ error: 'Offline draft payload is too large' });

  const existing = get('SELECT * FROM offline_financial_drafts WHERE draft_id=?', [draftId]);
  const serialized = JSON.stringify(payload);
  if (existing) {
    if (existing.org_id !== orgId || existing.device_id !== deviceId || existing.payload !== serialized) {
      return res.status(409).json({ error: 'Draft ID is already used with different data', conflict: true });
    }
    return res.json({ idempotent: true, draft: parseDraftPayload(existing) });
  }

  const now = new Date().toISOString();
  const result = run(`INSERT INTO offline_financial_drafts
    (draft_id,org_id,device_id,entity_type,provisional_number,payload,state,base_version,created_by,submitted_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?, 'SUBMITTED',?,?,?,?,?)`,
  [draftId, orgId, deviceId, entityType, provisionalNumber, serialized, baseVersion, req.user.id, now, now, now]);
  run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
    [req.user.id, orgId, 'OFFLINE_FINANCIAL_DRAFT_SUBMITTED', 'offline_financial_drafts', result.lastInsertRowid,
      JSON.stringify({ draft_id: draftId, device_id: deviceId, entity_type: entityType, state: 'SUBMITTED' }), req.ip]);
  const saved = get('SELECT * FROM offline_financial_drafts WHERE id=?', [result.lastInsertRowid]);
  res.status(201).json({ idempotent: false, draft: parseDraftPayload(saved) });
});

router.get('/offline-financial-drafts/reconciliation', ownerOnly, (req, res) => {
  const orgId = Number(req.query.org_id || 0);
  if (!orgId || !requireOrgAccess(req, res, orgId)) return;
  const rows = all('SELECT state,entity_type,payload FROM offline_financial_drafts WHERE org_id=?', [orgId]);
  const conflicts = all(`SELECT status,COUNT(*) count FROM sync_conflicts WHERE org_id=? GROUP BY status`, [orgId]);
  const byState = {};
  let unpostedAmount = 0;
  rows.forEach(row => {
    byState[row.state] = (byState[row.state] || 0) + 1;
    if (row.state !== 'POSTED') {
      try {
        const payload = JSON.parse(row.payload || '{}');
        unpostedAmount += Number(payload.amount || payload.grand_total || 0);
      } catch (_) {}
    }
  });
  res.json({
    total_drafts: rows.length,
    by_state: byState,
    unposted_amount: round(unpostedAmount),
    conflicts: Object.fromEntries(conflicts.map(row => [row.status, Number(row.count)])),
    final_posting_enabled: true,
    posting_capabilities: {
      PAYMENT_RECEIVED: true,
      PAYMENT_VOUCHER: true,
      SALE: true,
      PURCHASE: true,
      STOCK_MOVEMENT: true
    },
    generated_at: new Date().toISOString()
  });
});

router.get('/offline-financial-drafts', ownerOnly, (req, res) => {
  const orgId = Number(req.query.org_id || 0);
  const state = cleanText(req.query.state, 20).toUpperCase();
  if (!orgId || !requireOrgAccess(req, res, orgId)) return;
  if (state && !OFFLINE_FINANCIAL_STATES.has(state)) return res.status(400).json({ error: 'Invalid draft state' });
  const rows = all(`SELECT d.*, u.username AS created_by_name, r.username AS reviewed_by_name
    FROM offline_financial_drafts d
    LEFT JOIN users u ON u.id=d.created_by
    LEFT JOIN users r ON r.id=d.reviewed_by
    WHERE d.org_id=? ${state ? 'AND d.state=?' : ''}
    ORDER BY CASE d.state WHEN 'SUBMITTED' THEN 0 WHEN 'DRAFT' THEN 1 WHEN 'APPROVED' THEN 2 ELSE 3 END,
      d.created_at DESC`, state ? [orgId, state] : [orgId]);
  res.json(rows.map(parseDraftPayload));
});

router.post('/offline-financial-drafts/:id/review', ownerOnly, (req, res) => {
  const id = Number(req.params.id || 0);
  const decision = cleanText(req.body.decision, 20).toUpperCase();
  const reason = cleanText(req.body.reason, 1000);
  if (!id || !['APPROVE', 'REJECT'].includes(decision)) return res.status(400).json({ error: 'decision must be APPROVE or REJECT' });
  if (reason.length < 10) return res.status(400).json({ error: 'A review reason of at least 10 characters is required' });
  const draft = get('SELECT * FROM offline_financial_drafts WHERE id=?', [id]);
  if (!draft) return res.status(404).json({ error: 'Offline financial draft not found' });
  if (!requireOrgAccess(req, res, draft.org_id)) return;
  if (!['SUBMITTED', 'DRAFT'].includes(draft.state)) {
    return res.status(409).json({ error: `Draft is already ${draft.state.toLowerCase()}` });
  }
  if (decision === 'APPROVE') {
    const preflightProblems = offlineFinancialPreflight(draft);
    if (preflightProblems.length) {
      run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
        [req.user.id, draft.org_id, 'OFFLINE_FINANCIAL_DRAFT_PREFLIGHT_BLOCKED', 'offline_financial_drafts', id,
          JSON.stringify({ state: draft.state, problems: preflightProblems }), req.ip]);
      return res.status(422).json({ error: 'Offline financial draft failed preflight validation', problems: preflightProblems });
    }
  }
  const nextState = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  const now = new Date().toISOString();
  run(`UPDATE offline_financial_drafts SET state=?,reviewed_by=?,reviewed_at=?,review_reason=?,updated_at=? WHERE id=?`,
    [nextState, req.user.id, now, reason, now, id]);
  run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,old_data,new_data,ip_address) VALUES (?,?,?,?,?,?,?,?)',
    [req.user.id, draft.org_id, 'OFFLINE_FINANCIAL_DRAFT_REVIEWED', 'offline_financial_drafts', id,
      JSON.stringify({ state: draft.state }), JSON.stringify({ state: nextState, reason }), req.ip]);
  const saved = get('SELECT * FROM offline_financial_drafts WHERE id=?', [id]);
  res.json({ success: true, ledger_posted: false, draft: parseDraftPayload(saved) });
});

router.post('/offline-financial-drafts/:id/post', ownerOnly, (req, res) => {
  const id = Number(req.params.id || 0);
  const draft = get('SELECT * FROM offline_financial_drafts WHERE id=?', [id]);
  if (!draft) return res.status(404).json({ error: 'Offline financial draft not found' });
  if (!requireOrgAccess(req, res, draft.org_id)) return;
  if (draft.state === 'POSTED') {
    return res.json({
      success: true, idempotent: true, entity_type: draft.entity_type,
      entity_id: draft.posted_entity_id, number: draft.posted_number,
      payment_id: ['PAYMENT_RECEIVED','PAYMENT_VOUCHER'].includes(draft.entity_type) ? draft.posted_entity_id : undefined,
      payment_number: ['PAYMENT_RECEIVED','PAYMENT_VOUCHER'].includes(draft.entity_type) ? draft.posted_number : undefined,
      bill_id: draft.entity_type === 'SALE' ? draft.posted_entity_id : undefined,
      bill_number: draft.entity_type === 'SALE' ? draft.posted_number : undefined,
      purchase_id: draft.entity_type === 'PURCHASE' ? draft.posted_entity_id : undefined,
      purchase_number: draft.entity_type === 'PURCHASE' ? draft.posted_number : undefined,
      stock_adjustment_id: draft.entity_type === 'STOCK_MOVEMENT' ? draft.posted_entity_id : undefined,
      stock_adjustment_number: draft.entity_type === 'STOCK_MOVEMENT' ? draft.posted_number : undefined
    });
  }
  if (draft.state !== 'APPROVED') return res.status(409).json({ error: 'Only an approved draft can be posted' });
  if (!['PAYMENT_RECEIVED', 'PAYMENT_VOUCHER', 'SALE', 'PURCHASE', 'STOCK_MOVEMENT'].includes(draft.entity_type)) {
    return res.status(422).json({ error: 'Unsupported offline financial draft type' });
  }
  const problems = offlineFinancialPreflight(draft);
  if (problems.length) return res.status(422).json({ error: 'Offline financial draft failed posting preflight validation', problems });
  let payload = {};
  try { payload = JSON.parse(draft.payload || '{}'); } catch (_) {}

  if (draft.entity_type === 'SALE') {
    const billDate = String(payload.bill_date || payload.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    if (isPeriodLocked(draft.org_id, billDate)) return res.status(423).json({ error: `Financial year ${getFY(billDate)} is locked` });
    const org = get('SELECT * FROM orgs WHERE id=?', [draft.org_id]);
    if (!org) return res.status(404).json({ error: 'Company not found' });
    const party = payload.party_id ? partyForOrg(payload.party_id, draft.org_id) : null;
    if (payload.party_id && !party) return res.status(422).json({ error: 'Customer does not belong to this company' });
    const taxInclusive = Boolean(payload.tax_inclusive && org.gst_type === 'regular');
    const items = (Array.isArray(payload.items) ? payload.items : []).filter(item => Number(item.qty) > 0).map((item, index) => {
      if (item.item_id && !get('SELECT id FROM items WHERE id=? AND org_id=? AND active=1', [item.item_id, draft.org_id])) {
        throw new Error(`Item ${item.item_name || item.item_id} is unavailable in this company`);
      }
      const clean = taxableLine({ ...item, gst_rate: org.gst_type === 'regular' ? Number(item.gst_rate || 0) : 0 }, taxInclusive);
      return { ...clean, sno: index + 1 };
    });
    if (!items.length) return res.status(422).json({ error: 'Sale must contain at least one item' });
    const taxable = round(items.reduce((sum, item) => sum + Number(item.amount || 0), 0));
    const totalTax = round(items.reduce((sum, item) => sum + Number(item.tax || 0), 0));
    const totalBeforeRound = round(taxable + totalTax);
    const roundOff = payload.round_off_enabled === false ? 0 : round(Math.round(totalBeforeRound) - totalBeforeRound);
    const grandTotal = round(totalBeforeRound + roundOff);
    if (grandTotal <= 0) return res.status(422).json({ error: 'Sale total must be greater than zero' });
    try {
      const saved = transaction(() => {
        const sequence = sequenceNumber(draft.org_id, 'SALE', billDate);
        const partySnapshot = party ? JSON.stringify({
          name: party.name, registered_name: party.registered_name, address: party.address,
          city: party.city, state: party.state, gstin: party.gstin, gst_type: party.gst_type,
          phone: party.phone, email: party.email
        }) : null;
        const bankDetails = JSON.stringify({ bank_name: org.bank_name, account_no: org.account_no,
          branch: org.branch, ifsc: org.ifsc, upi_id: org.upi_id });
        const result = run(
          `INSERT INTO bills
           (org_id,format,bill_number,bill_date,fy,party_id,party_snapshot,payment_mode,items_json,subtotal,
            taxable_amount,tax_rate,cgst,sgst,igst,total_tax,grand_total,round_off,total_in_words,note_header,
            note_footer,description,custom_data,split_payments,cost_total,bank_details,status,offline_id,
            offline_device,offline_created_at,tax_inclusive,created_by)
           VALUES (?,'SALE',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [draft.org_id, sequence.number, billDate, sequence.fy, party?.id || null, partySnapshot,
           cleanText(payload.payment_mode || 'credit', 20).toLowerCase(), JSON.stringify(items),
           taxInclusive ? round(taxable + totalTax) : taxable, taxable,
           items.length ? Number(items[0].gst_rate || 0) : 0, round(totalTax / 2), round(totalTax / 2), 0,
           totalTax, grandTotal, roundOff, '', org.note_header || '', org.note_footer || '',
           cleanText(payload.description || payload.narration, 500), JSON.stringify(payload.custom_data || {}), '[]',
           round(items.reduce((sum, item) => {
             const master = item.item_id ? get('SELECT last_purchase_price FROM items WHERE id=?', [item.item_id]) : null;
             return sum + Number(item.qty || 0) * Number(master?.last_purchase_price || 0);
           }, 0)), bankDetails, 'saved', draft.draft_id, draft.device_id, draft.created_at,
           taxInclusive ? 1 : 0, req.user.id]
        );
        const bill = get('SELECT * FROM bills WHERE id=?', [result.lastInsertRowid]);
        postBill(bill);
        replaceStockMovements({ orgId: draft.org_id, sourceType: 'bill', sourceId: bill.id,
          date: billDate, refNumber: bill.bill_number, items, direction: 'out' });
        run(`UPDATE offline_financial_drafts SET state='POSTED',posted_entity_id=?,posted_number=?,updated_at=datetime('now') WHERE id=?`,
          [bill.id, bill.bill_number, id]);
        run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
          [req.user.id, draft.org_id, 'OFFLINE_FINANCIAL_DRAFT_POSTED', 'offline_financial_drafts', id,
            JSON.stringify({ entity_type: 'SALE', bill_id: bill.id, bill_number: bill.bill_number }), req.ip]);
        return { entity_type: 'SALE', entity_id: bill.id, number: bill.bill_number, bill_id: bill.id, bill_number: bill.bill_number };
      });
      return res.json({ success: true, idempotent: false, ...saved,
        draft: parseDraftPayload(get('SELECT * FROM offline_financial_drafts WHERE id=?', [id])) });
    } catch (error) { return res.status(422).json({ error: error.message }); }
  }

  if (draft.entity_type === 'PURCHASE') {
    const purchaseDate = String(payload.purchase_date || payload.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    if (isPeriodLocked(draft.org_id, purchaseDate)) return res.status(423).json({ error: `Financial year ${getFY(purchaseDate)} is locked` });
    const org = get('SELECT * FROM orgs WHERE id=?', [draft.org_id]);
    if (!org) return res.status(404).json({ error: 'Company not found' });
    const party = payload.party_id ? partyForOrg(payload.party_id, draft.org_id) : null;
    if (payload.party_id && !party) return res.status(422).json({ error: 'Supplier does not belong to this company' });
    const taxInclusive = Boolean(payload.tax_inclusive && org.gst_type === 'regular');
    try {
      const items = (Array.isArray(payload.items) ? payload.items : []).filter(item => Number(item.qty) > 0).map(item => {
        if (item.item_id && !get('SELECT id FROM items WHERE id=? AND org_id=? AND active=1', [item.item_id, draft.org_id])) {
          throw new Error(`Item ${item.item_name || item.item_id} is unavailable in this company`);
        }
        return taxableLine({ ...item, gst_rate: org.gst_type === 'regular' ? Number(item.gst_rate || 0) : 0 }, taxInclusive);
      });
      if (!items.length) return res.status(422).json({ error: 'Purchase must contain at least one item' });
      const taxable = round(items.reduce((sum, item) => sum + Number(item.amount || 0), 0));
      const totalTax = round(items.reduce((sum, item) => sum + Number(item.tax || 0), 0));
      const totalBeforeRound = round(taxable + totalTax);
      const roundOff = payload.round_off_enabled === false ? 0 : round(Math.round(totalBeforeRound) - totalBeforeRound);
      const grandTotal = round(totalBeforeRound + roundOff);
      if (grandTotal <= 0) return res.status(422).json({ error: 'Purchase total must be greater than zero' });
      const saved = transaction(() => {
        const sequence = sequenceNumber(draft.org_id, 'PURCHASE', purchaseDate);
        const result = run(
          `INSERT INTO purchases
           (org_id,purchase_number,supplier_invoice,purchase_date,due_date,fy,party_id,items_json,
            taxable_amount,cgst,sgst,igst,total_tax,grand_total,round_off,payment_mode,narration,tax_inclusive,created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [draft.org_id, sequence.number, cleanText(payload.supplier_invoice || payload.reference, 120),
           purchaseDate, payload.due_date || null, sequence.fy, party?.id || null, JSON.stringify(items),
           taxable, round(totalTax / 2), round(totalTax / 2), 0, totalTax, grandTotal, roundOff,
           cleanText(payload.payment_mode || 'credit', 20).toLowerCase(), cleanText(payload.narration, 500),
           taxInclusive ? 1 : 0, req.user.id]
        );
        const purchase = get('SELECT * FROM purchases WHERE id=?', [result.lastInsertRowid]);
        postPurchase(purchase);
        replaceStockMovements({ orgId: draft.org_id, sourceType: 'purchase', sourceId: purchase.id,
          date: purchaseDate, refNumber: purchase.purchase_number, items, direction: 'in' });
        run(`UPDATE offline_financial_drafts SET state='POSTED',posted_entity_id=?,posted_number=?,updated_at=datetime('now') WHERE id=?`,
          [purchase.id, purchase.purchase_number, id]);
        run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
          [req.user.id, draft.org_id, 'OFFLINE_FINANCIAL_DRAFT_POSTED', 'offline_financial_drafts', id,
            JSON.stringify({ entity_type: 'PURCHASE', purchase_id: purchase.id, purchase_number: purchase.purchase_number }), req.ip]);
        return { entity_type: 'PURCHASE', entity_id: purchase.id, number: purchase.purchase_number,
          purchase_id: purchase.id, purchase_number: purchase.purchase_number };
      });
      return res.json({ success: true, idempotent: false, ...saved,
        draft: parseDraftPayload(get('SELECT * FROM offline_financial_drafts WHERE id=?', [id])) });
    } catch (error) { return res.status(422).json({ error: error.message }); }
  }

  if (draft.entity_type === 'STOCK_MOVEMENT') {
    const movementDate = String(payload.movement_date || payload.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    if (isPeriodLocked(draft.org_id, movementDate)) return res.status(423).json({ error: `Financial year ${getFY(movementDate)} is locked` });
    let lines;
    try {
      lines = (Array.isArray(payload.items) ? payload.items : Array.isArray(payload.lines) ? payload.lines : []).map(line => {
        const itemId = Number(line.item_id || line.id || 0);
        const item = get('SELECT id,name FROM items WHERE id=? AND org_id=? AND active=1', [itemId, draft.org_id]);
        if (!item) throw new Error(`Item ${line.item_name || itemId} is unavailable in this company`);
        const qtyIn = Math.max(0, Number(line.qty_in || (String(line.direction).toLowerCase() === 'in' ? line.qty || line.quantity : 0) || 0));
        const qtyOut = Math.max(0, Number(line.qty_out || (String(line.direction).toLowerCase() === 'out' ? line.qty || line.quantity : 0) || 0));
        if ((qtyIn > 0) === (qtyOut > 0)) throw new Error(`${item.name}: enter either quantity in or quantity out`);
        return { item_id: item.id, item_name: item.name, qty_in: qtyIn, qty_out: qtyOut, rate: round(line.rate) };
      });
    } catch (error) { return res.status(422).json({ error: error.message }); }
    if (!lines.length) return res.status(422).json({ error: 'Stock adjustment must contain at least one item' });
    try {
      const saved = transaction(() => {
        const sequence = sequenceNumber(draft.org_id, 'STOCK_ADJUSTMENT', movementDate);
        lines.forEach(line => run(
          `INSERT INTO stock_movements
           (org_id,item_id,movement_date,source_type,source_id,ref_number,qty_in,qty_out,rate)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [draft.org_id, line.item_id, movementDate, 'offline_stock_adjustment', draft.id,
           sequence.number, line.qty_in, line.qty_out, line.rate]
        ));
        run(`UPDATE offline_financial_drafts SET state='POSTED',posted_entity_id=?,posted_number=?,updated_at=datetime('now') WHERE id=?`,
          [draft.id, sequence.number, id]);
        run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
          [req.user.id, draft.org_id, 'OFFLINE_FINANCIAL_DRAFT_POSTED', 'offline_financial_drafts', id,
            JSON.stringify({ entity_type: 'STOCK_MOVEMENT', adjustment_number: sequence.number, lines,
              note: cleanText(payload.narration || payload.note, 500) }), req.ip]);
        return { entity_type: 'STOCK_MOVEMENT', entity_id: draft.id, number: sequence.number,
          stock_adjustment_id: draft.id, stock_adjustment_number: sequence.number };
      });
      return res.json({ success: true, idempotent: false, ...saved,
        draft: parseDraftPayload(get('SELECT * FROM offline_financial_drafts WHERE id=?', [id])) });
    } catch (error) { return res.status(422).json({ error: error.message }); }
  }

  const amount = round(payload.amount);
  if (amount <= 0) return res.status(422).json({ error: 'Payment amount must be greater than zero' });
  const paymentDate = String(payload.payment_date || payload.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  if (isPeriodLocked(draft.org_id, paymentDate)) return res.status(423).json({ error: `Financial year ${getFY(paymentDate)} is locked` });
  const type = draft.entity_type === 'PAYMENT_VOUCHER' ? 'paid' : 'received';
  const mode = String(payload.mode || 'cash').toLowerCase();
  const reference = cleanText(payload.reference, 160);
  if (mode !== 'cash' && !reference) return res.status(422).json({ error: 'Payment reference is required for non-cash posting' });
  if (reference) {
    const duplicate = get(`SELECT id,payment_number FROM payments
      WHERE org_id=? AND deleted=0 AND lower(trim(reference))=lower(trim(?))`, [draft.org_id, reference]);
    if (duplicate) return res.status(409).json({ error: `Payment reference already exists (${duplicate.payment_number || duplicate.id})` });
  }
  const party = payload.party_id ? partyForOrg(payload.party_id, draft.org_id) : null;
  if (payload.party_id && !party) return res.status(422).json({ error: 'Customer does not belong to this company' });
  const allocations = Array.isArray(payload.linked_bills) ? payload.linked_bills : [];
  const requestedAllocation = allocations.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  if (requestedAllocation > amount + 0.01) return res.status(422).json({ error: 'Linked invoice allocation cannot exceed payment amount' });
  const saved = transaction(() => {
    const fy = getFY(paymentDate);
    const prefix = type === 'paid' ? 'PV' : 'PR';
    let sequence = get('SELECT * FROM bill_sequences WHERE org_id=? AND format=? AND fy=?', [draft.org_id, prefix, fy]);
    if (!sequence) {
      run('INSERT INTO bill_sequences (org_id,format,fy,prefix,last_number) VALUES (?,?,?,?,0)', [draft.org_id, prefix, fy, prefix]);
      sequence = { last_number: 0 };
    }
    const nextNumber = Number(sequence.last_number || 0) + 1;
    run('UPDATE bill_sequences SET last_number=? WHERE org_id=? AND format=? AND fy=?', [nextNumber, draft.org_id, prefix, fy]);
    const org = get('SELECT display_name FROM orgs WHERE id=?', [draft.org_id]);
    const orgCode = String(org?.display_name || 'ORG').replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase() || 'ORG';
    const paymentNumber = `${orgCode}/${prefix}/${fy}/${String(nextNumber).padStart(4, '0')}`;
    const actualAllocations = [];
    allocations.forEach(allocation => {
      const bill = get('SELECT * FROM bills WHERE id=? AND org_id=? AND deleted=0', [allocation.bill_id, draft.org_id]);
      if (!bill) throw new Error(`Invoice ${allocation.bill_id} was not found`);
      const allocatable = Math.min(Number(allocation.amount || 0), Number(billSettlement(bill).outstanding || 0));
      if (allocatable > 0) actualAllocations.push({ bill_id: bill.id, amount: round(allocatable) });
    });
    const result = run(`INSERT INTO payments
      (org_id,payment_number,payment_date,fy,party_id,party_snapshot,type,mode,amount,reference,linked_bills,narration,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [draft.org_id, paymentNumber, paymentDate, fy, party?.id || null,
      party ? JSON.stringify({ name: party.name, address: party.address, gstin: party.gstin }) : null,
      type, mode, amount, reference || null, JSON.stringify(actualAllocations), cleanText(payload.narration || payload.note, 500) || null, req.user.id]);
    let remaining = amount;
    actualAllocations.forEach(allocation => {
      const allocated = Math.min(remaining, allocation.amount);
      if (allocated > 0) {
        run('INSERT INTO payment_allocations (payment_id,bill_id,amount) VALUES (?,?,?)', [result.lastInsertRowid, allocation.bill_id, allocated]);
        remaining = round(remaining - allocated);
      }
    });
    postPayment(get('SELECT * FROM payments WHERE id=?', [result.lastInsertRowid]));
    run(`UPDATE offline_financial_drafts SET state='POSTED',posted_entity_id=?,posted_number=?,updated_at=datetime('now') WHERE id=?`,
      [result.lastInsertRowid, paymentNumber, id]);
    run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
      [req.user.id, draft.org_id, 'OFFLINE_FINANCIAL_DRAFT_POSTED', 'offline_financial_drafts', id,
        JSON.stringify({ payment_id: result.lastInsertRowid, payment_number: paymentNumber, remaining }), req.ip]);
    return { id: result.lastInsertRowid, payment_number: paymentNumber, unallocated_amount: remaining };
  });
  res.json({ success: true, idempotent: false, ...saved, draft: parseDraftPayload(get('SELECT * FROM offline_financial_drafts WHERE id=?', [id])) });
});
const cleanText = (value, limit = 500) => String(value || '').trim().slice(0, limit);
const pageParams = (query, defaultLimit = 200, maxLimit = 500) => {
  const requested = Number(query.limit || defaultLimit);
  const limit = Math.max(1, Math.min(maxLimit, Number.isFinite(requested) ? requested : defaultLimit));
  const offset = Math.max(0, Number(query.offset || 0) || 0);
  return { limit, offset };
};
const taxableLine = (item, taxInclusive) => {
  const qty = Number(item.qty || 0);
  const enteredRate = Number(item.entered_rate ?? item.rate ?? 0);
  const gstRate = Number(item.gst_rate || 0);
  const gross = round(qty * enteredRate);
  const tax = taxInclusive && gstRate > 0
    ? round(gross * gstRate / (100 + gstRate))
    : round(gross * gstRate / 100);
  const taxable = taxInclusive ? round(gross - tax) : gross;
  return {
    ...item, qty, entered_rate: enteredRate,
    rate: qty > 0 ? round(taxable / qty) : 0,
    amount: taxable, gross_amount: taxInclusive ? gross : round(gross + tax),
    gst_rate: gstRate, tax
  };
};
const setting = key => get('SELECT value FROM system_settings WHERE key=?', [key])?.value || '';
const putSetting = (key, value, userId) => run(
  `INSERT INTO system_settings (key,value,updated_by,updated_at) VALUES (?,?,?,datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=datetime('now')`,
  [key, String(value ?? ''), userId]
);

function runCommand(command, args = [], timeout = 12000) {
  return new Promise(resolve => {
    execFile(command, args, { windowsHide: true, timeout }, (error, stdout = '', stderr = '') => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        timed_out: Boolean(error?.killed),
        output: `${stdout}\n${stderr}`.trim()
      });
    });
  });
}

function parseDscInfo(text) {
  const output = String(text || '');
  const certMatch = output.match(/================ Certificate\s+\d+ ================[\s\S]*?(?=\n=|\nCertUtil:|$)/);
  const certBlock = certMatch?.[0] || output;
  const subject = certBlock.match(/Subject:\s*(.+)/)?.[1]?.trim() || '';
  const issuer = certBlock.match(/Issuer:\s*(.+)/)?.[1]?.trim() || '';
  const serialNumber = certBlock.match(/Serial Number:\s*(.+)/)?.[1]?.trim() || '';
  const thumbprint = certBlock.match(/Cert Hash\(sha1\):\s*([A-Fa-f0-9]+)/)?.[1]?.trim() || '';
  const provider = certBlock.match(/Provider\s*=\s*(.+)/)?.[1]?.trim()
    || output.match(/Provider Name:\s*(HyperPKI[^\r\n]+)/)?.[1]?.trim()
    || '';
  const keyContainer = certBlock.match(/Key Container\s*=\s*(.+)/)?.[1]?.trim() || '';
  const reader = output.match(/Reader:\s*(.+)/)?.[1]?.trim()
    || output.match(/\d+:\s*(HYPER[^\r\n]+)/)?.[1]?.trim()
    || '';
  const card = output.match(/Card:\s*(.+)/)?.[1]?.trim() || '';
  const notAfter = certBlock.match(/NotAfter:\s*(.+)/)?.[1]?.trim() || '';
  const certificateFound = Boolean(subject || thumbprint);
  return {
    reader,
    card,
    provider,
    key_container: keyContainer,
    certificate_found: certificateFound,
    subject,
    issuer,
    serial_number: serialNumber,
    thumbprint,
    not_after: notAfter,
    raw_hint: output.includes('No AT_SIGNATURE key') ? 'Certificate is available as AT_KEYEXCHANGE. PDF signing may need provider support for this key spec.' : ''
  };
}

function sequenceNumber(orgId, type, dateValue) {
  const fy = getFY(dateValue);
  const code = get('SELECT display_name FROM orgs WHERE id=?', [orgId])?.display_name?.slice(0, 3).toUpperCase() || 'ORG';
  const standardPrefix = { SALE: 'SB', QUOT: 'QT', JOURNAL: 'JV', PURCHASE: 'PUR', EXPENSE: 'EXP',
    CREDIT_NOTE: 'CN', DEBIT_NOTE: 'DN', STOCK_ADJUSTMENT: 'SA' }[type] || type;
  const org = get('SELECT * FROM orgs WHERE id=?', [orgId]);
  const prefix = ['SALE', 'PP', 'QUOT', 'DC', 'PI'].includes(type)
    ? invoicePrefix(org, type)
    : standardPrefix;
  const current = get('SELECT * FROM bill_sequences WHERE org_id=? AND format=? AND fy=?', [orgId, type, fy]);
  const next = Number(current?.last_number || 0) + 1;
  if (current) run('UPDATE bill_sequences SET last_number=?,prefix=? WHERE id=?', [next, prefix, current.id]);
  else run('INSERT INTO bill_sequences (org_id,format,fy,prefix,last_number) VALUES (?,?,?,?,?)',
    [orgId, type, fy, prefix, next]);
  const number = ['SALE', 'PP', 'QUOT', 'DC', 'PI'].includes(type)
    ? invoiceNumber(prefix, fy, next)
    : `${code}/${prefix}/${fy}/${String(next).padStart(4, '0')}`;
  return { fy, number };
}

function targetPartyId(sourcePartyId, targetOrgId) {
  if (!sourcePartyId) return null;
  const shared = partyForOrg(sourcePartyId, targetOrgId);
  if (shared) return shared.id;
  const source = get('SELECT name FROM parties WHERE id=?', [sourcePartyId]);
  return source ? get('SELECT id FROM parties WHERE org_id=? AND name=? AND active=1', [targetOrgId, source.name])?.id || null : null;
}

function targetItems(items, targetOrgId) {
  return (items || []).map(item => ({
    ...item,
    item_id: item.item_name
      ? get('SELECT id FROM items WHERE org_id=? AND name=? AND active=1', [targetOrgId, item.item_name])?.id || null
      : null
  }));
}

function targetAccountId(sourceAccountId, targetOrgId) {
  if (!sourceAccountId) return null;
  const source = get('SELECT code,system_key FROM accounts WHERE id=?', [sourceAccountId]);
  if (!source) return null;
  const target = source.system_key
    ? get('SELECT id FROM accounts WHERE org_id=? AND system_key=?', [targetOrgId, source.system_key])
    : get('SELECT id FROM accounts WHERE org_id=? AND code=?', [targetOrgId, source.code]);
  return target?.id || null;
}

// A duplicate must stay in its originating company. Re-mapping a party, item, or
// account into another company can silently change the document being copied.
function requireOriginalDuplicateCompany(req, res, source, targetOrgId) {
  if (Number(source.org_id) !== Number(targetOrgId)) {
    res.status(400).json({
      error: 'Duplicate must remain in its original company. Create a new transaction to use another company.'
    });
    return false;
  }
  return true;
}

function recordDuplicateAudit(req, source, type, duplicateId, duplicateNumber, date, resets = []) {
  run(
    `INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,old_data,new_data,ip_address)
     VALUES (?,?,?,?,?,?,?,?)`,
    [req.user.id, source.org_id, 'DUPLICATE_TRANSACTION', type, duplicateId,
      JSON.stringify({ source_id: source.id, source_number: source.bill_number || source.payment_number || source.purchase_number || source.expense_number || source.note_number || source.po_number || source.voucher_number || null }),
      JSON.stringify({ duplicate_id: duplicateId, duplicate_number: duplicateNumber, duplicate_date: date, retained_original_company: true, reset_for_new_record: resets }),
      req.ip]
  );
}

router.post('/presence', (req, res) => {
  const key = `${req.user.id}:${req.body.client_id || req.ip}`;
  activeClients.set(key, {
    user_id: req.user.id, user_name: req.user.name, role: req.user.role,
    org_id: Number(req.body.org_id || 0), client_name: String(req.body.client_name || 'Computer').slice(0, 80),
    ip: req.ip, page: String(req.body.page || ''),
    app_version: String(req.body.app_version || APP_VERSION),
    pending_sync: Math.max(0, Number(req.body.pending_sync || 0)),
    sync_conflicts: Math.max(0, Number(req.body.sync_conflicts || 0)),
    last_seen: new Date().toISOString()
  });
  res.json({ success: true });
});

router.get('/network-status', requirePermission('settings'), (req, res) => {
  if (!requireGlobalOwnerAccess(req, res)) return;
  const cutoff = Date.now() - 90000;
  const clients = [...activeClients.values()].filter(client => new Date(client.last_seen).getTime() >= cutoff);
  res.json({ server_time: new Date().toISOString(), connected_clients: clients.length, clients });
});

router.get('/performance', requirePermission('diagnostics'), (req, res) => {
  const started = process.hrtime.bigint();
  const orgId = Number(req.query.org_id || req.user.current_org_id || 0);
  if (orgId && !requireOrgAccess(req, res, orgId)) return;
  const includeHostMetrics = req.user.org_access === 'all';
  const scoped = orgId ? ' AND org_id=?' : '';
  const scopedParams = orgId ? [orgId] : [];
  const count = (table, extra = '', useOrgScope = true) => Number(get(
    `SELECT COUNT(*) count FROM ${table} WHERE 1=1${useOrgScope ? scoped : ''}${extra}`,
    useOrgScope ? scopedParams : []
  )?.count || 0);
  const pageCount = includeHostMetrics ? Number(Object.values(all('PRAGMA page_count')[0] || {})[0] || 0) : 0;
  const freelistCount = includeHostMetrics ? Number(Object.values(all('PRAGMA freelist_count')[0] || {})[0] || 0) : 0;
  const journalMode = includeHostMetrics ? String(Object.values(all('PRAGMA journal_mode')[0] || {})[0] || 'unknown') : null;
  const pendingAttachmentAnalysis = orgId
    ? Number(get(
      `SELECT COUNT(*) count FROM attachment_analysis_jobs a
       LEFT JOIN job_attachments ja
         ON a.source_table='job_attachments' AND a.attachment_id=ja.id
       LEFT JOIN job_orders j ON j.id=ja.job_id
       LEFT JOIN job_intake_attachments ia
         ON a.source_table='job_intake_attachments' AND a.attachment_id=ia.id
       LEFT JOIN job_intake_requests ir ON ir.id=ia.intake_request_id
       WHERE a.status IN ('PENDING','PROCESSING') AND (j.org_id=? OR ir.org_id=?)`,
      [orgId, orgId]
    )?.count || 0)
    : count('attachment_analysis_jobs', " AND status IN ('PENDING','PROCESSING')", false);
  const attachmentCount = orgId
    ? Number(get(
      `SELECT COUNT(*) count FROM job_attachments a
       JOIN job_orders j ON j.id=a.job_id WHERE j.org_id=?`, [orgId]
    )?.count || 0)
    : count('job_attachments', '', false);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  res.json({
    measured_at: new Date().toISOString(),
    query_ms: Number(elapsedMs.toFixed(2)),
    database: includeHostMetrics ? {
      page_count: pageCount,
      freelist_count: freelistCount,
      journal_mode: journalMode,
      estimated_page_bytes: 4096,
      estimated_size_mb: Number((pageCount * 4096 / 1048576).toFixed(2))
    } : null,
    scope: orgId || 'all-accessible',
    queue: {
      pending_sync_outbox: count('sync_outbox', " AND status IN ('PENDING','RETRY')"),
      sync_conflicts: count('sync_conflicts', " AND status='pending'"),
      attachment_analysis_pending: pendingAttachmentAnalysis,
      customer_intake_pending: count('job_intake_requests', " AND status IN ('NEW','IN_REVIEW','QUOTED')")
    },
    records: {
      bills: count('bills', ' AND deleted=0'),
      jobs: count('job_orders'),
      parties: count('parties', ' AND active=1'),
      items: count('items', ' AND active=1'),
      attachments: attachmentCount
    },
    process: includeHostMetrics ? {
      uptime_seconds: Math.round(process.uptime()),
      memory_mb: Number((process.memoryUsage().rss / 1048576).toFixed(2)),
      cpu_user_ms: Math.round(process.cpuUsage().user / 1000),
      cpu_system_ms: Math.round(process.cpuUsage().system / 1000)
    } : null,
    attachment_analysis: includeHostMetrics ? attachmentAnalysisWorkerStatus() : null
  });
});

router.get('/transaction-search', requireAnyPermission('billing', 'accounting', 'reports'), (req, res) => {
  const orgId = Number(req.query.org_id || 0);
  const fy = String(req.query.fy || '').trim();
  const q = String(req.query.q || '').trim();
  if (!orgId) return res.status(400).json({ error: 'Company is required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  if (q.length < 2) return res.json([]);
  const like = `%${q}%`;
  const fyClause = fy ? ' AND fy=?' : '';
  const fyParam = fy ? [fy] : [];
  const ownBillClause = ['operator', 'senior_operator', 'engineer'].includes(req.user.role) ? ' AND created_by=?' : '';
  const ownBillParam = ownBillClause ? [req.user.id] : [];
  const rows = [
    ...all(`SELECT 'bill' source,id,format type,bill_number number,bill_date date,party_id,
        COALESCE((SELECT name FROM parties WHERE id=bills.party_id),'Cash Customer') party,
        description,grand_total amount,status
      FROM bills
      WHERE deleted=0 AND org_id=?${fyClause}${ownBillClause}
        AND (bill_number LIKE ? OR description LIKE ? OR party_snapshot LIKE ?
          OR EXISTS (SELECT 1 FROM parties p WHERE p.id=bills.party_id AND (p.name LIKE ? OR p.phone LIKE ? OR p.gstin LIKE ?)))`,
      [orgId, ...fyParam, ...ownBillParam, like, like, like, like, like, like]),
    ...all(`SELECT 'payment' source,id,type,payment_number number,payment_date date,party_id,
        COALESCE((SELECT name FROM parties WHERE id=payments.party_id),'-') party,
        COALESCE(reference,narration,'') description,amount,'saved' status
      FROM payments
      WHERE deleted=0 AND org_id=?${fyClause}
        AND (payment_number LIKE ? OR reference LIKE ? OR narration LIKE ?
          OR EXISTS (SELECT 1 FROM parties p WHERE p.id=payments.party_id AND (p.name LIKE ? OR p.phone LIKE ? OR p.gstin LIKE ?)))`,
      [orgId, ...fyParam, like, like, like, like, like, like]),
    ...all(`SELECT 'purchase' source,id,'PURCHASE' type,purchase_number number,purchase_date date,party_id,
        COALESCE((SELECT name FROM parties WHERE id=purchases.party_id),'-') party,
        COALESCE(supplier_invoice,narration,'') description,grand_total amount,'saved' status
      FROM purchases
      WHERE deleted=0 AND org_id=?${fyClause}
        AND (purchase_number LIKE ? OR supplier_invoice LIKE ? OR narration LIKE ?
          OR EXISTS (SELECT 1 FROM parties p WHERE p.id=purchases.party_id AND p.name LIKE ?))`,
      [orgId, ...fyParam, like, like, like, like]),
    ...all(`SELECT 'expense' source,id,'EXPENSE' type,expense_number number,expense_date date,party_id,
        COALESCE((SELECT name FROM parties WHERE id=expenses.party_id),(SELECT name FROM accounts WHERE id=expenses.account_id),'-') party,
        COALESCE(reference,narration,'') description,amount,'saved' status
      FROM expenses
      WHERE deleted=0 AND org_id=?${fyClause}
        AND (expense_number LIKE ? OR reference LIKE ? OR narration LIKE ?)`,
      [orgId, ...fyParam, like, like, like]),
    ...all(`SELECT 'note' source,id,note_type type,note_number number,note_date date,party_id,
        COALESCE((SELECT name FROM parties WHERE id=credit_debit_notes.party_id),'-') party,
        COALESCE(narration,'') description,grand_total amount,'saved' status
      FROM credit_debit_notes
      WHERE deleted=0 AND org_id=?${fyClause}
        AND (note_number LIKE ? OR narration LIKE ? OR EXISTS (SELECT 1 FROM parties p WHERE p.id=credit_debit_notes.party_id AND p.name LIKE ?))`,
      [orgId, ...fyParam, like, like, like]),
    ...all(`SELECT 'purchase_order' source,id,'PO' type,po_number number,po_date date,party_id,
        COALESCE((SELECT name FROM parties WHERE id=purchase_orders.party_id),'-') party,
        COALESCE(narration,'') description,subtotal amount,status
      FROM purchase_orders
      WHERE org_id=?${fyClause}
        AND (po_number LIKE ? OR narration LIKE ? OR EXISTS (SELECT 1 FROM parties p WHERE p.id=purchase_orders.party_id AND p.name LIKE ?))`,
      [orgId, ...fyParam, like, like, like]),
    ...all(`SELECT 'journal' source,id,voucher_type type,voucher_number number,entry_date date,NULL party_id,
        '-' party,COALESCE(narration,'') description,
        (SELECT COALESCE(SUM(debit),0) FROM journal_lines WHERE entry_id=journal_entries.id) amount,'saved' status
      FROM journal_entries
      WHERE deleted=0 AND org_id=?${fyClause}
        AND (voucher_number LIKE ? OR narration LIKE ?)`,
      [orgId, ...fyParam, like, like])
  ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(b.id) - Number(a.id)).slice(0, 30);
  res.json(rows);
});

router.get('/dsc/status', requirePermission('settings'), async (req, res) => {
  if (!requireGlobalOwnerAccess(req, res)) return;
  const csp = await runCommand('certutil', ['-csplist'], 12000);
  const scinfo = await runCommand('certutil', ['-scinfo'], 18000);
  const info = parseDscInfo(`${csp.output}\n${scinfo.output}`);
  const hyperPkiInstalled = /HyperPKI/i.test(csp.output) || fs.existsSync('C:\\Program Files (x86)\\HyperPKI');
  const tokenDetected = /HYPERSECU USB TOKEN|HYP2003|SCARD_STATE_PRESENT/i.test(scinfo.output);
  const certificateReady = Boolean(info.certificate_found && info.provider);
  const windowsStore = await runCommand('powershell.exe', [
    '-NoProfile',
    '-Command',
    "Get-ChildItem Cert:\\CurrentUser\\My -ErrorAction SilentlyContinue | Select-Object -First 5 Subject,Thumbprint,HasPrivateKey | ConvertTo-Json -Compress"
  ], 8000);
  const storeHasPrivateKey = /"HasPrivateKey"\s*:\s*true/i.test(windowsStore.output);
  res.json({
    success: true,
    hyperpki_installed: hyperPkiInstalled,
    token_detected: tokenDetected,
    certificate_ready: certificateReady,
    windows_store_private_key: storeHasPrivateKey,
    signing_mode: storeHasPrivateKey ? 'windows_store' : (certificateReady ? 'hyperpki_provider_detected' : 'not_ready'),
    message: storeHasPrivateKey
      ? 'DSC certificate is visible in Windows store and can be used by a Windows signing bridge.'
      : certificateReady
        ? 'USB token and certificate are detected through HyperPKI. Windows store does not expose the private key, so Tarangini needs HyperPKI provider/SDK signing bridge for automatic PDF signing.'
        : 'DSC token/certificate was not fully detected. Open HyperPKI Token Manager and confirm the token certificate is visible.',
    info,
    checks: {
      certutil_csplist_ok: csp.ok,
      certutil_scinfo_ok: scinfo.ok,
      scinfo_timed_out: scinfo.timed_out,
      windows_store_probe_ok: windowsStore.ok
    }
  });
});

router.get('/mobile-login-qr', async (req, res) => {
  const loginUrl = buildAbsoluteUrl(req, `/mobile-${APP_VERSION}`);
  const dataUrl = await QRCode.toDataURL(loginUrl, { width: 260, margin: 1 });
  res.json({ url: loginUrl, qr_data_url: dataUrl });
});

router.get('/shifts', requireAnyPermission('pos', 'shifts'), (req, res) => {
  res.json(all(
    `SELECT ps.*,u.name user_name,
      COALESCE((SELECT SUM(b.grand_total) FROM bills b WHERE b.shift_id=ps.id AND b.deleted=0 AND b.status='saved'),0) sales_total
     FROM pos_shifts ps JOIN users u ON u.id=ps.user_id
     WHERE ps.org_id=? ORDER BY ps.opened_at DESC LIMIT 100`, [req.query.org_id]
  ));
});

router.get('/shifts/:id/report', requirePermission('shifts'), (req, res) => {
  const shift = get(`SELECT ps.*,u.name user_name,au.name accepted_by_name
    FROM pos_shifts ps JOIN users u ON u.id=ps.user_id
    LEFT JOIN users au ON au.id=ps.accepted_by WHERE ps.id=?`, [req.params.id]);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  if (!requireOrgAccess(req, res, shift.org_id)) return;
  const bills = all(`SELECT * FROM bills WHERE shift_id=? AND deleted=0 AND status='saved' ORDER BY id`, [shift.id]);
  const promised = { cash: 0, bank: 0, upi: 0, card: 0, credit: 0, other: 0 };
  bills.forEach(bill => {
    let split = [];
    try { split = JSON.parse(bill.split_payments || '[]'); } catch (_) {}
    if (!split.length) split = [{ mode: bill.payment_mode || 'cash', amount: bill.grand_total }];
    split.forEach(payment => {
      const mode = Object.prototype.hasOwnProperty.call(promised, payment.mode) ? payment.mode : 'other';
      promised[mode] += Number(payment.amount || 0);
    });
  });
  const receipts = all(
    `SELECT p.* FROM payments p WHERE p.shift_id=? AND p.type='received'
     AND p.deleted=0 ORDER BY p.id`,
    [shift.id]
  );
  const refunds = all(
    `SELECT * FROM payments WHERE shift_id=? AND type='paid' AND deleted=0`,
    [shift.id]
  );
  const collections = { cash: round(promised.cash), bank: 0, upi: 0, card: 0 };
  receipts.forEach(payment => {
    const mode = ['cash', 'bank', 'upi', 'card'].includes(payment.mode) ? payment.mode : 'bank';
    collections[mode] += Number(payment.amount || 0);
  });
  Object.keys(collections).forEach(key => { collections[key] = round(collections[key]); });
  const credited = bills.reduce((sum, bill) => sum + Number(
    get(`SELECT COALESCE(SUM(grand_total),0) total FROM credit_debit_notes
         WHERE linked_bill_id=? AND note_type='credit' AND deleted=0`, [bill.id]
    )?.total || 0
  ), 0);
  const collected = Object.values(collections).reduce((sum, value) => sum + Number(value), 0);
  const pending = Math.max(0, bills.reduce((sum, bill) => sum + Number(bill.grand_total), 0) - collected - credited);
  res.json({
    shift, invoices: bills.length, invoice_total: round(bills.reduce((sum, bill) => sum + Number(bill.grand_total), 0)),
    collections, promised_payments: Object.fromEntries(Object.entries(promised).map(([key, value]) => [key, round(value)])),
    pending_amount: round(pending), credit_note_amount: round(credited),
    refund_amount: round(refunds.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)),
    receipts, refunds,
    bank_references: receipts.filter(payment => payment.mode !== 'cash').map(payment => ({
      payment_number: payment.payment_number, mode: payment.mode, amount: payment.amount, reference: payment.reference
    })),
    expected_cash: Number(shift.expected_cash || 0), actual_cash: shift.counted_cash,
    variance: shift.variance
  });
});

router.put('/shifts/:id/accept', requirePermission('shifts'), (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner acceptance required' });
  const shift = get(`SELECT * FROM pos_shifts WHERE id=? AND status='closed'`, [req.params.id]);
  if (!shift) return res.status(404).json({ error: 'Closed shift not found' });
  if (!requireOrgAccess(req, res, shift.org_id)) return;
  run(`UPDATE pos_shifts SET owner_accepted=1,accepted_by=?,accepted_at=datetime('now'),acceptance_note=? WHERE id=?`,
    [req.user.id, String(req.body.note || '').slice(0, 500), shift.id]);
  run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
    [req.user.id, shift.org_id, 'SHIFT_HANDOVER_ACCEPTED', 'pos_shifts', shift.id,
     JSON.stringify({ note: req.body.note || '', variance: shift.variance }), req.ip]);
  res.json({ success: true });
});

router.get('/update-status', requirePermission('settings'), (req, res) => {
  if (!requireGlobalOwnerAccess(req, res)) return;
  const latest = get(`SELECT * FROM update_packages WHERE active=1 ORDER BY id DESC LIMIT 1`);
  const cutoff = Date.now() - 90000;
  const clients = [...activeClients.values()].filter(client => new Date(client.last_seen).getTime() >= cutoff);
  const unsafeClients = clients.filter(client => client.pending_sync > 0 || client.sync_conflicts > 0);
  res.json({
    current_version: APP_VERSION,
    latest_version: latest?.version || APP_VERSION,
    update_available: Boolean(latest && latest.version !== APP_VERSION),
    package: latest || null,
    clients,
    unsafe_clients: unsafeClients,
    upgrade_safe: unsafeClients.length === 0
  });
});

router.post('/update-packages', requirePermission('settings'), requireAdminNetworkAccess, (req, res) => {
  if (!requireGlobalOwnerAccess(req, res)) return;
  const version = String(req.body.version || '').trim();
  const filePath = String(req.body.file_path || '').trim();
  const sha256 = String(req.body.sha256 || '').trim().toUpperCase();
  if (!/^\d+\.\d+\.\d+$/.test(version) || !filePath || !/^[A-F0-9]{64}$/.test(sha256)) {
    return res.status(400).json({ error: 'Version, installer path, and SHA-256 are required' });
  }
  if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'Installer file does not exist on the main system' });
  const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
  if (actualSha256 !== sha256) {
    return res.status(400).json({ error: 'SHA-256 does not match the selected installer file' });
  }
  const cutoff = Date.now() - 90000;
  const unsafeClients = [...activeClients.values()].filter(client =>
    new Date(client.last_seen).getTime() >= cutoff &&
    (client.pending_sync > 0 || client.sync_conflicts > 0)
  );
  if (unsafeClients.length) {
    return res.status(409).json({ error: 'Upgrade blocked while offline invoices are pending or conflicted', clients: unsafeClients });
  }
  saveDB();
  const recoveryDir = path.join(path.dirname(getDBPath()), 'upgrade-backups');
  fs.mkdirSync(recoveryDir, { recursive: true });
  const recoveryFile = path.join(recoveryDir, `pre-upgrade-${APP_VERSION}-${Date.now()}.db`);
  fs.copyFileSync(getDBPath(), recoveryFile);
  run(`UPDATE update_packages SET active=0`);
  const result = run(
    `INSERT INTO update_packages
     (version,file_name,file_path,sha256,release_notes,mandatory,created_by)
     VALUES (?,?,?,?,?,?,?)`,
    [version, path.basename(filePath), filePath, sha256, req.body.release_notes || '',
     req.body.mandatory ? 1 : 0, req.user.id]
  );
  res.json({ success: true, id: result.lastInsertRowid, sha256: actualSha256, recovery_backup: recoveryFile });
});

router.get('/update-package/download', requirePermission('settings'), (req, res) => {
  if (!requireGlobalOwnerAccess(req, res)) return;
  const latest = get(`SELECT * FROM update_packages WHERE active=1 ORDER BY id DESC LIMIT 1`);
  if (!latest || !fs.existsSync(latest.file_path)) return res.status(404).json({ error: 'Update package is unavailable' });
  const actual = crypto.createHash('sha256').update(fs.readFileSync(latest.file_path)).digest('hex').toUpperCase();
  if (actual !== latest.sha256) return res.status(409).json({ error: 'Update package checksum verification failed' });
  res.download(latest.file_path, latest.file_name);
});

router.post('/shifts/open', requireAnyPermission('pos', 'shifts'), (req, res) => {
  if (!requireOrgAccess(req, res, req.body.org_id)) return;
  const existing = get(`SELECT * FROM pos_shifts WHERE org_id=? AND user_id=? AND status='open'`,
    [req.body.org_id, req.user.id]);
  if (existing) return res.json({ success: true, shift: existing });
  const result = run(
    `INSERT INTO pos_shifts (org_id,user_id,counter_name,opening_cash) VALUES (?,?,?,?)`,
    [req.body.org_id, req.user.id, String(req.body.counter_name || 'Main Counter'), round(req.body.opening_cash)]
  );
  res.json({ success: true, shift: get('SELECT * FROM pos_shifts WHERE id=?', [result.lastInsertRowid]) });
});

router.put('/shifts/:id/cash', requireAnyPermission('pos', 'shifts'), (req, res) => {
  const shift = get(`SELECT * FROM pos_shifts WHERE id=? AND status='open'`, [req.params.id]);
  if (!shift) return res.status(404).json({ error: 'Open shift not found' });
  if (!requireOrgAccess(req, res, shift.org_id)) return;
  if (req.user.role !== 'owner' && Number(shift.user_id) !== Number(req.user.id)) {
    return res.status(403).json({ error: 'You can update only your own open shift' });
  }
  const cashAdded = round(req.body.cash_added);
  const cashRemoved = round(req.body.cash_removed);
  if (cashAdded < 0 || cashRemoved < 0 || (cashAdded <= 0 && cashRemoved <= 0) ||
      (cashAdded > 0 && cashRemoved > 0)) {
    return res.status(400).json({ error: 'Enter either a positive cash addition or a positive cash removal' });
  }
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (!reason) return res.status(400).json({ error: 'Reason is required for shift cash changes' });
  run('UPDATE pos_shifts SET cash_added=cash_added+?,cash_removed=cash_removed+? WHERE id=?',
    [cashAdded, cashRemoved, shift.id]);
  run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
    [req.user.id, shift.org_id, cashAdded > 0 ? 'SHIFT_CASH_ADDED' : 'SHIFT_CASH_REMOVED',
     'pos_shifts', shift.id, JSON.stringify({
       amount: cashAdded > 0 ? cashAdded : cashRemoved,
       reason
     }), req.ip]);
  res.json({
    success: true,
    shift: get('SELECT * FROM pos_shifts WHERE id=?', [shift.id])
  });
});

router.put('/shifts/:id/close', requireAnyPermission('pos', 'shifts'), (req, res) => {
  const shift = get(`SELECT * FROM pos_shifts WHERE id=? AND status='open'`, [req.params.id]);
  if (!shift) return res.status(404).json({ error: 'Open shift not found' });
  if (!requireOrgAccess(req, res, shift.org_id)) return;
  if (req.user.role !== 'owner' && Number(shift.user_id) !== Number(req.user.id)) {
    return res.status(403).json({ error: 'You can close only your own shift' });
  }
  const cashSales = get(
    `SELECT COALESCE(SUM(CASE WHEN b.payment_mode='cash' THEN b.grand_total ELSE
       COALESCE((SELECT SUM(CAST(json_extract(j.value,'$.amount') AS REAL))
         FROM json_each(b.split_payments) j WHERE json_extract(j.value,'$.mode')='cash'),0) END),0) total
     FROM bills b WHERE b.shift_id=? AND b.deleted=0 AND b.status='saved'`, [shift.id]
  )?.total || 0;
  const refunds = get(
    `SELECT COALESCE(SUM(amount),0) total FROM payments
     WHERE shift_id=? AND type='paid' AND deleted=0`, [shift.id]
  )?.total || 0;
  const expected = round(Number(shift.opening_cash) + Number(shift.cash_added) - Number(shift.cash_removed) + cashSales - refunds);
  const counted = round(req.body.counted_cash);
  run(
    `UPDATE pos_shifts SET expected_cash=?,counted_cash=?,variance=?,status='closed',closed_at=datetime('now') WHERE id=?`,
    [expected, counted, round(counted - expected), shift.id]
  );
  res.json({ success: true, expected_cash: expected, counted_cash: counted, variance: round(counted - expected) });
});

router.get('/held-bills', requirePermission('pos'), (req, res) => {
  res.json(all(`SELECT * FROM held_bills WHERE org_id=? ORDER BY updated_at DESC`, [req.query.org_id]));
});

router.post('/held-bills', requirePermission('pos'), (req, res) => {
  if (!requireOrgAccess(req, res, req.body.org_id)) return;
  const result = run(
    `INSERT INTO held_bills (org_id,user_id,shift_id,hold_name,cart_json) VALUES (?,?,?,?,?)`,
    [req.body.org_id, req.user.id, req.body.shift_id || null,
     String(req.body.hold_name || 'Held Bill').slice(0, 100), JSON.stringify(req.body.cart || {})]
  );
  res.json({ success: true, id: result.lastInsertRowid });
});

router.delete('/held-bills/:id', requirePermission('pos'), (req, res) => {
  const held = get('SELECT * FROM held_bills WHERE id=?', [req.params.id]);
  if (!held) return res.status(404).json({ error: 'Held bill not found' });
  if (!requireOrgAccess(req, res, held.org_id)) return;
  if (req.user.role !== 'owner' && Number(held.user_id) !== Number(req.user.id)) {
    return res.status(403).json({ error: 'You can remove only your own held bill' });
  }
  run('DELETE FROM held_bills WHERE id=?', [req.params.id]);
  res.json({ success: true });
});

router.post('/duplicate', (req, res) => {
  const type = String(req.body.type || '');
  const id = Number(req.body.id);
  const targetOrgId = Number(req.body.org_id);
  const requestedDate = String(req.body.date || '').trim();
  if (!type || !id || !targetOrgId) return res.status(400).json({ error: 'Voucher and company are required' });
  if (!requireOrgAccess(req, res, targetOrgId)) return;

  try {
    if (type === 'bill') {
      const source = get('SELECT * FROM bills WHERE id=? AND deleted=0', [id]);
      if (!source) return res.status(404).json({ error: 'Bill not found' });
      if (['operator', 'senior_operator', 'engineer'].includes(req.user.role) && Number(source.created_by) !== Number(req.user.id)) {
        return res.status(404).json({ error: 'Bill not found' });
      }
      if (!requireOrgAccess(req, res, source.org_id)) return;
      if (!requireOriginalDuplicateCompany(req, res, source, targetOrgId)) return;
      const date = requestedDate || source.bill_date;
      const items = JSON.parse(source.items_json || '[]');
      const seq = sequenceNumber(targetOrgId, source.format, date);
      const result = run(
        `INSERT INTO bills
         (org_id,format,bill_number,bill_date,fy,party_id,party_snapshot,delivery_address,
          delivery_info,po_number,po_date,credit_days,due_date,payment_mode,items_json,subtotal,discount,
          taxable_amount,tax_rate,cgst,sgst,igst,total_tax,grand_total,round_off,total_in_words,note_header,
          note_footer,description,swipe_charge,custom_data,split_payments,cost_total,bank_details,status,tax_inclusive,
          digital_signature_required,digital_signature_note,digital_signature_status,digital_signature_signed_at,
          digital_signature_signed_by,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [targetOrgId, source.format, seq.number, date, seq.fy, source.party_id, source.party_snapshot,
         source.delivery_address, source.delivery_info || '{}', source.po_number, source.po_date, source.credit_days, source.due_date,
         source.payment_mode, source.items_json || '[]', source.subtotal, source.discount,
         source.taxable_amount, source.tax_rate, source.cgst, source.sgst, source.igst,
         source.total_tax, source.grand_total, source.round_off || 0, source.total_in_words, source.note_header || '',
         source.note_footer || '', source.description, source.swipe_charge, source.custom_data,
         source.split_payments || '[]', source.cost_total || 0, source.bank_details || '{}', 'saved',
         source.tax_inclusive ? 1 : 0, source.digital_signature_required ? 1 : 0,
         source.digital_signature_note || '',
         source.digital_signature_required ? 'pending' : 'not_required', null, null, req.user.id]
      );
      const bill = get('SELECT * FROM bills WHERE id=?', [result.lastInsertRowid]);
      postBill(bill);
      if (bill.format === 'SALE') replaceStockMovements({
        orgId: targetOrgId, sourceType: 'bill', sourceId: bill.id, date,
        refNumber: bill.bill_number, items, direction: 'out'
      });
      recordDuplicateAudit(req, source, type, bill.id, bill.bill_number, date,
        ['payment allocations', 'completed digital signature']);
      return res.json({ success: true, type, id: bill.id, number: bill.bill_number });
    }

    if (type === 'payment') {
      const source = get('SELECT * FROM payments WHERE id=? AND deleted=0', [id]);
      if (!source) return res.status(404).json({ error: 'Payment voucher not found' });
      if (!requireOrgAccess(req, res, source.org_id)) return;
      if (!requireOriginalDuplicateCompany(req, res, source, targetOrgId)) return;
      const date = requestedDate || source.payment_date;
      const seq = sequenceNumber(targetOrgId, source.type === 'received' ? 'PR' : 'PV', date);
      const result = run(
        `INSERT INTO payments
         (org_id,payment_number,payment_date,fy,party_id,party_snapshot,type,mode,deposit_account_id,amount,reference,linked_bills,narration,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [targetOrgId, seq.number, date, seq.fy, source.party_id,
         source.party_snapshot, source.type, source.mode, source.deposit_account_id,
         source.amount, '', '[]',
         source.narration, req.user.id]
      );
      const payment = get('SELECT * FROM payments WHERE id=?', [result.lastInsertRowid]);
      postPayment(payment);
      recordDuplicateAudit(req, source, type, payment.id, payment.payment_number, date,
        ['linked bill allocations', 'external payment reference']);
      return res.json({ success: true, type, id: payment.id, number: payment.payment_number });
    }

    if (type === 'purchase') {
      const source = get('SELECT * FROM purchases WHERE id=? AND deleted=0', [id]);
      if (!source) return res.status(404).json({ error: 'Purchase not found' });
      if (!requireOrgAccess(req, res, source.org_id)) return;
      if (!requireOriginalDuplicateCompany(req, res, source, targetOrgId)) return;
      const date = requestedDate || source.purchase_date;
      const seq = sequenceNumber(targetOrgId, 'PUR', date);
      const items = JSON.parse(source.items_json || '[]');
      const result = run(
        `INSERT INTO purchases
         (org_id,purchase_number,supplier_invoice,purchase_date,due_date,fy,party_id,items_json,
          taxable_amount,cgst,sgst,igst,total_tax,grand_total,round_off,payment_mode,narration,tax_inclusive,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [targetOrgId, seq.number, source.supplier_invoice, date, source.due_date, seq.fy,
        source.party_id, source.items_json || '[]', source.taxable_amount,
         source.cgst, source.sgst, source.igst, source.total_tax, source.grand_total, source.round_off || 0,
         source.payment_mode, source.narration, source.tax_inclusive ? 1 : 0, req.user.id]
      );
      const purchase = get('SELECT * FROM purchases WHERE id=?', [result.lastInsertRowid]);
      postPurchase(purchase);
      replaceStockMovements({
        orgId: targetOrgId, sourceType: 'purchase', sourceId: purchase.id, date,
        refNumber: purchase.purchase_number, items, direction: 'in'
      });
      recordDuplicateAudit(req, source, type, purchase.id, purchase.purchase_number, date);
      return res.json({ success: true, type, id: purchase.id, number: purchase.purchase_number });
    }

    if (type === 'expense') {
      const source = get('SELECT * FROM expenses WHERE id=? AND deleted=0', [id]);
      if (!source) return res.status(404).json({ error: 'Expense not found' });
      if (!requireOrgAccess(req, res, source.org_id)) return;
      if (!requireOriginalDuplicateCompany(req, res, source, targetOrgId)) return;
      const date = requestedDate || source.expense_date;
      const seq = sequenceNumber(targetOrgId, 'EXP', date);
      const result = run(
        `INSERT INTO expenses
         (org_id,expense_number,expense_date,fy,party_id,account_id,payment_mode,amount,gst_amount,reference,narration,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [targetOrgId, seq.number, date, seq.fy, source.party_id,
         source.account_id, source.payment_mode, source.amount, source.gst_amount,
         source.reference, source.narration, req.user.id]
      );
      const expense = get('SELECT * FROM expenses WHERE id=?', [result.lastInsertRowid]);
      postExpense(expense);
      recordDuplicateAudit(req, source, type, expense.id, expense.expense_number, date);
      return res.json({ success: true, type, id: expense.id, number: expense.expense_number });
    }

    if (type === 'note') {
      const source = get('SELECT * FROM credit_debit_notes WHERE id=? AND deleted=0', [id]);
      if (!source) return res.status(404).json({ error: 'Credit/debit note not found' });
      if (!requireOrgAccess(req, res, source.org_id)) return;
      if (!requireOriginalDuplicateCompany(req, res, source, targetOrgId)) return;
      const date = requestedDate || source.note_date;
      const seq = sequenceNumber(targetOrgId, source.note_type === 'credit' ? 'CN' : 'DN', date);
      const items = JSON.parse(source.items_json || '[]');
      const result = run(
        `INSERT INTO credit_debit_notes
         (org_id,note_number,note_date,fy,note_type,party_id,items_json,taxable_amount,tax_amount,
          grand_total,round_off,narration,tax_inclusive,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [targetOrgId, seq.number, date, seq.fy, source.note_type,
         source.party_id, source.items_json || '[]', source.taxable_amount,
         source.tax_amount, source.grand_total, source.round_off || 0, source.narration,
         source.tax_inclusive ? 1 : 0, req.user.id]
      );
      const note = get('SELECT * FROM credit_debit_notes WHERE id=?', [result.lastInsertRowid]);
      postNote(note);
      replaceStockMovements({
        orgId: targetOrgId, sourceType: 'note', sourceId: note.id, date,
        refNumber: note.note_number, items, direction: note.note_type === 'credit' ? 'in' : 'out'
      });
      recordDuplicateAudit(req, source, type, note.id, note.note_number, date);
      return res.json({ success: true, type, id: note.id, number: note.note_number });
    }

    if (type === 'journal') {
      const source = get(`SELECT * FROM journal_entries WHERE id=? AND deleted=0`, [id]);
      if (!source) return res.status(404).json({ error: 'Journal voucher not found' });
      if (!requireOrgAccess(req, res, source.org_id)) return;
      if (!requireOriginalDuplicateCompany(req, res, source, targetOrgId)) return;
      const date = requestedDate || source.entry_date;
      const seq = sequenceNumber(targetOrgId, source.voucher_type || 'JV', date);
      const lines = all(
        `SELECT jl.*,a.code,a.system_key FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE jl.entry_id=?`,
        [source.id]
      ).map(line => {
        return {
          accountId: line.account_id, partyId: line.party_id,
          debit: line.debit, credit: line.credit, narration: line.narration
        };
      });
      const sourceId = Date.now();
      const entryId = replaceSourceEntry({
        orgId: targetOrgId, date, voucherType: source.voucher_type, voucherNumber: seq.number,
        narration: source.narration, sourceType: 'manual', sourceId, createdBy: req.user.id, lines
      });
      recordDuplicateAudit(req, source, type, entryId, seq.number, date);
      return res.json({ success: true, type, id: entryId, number: seq.number });
    }

    if (type === 'purchase_order') {
      const source = get('SELECT * FROM purchase_orders WHERE id=?', [id]);
      if (!source) return res.status(404).json({ error: 'Purchase order not found' });
      if (!requireOrgAccess(req, res, source.org_id)) return;
      if (!requireOriginalDuplicateCompany(req, res, source, targetOrgId)) return;
      const date = requestedDate || source.po_date;
      const seq = sequenceNumber(targetOrgId, 'PO', date);
      const result = run(
        `INSERT INTO purchase_orders
         (org_id,po_number,po_date,expected_date,fy,party_id,items_json,subtotal,round_off,status,narration,tax_inclusive,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [targetOrgId, seq.number, date, source.expected_date, seq.fy,
         source.party_id, source.items_json || '[]',
         source.subtotal, source.round_off || 0, 'open', source.narration,
         source.tax_inclusive ? 1 : 0, req.user.id]
      );
      recordDuplicateAudit(req, source, type, result.lastInsertRowid, seq.number, date,
        ['purchase-order conversion status']);
      return res.json({ success: true, type, id: result.lastInsertRowid, number: seq.number });
    }
    res.status(400).json({ error: 'Unsupported voucher type' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/returns', requirePermission('returns'), rejectLockedPeriod, (req, res) => {
  const bill = get(`SELECT * FROM bills WHERE id=? AND org_id=? AND format IN ('SALE','PP') AND deleted=0`,
    [req.body.bill_id, req.body.org_id]);
  if (!bill) return res.status(404).json({ error: 'Original invoice not found' });
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Add at least one returned item' });
  const org = get('SELECT * FROM orgs WHERE id=?', [bill.org_id]);
  const inclusive = Boolean(req.body.tax_inclusive ?? bill.tax_inclusive);
  let taxable = 0;
  const cleanItems = items.map(item => {
    const clean = taxableLine({
      ...item,
      gst_rate: org.gst_type === 'regular' ? Number(item.gst_rate || 18) : 0
    }, inclusive && org.gst_type === 'regular');
    taxable += clean.amount;
    return clean;
  });
  const tax = round(cleanItems.reduce((sum, item) => sum + item.tax, 0));
  const totalBeforeRound = round(taxable + tax);
  const roundOff = req.body.round_off_enabled === false ? 0 : round(Math.round(totalBeforeRound) - totalBeforeRound);
  const grandTotal = round(totalBeforeRound + roundOff);
  const number = sequenceNumber(bill.org_id, 'SR', req.body.note_date);
  const result = run(
    `INSERT INTO credit_debit_notes
     (org_id,note_number,note_date,fy,note_type,party_id,linked_bill_id,items_json,
      taxable_amount,tax_amount,grand_total,round_off,narration,tax_inclusive,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [bill.org_id, number.number, req.body.note_date, number.fy, 'credit', bill.party_id, bill.id,
     JSON.stringify(cleanItems), round(taxable), tax, grandTotal, roundOff,
     req.body.narration || `Sales return against ${bill.bill_number}`, inclusive ? 1 : 0, req.user.id]
  );
  const note = get('SELECT * FROM credit_debit_notes WHERE id=?', [result.lastInsertRowid]);
  postNote(note);
  replaceStockMovements({
    orgId: bill.org_id, sourceType: 'note', sourceId: note.id, date: note.note_date,
    refNumber: note.note_number, items: cleanItems, direction: 'in'
  });
  if (req.body.refund_mode && grandTotal > 0) {
    const payNo = sequenceNumber(bill.org_id, 'RF', req.body.note_date);
    const payment = run(
      `INSERT INTO payments
       (org_id,payment_number,payment_date,fy,party_id,type,mode,amount,reference,narration,shift_id,created_by)
       VALUES (?,?,?,?,?,'paid',?,?,?,?,?,?)`,
      [bill.org_id, payNo.number, req.body.note_date, payNo.fy, bill.party_id,
       req.body.refund_mode, grandTotal, note.note_number,
       `Refund for ${note.note_number}`, req.body.shift_id || null, req.user.id]
    );
    postPayment(get('SELECT * FROM payments WHERE id=?', [payment.lastInsertRowid]));
  }
  res.json({ success: true, note });
});

router.get('/purchase-orders', requirePermission('purchase_orders'), (req, res) => {
  const page = pageParams(req.query);
  const params = [req.query.org_id, req.query.fy || '', req.query.fy || ''];
  let sql = `SELECT po.*,p.name party_name FROM purchase_orders po
     LEFT JOIN parties p ON p.id=po.party_id WHERE po.org_id=? AND COALESCE(po.deleted,0)=0 AND (?='' OR po.fy=?)`;
  if (req.query.search) {
    sql += ` AND (po.po_number LIKE ? OR p.name LIKE ? OR po.narration LIKE ?)`;
    const s = `%${cleanText(req.query.search, 120)}%`;
    params.push(s, s, s);
  }
  sql += ' ORDER BY po.po_date DESC,po.id DESC LIMIT ? OFFSET ?';
  params.push(page.limit, page.offset);
  res.json(all(sql, params));
});

router.get('/purchase-orders/:id', requirePermission('purchase_orders'), (req, res) => {
  const order = get('SELECT * FROM purchase_orders WHERE id=? AND COALESCE(deleted,0)=0', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Purchase order not found' });
  if (!requireOrgAccess(req, res, order.org_id)) return;
  order.items = JSON.parse(order.items_json || '[]');
  res.json(order);
});

router.post('/purchase-orders', requirePermission('purchase_orders'), rejectLockedPeriod, (req, res) => {
  if (req.body.party_id && !partyForOrg(req.body.party_id, req.body.org_id)) {
    return res.status(400).json({ error: 'Vendor does not belong to this company' });
  }
  const org = get('SELECT gst_type FROM orgs WHERE id=?', [req.body.org_id]);
  const inclusive = Boolean(req.body.tax_inclusive && org?.gst_type === 'regular');
  const items = (req.body.items || []).filter(item => Number(item.qty) > 0)
    .map(item => taxableLine(item, inclusive));
  if (!items.length) return res.status(400).json({ error: 'Add purchase-order items' });
  const date = req.body.po_date;
  const sequence = sequenceNumber(req.body.org_id, 'PO', date);
  const subtotal = round(items.reduce((sum, item) => sum + Number(item.amount) + Number(item.tax), 0));
  const roundOff = req.body.round_off_enabled === false ? 0 : round(Math.round(subtotal) - subtotal);
  const roundedTotal = round(subtotal + roundOff);
  const result = run(
    `INSERT INTO purchase_orders
     (org_id,po_number,po_date,expected_date,fy,party_id,items_json,subtotal,round_off,narration,tax_inclusive,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.body.org_id, sequence.number, date, req.body.expected_date || null, sequence.fy,
     req.body.party_id || null, JSON.stringify(items), roundedTotal, roundOff, req.body.narration || '',
     inclusive ? 1 : 0, req.user.id]
  );
  res.json({
    success: true,
    purchase_order: get(
      `SELECT po.*,p.name party_name FROM purchase_orders po
       LEFT JOIN parties p ON p.id=po.party_id WHERE po.id=?`,
      [result.lastInsertRowid]
    )
  });
});

router.patch('/purchase-orders/:id', ownerOnly, (req, res) => {
  const order = get('SELECT * FROM purchase_orders WHERE id=? AND COALESCE(deleted,0)=0', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Purchase order not found' });
  if (!requireOrgAccess(req, res, order.org_id)) return;
  if (order.status !== 'open') return res.status(409).json({ error: 'Only open purchase orders can be edited' });
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  if (reason.length < 5) return res.status(400).json({ error: 'Enter an edit reason of at least 5 characters' });
  if (Number(req.body.org_id) !== Number(order.org_id)) return res.status(400).json({ error: 'Company cannot be changed while editing' });
  if (isPeriodLocked(order.org_id, order.po_date)) return res.status(423).json({ error: `Financial year ${order.fy} is locked` });
  if (req.body.party_id && !partyForOrg(req.body.party_id, order.org_id)) return res.status(400).json({ error: 'Vendor does not belong to this company' });
  try {
    const org = get('SELECT gst_type FROM orgs WHERE id=?', [order.org_id]);
    const inclusive = Boolean(req.body.tax_inclusive && org?.gst_type === 'regular');
    const items = (req.body.items || []).filter(item => Number(item.qty) > 0).map(item => taxableLine(item, inclusive));
    if (!items.length) return res.status(400).json({ error: 'Add purchase-order items' });
    const subtotalBeforeRound = round(items.reduce((sum, item) => sum + Number(item.amount) + Number(item.tax), 0));
    const roundOff = req.body.round_off_enabled === false ? 0 : round(Math.round(subtotalBeforeRound) - subtotalBeforeRound);
    const updated = transaction(() => {
      run(`UPDATE purchase_orders SET po_date=?,expected_date=?,party_id=?,items_json=?,subtotal=?,round_off=?,
        narration=?,tax_inclusive=? WHERE id=?`,
      [req.body.po_date, req.body.expected_date || null, req.body.party_id || null, JSON.stringify(items),
        round(subtotalBeforeRound + roundOff), roundOff, String(req.body.narration || '').trim().slice(0, 500),
        inclusive ? 1 : 0, order.id]);
      const row = get('SELECT * FROM purchase_orders WHERE id=?', [order.id]);
      run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,old_data,new_data,ip_address) VALUES (?,?,?,?,?,?,?,?)',
        [req.user.id, order.org_id, 'UPDATE_PURCHASE_ORDER', 'purchase_orders', order.id, JSON.stringify(order),
          JSON.stringify({ reason, transaction: row }), req.ip]);
      return row;
    });
    res.json({ success: true, purchase_order: updated });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

router.delete('/purchase-orders/:id', ownerOnly, (req, res) => {
  const order = get('SELECT * FROM purchase_orders WHERE id=? AND COALESCE(deleted,0)=0', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Purchase order not found' });
  if (!requireOrgAccess(req, res, order.org_id)) return;
  if (order.status !== 'open') return res.status(409).json({ error: 'A converted purchase order cannot be deleted' });
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  if (reason.length < 5) return res.status(400).json({ error: 'Enter a deletion reason of at least 5 characters' });
  if (isPeriodLocked(order.org_id, order.po_date)) return res.status(423).json({ error: `Financial year ${order.fy} is locked` });
  transaction(() => {
    run('UPDATE purchase_orders SET deleted=1 WHERE id=?', [order.id]);
    run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,old_data,new_data,ip_address) VALUES (?,?,?,?,?,?,?,?)',
      [req.user.id, order.org_id, 'DELETE_PURCHASE_ORDER', 'purchase_orders', order.id,
        JSON.stringify(order), JSON.stringify({ reason }), req.ip]);
  });
  res.json({ success: true });
});

router.post('/purchase-orders/:id/convert', requirePermission('purchase_orders'), (req, res) => {
  const order = get(`SELECT * FROM purchase_orders WHERE id=? AND status='open'`, [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Open purchase order not found' });
  if (!requireOrgAccess(req, res, order.org_id)) return;
  const items = JSON.parse(order.items_json || '[]');
  const inclusive = Boolean(order.tax_inclusive);
  let taxable = 0;
  let tax = 0;
  const clean = items.map(item => {
    const row = taxableLine(item, inclusive);
    taxable += row.amount; tax += row.tax;
    return row;
  });
  const totalBeforeRound = round(taxable + tax);
  const roundOff = Number(order.round_off || 0);
  const grandTotal = round(totalBeforeRound + roundOff);
  const seq = sequenceNumber(order.org_id, 'PUR', req.body.purchase_date || order.po_date);
  const result = run(
    `INSERT INTO purchases
     (org_id,purchase_number,supplier_invoice,purchase_date,due_date,fy,party_id,items_json,
      taxable_amount,cgst,sgst,total_tax,grand_total,round_off,payment_mode,narration,tax_inclusive,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [order.org_id, seq.number, req.body.supplier_invoice || '', req.body.purchase_date || order.po_date,
     req.body.due_date || null, seq.fy, order.party_id, JSON.stringify(clean), round(taxable),
     round(tax / 2), round(tax / 2), round(tax), grandTotal, roundOff,
     req.body.payment_mode || 'credit', `Converted from ${order.po_number}`,
     inclusive ? 1 : 0, req.user.id]
  );
  const purchase = get('SELECT * FROM purchases WHERE id=?', [result.lastInsertRowid]);
  postPurchase(purchase);
  replaceStockMovements({
    orgId: order.org_id, sourceType: 'purchase', sourceId: purchase.id, date: purchase.purchase_date,
    refNumber: purchase.purchase_number, items: clean, direction: 'in'
  });
  run(`UPDATE purchase_orders SET status='converted',converted_purchase_id=? WHERE id=?`,
    [purchase.id, order.id]);
  res.json({ success: true, purchase });
});

router.get('/supplier-balances', requirePermission('purchases'), (req, res) => {
  res.json(all(
    `SELECT p.id,p.name,
     ROUND(COALESCE(SUM(CASE WHEN a.system_key='accounts_payable' THEN jl.credit-jl.debit ELSE 0 END),0),2) outstanding
     FROM parties p LEFT JOIN journal_lines jl ON jl.party_id=p.id
     LEFT JOIN journal_entries je ON je.id=jl.entry_id
     LEFT JOIN accounts a ON a.id=jl.account_id
     WHERE p.org_id=? AND p.active=1 AND p.type IN ('supplier','both')
       AND (jl.id IS NULL OR je.deleted=0)
     GROUP BY p.id HAVING outstanding>0.01 ORDER BY outstanding DESC`, [req.query.org_id]
  ));
});

router.get('/profitability', requirePermission('profit'), (req, res) => {
  const rows = all(
    `SELECT b.id,b.bill_number,b.bill_date,p.name party_name,b.subtotal,b.discount,b.taxable_amount,
      b.grand_total,b.cost_total,ROUND(b.taxable_amount-b.cost_total,2) gross_profit
     FROM bills b LEFT JOIN parties p ON p.id=b.party_id
     WHERE b.org_id=? AND b.fy=? AND b.format IN ('SALE','PP') AND b.deleted=0 AND b.status='saved'
     ORDER BY b.bill_date DESC,b.id DESC`, [req.query.org_id, req.query.fy]
  );
  const items = all(
    `SELECT json_extract(j.value,'$.item_name') item_name,
      SUM(CAST(json_extract(j.value,'$.amount') AS REAL)) revenue,
      SUM(CAST(json_extract(j.value,'$.qty') AS REAL)*COALESCE(i.last_purchase_price,0)) cost
     FROM bills b,json_each(b.items_json) j
     LEFT JOIN items i ON i.id=CAST(json_extract(j.value,'$.item_id') AS INTEGER)
     WHERE b.org_id=? AND b.fy=? AND b.format IN ('SALE','PP') AND b.deleted=0
     GROUP BY item_name ORDER BY revenue-cost DESC`, [req.query.org_id, req.query.fy]
  ).map(row => ({ ...row, profit: round(Number(row.revenue) - Number(row.cost)) }));
  const customers = all(
    `SELECT COALESCE(p.name,'Cash Customer') customer_name,
      SUM(b.taxable_amount) revenue,SUM(b.cost_total) cost,
      ROUND(SUM(b.taxable_amount-b.cost_total),2) profit,COUNT(*) invoice_count
     FROM bills b LEFT JOIN parties p ON p.id=b.party_id
     WHERE b.org_id=? AND b.fy=? AND b.format IN ('SALE','PP') AND b.deleted=0 AND b.status='saved'
     GROUP BY b.party_id ORDER BY profit DESC`, [req.query.org_id, req.query.fy]
  );
  const acceptedEstimates = new Map(all(
    `SELECT je.job_id,je.total_paise
     FROM job_estimates je
     JOIN (
       SELECT job_id,MAX(revision_no) revision_no
       FROM job_estimates
       WHERE status='ACCEPTED'
       GROUP BY job_id
     ) latest ON latest.job_id=je.job_id AND latest.revision_no=je.revision_no
     WHERE je.status='ACCEPTED'`
  ).map(row => [Number(row.job_id), Number(row.total_paise || 0)]));
  const approvedAdditions = new Map(all(
    `SELECT job_id,COUNT(*) addition_count,COALESCE(SUM(total_paise),0) total_paise
     FROM job_additions
     WHERE state='APPROVED'
     GROUP BY job_id`
  ).map(row => [Number(row.job_id), {
    addition_count: Number(row.addition_count || 0),
    total_paise: Number(row.total_paise || 0)
  }]));
  const materialUsage = new Map(all(
    `SELECT job_id,COUNT(*) material_entries,COALESCE(SUM(quantity*rate),0) material_cost
     FROM job_material_consumptions
     GROUP BY job_id`
  ).map(row => [Number(row.job_id), {
    material_entries: Number(row.material_entries || 0),
    material_cost: Number(row.material_cost || 0)
  }]));
  const jobs = all(
    `SELECT j.id,j.job_token,j.created_at,j.promised_delivery_at,j.current_status,j.financial_status,j.delivered_at,
      p.name party_name,b.bill_number final_bill_number,b.grand_total final_bill_total
     FROM job_orders j
     LEFT JOIN parties p ON p.id=j.party_id
     LEFT JOIN bills b ON b.id=j.final_bill_id
     WHERE j.org_id=?
     ORDER BY COALESCE(j.delivered_at,j.created_at) DESC,j.id DESC`,
    [req.query.org_id]
  ).filter(row => getFY(String(row.delivered_at || row.created_at || '').slice(0, 10)) === req.query.fy)
    .map(row => {
      const estimatePaise = Number(acceptedEstimates.get(Number(row.id)) || 0);
      const additions = approvedAdditions.get(Number(row.id)) || { addition_count: 0, total_paise: 0 };
      const materials = materialUsage.get(Number(row.id)) || { material_entries: 0, material_cost: 0 };
      const projectedRevenue = round((estimatePaise + additions.total_paise) / 100);
      const materialCost = round(materials.material_cost);
      const projectedMargin = round(projectedRevenue - materialCost);
      const finalRevenue = row.final_bill_total === null || row.final_bill_total === undefined
        ? null
        : round(Number(row.final_bill_total || 0));
      return {
        id: row.id,
        job_token: row.job_token,
        reference_date: row.delivered_at || row.created_at,
        promised_delivery_at: row.promised_delivery_at,
        current_status: row.current_status,
        financial_status: row.financial_status,
        customer_name: row.party_name || 'Walk-in Customer',
        estimate_value: round(estimatePaise / 100),
        approved_addition_value: round(additions.total_paise / 100),
        projected_revenue: projectedRevenue,
        material_cost: materialCost,
        projected_margin: projectedMargin,
        material_entries: materials.material_entries,
        approved_addition_count: additions.addition_count,
        final_bill_number: row.final_bill_number || null,
        final_revenue: finalRevenue,
        final_margin: finalRevenue === null ? null : round(finalRevenue - materialCost)
      };
    });
  res.json({
    invoices: rows, items, customers, jobs,
    totals: {
      revenue: round(rows.reduce((s, r) => s + Number(r.taxable_amount), 0)),
      cost: round(rows.reduce((s, r) => s + Number(r.cost_total), 0)),
      profit: round(rows.reduce((s, r) => s + Number(r.gross_profit), 0))
    },
    job_totals: {
      projected_revenue: round(jobs.reduce((sum, row) => sum + Number(row.projected_revenue || 0), 0)),
      material_cost: round(jobs.reduce((sum, row) => sum + Number(row.material_cost || 0), 0)),
      projected_margin: round(jobs.reduce((sum, row) => sum + Number(row.projected_margin || 0), 0)),
      final_revenue: round(jobs.reduce((sum, row) => sum + Number(row.final_revenue || 0), 0)),
      final_margin: round(jobs.reduce((sum, row) => sum + Number(row.final_margin || 0), 0))
    }
  });
});

router.get('/invoice-qr/:billId', requirePermission('billing'), async (req, res) => {
  const bill = get(`SELECT b.*,o.display_name,o.gstin FROM bills b JOIN orgs o ON o.id=b.org_id WHERE b.id=?`, [req.params.billId]);
  if (!bill) return res.status(404).json({ error: 'Invoice not found' });
  if (!requireOrgAccess(req, res, bill.org_id)) return;
  const payload = JSON.stringify({
    invoice: bill.bill_number, date: bill.bill_date, seller: bill.display_name,
    gstin: bill.gstin || '', total: Number(bill.grand_total), tax: Number(bill.total_tax)
  });
  const png = await QRCode.toBuffer(payload, { type: 'png', width: 220, margin: 1 });
  res.type('png').send(png);
});

function encryptBuffer(buffer, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([Buffer.from('TARANGINIENC1'), salt, iv, cipher.getAuthTag(), encrypted]);
}

function decryptBuffer(buffer, password) {
  if (buffer.subarray(0, 13).toString() !== 'TARANGINIENC1') throw new Error('Invalid encrypted backup');
  const salt = buffer.subarray(13, 29);
  const iv = buffer.subarray(29, 41);
  const tag = buffer.subarray(41, 57);
  const key = crypto.scryptSync(password, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buffer.subarray(57)), decipher.final()]);
}

router.post('/encrypted-backup', requirePermission('backup'), (req, res) => {
  if (!requireGlobalOwnerAccess(req, res)) return;
  if (!req.body.password || String(req.body.password).length < 8) {
    return res.status(400).json({ error: 'Backup password must contain at least 8 characters' });
  }
  saveDB();
  const encrypted = encryptBuffer(fs.readFileSync(getDBPath()), String(req.body.password));
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="tarangini-encrypted-${Date.now()}.tbe"`);
  res.send(encrypted);
});

router.post('/encrypted-backup/restore', requirePermission('backup'), express.raw({ type: 'application/octet-stream', limit: '200mb' }), (req, res) => {
  if (!requireGlobalOwnerAccess(req, res)) return;
  try {
    const password = String(req.headers['x-backup-password'] || '');
    const decrypted = decryptBuffer(req.body, password);
    if (decrypted.subarray(0, 16).toString() !== 'SQLite format 3\u0000') throw new Error('Backup is not a valid Tarangini database');
    const target = getDBPath();
    fs.copyFileSync(target, `${target}.before-restore-${Date.now()}`);
    fs.writeFileSync(`${target}.restore`, decrypted);
    fs.renameSync(`${target}.restore`, target);
    res.json({ success: true, restart_required: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/integrity', requirePermission('diagnostics'), (req, res) => {
  if (!requireGlobalOwnerAccess(req, res)) return;
  const pragma = all('PRAGMA integrity_check');
  const checks = {
    database: Object.values(pragma[0] || {})[0] || 'unknown',
    orphan_bill_parties: get(`SELECT COUNT(*) count FROM bills b LEFT JOIN parties p ON p.id=b.party_id WHERE b.party_id IS NOT NULL AND p.id IS NULL`)?.count || 0,
    orphan_journal_lines: get(`SELECT COUNT(*) count FROM journal_lines jl LEFT JOIN journal_entries je ON je.id=jl.entry_id WHERE je.id IS NULL`)?.count || 0,
    unbalanced_journals: all(
      `SELECT je.id,je.voucher_number,ROUND(SUM(jl.debit),2) debit,ROUND(SUM(jl.credit),2) credit
       FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id WHERE je.deleted=0
       GROUP BY je.id HAVING ABS(SUM(jl.debit)-SUM(jl.credit))>0.01`
    )
  };
  const database = fs.statSync(getDBPath());
  const cutoff = Date.now() - 90000;
  const clients = [...activeClients.values()].filter(client => new Date(client.last_seen).getTime() >= cutoff);
  const pendingOffline = clients.reduce((sum, client) => sum + Number(client.pending_sync || 0), 0);
  const syncConflicts = clients.reduce((sum, client) => sum + Number(client.sync_conflicts || 0), 0);
  const lastBackup = get(`SELECT * FROM backup_log ORDER BY backup_date DESC LIMIT 1`);
  const backupAgeDays = lastBackup
    ? Math.floor((Date.now() - new Date(`${lastBackup.backup_date}Z`).getTime()) / 86400000)
    : null;
  const latestBackupVerification = get(`SELECT id,backup_log_id,status,integrity_result,
    schema_table_count,database_size_bytes,error,verified_at
    FROM backup_verification_log ORDER BY id DESC LIMIT 1`);
  const orgId = Number(req.query.org_id || req.user.current_org_id || 1);
  const lanAddresses = Object.values(os.networkInterfaces())
    .flat()
    .filter(row => row && row.family === 'IPv4' && !row.internal)
    .map(row => row.address);
  res.json({
    healthy: checks.database === 'ok' && !checks.orphan_bill_parties &&
      !checks.orphan_journal_lines && !checks.unbalanced_journals.length,
    checks,
    maintenance: {
      database_size_mb: Number((database.size / 1048576).toFixed(2)),
      storage_locations: {
        app_data_dir: getAppDataDir(),
        database_path: getDBPath(),
        attachment_dir: attachmentRoot(),
        backup_dir: backupDirectory()
      },
      expired_sessions: get(`SELECT COUNT(*) count FROM sessions
        WHERE active=0 OR expires_at<datetime('now','-90 days')`)?.count || 0,
      old_revoked_customer_tokens: get(`SELECT COUNT(*) count FROM job_customer_access_tokens
        WHERE revoked_at IS NOT NULL AND revoked_at<datetime('now','-180 days')`)?.count || 0,
      attachment_analysis_jobs: attachmentAnalysisWorkerStatus()
    },
    production_health: {
      server_time: new Date().toISOString(),
      uptime_seconds: Math.round(process.uptime()),
      lan_addresses: lanAddresses,
      connected_clients: clients.length,
      pending_offline_queue: pendingOffline,
      sync_conflicts: syncConflicts,
      latest_backup: lastBackup || null,
      backup_age_days: backupAgeDays,
      automatic_backup: {
        enabled: setting('automatic_backup_enabled', '1') !== '0',
        hours: Number(setting('automatic_backup_hours', '24')),
        effective_directory: backupDirectory(),
        storage_health: backupStorageHealth(),
        latest_verification: latestBackupVerification || null
      },
      service_mode: process.env.TARANGINI_WINDOWS_SERVICE === '1' ||
        process.argv.includes('--tarangini-service'),
      customer_portal_url: buildAbsoluteUrl(req, `/customer-intake.html?org=${orgId}`),
      mobile_login_url: buildAbsoluteUrl(req, `/mobile-${APP_VERSION}`)
    },
    deployment: {
      version: APP_VERSION,
      transport: req.secure ? 'https' : 'http',
      trusted_proxy: req.app.get('trust proxy') || false,
      allowed_origins_configured: Boolean(process.env.TARANGINI_ALLOWED_ORIGINS),
      internet_mode: INTERNET_MODE,
      public_base_url: PUBLIC_BASE_URL || null,
      admin_ip_restriction: adminIpRestricted(),
      profile: deploymentProfile()
    }
  });
});

router.post('/maintenance', requirePermission('diagnostics'), requireAdminNetworkAccess, (req, res) => {
  if (!requireGlobalOwnerAccess(req, res)) return;
  const removedSessions = run(`DELETE FROM sessions
    WHERE active=0 OR expires_at<datetime('now','-90 days')`).changes;
  const removedTokens = run(`DELETE FROM job_customer_access_tokens
    WHERE revoked_at IS NOT NULL AND revoked_at<datetime('now','-180 days')`).changes;
  run('INSERT INTO audit_log (user_id,action,table_name,new_data,ip_address) VALUES (?,?,?,?,?)',
    [req.user.id, 'DATABASE_MAINTENANCE', 'system',
     JSON.stringify({ removed_sessions: removedSessions, removed_customer_tokens: removedTokens }), req.ip]);
  saveDB();
  all('PRAGMA optimize');
  all('PRAGMA wal_checkpoint(TRUNCATE)');
  res.json({
    success: true,
    removed_sessions: removedSessions,
    removed_customer_tokens: removedTokens,
    preserved: ['financial records', 'audit history', 'job history', 'stock history']
  });
});

router.post('/integrity/repair', requirePermission('diagnostics'), requireAdminNetworkAccess, (req, res) => {
  if (!requireGlobalOwnerAccess(req, res)) return;
  const protectedYears = all(
    `SELECT org_id,fy,locked,closed,closed_at
     FROM financial_year_locks WHERE locked=1 OR closed=1 ORDER BY org_id,fy`
  );
  const recoveryReason = String(req.body.recovery_reason || '').trim();
  if (protectedYears.length && (!req.body.closed_year_recovery || recoveryReason.length < 20)) {
    return res.status(423).json({
      error: 'Closed or locked financial years are protected. Reopen the affected year first, or use documented closed-year recovery with a reason of at least 20 characters.',
      protected_years: protectedYears
    });
  }
  rebuildAccounting();
  run(`DELETE FROM stock_movements`);
  all(`SELECT * FROM purchases WHERE deleted=0`).forEach(purchase => replaceStockMovements({
    orgId: purchase.org_id, sourceType: 'purchase', sourceId: purchase.id, date: purchase.purchase_date,
    refNumber: purchase.purchase_number, items: JSON.parse(purchase.items_json || '[]'), direction: 'in'
  }));
  all(`SELECT * FROM bills WHERE format='SALE' AND deleted=0 AND status='saved'`).forEach(bill => replaceStockMovements({
    orgId: bill.org_id, sourceType: 'bill', sourceId: bill.id, date: bill.bill_date,
    refNumber: bill.bill_number, items: JSON.parse(bill.items_json || '[]'), direction: 'out'
  }));
  all(`SELECT * FROM credit_debit_notes WHERE deleted=0`).forEach(note => replaceStockMovements({
    orgId: note.org_id, sourceType: 'note', sourceId: note.id, date: note.note_date,
    refNumber: note.note_number, items: JSON.parse(note.items_json || '[]'),
    direction: note.note_type === 'credit' ? 'in' : 'out'
  }));
  all(`SELECT * FROM stock_counts WHERE status='APPROVED'`).forEach(count => replaceStockCountMovements({
    orgId: count.org_id, countId: count.id, countDate: count.count_date, countNumber: count.count_number,
    lines: all('SELECT * FROM stock_count_lines WHERE count_id=?', [count.id])
  }));
  run(
    `INSERT INTO audit_log (user_id,action,table_name,new_data,ip_address)
     VALUES (?,?,?,?,?)`,
    [req.user.id,
     protectedYears.length ? 'INTEGRITY_REPAIR_CLOSED_YEAR_RECOVERY' : 'INTEGRITY_REPAIR',
     'system',
     JSON.stringify({
       protected_years: protectedYears,
       closed_year_recovery: Boolean(req.body.closed_year_recovery),
       recovery_reason: protectedYears.length ? recoveryReason.slice(0, 1000) : null
     }),
     req.ip]
  );
  saveDB();
  res.json({ success: true, closed_year_recovery: protectedYears.length > 0, protected_years: protectedYears });
});

function reportCsv(orgId, reportType) {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
  const org = get('SELECT * FROM orgs WHERE id=?', [orgId]);
  const sales = all(
    `SELECT bill_date,bill_number,grand_total,total_tax FROM bills
     WHERE org_id=? AND bill_date BETWEEN ? AND ? AND format IN ('SALE','PP') AND deleted=0`, [orgId, startDate, end]
  );
  const total = round(sales.reduce((sum, row) => sum + Number(row.grand_total), 0));
  const lines = [
    ['Organization', org?.display_name || ''], ['Report', reportType], ['From', startDate], ['To', end],
    ['Total Sales', total], [], ['Date', 'Invoice', 'Total', 'Tax'],
    ...sales.map(row => [row.bill_date, row.bill_number, row.grand_total, row.total_tax])
  ];
  return lines.map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

async function executeSchedule(schedule) {
  const csv = reportCsv(schedule.org_id, schedule.report_type);
  const directory = schedule.output_directory || path.join(path.dirname(getDBPath()), 'scheduled-reports');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `tarangini-${schedule.report_type}-${Date.now()}.csv`);
  fs.writeFileSync(file, csv);
  const host = setting('smtp_host');
  if (host) {
    const transporter = nodemailer.createTransport({
      host, port: Number(setting('smtp_port') || 587), secure: setting('smtp_secure') === '1',
      auth: setting('smtp_user') ? { user: setting('smtp_user'), pass: setting('smtp_password') } : undefined
    });
    await transporter.sendMail({
      from: setting('smtp_from') || setting('smtp_user'), to: schedule.recipient_email,
      subject: `Tarangini ${schedule.report_type.replace(/_/g, ' ')}`,
      text: 'Attached is your scheduled Tarangini report.', attachments: [{ filename: path.basename(file), path: file }]
    });
  }
  run(`UPDATE scheduled_reports SET last_run_at=datetime('now'),last_status=? WHERE id=?`,
    [host ? 'emailed' : `saved: ${file}`, schedule.id]);
  return { file, emailed: Boolean(host) };
}

router.get('/report-schedules', requirePermission('scheduled_reports'), (req, res) => {
  const globalOwner = req.user.role === 'owner' && req.user.org_access === 'all';
  res.json({
    schedules: all('SELECT * FROM scheduled_reports WHERE org_id=? ORDER BY id DESC', [req.query.org_id]),
    smtp: globalOwner ? {
      host: setting('smtp_host'), port: setting('smtp_port') || '587', secure: setting('smtp_secure') === '1',
      user: setting('smtp_user'), from: setting('smtp_from')
    } : null
  });
});

router.post('/report-schedules', requirePermission('scheduled_reports'), (req, res) => {
  const orgId = Number(req.body.org_id || 0);
  if (!orgId || !requireOrgAccess(req, res, orgId)) return;
  const result = run(
    `INSERT INTO scheduled_reports
     (org_id,report_type,recipient_email,day_of_month,output_directory,enabled,created_by)
     VALUES (?,?,?,?,?,?,?)`,
    [orgId, req.body.report_type || 'monthly_summary', req.body.recipient_email,
     Math.max(1, Math.min(28, Number(req.body.day_of_month || 1))), req.body.output_directory || '',
     req.body.enabled === false ? 0 : 1, req.user.id]
  );
  res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/report-schedules/smtp', requirePermission('scheduled_reports'), (req, res) => {
  if (!requireGlobalOwnerAccess(req, res)) return;
  ['host','port','user','password','from'].forEach(key => putSetting(`smtp_${key}`, req.body[key] || '', req.user.id));
  putSetting('smtp_secure', req.body.secure ? '1' : '0', req.user.id);
  res.json({ success: true });
});

router.post('/report-schedules/:id/run', requirePermission('scheduled_reports'), async (req, res) => {
  try {
    const schedule = get('SELECT * FROM scheduled_reports WHERE id=?', [req.params.id]);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
    if (!requireOrgAccess(req, res, schedule.org_id)) return;
    res.json({ success: true, ...(await executeSchedule(schedule)) });
  } catch (error) {
    run(`UPDATE scheduled_reports SET last_run_at=datetime('now'),last_status=? WHERE id=?`,
      [`error: ${error.message}`, req.params.id]);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/report-schedules/:id', requirePermission('scheduled_reports'), (req, res) => {
  const schedule = get('SELECT * FROM scheduled_reports WHERE id=?', [req.params.id]);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  if (!requireOrgAccess(req, res, schedule.org_id)) return;
  run('DELETE FROM scheduled_reports WHERE id=?', [schedule.id]);
  res.json({ success: true });
});

function startScheduledReports() {
  if (global.__taranginiScheduledReports) clearInterval(global.__taranginiScheduledReports);
  global.__taranginiScheduledReports = setInterval(async () => {
    const day = new Date().getDate();
    const schedules = all(
      `SELECT * FROM scheduled_reports WHERE enabled=1 AND day_of_month=?
       AND (last_run_at IS NULL OR date(last_run_at)<date('now'))`, [day]
    );
    for (const schedule of schedules) {
      try { await executeSchedule(schedule); }
      catch (error) {
        run(`UPDATE scheduled_reports SET last_run_at=datetime('now'),last_status=? WHERE id=?`,
          [`error: ${error.message}`, schedule.id]);
      }
    }
  }, 60 * 60 * 1000);
}

module.exports = { router, startScheduledReports };
