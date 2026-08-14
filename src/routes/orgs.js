const express = require('express');
const router = express.Router();
const { get, run, all } = require('../db/db');
const { authMiddleware, ownerOnly, requireOrgAccess } = require('../middleware/auth');
const {
  TRANSACTION_TYPES, sanitizeControl, defaultControl, typeMeta, parseJson
} = require('../business/transaction-controls');

router.use(authMiddleware);

const INVOICE_THEMES = new Set([
  'classic', 'sapphire', 'emerald', 'sunset', 'common-gst', 'gst-invoice', 'tally',
  'modern-wave', 'retail-grid', 'corporate-tax', 'commercial-red', 'statutory-gst',
  'royal-navy', 'plum', 'ruby', 'marigold', 'ocean', 'forest',
  'graphite', 'terracotta', 'indigo', 'slate'
]);

function validInvoiceTheme(value) {
  return INVOICE_THEMES.has(String(value || '').toLowerCase()) ? String(value).toLowerCase() : 'classic';
}

function getUserOrgs(user) {
  if (user.org_access === 'all') return all('SELECT * FROM orgs WHERE active=1 ORDER BY id');
  try {
    const ids = JSON.parse(user.org_access || '[]');
    if (!ids.length) return [];
    return all(`SELECT * FROM orgs WHERE id IN (${ids.join(',')}) AND active=1 ORDER BY id`);
  } catch(e) { return []; }
}

function normalizeInvoicePrintOptions(value, fallback = '{}') {
  let input = {};
  if (value && typeof value === 'object') input = value;
  else if (value === undefined && fallback) {
    try { input = JSON.parse(fallback || '{}'); } catch (_) { input = {}; }
  }
  return JSON.stringify({
    hsn: input.hsn !== false,
    rate: input.rate !== false,
    tax_inclusive_value: input.tax_inclusive_value !== false,
    bank_details: input.bank_details !== false
  });
}

function invoicePrintOptionsForOrg(org) {
  return parseJson(org?.invoice_print_options || '{}', {});
}

const FUTURE_TRANSACTION_PROFILE_KEY = 'future_transaction_control_profile';

function futureTransactionProfile() {
  const profile = parseJson(get('SELECT value FROM system_settings WHERE key=?', [FUTURE_TRANSACTION_PROFILE_KEY])?.value || '{}', {});
  return profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {};
}

function defaultControlForNewOrg(type, invoicePrintOptions) {
  const profile = futureTransactionProfile();
  return profile[type]
    ? sanitizeControl(type, profile[type], invoicePrintOptions)
    : defaultControl(type, invoicePrintOptions);
}

function controlProfile(rows) {
  return Object.fromEntries(rows.map(row => [row.transaction_type, {
    form_options: parseJson(row.form_options || '{}', {}),
    required_fields: parseJson(row.required_fields || '{}', {}),
    print_options: parseJson(row.print_options || '{}', {})
  }]));
}

function saveTransactionControl(org, type, candidate, userId) {
  const clean = sanitizeControl(type, candidate || {}, invoicePrintOptionsForOrg(org));
  run(`INSERT INTO transaction_control_settings
    (org_id,transaction_type,form_options,required_fields,print_options,updated_by,updated_at)
    VALUES (?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(org_id,transaction_type) DO UPDATE SET
      form_options=excluded.form_options,
      required_fields=excluded.required_fields,
      print_options=excluded.print_options,
      updated_by=excluded.updated_by,
      updated_at=datetime('now')`,
  [org.id, type, JSON.stringify(clean.form_options), JSON.stringify(clean.required_fields),
   JSON.stringify(clean.print_options), userId]);
  return clean;
}

function ensureTransactionControls(orgId, updatedBy = null) {
  const org = get('SELECT id,invoice_print_options FROM orgs WHERE id=?', [orgId]);
  if (!org) return [];
  const invoicePrintOptions = invoicePrintOptionsForOrg(org);
  TRANSACTION_TYPES.forEach(([type]) => {
    const existing = get(
      'SELECT id FROM transaction_control_settings WHERE org_id=? AND transaction_type=?',
      [orgId, type]
    );
    if (existing) return;
    const control = defaultControlForNewOrg(type, invoicePrintOptions);
    run(`INSERT INTO transaction_control_settings
      (org_id,transaction_type,form_options,required_fields,print_options,updated_by)
      VALUES (?,?,?,?,?,?)`,
      [orgId, type, JSON.stringify(control.form_options), JSON.stringify(control.required_fields),
       JSON.stringify(control.print_options), updatedBy]
    );
  });
  return all(
    'SELECT * FROM transaction_control_settings WHERE org_id=? ORDER BY transaction_type',
    [orgId]
  );
}

router.get('/', (req, res) => {
  res.json(getUserOrgs(req.user));
});

router.get('/:id/transaction-controls', (req, res) => {
  const org = get('SELECT * FROM orgs WHERE id=?', [req.params.id]);
  if (!org) return res.status(404).json({ error: 'Not found' });
  if (!requireOrgAccess(req, res, org.id)) return;
  const rows = ensureTransactionControls(org.id, req.user.id).map(row => ({
    transaction_type: row.transaction_type,
    form_options: parseJson(row.form_options || '{}', {}),
    required_fields: parseJson(row.required_fields || '{}', {}),
    print_options: parseJson(row.print_options || '{}', {}),
    updated_at: row.updated_at
  }));
  res.json({ meta: typeMeta(invoicePrintOptionsForOrg(org)), controls: rows });
});

router.put('/:id/transaction-controls', ownerOnly, (req, res) => {
  const org = get('SELECT * FROM orgs WHERE id=?', [req.params.id]);
  if (!org) return res.status(404).json({ error: 'Not found' });
  if (!requireOrgAccess(req, res, org.id)) return;
  ensureTransactionControls(org.id, req.user.id);
  const submitted = Array.isArray(req.body?.controls) ? req.body.controls : [];
  const byType = new Map(submitted.map(row => [String(row.transaction_type || ''), row]));
  TRANSACTION_TYPES.forEach(([type]) => {
    const current = get(
      'SELECT * FROM transaction_control_settings WHERE org_id=? AND transaction_type=?',
      [org.id, type]
    );
    saveTransactionControl(org, type, byType.get(type) || current || {}, req.user.id);
  });
  res.json({ success: true });
});

router.post('/:id/transaction-controls/propagate', ownerOnly, (req, res) => {
  const source = get('SELECT * FROM orgs WHERE id=? AND active=1', [req.params.id]);
  if (!source) return res.status(404).json({ error: 'Source company not found' });
  if (!requireOrgAccess(req, res, source.id)) return;
  const allowedIds = new Set(getUserOrgs(req.user).map(org => Number(org.id)));
  const targetIds = [...new Set((Array.isArray(req.body?.target_org_ids) ? req.body.target_org_ids : [])
    .map(Number).filter(id => Number.isInteger(id) && id > 0 && id !== Number(source.id)))];
  if (targetIds.some(id => !allowedIds.has(id))) {
    return res.status(403).json({ error: 'You cannot apply controls to one or more selected companies' });
  }
  const useForFuture = Boolean(req.body?.use_for_future_companies);
  if (useForFuture && req.user.org_access !== 'all') {
    return res.status(403).json({ error: 'Global access is required to set the default profile for future companies' });
  }
  if (!targetIds.length && !useForFuture) {
    return res.status(400).json({ error: 'Select at least one company or choose the future-company default option' });
  }

  const sourceProfile = controlProfile(ensureTransactionControls(source.id, req.user.id));
  targetIds.forEach(targetId => {
    const target = get('SELECT * FROM orgs WHERE id=? AND active=1', [targetId]);
    if (!target) return;
    ensureTransactionControls(target.id, req.user.id);
    TRANSACTION_TYPES.forEach(([type]) => saveTransactionControl(target, type, sourceProfile[type], req.user.id));
  });
  if (useForFuture) {
    run(`INSERT INTO system_settings (key,value,updated_by,updated_at) VALUES (?,?,?,datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=datetime('now')`,
    [FUTURE_TRANSACTION_PROFILE_KEY, JSON.stringify(sourceProfile), req.user.id]);
  }
  run(`INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address)
    VALUES (?,?,?,?,?,?,?)`,
  [req.user.id, source.id, 'PROPAGATE_TRANSACTION_CONTROLS', 'transaction_control_settings', source.id,
   JSON.stringify({ target_org_ids: targetIds, use_for_future_companies: useForFuture }), req.ip]);
  res.json({ success: true, updated_companies: targetIds.length, future_company_default: useForFuture });
});

router.get('/:id', (req, res) => {
  const org = get('SELECT * FROM orgs WHERE id=?', [req.params.id]);
  if (!org) return res.status(404).json({ error: 'Not found' });
  if (!requireOrgAccess(req, res, org.id)) return;
  res.json(org);
});

router.post('/', ownerOnly, (req, res) => {
  const { display_name, registered_name, address, phone, email, gstin, gst_type,
    bank_name, account_no, branch, ifsc, upi_id, note_header, note_footer, quotation_fixed_note,
    delivery_challan_fixed_note, proforma_fixed_note, invoice_description,
    project_bw_rate, project_colour_rate, project_book_rate, signature_name, signature_image, logo_base64,
    invoice_qr_enabled, negative_stock_allowed, default_tax_inclusive, invoice_prefixes,
    invoice_theme, invoice_print_options } = req.body;
  if (!display_name) return res.status(400).json({ error: 'Display name required' });
  const result = run(
    `INSERT INTO orgs (display_name,registered_name,address,phone,email,gstin,gst_type,
     bank_name,account_no,branch,ifsc,upi_id,note_header,note_footer,quotation_fixed_note,
     delivery_challan_fixed_note,proforma_fixed_note,invoice_description,
     project_bw_rate,project_colour_rate,project_book_rate,signature_name,signature_image,logo_base64,
     invoice_qr_enabled,negative_stock_allowed,default_tax_inclusive,invoice_prefixes,invoice_theme,invoice_print_options)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [display_name, registered_name || display_name, address || null, phone || null, email || null,
     gstin || null, gst_type || 'regular', bank_name || null, account_no || null, branch || null,
     ifsc || null, upi_id || null, note_header || '', note_footer || 'Thank you for your business!',
     quotation_fixed_note || '', delivery_challan_fixed_note || '', proforma_fixed_note || '',
     invoice_description || '', project_bw_rate || 0, project_colour_rate || 0, project_book_rate || 0,
     signature_name || display_name, signature_image || null, logo_base64 || null,
     invoice_qr_enabled === false ? 0 : 1,
     negative_stock_allowed === false || Number(negative_stock_allowed) === 0 ? 0 : 1,
     default_tax_inclusive ? 1 : 0, JSON.stringify(invoice_prefixes || {}),
     validInvoiceTheme(invoice_theme),
     normalizeInvoicePrintOptions(invoice_print_options)]
  );
  ensureTransactionControls(result.lastInsertRowid, req.user.id);
  res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/invoice-notes/all', ownerOnly, (req, res) => {
  const noteHeader = String(req.body.note_header || '').trim().slice(0, 2000);
  const noteFooter = String(req.body.note_footer || '').trim().slice(0, 2000);
  const quotationFixedNote = String(req.body.quotation_fixed_note || '').trim().slice(0, 2000);
  const deliveryChallanFixedNote = String(req.body.delivery_challan_fixed_note || '').trim().slice(0, 2000);
  const proformaFixedNote = String(req.body.proforma_fixed_note || '').trim().slice(0, 2000);
  const description = String(req.body.invoice_description || '').trim().slice(0, 4000);
  const ids = getUserOrgs(req.user).map(org => Number(org.id)).filter(Number.isInteger);
  if (!ids.length) return res.status(403).json({ error: 'No organization access available' });
  const result = run(`UPDATE orgs SET note_header=?,note_footer=?,quotation_fixed_note=?,delivery_challan_fixed_note=?,proforma_fixed_note=?,invoice_description=?
    WHERE active=1 AND id IN (${ids.map(() => '?').join(',')})`,
  [noteHeader, noteFooter, quotationFixedNote, deliveryChallanFixedNote, proformaFixedNote, description, ...ids]);
  res.json({ success: true, updated_companies: result.changes || 0 });
});

router.put('/:id', ownerOnly, (req, res) => {
  const existing = get('SELECT * FROM orgs WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { display_name, registered_name, address, phone, email, gstin, gst_type,
    bank_name, account_no, branch, ifsc, upi_id, note_header, note_footer, quotation_fixed_note,
    delivery_challan_fixed_note, proforma_fixed_note, invoice_description,
    project_bw_rate, project_colour_rate, project_book_rate, signature_name, logo_base64,
    signature_image, invoice_qr_enabled, negative_stock_allowed, default_tax_inclusive,
    invoice_prefixes, invoice_theme, invoice_print_options } = req.body;
  run(`UPDATE orgs SET display_name=?,registered_name=?,address=?,phone=?,email=?,gstin=?,gst_type=?,
       bank_name=?,account_no=?,branch=?,ifsc=?,upi_id=?,note_header=?,note_footer=?,quotation_fixed_note=?,
       delivery_challan_fixed_note=?,proforma_fixed_note=?,invoice_description=?,
       project_bw_rate=?,project_colour_rate=?,project_book_rate=?,signature_name=?,
       logo_base64=COALESCE(?,logo_base64),signature_image=COALESCE(?,signature_image),
       invoice_qr_enabled=?,negative_stock_allowed=?,default_tax_inclusive=?,invoice_prefixes=?,invoice_theme=?,
       invoice_print_options=? WHERE id=?`,
    [display_name, registered_name, address, phone, email, gstin, gst_type,
     bank_name, account_no, branch, ifsc, upi_id, note_header, note_footer,
     quotation_fixed_note ?? existing.quotation_fixed_note ?? '',
     delivery_challan_fixed_note ?? existing.delivery_challan_fixed_note ?? '',
     proforma_fixed_note ?? existing.proforma_fixed_note ?? '', invoice_description,
     project_bw_rate || 0, project_colour_rate || 0, project_book_rate || 0,
     signature_name, logo_base64 || null, signature_image || null,
     invoice_qr_enabled === false || Number(invoice_qr_enabled) === 0 ? 0 : 1,
     negative_stock_allowed === false || Number(negative_stock_allowed) === 0 ? 0 : 1,
     default_tax_inclusive ? 1 : 0, JSON.stringify(invoice_prefixes || {}),
     validInvoiceTheme(invoice_theme),
     normalizeInvoicePrintOptions(invoice_print_options, existing.invoice_print_options),
     req.params.id]);
  res.json({ success: true });
});

module.exports = router;
