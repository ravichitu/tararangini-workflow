const express = require('express');
const crypto = require('crypto');
const Busboy = require('busboy');
const QRCode = require('qrcode');
const router = express.Router();

const { get, run, all, transaction } = require('../db/db');
const { authMiddleware, checkOrgAccess, canAccessOrg, userPermissions } = require('../middleware/auth');
const { partyForOrg } = require('../business/parties');
const { groupCatalogServices, summarizeServiceGroup } = require('../business/job-service-groups');
const { getFY } = require('../accounting/accounting');
const {
  analyzeAttachment, normalizeCustomerPdfPrintRequest, validateAttachmentInput, normalizeMimeType
} = require('../services/attachment-analysis');
const {
  shouldAnalyzeSynchronously,
  queuedAnalysisFields,
  enqueueAttachmentAnalysis
} = require('../services/attachment-processing');
const { persistAttachmentBytes, loadAttachmentBytes } = require('../services/attachment-storage');
const { createZip } = require('../services/zip-builder');
const { buildAbsoluteUrl } = require('../security/runtime-config');
const { requireRegisteredOfflineDevice } = require('../security/registered-device');

const MAX_ACTIVE_INTAKE_MULTIPART = Math.max(1, Number(process.env.TARANGINI_INTAKE_UPLOAD_CONCURRENCY || 4));
let activeIntakeMultipart = 0;

function cleanText(value, max = 5000) {
  return String(value ?? '').trim().slice(0, max);
}

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

function paise(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function recordSyncRevision(orgId, entityType, entityId, operation) {
  run(`INSERT INTO sync_revisions
    (org_id,entity_type,entity_id,operation,record_version,changed_at)
    VALUES (?,?,?,?,NULL,datetime('now'))`,
  [orgId, entityType, String(entityId), operation]);
}

function requireCounter(req, res, next) {
  if (!userPermissions(req.user).jobs_counter) {
    return res.status(403).json({ error: 'jobs_counter permission required' });
  }
  next();
}

function intakeNumber() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `INQ-${stamp}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function nextJobToken(orgId, dateValue) {
  const fy = getFY(dateValue);
  const org = get('SELECT display_name FROM orgs WHERE id=?', [orgId]);
  const orgCode = String(org?.display_name || 'ORG').replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase();
  let seq = get('SELECT last_number FROM job_sequences WHERE org_id=? AND fy=?', [orgId, fy]);
  if (!seq) {
    run('INSERT INTO job_sequences (org_id,fy,last_number) VALUES (?,?,0)', [orgId, fy]);
    seq = { last_number: 0 };
  }
  const next = Number(seq.last_number || 0) + 1;
  run('UPDATE job_sequences SET last_number=? WHERE org_id=? AND fy=?', [next, orgId, fy]);
  return `JOB-${orgCode}-${String(fy).slice(2, 4)}-${String(next).padStart(6, '0')}`;
}

function orgRow(orgId) {
  return get(
    `SELECT id,display_name,registered_name,gst_type
     FROM orgs WHERE id=? AND active=1`,
    [orgId]
  );
}

function ensureDefaultCatalog(orgId, userId = 1) {
  if (get('SELECT id FROM job_service_categories WHERE org_id=? LIMIT 1', [orgId])) return;
  const definitions = [
    ['BIND', 'Finishing Services', null, 'BOOK-BIND', 'Book Binding'],
    ['PHOTO', 'Photo Services', 'Frames', 'PHOTO-FRAME', 'Photo Frames'],
    ['PRINT', 'Printing Services', 'General Printing', 'PRINT', 'Printing'],
    ['PRINT', 'Printing Services', 'Customized Products', 'CUSTOM-PRINT', 'Customized Printing'],
    ['PHOTO', 'Photo Services', 'Photo Output', 'PHOTO-PRINT', 'Photo Printing'],
    ['COMPUTER', 'Computer Shop Services', 'Repairs and Support', 'COMPUTER-SERVICE', 'Computer Shop Services'],
    ['PRINT', 'Printing Services', 'UV Printing', 'UV-PRINT', 'UV Printing Services']
  ];
  transaction(() => {
    for (const [categoryCode, categoryName, subcategoryName, serviceCode, serviceName] of definitions) {
      let category = get('SELECT id FROM job_service_categories WHERE org_id=? AND code=?', [orgId, categoryCode]);
      if (!category) {
        const inserted = run(
          'INSERT INTO job_service_categories (org_id,code,name,created_by) VALUES (?,?,?,?)',
          [orgId, categoryCode, categoryName, userId]
        );
        category = { id: inserted.lastInsertRowid };
      }
      let subcategoryId = null;
      if (subcategoryName) {
        let sub = get(
          'SELECT id FROM job_service_subcategories WHERE category_id=? AND name=?',
          [category.id, subcategoryName]
        );
        if (!sub) {
          const inserted = run(
            `INSERT INTO job_service_subcategories
             (org_id,category_id,code,name,created_by) VALUES (?,?,?,?,?)`,
            [orgId, category.id, `${categoryCode}-${subcategoryName.replace(/\W+/g, '-').toUpperCase()}`,
             subcategoryName, userId]
          );
          sub = { id: inserted.lastInsertRowid };
        }
        subcategoryId = sub.id;
      }
      run(
        `INSERT OR IGNORE INTO job_services
         (org_id,category_id,subcategory_id,code,name,specification_schema,allowed_units,default_unit,created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [orgId, category.id, subcategoryId, serviceCode, serviceName,
         JSON.stringify({ fields: ['description', 'size', 'material', 'finish', 'instructions'] }),
         JSON.stringify(['NOS', 'SHEETS', 'PAGES', 'SQFT', 'BOOKS', 'HOURS']), 'NOS', userId]
      );
    }
  });
}

function serviceCatalog(orgId) {
  return all(
    `SELECT s.id,s.name,s.default_unit,s.allowed_units,s.specification_schema,s.category_id,s.subcategory_id,
            c.name category_name,sc.name subcategory_name
     FROM job_services s
     JOIN job_service_categories c ON c.id=s.category_id
     LEFT JOIN job_service_subcategories sc ON sc.id=s.subcategory_id
     WHERE s.org_id=? AND s.active=1
     ORDER BY c.sort_order,c.name,sc.sort_order,sc.name,s.sort_order,s.name`,
    [orgId]
  ).map(service => ({
    ...service,
    allowed_units: parseJson(service.allowed_units, []),
    specification_schema: parseJson(service.specification_schema, {})
  }));
}

function intakeSummaryRow(id) {
  return get(
    `SELECT ir.*,
            jo.job_token converted_job_token,
            COUNT(ia.id) attachment_count
     FROM job_intake_requests ir
     LEFT JOIN job_orders jo ON jo.id=ir.converted_job_id
     LEFT JOIN job_intake_attachments ia ON ia.intake_request_id=ir.id
     WHERE ir.id=?
     GROUP BY ir.id`,
    [id]
  );
}

function intakeIdempotencyKey(req) {
  return cleanText(req.get('x-idempotency-key'), 120) ||
    cleanText(req.body.client_request_id, 120) ||
    null;
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

function resolveOrCreateIntakeParty(orgId, customer) {
  const phone = cleanText(customer.phone, 40) || null;
  const email = cleanText(customer.email, 200) || null;
  const name = cleanText(customer.name, 200);
  const address = cleanText(customer.address, 1000) || null;
  if (!name) return null;
  let party = null;
  if (phone) {
    const phoneMatches = partiesForPhone(orgId, phone);
    if (phoneMatches.length === 1) {
      party = phoneMatches[0];
    } else if (phoneMatches.length > 1) {
      const normalizedName = name.toLocaleLowerCase();
      party = phoneMatches.find(candidate => String(candidate.name || '').trim().toLocaleLowerCase() === normalizedName) || null;
      // Leave an unresolved shared phone to staff review instead of attaching the job to the wrong person.
      if (!party) return null;
    }
  }
  if (!party && email) {
    party = get(
      `SELECT * FROM parties
       WHERE org_id=? AND active=1 AND type IN ('customer','both') AND email=?
       ORDER BY id LIMIT 1`,
      [orgId, email]
    );
  }
  if (!party) {
    party = get(
      `SELECT * FROM parties
       WHERE org_id=? AND active=1 AND type IN ('customer','both') AND name=?
       ORDER BY id LIMIT 1`,
      [orgId, name]
    );
  }
  if (party) {
    const nextName = party.name || name;
    const nextRegisteredName = party.registered_name || nextName;
    const nextPhone = party.phone || phone;
    const nextEmail = party.email || email;
    const nextAddress = party.address || address;
    if (
      nextName !== party.name ||
      nextRegisteredName !== party.registered_name ||
      nextPhone !== party.phone ||
      nextEmail !== party.email ||
      nextAddress !== party.address
    ) {
      run(
        `UPDATE parties
         SET name=?,registered_name=?,phone=?,email=?,address=?
         WHERE id=?`,
        [nextName, nextRegisteredName, nextPhone, nextEmail, nextAddress, party.id]
      );
      party = get('SELECT * FROM parties WHERE id=?', [party.id]);
      recordSyncRevision(orgId, 'PARTY', party.id, 'UPDATE');
    }
    return party;
  }
  const created = run(
    `INSERT INTO parties
     (org_id,shared,type,name,registered_name,phone,email,address,city,state,pincode,gstin,gst_type,delivery_addresses,digital_signature_required,opening_balance,balance_type)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      orgId,
      0,
      'customer',
      name,
      name,
      phone,
      email,
      address,
      null,
      'Andhra Pradesh',
      null,
      null,
      'unregistered',
      '[]',
      0,
      0,
      'cr'
    ]
  );
  const saved = get('SELECT * FROM parties WHERE id=?', [created.lastInsertRowid]);
  recordSyncRevision(orgId, 'PARTY', saved.id, 'CREATE');
  return saved;
}

function normalizePhoneForMatch(value) {
  return String(value || '').replace(/\D/g, '');
}

function maskedPhoneMatch(input, stored) {
  const left = normalizePhoneForMatch(input);
  const right = normalizePhoneForMatch(stored);
  if (!left || !right) return false;
  return left === right || left.slice(-10) === right.slice(-10);
}

function partiesForPhone(orgId, phone) {
  const digits = normalizePhoneForMatch(phone);
  if (digits.length < 10) return [];
  const lastTen = digits.slice(-10);
  return all(
    `SELECT * FROM parties
     WHERE org_id=? AND active=1 AND type IN ('customer','both')
       AND phone IS NOT NULL AND phone<>''
       AND substr(replace(replace(replace(replace(replace(phone,' ',''),'-',''),'(',''),')',''),'+',''),-10)=?
     ORDER BY id`,
    [orgId, lastTen]
  ).filter(party => maskedPhoneMatch(phone, party.phone));
}

function insertAuditEvent({
  jobId = null,
  orgId,
  entityType,
  entityId = null,
  action,
  actorUserId = null,
  actorRole = null,
  reason = null,
  oldData = null,
  newData = null,
  ipAddress = null
}) {
  run(
    `INSERT INTO job_audit_events
     (job_id,org_id,entity_type,entity_id,action,actor_user_id,actor_role,reason,old_data,new_data,operation_id,ip_address)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      jobId, orgId, entityType, entityId, action, actorUserId, actorRole, reason,
      oldData ? JSON.stringify(oldData) : null,
      newData ? JSON.stringify(newData) : null,
      crypto.randomUUID(),
      ipAddress
    ]
  );
}

router.get('/config', (req, res) => {
  const orgId = Number(req.query.org_id);
  const org = orgRow(orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  ensureDefaultCatalog(orgId);
  const services = serviceCatalog(orgId);
  res.json({
    org: {
      id: org.id,
      name: org.display_name || org.registered_name || `Organization ${org.id}`
    },
    services: services.map(service => ({
      id: service.id,
      name: service.name,
      category_name: service.category_name,
      subcategory_name: service.subcategory_name,
      default_unit: service.default_unit,
      ...summarizeServiceGroup(service)
    })),
    service_groups: groupCatalogServices(services).map(group => ({
      key: group.key,
      label: group.label,
      description: group.description,
      portal_note: group.portal_note,
      suggested_item_type: group.suggested_item_type,
      suggested_summary: group.suggested_summary,
      instruction_hint: group.instruction_hint,
      services: group.services.map(service => ({
        id: service.id,
        name: service.name,
        category_name: service.category_name,
        subcategory_name: service.subcategory_name,
        default_unit: service.default_unit
      }))
    }))
  });
});

router.get('/customer-profile', (req, res) => {
  const orgId = Number(req.query.org_id);
  const org = orgRow(orgId);
  const phone = cleanText(req.query.phone, 40);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  if (normalizePhoneForMatch(phone).length < 10) {
    return res.status(400).json({ error: 'Enter a valid 10-digit customer phone number' });
  }
  const matches = partiesForPhone(orgId, phone);
  if (!matches.length) return res.json({ found: false });
  if (matches.length > 1) {
    return res.json({
      found: false,
      ambiguous: true,
      message: 'More than one customer record uses this phone number. Please enter your details; staff will confirm the account.'
    });
  }
  const party = matches[0];
  res.json({
    found: true,
    customer: {
      name: party.name || '',
      phone: party.phone || phone,
      email: party.email || '',
      address: party.address || ''
    }
  });
});

router.post('/analyze-file', async (req, res) => {
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

router.get('/status', (req, res) => {
  const orgId = Number(req.query.org_id);
  const orderId = cleanText(req.query.order_id, 120).toUpperCase();
  const phone = cleanText(req.query.phone, 40);
  if (!orgId || !orderId || !phone) {
    return res.status(400).json({ error: 'org_id, order_id, and phone are required' });
  }
  const intake = get(
    `SELECT ir.*,jo.job_token converted_job_token,jo.current_status job_status,jo.promised_delivery_at,
            jo.financial_status job_financial_status,jo.final_bill_id,b.bill_number final_bill_number,
            o.display_name org_name,o.registered_name org_registered_name
     FROM job_intake_requests ir
     JOIN orgs o ON o.id=ir.org_id
     LEFT JOIN job_orders jo ON jo.id=ir.converted_job_id
     LEFT JOIN bills b ON b.id=jo.final_bill_id
     WHERE ir.org_id=? AND (UPPER(ir.request_number)=? OR UPPER(jo.job_token)=?)`,
    [orgId, orderId, orderId]
  );
  if (!intake || !maskedPhoneMatch(phone, intake.customer_phone)) {
    return res.status(404).json({ error: 'Order ID and phone number do not match any customer request' });
  }
  const latestPortalToken = intake.converted_job_id
    ? get(
      `SELECT id FROM job_customer_access_tokens
       WHERE job_id=? AND revoked_at IS NULL AND expires_at>datetime('now')
       ORDER BY id DESC LIMIT 1`,
      [intake.converted_job_id]
    )
    : null;
  const quotation = intake.converted_job_id ? estimateSummary(intake.converted_job_id) : null;
  res.json({
    success: true,
    company_name: intake.org_name || intake.org_registered_name || `Organization ${orgId}`,
    customer_name: intake.customer_name,
    party_id: intake.party_id || null,
    billing_party_linked: Boolean(intake.party_id),
    order_id: intake.request_number,
    submitted_at: intake.submitted_at,
    request_status: intake.status,
    requested_delivery_at: intake.requested_delivery_at,
    issue_summary: intake.issue_summary,
    intake_stage_label: intake.status === 'CONVERTED'
      ? 'Converted to production job'
      : intake.status === 'REVIEWED'
        ? 'Reviewed by counter staff'
        : intake.status === 'CANCELLED'
          ? 'Cancelled'
          : 'Submitted for review',
    job: intake.converted_job_id ? {
      id: intake.converted_job_id,
      token: intake.converted_job_token,
      current_status: intake.job_status,
      promised_delivery_at: intake.promised_delivery_at,
      financial_status: intake.job_financial_status,
      final_bill_id: intake.final_bill_id || null,
      final_bill_number: intake.final_bill_number || null,
      customer_portal_issued: Boolean(latestPortalToken)
    } : null,
    quotation
  });
});

router.post('/submit-multipart', (req, res) => {
  if (activeIntakeMultipart >= MAX_ACTIVE_INTAKE_MULTIPART) {
    res.setHeader('Retry-After', '3');
    return res.status(429).json({ error: 'Intake upload capacity is busy. Please retry shortly.', code: 'UPLOAD_CAPACITY_BUSY' });
  }
  activeIntakeMultipart += 1;
  const fields = {};
  const files = [];
  let parser;
  try { parser = Busboy({ headers: req.headers, limits: { files: 20, fileSize: 20 * 1024 * 1024 } }); }
  catch (error) { activeIntakeMultipart -= 1; return res.status(400).json({ error: error.message }); }
  parser.on('field', (name, value) => { fields[name] = value; });
  parser.on('file', (name, stream, info) => {
    if (name !== 'attachment') return stream.resume();
    const chunks = [];
    let tooLarge = false;
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('limit', () => { tooLarge = true; });
    stream.on('end', () => files.push({ file_name: cleanText(info.filename, 240), mime_type: info.mimeType, content_bytes: Buffer.concat(chunks), tooLarge }));
  });
  parser.on('error', error => { activeIntakeMultipart -= 1; if (!res.headersSent) res.status(400).json({ error: error.message }); });
  parser.on('finish', async () => {
    try {
      const payload = parseJson(fields.payload, null);
      if (!payload || !Array.isArray(payload.attachments)) throw new Error('Multipart intake payload is missing');
      if (files.some(file => file.tooLarge)) throw new Error('An attachment exceeds the 20 MB customer upload limit');
      payload.attachments = files.map((file, index) => ({ ...file, ...(payload.attachments[index] || {}) }));
      req.body = payload;
      await submitIntakeHandler(req, res);
    } catch (error) {
      if (!res.headersSent) res.status(400).json({ error: error.message });
    } finally { activeIntakeMultipart -= 1; }
  });
  req.pipe(parser);
});

async function submitIntakeHandler(req, res) {
  const orgId = Number(req.body.org_id);
  if (!requireRegisteredOfflineDevice(req, res, orgId)) return;
  const org = orgRow(orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  const customerName = cleanText(req.body.customer_name, 200);
  const customerPhone = cleanText(req.body.customer_phone, 40);
  const issueSummary = cleanText(req.body.issue_summary, 500);
  if (!customerName || !customerPhone || !issueSummary) {
    return res.status(400).json({ error: 'Customer name, phone, and job summary are required' });
  }
  const clientRequestId = intakeIdempotencyKey(req);
  if (clientRequestId) {
    const existing = get(
      `SELECT ir.id,ir.request_number,ir.status,ir.party_id,COUNT(ia.id) attachment_count
       FROM job_intake_requests ir
       LEFT JOIN job_intake_attachments ia ON ia.intake_request_id=ir.id
       WHERE ir.org_id=? AND ir.client_request_id=?
       GROUP BY ir.id`,
      [orgId, clientRequestId]
    );
    if (existing) {
      return res.json({
        success: true,
        duplicate: true,
        id: existing.id,
        order_id: existing.request_number,
        request_number: existing.request_number,
        party_id: existing.party_id || null,
        billing_party_linked: Boolean(existing.party_id),
        status: existing.status,
        attachment_count: Number(existing.attachment_count || 0)
      });
    }
  }
  if (!req.body.consent_status) {
    return res.status(400).json({ error: 'Customer confirmation is required before submitting the request' });
  }
  const requestedServiceId = Number(req.body.service_id || 0) || null;
  const service = requestedServiceId
    ? get('SELECT id,name FROM job_services WHERE id=? AND org_id=? AND active=1', [requestedServiceId, orgId])
    : null;
  if (requestedServiceId && !service) {
    return res.status(400).json({ error: 'Selected service is unavailable' });
  }
  const requestedAttachments = Array.isArray(req.body.attachments) ? req.body.attachments : [];
  const requestToken = crypto.randomBytes(24).toString('base64url');
  const requestNumber = intakeNumber();
  try {
    const analyzedAttachments = [];
    for (const attachment of requestedAttachments) {
      const fileName = cleanText(attachment.file_name, 240);
      const mimeType = cleanText(attachment.mime_type || 'application/octet-stream', 120).toLowerCase();
      const contentBase64 = String(attachment.content_base64 || '').replace(/\s/g, '');
      if (!fileName || (!contentBase64 && !Buffer.isBuffer(attachment.content_bytes))) continue;
      const bytes = Buffer.isBuffer(attachment.content_bytes)
        ? attachment.content_bytes
        : Buffer.from(contentBase64, 'base64');
      const normalizedMimeType = normalizeMimeType(fileName, mimeType);
      validateAttachmentInput({ bytes, mimeType: normalizedMimeType, uploadOrigin: 'CUSTOMER_PORTAL' });
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const rawPdfPrintRequest = normalizedMimeType === 'application/pdf'
        ? attachment.customer_pdf_print_request || null
        : null;
      const analyzeNow = shouldAnalyzeSynchronously({
        hasCustomerPdfPrintRequest: Boolean(rawPdfPrintRequest)
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
      const pdfPrintRequest = normalizedMimeType === 'application/pdf' && rawPdfPrintRequest
        ? normalizeCustomerPdfPrintRequest(rawPdfPrintRequest, analysis)
        : null;
      const stored = persistAttachmentBytes({
        scope: 'intake',
        fileName,
        sha256,
        bytes
      });
      analyzedAttachments.push({
        fileName,
        byteSize: bytes.length,
        sha256,
        storagePath: stored.storage_path,
        storedContentBase64: stored.content_base64,
        analysis,
        analyzeNow,
        pdfPrintRequest
      });
    }
    const created = transaction(() => {
      const party = resolveOrCreateIntakeParty(orgId, {
        name: customerName,
        phone: customerPhone,
        email: cleanText(req.body.customer_email, 200),
        address: cleanText(req.body.customer_address, 1000)
      });
      const result = run(
        `INSERT INTO job_intake_requests
         (org_id,request_token,request_number,client_request_id,source_channel,status,
          party_id,customer_name,customer_phone,customer_email,customer_address,preferred_contact,
          service_id,service_name_snapshot,item_type,item_name,device_brand,device_model,device_serial,
          quantity,issue_summary,issue_details,requested_delivery_at,consent_status,consent_text,
          metadata_json,source_ip,source_user_agent)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          orgId,
          requestToken,
          requestNumber,
          clientRequestId,
          cleanText(req.body.source_channel || 'QR', 30).toUpperCase(),
          'SUBMITTED',
          party?.id || null,
          customerName,
          customerPhone,
          cleanText(req.body.customer_email, 200) || null,
          cleanText(req.body.customer_address, 1000) || null,
          cleanText(req.body.preferred_contact || 'PHONE', 20).toUpperCase(),
          service?.id || null,
          service?.name || null,
          cleanText(req.body.item_type, 120),
          cleanText(req.body.item_name, 240),
          cleanText(req.body.device_brand, 120),
          cleanText(req.body.device_model, 120),
          cleanText(req.body.device_serial, 120),
          Math.max(0.001, Number(req.body.quantity || 1)),
          issueSummary,
          cleanText(req.body.issue_details, 4000),
          cleanText(req.body.requested_delivery_at, 40) || null,
          req.body.consent_status ? 'ACCEPTED' : 'PENDING',
          cleanText(req.body.consent_text, 2000),
          JSON.stringify({
            customer_reference: cleanText(req.body.customer_reference, 120),
            submitted_from: 'customer-intake-page'
          }),
          req.ip,
          cleanText(req.headers['user-agent'], 500)
        ]
      );
      for (const attachment of analyzedAttachments) {
        const inserted = run(
          `INSERT INTO job_intake_attachments
           (intake_request_id,file_name,mime_type,byte_size,sha256,storage_path,content_base64,pixel_width,pixel_height,
            pdf_page_count,analysis_status,analysis_error,metadata_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            result.lastInsertRowid,
            attachment.fileName,
            attachment.analysis.mimeType,
            attachment.byteSize,
            attachment.sha256,
            attachment.storagePath,
            attachment.storedContentBase64,
            attachment.analysis.pixelWidth,
            attachment.analysis.pixelHeight,
            attachment.analysis.pdfPageCount,
            attachment.analysis.analysisStatus,
            attachment.analysis.analysisError,
            JSON.stringify({
              ...(attachment.analysis.metadata || {}),
              ...(attachment.pdfPrintRequest ? { customer_print_request: attachment.pdfPrintRequest } : {})
            })
          ]
        );
        recordSyncRevision(orgId, 'INTAKE_ATTACHMENT', inserted.lastInsertRowid, 'CREATE');
        if (!attachment.analyzeNow) {
          enqueueAttachmentAnalysis({
            table: 'job_intake_attachments',
            id: inserted.lastInsertRowid,
            metadata: attachment.pdfPrintRequest ? { customer_print_request: attachment.pdfPrintRequest } : {}
          });
        }
      }
      insertAuditEvent({
        orgId,
        entityType: 'INTAKE',
        entityId: result.lastInsertRowid,
        action: 'SUBMIT',
        actorRole: 'CUSTOMER',
        newData: {
          request_number: requestNumber,
          party_id: party?.id || null,
          customer_name: customerName,
          customer_phone: customerPhone,
          service_name: service?.name || null,
          attachment_count: analyzedAttachments.length
        },
        ipAddress: req.ip
      });
      recordSyncRevision(orgId, 'INTAKE', result.lastInsertRowid, 'SUBMIT');
      return { id: result.lastInsertRowid };
    });
    const summary = intakeSummaryRow(created.id);
    res.json({
      success: true,
      id: created.id,
      order_id: requestNumber,
      request_number: requestNumber,
      party_id: summary.party_id || null,
      billing_party_linked: Boolean(summary.party_id),
      status: summary.status,
      attachment_count: Number(summary.attachment_count || 0)
    });
  } catch (error) {
    if (clientRequestId && /UNIQUE constraint failed/i.test(String(error.message || ''))) {
      const existing = get(
        `SELECT ir.id,ir.request_number,ir.status,ir.party_id,COUNT(ia.id) attachment_count
         FROM job_intake_requests ir
         LEFT JOIN job_intake_attachments ia ON ia.intake_request_id=ir.id
         WHERE ir.org_id=? AND ir.client_request_id=?
         GROUP BY ir.id`,
        [orgId, clientRequestId]
      );
      if (existing) {
        return res.json({
          success: true,
          duplicate: true,
          id: existing.id,
          order_id: existing.request_number,
          request_number: existing.request_number,
          party_id: existing.party_id || null,
          billing_party_linked: Boolean(existing.party_id),
          status: existing.status,
          attachment_count: Number(existing.attachment_count || 0)
        });
      }
    }
    res.status(400).json({ error: error.message });
  }
}

router.post('/submit', submitIntakeHandler);

router.get('/link', authMiddleware, checkOrgAccess, requireCounter, async (req, res) => {
  const orgId = Number(req.query.org_id);
  const org = orgRow(orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  const path = `/customer-intake.html?org=${orgId}`;
  const url = buildAbsoluteUrl(req, path);
  const qrDataUrl = await QRCode.toDataURL(url, { width: 280, margin: 1 });
  res.json({
    success: true,
    path,
    url,
    qr_data_url: qrDataUrl,
    org: {
      id: org.id,
      name: org.display_name || org.registered_name || `Organization ${org.id}`
    }
  });
});

router.get('/', authMiddleware, checkOrgAccess, requireCounter, (req, res) => {
  const orgId = Number(req.query.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  const counts = Object.fromEntries(
    all(
      `SELECT status,COUNT(*) count
       FROM job_intake_requests WHERE org_id=?
       GROUP BY status`,
      [orgId]
    ).map(row => [row.status, Number(row.count)])
  );
  const rows = all(
    `SELECT ir.*,jo.job_token converted_job_token,COUNT(ia.id) attachment_count
     FROM job_intake_requests ir
     LEFT JOIN job_orders jo ON jo.id=ir.converted_job_id
     LEFT JOIN job_intake_attachments ia ON ia.intake_request_id=ir.id
     WHERE ir.org_id=?
     GROUP BY ir.id
     ORDER BY CASE ir.status
       WHEN 'SUBMITTED' THEN 1
       WHEN 'REVIEWED' THEN 2
       WHEN 'CONVERTED' THEN 3
       ELSE 4 END, ir.submitted_at DESC
     LIMIT 200`,
    [orgId]
  );
  res.json({
    counts,
    requests: rows.map(row => ({
      id: row.id,
      request_number: row.request_number,
      status: row.status,
      customer_name: row.customer_name,
      customer_phone: row.customer_phone,
      service_name: row.service_name_snapshot,
      item_name: row.item_name,
      issue_summary: row.issue_summary,
      requested_delivery_at: row.requested_delivery_at,
      submitted_at: row.submitted_at,
      attachment_count: Number(row.attachment_count || 0),
      converted_job_id: row.converted_job_id,
      converted_job_token: row.converted_job_token
    }))
  });
});

router.get('/:id/attachments.zip', authMiddleware, requireCounter, (req, res) => {
  const intake = intakeSummaryRow(req.params.id);
  if (!intake) return res.status(404).json({ error: 'Intake request not found' });
  if (!canAccessOrg(req.user, intake.org_id)) {
    return res.status(403).json({ error: 'No access to this organization' });
  }
  const attachments = all(
    `SELECT *
     FROM job_intake_attachments
     WHERE intake_request_id=?
     ORDER BY id`,
    [intake.id]
  );
  if (!attachments.length) return res.status(404).json({ error: 'No files are attached to this request' });
  const zip = createZip(attachments.map(file => ({
    name: file.file_name || `attachment-${file.id}`,
    data: loadAttachmentBytes(file),
    date: file.created_at || intake.submitted_at
  })));
  const safeOrder = String(intake.request_number || `intake-${intake.id}`).replace(/[^a-z0-9._-]+/gi, '-');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeOrder}-files.zip"`);
  res.setHeader('Content-Length', zip.length);
  res.send(zip);
});

router.get('/:id', authMiddleware, requireCounter, (req, res) => {
  const intake = intakeSummaryRow(req.params.id);
  if (!intake) return res.status(404).json({ error: 'Intake request not found' });
  if (!canAccessOrg(req.user, intake.org_id)) {
    return res.status(403).json({ error: 'No access to this organization' });
  }
  const attachments = all(
    `SELECT id,file_name,mime_type,byte_size,pixel_width,pixel_height,pdf_page_count,
            analysis_status,analysis_error,metadata_json,created_at
     FROM job_intake_attachments
     WHERE intake_request_id=?
     ORDER BY id DESC`,
    [intake.id]
  ).map(file => ({
    ...file,
    metadata: parseJson(file.metadata_json, {})
  }));
  const matches = all(
    `SELECT id,name,phone,email
     FROM parties
     WHERE org_id=? AND active=1 AND type IN ('customer','both')
       AND (
         phone=? OR
         (email IS NOT NULL AND email=?) OR
         name LIKE ?
       )
     ORDER BY
       CASE WHEN phone=? THEN 0 WHEN email=? THEN 1 ELSE 2 END,
       name
     LIMIT 20`,
    [
      intake.org_id,
      intake.customer_phone,
      cleanText(intake.customer_email, 200) || null,
      `%${cleanText(intake.customer_name, 120)}%`,
      intake.customer_phone,
      cleanText(intake.customer_email, 200) || null
    ]
  );
  res.json({
    ...intake,
    metadata: parseJson(intake.metadata_json, {}),
    attachments,
    matching_parties: matches
  });
});

router.patch('/:id', authMiddleware, requireCounter, (req, res) => {
  const intake = intakeSummaryRow(req.params.id);
  if (!intake) return res.status(404).json({ error: 'Intake request not found' });
  if (!canAccessOrg(req.user, intake.org_id)) {
    return res.status(403).json({ error: 'No access to this organization' });
  }
  const nextStatus = cleanText(req.body.status, 30).toUpperCase() || intake.status;
  if (!['SUBMITTED', 'REVIEWED', 'CANCELLED', 'CONVERTED'].includes(nextStatus)) {
    return res.status(400).json({ error: 'Invalid intake status' });
  }
  const internalNotes = cleanText(req.body.internal_notes, 4000);
  run(
    `UPDATE job_intake_requests
     SET status=?,internal_notes=?,reviewed_by=?,reviewed_at=datetime('now'),updated_at=datetime('now')
     WHERE id=?`,
    [nextStatus, internalNotes, req.user.id, intake.id]
  );
  recordSyncRevision(intake.org_id, 'INTAKE', intake.id, 'STATUS');
  insertAuditEvent({
    orgId: intake.org_id,
    entityType: 'INTAKE',
    entityId: intake.id,
    action: 'REVIEW',
    actorUserId: req.user.id,
    actorRole: req.user.role,
    oldData: { status: intake.status, internal_notes: intake.internal_notes },
    newData: { status: nextStatus, internal_notes: internalNotes },
    ipAddress: req.ip
  });
  res.json({ success: true, status: nextStatus, internal_notes: internalNotes });
});

router.get('/:id/attachments/:attachmentId/content', authMiddleware, requireCounter, (req, res) => {
  const intake = intakeSummaryRow(req.params.id);
  if (!intake) return res.status(404).json({ error: 'Intake request not found' });
  if (!canAccessOrg(req.user, intake.org_id)) {
    return res.status(403).json({ error: 'No access to this organization' });
  }
  const attachment = get(
    `SELECT * FROM job_intake_attachments
     WHERE id=? AND intake_request_id=?`,
    [req.params.attachmentId, intake.id]
  );
  if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
  const bytes = loadAttachmentBytes(attachment);
  res.setHeader('Content-Type', attachment.mime_type || 'application/octet-stream');
  res.setHeader('Content-Length', bytes.length);
  res.setHeader('Content-Disposition', `inline; filename="${String(attachment.file_name || 'attachment').replace(/"/g, '')}"`);
  res.send(bytes);
});

router.post('/:id/convert', authMiddleware, requireCounter, (req, res) => {
  const intake = intakeSummaryRow(req.params.id);
  if (!intake) return res.status(404).json({ error: 'Intake request not found' });
  if (!canAccessOrg(req.user, intake.org_id)) {
    return res.status(403).json({ error: 'No access to this organization' });
  }
  if (intake.converted_job_id) {
    return res.json({
      success: true,
      existing: true,
      job_id: intake.converted_job_id,
      job_token: intake.converted_job_token
    });
  }

  const org = orgRow(intake.org_id);
  const service = get(
    `SELECT s.*,c.name category_name,sc.name subcategory_name
     FROM job_services s
     JOIN job_service_categories c ON c.id=s.category_id
     LEFT JOIN job_service_subcategories sc ON sc.id=s.subcategory_id
     WHERE s.id=? AND s.org_id=? AND s.active=1`,
    [Number(req.body.service_id || intake.service_id), intake.org_id]
  );
  if (!service) return res.status(400).json({ error: 'Select an active service for conversion' });

  const promisedDeliveryAt = cleanText(req.body.promised_delivery_at, 40) || cleanText(intake.requested_delivery_at, 40);
  if (!promisedDeliveryAt) return res.status(400).json({ error: 'Promised delivery date is required' });

  let estimateLines = Array.isArray(req.body.estimate_lines) ? req.body.estimate_lines : [];
  if (!estimateLines.length) {
    const quantity = Math.max(0.001, Number(req.body.quantity || intake.quantity || 1));
    const unitPrice = Number(req.body.estimate_unit_price || 0);
    if (unitPrice > 0) {
      estimateLines = [{
        description: cleanText(req.body.description, 500) || intake.issue_summary,
        quantity,
        unit: cleanText(req.body.unit || service.default_unit, 30) || 'NOS',
        unit_price: unitPrice,
        tax_rate: Number(req.body.tax_rate || 0),
        line_total: quantity * unitPrice
      }];
    }
  }
  if (!estimateLines.length) {
    return res.status(400).json({ error: 'Estimate amount is required before conversion' });
  }

  const selectedPartyId = Number(req.body.party_id || 0) || null;
  let party = selectedPartyId
    ? partyForOrg(selectedPartyId, intake.org_id)
    : (intake.party_id ? partyForOrg(intake.party_id, intake.org_id) : null);
  const quantity = Math.max(0.001, Number(req.body.quantity || intake.quantity || 1));
  const unit = cleanText(req.body.unit || service.default_unit, 30) || 'NOS';
  const description = cleanText(req.body.description, 500) || intake.issue_summary || service.name;
  const estimateTaxInclusive = Boolean(req.body.tax_inclusive && org?.gst_type === 'regular');

  try {
    const converted = transaction(() => {
      if (!party) {
        const createdParty = run(
          `INSERT INTO parties
           (org_id,shared,type,name,registered_name,phone,email,address,city,state,pincode,gstin,gst_type,delivery_addresses,digital_signature_required,opening_balance,balance_type)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            intake.org_id,
            0,
            'customer',
            intake.customer_name,
            intake.customer_name,
            intake.customer_phone || null,
            intake.customer_email || null,
            intake.customer_address || null,
            null,
            'Andhra Pradesh',
            null,
            null,
            'unregistered',
            '[]',
            0,
            0,
            'cr'
          ]
        );
        party = get('SELECT * FROM parties WHERE id=?', [createdParty.lastInsertRowid]);
      }

      const token = nextJobToken(intake.org_id, new Date().toISOString().slice(0, 10));
      const partySnapshot = {
        name: party.name,
        phone: party.phone,
        email: party.email,
        address: party.address,
        gstin: party.gstin
      };
      const job = run(
        `INSERT INTO job_orders
         (org_id,job_token,party_id,party_snapshot,priority,promised_delivery_at,current_status,
          customer_commitment,counter_note,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          intake.org_id,
          token,
          party.id,
          JSON.stringify(partySnapshot),
          ['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(cleanText(req.body.priority, 20).toUpperCase())
            ? cleanText(req.body.priority, 20).toUpperCase()
            : 'NORMAL',
          promisedDeliveryAt,
          'WAITING',
          cleanText(req.body.customer_commitment, 4000) || intake.issue_details,
          cleanText(req.body.counter_note, 4000) || `Converted from intake ${intake.request_number}`,
          req.user.id
        ]
      );

      run(
        `INSERT INTO job_items
         (job_id,service_id,category_snapshot,subcategory_snapshot,service_snapshot,description,
          specification_json,quantity,unit,sort_order,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          job.lastInsertRowid,
          service.id,
          service.category_name,
          service.subcategory_name || null,
          service.name,
          description,
          JSON.stringify({
            intake_request_number: intake.request_number,
            item_type: intake.item_type,
            item_name: intake.item_name,
            device_brand: intake.device_brand,
            device_model: intake.device_model,
            device_serial: intake.device_serial,
            notes: intake.issue_details
          }),
          quantity,
          unit,
          0,
          req.user.id
        ]
      );

      const normalized = estimateLines.map((line, index) => {
        const lineQuantity = Number(line.quantity || quantity || 1);
        const enteredUnitPrice = Number(line.unit_price || 0);
        const taxRate = Number(line.tax_rate || 0);
        const grossPaise = paise(line.line_total ?? lineQuantity * enteredUnitPrice);
        const taxPaise = estimateTaxInclusive && taxRate > 0
          ? Math.round(grossPaise * taxRate / (100 + taxRate))
          : Math.round(grossPaise * taxRate / 100);
        const taxablePaise = estimateTaxInclusive ? grossPaise - taxPaise : grossPaise;
        return {
          description: cleanText(line.description, 500) || description,
          quantity: lineQuantity,
          unit: cleanText(line.unit || unit, 30),
          entered_unit_price_paise: paise(enteredUnitPrice),
          unit_price_paise: lineQuantity > 0 ? Math.round(taxablePaise / lineQuantity) : 0,
          tax_rate: taxRate,
          line_total_paise: taxablePaise,
          tax_paise: taxPaise,
          sort_order: index
        };
      });
      const subtotal = normalized.reduce((sum, line) => sum + line.line_total_paise, 0);
      const tax = normalized.reduce((sum, line) => sum + line.tax_paise, 0);
      const totalBeforeRound = subtotal + tax;
      const roundOff = req.body.round_off_enabled === false
        ? 0
        : Math.round(totalBeforeRound / 100) * 100 - totalBeforeRound;
      run(
        `INSERT INTO job_estimates
         (job_id,revision_no,status,subtotal_paise,tax_paise,total_paise,round_off_paise,lines_json,tax_inclusive,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          job.lastInsertRowid,
          1,
          'ACCEPTED',
          subtotal,
          tax,
          totalBeforeRound + roundOff,
          roundOff,
          JSON.stringify(normalized),
          estimateTaxInclusive ? 1 : 0,
          req.user.id
        ]
      );

      const intakeAttachments = all(
        `SELECT * FROM job_intake_attachments WHERE intake_request_id=? ORDER BY id`,
        [intake.id]
      );
      for (const attachment of intakeAttachments) {
        run(
          `INSERT INTO job_attachments
           (job_id,entity_type,entity_id,purpose,upload_origin,file_name,mime_type,byte_size,sha256,storage_path,content_base64,
            visible_to_customer,pixel_width,pixel_height,pdf_page_count,analysis_status,analysis_error,metadata_json,created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            job.lastInsertRowid,
            'JOB',
            job.lastInsertRowid,
            'CUSTOMER_UPLOAD',
            'CUSTOMER_PORTAL',
            attachment.file_name,
            attachment.mime_type,
            attachment.byte_size,
            attachment.sha256,
            attachment.storage_path || null,
            attachment.content_base64,
            1,
            attachment.pixel_width,
            attachment.pixel_height,
            attachment.pdf_page_count,
            attachment.analysis_status,
            attachment.analysis_error,
            attachment.metadata_json || '{}',
            req.user.id
          ]
        );
      }

      run(
        `INSERT INTO job_status_events
         (job_id,from_status,to_status,reason,actor_user_id,operation_id)
         VALUES (?,?,?,?,?,?)`,
        [job.lastInsertRowid, null, 'WAITING', `Converted from intake ${intake.request_number}`, req.user.id, crypto.randomUUID()]
      );

      run(
        `UPDATE job_intake_requests
         SET status='CONVERTED',party_id=?,converted_job_id=?,converted_by=?,reviewed_by=?,reviewed_at=datetime('now'),
             converted_at=datetime('now'),internal_notes=?,updated_at=datetime('now')
         WHERE id=?`,
        [
          party.id,
          job.lastInsertRowid,
          req.user.id,
          req.user.id,
          cleanText(req.body.internal_notes, 4000),
          intake.id
        ]
      );
      recordSyncRevision(intake.org_id, 'INTAKE', intake.id, 'CONVERT');

      insertAuditEvent({
        jobId: job.lastInsertRowid,
        orgId: intake.org_id,
        entityType: 'JOB',
        entityId: job.lastInsertRowid,
        action: 'CREATE',
        actorUserId: req.user.id,
        actorRole: req.user.role,
        reason: `Converted from intake ${intake.request_number}`,
        newData: { token, intake_request_id: intake.id, party_id: party.id },
        ipAddress: req.ip
      });
      insertAuditEvent({
        orgId: intake.org_id,
        entityType: 'INTAKE',
        entityId: intake.id,
        action: 'CONVERT',
        actorUserId: req.user.id,
        actorRole: req.user.role,
        oldData: { status: intake.status },
        newData: { status: 'CONVERTED', job_id: job.lastInsertRowid, party_id: party.id },
        ipAddress: req.ip
      });
      return {
        job_id: job.lastInsertRowid,
        job_token: token,
        party_id: party.id
      };
    });
    res.json({ success: true, ...converted });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
