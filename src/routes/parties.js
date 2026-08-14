const express = require('express');
const router = express.Router();
const { get, run, all } = require('../db/db');
const { authMiddleware, checkOrgAccess, requirePermission, requireOrgAccess } = require('../middleware/auth');
const https = require('https');
const { postOpeningBalance } = require('../accounting/accounting');

function titleCaseWords(value) {
  return String(value || '').trim().replace(/\S+/g, word => word.charAt(0).toUpperCase() + word.slice(1));
}

const GST_STATE_CODES = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh (Old)',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
  '99': 'Centre Jurisdiction'
};

const GST_CODEPOINTS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function validGstin(value) {
  const gstin = String(value || '').trim().toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(gstin)) return false;
  let factor = 1;
  let sum = 0;
  for (let index = 0; index < 14; index += 1) {
    const product = factor * GST_CODEPOINTS.indexOf(gstin[index]);
    factor = factor === 2 ? 1 : 2;
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GST_CODEPOINTS[(36 - (sum % 36)) % 36] === gstin[14];
}

function gstStateFromGstin(gstin) {
  return GST_STATE_CODES[String(gstin || '').slice(0, 2)] || '';
}

function gstFallback(gstin, message) {
  return {
    success: true,
    partial: true,
    source: 'gstin',
    gstin,
    state: gstStateFromGstin(gstin),
    gst_type: 'regular',
    status: 'Unverified',
    message
  };
}

function fetchGstinCheck(gstin) {
  const apiKey = String(process.env.GSTIN_CHECK_API_KEY || process.env.TARANGINI_GSTIN_CHECK_API_KEY || '').trim();
  if (!apiKey) {
    return Promise.resolve(gstFallback(gstin, 'GSTIN state was detected. Add GSTIN_CHECK_API_KEY for online legal-name lookup.'));
  }

  const url = new URL(`https://sheet.gstincheck.co.in/check/${encodeURIComponent(apiKey)}/${encodeURIComponent(gstin)}`);
  return new Promise(resolve => {
    const request = https.get(url, { timeout: 6000 }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.flag && parsed.data) {
            const address = parsed.data?.pradr?.adr || '';
            const state = parsed.data?.pradr?.addr?.stcd || gstStateFromGstin(gstin);
            resolve({
              success: true,
              partial: false,
              source: 'gstincheck',
              gstin,
              name: parsed.data?.tradeNam || parsed.data?.lgnm || '',
              registered_name: parsed.data?.lgnm || parsed.data?.tradeNam || '',
              address,
              state,
              gst_type: String(parsed.data?.ctb || '').toLowerCase().includes('composition') ? 'composition' : 'regular',
              status: parsed.data?.sts || 'Active'
            });
            return;
          }
          resolve(gstFallback(gstin, parsed.error || parsed.message || 'Online GST lookup did not return party details.'));
        } catch (_) {
          resolve(gstFallback(gstin, 'Online GST lookup returned an unreadable response.'));
        }
      });
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(gstFallback(gstin, 'Online GST lookup timed out. State was detected from GSTIN.'));
    });
    request.on('error', () => {
      resolve(gstFallback(gstin, 'Online GST lookup is unavailable. State was detected from GSTIN.'));
    });
  });
}

router.use(authMiddleware);
router.use(checkOrgAccess);
router.use(requirePermission('billing'));

function cleanText(value, limit = 500) {
  return String(value || '').trim().slice(0, limit);
}

function addressPayload(body, party) {
  const label = cleanText(body.label || 'Main Address', 120);
  const address = cleanText(body.address, 800);
  if (!label) throw new Error('Address label is required');
  if (!address) throw new Error('Address is required');
  return {
    label,
    address_type: cleanText(body.address_type || 'billing_delivery', 40),
    contact_person: cleanText(body.contact_person, 120),
    phone: cleanText(body.phone || party?.phone, 40),
    email: cleanText(body.email || party?.email, 120),
    address,
    city: cleanText(body.city || party?.city, 120),
    district: cleanText(body.district, 120),
    state: cleanText(body.state || party?.state || 'Andhra Pradesh', 120),
    pincode: cleanText(body.pincode || party?.pincode, 20),
    gstin: cleanText(body.gstin || party?.gstin, 20).toUpperCase(),
    is_default_billing: body.is_default_billing ? 1 : 0,
    is_default_delivery: body.is_default_delivery ? 1 : 0
  };
}

function ensureDefaultPartyAddress(party) {
  if (!party?.id || !party.address) return null;
  const existing = get('SELECT * FROM party_addresses WHERE party_id=? AND active=1 ORDER BY id LIMIT 1', [party.id]);
  if (existing) return existing;
  const result = run(
    `INSERT INTO party_addresses
     (party_id,org_id,label,address_type,contact_person,phone,email,address,city,state,pincode,gstin,is_default_billing,is_default_delivery)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [party.id, party.org_id, 'Main Address', 'billing_delivery', party.registered_name || party.name,
     party.phone || null, party.email || null, party.address || '', party.city || '', party.state || 'Andhra Pradesh',
     party.pincode || '', party.gstin || '', 1, 1]
  );
  return get('SELECT * FROM party_addresses WHERE id=?', [result.lastInsertRowid]);
}

function syncSharedPartyLinks(partyId, shared) {
  if (!shared) {
    run('DELETE FROM party_org_links WHERE party_id=?', [partyId]);
    return;
  }
  all('SELECT id FROM orgs WHERE active=1').forEach(org => {
    run('INSERT OR IGNORE INTO party_org_links (party_id,org_id) VALUES (?,?)', [partyId, org.id]);
  });
}

router.get('/', (req, res) => {
  const { org_id, type, search } = req.query;
  let sql = `SELECT p.*, GROUP_CONCAT(pol.org_id) as linked_orgs FROM parties p
    LEFT JOIN party_org_links pol ON p.id=pol.party_id WHERE p.active=1`;
  const params = [];
  if (req.query.include_common !== '1') sql += ' AND COALESCE(p.is_common_ledger,0)=0';
  if (org_id) { sql += ` AND (p.org_id=? OR p.shared=1 OR pol.org_id=?)`; params.push(org_id, org_id); }
  if (type && type !== 'all') { sql += ` AND p.type IN ('${type}','both')`; }
  if (search) { sql += ` AND (p.name LIKE ? OR p.phone LIKE ? OR p.gstin LIKE ?)`; const s = `%${search}%`; params.push(s, s, s); }
  const paged = req.query.page !== undefined || req.query.limit !== undefined || req.query.offset !== undefined;
  const requestedLimit = Number(req.query.limit || 100);
  const limit = Math.max(1, Math.min(500, Number.isFinite(requestedLimit) ? requestedLimit : 100));
  const requestedOffset = Number(req.query.offset || 0);
  const offset = Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : 0);
  if (paged) {
    const countSql = sql.replace('SELECT p.*, GROUP_CONCAT(pol.org_id) as linked_orgs', 'SELECT COUNT(DISTINCT p.id) count')
      .replace(' GROUP BY p.id ORDER BY p.name', '');
    const total = get(countSql, params)?.count || 0;
    res.set('X-Total-Count', String(total));
    res.set('X-Page-Limit', String(limit));
    res.set('X-Page-Offset', String(offset));
  }
  sql += ` GROUP BY p.id ORDER BY p.name${paged ? ' LIMIT ? OFFSET ?' : ''}`;
  if (paged) params.push(limit, offset);
  const parties = all(sql, params);
  parties.forEach(ensureDefaultPartyAddress);
  res.json(parties.map(party => ({
    ...party,
    address_count: get('SELECT COUNT(*) count FROM party_addresses WHERE party_id=? AND active=1', [party.id])?.count || 0
  })));
});

// GST fetch. Online legal-name lookup needs a GSTIN_CHECK_API_KEY/TARANGINI_GSTIN_CHECK_API_KEY.
// Without a key or internet, return a safe partial result so the form can still fill state/type.
router.get('/gst-fetch/:gstin', async (req, res) => {
  const gstin = String(req.params.gstin || '').trim().toUpperCase();
  if (!validGstin(gstin)) return res.status(400).json({ error: 'Invalid GSTIN format or checksum' });
  res.json(await fetchGstinCheck(gstin));
});

router.get('/:id', (req, res) => {
  const party = get(`SELECT p.*,GROUP_CONCAT(pol.org_id) linked_orgs
    FROM parties p LEFT JOIN party_org_links pol ON pol.party_id=p.id
    WHERE p.id=? GROUP BY p.id`, [req.params.id]);
  if (!party) return res.status(404).json({ error: 'Not found' });
  const requestedOrgId = Number(req.query.org_id || party.org_id);
  const linkedOrHome = Number(party.org_id) === requestedOrgId ||
    Number(party.shared) === 1 ||
    String(party.linked_orgs || '').split(',').map(Number).includes(requestedOrgId);
  if (!linkedOrHome || !requireOrgAccess(req, res, requestedOrgId)) return;
  res.json(party);
});

router.post('/', (req, res) => {
  const { org_id, type, name, registered_name, phone, email, address, city, state, pincode,
    gstin, gst_type, delivery_addresses, opening_balance, balance_type, shared,
    digital_signature_required } = req.body;
  const normalizedName = titleCaseWords(name);
  if (!normalizedName || !org_id) return res.status(400).json({ error: 'Name and org_id required' });
  const result = run(
    `INSERT INTO parties (org_id,shared,type,name,registered_name,phone,email,address,city,state,pincode,gstin,gst_type,delivery_addresses,digital_signature_required,opening_balance,balance_type)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [org_id, shared ? 1 : 0, type || 'both', normalizedName, titleCaseWords(registered_name || name), phone || null, email || null,
     address || null, city || null, state || 'Andhra Pradesh', pincode || null, gstin || null, gst_type || 'unregistered',
     delivery_addresses ? JSON.stringify(delivery_addresses) : '[]',
     digital_signature_required ? 1 : 0,
     opening_balance || 0, balance_type || 'cr']
  );
  const id = result.lastInsertRowid;
  syncSharedPartyLinks(id, shared);
  postOpeningBalance(get('SELECT * FROM parties WHERE id=?', [id]));
  ensureDefaultPartyAddress(get('SELECT * FROM parties WHERE id=?', [id]));
  res.json({ success: true, id });
});

router.put('/:id', (req, res) => {
  const existing = get('SELECT org_id,digital_signature_required FROM parties WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!requireOrgAccess(req, res, existing.org_id)) return;
  const { type, name, registered_name, phone, email, address, city, state, pincode,
    gstin, gst_type, delivery_addresses, opening_balance, balance_type, shared,
    digital_signature_required } = req.body;
  const normalizedName = titleCaseWords(name);
  run(`UPDATE parties SET type=?,name=?,registered_name=?,phone=?,email=?,address=?,city=?,state=?,pincode=?,
       gstin=?,gst_type=?,delivery_addresses=?,digital_signature_required=?,opening_balance=?,balance_type=?,shared=? WHERE id=?`,
    [type || 'both', normalizedName, titleCaseWords(registered_name || name), phone || null, email || null, address || null,
     city || null, state || 'Andhra Pradesh', pincode || null, gstin || null, gst_type || 'unregistered',
     JSON.stringify(delivery_addresses || []),
     digital_signature_required === undefined ? existing.digital_signature_required : (digital_signature_required ? 1 : 0),
     opening_balance || 0,
     balance_type || 'cr', shared ? 1 : 0, req.params.id]);
  syncSharedPartyLinks(req.params.id, shared);
  postOpeningBalance(get('SELECT * FROM parties WHERE id=?', [req.params.id]));
  ensureDefaultPartyAddress(get('SELECT * FROM parties WHERE id=?', [req.params.id]));
  res.json({ success: true });
});

router.get('/:id/addresses', (req, res) => {
  const party = get('SELECT * FROM parties WHERE id=? AND active=1', [req.params.id]);
  if (!party) return res.status(404).json({ error: 'Party not found' });
  const requestedOrgId = Number(req.query.org_id || party.org_id);
  if (!requireOrgAccess(req, res, requestedOrgId)) return;
  ensureDefaultPartyAddress(party);
  res.json(all(
    `SELECT * FROM party_addresses
     WHERE party_id=? AND active=1
     ORDER BY is_default_billing DESC,is_default_delivery DESC,label`,
    [req.params.id]
  ));
});

router.post('/:id/addresses', (req, res) => {
  const party = get('SELECT * FROM parties WHERE id=? AND active=1', [req.params.id]);
  if (!party) return res.status(404).json({ error: 'Party not found' });
  if (!requireOrgAccess(req, res, party.org_id)) return;
  try {
    const payload = addressPayload(req.body, party);
    if (payload.is_default_billing) run('UPDATE party_addresses SET is_default_billing=0 WHERE party_id=?', [party.id]);
    if (payload.is_default_delivery) run('UPDATE party_addresses SET is_default_delivery=0 WHERE party_id=?', [party.id]);
    const result = run(
      `INSERT INTO party_addresses
       (party_id,org_id,label,address_type,contact_person,phone,email,address,city,district,state,pincode,gstin,is_default_billing,is_default_delivery)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [party.id, party.org_id, payload.label, payload.address_type, payload.contact_person || null, payload.phone || null,
       payload.email || null, payload.address, payload.city || null, payload.district || null, payload.state || null,
       payload.pincode || null, payload.gstin || null, payload.is_default_billing, payload.is_default_delivery]
    );
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put('/:id/addresses/:addressId', (req, res) => {
  const party = get('SELECT * FROM parties WHERE id=? AND active=1', [req.params.id]);
  const existing = get('SELECT * FROM party_addresses WHERE id=? AND party_id=? AND active=1', [req.params.addressId, req.params.id]);
  if (!party || !existing) return res.status(404).json({ error: 'Address not found' });
  if (!requireOrgAccess(req, res, party.org_id)) return;
  try {
    const payload = addressPayload(req.body, party);
    if (payload.is_default_billing) run('UPDATE party_addresses SET is_default_billing=0 WHERE party_id=?', [party.id]);
    if (payload.is_default_delivery) run('UPDATE party_addresses SET is_default_delivery=0 WHERE party_id=?', [party.id]);
    run(
      `UPDATE party_addresses SET label=?,address_type=?,contact_person=?,phone=?,email=?,address=?,city=?,
       district=?,state=?,pincode=?,gstin=?,is_default_billing=?,is_default_delivery=?,updated_at=datetime('now')
       WHERE id=? AND party_id=?`,
      [payload.label, payload.address_type, payload.contact_person || null, payload.phone || null, payload.email || null,
       payload.address, payload.city || null, payload.district || null, payload.state || null, payload.pincode || null,
       payload.gstin || null, payload.is_default_billing, payload.is_default_delivery, req.params.addressId, party.id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/:id/addresses/:addressId', (req, res) => {
  const party = get('SELECT * FROM parties WHERE id=? AND active=1', [req.params.id]);
  const existing = get('SELECT * FROM party_addresses WHERE id=? AND party_id=? AND active=1', [req.params.addressId, req.params.id]);
  if (!party || !existing) return res.status(404).json({ error: 'Address not found' });
  if (!requireOrgAccess(req, res, party.org_id)) return;
  run('UPDATE party_addresses SET active=0,updated_at=datetime(\'now\') WHERE id=? AND party_id=?', [req.params.addressId, party.id]);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  const existing = get('SELECT org_id FROM parties WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!requireOrgAccess(req, res, existing.org_id)) return;
  run('UPDATE parties SET active=0 WHERE id=?', [req.params.id]);
  res.json({ success: true });
});

// Link party to another org
router.post('/:id/link-org', (req, res) => {
  const existing = get('SELECT org_id FROM parties WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!requireOrgAccess(req, res, existing.org_id) || !requireOrgAccess(req, res, req.body.org_id)) return;
  const { org_id } = req.body;
  try { run('INSERT OR IGNORE INTO party_org_links (party_id,org_id) VALUES (?,?)', [req.params.id, org_id]); }
  catch(e) {}
  res.json({ success: true });
});

module.exports = router;
