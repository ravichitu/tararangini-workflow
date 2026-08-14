const { run } = require('../db/db');

function beginDataShiftBatch({
  sourceApp = 'tarangini-backup',
  sourceVersion = '',
  sourceInstance = '',
  orgId = null,
  shiftMode = 'IMPORT',
  entityScope = 'MERGED_APP',
  notes = '',
  createdBy = null
} = {}) {
  const result = run(
    `INSERT INTO data_shift_batches
     (source_app,source_version,source_instance,org_id,shift_mode,entity_scope,status,notes,counts_json,started_at,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),?)`,
    [
      sourceApp,
      sourceVersion || null,
      sourceInstance || null,
      orgId || null,
      shiftMode,
      entityScope,
      'RUNNING',
      String(notes || '').slice(0, 2000),
      '{}',
      createdBy || null
    ]
  );
  return Number(result.lastInsertRowid || 0);
}

function recordDataShiftEntityMap({
  batchId,
  entityType,
  sourceTable,
  sourceId,
  sourceRef = null,
  targetTable,
  targetId,
  targetRef = null,
  resolutionStatus = 'MAPPED',
  notes = ''
}) {
  if (!batchId || !entityType || sourceId === undefined || sourceId === null || !targetTable) return;
  run(
    `INSERT INTO data_shift_entity_map
     (batch_id,entity_type,source_table,source_id,source_ref,target_table,target_id,target_ref,resolution_status,notes)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(batch_id,entity_type,source_id) DO UPDATE SET
       source_table=excluded.source_table,
       source_ref=excluded.source_ref,
       target_table=excluded.target_table,
       target_id=excluded.target_id,
       target_ref=excluded.target_ref,
       resolution_status=excluded.resolution_status,
       notes=excluded.notes`,
    [
      batchId,
      entityType,
      sourceTable || null,
      String(sourceId),
      sourceRef || null,
      targetTable,
      targetId || null,
      targetRef || null,
      resolutionStatus,
      String(notes || '').slice(0, 2000)
    ]
  );
}

function finishDataShiftBatch(batchId, {
  status = 'COMPLETED',
  counts = {},
  notes = null
} = {}) {
  if (!batchId) return;
  run(
    `UPDATE data_shift_batches
     SET status=?, counts_json=?, notes=COALESCE(?, notes), completed_at=datetime('now')
     WHERE id=?`,
    [status, JSON.stringify(counts || {}), notes, batchId]
  );
}

module.exports = {
  beginDataShiftBatch,
  recordDataShiftEntityMap,
  finishDataShiftBatch
};
