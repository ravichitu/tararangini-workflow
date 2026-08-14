const express = require('express');
const crypto = require('crypto');
const Busboy = require('busboy');
const router = express.Router();
const { get, run, all, transaction } = require('../db/db');
const {
  analyzeAttachment, normalizeCustomerPdfPrintRequest, validateAttachmentInput, normalizeMimeType
} = require('../services/attachment-analysis');
const {
  shouldAnalyzeSynchronously,
  queuedAnalysisFields,
  enqueueAttachmentAnalysis
} = require('../services/attachment-processing');
const { persistAttachmentBytes, loadAttachmentBytes, hasAttachmentBytes } = require('../services/attachment-storage');

const MAX_ACTIVE_MULTIPART_UPLOADS = Math.max(1, Number(process.env.TARANGINI_UPLOAD_CONCURRENCY || 8));
let activeMultipartUploads = 0;

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function cleanText(value, max = 5000) {
  return String(value ?? '').trim().slice(0, max);
}

async function saveCustomerPortalAttachment(req, access, fileName, mimeType, purpose, pdfPrintRequest, bytes) {
  const normalizedMimeType = normalizeMimeType(fileName, mimeType);
  validateAttachmentInput({ bytes, mimeType: normalizedMimeType, uploadOrigin: 'CUSTOMER_PORTAL' });
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const analyzeNow = shouldAnalyzeSynchronously({ hasCustomerPdfPrintRequest: Boolean(pdfPrintRequest) });
  const analysis = analyzeNow
    ? await analyzeAttachment({ fileName, mimeType: normalizedMimeType, bytes })
    : queuedAnalysisFields({ fileName, mimeType: normalizedMimeType, byteSize: bytes.length });
  const normalizedPdfPrintRequest = normalizedMimeType === 'application/pdf' && pdfPrintRequest
    ? normalizeCustomerPdfPrintRequest(pdfPrintRequest, analysis) : null;
  const stored = persistAttachmentBytes({ scope: 'job', fileName, sha256, bytes });
  const result = run(`INSERT INTO job_attachments
    (job_id,entity_type,entity_id,purpose,upload_origin,file_name,mime_type,byte_size,sha256,storage_path,content_base64,visible_to_customer,
     pixel_width,pixel_height,pdf_page_count,analysis_status,analysis_error,metadata_json,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [access.job_id, 'CUSTOMER', null, purpose, 'CUSTOMER_PORTAL', fileName, analysis.mimeType, bytes.length, sha256,
      stored.storage_path, stored.content_base64, 1, analysis.pixelWidth, analysis.pixelHeight, analysis.pdfPageCount,
      analysis.analysisStatus, analysis.analysisError, JSON.stringify({ ...(analysis.metadata || {}),
        ...(normalizedPdfPrintRequest ? { customer_print_request: normalizedPdfPrintRequest } : {}) }), access.created_by]);
  if (!analyzeNow) enqueueAttachmentAnalysis({ table: 'job_attachments', id: result.lastInsertRowid,
    metadata: normalizedPdfPrintRequest ? { customer_print_request: normalizedPdfPrintRequest } : {} });
  run(`INSERT INTO job_audit_events
    (job_id,org_id,entity_type,entity_id,action,actor_role,new_data,operation_id,ip_address)
    SELECT j.id,j.org_id,'ATTACHMENT',?,?, 'CUSTOMER',?,?,? FROM job_orders j WHERE j.id=?`,
    [result.lastInsertRowid, 'UPLOAD', JSON.stringify({ file_name: fileName, mime_type: analysis.mimeType,
      byte_size: bytes.length, purpose, analysis_status: analysis.analysisStatus }), crypto.randomUUID(), req.ip, access.job_id]);
  return { id: result.lastInsertRowid, file_name: fileName, mime_type: analysis.mimeType, byte_size: bytes.length,
    pixel_width: analysis.pixelWidth, pixel_height: analysis.pixelHeight, pdf_page_count: analysis.pdfPageCount,
    analysis_status: analysis.analysisStatus, analysis_error: analysis.analysisError,
    metadata: { ...(analysis.metadata || {}), ...(normalizedPdfPrintRequest ? { customer_print_request: normalizedPdfPrintRequest } : {}) } };
}

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

function estimateSummary(jobId) {
  if (!jobId) return null;
  const estimate = get(
    `SELECT * FROM job_estimates
     WHERE job_id=? AND status='ACCEPTED'
     ORDER BY revision_no DESC LIMIT 1`,
    [jobId]
  );
  if (!estimate) return null;
  return {
    revision_no: estimate.revision_no,
    status: estimate.status,
    subtotal_paise: estimate.subtotal_paise,
    tax_paise: estimate.tax_paise,
    total_paise: estimate.total_paise,
    round_off_paise: estimate.round_off_paise,
    tax_inclusive: Boolean(estimate.tax_inclusive),
    lines: parseJson(estimate.lines_json, [])
  };
}

function accessFor(token) {
  return get(
    `SELECT a.*,j.job_token,j.party_id,j.priority,j.promised_delivery_at,j.current_status,
      j.customer_commitment,j.financial_status,j.pre_bill_id,j.final_bill_id,
      COALESCE(b.bill_number,pb.bill_number) final_bill_number,
      COALESCE(j.final_bill_id,j.pre_bill_id) visible_bill_id,
      p.name party_name
     FROM job_customer_access_tokens a
     JOIN job_orders j ON j.id=a.job_id
     LEFT JOIN bills b ON b.id=j.final_bill_id
     LEFT JOIN bills pb ON pb.id=j.pre_bill_id
     JOIN parties p ON p.id=j.party_id
     WHERE a.token_hash=? AND a.revoked_at IS NULL AND a.expires_at>datetime('now')`,
    [tokenHash(token)]
  );
}

router.get('/:token', (req, res) => {
  const access = accessFor(req.params.token);
  if (!access) return res.status(404).json({ error: 'This job link is invalid or expired' });
  run('UPDATE job_customer_access_tokens SET last_accessed_at=datetime(\'now\') WHERE id=?', [access.id]);
  const items = all(
    `SELECT service_snapshot,description,specification_json,quantity,unit
     FROM job_items WHERE job_id=? AND active=1 ORDER BY sort_order,id`, [access.job_id]
  ).map(item => {
    let specifications = {};
    try { specifications = JSON.parse(item.specification_json || '{}'); } catch (_) {}
    return { ...item, specifications, specification_json: undefined };
  });
  const additions = all(
    `SELECT id,customer_description,quantity,unit,tax_rate,total_paise,state
     FROM job_additions WHERE job_id=? AND state IN ('AWAITING_CUSTOMER','APPROVED','REJECTED')
     ORDER BY id DESC`, [access.job_id]
  );
  const attachments = all(
    `SELECT id,entity_type,entity_id,purpose,upload_origin,file_name,mime_type,byte_size,pixel_width,pixel_height,pdf_page_count,
            analysis_status,analysis_error,metadata_json,retention_state,retention_delete_after,physical_deleted_at,created_at,
            storage_path,content_base64
     FROM job_attachments
     WHERE job_id=? AND visible_to_customer=1
     ORDER BY id DESC`,
    [access.job_id]
  ).map(attachment => ({
    id: attachment.id,
    entity_type: attachment.entity_type,
    entity_id: attachment.entity_id,
    purpose: attachment.purpose,
    upload_origin: attachment.upload_origin,
    file_name: attachment.file_name,
    mime_type: attachment.mime_type,
    byte_size: attachment.byte_size,
    pixel_width: attachment.pixel_width,
    pixel_height: attachment.pixel_height,
    pdf_page_count: attachment.pdf_page_count,
    analysis_status: attachment.analysis_status,
    analysis_error: attachment.analysis_error,
    retention_state: attachment.retention_state,
    retention_delete_after: attachment.retention_delete_after,
    physical_deleted_at: attachment.physical_deleted_at,
    content_available: hasAttachmentBytes(attachment),
    created_at: attachment.created_at,
    metadata: parseJson(attachment.metadata_json, {})
  }));
  const timeline = all(
    `SELECT to_status,reason,occurred_at FROM job_status_events
     WHERE job_id=? ORDER BY id DESC`, [access.job_id]
  );
  const quotation = estimateSummary(access.job_id);
  res.json({
    job_token: access.job_token,
    customer_name: access.party_name,
    priority: access.priority,
    promised_delivery_at: access.promised_delivery_at,
    current_status: access.current_status,
    customer_commitment: access.customer_commitment,
    financial_status: access.financial_status,
    final_bill_id: access.visible_bill_id || null,
    final_bill_number: access.final_bill_number || null,
    items, attachments, additions, timeline, quotation
  });
});

router.post('/:token/analyze-upload', async (req, res) => {
  const access = accessFor(req.params.token);
  if (!access) return res.status(404).json({ error: 'This job link is invalid or expired' });
  const fileName = cleanText(req.body.file_name, 240);
  const mimeType = cleanText(req.body.mime_type || 'application/octet-stream', 120).toLowerCase();
  const contentBase64 = String(req.body.content_base64 || '').replace(/\s/g, '');
  if (!fileName || !contentBase64) return res.status(400).json({ error: 'Attachment content is required' });
  try {
    const bytes = Buffer.from(contentBase64, 'base64');
    const normalizedMimeType = normalizeMimeType(fileName, mimeType);
    validateAttachmentInput({ bytes, mimeType: normalizedMimeType, uploadOrigin: 'CUSTOMER_PORTAL' });
    const analysis = await analyzeAttachment({
      fileName,
      mimeType: normalizedMimeType,
      bytes
    });
    res.json({
      success: true,
      analysis: {
        file_name: fileName,
        mime_type: analysis.mimeType,
        byte_size: bytes.length,
        pixel_width: analysis.pixelWidth,
        pixel_height: analysis.pixelHeight,
        pdf_page_count: analysis.pdfPageCount,
        analysis_status: analysis.analysisStatus,
        analysis_error: analysis.analysisError,
        metadata: analysis.metadata || {}
      }
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/:token/uploads-multipart', (req, res) => {
  const access = accessFor(req.params.token);
  if (!access) return res.status(404).json({ error: 'This job link is invalid or expired' });
  if (activeMultipartUploads >= MAX_ACTIVE_MULTIPART_UPLOADS) {
    res.setHeader('Retry-After', '3');
    return res.status(429).json({ error: 'Upload capacity is busy. Please retry shortly.', code: 'UPLOAD_CAPACITY_BUSY' });
  }
  activeMultipartUploads += 1;
  let fields = {};
  let fileName = '';
  let mimeType = 'application/octet-stream';
  const chunks = [];
  let fileBytes = 0;
  let fileTooLarge = false;
  let parser;
  try {
    parser = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 20 * 1024 * 1024 } });
  } catch (error) {
    activeMultipartUploads -= 1;
    return res.status(400).json({ error: error.message });
  }
  parser.on('field', (name, value) => { fields[name] = value; });
  parser.on('file', (name, stream, info) => {
    if (name !== 'file') return stream.resume();
    fileName = cleanText(info.filename, 240);
    mimeType = cleanText(info.mimeType || 'application/octet-stream', 120).toLowerCase();
    stream.on('data', chunk => { fileBytes += chunk.length; chunks.push(chunk); });
    stream.on('limit', () => { fileTooLarge = true; });
  });
  parser.on('error', error => {
    activeMultipartUploads -= 1;
    if (!res.headersSent) res.status(400).json({ error: error.message });
  });
  parser.on('finish', async () => {
    try {
      if (fileTooLarge) throw new Error('Attachment exceeds the 20 MB customer upload limit');
      if (!fileName || !fileBytes) throw new Error('A file field is required');
      const attachment = await saveCustomerPortalAttachment(req, access, fileName, mimeType,
        cleanText(fields.purpose || 'CUSTOMER_UPLOAD', 40).toUpperCase(),
        fields.customer_pdf_print_request ? parseJson(fields.customer_pdf_print_request, null) : null,
        Buffer.concat(chunks));
      res.json({ success: true, attachment });
    } catch (error) {
      if (!res.headersSent) res.status(400).json({ error: error.message });
    } finally {
      activeMultipartUploads -= 1;
    }
  });
  req.pipe(parser);
});

router.post('/:token/uploads', async (req, res) => {
  const access = accessFor(req.params.token);
  if (!access) return res.status(404).json({ error: 'This job link is invalid or expired' });
  const fileName = cleanText(req.body.file_name, 240);
  const mimeType = cleanText(req.body.mime_type || 'application/octet-stream', 120).toLowerCase();
  const contentBase64 = String(req.body.content_base64 || '').replace(/\s/g, '');
  const purpose = cleanText(req.body.purpose || 'CUSTOMER_UPLOAD', 40).toUpperCase();
  if (!fileName || !contentBase64) return res.status(400).json({ error: 'Attachment content is required' });
  try {
    const bytes = Buffer.from(contentBase64, 'base64');
    const normalizedMimeType = normalizeMimeType(fileName, mimeType);
    validateAttachmentInput({ bytes, mimeType: normalizedMimeType, uploadOrigin: 'CUSTOMER_PORTAL' });
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const pdfPrintRequest = normalizedMimeType === 'application/pdf'
      ? req.body.customer_pdf_print_request || null
      : null;
    const analyzeNow = shouldAnalyzeSynchronously({
      hasCustomerPdfPrintRequest: Boolean(pdfPrintRequest)
    });
    const analysis = analyzeNow
      ? await analyzeAttachment({
        fileName,
        mimeType: normalizedMimeType,
        bytes
      })
      : queuedAnalysisFields({
        fileName,
        mimeType: normalizedMimeType,
        byteSize: bytes.length
      });
    const normalizedPdfPrintRequest = normalizedMimeType === 'application/pdf' && pdfPrintRequest
      ? normalizeCustomerPdfPrintRequest(pdfPrintRequest, analysis)
      : null;
    const stored = persistAttachmentBytes({
      scope: 'job',
      fileName,
      sha256,
      bytes
    });
    const result = run(
      `INSERT INTO job_attachments
       (job_id,entity_type,entity_id,purpose,upload_origin,file_name,mime_type,byte_size,sha256,storage_path,content_base64,visible_to_customer,
        pixel_width,pixel_height,pdf_page_count,analysis_status,analysis_error,metadata_json,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        access.job_id,
        'CUSTOMER',
        null,
        purpose,
        'CUSTOMER_PORTAL',
        fileName,
        analysis.mimeType,
        bytes.length,
        sha256,
        stored.storage_path,
        stored.content_base64,
        1,
        analysis.pixelWidth,
        analysis.pixelHeight,
        analysis.pdfPageCount,
        analysis.analysisStatus,
        analysis.analysisError,
        JSON.stringify({
          ...(analysis.metadata || {}),
          ...(normalizedPdfPrintRequest ? { customer_print_request: normalizedPdfPrintRequest } : {})
        }),
        access.created_by
      ]
    );
    if (!analyzeNow) {
      enqueueAttachmentAnalysis({
        table: 'job_attachments',
        id: result.lastInsertRowid,
        metadata: normalizedPdfPrintRequest ? { customer_print_request: normalizedPdfPrintRequest } : {}
      });
    }
    run(
      `INSERT INTO job_audit_events
       (job_id,org_id,entity_type,entity_id,action,actor_role,new_data,operation_id,ip_address)
       SELECT j.id,j.org_id,'ATTACHMENT',?,?, 'CUSTOMER',?,?,?
       FROM job_orders j WHERE j.id=?`,
      [
        result.lastInsertRowid,
        'UPLOAD',
        JSON.stringify({
          file_name: fileName,
          mime_type: analysis.mimeType,
          byte_size: bytes.length,
          purpose,
          analysis_status: analysis.analysisStatus
        }),
        crypto.randomUUID(),
        req.ip,
        access.job_id
      ]
    );
    res.json({
      success: true,
      attachment: {
        id: result.lastInsertRowid,
        file_name: fileName,
        mime_type: analysis.mimeType,
        byte_size: bytes.length,
        pixel_width: analysis.pixelWidth,
        pixel_height: analysis.pixelHeight,
        pdf_page_count: analysis.pdfPageCount,
        analysis_status: analysis.analysisStatus,
        analysis_error: analysis.analysisError,
        metadata: {
          ...(analysis.metadata || {}),
          ...(normalizedPdfPrintRequest ? { customer_print_request: normalizedPdfPrintRequest } : {})
        }
      }
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/:token/attachments/:attachmentId/content', (req, res) => {
  const access = accessFor(req.params.token);
  if (!access) return res.status(404).json({ error: 'This job link is invalid or expired' });
  const attachment = get(
    `SELECT * FROM job_attachments
     WHERE id=? AND job_id=? AND visible_to_customer=1`,
    [req.params.attachmentId, access.job_id]
  );
  if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
  if (!hasAttachmentBytes(attachment)) {
    return res.status(410).json({
      error: 'This file preview has expired. The order history keeps the file name and analysis details.'
    });
  }
  const bytes = loadAttachmentBytes(attachment);
  res.setHeader('Content-Type', attachment.mime_type || 'application/octet-stream');
  res.setHeader('Content-Length', bytes.length);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Download-Options', 'noopen');
  res.send(bytes);
});

router.post('/:token/additions/:additionId/decision', (req, res) => {
  const access = accessFor(req.params.token);
  if (!access) return res.status(404).json({ error: 'This job link is invalid or expired' });
  const addition = get(
    `SELECT * FROM job_additions WHERE id=? AND job_id=?`,
    [req.params.additionId, access.job_id]
  );
  if (!addition || addition.state !== 'AWAITING_CUSTOMER') {
    return res.status(409).json({ error: 'This additional-work request is no longer awaiting approval' });
  }
  const decision = String(req.body.decision || '').toUpperCase();
  const method = String(req.body.method || 'DIGITAL_SIGNATURE').toUpperCase();
  const approver = String(req.body.approver_name || '').trim().slice(0, 200);
  if (!['APPROVED', 'REJECTED'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });
  if (method !== 'DIGITAL_SIGNATURE') {
    return res.status(400).json({ error: 'Use digital signature on this page' });
  }
  if (!approver) return res.status(400).json({ error: 'Approver name is required' });
  const evidence = {
    addition_id: addition.id,
    addition_revision_no: addition.revision_no,
    decision,
    method,
    approver_name: approver,
    signature: String(req.body.signature_data || '').slice(0, 200000),
    charge_hash: addition.evidence_hash,
    confirmation: String(req.body.confirmation_text || '').slice(0, 2000)
  };
  const evidenceHash = crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  transaction(() => {
    run(
      `INSERT INTO job_customer_approvals
       (job_addition_id,addition_revision_no,decision,method,approver_name,evidence_text,evidence_hash)
       VALUES (?,?,?,?,?,?,?)`,
      [addition.id, addition.revision_no, decision, method, approver,
       evidence.confirmation || 'Customer portal confirmation', evidenceHash]
    );
    run('UPDATE job_additions SET state=?,updated_at=datetime(\'now\') WHERE id=?', [decision, addition.id]);
    run(
      `INSERT INTO job_audit_events
       (job_id,org_id,entity_type,entity_id,action,actor_role,new_data,operation_id,ip_address)
       SELECT j.id,j.org_id,'ADDITION_APPROVAL',?,?, 'CUSTOMER',?,?,?
       FROM job_orders j WHERE j.id=?`,
      [addition.id, decision, JSON.stringify({ ...evidence, signature: evidence.signature ? '[captured]' : '' }),
       crypto.randomUUID(), req.ip, access.job_id]
    );
  });
  res.json({ success: true, decision });
});

module.exports = router;
