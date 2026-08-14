const express = require('express');
const router = express.Router();
const { get, run, all, transaction } = require('../db/db');
const {
  authMiddleware, checkOrgAccess, requirePermission, requireOrgAccess
} = require('../middleware/auth');
const { postBill, postNote, removeSourceEntry } = require('../accounting/accounting');
const { billSettlement } = require('../accounting/accounting');
const { replaceStockMovements, removeStockMovements, validateStockAvailability } = require('../business/stock');
const { creditPolicyForParty, enforceCreditPolicy } = require('../business/credit');
const { rejectLockedPeriod, isPeriodLocked } = require('../middleware/auth');
const { invoicePrefix, invoiceNumber } = require('../business/numbering');
const { defaultControl, parseJson } = require('../business/transaction-controls');
const { partyForOrg } = require('../business/parties');
const { requireRegisteredOfflineDevice } = require('../security/registered-device');

const OWN_BILL_ONLY_ROLES = new Set(['operator', 'senior_operator', 'engineer']);

function ownBillOnly(user) {
  return OWN_BILL_ONLY_ROLES.has(String(user?.role || '').toLowerCase());
}

function requireBillVisibility(req, res, bill) {
  if (!bill || (ownBillOnly(req.user) && Number(bill.created_by) !== Number(req.user.id))) {
    res.status(404).json({ error: 'Bill not found' });
    return false;
  }
  return true;
}

router.use(authMiddleware);
router.use(checkOrgAccess);
router.use(requirePermission('billing'));

function getCurrentFY(dateValue) {
  const now = dateValue ? new Date(`${dateValue}T00:00:00`) : new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-${String(year + 1).slice(-2)}`;
}

function addCalendarDays(dateValue, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ''));
  if (!match) return dateValue;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + Number(days || 0)));
  return date.toISOString().slice(0, 10);
}

function numberToWords(n) {
  if (n === 0) return 'Zero';
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve',
    'Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function convert(num) {
    if (num < 20) return ones[num];
    if (num < 100) return tens[Math.floor(num/10)] + (num%10 ? ' ' + ones[num%10] : '');
    if (num < 1000) return ones[Math.floor(num/100)] + ' Hundred' + (num%100 ? ' ' + convert(num%100) : '');
    if (num < 100000) return convert(Math.floor(num/1000)) + ' Thousand' + (num%1000 ? ' ' + convert(num%1000) : '');
    if (num < 10000000) return convert(Math.floor(num/100000)) + ' Lakh' + (num%100000 ? ' ' + convert(num%100000) : '');
    return convert(Math.floor(num/10000000)) + ' Crore' + (num%10000000 ? ' ' + convert(num%10000000) : '');
  }
  const rupees = Math.floor(n);
  const paise = Math.round((n - rupees) * 100);
  let words = convert(rupees) + ' Rupees';
  if (paise > 0) words += ' and ' + convert(paise) + ' Paise';
  return words + ' Only';
}

function validatePaymentSplit(paymentMode, splitPayments, grandTotal) {
  if (paymentMode !== 'split') return [];
  if (!Array.isArray(splitPayments)) throw new Error('Split payments are required');
  const allowed = new Set(['cash', 'bank', 'upi', 'card', 'credit']);
  const normalized = splitPayments
    .map(row => ({ mode: String(row.mode || '').toLowerCase(), amount: Number(row.amount || 0) }))
    .filter(row => row.amount > 0);
  if (!normalized.length || normalized.some(row => !allowed.has(row.mode) || !Number.isFinite(row.amount))) {
    throw new Error('Split payments must use Cash, Bank, UPI, or Card with valid amounts');
  }
  const total = normalized.reduce((sum, row) => sum + row.amount, 0);
  if (Math.abs(total - Number(grandTotal || 0)) > 0.02) {
    throw new Error('Split payment total must equal the invoice total');
  }
  return normalized.map(row => ({ ...row, amount: Number(row.amount.toFixed(2)) }));
}

function cleanText(value, limit = 500) {
  return String(value || '').trim().slice(0, limit);
}

function titleCaseWords(value) {
  return cleanText(value, 240).replace(/\S+/g, word => word.charAt(0).toUpperCase() + word.slice(1));
}

function fixedNoteForFormat(org, format) {
  const fieldByFormat = {
    QUOT: 'quotation_fixed_note',
    DC: 'delivery_challan_fixed_note',
    PI: 'proforma_fixed_note'
  };
  const documentNote = cleanText(org?.[fieldByFormat[format]], 2000);
  const standardNote = cleanText(org?.note_footer, 2000);
  return [...new Set([documentNote, standardNote].filter(Boolean))].join('\n');
}

function pageParams(query, defaultLimit = 200, maxLimit = 500) {
  const requested = Number(query.limit || defaultLimit);
  const limit = Math.max(1, Math.min(maxLimit, Number.isFinite(requested) ? requested : defaultLimit));
  const offset = Math.max(0, Number(query.offset || 0) || 0);
  return { limit, offset };
}

function addressSnapshot(row, fallbackParty = null, fallbackAddress = '') {
  if (row) {
    return {
      id: row.id,
      label: row.label || '',
      address_type: row.address_type || '',
      contact_person: row.contact_person || '',
      phone: row.phone || '',
      email: row.email || '',
      address: row.address || '',
      city: row.city || '',
      district: row.district || '',
      state: row.state || '',
      pincode: row.pincode || '',
      gstin: row.gstin || ''
    };
  }
  if (!fallbackParty && !fallbackAddress) return null;
  return {
    id: null,
    label: 'Transaction Address',
    contact_person: fallbackParty?.registered_name || fallbackParty?.name || '',
    phone: fallbackParty?.phone || '',
    email: fallbackParty?.email || '',
    address: fallbackAddress || fallbackParty?.address || '',
    city: fallbackParty?.city || '',
    state: fallbackParty?.state || '',
    pincode: fallbackParty?.pincode || '',
    gstin: fallbackParty?.gstin || ''
  };
}

function formatAddressText(address) {
  if (!address) return '';
  return [
    address.address,
    address.city,
    address.district,
    address.state,
    address.pincode
  ].filter(Boolean).join(', ');
}

function resolvePartyAddress(addressId, party, orgId, fallbackAddress = '') {
  if (addressId) {
    if (!party || !partyForOrg(party.id, orgId)) {
      throw new Error('Selected address does not belong to this party/company');
    }
    const row = get(
      'SELECT * FROM party_addresses WHERE id=? AND party_id=? AND active=1',
      [addressId, party.id]
    );
    if (!row) throw new Error('Selected address does not belong to this party/company');
    const snapshot = addressSnapshot(row);
    return { id: row.id, snapshot, address: formatAddressText(snapshot) };
  }
  const snapshot = addressSnapshot(null, party, fallbackAddress);
  return {
    id: null,
    snapshot,
    address: cleanText(fallbackAddress || party?.address || '', 800)
  };
}

const DEFAULT_DSC_NOTE = 'Digital signature required before issue. Use the USB DSC token externally; Tarangini does not store DSC passwords.';

function normalizeDigitalSignatureSelection(inputRequired, inputNote, inputStatus, fallbackRequired = false, fallbackNote = '', fallbackStatus = '') {
  const required = inputRequired === undefined ? Boolean(Number(fallbackRequired || 0)) : Boolean(inputRequired);
  const note = required
    ? String(inputNote || fallbackNote || DEFAULT_DSC_NOTE).slice(0, 500)
    : '';
  const requestedStatus = String(inputStatus || fallbackStatus || '').toLowerCase();
  const status = required
    ? (requestedStatus === 'signed_in_app' ? 'signed_in_app' : 'pending')
    : 'not_required';
  return { required, note, status };
}

function transactionRequiredFields(orgId, type) {
  const row = get('SELECT required_fields FROM transaction_control_settings WHERE org_id=? AND transaction_type=?', [orgId, type]);
  if (row) return parseJson(row.required_fields || '{}', {});
  const org = get('SELECT invoice_print_options FROM orgs WHERE id=?', [orgId]);
  return defaultControl(type, parseJson(org?.invoice_print_options || '{}', {})).required_fields;
}

function requireBillControlFields(orgId, type, body) {
  const required = transactionRequiredFields(orgId, type);
  const missing = [];
  const items = Array.isArray(body.items) ? body.items : [];
  const hasItemValue = key => items.some(item => String(item[key] ?? '').trim() !== '' && Number(item[key] ?? 0) !== 0);
  if (required.party && !body.party_id) missing.push('Party / Customer');
  if (required.delivery_address && !body.delivery_address) missing.push('Delivery Address');
  if (required.recipient && !(body.delivery_info?.recipient_name || body.delivery_info?.recipient_phone)) missing.push('Recipient Name / Phone');
  if (required.transport && !body.delivery_info?.transport_name) missing.push('Transport / Courier');
  if (required.tracking && !body.delivery_info?.tracking_id) missing.push('Tracking / LR / Consignment No.');
  if (required.dispatch_date && !body.delivery_info?.dispatch_date) missing.push('Dispatch Date');
  if (required.po_details && !(body.po_number || body.po_date)) missing.push('PO Number / Date');
  if (required.hsn && !hasItemValue('hsn_code')) missing.push('HSN Code');
  if (required.item_description && !hasItemValue('item_description')) missing.push('Item Description / Serial');
  if (required.qty_unit && !items.every(item => Number(item.qty || 0) > 0 && String(item.unit || '').trim())) missing.push('Qty / Unit');
  if (required.rate && !items.every(item => Number(item.rate || 0) > 0)) missing.push('Rate');
  if (required.amount && !items.every(item => Number(item.amount || 0) > 0)) missing.push('Amount');
  if (required.payment_mode && !body.payment_mode) missing.push('Payment Mode');
  if (required.split_payment && body.payment_mode === 'split' && !(Array.isArray(body.split_payments) && body.split_payments.length)) missing.push('Split Payment Details');
  if (required.digital_signature && !body.digital_signature_required) missing.push('USB DSC Digital Signature');
  if (missing.length) throw new Error(`${type} required field missing: ${missing.join(', ')}`);
}

function parseBillItems(bill) {
  try {
    const parsed = JSON.parse(bill?.items_json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function findOrCreateBillMasterItem(orgId, item, userId) {
  const name = titleCaseWords(item?.item_name);
  let master = get(`SELECT id,name,hsn_code,unit,gst_rate FROM items
    WHERE org_id=? AND active=1 AND lower(trim(name))=lower(trim(?))`, [orgId, name]);
  if (master) return master;

  const next = Number(get('SELECT COUNT(*) count FROM items WHERE org_id=?', [orgId])?.count || 0) + 1;
  const org = get('SELECT display_name FROM orgs WHERE id=?', [orgId]);
  const orgCode = String(org?.display_name || 'ORG').replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase();
  const gstRate = item?.gst_rate === undefined || item?.gst_rate === '' ? 18 : Number(item.gst_rate || 0);
  const rate = Number(item?.rate || 0);
  const result = run(`INSERT INTO items
    (org_id,name,hsn_code,unit,gst_rate,last_sale_price,description,item_code,mrp)
    VALUES (?,?,?,?,?,?,?,?,?)`,
  [orgId, name, cleanText(item?.hsn_code, 80), cleanText(item?.unit, 30) || 'NOS', gstRate,
   rate, cleanText(item?.item_description, 1000), `${orgCode}-ITEM-${String(next).padStart(5, '0')}`, rate]);
  master = get('SELECT id,name,hsn_code,unit,gst_rate FROM items WHERE id=? AND org_id=?', [result.lastInsertRowid, orgId]);
  run(`INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data)
    VALUES (?,?,?,?,?,?)`,
  [userId || null, orgId, 'AUTO_CREATE_ITEM_FROM_BILL', 'items', master.id,
   JSON.stringify({ name: master.name, hsn_code: master.hsn_code, unit: master.unit, gst_rate: master.gst_rate })]);
  return master;
}

function normalizeBillItemsForOrg(orgId, rawItems, userId) {
  if (!Array.isArray(rawItems) || !rawItems.length) throw new Error('Add at least one item');
  return rawItems.map((item, index) => {
    const itemId = Number(item?.item_id || 0);
    const manualName = titleCaseWords(item?.item_name);
    if (!itemId) {
      if (!manualName) throw new Error(`Item name is required for line ${index + 1}`);
      const master = findOrCreateBillMasterItem(orgId, { ...item, item_name: manualName }, userId);
      return {
        ...item,
        item_id: master.id,
        item_name: master.name,
        hsn_code: cleanText(item?.hsn_code, 80) || master.hsn_code || '',
        unit: cleanText(item?.unit, 30) || master.unit || 'NOS',
        gst_rate: item?.gst_rate === undefined || item?.gst_rate === '' ? Number(master.gst_rate || 0) : item.gst_rate
      };
    }
    const master = get(`SELECT id,name,hsn_code,unit,gst_rate FROM items
      WHERE id=? AND org_id=? AND active=1`, [itemId, orgId]);
    if (!master) throw new Error(`Item on line ${index + 1} does not belong to this company or is inactive`);
    return {
      ...item,
      item_id: master.id,
      item_name: manualName || master.name,
      hsn_code: cleanText(item?.hsn_code, 80) || master.hsn_code || '',
      unit: cleanText(item?.unit, 30) || master.unit || 'NOS',
      gst_rate: item?.gst_rate === undefined || item?.gst_rate === '' ? Number(master.gst_rate || 0) : item.gst_rate
    };
  });
}

function billLineKey(item, index) {
  return String(item?.line_id || item?.source_line_key || index);
}

function addTransactionLink(orgId, sourceId, targetId, relationship, userId) {
  run(`INSERT OR IGNORE INTO transaction_links
       (org_id,source_type,source_id,target_type,target_id,relationship,created_by)
       VALUES (?,'bill',?,'bill',?,?,?)`,
    [orgId, sourceId, targetId, relationship, userId]);
}

function linkedBills(orgId, billId) {
  return all(`SELECT l.relationship, l.source_id, l.target_id,
                     b.id, b.format, b.bill_number, b.bill_date, b.status, b.grand_total
                FROM transaction_links l
                JOIN bills b ON b.id = CASE
                  WHEN l.source_id=? AND l.source_type='bill' THEN l.target_id
                  ELSE l.source_id END
               WHERE l.org_id=? AND ((l.source_type='bill' AND l.source_id=? AND l.target_type='bill')
                  OR (l.target_type='bill' AND l.target_id=? AND l.source_type='bill'))
                 AND b.deleted=0
               ORDER BY b.bill_date, b.id`, [billId, orgId, billId, billId]);
}

function allocatedSourceQuantities(orgId, sourceId, targetFormat) {
  const rows = all(`SELECT a.source_line_key, SUM(a.quantity) AS quantity
                      FROM transaction_line_allocations a
                      JOIN bills target ON target.id=a.target_id
                     WHERE a.org_id=? AND a.source_type='bill' AND a.source_id=?
                       AND a.target_type='bill' AND target.format=? AND target.deleted=0
                     GROUP BY a.source_line_key`, [orgId, sourceId, targetFormat]);
  return new Map(rows.map(row => [String(row.source_line_key), Number(row.quantity || 0)]));
}

function deriveBillItems(sourceBill, targetFormat, requestedItems) {
  const sourceItems = parseBillItems(sourceBill);
  const allocations = allocatedSourceQuantities(sourceBill.org_id, sourceBill.id, targetFormat);
  const requests = Array.isArray(requestedItems) && requestedItems.length
    ? requestedItems
    : sourceItems.map((item, index) => ({ source_line_key: billLineKey(item, index), qty: item.qty }));
  const selected = [];
  for (const request of requests) {
    const key = String(request.source_line_key ?? request.line_key ?? '');
    const index = sourceItems.findIndex((item, i) => billLineKey(item, i) === key);
    if (index < 0) throw new Error(`Source line ${key || '(blank)'} was not found`);
    const source = sourceItems[index];
    const sourceQty = Number(source.qty || 0);
    const already = Number(allocations.get(key) || 0);
    const remaining = Math.max(0, sourceQty - already);
    const qty = Number(request.qty ?? sourceQty);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Quantity for source line ${key} must be greater than zero`);
    if (qty > remaining + 0.00001) {
      throw new Error(`Quantity for source line ${key} exceeds remaining quantity (${remaining})`);
    }
    const rate = Number(source.rate || 0);
    selected.push({ ...source, source_line_key: key, qty, rate, amount: Number((qty * rate).toFixed(2)) });
  }
  if (!selected.length) throw new Error('At least one source line is required');
  return selected;
}

function insertDerivedBill({ req, sourceBill, targetFormat, items }) {
  const effectiveDate = cleanText(req.body.bill_date || new Date().toISOString().slice(0, 10), 20);
  const fy = getCurrentFY(effectiveDate);
  const org = get('SELECT * FROM orgs WHERE id=?', [sourceBill.org_id]);
  const party = sourceBill.party_id ? partyForOrg(sourceBill.party_id, sourceBill.org_id) : null;
  const subtotal = Number(items.reduce((sum, item) => sum + Number(item.amount || 0), 0).toFixed(2));
  const discount = Number(req.body.discount || 0);
  const gross = Math.max(0, subtotal - discount);
  const taxRate = targetFormat === 'DC' || org?.gst_type === 'composition' ? 0 : 18;
  const tax = Number((gross * taxRate / 100).toFixed(2));
  const cgst = Number((tax / 2).toFixed(2));
  const sgst = Number((tax - cgst).toFixed(2));
  const roundOff = req.body.round_off_enabled === false ? 0 : Number((Math.round(gross + tax) - (gross + tax)).toFixed(2));
  const grandTotal = Number((gross + tax + roundOff).toFixed(2));
  const billNumber = getNextBillNumber(sourceBill.org_id, targetFormat, fy);
  const partySnapshot = sourceBill.party_snapshot || (party ? JSON.stringify({
    name: party.name, registered_name: party.registered_name, address: party.address,
    city: party.city, state: party.state, gstin: party.gstin, gst_type: party.gst_type,
    phone: party.phone, email: party.email
  }) : null);
  const bankDetails = JSON.stringify({ bank_name: org?.bank_name, account_no: org?.account_no,
    branch: org?.branch, ifsc: org?.ifsc, upi_id: org?.upi_id });
  const result = run(`INSERT INTO bills
    (org_id,format,bill_number,bill_date,fy,party_id,party_snapshot,delivery_address,delivery_info,
     payment_mode,items_json,subtotal,discount,taxable_amount,tax_rate,cgst,sgst,igst,total_tax,grand_total,
     round_off,total_in_words,note_header,note_footer,description,bank_details,status,converted_from,
     tax_inclusive,digital_signature_required,digital_signature_note,digital_signature_status,created_by)
    VALUES (${Array.from({ length: 33 }, () => '?').join(',')})`,
    [sourceBill.org_id, targetFormat, billNumber, effectiveDate, fy, sourceBill.party_id || null, partySnapshot,
      sourceBill.delivery_address || null, sourceBill.delivery_info || '{}',
      targetFormat === 'DC' ? 'credit' : (req.body.payment_mode || 'credit'), JSON.stringify(items), subtotal,
      discount, Number((gross - (req.body.tax_inclusive ? tax : 0)).toFixed(2)), taxRate, cgst, sgst, 0, tax,
      grandTotal, roundOff, numberToWords(grandTotal), org?.note_header || '', fixedNoteForFormat(org, targetFormat) || sourceBill.note_footer || '',
      req.body.description || sourceBill.description || '', bankDetails, 'saved', sourceBill.id,
      req.body.tax_inclusive ? 1 : 0, 0, '', 'not_required', req.user.id]);
  const bill = get('SELECT * FROM bills WHERE id=?', [result.lastInsertRowid]);
  addTransactionLink(sourceBill.org_id, sourceBill.id, bill.id,
    targetFormat === 'DC' ? 'delivery_from' : 'invoice_from', req.user.id);
  items.forEach((item, index) => run(`INSERT OR IGNORE INTO transaction_line_allocations
    (org_id,source_type,source_id,source_line_key,target_type,target_id,target_line_key,quantity,created_by)
    VALUES (?,'bill',? ,?,'bill',?,?,?,?)`,
    [sourceBill.org_id, sourceBill.id, item.source_line_key, bill.id, String(index), item.qty, req.user.id]));
  run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
    [req.user.id, sourceBill.org_id, 'DERIVE_TRANSACTION', 'bills', bill.id,
      JSON.stringify({ source_id: sourceBill.id, source_format: sourceBill.format, target_format: targetFormat, bill_number: billNumber }), req.ip]);
  postBill(bill);
  if (targetFormat === 'SALE') replaceStockMovements({
    orgId: bill.org_id, sourceType: 'bill', sourceId: bill.id, date: bill.bill_date,
    refNumber: bill.bill_number, items, direction: 'out'
  });
  bill.items = items;
  bill.org = org;
  bill.party = party;
  return bill;
}

function getNextBillNumber(org_id, format, fy) {
  const org = get('SELECT * FROM orgs WHERE id=?', [org_id]);
  const prefix = invoicePrefix(org, format);

  let seq = get('SELECT * FROM bill_sequences WHERE org_id=? AND format=? AND fy=?', [org_id, format, fy]);
  if (!seq) {
    run('INSERT INTO bill_sequences (org_id,format,fy,prefix,last_number) VALUES (?,?,?,?,0)',
      [org_id, format, fy, prefix]);
    seq = { last_number: 0 };
  }
  const nextNum = (seq.last_number || 0) + 1;
  run('UPDATE bill_sequences SET last_number=? WHERE org_id=? AND format=? AND fy=?',
    [nextNum, org_id, format, fy]);
  run('UPDATE bill_sequences SET prefix=? WHERE org_id=? AND format=? AND fy=?',
    [prefix, org_id, format, fy]);
  return invoiceNumber(prefix, fy, nextNum);
}

router.get('/next-number', (req, res) => {
  const { org_id, format, fy } = req.query;
  // Peek without incrementing
  const org = get('SELECT * FROM orgs WHERE id=?', [org_id]);
  const prefix = invoicePrefix(org, format);
  const seq = get('SELECT last_number FROM bill_sequences WHERE org_id=? AND format=? AND fy=?', [org_id, format, fy]);
  const nextNum = (seq?.last_number || 0) + 1;
  res.json({ number: invoiceNumber(prefix, fy, nextNum), prefix });
});

router.get('/', (req, res) => {
  const { org_id, format, fy, party_id, search, status } = req.query;
  const page = pageParams(req.query);
  let sql = `SELECT b.*, p.name as party_name, u.name as created_by_name, u.username as created_by_username
    FROM bills b
    LEFT JOIN parties p ON b.party_id=p.id
    LEFT JOIN users u ON u.id=b.created_by
    WHERE b.deleted=0`;
  const params = [];
  if (ownBillOnly(req.user)) { sql += ' AND b.created_by=?'; params.push(req.user.id); }
  if (org_id) { sql += ' AND b.org_id=?'; params.push(org_id); }
  else if (req.user.org_access !== 'all') {
    let access = [];
    try { access = JSON.parse(req.user.org_access || '[]').map(Number).filter(Number.isInteger); } catch (_) {}
    if (!access.length) return res.json([]);
    sql += ` AND b.org_id IN (${access.map(() => '?').join(',')})`;
    params.push(...access);
  }
  if (format) { sql += ' AND b.format=?'; params.push(format); }
  if (fy) { sql += ' AND b.fy=?'; params.push(fy); }
  if (party_id) { sql += ' AND b.party_id=?'; params.push(party_id); }
  if (status) { sql += ' AND b.status=?'; params.push(status); }
  if (search) {
    sql += ` AND (b.bill_number LIKE ? OR p.name LIKE ? OR p.phone LIKE ? OR p.gstin LIKE ?
      OR b.party_snapshot LIKE ? OR b.po_number LIKE ? OR b.description LIKE ?)`;
    const s = `%${cleanText(search, 120)}%`;
    params.push(s, s, s, s, s, s, s);
  }
  sql += ' ORDER BY b.created_at DESC LIMIT ? OFFSET ?';
  params.push(page.limit, page.offset);
  res.json(all(sql, params).map(bill => ({ ...bill, ...billSettlement(bill) })));
});

router.get('/delivery-suggestions', (req, res) => {
  const orgId = Number(req.query.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  const values = {
    recipient_names: new Set(), recipient_phones: new Set(), tracking_ids: new Set(),
    dispatch_dates: new Set(), couriers: new Set(), descriptions: new Set()
  };
  all(`SELECT b.delivery_info,b.description,p.name AS party_name,p.phone AS party_phone
       FROM bills b LEFT JOIN parties p ON p.id=b.party_id
       WHERE b.org_id=? AND b.deleted=0
       ORDER BY b.created_at DESC LIMIT 500`, [orgId]).forEach(row => {
    let delivery = {};
    try { delivery = JSON.parse(row.delivery_info || '{}'); } catch (_) {}
    const add = (key, value) => {
      const text = cleanText(value, 240);
      if (text) values[key].add(text);
    };
    add('recipient_names', delivery.recipient_name || row.party_name);
    add('recipient_phones', delivery.recipient_phone || row.party_phone);
    add('tracking_ids', delivery.tracking_id);
    add('dispatch_dates', delivery.dispatch_date);
    add('couriers', delivery.transport_name);
    add('descriptions', row.description);
  });
  res.json(Object.fromEntries(Object.entries(values).map(([key, set]) => [key, [...set].slice(0, 80)])));
});

router.get('/:id', (req, res) => {
  const bill = get(`SELECT b.*, p.name as party_name, p.address as party_address FROM bills b
    LEFT JOIN parties p ON b.party_id=p.id WHERE b.id=? AND b.deleted=0`, [req.params.id]);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  if (!requireOrgAccess(req, res, bill.org_id)) return;
  if (!requireBillVisibility(req, res, bill)) return;
  try { bill.items = JSON.parse(bill.items_json || '[]'); } catch(e) { bill.items = []; }
  try { bill.delivery = JSON.parse(bill.delivery_info || '{}'); } catch (_) { bill.delivery = {}; }
  res.json({ ...bill, ...billSettlement(bill) });
});

router.post('/', rejectLockedPeriod, (req, res) => {
  try {
    const { org_id, format, bill_date, party_id, billing_address_id, delivery_address_id, delivery_address, delivery_info, po_number, po_date,
      credit_days, payment_mode, items, discount, note_footer, description, swipe_charge,
      custom_data, tax_inclusive, round_off_enabled, split_payments, shift_id, return_of,
      offline_id, offline_number, offline_device, offline_created_at,
      digital_signature_required, digital_signature_note, digital_signature_status } = req.body;

    if (!org_id || !format) return res.status(400).json({ error: 'org_id and format required' });
    if (!requireRegisteredOfflineDevice(req, res, org_id)) return;
    if (offline_id) {
      const duplicate = get('SELECT * FROM bills WHERE offline_id=? AND deleted=0', [offline_id]);
      if (duplicate) {
        try { duplicate.items = JSON.parse(duplicate.items_json || '[]'); } catch (_) { duplicate.items = []; }
        return res.json({ success: true, id: duplicate.id, bill: duplicate, sync_duplicate: true });
      }
      const numberConflict = offline_number
        ? get('SELECT id,offline_id FROM bills WHERE org_id=? AND bill_number=? AND deleted=0', [org_id, offline_number])
        : null;
      if (numberConflict) {
        return res.status(409).json({
          error: 'This offline invoice number already belongs to another invoice. Check that every client uses a different client code.',
          code: 'DEVICE_NUMBER_CONFLICT'
        });
      }
    }

    const effectiveDate = bill_date || new Date().toISOString().split('T')[0];
    const fy = getCurrentFY(effectiveDate);
    const org = get('SELECT * FROM orgs WHERE id=?', [org_id]);
    if (!org) return res.status(404).json({ error: 'Company not found' });
    const party = party_id ? partyForOrg(party_id, org_id) : null;
    if (party_id && !party) return res.status(400).json({ error: 'Customer does not belong to this company' });
    if (party && req.body.party_name_confirmation !== undefined &&
        String(req.body.party_name_confirmation || '').trim().toLowerCase() !== String(party.name || '').trim().toLowerCase()) {
      return res.status(409).json({ error: 'Selected customer/vendor name does not match the selected party. Select the party again.' });
    }
    const creditPolicy = party ? creditPolicyForParty(org_id, party.id) : null;
    const effectiveCreditDays = credit_days === undefined || credit_days === null || credit_days === ''
      ? Number(creditPolicy?.credit_days || 0)
      : Number(credit_days || 0);
    const dueDate = effectiveCreditDays > 0 ? addCalendarDays(effectiveDate, effectiveCreditDays) : effectiveDate;
    let normalizedItems;
    try { normalizedItems = normalizeBillItemsForOrg(org_id, items, req.user.id); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const billingAddress = resolvePartyAddress(billing_address_id, party, org_id);
    const deliveryAddress = resolvePartyAddress(delivery_address_id, party, org_id, delivery_address);
    try {
      const controlType = format === 'SALE' && shift_id ? 'POS' : format;
      requireBillControlFields(org_id, controlType, { ...req.body, items: normalizedItems });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    if (offline_id && party_id && !party) {
      return res.status(409).json({ error: 'Offline invoice customer no longer exists on the main system', code: 'PARTY_CONFLICT' });
    }
    if (offline_id) {
      const missingItem = (items || []).find(item => item.item_id &&
        !get('SELECT id FROM items WHERE id=? AND org_id=? AND active=1', [item.item_id, org_id]));
      if (missingItem) {
        return res.status(409).json({
          error: `Offline invoice item is unavailable on the main system: ${missingItem.item_name || missingItem.item_id}`,
          code: 'ITEM_CONFLICT'
        });
      }
    }
    // Calculate totals
    let subtotal = 0;
    const processedItems = normalizedItems.map((item, i) => {
      const qty = parseFloat(item.qty) || 0;
      let rate = parseFloat(item.rate) || 0;
      let amount = parseFloat(item.amount) || 0;

      if (amount && !rate && qty) { rate = amount / qty; }
      else if (rate && qty) { amount = rate * qty; }

      subtotal += amount;

      // Update item last price
      if (item.item_id && rate > 0) {
        try { run('UPDATE items SET last_sale_price=? WHERE id=? AND org_id=?', [rate, item.item_id, org_id]); } catch(e){}
      }

      return { ...item, sno: i + 1, rate: parseFloat(rate.toFixed(2)), amount: parseFloat(amount.toFixed(2)) };
    });
    const stockWarnings = format === 'SALE'
      ? validateStockAvailability(Number(org_id), processedItems)
      : [];

    const discountAmt = parseFloat(discount) || 0;
    const grossBeforeTax = subtotal - discountAmt;

    // Tax calculation
    const gstType = org?.gst_type || 'regular';
    const taxRate = gstType === 'composition' ? 0 : 18;
    let cgst = 0, sgst = 0, igst = 0;

    if (gstType === 'regular' && format !== 'DC') {
      if (tax_inclusive) {
        const taxPortion = grossBeforeTax * taxRate / (100 + taxRate);
        cgst = taxPortion / 2;
        sgst = taxPortion / 2;
      } else {
        cgst = grossBeforeTax * (taxRate / 2) / 100;
        sgst = grossBeforeTax * (taxRate / 2) / 100;
      }
    }

    const totalTax = cgst + sgst + igst;
    const taxable = tax_inclusive ? grossBeforeTax - totalTax : grossBeforeTax;
    const swipeCharge = parseFloat(swipe_charge) || 0;
    const totalBeforeRound = grossBeforeTax + (tax_inclusive ? 0 : totalTax) + swipeCharge;
    const roundOff = round_off_enabled === false ? 0 : Number((Math.round(totalBeforeRound) - totalBeforeRound).toFixed(2));
    const grandTotal = Number((totalBeforeRound + roundOff).toFixed(2));
    const normalizedSplit = validatePaymentSplit(payment_mode, split_payments, grandTotal);
    try {
      enforceCreditPolicy({ orgId: org_id, partyId: party?.id, format, paymentMode: payment_mode || 'cash', grandTotal });
    } catch (error) {
      return res.status(error.statusCode || 400).json({ error: error.message, code: error.code, credit: error.position || null });
    }

    const billNumber = offline_id && offline_number
      ? String(offline_number).slice(0, 100)
      : getNextBillNumber(org_id, format, fy);
    const partySnapshot = party ? JSON.stringify({
      name: party.name, registered_name: party.registered_name,
      address: party.address, city: party.city, state: party.state,
      gstin: party.gstin, gst_type: party.gst_type, phone: party.phone, email: party.email,
      digital_signature_required: party.digital_signature_required ? 1 : 0
    }) : null;
    const signatureSelection = normalizeDigitalSignatureSelection(
      digital_signature_required,
      digital_signature_note,
      digital_signature_status,
      party?.digital_signature_required
    );

    const bankDetails = JSON.stringify({
      bank_name: org?.bank_name, account_no: org?.account_no,
      branch: org?.branch, ifsc: org?.ifsc, upi_id: org?.upi_id
    });

    const result = run(
      `INSERT INTO bills (org_id,format,bill_number,bill_date,fy,party_id,party_snapshot,
       billing_address_id,billing_address_snapshot,delivery_address_id,delivery_address_snapshot,delivery_address,delivery_info,
       po_number,po_date,credit_days,due_date,payment_mode,items_json,subtotal,discount,taxable_amount,tax_rate,
       cgst,sgst,igst,total_tax,grand_total,round_off,total_in_words,note_header,note_footer,description,
       swipe_charge,custom_data,split_payments,cost_total,shift_id,return_of,bank_details,status,
       offline_id,offline_device,offline_created_at,tax_inclusive,digital_signature_required,digital_signature_note,
       digital_signature_status,digital_signature_signed_at,digital_signature_signed_by,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [org_id, format, billNumber, effectiveDate, fy,
       party_id || null, partySnapshot,
       billingAddress.id, billingAddress.snapshot ? JSON.stringify(billingAddress.snapshot) : null,
       deliveryAddress.id, deliveryAddress.snapshot ? JSON.stringify(deliveryAddress.snapshot) : null,
       deliveryAddress.address || null, JSON.stringify(delivery_info || {}),
       po_number || null, po_date || null,
       effectiveCreditDays || null, dueDate, payment_mode || 'cash', JSON.stringify(processedItems),
       parseFloat(subtotal.toFixed(2)), discountAmt, parseFloat(taxable.toFixed(2)),
       taxRate, parseFloat(cgst.toFixed(2)), parseFloat(sgst.toFixed(2)), parseFloat(igst.toFixed(2)),
       parseFloat(totalTax.toFixed(2)), parseFloat(grandTotal.toFixed(2)), roundOff,
       numberToWords(grandTotal), org?.note_header || '',
       fixedNoteForFormat(org, format) || note_footer || '', description || org?.invoice_description || '',
       swipeCharge, JSON.stringify(custom_data || {}), JSON.stringify(normalizedSplit),
       processedItems.reduce((sum, item) => {
         const master = item.item_id ? get('SELECT last_purchase_price FROM items WHERE id=? AND org_id=?', [item.item_id, org_id]) : null;
         return sum + Number(item.qty || 0) * Number(master?.last_purchase_price || 0);
       }, 0), shift_id || null, return_of || null, bankDetails, 'saved',
       offline_id || null, offline_device || null, offline_created_at || null, tax_inclusive ? 1 : 0,
       signatureSelection.required ? 1 : 0, signatureSelection.note, signatureSelection.status,
       signatureSelection.status === 'signed_in_app' ? new Date().toISOString() : null,
       signatureSelection.status === 'signed_in_app' ? req.user.id : null,
       req.user.id]
    );

    // Audit log
    run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
      [req.user.id, org_id, 'CREATE', 'bills', result.lastInsertRowid,
       JSON.stringify({ bill_number: billNumber, grand_total: grandTotal }), req.ip]);

    const savedBill = get('SELECT * FROM bills WHERE id=?', [result.lastInsertRowid]);
    postBill(savedBill);
    if (format === 'SALE') replaceStockMovements({
      orgId: Number(org_id), sourceType: 'bill', sourceId: savedBill.id, date: effectiveDate,
      refNumber: billNumber, items: processedItems, direction: 'out'
    });
    try { savedBill.items = JSON.parse(savedBill.items_json || '[]'); } catch(e) { savedBill.items = []; }
    savedBill.org = org;
    savedBill.party = party;
    savedBill.created_by_name = req.user.name;
    savedBill.created_by_username = req.user.username;

    res.json({ success: true, id: result.lastInsertRowid, bill: savedBill, stock_warnings: stockWarnings });
  } catch(e) {
    console.error('Bill save error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', (req, res) => {
  const existing = get('SELECT * FROM bills WHERE id=? AND deleted=0', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Bill not found' });
  if (!requireOrgAccess(req, res, existing.org_id)) return;
  if (!requireBillVisibility(req, res, existing)) return;
  const emergencyReason = String(req.body.edit_reason || req.body.emergency_reason || '').trim();
  const isOwner1 = req.user.role === 'owner' && String(req.user.username).toLowerCase() === 'owner1';
  if (ownBillOnly(req.user) && emergencyReason.length < 10) {
    return res.status(400).json({ error: 'Operator edit reason of at least 10 characters is required' });
  }
  if (existing.offline_id && !isOwner1) {
    return res.status(403).json({
      error: 'A synchronized offline invoice can only be changed by Owner1 using Emergency Edit'
    });
  }
  if (existing.offline_id && emergencyReason.length < 5) {
    return res.status(400).json({
      error: 'Owner1 must enter an emergency correction reason of at least 5 characters'
    });
  }
  const { items, discount, payment_mode, party_id, po_number, po_date, credit_days, billing_address_id, delivery_address_id, delivery_address, delivery_info,
    note_footer, description, swipe_charge, custom_data, bill_date, tax_inclusive, round_off_enabled,
    split_payments, shift_id, digital_signature_required, digital_signature_note, digital_signature_status } = req.body;
  if (isPeriodLocked(existing.org_id, bill_date || existing.bill_date) && !isOwner1) {
    return res.status(423).json({ error: `Financial year ${getCurrentFY(bill_date || existing.bill_date)} is locked` });
  }
  if (existing.status === 'converted' && !isOwner1) return res.status(400).json({ error: 'Converted bills cannot be edited' });

  const org = get('SELECT * FROM orgs WHERE id=?', [existing.org_id]);
  const nextPartyId = party_id === undefined ? existing.party_id : (Number(party_id) || null);
  const partyChanged = Number(nextPartyId || 0) !== Number(existing.party_id || 0);
  const party = nextPartyId ? partyForOrg(nextPartyId, existing.org_id) : null;
  if (nextPartyId && !party) {
    return res.status(400).json({ error: 'Customer does not belong to this company' });
  }
  if (party && req.body.party_name_confirmation !== undefined &&
      String(req.body.party_name_confirmation || '').trim().toLowerCase() !== String(party.name || '').trim().toLowerCase()) {
    return res.status(409).json({ error: 'Selected customer/vendor name does not match the selected party. Select the party again.' });
  }
  let normalizedItems;
  try { normalizedItems = normalizeBillItemsForOrg(existing.org_id, items, req.user.id); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const selectedBillingAddressId = billing_address_id === undefined
    ? (partyChanged ? null : existing.billing_address_id)
    : billing_address_id;
  const selectedDeliveryAddressId = delivery_address_id === undefined
    ? (partyChanged ? null : existing.delivery_address_id)
    : delivery_address_id;
  const selectedDeliveryAddress = delivery_address === undefined
    ? (partyChanged ? formatAddressText(addressSnapshot(null, party)) : existing.delivery_address)
    : delivery_address;
  let billingAddress;
  let deliveryAddress;
  try {
    billingAddress = resolvePartyAddress(
      selectedBillingAddressId,
      party,
      existing.org_id
    );
    deliveryAddress = resolvePartyAddress(
      selectedDeliveryAddressId,
      party,
      existing.org_id,
      selectedDeliveryAddress
    );
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const controlType = existing.format === 'SALE' && (req.body.shift_id || existing.shift_id) ? 'POS' : existing.format;
    requireBillControlFields(existing.org_id, controlType, {
      ...req.body,
      party_id: nextPartyId,
      po_number: req.body.po_number ?? existing.po_number,
      po_date: req.body.po_date ?? existing.po_date,
      delivery_address: req.body.delivery_address ?? existing.delivery_address,
      delivery_info: req.body.delivery_info || parseJson(existing.delivery_info || '{}', {}),
      payment_mode: req.body.payment_mode ?? existing.payment_mode,
      digital_signature_required: req.body.digital_signature_required ?? existing.digital_signature_required,
      items: normalizedItems
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const gstType = org?.gst_type || 'regular';
  const taxRate = gstType === 'composition' ? 0 : 18;

  let subtotal = 0;
  const processedItems = normalizedItems.map((item, i) => {
    const qty = parseFloat(item.qty) || 0;
    let rate = parseFloat(item.rate) || 0;
    let amount = parseFloat(item.amount) || 0;
    if (amount && !rate && qty) rate = amount / qty;
    else if (rate && qty) amount = rate * qty;
    subtotal += amount;
    if (item.item_id && rate > 0) {
      try { run('UPDATE items SET last_sale_price=? WHERE id=? AND org_id=?',
        [rate, item.item_id, existing.org_id]); } catch(e){}
    }
    return { ...item, sno: i + 1, rate: parseFloat(rate.toFixed(2)), amount: parseFloat(amount.toFixed(2)) };
  });
  const stockWarnings = existing.format === 'SALE'
    ? validateStockAvailability(Number(existing.org_id), processedItems, existing.id)
    : [];

  const discountAmt = parseFloat(discount) || 0;
  const grossBeforeTax = subtotal - discountAmt;
  let cgst = 0, sgst = 0;
  if (gstType === 'regular' && existing.format !== 'DC') {
    if (tax_inclusive) {
      const tp = grossBeforeTax * taxRate / (100 + taxRate);
      cgst = tp / 2; sgst = tp / 2;
    } else {
      cgst = grossBeforeTax * (taxRate / 2) / 100;
      sgst = grossBeforeTax * (taxRate / 2) / 100;
    }
  }
  const totalTax = cgst + sgst;
  const taxable = tax_inclusive ? grossBeforeTax - totalTax : grossBeforeTax;
  const swipeCharge = parseFloat(swipe_charge) || 0;
  const totalBeforeRound = grossBeforeTax + (tax_inclusive ? 0 : totalTax) + swipeCharge;
  const useRoundOff = round_off_enabled === undefined ? Math.abs(Number(existing.round_off || 0)) > 0.001 : round_off_enabled !== false;
  const roundOff = useRoundOff ? Number((Math.round(totalBeforeRound) - totalBeforeRound).toFixed(2)) : 0;
  const grandTotal = Number((totalBeforeRound + roundOff).toFixed(2));
  const normalizedSplit = validatePaymentSplit(payment_mode || existing.payment_mode, split_payments, grandTotal);
  try {
    enforceCreditPolicy({
      orgId: existing.org_id,
      partyId: nextPartyId,
      format: existing.format,
      paymentMode: payment_mode || existing.payment_mode || 'cash',
      grandTotal,
      excludeBillId: existing.id
    });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message, code: error.code, credit: error.position || null });
  }
  const signatureSelection = normalizeDigitalSignatureSelection(
    digital_signature_required,
    digital_signature_note,
    digital_signature_status,
    existing.digital_signature_required,
    existing.digital_signature_note,
    existing.digital_signature_status
  );
  const signatureSignedAt = signatureSelection.status === 'signed_in_app'
    ? (existing.digital_signature_status === 'signed_in_app' ? existing.digital_signature_signed_at : new Date().toISOString())
    : null;
  const signatureSignedBy = signatureSelection.status === 'signed_in_app'
    ? (existing.digital_signature_status === 'signed_in_app' ? existing.digital_signature_signed_by : req.user.id)
    : null;
  const partySnapshot = party ? JSON.stringify({
    name: party.name,
    registered_name: party.registered_name,
    address: party.address,
    city: party.city,
    state: party.state,
    gstin: party.gstin,
    gst_type: party.gst_type,
    phone: party.phone,
    email: party.email,
    digital_signature_required: party.digital_signature_required ? 1 : 0
  }) : null;
  const billingSnapshot = billingAddress.snapshot
    ? JSON.stringify(billingAddress.snapshot)
    : (partyChanged ? null : existing.billing_address_snapshot || null);
  const deliverySnapshot = deliveryAddress.snapshot
    ? JSON.stringify(deliveryAddress.snapshot)
    : (partyChanged ? null : existing.delivery_address_snapshot || null);
  const updatedCreditPolicy = party ? creditPolicyForParty(existing.org_id, party.id) : null;
  const effectiveCreditDays = credit_days === undefined || credit_days === null || credit_days === ''
    ? (partyChanged ? Number(updatedCreditPolicy?.credit_days || 0) : Number(existing.credit_days || 0))
    : Number(credit_days || 0);
  const effectiveBillDate = bill_date || existing.bill_date;
  const effectiveDueDate = effectiveCreditDays > 0 ? addCalendarDays(effectiveBillDate, effectiveCreditDays) : effectiveBillDate;

  run(`UPDATE bills SET bill_date=?,party_id=?,party_snapshot=?,items_json=?,subtotal=?,discount=?,taxable_amount=?,tax_rate=?,
       cgst=?,sgst=?,total_tax=?,grand_total=?,round_off=?,total_in_words=?,payment_mode=?,po_number=?,po_date=?,
       credit_days=?,due_date=?,billing_address_id=?,billing_address_snapshot=?,delivery_address_id=?,delivery_address_snapshot=?,
       delivery_address=?,delivery_info=?,note_header=?,note_footer=?,description=?,swipe_charge=?,
       custom_data=?,split_payments=?,shift_id=?,tax_inclusive=?,digital_signature_required=?,digital_signature_note=?,
       digital_signature_status=?,digital_signature_signed_at=?,digital_signature_signed_by=?,
       edited_by=?,updated_at=datetime('now') WHERE id=?`,
    [bill_date || existing.bill_date, nextPartyId, partySnapshot, JSON.stringify(processedItems), subtotal, discountAmt, taxable, taxRate,
     cgst, sgst, totalTax, grandTotal, roundOff, numberToWords(grandTotal),
     payment_mode || existing.payment_mode || 'cash', po_number ?? existing.po_number ?? null,
     po_date ?? existing.po_date ?? null, effectiveCreditDays || null, effectiveDueDate,
     billingAddress.id, billingSnapshot,
     deliveryAddress.id, deliverySnapshot,
     deliveryAddress.address ?? existing.delivery_address ?? null,
     JSON.stringify(delivery_info || JSON.parse(existing.delivery_info || '{}')),
     org?.note_header || '', fixedNoteForFormat(org, existing.format) || note_footer || '',
     description || org?.invoice_description || '', swipeCharge, JSON.stringify(custom_data || {}),
     JSON.stringify(normalizedSplit), shift_id || existing.shift_id || null, tax_inclusive ? 1 : 0,
     signatureSelection.required ? 1 : 0, signatureSelection.note, signatureSelection.status,
     signatureSignedAt, signatureSignedBy, req.user.id, req.params.id]);

  run(`INSERT INTO audit_log
       (user_id,org_id,action,table_name,record_id,old_data,new_data,ip_address)
       VALUES (?,?,?,?,?,?,?,?)`,
    [req.user.id, existing.org_id, existing.offline_id ? 'EMERGENCY_EDIT' : 'EDIT', 'bills',
     req.params.id, JSON.stringify(existing),
     JSON.stringify({
       reason: emergencyReason || null,
       offline_id: existing.offline_id || null,
       previous_party_id: existing.party_id || null,
       party_id: nextPartyId
     }),
     req.ip]);

  const updated = get('SELECT * FROM bills WHERE id=?', [req.params.id]);
  postBill(updated);
  if (updated.format === 'SALE') replaceStockMovements({
    orgId: updated.org_id, sourceType: 'bill', sourceId: updated.id, date: updated.bill_date,
    refNumber: updated.bill_number, items: processedItems, direction: 'out'
  });
  try { updated.items = JSON.parse(updated.items_json || '[]'); } catch(e) { updated.items = []; }
  try { updated.delivery = JSON.parse(updated.delivery_info || '{}'); } catch (_) { updated.delivery = {}; }
  updated.org = org;
  updated.party = party;
  const editor = get('SELECT name,username FROM users WHERE id=?', [updated.created_by]);
  updated.created_by_name = editor?.name;
  updated.created_by_username = editor?.username;
  res.json({ success: true, bill: updated, stock_warnings: stockWarnings });
});

router.post('/:id/digital-signature/mark-signed', (req, res) => {
  const bill = get('SELECT * FROM bills WHERE id=? AND deleted=0', [req.params.id]);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  if (!requireOrgAccess(req, res, bill.org_id)) return;
  if (!requireBillVisibility(req, res, bill)) return;
  if (!Number(bill.digital_signature_required || 0)) {
    return res.status(400).json({ error: 'Digital signature is not required for this invoice' });
  }
  if (bill.digital_signature_status === 'signed_in_app') {
    try { bill.items = JSON.parse(bill.items_json || '[]'); } catch (_) { bill.items = []; }
    return res.json({ success: true, bill, already_signed: true });
  }

  const confirmation = String(req.body.confirmation || '').trim();
  if (confirmation.length < 8) {
    return res.status(400).json({
      error: 'Enter a confirmation note after completing DSC token signing'
    });
  }

  const signedAt = new Date().toISOString();
  run(`UPDATE bills SET digital_signature_status='signed_in_app',
       digital_signature_signed_at=?,digital_signature_signed_by=?,digital_signature_note=?,
       edited_by=?,updated_at=datetime('now') WHERE id=?`,
    [
      signedAt,
      req.user.id,
      String(req.body.note || bill.digital_signature_note || DEFAULT_DSC_NOTE).slice(0, 500),
      req.user.id,
      bill.id
    ]);
  run(`INSERT INTO audit_log
       (user_id,org_id,action,table_name,record_id,old_data,new_data,ip_address)
       VALUES (?,?,?,?,?,?,?,?)`,
    [req.user.id, bill.org_id, 'DSC_SIGNED', 'bills', bill.id,
     JSON.stringify({
       digital_signature_status: bill.digital_signature_status,
       digital_signature_signed_at: bill.digital_signature_signed_at
     }),
     JSON.stringify({
       digital_signature_status: 'signed_in_app',
       digital_signature_signed_at: signedAt,
       confirmation: confirmation.slice(0, 300),
       signing_mode: String(req.body.signing_mode || 'operator_confirmed').slice(0, 80)
     }),
     req.ip]);

  const updated = get('SELECT * FROM bills WHERE id=?', [bill.id]);
  try { updated.items = JSON.parse(updated.items_json || '[]'); } catch (_) { updated.items = []; }
  try { updated.delivery = JSON.parse(updated.delivery_info || '{}'); } catch (_) { updated.delivery = {}; }
  updated.org = get('SELECT * FROM orgs WHERE id=?', [updated.org_id]);
  updated.party = updated.party_id ? get('SELECT * FROM parties WHERE id=?', [updated.party_id]) : null;
  const signer = get('SELECT name,username FROM users WHERE id=?', [req.user.id]);
  updated.digital_signature_signed_by_name = signer?.name || signer?.username || '';
  res.json({ success: true, bill: updated });
});

router.get('/corrections/list', (req, res) => {
  let sql = `SELECT cr.*,b.bill_number,b.grand_total,u.name requested_by_name,ru.name reviewed_by_name
    FROM invoice_correction_requests cr
    JOIN bills b ON b.id=cr.bill_id
    JOIN users u ON u.id=cr.requested_by
    LEFT JOIN users ru ON ru.id=cr.reviewed_by WHERE 1=1`;
  const params = [];
  if (req.query.org_id) { sql += ' AND cr.org_id=?'; params.push(req.query.org_id); }
  if (ownBillOnly(req.user)) { sql += ' AND b.created_by=?'; params.push(req.user.id); }
  if (req.query.status) { sql += ' AND cr.status=?'; params.push(req.query.status); }
  sql += ' ORDER BY cr.created_at DESC';
  res.json(all(sql, params));
});

router.post('/:id/correction-request', (req, res) => {
  const bill = get('SELECT * FROM bills WHERE id=? AND deleted=0', [req.params.id]);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  if (!requireOrgAccess(req, res, bill.org_id)) return;
  if (!requireBillVisibility(req, res, bill)) return;
  const reason = String(req.body.reason || '').trim();
  const proposedItems = Array.isArray(req.body.proposed_items) ? req.body.proposed_items : [];
  if (reason.length < 5 || !proposedItems.length) {
    return res.status(400).json({ error: 'Reason and proposed invoice items are required' });
  }
  const original = JSON.parse(bill.items_json || '[]');
  const invalidProposal = proposedItems.length !== original.length || original.some((item, index) => {
    const proposed = proposedItems[index];
    return !proposed ||
      String(proposed.item_id || proposed.item_name) !== String(item.item_id || item.item_name) ||
      Number(proposed.qty || 0) < 0 ||
      Number(proposed.qty || 0) > Number(item.qty || 0);
  });
  if (invalidProposal) {
    return res.status(400).json({ error: 'Proposed items must preserve every invoice row and may only reduce quantity' });
  }
  const pending = get(
    `SELECT id FROM invoice_correction_requests WHERE bill_id=? AND status='pending'`,
    [bill.id]
  );
  if (pending) return res.status(409).json({ error: 'A correction request is already pending for this invoice' });
  const result = run(
    `INSERT INTO invoice_correction_requests
     (org_id,bill_id,requested_by,reason,requested_items,proposed_items)
     VALUES (?,?,?,?,?,?)`,
    [bill.org_id, bill.id, req.user.id, reason, JSON.stringify(original), JSON.stringify(proposedItems)]
  );
  run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
    [req.user.id, bill.org_id, 'CORRECTION_REQUEST', 'bills', bill.id,
     JSON.stringify({ correction_request_id: result.lastInsertRowid, reason }), req.ip]);
  res.json({ success: true, id: result.lastInsertRowid, status: 'pending' });
});

router.put('/corrections/:id/review', (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner approval required' });
  const request = get(`SELECT * FROM invoice_correction_requests WHERE id=? AND status='pending'`, [req.params.id]);
  if (!request) return res.status(404).json({ error: 'Pending correction request not found' });
  if (!requireOrgAccess(req, res, request.org_id)) return;
  const bill = get('SELECT * FROM bills WHERE id=? AND deleted=0', [request.bill_id]);
  if (!bill) return res.status(404).json({ error: 'Invoice not found' });
  const decision = String(req.body.decision || '');
  if (decision === 'reject') {
    run(`UPDATE invoice_correction_requests SET status='rejected',reviewed_by=?,review_note=?,reviewed_at=datetime('now')
         WHERE id=?`, [req.user.id, req.body.review_note || '', request.id]);
    return res.json({ success: true, status: 'rejected' });
  }
  if (decision !== 'approve') return res.status(400).json({ error: 'Decision must be approve or reject' });

  const original = JSON.parse(request.requested_items || '[]');
  const proposed = JSON.parse(request.proposed_items || '[]');
  const removed = original.map((item, index) => {
    const proposedItem = proposed[index];
    const sameRow = proposedItem &&
      String(proposedItem.item_id || proposedItem.item_name) === String(item.item_id || item.item_name);
    const proposedQty = sameRow ? Number(proposedItem.qty || 0) : 0;
    const removedQty = Math.max(0, Number(item.qty || 0) - proposedQty);
    return { ...item, qty: removedQty, amount: removedQty * Number(item.rate || 0) };
  }).filter(item => item.qty > 0);
  if (!removed.length) return res.status(400).json({ error: 'The proposal does not remove any quantity' });

  const noteDate = req.body.note_date || new Date().toISOString().slice(0, 10);
  const fy = getCurrentFY(noteDate);
  const orgCode = get('SELECT display_name FROM orgs WHERE id=?', [bill.org_id])?.display_name?.slice(0, 3).toUpperCase() || 'ORG';
  let seq = get(`SELECT * FROM bill_sequences WHERE org_id=? AND format='CREDIT_NOTE' AND fy=?`, [bill.org_id, fy]);
  const next = Number(seq?.last_number || 0) + 1;
  if (seq) run('UPDATE bill_sequences SET last_number=? WHERE id=?', [next, seq.id]);
  else run(`INSERT INTO bill_sequences (org_id,format,fy,prefix,last_number) VALUES (?,'CREDIT_NOTE',?,'CN',?)`,
    [bill.org_id, fy, next]);
  const number = `${orgCode}/CN/${fy}/${String(next).padStart(4, '0')}`;
  const removedSubtotal = removed.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const ratio = Number(bill.subtotal || 0) > 0
    ? Math.min(1, removedSubtotal / Number(bill.subtotal))
    : 0;
  const taxable = Number((Number(bill.taxable_amount || 0) * ratio).toFixed(2));
  const correctedTotal = Number(((Number(bill.grand_total || 0) - Number(bill.swipe_charge || 0)) * ratio).toFixed(2));
  const tax = Number(Math.max(0, correctedTotal - taxable).toFixed(2));
  const noteResult = run(
    `INSERT INTO credit_debit_notes
     (org_id,note_number,note_date,fy,note_type,party_id,linked_bill_id,items_json,
      taxable_amount,tax_amount,grand_total,narration,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [bill.org_id, number, noteDate, fy, 'credit', bill.party_id, bill.id, JSON.stringify(removed),
     taxable, tax, taxable + tax, `Approved correction for ${bill.bill_number}: ${request.reason}`, req.user.id]
  );
  const note = get('SELECT * FROM credit_debit_notes WHERE id=?', [noteResult.lastInsertRowid]);
  postNote(note);
  replaceStockMovements({
    orgId: bill.org_id, sourceType: 'note', sourceId: note.id, date: noteDate,
    refNumber: number, items: removed, direction: 'in'
  });
  run(`UPDATE invoice_correction_requests
       SET status='approved',reviewed_by=?,review_note=?,resolution_type='credit_note',
       credit_note_id=?,reviewed_at=datetime('now') WHERE id=?`,
    [req.user.id, req.body.review_note || '', note.id, request.id]);
  run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
    [req.user.id, bill.org_id, 'CORRECTION_APPROVED', 'bills', bill.id,
     JSON.stringify({ correction_request_id: request.id, credit_note_id: note.id, credit_note: number }), req.ip]);
  res.json({ success: true, status: 'approved', credit_note: note });
});

router.delete('/:id', (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only can delete' });
  const bill = get('SELECT * FROM bills WHERE id=?', [req.params.id]);
  if (!bill) return res.status(404).json({ error: 'Not found' });
  if (!requireOrgAccess(req, res, bill.org_id)) return;
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5) {
    return res.status(400).json({ error: 'Deletion reason of at least 5 characters is required' });
  }
  if (isPeriodLocked(bill.org_id, bill.bill_date)) {
    return res.status(423).json({ error: `Financial year ${bill.fy} is locked` });
  }
  run('UPDATE bills SET deleted=1,status=? WHERE id=?', ['cancelled', req.params.id]);
  removeSourceEntry(bill.org_id, 'bill', bill.id);
  removeStockMovements(bill.org_id, 'bill', bill.id);
  run(`INSERT INTO audit_log
       (user_id,org_id,action,table_name,record_id,old_data,new_data,ip_address)
       VALUES (?,?,?,?,?,?,?,?)`,
    [req.user.id, bill.org_id, 'DELETE', 'bills', req.params.id, JSON.stringify(bill),
     JSON.stringify({ reason }), req.ip]);
  res.json({ success: true });
});

// Create a linked delivery challan or invoice with optional partial quantities.
// The older /convert route below is intentionally retained for compatibility.
router.post('/:id/derive', (req, res) => {
  try {
    const sourceBill = get('SELECT * FROM bills WHERE id=? AND deleted=0', [req.params.id]);
    if (!sourceBill) return res.status(404).json({ error: 'Bill not found' });
    if (!requireOrgAccess(req, res, sourceBill.org_id)) return;
    if (!requireBillVisibility(req, res, sourceBill)) return;
    const targetFormat = String(req.body.target_format || req.body.format || '').toUpperCase();
    const allowed = targetFormat === 'DC'
      ? ['QUOT', 'SALE', 'PI']
      : targetFormat === 'SALE' ? ['QUOT', 'DC', 'PI'] : [];
    if (!allowed.includes(sourceBill.format)) {
      return res.status(400).json({ error: `${sourceBill.format} cannot be used to create ${targetFormat || 'this document'}` });
    }
    if (!['DC', 'SALE'].includes(targetFormat)) return res.status(400).json({ error: 'target_format must be DC or SALE' });
    if (isPeriodLocked(sourceBill.org_id, req.body.bill_date || sourceBill.bill_date)) {
      return res.status(423).json({ error: `Financial year ${sourceBill.fy} is locked` });
    }
    const items = deriveBillItems(sourceBill, targetFormat, req.body.items);
    const bill = insertDerivedBill({ req, sourceBill, targetFormat, items });
    res.json({ success: true, id: bill.id, bill, linked_documents: linkedBills(sourceBill.org_id, sourceBill.id) });
  } catch (error) {
    const duplicate = /UNIQUE constraint/i.test(error.message);
    res.status(duplicate ? 409 : 400).json({ error: error.message });
  }
});

// Convert quotation/DC to sale bill
router.post('/:id/convert', (req, res) => {
  const sourceBill = get('SELECT * FROM bills WHERE id=? AND deleted=0', [req.params.id]);
  if (!sourceBill) return res.status(404).json({ error: 'Bill not found' });
  if (!requireOrgAccess(req, res, sourceBill.org_id)) return;
  if (!requireBillVisibility(req, res, sourceBill)) return;
  if (!['QUOT','DC','PI'].includes(sourceBill.format)) return res.status(400).json({ error: 'Only QUOT/DC/PI can be converted' });
  if (sourceBill.status === 'converted') return res.status(400).json({ error: 'Already converted' });

  const fy = getCurrentFY();
  const org = get('SELECT * FROM orgs WHERE id=?', [sourceBill.org_id]);
  const billNumber = getNextBillNumber(sourceBill.org_id, 'SALE', fy);

  const result = run(
    `INSERT INTO bills (org_id,format,bill_number,bill_date,fy,party_id,party_snapshot,items_json,
     subtotal,discount,taxable_amount,tax_rate,cgst,sgst,total_tax,grand_total,total_in_words,
     note_header,note_footer,bank_details,payment_mode,status,converted_from,tax_inclusive,
     digital_signature_required,digital_signature_note,digital_signature_status,digital_signature_signed_at,
     digital_signature_signed_by,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [sourceBill.org_id, 'SALE', billNumber, new Date().toISOString().split('T')[0], fy,
     sourceBill.party_id, sourceBill.party_snapshot, sourceBill.items_json,
     sourceBill.subtotal, sourceBill.discount, sourceBill.taxable_amount, sourceBill.tax_rate,
     sourceBill.cgst, sourceBill.sgst, sourceBill.total_tax, sourceBill.grand_total,
     sourceBill.total_in_words, sourceBill.note_header, fixedNoteForFormat(org, 'SALE') || sourceBill.note_footer, sourceBill.bank_details,
     'cash', 'saved', sourceBill.id, sourceBill.tax_inclusive ? 1 : 0,
     sourceBill.digital_signature_required ? 1 : 0, sourceBill.digital_signature_note || '',
     sourceBill.digital_signature_status || (sourceBill.digital_signature_required ? 'pending' : 'not_required'),
     sourceBill.digital_signature_signed_at || null, sourceBill.digital_signature_signed_by || null, req.user.id]
  );

  run('UPDATE bills SET status=?,converted_to=? WHERE id=?', ['converted', result.lastInsertRowid, req.params.id]);

  const newBill = get('SELECT * FROM bills WHERE id=?', [result.lastInsertRowid]);
  addTransactionLink(sourceBill.org_id, sourceBill.id, newBill.id, 'invoice_from', req.user.id);
  parseBillItems(sourceBill).forEach((item, index) => run(`INSERT OR IGNORE INTO transaction_line_allocations
    (org_id,source_type,source_id,source_line_key,target_type,target_id,target_line_key,quantity,created_by)
    VALUES (?,'bill',? ,?,'bill',?,?,?,?)`,
    [sourceBill.org_id, sourceBill.id, billLineKey(item, index), newBill.id, String(index), Number(item.qty || 0), req.user.id]));
  postBill(newBill);
  replaceStockMovements({
    orgId: newBill.org_id, sourceType: 'bill', sourceId: newBill.id, date: newBill.bill_date,
    refNumber: newBill.bill_number, items: JSON.parse(newBill.items_json || '[]'), direction: 'out'
  });
  try { newBill.items = JSON.parse(newBill.items_json || '[]'); } catch(e) { newBill.items = []; }
  newBill.org = org;
  newBill.party = sourceBill.party_id ? get('SELECT * FROM parties WHERE id=?', [sourceBill.party_id]) : null;
  newBill.linked_documents = linkedBills(newBill.org_id, newBill.id);
  res.json({ success: true, id: result.lastInsertRowid, bill: newBill });
});

// Get bill with full details for preview/print
router.get('/:id/full', (req, res) => {
  const bill = get('SELECT * FROM bills WHERE id=? AND deleted=0', [req.params.id]);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  if (!requireOrgAccess(req, res, bill.org_id)) return;
  if (!requireBillVisibility(req, res, bill)) return;
  try { bill.items = JSON.parse(bill.items_json || '[]'); } catch(e) { bill.items = []; }
  bill.org = get('SELECT * FROM orgs WHERE id=?', [bill.org_id]);
  bill.party = bill.party_id ? get('SELECT * FROM parties WHERE id=?', [bill.party_id]) : null;
  const creator = bill.created_by ? get('SELECT name,username FROM users WHERE id=?', [bill.created_by]) : null;
  bill.created_by_name = creator?.name;
  bill.created_by_username = creator?.username;
  try { bill.party_data = JSON.parse(bill.party_snapshot || '{}'); } catch(e) { bill.party_data = {}; }
  try { bill.bank = JSON.parse(bill.bank_details || '{}'); } catch(e) { bill.bank = {}; }
  try { bill.delivery = JSON.parse(bill.delivery_info || '{}'); } catch (_) { bill.delivery = {}; }
  bill.linked_documents = linkedBills(bill.org_id, bill.id);
  res.json({ ...bill, ...billSettlement(bill) });
});

module.exports = router;
