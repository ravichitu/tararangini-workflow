const crypto = require('crypto');

const { all, get, run, transaction } = require('../db/db');
const { analyzeAttachment } = require('./attachment-analysis');
const { loadAttachmentBytes } = require('./attachment-storage');
const { ATTACHMENT_ANALYSIS_MODE } = require('../config/deployment-profile');

const SUPPORTED_TABLES = ['job_attachments', 'job_intake_attachments'];
const MAX_ATTEMPTS = Math.max(1, Number(process.env.TARANGINI_ATTACHMENT_ANALYSIS_ATTEMPTS || 3));
const DEFAULT_WORKER_INTERVAL_MS = Math.max(250, Number(process.env.TARANGINI_ATTACHMENT_WORKER_INTERVAL_MS || 1500));

let queueActive = false;
let workerStarted = false;
let workerTimer = null;

function shouldAnalyzeSynchronously({ hasCustomerPdfPrintRequest = false }) {
  return ATTACHMENT_ANALYSIS_MODE === 'sync' || hasCustomerPdfPrintRequest;
}

function baseMetadata(fileName, mimeType, byteSize) {
  return {
    file_name: fileName,
    mime_type: mimeType,
    byte_size: byteSize
  };
}

function queuedAnalysisFields({ fileName, mimeType, byteSize, metadata = {} }) {
  return {
    mimeType,
    pixelWidth: null,
    pixelHeight: null,
    pdfPageCount: null,
    analysisStatus: 'PENDING',
    analysisError: null,
    metadata: {
      ...baseMetadata(fileName, mimeType, byteSize),
      ...metadata
    }
  };
}

function validateTable(table) {
  if (!SUPPORTED_TABLES.includes(table)) {
    throw new Error(`Unsupported attachment table: ${table}`);
  }
}

function parseMetadata(value) {
  try {
    return JSON.parse(value || '{}');
  } catch (_) {
    return {};
  }
}

function rowForTable(table, id) {
  validateTable(table);
  if (table === 'job_attachments') {
    return get('SELECT * FROM job_attachments WHERE id=?', [id]);
  }
  return get('SELECT * FROM job_intake_attachments WHERE id=?', [id]);
}

function updateTableAnalysis(table, id, analysis) {
  validateTable(table);
  run(
    `UPDATE ${table}
     SET pixel_width=?,pixel_height=?,pdf_page_count=?,analysis_status=?,analysis_error=?,metadata_json=?
     WHERE id=?`,
    [
      analysis.pixelWidth,
      analysis.pixelHeight,
      analysis.pdfPageCount,
      analysis.analysisStatus,
      analysis.analysisError,
      JSON.stringify(analysis.metadata || {}),
      id
    ]
  );
}

function failAttachment(table, id, error, metadata = {}) {
  updateTableAnalysis(table, id, {
    pixelWidth: null,
    pixelHeight: null,
    pdfPageCount: null,
    analysisStatus: 'FAILED',
    analysisError: error.message,
    metadata: {
      ...metadata,
      processing_error_id: crypto.randomUUID()
    }
  });
}

async function processQueuedAttachment(task) {
  const row = rowForTable(task.table, task.id);
  if (!row) return { skipped: true };
  const rowMetadata = parseMetadata(row.metadata_json);
  const bytes = loadAttachmentBytes(row);
  const analysis = await analyzeAttachment({
    fileName: row.file_name,
    mimeType: row.mime_type,
    bytes
  });
  updateTableAnalysis(task.table, task.id, {
    ...analysis,
    metadata: {
      ...rowMetadata,
      ...(analysis.metadata || {}),
      ...(task.metadata || {})
    }
  });
  return { skipped: false };
}

function recoverPendingAttachmentAnalyses({ resetRunning = false } = {}) {
  if (resetRunning) {
    run(
      `UPDATE attachment_analysis_jobs
       SET status='PENDING', updated_at=datetime('now')
       WHERE status='RUNNING'`
    );
  }
  run(
    `INSERT OR IGNORE INTO attachment_analysis_jobs (source_table, attachment_id, status, metadata_json)
     SELECT 'job_attachments', id, 'PENDING', COALESCE(metadata_json, '{}')
     FROM job_attachments
     WHERE analysis_status='PENDING'`
  );
  run(
    `INSERT OR IGNORE INTO attachment_analysis_jobs (source_table, attachment_id, status, metadata_json)
     SELECT 'job_intake_attachments', id, 'PENDING', COALESCE(metadata_json, '{}')
     FROM job_intake_attachments
     WHERE analysis_status='PENDING'`
  );
}

function claimNextJob() {
  return transaction(() => {
    const job = get(
      `SELECT * FROM attachment_analysis_jobs
       WHERE status IN ('PENDING','RETRY') AND attempts < ?
       ORDER BY updated_at, id
       LIMIT 1`,
      [MAX_ATTEMPTS]
    );
    if (!job) return null;
    run(
      `UPDATE attachment_analysis_jobs
       SET status='RUNNING', attempts=attempts+1, updated_at=datetime('now')
       WHERE id=?`,
      [job.id]
    );
    return {
      ...job,
      attempts: Number(job.attempts || 0) + 1,
      metadata: parseMetadata(job.metadata_json)
    };
  });
}

function completeJob(job) {
  run(
    `UPDATE attachment_analysis_jobs
     SET status='DONE', last_error=NULL, updated_at=datetime('now'), completed_at=datetime('now')
     WHERE id=?`,
    [job.id]
  );
}

function retryOrFailJob(job, error) {
  const finalFailure = job.attempts >= MAX_ATTEMPTS;
  run(
    `UPDATE attachment_analysis_jobs
     SET status=?, last_error=?, updated_at=datetime('now'), completed_at=?
     WHERE id=?`,
    [
      finalFailure ? 'FAILED' : 'RETRY',
      error.message,
      finalFailure ? new Date().toISOString() : null,
      job.id
    ]
  );
  if (finalFailure) {
    try {
      failAttachment(job.source_table, job.attachment_id, error, job.metadata || {});
    } catch (_) {}
  }
}

function pumpQueue() {
  if (queueActive) return;
  queueActive = true;
  setImmediate(async () => {
    try {
      while (true) {
        const job = claimNextJob();
        if (!job) break;
        try {
          await processQueuedAttachment({
            table: job.source_table,
            id: job.attachment_id,
            metadata: job.metadata
          });
          completeJob(job);
        } catch (error) {
          retryOrFailJob(job, error);
        }
      }
    } finally {
      queueActive = false;
    }
  });
}

function enqueueAttachmentAnalysis(task) {
  validateTable(task.table);
  const metadata = JSON.stringify(task.metadata || {});
  run(
    `INSERT INTO attachment_analysis_jobs (source_table, attachment_id, status, metadata_json)
     VALUES (?, ?, 'PENDING', ?)
     ON CONFLICT(source_table, attachment_id) DO UPDATE SET
       status=CASE WHEN status='DONE' THEN status ELSE 'PENDING' END,
       metadata_json=CASE WHEN status='DONE' THEN metadata_json ELSE excluded.metadata_json END,
       last_error=CASE WHEN status='DONE' THEN last_error ELSE NULL END,
       updated_at=datetime('now'),
       completed_at=CASE WHEN status='DONE' THEN completed_at ELSE NULL END`,
    [task.table, task.id, metadata]
  );
  pumpQueue();
}

function attachmentAnalysisWorkerStatus() {
  const counts = {
    PENDING: 0,
    RETRY: 0,
    RUNNING: 0,
    DONE: 0,
    FAILED: 0
  };
  all(`SELECT status, COUNT(*) count FROM attachment_analysis_jobs GROUP BY status`).forEach(row => {
    counts[row.status] = Number(row.count || 0);
  });
  return {
    mode: ATTACHMENT_ANALYSIS_MODE,
    started: workerStarted,
    active: queueActive,
    max_attempts: MAX_ATTEMPTS,
    counts
  };
}

function startAttachmentAnalysisWorker({ intervalMs = DEFAULT_WORKER_INTERVAL_MS } = {}) {
  if (workerStarted) return () => {};
  workerStarted = true;
  recoverPendingAttachmentAnalyses({ resetRunning: true });
  pumpQueue();
  workerTimer = setInterval(() => {
    recoverPendingAttachmentAnalyses();
    pumpQueue();
  }, intervalMs);
  if (typeof workerTimer.unref === 'function') workerTimer.unref();
  return () => {
    if (workerTimer) clearInterval(workerTimer);
    workerTimer = null;
    workerStarted = false;
  };
}

module.exports = {
  ATTACHMENT_ANALYSIS_MODE,
  shouldAnalyzeSynchronously,
  queuedAnalysisFields,
  enqueueAttachmentAnalysis,
  recoverPendingAttachmentAnalyses,
  startAttachmentAnalysisWorker,
  attachmentAnalysisWorkerStatus
};
