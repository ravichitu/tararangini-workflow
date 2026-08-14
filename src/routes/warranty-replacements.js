const express = require('express');
const router = express.Router();
const { all, get, run, transaction } = require('../db/db');
const { authMiddleware, checkOrgAccess, requireOrgAccess, userPermissions } = require('../middleware/auth');

router.use(authMiddleware);
router.use(checkOrgAccess);

const VALID_STATUS = new Set(['OPEN', 'PENDING_DISPATCH', 'SENT_TO_VENDOR', 'RMA_RECEIVED', 'FOLLOW_UP', 'REPLACEMENT_RECEIVED', 'DELIVERED', 'CLOSED', 'CANCELLED']);

function cleanText(value, limit = 500) {
  return String(value || '').trim().slice(0, limit);
}

function requireWarrantyAccess(req, res) {
  const permissions = userPermissions(req.user);
  if (permissions.jobs_counter || permissions.jobs_operations || permissions.billing || req.user.role === 'owner') return true;
  res.status(403).json({ error: 'Warranty replacement access required' });
  return false;
}

function nextReplacementNumber(orgId, dateValue) {
  const year = new Date(dateValue || Date.now()).getFullYear();
  const prefix = `WR-${year}`;
  const latest = get(
    `SELECT replacement_number FROM warranty_replacements
     WHERE org_id=? AND replacement_number LIKE ?
     ORDER BY id DESC LIMIT 1`,
    [orgId, `${prefix}-%`]
  );
  const last = Number(String(latest?.replacement_number || '').split('-').pop() || 0);
  return `${prefix}-${String(last + 1).padStart(4, '0')}`;
}

function hydrate(row) {
  return {
    ...row,
    quantity: Number(row.quantity || 0),
    customer_mode: row.customer_mode || 'PARTY',
    customer_name: row.customer_name || row.party_name || '',
    customer_phone: row.customer_phone || '',
    customer_email: row.customer_email || '',
    customer_address: row.customer_address || ''
  };
}

function ensureCommonCustomerParties(orgId) {
  const rows = [];
  for (let slot = 1; slot <= 3; slot += 1) {
    let party = get(
      'SELECT * FROM parties WHERE org_id=? AND is_common_ledger=1 AND common_ledger_slot=? AND active=1',
      [orgId, slot]
    );
    if (!party) {
      const result = run(
        `INSERT INTO parties
         (org_id,shared,type,name,registered_name,gst_type,is_common_ledger,common_ledger_slot,active)
         VALUES (?,?,?,?,?,?,?,?,1)`,
        [orgId, 0, 'customer', `Common Customer ${slot}`, `Common Customer ${slot}`,
         'unregistered', 1, slot]
      );
      party = get('SELECT * FROM parties WHERE id=?', [result.lastInsertRowid]);
    }
    rows.push({ id: party.id, slot, label: party.name, is_common_ledger: 1 });
  }
  return rows;
}

function validatePayload(body, existingOrgId = null) {
  const orgId = Number(body.org_id || existingOrgId || 0);
  const partyId = Number(body.party_id || 0);
  const originalSaleBillId = Number(body.original_sale_bill_id || 0) || null;
  const deliveryBillId = Number(body.delivery_bill_id || 0);
  const productItemId = Number(body.product_item_id || 0);
  const serialNumber = cleanText(body.serial_number, 160);
  const quantity = Number(body.quantity || 0);
  const requestDate = cleanText(body.request_date, 20);
  const issueSummary = cleanText(body.issue_summary, 1000);
  const status = cleanText(body.status || 'OPEN', 40).toUpperCase();
  const commonCustomerSlot = Number(body.common_customer_slot || 0);
  const customerMode = commonCustomerSlot ? 'COMMON' : 'PARTY';
  const customerName = cleanText(body.customer_name, 200);
  const customerPhone = cleanText(body.customer_phone, 60);
  const customerEmail = cleanText(body.customer_email, 160);
  const customerAddress = cleanText(body.customer_address, 800);

  if (!orgId) throw new Error('Company is required');
  if (!partyId) throw new Error('Party name is required');
  if (commonCustomerSlot && ![1, 2, 3].includes(commonCustomerSlot)) throw new Error('Common customer ledger must be 1, 2 or 3');
  if (customerMode === 'COMMON' && !customerName) throw new Error('Walk-in customer name is required');
  if (customerMode === 'COMMON' && !customerPhone) throw new Error('Walk-in customer phone number is required');
  if (!deliveryBillId) throw new Error('Delivery order/challan link is required');
  if (!productItemId) throw new Error('Warranty product is required');
  if (!serialNumber) throw new Error('Serial number is required');
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Number of items must be at least 1');
  if (!requestDate) throw new Error('Request date is required');
  if (!issueSummary) throw new Error('Problem/follow-up note is required');
  if (!VALID_STATUS.has(status)) throw new Error('Valid warranty status is required');

  return {
    orgId, partyId, customerMode, commonCustomerSlot: commonCustomerSlot || null, customerName, customerPhone,
    customerEmail, customerAddress, originalSaleBillId, deliveryBillId, productItemId, serialNumber, quantity, requestDate, issueSummary, status,
    serviceCenterId: Number(body.service_center_id || 0) || null,
    vendorReference: cleanText(body.vendor_reference, 200),
    courierVendor: cleanText(body.courier_vendor, 200),
    courierTrackingNumber: cleanText(body.courier_tracking_number, 200),
    sentDate: cleanText(body.sent_date, 20) || null,
    expectedReturnDate: cleanText(body.expected_return_date, 20) || null,
    rmaNumber: cleanText(body.rma_number, 200),
    serviceCenterContact: cleanText(body.service_center_contact, 200),
    serviceCenterAckStatus: cleanText(body.service_center_ack_status, 120),
    followUpDate: cleanText(body.follow_up_date, 20) || null,
    resolutionNotes: cleanText(body.resolution_notes, 1000)
  };
}

function validateLinks(payload) {
  const party = get('SELECT id,name,org_id,is_common_ledger,common_ledger_slot FROM parties WHERE id=? AND org_id=?', [payload.partyId, payload.orgId]);
  if (!party) throw new Error('Selected party does not belong to this company');
  if (payload.customerMode === 'COMMON' &&
      (Number(party.is_common_ledger || 0) !== 1 || Number(party.common_ledger_slot || 0) !== payload.commonCustomerSlot)) {
    throw new Error('Select the matching Common Customer ledger');
  }
  const item = get('SELECT id,name,org_id FROM items WHERE id=? AND org_id=? AND active=1', [payload.productItemId, payload.orgId]);
  if (!item) throw new Error('Selected warranty product does not belong to this company');
  const delivery = get(
    `SELECT id,bill_number,org_id,party_id,format FROM bills
     WHERE id=? AND org_id=? AND deleted=0 AND format='DC'`,
    [payload.deliveryBillId, payload.orgId]
  );
  if (!delivery) throw new Error('Linked delivery order must be an active Delivery Challan');
  const deliveryParty = delivery.party_id ? get('SELECT is_common_ledger FROM parties WHERE id=?', [delivery.party_id]) : null;
  const deliveryMatchesCommon = payload.customerMode === 'COMMON' &&
    (!delivery.party_id || Number(delivery.party_id) === payload.partyId || Number(deliveryParty?.is_common_ledger || 0) === 1);
  if (!deliveryMatchesCommon && Number(delivery.party_id || 0) !== payload.partyId) {
    throw new Error('Linked delivery order must belong to the selected party');
  }
  const originalSale = payload.originalSaleBillId
    ? get(
        `SELECT id,bill_number,org_id,party_id,format FROM bills
         WHERE id=? AND org_id=? AND deleted=0 AND format='SALE'`,
        [payload.originalSaleBillId, payload.orgId]
      )
    : null;
  if (payload.originalSaleBillId && !originalSale) throw new Error('Original sale invoice must be an active Sale invoice');
  const saleParty = originalSale?.party_id ? get('SELECT is_common_ledger FROM parties WHERE id=?', [originalSale.party_id]) : null;
  const saleMatchesCommon = payload.customerMode === 'COMMON' &&
    (!originalSale?.party_id || Number(originalSale.party_id) === payload.partyId || Number(saleParty?.is_common_ledger || 0) === 1);
  if (originalSale && !saleMatchesCommon && Number(originalSale.party_id || 0) !== payload.partyId) {
    throw new Error('Original sale invoice must belong to the selected party');
  }
  const serviceCenter = payload.serviceCenterId
    ? get('SELECT id,name FROM warranty_service_centers WHERE id=? AND org_id=? AND active=1', [payload.serviceCenterId, payload.orgId])
    : null;
  if (payload.serviceCenterId && !serviceCenter) throw new Error('Selected service center does not belong to this company');
  return { party, item, delivery, originalSale, serviceCenter };
}

router.get('/service-centers', (req, res) => {
  if (!requireWarrantyAccess(req, res)) return;
  const orgId = Number(req.query.org_id || 0);
  if (!orgId) return res.status(400).json({ error: 'org_id is required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  res.json(all(
    `SELECT * FROM warranty_service_centers
     WHERE org_id=? AND active=1
       AND (?='' OR name LIKE ? OR category LIKE ? OR brand LIKE ?)
     ORDER BY category,brand,name`,
    [orgId, req.query.search || '', `%${req.query.search || ''}%`, `%${req.query.search || ''}%`, `%${req.query.search || ''}%`]
  ));
});

router.get('/common-customers', (req, res) => {
  if (!requireWarrantyAccess(req, res)) return;
  const orgId = Number(req.query.org_id || 0);
  if (!orgId) return res.status(400).json({ error: 'org_id is required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  res.json(ensureCommonCustomerParties(orgId));
});

router.post('/service-centers', (req, res) => {
  if (!requireWarrantyAccess(req, res)) return;
  const orgId = Number(req.body.org_id || 0);
  if (!orgId) return res.status(400).json({ error: 'Company is required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  const name = cleanText(req.body.name, 200);
  if (!name) return res.status(400).json({ error: 'Service center name is required' });
  try {
    const result = run(
      `INSERT INTO warranty_service_centers
       (org_id,name,category,brand,contact_person,phone,address,courier_instructions)
       VALUES (?,?,?,?,?,?,?,?)`,
      [orgId, name, cleanText(req.body.category, 120), cleanText(req.body.brand, 120),
       cleanText(req.body.contact_person, 160), cleanText(req.body.phone, 60),
       cleanText(req.body.address, 800), cleanText(req.body.courier_instructions, 1000)]
    );
    res.json({ success: true, service_center: get('SELECT * FROM warranty_service_centers WHERE id=?', [result.lastInsertRowid]) });
  } catch (error) {
    res.status(400).json({ error: 'Service center already exists for this category/brand' });
  }
});

router.get('/', (req, res) => {
  if (!requireWarrantyAccess(req, res)) return;
  const orgId = Number(req.query.org_id || 0);
  if (!orgId) return res.status(400).json({ error: 'org_id is required' });
  if (!requireOrgAccess(req, res, orgId)) return;
  const params = [orgId];
  let sql = `SELECT wr.*, COALESCE(NULLIF(wr.customer_name,''),p.name) party_name, p.name ledger_name,
      i.item_code product_code, b.bill_number delivery_bill_number,
      sb.bill_number original_sale_bill_number,
      sc.name service_center_name,
      u.name created_by_name
    FROM warranty_replacements wr
    JOIN parties p ON p.id=wr.party_id
    JOIN items i ON i.id=wr.product_item_id
    JOIN bills b ON b.id=wr.delivery_bill_id
    LEFT JOIN bills sb ON sb.id=wr.original_sale_bill_id
    LEFT JOIN warranty_service_centers sc ON sc.id=wr.service_center_id
    LEFT JOIN users u ON u.id=wr.created_by
    WHERE wr.org_id=?`;
  if (req.query.status) {
    const status = cleanText(req.query.status, 40).toUpperCase();
    if (status === 'FOLLOW_UP_DUE') {
      sql += ` AND wr.follow_up_date<=? AND wr.status NOT IN ('CLOSED','CANCELLED','DELIVERED')`;
      params.push(new Date().toISOString().slice(0, 10));
    } else {
      sql += ' AND wr.status=?';
      params.push(status);
    }
  }
  if (req.query.search) {
    sql += ` AND (wr.replacement_number LIKE ? OR COALESCE(NULLIF(wr.customer_name,''),p.name) LIKE ? OR wr.customer_phone LIKE ? OR wr.product_name LIKE ?
      OR wr.serial_number LIKE ? OR b.bill_number LIKE ? OR sb.bill_number LIKE ?
      OR wr.courier_tracking_number LIKE ? OR wr.rma_number LIKE ?)`;
    const search = `%${cleanText(req.query.search, 120)}%`;
    params.push(search, search, search, search, search, search, search, search, search);
  }
  sql += ' ORDER BY CASE WHEN wr.status IN (\'CLOSED\',\'CANCELLED\') THEN 1 ELSE 0 END, wr.follow_up_date IS NULL, wr.follow_up_date, wr.id DESC LIMIT 300';
  res.json(all(sql, params).map(hydrate));
});

router.post('/', (req, res) => {
  if (!requireWarrantyAccess(req, res)) return;
  try {
    const payload = validatePayload(req.body);
    if (!requireOrgAccess(req, res, payload.orgId)) return;
    const links = validateLinks(payload);
    const saved = transaction(() => {
      const number = nextReplacementNumber(payload.orgId, payload.requestDate);
      const closedAt = ['CLOSED', 'CANCELLED', 'DELIVERED'].includes(payload.status) ? new Date().toISOString() : null;
      const result = run(
        `INSERT INTO warranty_replacements
         (org_id,replacement_number,party_id,customer_mode,common_customer_slot,customer_name,customer_phone,
          customer_email,customer_address,delivery_bill_id,product_item_id,product_name,serial_number,
          quantity,request_date,status,issue_summary,vendor_reference,service_center_id,courier_vendor,
          courier_tracking_number,sent_date,expected_return_date,rma_number,service_center_contact,
          service_center_ack_status,follow_up_date,resolution_notes,closed_at,created_by,updated_by,original_sale_bill_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [payload.orgId, number, payload.partyId, payload.customerMode, payload.commonCustomerSlot,
         payload.customerName, payload.customerPhone, payload.customerEmail, payload.customerAddress,
         payload.deliveryBillId, payload.productItemId, links.item.name,
         payload.serialNumber, payload.quantity, payload.requestDate, payload.status, payload.issueSummary,
         payload.vendorReference, payload.serviceCenterId, payload.courierVendor, payload.courierTrackingNumber,
         payload.sentDate, payload.expectedReturnDate, payload.rmaNumber, payload.serviceCenterContact,
         payload.serviceCenterAckStatus, payload.followUpDate, payload.resolutionNotes, closedAt, req.user.id, req.user.id,
         payload.originalSaleBillId]
      );
      run(
        'INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
        [req.user.id, payload.orgId, 'CREATE', 'warranty_replacements', result.lastInsertRowid,
         JSON.stringify({ replacement_number: number, delivery_bill_number: links.delivery.bill_number,
           original_sale_bill_number: links.originalSale?.bill_number || null }),
         req.ip]
      );
      return get('SELECT * FROM warranty_replacements WHERE id=?', [result.lastInsertRowid]);
    });
    res.json({ success: true, replacement: hydrate(saved) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put('/:id', (req, res) => {
  if (!requireWarrantyAccess(req, res)) return;
  const existing = get('SELECT * FROM warranty_replacements WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Warranty replacement not found' });
  if (!requireOrgAccess(req, res, existing.org_id)) return;
  try {
    const payload = validatePayload(req.body, existing.org_id);
    if (payload.orgId !== Number(existing.org_id)) throw new Error('Company cannot be changed for this replacement');
    const links = validateLinks(payload);
    const closedAt = ['CLOSED', 'CANCELLED', 'DELIVERED'].includes(payload.status)
      ? (existing.closed_at || new Date().toISOString())
      : null;
    run(
      `UPDATE warranty_replacements SET party_id=?,customer_mode=?,common_customer_slot=?,customer_name=?,customer_phone=?,
       customer_email=?,customer_address=?,delivery_bill_id=?,product_item_id=?,product_name=?,
       serial_number=?,quantity=?,request_date=?,status=?,issue_summary=?,vendor_reference=?,
       service_center_id=?,courier_vendor=?,courier_tracking_number=?,sent_date=?,expected_return_date=?,
       rma_number=?,service_center_contact=?,service_center_ack_status=?,
       follow_up_date=?,resolution_notes=?,closed_at=?,updated_by=?,original_sale_bill_id=?,updated_at=datetime('now') WHERE id=?`,
      [payload.partyId, payload.customerMode, payload.commonCustomerSlot, payload.customerName, payload.customerPhone,
       payload.customerEmail, payload.customerAddress, payload.deliveryBillId, payload.productItemId, links.item.name, payload.serialNumber,
       payload.quantity, payload.requestDate, payload.status, payload.issueSummary, payload.vendorReference,
       payload.serviceCenterId, payload.courierVendor, payload.courierTrackingNumber, payload.sentDate,
       payload.expectedReturnDate, payload.rmaNumber, payload.serviceCenterContact, payload.serviceCenterAckStatus,
       payload.followUpDate, payload.resolutionNotes, closedAt, req.user.id, payload.originalSaleBillId, req.params.id]
    );
    run(
      'INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,old_data,new_data,ip_address) VALUES (?,?,?,?,?,?,?,?)',
      [req.user.id, existing.org_id, 'UPDATE', 'warranty_replacements', existing.id,
       JSON.stringify({ status: existing.status, follow_up_date: existing.follow_up_date }),
       JSON.stringify({ status: payload.status, follow_up_date: payload.followUpDate }),
       req.ip]
    );
    res.json({ success: true, replacement: hydrate(get('SELECT * FROM warranty_replacements WHERE id=?', [req.params.id])) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
