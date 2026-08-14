const express = require('express');
const router = express.Router();
const { get, run, all } = require('../db/db');
const { authMiddleware, checkOrgAccess, requirePermission, requireOrgAccess } = require('../middleware/auth');

function titleCaseWords(value) {
  return String(value || '').trim().replace(/\S+/g, word => word.charAt(0).toUpperCase() + word.slice(1));
}

function normalizedHsn(value) {
  return String(value || '').trim().replace(/\s+/g, '');
}

function requireHsnForRegularOrg(orgId, hsnCode) {
  const org = get('SELECT gst_type FROM orgs WHERE id=?', [orgId]);
  if (org?.gst_type !== 'regular') return;
  const hsn = normalizedHsn(hsnCode);
  if (!/^\d{4}(?:\d{2})?(?:\d{2})?$/.test(hsn)) {
    throw new Error('HSN/SAC code is required for items in a regular GST company. Enter a 4, 6, or 8 digit code.');
  }
}

router.use(authMiddleware);
router.use(checkOrgAccess);
router.use(requirePermission('inventory'));

router.get('/categories', (req, res) => {
  const { org_id } = req.query;
  const sql = org_id
    ? 'SELECT * FROM item_categories WHERE org_id=? ORDER BY name'
    : 'SELECT * FROM item_categories ORDER BY org_id, name';
  res.json(all(sql, org_id ? [org_id] : []));
});

router.post('/categories', (req, res) => {
  const { org_id, name, hsn_code } = req.body;
  const normalizedName = titleCaseWords(name);
  if (!org_id || !normalizedName) return res.status(400).json({ error: 'org_id and name required' });
  const result = run('INSERT INTO item_categories (org_id,name,hsn_code) VALUES (?,?,?)', [org_id, normalizedName, hsn_code]);
  res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/categories/:id', (req, res) => {
  const { name, hsn_code } = req.body;
  run('UPDATE item_categories SET name=?,hsn_code=? WHERE id=?', [titleCaseWords(name), hsn_code, req.params.id]);
  res.json({ success: true });
});

router.get('/', (req, res) => {
  const { org_id, category_id, search } = req.query;
  let sql = `SELECT i.*, ic.name as category_name FROM items i
    LEFT JOIN item_categories ic ON i.category_id=ic.id WHERE i.active=1`;
  const params = [];
  if (org_id) { sql += ' AND i.org_id=?'; params.push(org_id); }
  if (category_id) { sql += ' AND i.category_id=?'; params.push(category_id); }
  if (search) {
    sql += ' AND (i.name LIKE ? OR i.hsn_code LIKE ? OR i.item_code LIKE ? OR i.model_number LIKE ? OR i.barcode LIKE ?)';
    const s = `%${search}%`; params.push(s, s, s, s, s);
  }
  const paged = req.query.page !== undefined || req.query.limit !== undefined || req.query.offset !== undefined;
  const requestedLimit = Number(req.query.limit || 100);
  const limit = Math.max(1, Math.min(500, Number.isFinite(requestedLimit) ? requestedLimit : 100));
  const requestedOffset = Number(req.query.offset || 0);
  const offset = Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : 0);
  if (paged) {
    const countSql = sql.replace('SELECT i.*, ic.name as category_name', 'SELECT COUNT(*) count');
    const total = get(countSql, params)?.count || 0;
    res.set('X-Total-Count', String(total));
    res.set('X-Page-Limit', String(limit));
    res.set('X-Page-Offset', String(offset));
  }
  sql += ` ORDER BY i.name${paged ? ' LIMIT ? OFFSET ?' : ''}`;
  if (paged) params.push(limit, offset);
  res.json(all(sql, params));
});

router.get('/:id', (req, res) => {
  const item = get(`SELECT i.*, ic.name as category_name FROM items i
    LEFT JOIN item_categories ic ON i.category_id=ic.id WHERE i.id=?`, [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (!requireOrgAccess(req, res, item.org_id)) return;
  res.json(item);
});

router.post('/', (req, res) => {
  const { org_id, category_id, name, hsn_code, unit, gst_rate, last_sale_price, last_purchase_price,
    description, item_code, model_number, mrp, barcode, opening_stock, reorder_level } = req.body;
  const normalizedName = titleCaseWords(name);
  const normalizedHsnCode = normalizedHsn(hsn_code);
  if (!org_id || !normalizedName) return res.status(400).json({ error: 'org_id and name required' });
  try { requireHsnForRegularOrg(org_id, normalizedHsnCode); } catch (error) { return res.status(400).json({ error: error.message }); }
  const next = Number(get('SELECT COUNT(*) count FROM items WHERE org_id=?', [org_id])?.count || 0) + 1;
  const org = get('SELECT display_name FROM orgs WHERE id=?', [org_id]);
  const orgCode = String(org?.display_name || 'ORG').replace(/[^A-Z0-9]/gi, '').substring(0, 3).toUpperCase();
  const generatedCode = item_code || `${orgCode}-ITEM-${String(next).padStart(5, '0')}`;
  const generatedBarcode = barcode || `${String(org_id).padStart(2, '0')}${String(Date.now()).slice(-10)}${String(next).padStart(3, '0')}`;
  const result = run(
    `INSERT INTO items
     (org_id,category_id,name,hsn_code,unit,gst_rate,last_sale_price,last_purchase_price,description,
      item_code,model_number,mrp,barcode,opening_stock,reorder_level)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [org_id, category_id || null, normalizedName, normalizedHsnCode, unit || 'NOS', gst_rate || 18,
     last_sale_price || 0, last_purchase_price || 0, description || '', generatedCode,
     model_number || '', mrp || last_sale_price || 0, generatedBarcode, opening_stock || 0, reorder_level || 0]
  );
  res.json({ success: true, id: result.lastInsertRowid, item_code: generatedCode, barcode: generatedBarcode });
});

router.put('/:id', (req, res) => {
  const existing = get('SELECT org_id FROM items WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!requireOrgAccess(req, res, existing.org_id)) return;
  const { category_id, name, hsn_code, unit, gst_rate, last_sale_price, last_purchase_price,
    description, item_code, model_number, mrp, barcode, opening_stock, reorder_level } = req.body;
  const normalizedName = titleCaseWords(name);
  const normalizedHsnCode = normalizedHsn(hsn_code);
  try { requireHsnForRegularOrg(existing.org_id, normalizedHsnCode); } catch (error) { return res.status(400).json({ error: error.message }); }
  run(`UPDATE items SET category_id=?,name=?,hsn_code=?,unit=?,gst_rate=?,last_sale_price=?,
       last_purchase_price=?,description=?,item_code=?,model_number=?,mrp=?,barcode=?,opening_stock=?,reorder_level=? WHERE id=?`,
    [category_id, normalizedName, normalizedHsnCode, unit, gst_rate, last_sale_price, last_purchase_price, description,
     item_code, model_number, mrp, barcode, opening_stock, reorder_level, req.params.id]);
  res.json({ success: true });
});

router.patch('/:id/hsn', (req, res) => {
  const existing = get('SELECT id,org_id FROM items WHERE id=? AND active=1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Item not found' });
  if (!requireOrgAccess(req, res, existing.org_id)) return;
  const hsnCode = normalizedHsn(req.body.hsn_code);
  try { requireHsnForRegularOrg(existing.org_id, hsnCode); } catch (error) { return res.status(400).json({ error: error.message }); }
  run('UPDATE items SET hsn_code=? WHERE id=? AND org_id=?', [hsnCode, existing.id, existing.org_id]);
  res.json({ success: true, hsn_code: hsnCode });
});

router.get('/next-code/:orgId', (req, res) => {
  const org = get('SELECT display_name FROM orgs WHERE id=?', [req.params.orgId]);
  const next = Number(get('SELECT COUNT(*) count FROM items WHERE org_id=?', [req.params.orgId])?.count || 0) + 1;
  const orgCode = String(org?.display_name || 'ORG').replace(/[^A-Z0-9]/gi, '').substring(0, 3).toUpperCase();
  res.json({
    item_code: `${orgCode}-ITEM-${String(next).padStart(5, '0')}`,
    barcode: `${String(req.params.orgId).padStart(2, '0')}${String(Date.now()).slice(-10)}${String(next).padStart(3, '0')}`
  });
});

router.delete('/:id', (req, res) => {
  const existing = get('SELECT id, org_id, active FROM items WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!requireOrgAccess(req, res, existing.org_id)) return;
  // Scope the mutation by both item and organization so a client can never
  // accidentally hide another organization's master data.
  const result = run('UPDATE items SET active=0 WHERE id=? AND org_id=? AND active=1', [req.params.id, existing.org_id]);
  if (!result.changes) return res.status(409).json({ error: 'Item is already deleted or unavailable' });
  res.json({ success: true });
});

// Update last sale price after bill save
router.post('/:id/update-price', (req, res) => {
  const existing = get('SELECT org_id FROM items WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!requireOrgAccess(req, res, existing.org_id)) return;
  const { last_sale_price } = req.body;
  run('UPDATE items SET last_sale_price=? WHERE id=?', [last_sale_price, req.params.id]);
  res.json({ success: true });
});

module.exports = router;
