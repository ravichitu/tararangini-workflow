const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { get, run, all, transaction } = require('../db/db');
const { authMiddleware, checkOrgAccess, userPermissions, canAccessOrg } = require('../middleware/auth');
const { postBill, postPayment, billSettlement, getFY } = require('../accounting/accounting');
const { invoicePrefix, invoiceNumber } = require('../business/numbering');
const { partyForOrg } = require('../business/parties');
const { summarizeServiceGroup } = require('../business/job-service-groups');
const { validateStockAvailability } = require('../business/stock');
const { analyzeAttachment, validateAttachmentInput, normalizeMimeType } = require('../services/attachment-analysis');
const {
  shouldAnalyzeSynchronously,
  queuedAnalysisFields,
  enqueueAttachmentAnalysis
} = require('../services/attachment-processing');
const { persistAttachmentBytes, loadAttachmentBytes, hasAttachmentBytes } = require('../services/attachment-storage');
const { scheduleJobAttachmentCleanup, purgeExpiredAttachments } = require('../services/attachment-retention');
const { buildAbsoluteUrl } = require('../security/runtime-config');
const { requireRegisteredOfflineDevice } = require('../security/registered-device');

const STATUSES = [
  'WAITING', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_FOR_MATERIAL',
  'QUALITY_CHECK', 'COMPLETED', 'READY_FOR_DELIVERY', 'DELIVERED'
];
const TRANSITIONS = {
  WAITING: ['ACCEPTED'],
  ACCEPTED: ['WAITING', 'IN_PROGRESS'],
  IN_PROGRESS: ['WAITING_FOR_MATERIAL', 'QUALITY_CHECK'],
  WAITING_FOR_MATERIAL: ['IN_PROGRESS'],
  QUALITY_CHECK: ['IN_PROGRESS', 'COMPLETED'],
  COMPLETED: ['IN_PROGRESS', 'READY_FOR_DELIVERY'],
  READY_FOR_DELIVERY: ['IN_PROGRESS', 'DELIVERED'],
  DELIVERED: []
};
const PRODUCTION_ROLES = new Set(['operator', 'senior_operator', 'engineer']);

function recordSyncRevision(orgId, entityType, entityId, operation, recordVersion = null) {
  run(`INSERT INTO sync_revisions
    (org_id,entity_type,entity_id,operation,record_version,changed_at)
    VALUES (?,?,?,?,?,datetime('now'))`,
  [orgId, entityType, String(entityId), operation, recordVersion]);
}

router.use(authMiddleware);
router.use(checkOrgAccess);

function permissions(req) {
  return userPermissions(req.user);
}

function requireJobPermission(name) {
  return (req, res, next) => {
    if (!permissions(req)[name]) return res.status(403).json({ error: `${name} permission required` });
    next();
  };
}

function requireAnyJobPermission(...names) {
  return (req, res, next) => {
    const granted = permissions(req);
    if (!names.some(name => granted[name])) {
      return res.status(403).json({ error: `${names.join(' or ')} permission required` });
    }
    next();
  };
}

function isFinanceUser(req) {
  return Boolean(permissions(req).jobs_finance);
}

function isOperationsUser(req) {
  return Boolean(permissions(req).jobs_operations);
}

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

function resolveJobParty(req, orgId) {
  const selected = partyForOrg(req.body.party_id, orgId);
  if (selected) return selected;
  const snapshot = req.body.offline_party && typeof req.body.offline_party === 'object'
    ? req.body.offline_party : null;
  const name = cleanText(snapshot?.name, 200);
  const phone = cleanText(snapshot?.phone, 40);
  if (!name || !phone) return null;
  const existing = get(
    `SELECT * FROM parties WHERE org_id=? AND active=1 AND
      ((phone<>'' AND phone=?) OR (LOWER(name)=LOWER(?) AND COALESCE(email,'')=COALESCE(?,'')))
     ORDER BY CASE WHEN phone=? THEN 0 ELSE 1 END,id LIMIT 1`,
    [orgId, phone, name, cleanText(snapshot?.email, 200), phone]
  );
  if (existing) return existing;
  const result = run(
    `INSERT INTO parties
      (org_id,shared,type,name,registered_name,phone,email,address,city,state,pincode,gstin,gst_type,delivery_addresses)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [orgId, 0, 'customer', name, name, phone, cleanText(snapshot?.email, 200) || null,
      cleanText(snapshot?.address, 500) || null, cleanText(snapshot?.city, 100) || null,
      cleanText(snapshot?.state, 100) || 'Andhra Pradesh', cleanText(snapshot?.pincode, 20) || null,
      cleanText(snapshot?.gstin, 40) || null, cleanText(snapshot?.gst_type, 40) || 'unregistered', '[]']
  );
  return get('SELECT * FROM parties WHERE id=?', [result.lastInsertRowid]);
}

function rupees(value) {
  return Number((Number(value || 0) / 100).toFixed(2));
}

function hashEvidence(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function audit(req, jobId, orgId, entityType, entityId, action, oldData, newData, reason) {
  run(
    `INSERT INTO job_audit_events
     (job_id,org_id,entity_type,entity_id,action,actor_user_id,actor_role,reason,old_data,new_data,operation_id,ip_address)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [jobId || null, orgId, entityType, entityId || null, action, req.user.id, req.user.role,
     reason || null, oldData ? JSON.stringify(oldData) : null, newData ? JSON.stringify(newData) : null,
     crypto.randomUUID(), req.ip]
  );
}

function jobLockReason(job) {
  if (!job) return '';
  if (job.final_bill_id || job.delivered_at || job.closed_at || job.current_status === 'DELIVERED') {
    return 'Job is delivered or invoice-linked and is locked. Create an owner-approved correction instead of editing history.';
  }
  return '';
}

function rejectLockedJob(res, job) {
  const reason = jobLockReason(job);
  if (!reason) return false;
  res.status(423).json({ error: reason, locked: true, current_status: job.current_status });
  return true;
}

function attachmentRow(id) {
  return get(
    `SELECT a.*,j.org_id,j.job_token
     FROM job_attachments a
     JOIN job_orders j ON j.id=a.job_id
     WHERE a.id=?`,
    [id]
  );
}

function projectAttachment(attachment) {
  return {
    ...attachment,
    content_available: hasAttachmentBytes(attachment),
    metadata: parseJson(attachment.metadata_json, {})
  };
}

async function createAttachmentRecord({
  jobId,
  entityType,
  entityId,
  purpose,
  fileName,
  mimeType,
  contentBase64,
  visibleToCustomer,
  createdBy,
  uploadOrigin
}) {
  const bytes = Buffer.from(String(contentBase64 || '').replace(/\s/g, ''), 'base64');
  const normalizedMimeType = normalizeMimeType(fileName, mimeType);
  validateAttachmentInput({ bytes, mimeType: normalizedMimeType, uploadOrigin });
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const stored = persistAttachmentBytes({
    scope: 'job',
    fileName,
    sha256,
    bytes
  });
  const analyzeNow = shouldAnalyzeSynchronously({ hasCustomerPdfPrintRequest: false });
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
  const result = run(
    `INSERT INTO job_attachments
     (job_id,entity_type,entity_id,purpose,upload_origin,file_name,mime_type,byte_size,sha256,storage_path,content_base64,
      visible_to_customer,pixel_width,pixel_height,pdf_page_count,analysis_status,analysis_error,metadata_json,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      jobId,
      entityType,
      entityId || null,
      purpose,
      uploadOrigin,
      fileName,
      analysis.mimeType,
      bytes.length,
      sha256,
      stored.storage_path,
      stored.content_base64,
      visibleToCustomer ? 1 : 0,
      analysis.pixelWidth,
      analysis.pixelHeight,
      analysis.pdfPageCount,
      analysis.analysisStatus,
      analysis.analysisError,
      JSON.stringify(analysis.metadata || {}),
      createdBy
    ]
  );
  if (!analyzeNow) {
    enqueueAttachmentAnalysis({
      table: 'job_attachments',
      id: result.lastInsertRowid,
      metadata: {}
    });
  }
  return attachmentRow(result.lastInsertRowid);
}

function ensureDefaultCatalog(orgId, userId) {
  const org = get('SELECT job_catalog_auto_seed FROM orgs WHERE id=?', [orgId]);
  if (Number(org?.job_catalog_auto_seed) === 0) return;
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

function nextBillNumber(orgId, format, fy) {
  const org = get('SELECT * FROM orgs WHERE id=?', [orgId]);
  const prefix = invoicePrefix(org, format);
  let seq = get('SELECT last_number FROM bill_sequences WHERE org_id=? AND format=? AND fy=?', [orgId, format, fy]);
  if (!seq) {
    run('INSERT INTO bill_sequences (org_id,format,fy,prefix,last_number) VALUES (?,?,?,?,0)',
      [orgId, format, fy, prefix]);
    seq = { last_number: 0 };
  }
  const next = Number(seq.last_number || 0) + 1;
  run('UPDATE bill_sequences SET last_number=?,prefix=? WHERE org_id=? AND format=? AND fy=?',
    [next, prefix, orgId, format, fy]);
  return invoiceNumber(prefix, fy, next);
}

function nextPaymentNumber(orgId, dateValue) {
  const fy = getFY(dateValue);
  const org = get('SELECT display_name FROM orgs WHERE id=?', [orgId]);
  const orgCode = String(org?.display_name || 'ORG').slice(0, 3).toUpperCase();
  let seq = get('SELECT last_number FROM bill_sequences WHERE org_id=? AND format=? AND fy=?', [orgId, 'PR', fy]);
  if (!seq) {
    run('INSERT INTO bill_sequences (org_id,format,fy,prefix,last_number) VALUES (?,?,?,?,0)', [orgId, 'PR', fy, 'PR']);
    seq = { last_number: 0 };
  }
  const next = Number(seq.last_number || 0) + 1;
  run('UPDATE bill_sequences SET last_number=? WHERE org_id=? AND format=? AND fy=?', [next, orgId, 'PR', fy]);
  return { fy, number: `${orgCode}/PR/${fy}/${String(next).padStart(4, '0')}` };
}

function jobInvoiceLines(jobId, estimate, additions = []) {
  const estimateLines = parseJson(estimate?.lines_json || '[]', []);
  const approvedAdditionLines = additions.map(addition => ({
    description: addition.customer_description,
    quantity: addition.quantity,
    unit: addition.unit,
    unit_price_paise: addition.unit_price_paise,
    tax_rate: addition.tax_rate,
    line_total_paise: Math.round(addition.quantity * addition.unit_price_paise)
  }));
  const allLines = [...estimateLines, ...approvedAdditionLines];
  const subtotalPaise = allLines.reduce((sum, line) => sum + Number(line.line_total_paise || 0), 0);
  const taxPaise = allLines.reduce(
    (sum, line) => sum + Math.round(Number(line.line_total_paise || 0) * Number(line.tax_rate || 0) / 100), 0
  );
  const totalBeforeRoundPaise = subtotalPaise + taxPaise;
  const roundOffPaise = Math.round(totalBeforeRoundPaise / 100) * 100 - totalBeforeRoundPaise;
  const totalPaise = totalBeforeRoundPaise + roundOffPaise;
  return {
    allLines,
    subtotalPaise,
    taxPaise,
    roundOffPaise,
    totalPaise,
    items: allLines.map((line, index) => ({
      sno: index + 1,
      item_name: line.description,
      qty: Number(line.quantity || 1),
      unit: line.unit || 'NOS',
      rate: rupees(line.unit_price_paise),
      amount: rupees(line.line_total_paise),
      gst_rate: Number(line.tax_rate || 0)
    }))
  };
}

function numberToWords(value) {
  return `${Number(value || 0).toFixed(2)} Rupees Only`;
}

function createReceipt({ orgId, partyId, amount, mode, reference, date, userId, billId, narration, depositAccountId }) {
  if (amount <= 0) return null;
  if (mode !== 'cash' && !cleanText(reference, 200)) {
    throw new Error(`${mode.toUpperCase()} receipt reference is required`);
  }
  const number = nextPaymentNumber(orgId, date);
  const party = get('SELECT name,address,gstin FROM parties WHERE id=?', [partyId]);
  const result = run(
    `INSERT INTO payments
     (org_id,payment_number,payment_date,fy,party_id,party_snapshot,type,mode,deposit_account_id,amount,reference,linked_bills,narration,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [orgId, number.number, date, number.fy, partyId,
     JSON.stringify(party || {}), 'received', mode, depositAccountId || null, amount, reference || null,
     JSON.stringify(billId ? [{ bill_id: billId, amount }] : []), narration || null, userId]
  );
  if (billId) run('INSERT INTO payment_allocations (payment_id,bill_id,amount) VALUES (?,?,?)',
    [result.lastInsertRowid, billId, amount]);
  const payment = get('SELECT * FROM payments WHERE id=?', [result.lastInsertRowid]);
  postPayment(payment);
  return payment;
}

function jobRow(id) {
  return get(
    `SELECT j.*,p.name party_name,p.phone party_phone,p.email party_email,
      b.bill_number final_bill_number,
      pb.bill_number pre_bill_number,
      pb.grand_total pre_bill_total,
      pb.payment_mode pre_bill_payment_mode,
      (SELECT ji.category_snapshot FROM job_items ji WHERE ji.job_id=j.id AND ji.active=1 ORDER BY ji.sort_order,ji.id LIMIT 1) primary_category_name,
      (SELECT ji.subcategory_snapshot FROM job_items ji WHERE ji.job_id=j.id AND ji.active=1 ORDER BY ji.sort_order,ji.id LIMIT 1) primary_subcategory_name,
      (SELECT ji.service_snapshot FROM job_items ji WHERE ji.job_id=j.id AND ji.active=1 ORDER BY ji.sort_order,ji.id LIMIT 1) primary_service_name,
      (SELECT ji.description FROM job_items ji WHERE ji.job_id=j.id AND ji.active=1 ORDER BY ji.sort_order,ji.id LIMIT 1) primary_item_description,
      (SELECT ji.quantity FROM job_items ji WHERE ji.job_id=j.id AND ji.active=1 ORDER BY ji.sort_order,ji.id LIMIT 1) primary_item_quantity,
      (SELECT ji.unit FROM job_items ji WHERE ji.job_id=j.id AND ji.active=1 ORDER BY ji.sort_order,ji.id LIMIT 1) primary_item_unit
     FROM job_orders j
     JOIN parties p ON p.id=j.party_id
     LEFT JOIN bills b ON b.id=j.final_bill_id
     LEFT JOIN bills pb ON pb.id=j.pre_bill_id
     WHERE j.id=?`,
    [id]
  );
}

function requireJobOrgAccess(req, res, job) {
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return false;
  }
  if (!canAccessOrg(req.user, Number(job.org_id))) {
    res.status(403).json({ error: 'No access to this organization' });
    return false;
  }
  return true;
}

function assignmentFor(jobId) {
  return get(
    `SELECT a.*,u.name employee_name,byu.name assigned_by_name
     FROM job_assignments a
     JOIN users u ON u.id=a.employee_id
     LEFT JOIN users byu ON byu.id=a.assigned_by
     WHERE a.job_id=? AND a.status IN ('PENDING_ACCEPTANCE','ACCEPTED')
     ORDER BY a.id DESC LIMIT 1`,
    [jobId]
  );
}

function activeAcceptedAssignment(jobId) {
  return get(
    `SELECT * FROM job_assignments
     WHERE job_id=? AND status='ACCEPTED'
     ORDER BY id DESC LIMIT 1`,
    [jobId]
  );
}

function materialCostPaise(materials) {
  return (materials || []).reduce((sum, material) =>
    sum + Math.round(Number(material.quantity || 0) * Number(material.rate || 0) * 100), 0);
}

function jobCommercialSummary({ estimate, additions, materials, finalBill }) {
  const estimatePaise = Number(estimate?.total_paise || 0);
  const approvedAdditionsPaise = (additions || [])
    .filter(addition => addition.state === 'APPROVED')
    .reduce((sum, addition) => sum + Number(addition.total_paise || 0), 0);
  const projectedRevenuePaise = estimatePaise + approvedAdditionsPaise;
  const materialsCostPaise = materialCostPaise(materials);
  const finalInvoicePaise = finalBill ? paise(finalBill.grand_total || 0) : 0;
  return {
    estimate_paise: estimatePaise,
    approved_additions_paise: approvedAdditionsPaise,
    projected_revenue_paise: projectedRevenuePaise,
    materials_cost_paise: materialsCostPaise,
    material_entries: Number((materials || []).length),
    projected_margin_paise: projectedRevenuePaise - materialsCostPaise,
    final_invoice_paise: finalInvoicePaise || null,
    final_margin_paise: finalBill ? finalInvoicePaise - materialsCostPaise : null
  };
}

function projectJob(req, row, full = false) {
  const finance = isFinanceUser(req);
  const operations = isOperationsUser(req);
  const ownerCommercialView = req.user?.role === 'owner';
  const canViewCommercials = finance || ownerCommercialView;
  const result = {
    id: row.id,
    org_id: row.org_id,
    job_token: row.job_token,
    provisional_token: row.provisional_token,
    priority: row.priority,
    promised_delivery_at: row.promised_delivery_at,
    current_status: row.current_status,
    customer_commitment: row.customer_commitment,
    counter_note: operations || canViewCommercials || full ? row.counter_note : undefined,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    pre_bill_id: canViewCommercials ? row.pre_bill_id : undefined,
    pre_bill_number: canViewCommercials ? row.pre_bill_number : undefined,
    final_bill_id: canViewCommercials ? row.final_bill_id : undefined,
    final_bill_number: canViewCommercials ? row.final_bill_number : undefined,
    customer: operations && !canViewCommercials
      ? { reference: `C-${String(row.party_id).padStart(5, '0')}` }
      : { id: row.party_id, name: row.party_name, phone: row.party_phone, email: row.party_email },
    assignment: assignmentFor(row.id),
    primary_item: row.primary_item_description ? {
      description: row.primary_item_description,
      quantity: row.primary_item_quantity,
      unit: row.primary_item_unit
    } : undefined,
    service_summary: row.primary_service_name ? {
      category_name: row.primary_category_name,
      subcategory_name: row.primary_subcategory_name,
      service_name: row.primary_service_name,
      ...summarizeServiceGroup({
        category_name: row.primary_category_name,
        subcategory_name: row.primary_subcategory_name,
        name: row.primary_service_name
      })
    } : undefined
  };
  if (canViewCommercials) {
    const estimate = get(
      `SELECT * FROM job_estimates WHERE job_id=? AND status='ACCEPTED'
       ORDER BY revision_no DESC LIMIT 1`, [row.id]
    );
    result.finance = {
      financial_status: row.financial_status,
      advance_paise: row.advance_paise,
      pre_bill: row.pre_bill_id ? {
        id: row.pre_bill_id,
        bill_number: row.pre_bill_number,
        grand_total: row.pre_bill_total,
        payment_mode: row.pre_bill_payment_mode,
        settlement: billSettlement(get('SELECT * FROM bills WHERE id=?', [row.pre_bill_id]))
      } : null,
      estimate: estimate ? { ...estimate, lines: parseJson(estimate.lines_json, []) } : null
    };
  }
  if (full) {
    result.items = all('SELECT * FROM job_items WHERE job_id=? AND active=1 ORDER BY sort_order,id', [row.id])
      .map(item => ({ ...item, specifications: parseJson(item.specification_json, {}) }));
    result.attachments = all(
      `SELECT id,entity_type,entity_id,purpose,upload_origin,file_name,mime_type,byte_size,sha256,storage_path,content_base64,
              visible_to_customer,pixel_width,pixel_height,pdf_page_count,analysis_status,analysis_error,metadata_json,
              retention_policy,retention_state,retention_delete_after,archived_at,archived_by,archive_reason,
              physical_deleted_at,physical_deleted_by,physical_delete_reason,created_at
       FROM job_attachments WHERE job_id=? ORDER BY id DESC`,
      [row.id]
    ).map(projectAttachment)
      .map(({ storage_path, content_base64, ...attachment }) => attachment);
    result.status_events = all(
      `SELECT e.*,u.name actor_name FROM job_status_events e
       LEFT JOIN users u ON u.id=e.actor_user_id WHERE e.job_id=? ORDER BY e.id DESC`, [row.id]
    );
    result.assignments = all(
      `SELECT a.*,u.name employee_name,byu.name assigned_by_name
       FROM job_assignments a JOIN users u ON u.id=a.employee_id
       LEFT JOIN users byu ON byu.id=a.assigned_by WHERE a.job_id=? ORDER BY a.id DESC`, [row.id]
    );
    result.work_reports = all(
      `SELECT r.*,u.name employee_name FROM job_work_reports r
       JOIN users u ON u.id=r.employee_id WHERE r.job_id=? ORDER BY r.id DESC`, [row.id]
    );
    result.materials = all(
      `SELECT m.*,u.name consumed_by_name,i.name current_item_name,i.item_code current_item_code
       FROM job_material_consumptions m
       JOIN users u ON u.id=m.consumed_by
       LEFT JOIN items i ON i.id=m.item_id
       WHERE m.job_id=? ORDER BY m.id DESC`,
      [row.id]
    );
    result.additions = all(
      `SELECT a.*,u.name proposed_by_name,p.name priced_by_name,
        ca.decision approval_decision,ca.method approval_method,ca.decided_at approval_at
       FROM job_additions a JOIN users u ON u.id=a.proposed_by
       LEFT JOIN users p ON p.id=a.priced_by
       LEFT JOIN job_customer_approvals ca ON ca.job_addition_id=a.id
       WHERE a.job_id=? ORDER BY a.id DESC`, [row.id]
    ).map(addition => {
      if (!canViewCommercials) {
        delete addition.unit_price_paise;
        delete addition.total_paise;
        delete addition.priced_by;
        delete addition.priced_by_name;
      }
      return addition;
    });
    result.internal_notes = all(
      `SELECT n.*,u.name author_name,u.role author_role
       FROM job_internal_notes n JOIN users u ON u.id=n.author_user_id
       WHERE n.job_id=? ORDER BY n.id DESC`, [row.id]
    ).map(note => ({ ...note, file_names: parseJson(note.file_names_json, []) }));
    if (canViewCommercials) {
      result.delivery = get('SELECT * FROM job_delivery_acknowledgements WHERE job_id=?', [row.id]);
      const finalBill = row.final_bill_id ? get('SELECT * FROM bills WHERE id=?', [row.final_bill_id]) : null;
      result.settlement = finalBill ? billSettlement(finalBill) : null;
      result.finance.production_summary = jobCommercialSummary({
        estimate: result.finance?.estimate,
        additions: result.additions,
        materials: result.materials,
        finalBill
      });
      result.owner_work_order = {
        work_order_id: row.job_token,
        job_id: row.id,
        customer_name: row.party_name,
        current_status: row.current_status,
        promised_delivery_at: row.promised_delivery_at,
        customer_request: row.customer_commitment || '',
        counter_note: row.counter_note || '',
        items: result.items.map(item => ({
          service: item.service_snapshot,
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
          specifications: item.specifications || {}
        })),
        estimate: result.finance?.estimate ? {
          revision_no: result.finance.estimate.revision_no,
          status: result.finance.estimate.status,
          subtotal_paise: result.finance.estimate.subtotal_paise,
          tax_paise: result.finance.estimate.tax_paise,
          total_paise: result.finance.estimate.total_paise,
          round_off_paise: result.finance.estimate.round_off_paise,
          tax_inclusive: Boolean(result.finance.estimate.tax_inclusive),
          lines: result.finance.estimate.lines || []
        } : null,
        commercial_summary: result.finance.production_summary,
        pre_bill: result.finance.pre_bill,
        work_reports: result.work_reports.map(report => ({
          id: report.id,
          report_type: report.report_type,
          progress_percent: report.progress_percent,
          report_text: report.report_text,
          checklist: parseJson(report.checklist_json, {}),
          employee_name: report.employee_name,
          started_at: report.started_at,
          completed_at: report.completed_at,
          created_at: report.created_at
        })),
        materials: result.materials.map(material => ({
          id: material.id,
          item_id: material.item_id,
          item_name: material.item_name_snapshot,
          item_code: material.item_code_snapshot,
          quantity: material.quantity,
          unit: material.unit,
          rate: material.rate,
          notes: material.notes,
          consumed_by_name: material.consumed_by_name,
          created_at: material.created_at
        })),
        additions: result.additions.map(addition => ({
          id: addition.id,
          state: addition.state,
          internal_reason: addition.internal_reason,
          customer_description: addition.customer_description,
          quantity: addition.quantity,
          unit: addition.unit,
          unit_price_paise: addition.unit_price_paise,
          total_paise: addition.total_paise,
          approval_decision: addition.approval_decision,
          approval_method: addition.approval_method,
          approval_at: addition.approval_at
        })),
        delivery: result.delivery ? {
          receiver_name: result.delivery.receiver_name,
          method: result.delivery.method,
          warranty_notes: result.delivery.warranty_notes,
          service_notes: result.delivery.service_notes,
          outstanding_paise: result.delivery.outstanding_paise,
          outstanding_terms: result.delivery.outstanding_terms,
          recorded_at: result.delivery.recorded_at
        } : null,
        timeline: result.status_events.map(event => ({
          to_status: event.to_status,
          reason: event.reason,
          actor_name: event.actor_name,
          occurred_at: event.occurred_at
        }))
      };
    }
  }
  Object.keys(result).forEach(key => result[key] === undefined && delete result[key]);
  return result;
}

router.get('/catalog', (req, res) => {
  const orgId = Number(req.query.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  ensureDefaultCatalog(orgId, req.user.id);
  const includeInactive = req.user.role === 'owner' && req.query.include_inactive === '1';
  const active = includeInactive ? '' : ' AND active=1';
  res.json({
    categories: all(`SELECT * FROM job_service_categories WHERE org_id=?${active} ORDER BY sort_order,name`, [orgId]),
    subcategories: all(`SELECT * FROM job_service_subcategories WHERE org_id=?${active} ORDER BY sort_order,name`, [orgId]),
    services: all(`SELECT * FROM job_services WHERE org_id=?${active} ORDER BY sort_order,name`, [orgId])
      .map(service => ({
        ...service,
        specification_schema: parseJson(service.specification_schema, {}),
        allowed_units: parseJson(service.allowed_units, [])
      }))
  });
});

router.post('/catalog/categories', requireJobPermission('jobs_catalog'), (req, res) => {
  const orgId = Number(req.body.org_id);
  const code = cleanText(req.body.code, 40).toUpperCase();
  const name = cleanText(req.body.name, 120);
  if (!orgId || !code || !name) return res.status(400).json({ error: 'Category name and code are required' });
  const existing = get(`SELECT * FROM job_service_categories
    WHERE org_id=? AND (code=? OR lower(name)=lower(?)) LIMIT 1`, [orgId, code, name]);
  if (existing?.active) return res.status(409).json({ error: 'A category with this name or code already exists in this organization' });
  if (existing) {
    run(`UPDATE job_service_categories
      SET code=?,name=?,description=?,sort_order=?,active=1,updated_at=datetime('now') WHERE id=?`,
    [code, name, cleanText(req.body.description), Number(req.body.sort_order || 0), existing.id]);
    audit(req, null, orgId, 'SERVICE_CATEGORY', existing.id, 'REACTIVATE', existing, req.body);
    return res.json({ success: true, id: existing.id, reactivated: true });
  }
  const result = run(
    `INSERT INTO job_service_categories (org_id,code,name,description,sort_order,created_by)
     VALUES (?,?,?,?,?,?)`,
    [orgId, code, name, cleanText(req.body.description), Number(req.body.sort_order || 0), req.user.id]
  );
  audit(req, null, orgId, 'SERVICE_CATEGORY', result.lastInsertRowid, 'CREATE', null, req.body);
  res.json({ success: true, id: result.lastInsertRowid });
});

router.post('/catalog/subcategories', requireJobPermission('jobs_catalog'), (req, res) => {
  const category = get('SELECT * FROM job_service_categories WHERE id=? AND org_id=?',
    [req.body.category_id, req.body.org_id]);
  if (!category) return res.status(400).json({ error: 'Category not found' });
  const code = cleanText(req.body.code, 60).toUpperCase();
  const name = cleanText(req.body.name, 120);
  if (!code || !name) return res.status(400).json({ error: 'Subcategory name and code are required' });
  try {
    const existing = get(`SELECT * FROM job_service_subcategories
      WHERE org_id=? AND category_id=? AND (code=? OR lower(name)=lower(?)) LIMIT 1`,
    [req.body.org_id, category.id, code, name]);
    if (existing?.active) return res.status(409).json({ error: 'A subcategory with this name or code already exists in this organization' });
    if (existing) {
      run(`UPDATE job_service_subcategories
        SET code=?,name=?,description=?,sort_order=?,active=1,updated_at=datetime('now') WHERE id=?`,
      [code, name, cleanText(req.body.description), Number(req.body.sort_order || 0), existing.id]);
      audit(req, null, req.body.org_id, 'SERVICE_SUBCATEGORY', existing.id, 'REACTIVATE', existing, req.body);
      return res.json({ success: true, id: existing.id, reactivated: true });
    }
    const result = run(
      `INSERT INTO job_service_subcategories (org_id,category_id,code,name,description,sort_order,created_by)
       VALUES (?,?,?,?,?,?,?)`,
      [req.body.org_id, category.id, code, name,
       cleanText(req.body.description), Number(req.body.sort_order || 0), req.user.id]
    );
    audit(req, null, req.body.org_id, 'SERVICE_SUBCATEGORY', result.lastInsertRowid, 'CREATE', null, req.body);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(error.message || '')) {
      return res.status(409).json({ error: 'A subcategory with this name or code already exists in this organization' });
    }
    throw error;
  }
});

router.post('/catalog/services', requireJobPermission('jobs_catalog'), (req, res) => {
  const category = get('SELECT * FROM job_service_categories WHERE id=? AND org_id=?',
    [req.body.category_id, req.body.org_id]);
  if (!category) return res.status(400).json({ error: 'Category not found' });
  if (req.body.subcategory_id && !get(
    'SELECT id FROM job_service_subcategories WHERE id=? AND category_id=? AND org_id=?',
    [req.body.subcategory_id, category.id, req.body.org_id]
  )) return res.status(400).json({ error: 'Subcategory does not belong to the selected category' });
  const orgId = Number(req.body.org_id);
  const code = cleanText(req.body.code, 60).toUpperCase();
  const name = cleanText(req.body.name, 120);
  if (!code || !name) return res.status(400).json({ error: 'Service name and code are required' });
  const existing = get(`SELECT * FROM job_services
    WHERE org_id=? AND (code=? OR lower(name)=lower(?)) LIMIT 1`, [orgId, code, name]);
  if (existing?.active) return res.status(409).json({ error: 'A service with this name or code already exists in this organization' });
  if (existing) {
    run(`UPDATE job_services SET category_id=?,subcategory_id=?,code=?,name=?,description=?,
      specification_schema=?,allowed_units=?,default_unit=?,default_sla_minutes=?,estimate_guidance=?,
      sort_order=?,active=1,updated_at=datetime('now') WHERE id=?`,
    [category.id, req.body.subcategory_id || null, code, name, cleanText(req.body.description),
      JSON.stringify(req.body.specification_schema || {}), JSON.stringify(req.body.allowed_units || []),
      cleanText(req.body.default_unit || 'NOS', 20), req.body.default_sla_minutes || null,
      JSON.stringify(req.body.estimate_guidance || {}), Number(req.body.sort_order || 0), existing.id]);
    audit(req, null, orgId, 'SERVICE', existing.id, 'REACTIVATE', existing, req.body);
    return res.json({ success: true, id: existing.id, reactivated: true });
  }
  const result = run(
    `INSERT INTO job_services
     (org_id,category_id,subcategory_id,code,name,description,specification_schema,allowed_units,
      default_unit,default_sla_minutes,estimate_guidance,sort_order,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [orgId, category.id, req.body.subcategory_id || null,
     code, name, cleanText(req.body.description),
     JSON.stringify(req.body.specification_schema || {}), JSON.stringify(req.body.allowed_units || []),
     cleanText(req.body.default_unit || 'NOS', 20), req.body.default_sla_minutes || null,
     JSON.stringify(req.body.estimate_guidance || {}), Number(req.body.sort_order || 0), req.user.id]
  );
  audit(req, null, orgId, 'SERVICE', result.lastInsertRowid, 'CREATE', null, req.body);
  res.json({ success: true, id: result.lastInsertRowid });
});

router.post('/catalog/reset', requireJobPermission('jobs_catalog'), (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can reset a service catalog' });
  const orgId = Number(req.body.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  if (cleanText(req.body.confirmation, 80) !== 'RESET SERVICE CATALOG') {
    return res.status(400).json({ error: 'Type RESET SERVICE CATALOG to confirm this action' });
  }
  const result = transaction(() => {
    const counts = {
      categories: Number(get('SELECT COUNT(*) AS count FROM job_service_categories WHERE org_id=? AND active=1', [orgId])?.count || 0),
      subcategories: Number(get('SELECT COUNT(*) AS count FROM job_service_subcategories WHERE org_id=? AND active=1', [orgId])?.count || 0),
      services: Number(get('SELECT COUNT(*) AS count FROM job_services WHERE org_id=? AND active=1', [orgId])?.count || 0)
    };
    run("UPDATE job_services SET active=0,updated_at=datetime('now') WHERE org_id=? AND active=1", [orgId]);
    run("UPDATE job_service_subcategories SET active=0,updated_at=datetime('now') WHERE org_id=? AND active=1", [orgId]);
    run("UPDATE job_service_categories SET active=0,updated_at=datetime('now') WHERE org_id=? AND active=1", [orgId]);
    run('UPDATE orgs SET job_catalog_auto_seed=0 WHERE id=?', [orgId]);
    audit(req, null, orgId, 'SERVICE_CATALOG', orgId, 'RESET_ARCHIVE', counts,
      { ...counts, preserved_job_history: true }, cleanText(req.body.reason, 500) || 'Owner requested a fresh catalog');
    return counts;
  });
  res.json({ success: true, archived: result, preserved_job_history: true });
});

router.patch('/catalog/:entity/:id', requireJobPermission('jobs_catalog'), (req, res) => {
  const tables = {
    categories: 'job_service_categories',
    subcategories: 'job_service_subcategories',
    services: 'job_services'
  };
  const table = tables[req.params.entity];
  if (!table) return res.status(404).json({ error: 'Catalog entity not found' });
  const existing = get(`SELECT * FROM ${table} WHERE id=?`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Catalog entry not found' });
  const name = req.body.name === undefined ? existing.name : cleanText(req.body.name, 120);
  const active = req.body.active === undefined ? existing.active : req.body.active ? 1 : 0;
  const sortOrder = req.body.sort_order === undefined ? existing.sort_order : Number(req.body.sort_order);
  run(`UPDATE ${table} SET name=?,active=?,sort_order=?,updated_at=datetime('now') WHERE id=?`,
    [name, active, sortOrder, existing.id]);
  audit(req, null, existing.org_id, req.params.entity.toUpperCase(), existing.id, 'UPDATE',
    existing, { name, active, sort_order: sortOrder }, cleanText(req.body.reason));
  res.json({ success: true });
});

router.get('/staff', (req, res) => {
  const orgId = Number(req.query.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  if (!canAccessOrg(req.user, orgId)) {
    return res.status(403).json({ error: 'No access to this organization' });
  }
  let rows = all(
    `SELECT id,name,username,role,org_access FROM users
     WHERE active=1 AND role IN ('operator','senior_operator','engineer') ORDER BY role,name`
  );
  rows = rows.filter(user => {
    if (user.org_access === 'all') return true;
    return parseJson(user.org_access, []).map(Number).includes(orgId);
  });
  res.json(rows.map(({ org_access, ...user }) => user));
});

router.get('/', (req, res) => {
  const orgId = Number(req.query.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  const filters = ['j.org_id=?'];
  const params = [orgId];
  if (req.query.status) { filters.push('j.current_status=?'); params.push(req.query.status); }
  if (req.query.search) {
    filters.push('(j.job_token LIKE ? OR p.name LIKE ?)');
    const search = `%${req.query.search}%`;
    params.push(search, search);
  }
  if (isOperationsUser(req) && req.query.mine === '1') {
    filters.push(`EXISTS (SELECT 1 FROM job_assignments a WHERE a.job_id=j.id AND a.employee_id=?
      AND a.status IN ('PENDING_ACCEPTANCE','ACCEPTED'))`);
    params.push(req.user.id);
  }
  const paged = req.query.page !== undefined || req.query.limit !== undefined || req.query.offset !== undefined;
  const requestedLimit = Number(req.query.limit || 100);
  const limit = Math.max(1, Math.min(500, Number.isFinite(requestedLimit) ? requestedLimit : 100));
  const requestedOffset = Number(req.query.offset || 0);
  const offset = Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : 0);
  if (paged) {
    const total = get(
      `SELECT COUNT(*) count FROM job_orders j JOIN parties p ON p.id=j.party_id WHERE ${filters.join(' AND ')}`,
      params
    )?.count || 0;
    res.set('X-Total-Count', String(total));
    res.set('X-Page-Limit', String(limit));
    res.set('X-Page-Offset', String(offset));
  }
  const pageSql = paged ? ' LIMIT ? OFFSET ?' : ' LIMIT 500';
  const queryParams = paged ? [...params, limit, offset] : params;
  const rows = all(
    `SELECT j.*,p.name party_name,p.phone party_phone,p.email party_email,b.bill_number final_bill_number,
      (SELECT ji.category_snapshot FROM job_items ji WHERE ji.job_id=j.id AND ji.active=1 ORDER BY ji.sort_order,ji.id LIMIT 1) primary_category_name,
      (SELECT ji.subcategory_snapshot FROM job_items ji WHERE ji.job_id=j.id AND ji.active=1 ORDER BY ji.sort_order,ji.id LIMIT 1) primary_subcategory_name,
      (SELECT ji.service_snapshot FROM job_items ji WHERE ji.job_id=j.id AND ji.active=1 ORDER BY ji.sort_order,ji.id LIMIT 1) primary_service_name,
      (SELECT ji.description FROM job_items ji WHERE ji.job_id=j.id AND ji.active=1 ORDER BY ji.sort_order,ji.id LIMIT 1) primary_item_description,
      (SELECT ji.quantity FROM job_items ji WHERE ji.job_id=j.id AND ji.active=1 ORDER BY ji.sort_order,ji.id LIMIT 1) primary_item_quantity,
      (SELECT ji.unit FROM job_items ji WHERE ji.job_id=j.id AND ji.active=1 ORDER BY ji.sort_order,ji.id LIMIT 1) primary_item_unit
     FROM job_orders j JOIN parties p ON p.id=j.party_id
     LEFT JOIN bills b ON b.id=j.final_bill_id
     WHERE ${filters.join(' AND ')}
     ORDER BY CASE j.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END,
       j.promised_delivery_at${pageSql}`,
    queryParams
  );
  res.json(rows.map(row => projectJob(req, row)));
});

router.get('/dashboard/summary', (req, res) => {
  const orgId = Number(req.query.org_id);
  const counts = Object.fromEntries(STATUSES.map(status => [status, 0]));
  all('SELECT current_status,COUNT(*) count FROM job_orders WHERE org_id=? GROUP BY current_status', [orgId])
    .forEach(row => { counts[row.current_status] = Number(row.count); });
  const overdue = get(
    `SELECT COUNT(*) count FROM job_orders
     WHERE org_id=? AND current_status!='DELIVERED' AND promised_delivery_at<datetime('now')`, [orgId]
  )?.count || 0;
  res.json({ counts, overdue: Number(overdue) });
});

router.post('/', requireJobPermission('jobs_counter'), async (req, res) => {
  const orgId = Number(req.body.org_id);
  if (!requireRegisteredOfflineDevice(req, res, orgId)) return;
  if (req.body.offline_id) {
    const duplicate = get('SELECT id FROM job_orders WHERE offline_id=?', [cleanText(req.body.offline_id, 100)]);
    if (duplicate) {
      return res.json({
        success: true, sync_duplicate: true, id: duplicate.id,
        job: projectJob(req, jobRow(duplicate.id), true)
      });
    }
  }
  const party = resolveJobParty(req, orgId);
  if (!orgId || !party) return res.status(400).json({ error: 'Valid organization and customer are required' });
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const estimateLines = Array.isArray(req.body.estimate_lines) ? req.body.estimate_lines : [];
  const requestedAttachments = Array.isArray(req.body.attachments) ? req.body.attachments : [];
  const org = get('SELECT gst_type FROM orgs WHERE id=?', [orgId]);
  const estimateTaxInclusive = Boolean(req.body.tax_inclusive && org?.gst_type === 'regular');
  if (!items.length) return res.status(400).json({ error: 'At least one service item is required' });
  if (!estimateLines.length) return res.status(400).json({ error: 'An estimate is required' });
  if (!req.body.promised_delivery_at) return res.status(400).json({ error: 'Promised delivery date is required' });
  ensureDefaultCatalog(orgId, req.user.id);
  try {
    const created = transaction(() => {
      const token = nextJobToken(orgId, new Date().toISOString().slice(0, 10));
      const partySnapshot = {
        name: party.name, phone: party.phone, email: party.email, address: party.address, gstin: party.gstin
      };
      const result = run(
        `INSERT INTO job_orders
         (org_id,job_token,provisional_token,offline_id,offline_device,offline_created_at,
          party_id,party_snapshot,priority,promised_delivery_at,current_status,
          customer_commitment,counter_note,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [orgId, token, cleanText(req.body.provisional_token, 100) || null,
         cleanText(req.body.offline_id, 100) || null, cleanText(req.body.offline_device, 20) || null,
         req.body.offline_created_at || null, party.id, JSON.stringify(partySnapshot),
         ['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(cleanText(req.body.priority, 20).toUpperCase())
           ? cleanText(req.body.priority, 20).toUpperCase() : 'NORMAL',
         req.body.promised_delivery_at, 'WAITING', cleanText(req.body.customer_commitment),
         cleanText(req.body.counter_note), req.user.id]
      );
      const jobId = result.lastInsertRowid;
      items.forEach((item, index) => {
        const service = get(
          `SELECT s.*,c.name category_name,sc.name subcategory_name
           FROM job_services s JOIN job_service_categories c ON c.id=s.category_id
           LEFT JOIN job_service_subcategories sc ON sc.id=s.subcategory_id
           WHERE s.id=? AND s.org_id=? AND s.active=1`,
          [item.service_id, orgId]
        );
        if (!service) throw new Error(`Service ${item.service_id} is unavailable`);
        run(
          `INSERT INTO job_items
           (job_id,service_id,category_snapshot,subcategory_snapshot,service_snapshot,description,
            specification_json,quantity,unit,sort_order,created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [jobId, service.id, service.category_name, service.subcategory_name || null, service.name,
           cleanText(item.description || service.name), JSON.stringify(item.specifications || {}),
           Number(item.quantity || 1), cleanText(item.unit || service.default_unit, 30), index, req.user.id]
        );
      });
      if (estimateLines.length) {
        const normalized = estimateLines.map((line, index) => {
          const quantity = Number(line.quantity || 1);
          const enteredUnitPrice = Number(line.unit_price || 0);
          const taxRate = Number(line.tax_rate || 0);
          const grossPaise = paise(line.line_total ?? quantity * enteredUnitPrice);
          const taxPaise = estimateTaxInclusive && taxRate > 0
            ? Math.round(grossPaise * taxRate / (100 + taxRate))
            : Math.round(grossPaise * taxRate / 100);
          const taxablePaise = estimateTaxInclusive ? grossPaise - taxPaise : grossPaise;
          return {
            description: cleanText(line.description, 500),
            quantity,
            unit: cleanText(line.unit || 'NOS', 30),
            entered_unit_price_paise: paise(enteredUnitPrice),
            unit_price_paise: quantity > 0 ? Math.round(taxablePaise / quantity) : 0,
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
           (job_id,revision_no,status,subtotal_paise,tax_paise,total_paise,round_off_paise,
           lines_json,tax_inclusive,created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [jobId, 1, 'ACCEPTED', subtotal, tax, totalBeforeRound + roundOff, roundOff,
           JSON.stringify(normalized),
           estimateTaxInclusive ? 1 : 0, req.user.id]
        );
      }
      const advancePayments = [];
      const advances = Array.isArray(req.body.advance_payments) ? req.body.advance_payments : [];
      for (const advance of advances) {
        const amount = Number(advance.amount || 0);
        if (amount <= 0) continue;
        const receipt = createReceipt({
          orgId, partyId: party.id, amount, mode: cleanText(advance.mode || 'cash', 20).toLowerCase(),
          reference: cleanText(advance.reference, 200), date: new Date().toISOString().slice(0, 10),
          userId: req.user.id, narration: `Advance for ${token}`
        });
        advancePayments.push(receipt.id);
      }
      if (advancePayments.length) {
        const totalAdvance = all(
          `SELECT amount FROM payments WHERE id IN (${advancePayments.map(() => '?').join(',')})`,
          advancePayments
        ).reduce((sum, payment) => sum + Number(payment.amount), 0);
        run('UPDATE job_orders SET advance_paise=?,advance_payment_ids=? WHERE id=?',
          [paise(totalAdvance), JSON.stringify(advancePayments), jobId]);
      }
      run(
        `INSERT INTO job_status_events
         (job_id,from_status,to_status,reason,actor_user_id,operation_id)
         VALUES (?,?,?,?,?,?)`,
        [jobId, null, 'WAITING', 'Job created', req.user.id, crypto.randomUUID()]
      );
      recordSyncRevision(orgId, 'JOB', jobId, 'CREATE', 1);
      audit(req, jobId, orgId, 'JOB', jobId, 'CREATE', null, { token, item_count: items.length });
      return { id: jobId, token };
    });
    for (const attachment of requestedAttachments) {
      const fileName = cleanText(attachment.file_name, 240);
      const mimeType = cleanText(attachment.mime_type || 'application/octet-stream', 120).toLowerCase();
      const contentBase64 = String(attachment.content_base64 || '').replace(/\s/g, '');
      if (!fileName || !contentBase64) {
        throw new Error(`Invalid attachment: ${fileName || 'unnamed file'}`);
      }
      await createAttachmentRecord({
        jobId: created.id,
        entityType: 'JOB',
        entityId: created.id,
        purpose: 'SPECIFICATION',
        fileName,
        mimeType,
        contentBase64,
        visibleToCustomer: Boolean(attachment.visible_to_customer),
        createdBy: req.user.id,
        uploadOrigin: 'STAFF'
      });
    }
    res.json({ success: true, ...created, job: projectJob(req, jobRow(created.id), true) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/:id/attachments', requireAnyJobPermission('jobs_counter', 'jobs_operations'), async (req, res) => {
  const job = jobRow(req.params.id);
  if (!requireJobOrgAccess(req, res, job)) return;
  if (rejectLockedJob(res, job)) return;
  const fileName = cleanText(req.body.file_name, 240);
  const mimeType = cleanText(req.body.mime_type || 'application/octet-stream', 120).toLowerCase();
  const contentBase64 = String(req.body.content_base64 || '').replace(/\s/g, '');
  if (!fileName || !contentBase64) return res.status(400).json({ error: 'File name and content are required' });
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64)) {
    return res.status(400).json({ error: 'Attachment content is not valid base64' });
  }
  const purpose = cleanText(req.body.purpose || 'SPECIFICATION', 40).toUpperCase();
  try {
    const attachment = await createAttachmentRecord({
      jobId: job.id,
      entityType: 'JOB',
      entityId: job.id,
      purpose,
      fileName,
      mimeType,
      contentBase64,
      visibleToCustomer: Boolean(req.body.visible_to_customer),
      createdBy: req.user.id,
      uploadOrigin: 'STAFF'
    });
    audit(req, job.id, job.org_id, 'ATTACHMENT', attachment.id, 'CREATE', null, {
      file_name: attachment.file_name,
      mime_type: attachment.mime_type,
      byte_size: attachment.byte_size,
      sha256: attachment.sha256,
      purpose,
      pixel_width: attachment.pixel_width,
      pixel_height: attachment.pixel_height,
      pdf_page_count: attachment.pdf_page_count,
      analysis_status: attachment.analysis_status
    });
    res.json({
      success: true,
      id: attachment.id,
      file_name: attachment.file_name,
      mime_type: attachment.mime_type,
      byte_size: attachment.byte_size,
      sha256: attachment.sha256,
      pixel_width: attachment.pixel_width,
      pixel_height: attachment.pixel_height,
      pdf_page_count: attachment.pdf_page_count,
      analysis_status: attachment.analysis_status
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/attachments/:attachmentId/content', requireAnyJobPermission('jobs_counter', 'jobs_operations'), (req, res) => {
  const attachment = attachmentRow(req.params.attachmentId);
  if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
  if (!canAccessOrg(req.user, attachment.org_id)) {
    return res.status(403).json({ error: 'No access to this organization' });
  }
  if (!hasAttachmentBytes(attachment)) {
    return res.status(410).json({
      error: 'Attachment file was removed by retention policy; metadata remains in job history'
    });
  }
  const bytes = loadAttachmentBytes(attachment);
  res.setHeader('Content-Type', attachment.mime_type || 'application/octet-stream');
  res.setHeader('Content-Length', bytes.length);
  res.setHeader('Content-Disposition', `inline; filename="${attachment.file_name.replace(/"/g, '')}"`);
  res.send(bytes);
});

router.post('/attachments/retention/cleanup', requireAnyJobPermission('jobs_counter', 'jobs_finance'), (req, res) => {
  const result = purgeExpiredAttachments({
    actorUserId: req.user.id,
    reason: cleanText(req.body.reason || 'MANUAL_RETENTION_CLEANUP', 120)
  });
  res.json({ success: true, ...result });
});

router.patch('/attachments/:attachmentId', requireAnyJobPermission('jobs_counter', 'jobs_finance'), (req, res) => {
  const attachment = attachmentRow(req.params.attachmentId);
  if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
  if (!canAccessOrg(req.user, attachment.org_id)) {
    return res.status(403).json({ error: 'No access to this organization' });
  }
  const updates = [];
  const params = [];
  const nextData = {};
  if (req.body.visible_to_customer !== undefined) {
    const visible = req.body.visible_to_customer ? 1 : 0;
    updates.push('visible_to_customer=?');
    params.push(visible);
    nextData.visible_to_customer = visible;
  }
  if (req.body.purpose !== undefined) {
    const purpose = cleanText(req.body.purpose, 40).toUpperCase() || attachment.purpose;
    updates.push('purpose=?');
    params.push(purpose);
    nextData.purpose = purpose;
  }
  if (req.body.archive_attachment !== undefined) {
    const archive = Boolean(req.body.archive_attachment);
    if (archive) {
      updates.push(`retention_policy='ARCHIVE'`);
      updates.push(`retention_state='ARCHIVED'`);
      updates.push(`retention_delete_after=NULL`);
      updates.push(`archived_at=datetime('now')`);
      updates.push('archived_by=?');
      params.push(req.user.id);
      updates.push('archive_reason=?');
      params.push(cleanText(req.body.archive_reason || 'Important/repeating customer order', 500));
      nextData.retention_state = 'ARCHIVED';
      nextData.retention_policy = 'ARCHIVE';
    } else {
      const job = jobRow(attachment.job_id);
      updates.push(`retention_policy='AUTO_DELETE'`);
      updates.push(`retention_state='ACTIVE'`);
      updates.push(`archived_at=NULL`);
      updates.push(`archived_by=NULL`);
      updates.push(`archive_reason=NULL`);
      if (job?.delivered_at || job?.closed_at || job?.current_status === 'DELIVERED') {
        updates.push(`retention_delete_after=COALESCE(retention_delete_after, datetime('now', '+7 days'))`);
      }
      nextData.retention_state = 'ACTIVE';
      nextData.retention_policy = 'AUTO_DELETE';
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No supported attachment fields provided' });
  run(`UPDATE job_attachments SET ${updates.join(', ')} WHERE id=?`, [...params, attachment.id]);
  const updated = attachmentRow(attachment.id);
  audit(req, attachment.job_id, attachment.org_id, 'ATTACHMENT', attachment.id, 'UPDATE',
    {
      visible_to_customer: attachment.visible_to_customer,
      purpose: attachment.purpose,
      retention_state: attachment.retention_state,
      retention_policy: attachment.retention_policy
    }, nextData);
  res.json({
    success: true,
    id: updated.id,
    file_name: updated.file_name,
    purpose: updated.purpose,
    visible_to_customer: updated.visible_to_customer,
    retention_policy: updated.retention_policy,
    retention_state: updated.retention_state,
    retention_delete_after: updated.retention_delete_after,
    content_available: hasAttachmentBytes(updated)
  });
});

router.post('/:id/customer-access', requireJobPermission('jobs_counter'), (req, res) => {
  const job = jobRow(req.params.id);
  if (!requireJobOrgAccess(req, res, job)) return;
  const token = crypto.randomBytes(32).toString('base64url');
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  const validDays = Math.max(1, Math.min(90, Number(req.body.valid_days || 30)));
  run('UPDATE job_customer_access_tokens SET revoked_at=datetime(\'now\') WHERE job_id=? AND revoked_at IS NULL',
    [job.id]);
  run(
    `INSERT INTO job_customer_access_tokens (job_id,token_hash,expires_at,created_by)
     VALUES (?,?,datetime('now',?),?)`,
    [job.id, digest, `+${validDays} days`, req.user.id]
  );
  audit(req, job.id, job.org_id, 'CUSTOMER_ACCESS', job.id, 'ISSUE', null,
    { valid_days: validDays }, 'Secure customer status and approval link issued');
  res.json({
    success: true,
    token,
    path: `/customer-job.html?token=${encodeURIComponent(token)}`,
    url: buildAbsoluteUrl(req, `/customer-job.html?token=${encodeURIComponent(token)}`),
    expires_in_days: validDays
  });
});

router.post('/:id/pre-bill', requireJobPermission('jobs_finance'), (req, res) => {
  const job = jobRow(req.params.id);
  if (!requireJobOrgAccess(req, res, job)) return;
  if (job.final_bill_id) return res.status(409).json({ error: 'This job already has a final invoice' });
  if (job.pre_bill_id) return res.status(409).json({ error: 'This job already has a first bill linked' });
  const estimate = get(
    `SELECT * FROM job_estimates WHERE job_id=? AND status='ACCEPTED'
     ORDER BY revision_no DESC LIMIT 1`,
    [job.id]
  );
  if (!estimate) return res.status(409).json({ error: 'Accepted estimate is required before first billing' });
  try {
    const outcome = transaction(() => {
      const date = cleanText(req.body.bill_date, 20) || new Date().toISOString().slice(0, 10);
      const fy = getFY(date);
      const org = get('SELECT * FROM orgs WHERE id=?', [job.org_id]);
      const billNumber = nextBillNumber(job.org_id, 'SALE', fy);
      const lines = jobInvoiceLines(job.id, estimate, []);
      const subtotal = rupees(lines.subtotalPaise);
      const tax = rupees(lines.taxPaise);
      const roundOff = rupees(lines.roundOffPaise);
      const total = rupees(lines.totalPaise);
      const bill = run(
        `INSERT INTO bills
         (org_id,format,bill_number,bill_date,fy,party_id,party_snapshot,payment_mode,items_json,
          subtotal,discount,taxable_amount,tax_rate,cgst,sgst,igst,total_tax,grand_total,round_off,total_in_words,
          note_header,note_footer,description,custom_data,split_payments,bank_details,status,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          job.org_id, 'SALE', billNumber, date, fy, job.party_id, job.party_snapshot,
          cleanText(req.body.payment_mode || 'credit', 20).toLowerCase(),
          JSON.stringify(lines.items), subtotal, 0, subtotal,
          subtotal ? Number((tax / subtotal * 100).toFixed(2)) : 0,
          Number((tax / 2).toFixed(2)), Number((tax / 2).toFixed(2)), 0, tax, total, roundOff,
          numberToWords(total), org?.note_header || '', org?.note_footer || '',
          `First bill for ${job.job_token}`,
          JSON.stringify({
            job_id: job.id,
            job_token: job.job_token,
            invoice_role: 'PRE_BILL',
            estimate_revision_no: estimate.revision_no
          }),
          '[]',
          JSON.stringify({
            bank_name: org?.bank_name, account_no: org?.account_no, branch: org?.branch,
            ifsc: org?.ifsc, upi_id: org?.upi_id
          }),
          'saved',
          req.user.id
        ]
      );
      const billId = bill.lastInsertRowid;
      const savedBill = get('SELECT * FROM bills WHERE id=?', [billId]);
      postBill(savedBill);
      run(
        `UPDATE job_orders
         SET pre_bill_id=?,pre_billed_at=datetime('now'),financial_status='BILLED',
             version=version+1,updated_at=datetime('now')
         WHERE id=?`,
        [billId, job.id]
      );
      audit(req, job.id, job.org_id, 'BILL', billId, 'PRE_BILL', null,
        { bill_id: billId, bill_number: billNumber, total }, 'First bill issued from job estimate');
      return { bill_id: billId, bill_number: billNumber, total };
    });
    res.json({ success: true, ...outcome, job: projectJob(req, jobRow(job.id), true) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/:id', (req, res) => {
  const row = jobRow(req.params.id);
  if (!requireJobOrgAccess(req, res, row)) return;
  res.json(projectJob(req, row, true));
});

router.get('/:id/internal-notes', requireAnyJobPermission('jobs_operations', 'jobs_counter'), (req, res) => {
  const job = jobRow(req.params.id);
  if (!requireJobOrgAccess(req, res, job)) return;
  res.json(all(`SELECT n.*,u.name author_name,u.role author_role
    FROM job_internal_notes n JOIN users u ON u.id=n.author_user_id
    WHERE n.job_id=? ORDER BY n.id DESC`, [job.id]).map(note => ({
    ...note, file_names: parseJson(note.file_names_json, [])
  })));
});

router.post('/:id/internal-notes', requireAnyJobPermission('jobs_operations', 'jobs_counter'), (req, res) => {
  const job = jobRow(req.params.id);
  if (!requireJobOrgAccess(req, res, job)) return;
  const noteText = cleanText(req.body.note_text, 4000);
  if (noteText.length < 3) return res.status(400).json({ error: 'Internal note must be at least 3 characters' });
  const noteType = cleanText(req.body.note_type || 'INSTRUCTION', 40).toUpperCase();
  const fileNames = Array.isArray(req.body.file_names)
    ? [...new Set(req.body.file_names.map(name => String(name || '').split(/[\\/]/).pop().trim()).filter(Boolean))].slice(0, 30)
    : [];
  const result = run(`INSERT INTO job_internal_notes
    (job_id,org_id,author_user_id,note_type,note_text,file_names_json)
    VALUES (?,?,?,?,?,?)`, [job.id, job.org_id, req.user.id, noteType, noteText, JSON.stringify(fileNames)]);
  audit(req, job.id, job.org_id, 'INTERNAL_NOTE', result.lastInsertRowid, 'CREATE', null,
    { note_type: noteType, note_text: noteText, file_names: fileNames });
  res.status(201).json({ success: true, note: get(`SELECT n.*,u.name author_name,u.role author_role
    FROM job_internal_notes n JOIN users u ON u.id=n.author_user_id WHERE n.id=?`, [result.lastInsertRowid]) });
});

router.post('/:id/assign', requireJobPermission('jobs_assign'), (req, res) => {
  const job = jobRow(req.params.id);
  if (!requireJobOrgAccess(req, res, job)) return;
  if (rejectLockedJob(res, job)) return;
  const employee = get('SELECT id,name,role,active FROM users WHERE id=?', [req.body.employee_id]);
  if (!employee || !employee.active || !PRODUCTION_ROLES.has(employee.role)) {
    return res.status(400).json({ error: 'Select an active Operator, Senior Operator, or Engineer' });
  }
  const current = assignmentFor(job.id);
  const ownCurrent = current && Number(current.employee_id) === Number(req.user.id);
  if (current && !ownCurrent && !permissions(req).jobs_assign_any) {
    return res.status(403).json({ error: 'Only the current assignee or Senior Operator/Owner may forward this job' });
  }
  const reason = cleanText(req.body.reason);
  if (reason.length < 3) return res.status(400).json({ error: 'Handoff reason is required' });
  const handoffType = cleanText(req.body.handoff_type || (current ? 'FORWARD' : 'INITIAL_ASSIGNMENT'), 30).toUpperCase();
  const assignmentId = transaction(() => {
    if (current) run(
      `UPDATE job_assignments SET status='RELEASED',released_at=datetime('now'),release_reason=? WHERE id=?`,
      [reason, current.id]
    );
    const result = run(
      `INSERT INTO job_assignments
       (job_id,employee_id,assigned_role,assigned_by,source_assignment_id,handoff_type,handoff_reason,instructions,status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [job.id, employee.id, employee.role.toUpperCase(), req.user.id, current?.id || null, handoffType,
       reason, cleanText(req.body.instructions), 'PENDING_ACCEPTANCE']
    );
    audit(req, job.id, job.org_id, 'ASSIGNMENT', result.lastInsertRowid, handoffType,
      current, { employee_id: employee.id, employee_name: employee.name, role: employee.role }, reason);
    return result.lastInsertRowid;
  });
  res.json({ success: true, id: assignmentId, assignment: assignmentFor(job.id) });
});

router.post('/assignments/:id/respond', requireJobPermission('jobs_operations'), (req, res) => {
  const assignment = get('SELECT * FROM job_assignments WHERE id=?', [req.params.id]);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  if (Number(assignment.employee_id) !== Number(req.user.id) && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'This assignment belongs to another employee' });
  }
  if (assignment.status !== 'PENDING_ACCEPTANCE') {
    return res.status(400).json({ error: 'Assignment is no longer pending' });
  }
  const decision = cleanText(req.body.decision, 20).toUpperCase();
  const job = jobRow(assignment.job_id);
  if (decision === 'ACCEPT') {
    transaction(() => {
      run(`UPDATE job_assignments SET status='ACCEPTED',accepted_at=datetime('now') WHERE id=?`, [assignment.id]);
      if (job.current_status === 'WAITING') {
        run(`UPDATE job_orders SET current_status='ACCEPTED',version=version+1,updated_at=datetime('now') WHERE id=?`, [job.id]);
        run(
          `INSERT INTO job_status_events
           (job_id,from_status,to_status,reason,actor_user_id,operation_id) VALUES (?,?,?,?,?,?)`,
          [job.id, 'WAITING', 'ACCEPTED', 'Assignment accepted', req.user.id, crypto.randomUUID()]
        );
      }
      audit(req, job.id, job.org_id, 'ASSIGNMENT', assignment.id, 'ACCEPT', assignment, null);
    });
  } else if (decision === 'DECLINE') {
    const reason = cleanText(req.body.reason);
    if (reason.length < 3) return res.status(400).json({ error: 'Decline reason is required' });
    run(`UPDATE job_assignments SET status='DECLINED',declined_at=datetime('now'),decline_reason=? WHERE id=?`,
      [reason, assignment.id]);
    audit(req, job.id, job.org_id, 'ASSIGNMENT', assignment.id, 'DECLINE', assignment, null, reason);
  } else return res.status(400).json({ error: 'Decision must be ACCEPT or DECLINE' });
  res.json({ success: true, job: projectJob(req, jobRow(job.id), true) });
});

router.post('/:id/status', requireJobPermission('jobs_operations'), (req, res) => {
  const job = jobRow(req.params.id);
  if (!requireJobOrgAccess(req, res, job)) return;
  const offlineChangeId = cleanText(req.body.offline_change_id, 160);
  if (offlineChangeId) {
    const deviceId = cleanText(req.get('x-tarangini-device-id') || req.body.offline_device_id, 120);
    const device = get("SELECT id FROM registered_devices WHERE org_id=? AND device_id=? AND status='active'", [job.org_id, deviceId]);
    if (!device) return res.status(403).json({ error: 'An active registered device is required', code: 'DEVICE_NOT_ACTIVE' });
    const replay = get('SELECT id FROM job_status_events WHERE operation_id=?', [offlineChangeId]);
    if (replay) return res.json({ success: true, idempotent: true, job: projectJob(req, jobRow(job.id), true) });
    const baseVersion = Number(req.body.base_version);
    if (!Number.isInteger(baseVersion)) {
      return res.status(400).json({ error: 'base_version is required for an offline job update' });
    }
    if (baseVersion !== Number(job.version)) {
      const existingConflict = get('SELECT id FROM sync_conflicts WHERE change_id=? AND org_id=?', [offlineChangeId, job.org_id]);
      if (!existingConflict) {
        run(`INSERT INTO sync_conflicts
          (change_id,org_id,entity_type,entity_id,main_snapshot,incoming_snapshot,status)
          VALUES (?,?,?,?,?,?, 'pending')`, [offlineChangeId, job.org_id, 'JOB_STATUS', String(job.id),
          JSON.stringify({ id: job.id, job_token: job.job_token, status: job.current_status, version: job.version }),
          JSON.stringify({ status: req.body.status, reason: req.body.reason || '', base_version: baseVersion, device_id: deviceId })]);
      }
      return res.status(409).json({
        error: 'Job changed on the Main System after this device last synchronized',
        code: 'SYNC_VERSION_CONFLICT', conflict: true, current_version: Number(job.version)
      });
    }
  }
  const target = cleanText(req.body.status, 40).toUpperCase();
  if (!STATUSES.includes(target) || target === 'DELIVERED') {
    return res.status(400).json({ error: 'Use the delivery command for Delivered status' });
  }
  if (!TRANSITIONS[job.current_status]?.includes(target)) {
    return res.status(409).json({ error: `Invalid transition ${job.current_status} -> ${target}` });
  }
  const reason = cleanText(req.body.reason);
  if (['COMPLETED', 'READY_FOR_DELIVERY'].includes(job.current_status) && target === 'IN_PROGRESS') {
    if (req.user.role !== 'owner' && !permissions(req).jobs_assign_any) {
      return res.status(403).json({
        error: 'Owner or Senior Operator approval is required to reopen completed work'
      });
    }
    if (reason.length < 5) {
      return res.status(400).json({ error: 'Correction/reopen reason of at least 5 characters is required' });
    }
  }
  const assignment = assignmentFor(job.id);
  if (!assignment || assignment.status !== 'ACCEPTED') {
    return res.status(409).json({ error: 'An accepted assignment is required before updating work status' });
  }
  if (Number(assignment.employee_id) !== Number(req.user.id) && !permissions(req).jobs_assign_any) {
    return res.status(403).json({ error: 'Only the assignee or Senior Operator/Owner may update this job' });
  }
  transaction(() => {
    run('UPDATE job_orders SET current_status=?,version=version+1,updated_at=datetime(\'now\') WHERE id=?',
      [target, job.id]);
    run(
      `INSERT INTO job_status_events
       (job_id,from_status,to_status,reason,actor_user_id,operation_id) VALUES (?,?,?,?,?,?)`,
      [job.id, job.current_status, target, reason || null, req.user.id, offlineChangeId || crypto.randomUUID()]
    );
    recordSyncRevision(job.org_id, 'JOB', job.id, 'STATUS', Number(job.version || 0) + 1);
    audit(req, job.id, job.org_id, 'JOB_STATUS', job.id, 'TRANSITION',
      { status: job.current_status }, { status: target }, reason);
    if (['COMPLETED', 'READY_FOR_DELIVERY'].includes(job.current_status) && target === 'IN_PROGRESS') {
      audit(req, job.id, job.org_id, 'JOB_CORRECTION', job.id, 'REOPEN',
        { status: job.current_status }, { status: target }, reason);
    }
  });
  res.json({ success: true, job: projectJob(req, jobRow(job.id), true) });
});

router.post('/:id/reports', requireJobPermission('jobs_operations'), (req, res) => {
  const job = jobRow(req.params.id);
  if (!requireJobOrgAccess(req, res, job)) return;
  if (rejectLockedJob(res, job)) return;
  const text = cleanText(req.body.report_text);
  if (!text) return res.status(400).json({ error: 'Report text is required' });
  const result = run(
    `INSERT INTO job_work_reports
     (job_id,employee_id,report_type,progress_percent,report_text,checklist_json,started_at,completed_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [job.id, req.user.id, cleanText(req.body.report_type || 'PROGRESS', 30).toUpperCase(),
     req.body.progress_percent === undefined ? null : Math.max(0, Math.min(100, Number(req.body.progress_percent))),
     text, JSON.stringify(req.body.checklist || {}), req.body.started_at || null, req.body.completed_at || null]
  );
  recordSyncRevision(job.org_id, 'JOB_REPORT', result.lastInsertRowid, 'CREATE', null);
  audit(req, job.id, job.org_id, 'WORK_REPORT', result.lastInsertRowid, 'CREATE', null, req.body);
  res.json({ success: true, id: result.lastInsertRowid });
});

router.post('/:id/materials', requireJobPermission('jobs_operations'), (req, res) => {
  const job = jobRow(req.params.id);
  if (!requireJobOrgAccess(req, res, job)) return;
  if (rejectLockedJob(res, job)) return;
  const assignment = activeAcceptedAssignment(job.id);
  if (!assignment) {
    return res.status(409).json({ error: 'An accepted assignment is required before recording materials' });
  }
  if (Number(assignment.employee_id) !== Number(req.user.id) && !permissions(req).jobs_assign_any) {
    return res.status(403).json({ error: 'Only the assignee or Senior Operator/Owner may record materials' });
  }
  const itemId = Number(req.body.item_id || 0);
  const quantity = Number(req.body.quantity || 0);
  if (!itemId || quantity <= 0) {
    return res.status(400).json({ error: 'Valid item and quantity are required' });
  }
  const item = get(
    `SELECT * FROM items WHERE id=? AND org_id=? AND active=1`,
    [itemId, job.org_id]
  );
  if (!item) return res.status(404).json({ error: 'Inventory item not found for this company' });
  const notes = cleanText(req.body.notes, 1000);
  const rate = Number(req.body.rate ?? item.last_purchase_price ?? 0);
  const movementDate = new Date().toISOString().slice(0, 10);
  const stockWarnings = validateStockAvailability(job.org_id, [{
    item_id: item.id,
    item_name: item.name,
    qty: quantity
  }]);
  let material = null;
  transaction(() => {
    const inserted = run(
      `INSERT INTO job_material_consumptions
       (job_id,item_id,item_name_snapshot,item_code_snapshot,quantity,unit,rate,notes,consumed_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [job.id, item.id, item.name, item.item_code || '', quantity, item.unit || 'NOS', rate, notes, req.user.id]
    );
    material = get(
      `SELECT m.*,u.name consumed_by_name
       FROM job_material_consumptions m
       JOIN users u ON u.id=m.consumed_by
       WHERE m.id=?`,
      [inserted.lastInsertRowid]
    );
    run(
      `INSERT INTO stock_movements
       (org_id,item_id,movement_date,source_type,source_id,ref_number,qty_in,qty_out,rate)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [job.org_id, item.id, movementDate, 'job_material', material.id, job.job_token, 0, quantity, rate]
    );
    recordSyncRevision(job.org_id, 'JOB_MATERIAL', material.id, 'CREATE', null);
    audit(req, job.id, job.org_id, 'MATERIAL', material.id, 'CONSUME', null, {
      item_id: item.id,
      item_name: item.name,
      quantity,
      unit: item.unit || 'NOS',
      rate,
      notes
    });
  });
  res.json({ success: true, material, stock_warnings: stockWarnings, job: projectJob(req, jobRow(job.id), true) });
});

router.post('/:id/additions', requireJobPermission('jobs_operations'), async (req, res) => {
  const job = jobRow(req.params.id);
  if (!requireJobOrgAccess(req, res, job)) return;
  if (rejectLockedJob(res, job)) return;
  const reason = cleanText(req.body.reason);
  if (!reason) return res.status(400).json({ error: 'Technical reason is required' });
  try {
    const requestedAttachments = Array.isArray(req.body.attachments) ? req.body.attachments : [];
    const result = transaction(() => {
      const inserted = run(
        `INSERT INTO job_additions (job_id,proposed_by,internal_reason,state) VALUES (?,?,?,'PROPOSED')`,
        [job.id, req.user.id, reason]
      );
      audit(req, job.id, job.org_id, 'ADDITION', inserted.lastInsertRowid, 'PROPOSE', null,
        { reason, attachment_count: requestedAttachments.length });
      return inserted;
    });
    for (const attachment of requestedAttachments) {
      const fileName = cleanText(attachment.file_name, 240);
      const mimeType = cleanText(attachment.mime_type || 'application/octet-stream', 120).toLowerCase();
      const contentBase64 = String(attachment.content_base64 || '').replace(/\s/g, '');
      if (!fileName || !contentBase64) {
        throw new Error(`Invalid attachment: ${fileName || 'unnamed file'}`);
      }
      const normalizedMimeType = normalizeMimeType(fileName, mimeType);
      if (!normalizedMimeType.startsWith('image/') && normalizedMimeType !== 'application/pdf') {
        throw new Error('Addition evidence must be an image or PDF');
      }
      await createAttachmentRecord({
        jobId: job.id,
        entityType: 'ADDITION',
        entityId: result.lastInsertRowid,
        purpose: 'ADDITION_EVIDENCE',
        fileName,
        mimeType: normalizedMimeType,
        contentBase64,
        visibleToCustomer: false,
        createdBy: req.user.id,
        uploadOrigin: 'STAFF'
      });
    }
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put('/additions/:id/price', requireJobPermission('jobs_finance'), (req, res) => {
  const addition = get(
    `SELECT a.*,j.org_id,j.current_status,j.final_bill_id,j.pre_bill_id,j.delivered_at,j.closed_at
     FROM job_additions a JOIN job_orders j ON j.id=a.job_id WHERE a.id=?`,
    [req.params.id]
  );
  if (!addition) return res.status(404).json({ error: 'Additional work not found' });
  if (rejectLockedJob(res, addition)) return;
  if (['APPROVED', 'REJECTED'].includes(addition.state)) {
    return res.status(409).json({ error: 'Approved or rejected additions require a new revision' });
  }
  const quantity = Number(req.body.quantity || 1);
  const unitPrice = paise(req.body.unit_price);
  const taxRate = Number(req.body.tax_rate || 0);
  const total = Math.round(quantity * unitPrice * (1 + taxRate / 100));
  const description = cleanText(req.body.customer_description);
  if (!description || total < 0) return res.status(400).json({ error: 'Description and valid charge are required' });
  const evidence = {
    addition_id: addition.id, revision_no: addition.revision_no, description,
    quantity, unit: cleanText(req.body.unit || 'NOS', 30), unit_price_paise: unitPrice,
    tax_rate: taxRate, total_paise: total
  };
  run(
    `UPDATE job_additions SET customer_description=?,quantity=?,unit=?,unit_price_paise=?,tax_rate=?,
     total_paise=?,evidence_hash=?,state='AWAITING_CUSTOMER',priced_by=?,priced_at=datetime('now'),
     updated_at=datetime('now') WHERE id=?`,
    [description, quantity, evidence.unit, unitPrice, taxRate, total, hashEvidence(evidence), req.user.id, addition.id]
  );
  audit(req, addition.job_id, addition.org_id, 'ADDITION', addition.id, 'PRICE', addition, evidence);
  res.json({ success: true, total_paise: total });
});

router.post('/additions/:id/approval', requireJobPermission('jobs_counter'), (req, res) => {
  const addition = get(
    `SELECT a.*,j.org_id,j.current_status,j.final_bill_id,j.pre_bill_id,j.delivered_at,j.closed_at
     FROM job_additions a JOIN job_orders j ON j.id=a.job_id WHERE a.id=?`,
    [req.params.id]
  );
  if (!addition) return res.status(404).json({ error: 'Additional work not found' });
  if (rejectLockedJob(res, addition)) return;
  if (addition.state !== 'AWAITING_CUSTOMER') {
    return res.status(409).json({ error: 'Additional work is not awaiting customer approval' });
  }
  const decision = cleanText(req.body.decision, 20).toUpperCase();
  const method = cleanText(req.body.method, 30).toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });
  if (!['OTP', 'DIGITAL_SIGNATURE', 'WHATSAPP', 'VERBAL_RECORDED'].includes(method)) {
    return res.status(400).json({ error: 'Invalid approval method' });
  }
  const approver = cleanText(req.body.approver_name, 200);
  if (!approver) return res.status(400).json({ error: 'Approver name is required' });
  const evidence = {
    addition_id: addition.id, revision_no: addition.revision_no, decision, method,
    approver, evidence: cleanText(req.body.evidence_text), charge_hash: addition.evidence_hash
  };
  transaction(() => {
    run(
      `INSERT INTO job_customer_approvals
       (job_addition_id,addition_revision_no,decision,method,approver_name,approver_contact_masked,
        evidence_text,evidence_hash,recorded_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [addition.id, addition.revision_no, decision, method, approver,
       cleanText(req.body.approver_contact_masked, 100), evidence.evidence, hashEvidence(evidence), req.user.id]
    );
    run(`UPDATE job_additions SET state=?,updated_at=datetime('now') WHERE id=?`, [decision, addition.id]);
    audit(req, addition.job_id, addition.org_id, 'ADDITION_APPROVAL', addition.id, decision,
      null, evidence, cleanText(req.body.reason));
  });
  res.json({ success: true, decision });
});

router.get('/:id/communication-status', requireJobPermission('jobs_whatsapp'), (req, res) => {
  const job = jobRow(req.params.id);
  if (!requireJobOrgAccess(req, res, job)) return;
  const consent = get(
    `SELECT id,effective_at,source,evidence FROM job_communication_consents
     WHERE party_id=? AND channel='WHATSAPP' AND purpose='TRANSACTIONAL'
       AND consent_status='OPTED_IN' AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`, [job.party_id]
  );
  res.json({ whatsapp_transactional_consent: Boolean(consent), consent: consent || null });
});

router.get('/:id/messages', (req, res) => {
  const job = jobRow(req.params.id);
  if (!requireJobOrgAccess(req, res, job)) return;
  if (!permissions(req).jobs_whatsapp && !isOperationsUser(req)) {
    return res.status(403).json({ error: 'WhatsApp conversation access required' });
  }
  const conversation = get('SELECT * FROM job_conversations WHERE job_id=? ORDER BY id DESC LIMIT 1', [job.id]);
  if (!conversation) return res.json({ conversation: null, messages: [] });
  const messages = all('SELECT * FROM job_messages WHERE conversation_id=? ORDER BY id', [conversation.id]);
  res.json({
    conversation,
    messages: isOperationsUser(req) && !permissions(req).jobs_whatsapp
      ? messages.filter(message => message.workflow_intent === 'INFORMATION')
          .map(message => ({ id: message.id, direction: message.direction, body_text: message.body_text,
            received_at: message.received_at, created_at: message.created_at }))
      : messages
  });
});

router.post('/:id/messages', requireJobPermission('jobs_whatsapp'), (req, res) => {
  const job = jobRow(req.params.id);
  if (!requireJobOrgAccess(req, res, job)) return;
  const consent = get(
    `SELECT * FROM job_communication_consents
     WHERE party_id=? AND channel='WHATSAPP' AND purpose='TRANSACTIONAL'
       AND consent_status='OPTED_IN' AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`, [job.party_id]
  );
  if (!consent && req.body.direction !== 'INBOUND') {
    return res.status(409).json({ error: 'Active WhatsApp transactional consent is required' });
  }
  let conversation = get('SELECT * FROM job_conversations WHERE job_id=? AND status!=? ORDER BY id DESC LIMIT 1',
    [job.id, 'CLOSED']);
  if (!conversation) {
    const result = run(
      `INSERT INTO job_conversations (job_id,party_id,assigned_staff_user_id,status) VALUES (?,?,?,'OPEN')`,
      [job.id, job.party_id, req.user.id]
    );
    conversation = get('SELECT * FROM job_conversations WHERE id=?', [result.lastInsertRowid]);
  }
  const direction = cleanText(req.body.direction || 'OUTBOUND', 20).toUpperCase();
  const body = cleanText(req.body.body_text, 4000);
  if (!body) return res.status(400).json({ error: 'Message text is required' });
  const result = run(
    `INSERT INTO job_messages
     (conversation_id,direction,message_type,template_code,body_text,workflow_intent,delivery_status,
      external_message_ref,sender_user_id,sent_at,received_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [conversation.id, direction, cleanText(req.body.message_type || 'TEXT', 30).toUpperCase(),
     cleanText(req.body.template_code, 100) || null, body,
     cleanText(req.body.workflow_intent || 'INFORMATION', 40).toUpperCase(),
     direction === 'INBOUND' ? 'RECEIVED' : 'QUEUED', cleanText(req.body.external_message_ref, 200) || null,
     direction === 'INBOUND' ? null : req.user.id,
     direction === 'INBOUND' ? null : new Date().toISOString(),
     direction === 'INBOUND' ? new Date().toISOString() : null]
  );
  run('UPDATE job_conversations SET last_message_at=datetime(\'now\'),status=? WHERE id=?',
    [direction === 'INBOUND' ? 'WAITING_STAFF' : 'WAITING_CUSTOMER', conversation.id]);
  audit(req, job.id, job.org_id, 'WHATSAPP_MESSAGE', result.lastInsertRowid, direction, null,
    { body_text: body, workflow_intent: req.body.workflow_intent });
  res.json({ success: true, id: result.lastInsertRowid });
});

router.post('/:id/messages/presented', requireJobPermission('jobs_whatsapp'), (req, res) => {
  const job = jobRow(req.params.id);
  if (!requireJobOrgAccess(req, res, job)) return;
  const consent = get(
    `SELECT id FROM job_communication_consents
     WHERE party_id=? AND channel='WHATSAPP' AND purpose='TRANSACTIONAL'
       AND consent_status='OPTED_IN' AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`, [job.party_id]
  );
  if (!consent) return res.status(409).json({ error: 'Active WhatsApp transactional consent is required' });
  const body = cleanText(req.body.body_text, 4000);
  if (!body) return res.status(400).json({ error: 'Message text is required' });
  let conversation = get('SELECT * FROM job_conversations WHERE job_id=? AND status!=? ORDER BY id DESC LIMIT 1',
    [job.id, 'CLOSED']);
  if (!conversation) {
    const created = run(
      `INSERT INTO job_conversations (job_id,party_id,assigned_staff_user_id,status) VALUES (?,?,?,'OPEN')`,
      [job.id, job.party_id, req.user.id]
    );
    conversation = get('SELECT * FROM job_conversations WHERE id=?', [created.lastInsertRowid]);
  }
  const result = run(
    `INSERT INTO job_messages
     (conversation_id,direction,message_type,template_code,body_text,workflow_intent,delivery_status,sender_user_id)
     VALUES (?,?,?,?,?,?,?,?)`,
    [conversation.id, 'OUTBOUND', 'TEXT', cleanText(req.body.template_code, 100) || 'EXTERNAL_WHATSAPP', body,
     cleanText(req.body.workflow_intent || 'INFORMATION', 40).toUpperCase(), 'OPENED_EXTERNALLY', req.user.id]
  );
  run(`UPDATE job_conversations SET last_message_at=datetime('now'),status='WAITING_CUSTOMER' WHERE id=?`, [conversation.id]);
  audit(req, job.id, job.org_id, 'WHATSAPP_EXTERNAL_OPEN', result.lastInsertRowid, 'PRESENTED', null,
    { body_text: body, delivery_status: 'OPENED_EXTERNALLY', consent_id: consent.id });
  res.status(201).json({
    success: true,
    id: result.lastInsertRowid,
    delivery_status: 'OPENED_EXTERNALLY',
    message: 'Prepared message opened in external WhatsApp. Delivery is not confirmed by Tarangini.'
  });
});

router.post('/consents', requireJobPermission('jobs_whatsapp'), (req, res) => {
  const orgId = Number(req.body.org_id);
  if (!orgId || !canAccessOrg(req.user, orgId)) {
    return res.status(403).json({ error: 'No access to this organization' });
  }
  if (!partyForOrg(req.body.party_id, orgId)) {
    return res.status(400).json({ error: 'Party does not belong to this organization' });
  }
  const status = cleanText(req.body.consent_status, 30).toUpperCase();
  if (!['OPTED_IN', 'OPTED_OUT'].includes(status)) return res.status(400).json({ error: 'Invalid consent status' });
  if (status === 'OPTED_OUT') {
    run(
      `UPDATE job_communication_consents SET revoked_at=datetime('now')
       WHERE party_id=? AND channel='WHATSAPP' AND purpose=? AND revoked_at IS NULL`,
      [req.body.party_id, cleanText(req.body.purpose || 'TRANSACTIONAL', 40).toUpperCase()]
    );
  }
  const result = run(
    `INSERT INTO job_communication_consents
     (party_id,channel,purpose,consent_status,source,evidence,recorded_by)
     VALUES (?,'WHATSAPP',?,?,?,?,?)`,
    [req.body.party_id, cleanText(req.body.purpose || 'TRANSACTIONAL', 40).toUpperCase(),
     status, cleanText(req.body.source || 'COUNTER_FORM', 40).toUpperCase(),
     cleanText(req.body.evidence), req.user.id]
  );
  res.json({ success: true, id: result.lastInsertRowid });
});

router.post('/:id/deliver', requireJobPermission('jobs_counter'), (req, res) => {
  const job = jobRow(req.params.id);
  if (!requireJobOrgAccess(req, res, job)) return;
  if (job.current_status !== 'READY_FOR_DELIVERY') {
    return res.status(409).json({ error: 'Job must be Ready for Delivery before invoicing' });
  }
  if (job.final_bill_id) return res.status(409).json({ error: 'Final invoice already exists' });
  const estimate = get(
    `SELECT * FROM job_estimates WHERE job_id=? AND status='ACCEPTED' ORDER BY revision_no DESC LIMIT 1`,
    [job.id]
  );
  if (!estimate) return res.status(409).json({ error: 'Accepted original estimate is required' });
  const additions = all(
    `SELECT a.*,ca.id approval_id,ca.evidence_hash approval_evidence_hash
     FROM job_additions a JOIN job_customer_approvals ca ON ca.job_addition_id=a.id
     WHERE a.job_id=? AND a.state='APPROVED' AND ca.decision='APPROVED'`, [job.id]
  );
  const invoiceLines = jobInvoiceLines(job.id, estimate, additions);
  const total = rupees(invoiceLines.totalPaise);
  const preBill = job.pre_bill_id ? get('SELECT * FROM bills WHERE id=? AND deleted=0', [job.pre_bill_id]) : null;
  if (preBill && Math.abs(Number(preBill.grand_total || 0) - total) > 0.02) {
    return res.status(409).json({
      error: 'First bill amount differs from final job amount. Create a supplementary invoice or correction before delivery.',
      pre_bill_total: Number(preBill.grand_total || 0),
      final_job_total: total
    });
  }
  const advancePaymentIds = parseJson(job.advance_payment_ids, []).map(Number).filter(Boolean);
  const advanceTotal = advancePaymentIds.length
    ? all(`SELECT id,amount FROM payments WHERE id IN (${advancePaymentIds.map(() => '?').join(',')}) AND deleted=0`,
        advancePaymentIds).reduce((sum, payment) => sum + Number(payment.amount), 0)
    : 0;
  const deliveryPayments = Array.isArray(req.body.payments) ? req.body.payments : [];
  const deliveryTotal = deliveryPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const preBillSettlement = preBill ? billSettlement(preBill) : null;
  const alreadyPaid = preBillSettlement ? Number(preBillSettlement.paid_amount || 0) : 0;
  if (advanceTotal + alreadyPaid + deliveryTotal > total + 0.02) {
    return res.status(400).json({ error: 'Advance and delivery payments exceed invoice total' });
  }
  const receiverName = cleanText(req.body.receiver_name, 200);
  if (!receiverName) return res.status(400).json({ error: 'Receiver name is required' });
  try {
    const outcome = transaction(() => {
      const date = new Date().toISOString().slice(0, 10);
      let billId = preBill?.id || null;
      let billNumber = preBill?.bill_number || null;
      if (!preBill) {
        const fy = getFY(date);
        const org = get('SELECT * FROM orgs WHERE id=?', [job.org_id]);
        billNumber = nextBillNumber(job.org_id, 'SALE', fy);
        const subtotal = rupees(invoiceLines.subtotalPaise);
        const tax = rupees(invoiceLines.taxPaise);
        const roundOff = rupees(invoiceLines.roundOffPaise);
        const bill = run(
          `INSERT INTO bills
           (org_id,format,bill_number,bill_date,fy,party_id,party_snapshot,payment_mode,items_json,
            subtotal,discount,taxable_amount,tax_rate,cgst,sgst,igst,total_tax,grand_total,round_off,total_in_words,
            note_header,note_footer,description,custom_data,split_payments,bank_details,status,created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [job.org_id, 'SALE', billNumber, date, fy, job.party_id, job.party_snapshot, 'credit',
           JSON.stringify(invoiceLines.items), subtotal, 0, subtotal, subtotal ? Number((tax / subtotal * 100).toFixed(2)) : 0,
           Number((tax / 2).toFixed(2)), Number((tax / 2).toFixed(2)), 0, tax, total, roundOff, numberToWords(total),
           org?.note_header || '', org?.note_footer || '', `Final invoice for ${job.job_token}`,
           JSON.stringify({ job_id: job.id, job_token: job.job_token, approved_addition_ids: additions.map(a => a.id) }),
           '[]', JSON.stringify({
             bank_name: org?.bank_name, account_no: org?.account_no, branch: org?.branch,
             ifsc: org?.ifsc, upi_id: org?.upi_id
           }), 'saved', req.user.id]
        );
        billId = bill.lastInsertRowid;
        const savedBill = get('SELECT * FROM bills WHERE id=?', [billId]);
        postBill(savedBill);
      } else {
        audit(req, job.id, job.org_id, 'BILL', preBill.id, 'PRE_BILL_REUSED', null,
          { bill_id: preBill.id, bill_number: preBill.bill_number }, 'First bill reused at delivery');
      }
      for (const paymentId of advancePaymentIds) {
        const payment = get('SELECT * FROM payments WHERE id=? AND deleted=0', [paymentId]);
        if (!payment) continue;
        const already = get('SELECT id FROM payment_allocations WHERE payment_id=? AND bill_id=?', [paymentId, billId]);
        if (!already) run('INSERT INTO payment_allocations (payment_id,bill_id,amount) VALUES (?,?,?)',
          [paymentId, billId, Math.min(Number(payment.amount), total)]);
      }
      const receipts = [];
      for (const payment of deliveryPayments) {
        const amount = Number(payment.amount || 0);
        if (amount <= 0) continue;
        receipts.push(createReceipt({
          orgId: job.org_id, partyId: job.party_id, amount,
          mode: cleanText(payment.mode || 'cash', 20).toLowerCase(),
          reference: cleanText(payment.reference, 200), date, userId: req.user.id, billId,
          narration: `Delivery receipt for ${job.job_token}`
        }));
      }
      const paid = advanceTotal + alreadyPaid + deliveryTotal;
      const outstanding = Math.max(0, total - paid);
      run(
        `INSERT INTO job_delivery_acknowledgements
         (job_id,receiver_name,receiver_contact_masked,method,evidence_text,warranty_notes,service_notes,
          outstanding_paise,outstanding_terms,recorded_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [job.id, receiverName, cleanText(req.body.receiver_contact_masked, 100),
         cleanText(req.body.acknowledgement_method || 'OTP', 30).toUpperCase(),
         cleanText(req.body.evidence_text), cleanText(req.body.warranty_notes), cleanText(req.body.service_notes),
         paise(outstanding), cleanText(req.body.outstanding_terms), req.user.id]
      );
      run(
        `UPDATE job_orders SET current_status='DELIVERED',financial_status=?,final_bill_id=?,
         delivered_at=datetime('now'),closed_at=?,version=version+1,updated_at=datetime('now') WHERE id=?`,
        [outstanding <= 0.01 ? 'PAID' : paid > 0 ? 'PART_PAID' : 'OPEN', billId,
         outstanding <= 0.01 ? new Date().toISOString() : null, job.id]
      );
      run(
        `INSERT INTO job_status_events
         (job_id,from_status,to_status,reason,actor_user_id,operation_id) VALUES (?,?,?,?,?,?)`,
        [job.id, 'READY_FOR_DELIVERY', 'DELIVERED', 'Invoice posted and delivery acknowledged',
         req.user.id, crypto.randomUUID()]
      );
      recordSyncRevision(job.org_id, 'JOB', job.id, 'DELIVER', Number(job.version || 0) + 1);
      scheduleJobAttachmentCleanup(job.id);
      audit(req, job.id, job.org_id, 'DELIVERY', job.id, 'DELIVER', null,
        { bill_id: billId, bill_number: billNumber, receipt_ids: receipts.map(r => r.id), outstanding, reused_pre_bill: Boolean(preBill) });
      return { bill_id: billId, bill_number: billNumber, receipt_ids: receipts.map(r => r.id), outstanding, reused_pre_bill: Boolean(preBill) };
    });
    res.json({ success: true, ...outcome, job: projectJob(req, jobRow(job.id), true) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/:id/audit', (req, res) => {
  const job = jobRow(req.params.id);
  if (!requireJobOrgAccess(req, res, job)) return;
  const rows = all(
    `SELECT a.*,u.name actor_name FROM job_audit_events a
     LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.job_id=? ORDER BY a.id DESC`, [job.id]
  );
  res.json(rows.map(row => {
    if (!isFinanceUser(req) && ['ADDITION', 'ADDITION_APPROVAL', 'DELIVERY'].includes(row.entity_type)) {
      return { ...row, old_data: null, new_data: null };
    }
    return row;
  }));
});

module.exports = router;
