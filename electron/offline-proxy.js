const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const QRCode = require('qrcode');
const APP_VERSION = require('../package.json').version;
const { safeDeviceCode } = require('./device-identity');
const { OFFLINE_DRAFT_FORMATS, isOfflineDraftFormat, offlineDraftError } = require('../src/business/offline-policy');
const OWN_BILL_ONLY_ROLES = new Set(['operator', 'senior_operator', 'engineer']);
// Offline work can only advance an already-assigned production job. Financial,
// delivery, reassignment, and reopen actions remain centralized for safety.
const SAFE_OFFLINE_JOB_TRANSITIONS = {
  ACCEPTED: ['IN_PROGRESS'],
  IN_PROGRESS: ['WAITING_FOR_MATERIAL', 'QUALITY_CHECK'],
  WAITING_FOR_MATERIAL: ['IN_PROGRESS'],
  QUALITY_CHECK: ['IN_PROGRESS', 'COMPLETED'],
  COMPLETED: ['READY_FOR_DELIVERY']
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, value);
  fs.renameSync(temp, file);
}

function storeChecksum(serialized) {
  return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

function requestRemote(baseUrl, method, requestPath, headers = {}, body = null, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, baseUrl);
    const client = url.protocol === 'https:' ? https : http;
    const outgoingHeaders = { ...headers, host: url.host, 'accept-encoding': 'identity' };
    // The browser is talking only to this trusted local bridge. Forwarding its
    // localhost Origin to the main system makes a same-client request look like
    // a cross-origin browser request and causes the CSRF guard to reject it.
    delete outgoingHeaders.origin;
    delete outgoingHeaders.referer;
    delete outgoingHeaders['sec-fetch-site'];
    delete outgoingHeaders['sec-fetch-mode'];
    delete outgoingHeaders['sec-fetch-dest'];
    delete outgoingHeaders['content-length'];
    if (body) outgoingHeaders['content-length'] = Buffer.byteLength(body);
    const request = client.request(url, { method, headers: outgoingHeaders }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    request.setTimeout(timeout, () => request.destroy(new Error('Main system connection timed out')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function bodyFromRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function financialYear(dateValue) {
  const date = new Date(`${dateValue || new Date().toISOString().slice(0, 10)}T00:00:00`);
  const year = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return `${year}-${String(year + 1).slice(-2)}`;
}

function passwordVerifier(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function sanitizeLocalOrderPart(value, fallback = 'ORDER') {
  return String(value || fallback).replace(/[^A-Z0-9]/gi, '').slice(0, 12).toUpperCase() || fallback;
}

class OfflineProxy {
  constructor({
    appPath, userData, serverUrl, deviceCode, deviceIdentity = {}, port = 3001, portalLanEnabled = false,
    protectToken, unprotectToken, protectData, unprotectData, discoverServer, onServerUrlChanged
  }) {
    this.publicDir = path.join(appPath, 'public');
    this.dataDir = path.join(userData, 'offline-client');
    this.serverUrl = serverUrl;
    this.deviceCode = safeDeviceCode(deviceCode);
    this.deviceIdentity = {
      deviceId: deviceIdentity.deviceId || null,
      systemName: deviceIdentity.systemName || os.hostname(),
      displayName: deviceIdentity.displayName || deviceIdentity.systemName || os.hostname(),
      macReferences: Array.isArray(deviceIdentity.macReferences) ? deviceIdentity.macReferences : []
    };
    this.port = port;
    this.portalLanEnabled = Boolean(portalLanEnabled);
    this.queueFile = path.join(this.dataDir, 'queue.json');
    this.cacheFile = path.join(this.dataDir, 'cache.json');
    this.replicaDir = path.join(this.dataDir, 'replicas');
    this.protectData = protectData || (value => value);
    this.unprotectData = unprotectData || (value => value);
    this.storageRecoveryEvents = [];
    this.queue = this.readStore(this.queueFile, { sequence: {}, items: [] });
    this.cache = this.readStore(this.cacheFile, {});
    this.online = false;
    this.lastError = '';
    this.lastSyncAt = null;
    this.syncing = false;
    this.server = null;
    this.eventClients = new Set();
    this.remoteRevision = null;
    this.remoteVersion = null;
    this.localWipedAt = this.cache.device_wipe?.completed_at || null;
    this.protectToken = protectToken || (value => value);
    this.unprotectToken = unprotectToken || (value => value);
    this.discoverServer = discoverServer || null;
    this.onServerUrlChanged = onServerUrlChanged || null;
    this.lastDiscoveryAt = 0;
    this.lastPullAt = 0;
  }

  readStore(file, fallback) {
    const temporary = `${file}.tmp`;
    if (!fs.existsSync(file) && fs.existsSync(temporary)) {
      try {
        fs.renameSync(temporary, file);
        this.storageRecoveryEvents.push({
          store: path.basename(file), action: 'RECOVERED_INTERRUPTED_WRITE', at: new Date().toISOString()
        });
      } catch (_) {}
    }
    try {
      if (!fs.existsSync(file)) return fallback;
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!stored) return fallback;
      if (stored.__protected && typeof stored.data === 'string') {
        const serialized = this.unprotectData(stored.data);
        if (stored.format === 2 && stored.sha256 && storeChecksum(serialized) !== stored.sha256) {
          throw new Error('Protected store integrity check failed');
        }
        return JSON.parse(serialized);
      }
      return stored;
    } catch (error) {
      if (fs.existsSync(file)) {
        const quarantine = `${file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(file, quarantine);
          this.storageRecoveryEvents.push({
            store: path.basename(file), action: 'QUARANTINED_CORRUPT_STORE',
            quarantine_file: path.basename(quarantine), error: error.message, at: new Date().toISOString()
          });
        } catch (_) {}
      }
      return fallback;
    }
  }

  writeStore(file, value) {
    const serialized = JSON.stringify(value);
    writeText(file, JSON.stringify({
      __protected: true,
      format: 2,
      sha256: storeChecksum(serialized),
      data: this.protectData(serialized)
    }));
  }

  start() {
    if (this.server) return Promise.resolve();
    this.server = http.createServer((request, response) => this.handle(request, response));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.portalLanEnabled ? '0.0.0.0' : '127.0.0.1', () => {
        this.monitor = setInterval(() => this.checkAndSync(), 5000);
        this.checkAndSync();
        resolve();
      });
    });
  }

  stop() {
    clearInterval(this.monitor);
    if (this.server) this.server.close();
    this.server = null;
  }

  saveQueue() {
    this.writeStore(this.queueFile, this.queue);
  }

  saveCache() {
    this.writeStore(this.cacheFile, this.cache);
  }

  replicaFile(orgId) {
    return path.join(this.replicaDir, `org-${Number(orgId)}.replica`);
  }

  saveReplicaSnapshot(snapshot) {
    const orgId = Number(snapshot?.org_id || snapshot?.org?.id || 0);
    if (!orgId) throw new Error('Snapshot organization is required');
    this.writeStore(this.replicaFile(orgId), {
      replica_version: 1,
      org_id: orgId,
      schema_version: snapshot.schema_version || null,
      revision: Number(snapshot.revision || 0),
      checksum_sha256: snapshot.checksum_sha256 || null,
      snapshot,
      saved_at: new Date().toISOString()
    });
  }

  readReplicaSnapshot(orgId) {
    const replica = this.readStore(this.replicaFile(orgId), null);
    return replica?.snapshot || null;
  }

  snapshotForOrg(orgId) {
    return this.cache.organization_snapshots?.[String(orgId)] || this.readReplicaSnapshot(orgId);
  }

  replicaSummary() {
    if (!fs.existsSync(this.replicaDir)) return [];
    return fs.readdirSync(this.replicaDir)
      .filter(name => /^org-\d+\.replica$/.test(name))
      .map(name => {
        const orgId = Number(name.match(/\d+/)?.[0] || 0);
        const replica = this.readStore(path.join(this.replicaDir, name), null);
        return replica ? {
          org_id: orgId,
          schema_version: replica.schema_version || null,
          revision: Number(replica.revision || 0),
          checksum_sha256: replica.checksum_sha256 || null,
          saved_at: replica.saved_at || null
        } : null;
      }).filter(Boolean);
  }

  getStatus() {
    const counts = { pending: 0, synced: 0, conflict: 0 };
    this.queue.items.forEach(item => { counts[item.status] = (counts[item.status] || 0) + 1; });
    const lanAddress = Object.values(os.networkInterfaces()).flat().find(entry =>
      entry && entry.family === 'IPv4' && !entry.internal)?.address || '';
    return {
      role: 'client',
      device_code: this.deviceCode,
      device_id: this.deviceIdentity.deviceId,
      system_name: this.deviceIdentity.systemName,
      display_name: this.deviceIdentity.displayName,
      mac_references: this.deviceIdentity.macReferences,
      server_url: this.serverUrl,
      portal_lan_enabled: this.portalLanEnabled,
      portal_base_url: this.portalLanEnabled && lanAddress ? `http://${lanAddress}:${this.port}` : '',
      online: this.online,
      syncing: this.syncing,
      last_error: this.lastError,
      last_sync_at: this.lastSyncAt,
      local_wiped_at: this.localWipedAt,
      storage_recovery_events: [...this.storageRecoveryEvents],
      encrypted_replicas: this.replicaSummary(),
      app_version: APP_VERSION,
      server_version: this.remoteVersion,
      version_mismatch: Boolean(this.remoteVersion && this.remoteVersion !== APP_VERSION),
      counts,
      items: [...this.queue.items].reverse().slice(0, 200).map(item => ({
        id: item.id, number: item.number, date: item.body.bill_date || item.created_at,
        format: item.type === 'job-create' ? 'JOB' : item.type === 'job-status' ? 'JOB STATUS' :
          item.type === 'intake-submit' ? 'INTAKE' : item.body.format,
        status: item.status, error: item.error || '', created_at: item.created_at, synced_at: item.synced_at || null
      }))
    };
  }

  broadcast() {
    const payload = `data: ${JSON.stringify({ revision: Date.now(), offline: true })}\n\n`;
    this.eventClients.forEach(client => client.write(payload));
  }

  cachedJson(key, fallback = null) {
    try { return JSON.parse(Buffer.from(this.cache[key]?.body || '', 'base64').toString('utf8')); }
    catch (_) { return fallback; }
  }

  offlineUser(username) {
    return this.cache.offline_users?.[String(username || '').trim().toLowerCase()] || null;
  }

  offlineUserForToken(token) {
    return Object.values(this.cache.offline_users || {}).find(saved => {
      try {
        return JSON.parse(Buffer.from(saved.response, 'base64').toString('utf8')).token === token;
      } catch (_) {
        return false;
      }
    }) || null;
  }

  sendOfflineLogin(response, username, password) {
    const saved = this.offlineUser(username);
    if (!saved || passwordVerifier(password || '', saved.salt) !== saved.verifier) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: 'Client is offline or cannot reach the Main System. Login once online on this client, or check Main System IP/firewall and retry.'
      }));
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-tarangini-offline-login': '1'
    });
    response.end(Buffer.from(saved.response, 'base64'));
  }

  sendOfflineUnlock(response, request, password) {
    const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const saved = this.offlineUserForToken(token);
    if (!saved || passwordVerifier(password || '', saved.salt) !== saved.verifier) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Incorrect password' }));
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-tarangini-offline-unlock': '1'
    });
    response.end(JSON.stringify({ success: true, offline: true }));
  }

  orgFor(orgId) {
    return (this.cachedJson('/api/orgs', []) || []).find(org => Number(org.id) === Number(orgId));
  }

  cachedBill(id) {
    for (const [key, entry] of Object.entries(this.cache)) {
      if (!key.startsWith('/api/bills?') || !entry?.body) continue;
      try {
        const rows = JSON.parse(Buffer.from(entry.body, 'base64').toString('utf8'));
        const bill = rows.find(row => Number(row.id) === Number(id));
        if (bill) return bill;
      } catch (_) {}
    }
    return null;
  }

  cachedBillRows() {
    const rows = new Map();
    for (const [key, entry] of Object.entries(this.cache)) {
      if (!key.startsWith('/api/bills?') || !entry?.body) continue;
      try {
        JSON.parse(Buffer.from(entry.body, 'base64').toString('utf8'))
          .forEach(row => rows.set(Number(row.id), row));
      } catch (_) {}
    }
    return [...rows.values()];
  }

  userFromRequest(request) {
    const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const saved = this.offlineUserIdentity(token);
    if (saved) return saved;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      return { id: payload.userId, role: payload.role };
    } catch (_) { return null; }
  }

  offlineBillList(requestUrl, request) {
    const query = requestUrl.searchParams;
    const user = this.userFromRequest(request);
    const queued = this.queue.items
      .filter(item => !item.type && !item.operation && ['pending', 'conflict'].includes(item.status))
      .map(item => this.projectOfflineBill(item));
    const combined = [...queued, ...this.cachedBillRows().filter(row =>
      !queued.some(local => String(local.offline_id) === String(row.offline_id))
    )];
    let rows = combined.filter(row => {
      if (query.get('org_id') && Number(row.org_id) !== Number(query.get('org_id'))) return false;
      if (query.get('format') && row.format !== query.get('format')) return false;
      if (query.get('fy') && row.fy !== query.get('fy')) return false;
      if (query.get('party_id') && Number(row.party_id) !== Number(query.get('party_id'))) return false;
      if (OWN_BILL_ONLY_ROLES.has(String(user?.role || '').toLowerCase()) &&
          Number(row.created_by) !== Number(user?.id)) return false;
      const search = String(query.get('search') || '').trim().toLowerCase();
      if (search && ![
        row.bill_number, row.description, row.party_name, row.party_snapshot
      ].some(value => String(value || '').toLowerCase().includes(search))) return false;
      return true;
    });
    rows.sort((a, b) => String(b.created_at || b.bill_date).localeCompare(String(a.created_at || a.bill_date)));
    const offset = Math.max(0, Number(query.get('offset') || 0));
    const limit = Math.max(1, Math.min(500, Number(query.get('limit') || 500)));
    return rows.slice(offset, offset + limit);
  }

  nextOfflineNumber(body, increment = true) {
    const fy = body.fy || financialYear(body.bill_date);
    const prefix = { SALE: 'SB', PP: 'PP' }[body.format] || body.format;
    const org = this.orgFor(body.org_id);
    const orgCode = String(org?.display_name || 'ORG').replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase() || 'ORG';
    const key = `${body.org_id}:${body.format}:${fy}`;
    const next = Number(this.queue.sequence[key] || 0) + 1;
    if (increment) {
      this.queue.sequence[key] = next;
      this.saveQueue();
    }
    return `${orgCode}-${this.deviceCode}/${prefix}/${fy}/${String(next).padStart(4, '0')}`;
  }

  nextLocalIntakeNumber(body = {}, increment = true) {
    const orgCode = sanitizeLocalOrderPart(body.org_id ? `ORG${body.org_id}` : this.orgFor(body.org_id)?.display_name, 'ORG');
    const key = `${body.org_id || 'unknown'}:intake:${this.deviceCode}`;
    const next = Number(this.queue.sequence[key] || 0) + 1;
    if (increment) {
      this.queue.sequence[key] = next;
      this.saveQueue();
    }
    return `LOCAL-${orgCode}-${this.deviceCode}-${String(next).padStart(4, '0')}`;
  }

  offlineUserIdentity(token) {
    const saved = this.offlineUserForToken(token);
    try {
      const user = JSON.parse(Buffer.from(saved?.response || '', 'base64').toString('utf8')).user;
      if (user) return user;
    } catch (_) {}
    // A cached session may have been refreshed before a device restart. The Main
    // System still authorizes the replay; this only preserves local role checks.
    try {
      const payload = JSON.parse(Buffer.from(String(token || '').split('.')[1], 'base64url').toString('utf8'));
      return { id: payload.userId, role: payload.role };
    } catch (_) { return null; }
  }

  cachedJob(centralId) {
    return this.cachedJson(`/api/jobs/${Number(centralId)}`, null);
  }

  saveCachedJob(job) {
    const id = Number(job?.id);
    if (!id) return;
    const key = `/api/jobs/${id}`;
    const previous = this.cache[key] || {};
    this.cache[key] = {
      ...previous,
      body: Buffer.from(JSON.stringify(job)).toString('base64'),
      content_type: 'application/json',
      cached_at: new Date().toISOString()
    };
    this.saveCache();
  }

  cachedRemoteToken() {
    const users = Object.values(this.cache.offline_users || {})
      .sort((a, b) => String(b.cached_at || '').localeCompare(String(a.cached_at || '')));
    for (const saved of users) {
      try {
        const response = JSON.parse(Buffer.from(saved.response || '', 'base64').toString('utf8'));
        if (response.token) return response.token;
      } catch (_) {}
    }
    return '';
  }

  projectOfflineBill(item) {
    if (item.optimistic) return item.optimistic;
    const body = item.body || {};
    const org = this.orgFor(body.org_id) || {};
    const parties = this.cachedJson(`/api/parties?org_id=${body.org_id}`, []) || [];
    const party = parties.find(row => Number(row.id) === Number(body.party_id)) || null;
    const items = (body.items || []).map((item, index) => {
      const qty = Number(item.qty || 0);
      const rate = Number(item.rate || 0);
      return { ...item, sno: index + 1, qty, rate, amount: Number(item.amount || qty * rate) };
    });
    const subtotal = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const grossBeforeTax = subtotal - Number(body.discount || 0);
    const taxRate = org.gst_type === 'composition' || ['QUOT', 'DC'].includes(body.format) ? 0 : 18;
    const totalTax = body.tax_inclusive ? grossBeforeTax * taxRate / (100 + taxRate) : grossBeforeTax * taxRate / 100;
    const taxable = body.tax_inclusive ? grossBeforeTax - totalTax : grossBeforeTax;
    const grandTotal = grossBeforeTax + (body.tax_inclusive ? 0 : totalTax) + Number(body.swipe_charge || 0);
    return {
      id: `offline:${item.id}`, org_id: body.org_id, format: body.format, bill_number: item.number,
      bill_date: body.bill_date, fy: financialYear(body.bill_date), party_id: body.party_id || null,
      payment_mode: body.payment_mode || 'cash', items, items_json: JSON.stringify(items),
      subtotal, discount: Number(body.discount || 0), taxable_amount: taxable, tax_rate: taxRate,
      cgst: totalTax / 2, sgst: totalTax / 2, igst: 0, total_tax: totalTax,
      grand_total: grandTotal, swipe_charge: Number(body.swipe_charge || 0),
      tax_inclusive: body.tax_inclusive ? 1 : 0,
      description: body.description || '', custom_data: JSON.stringify(body.custom_data || {}),
      split_payments: JSON.stringify(body.split_payments || []),
      delivery_address: body.delivery_address || null,
      delivery_info: JSON.stringify(body.delivery_info || {}),
      delivery: body.delivery_info || {},
      party_name: party?.name || 'Cash Customer', party_snapshot: party ? JSON.stringify(party) : null,
      created_by: item.created_by || null, created_by_name: item.created_by_name || '',
      created_by_username: item.created_by_username || '',
      created_at: item.created_at, status: item.status === 'conflict' ? 'sync conflict' : 'pending sync',
      org, party, offline_id: item.id, offline_device: this.deviceCode, offline_pending: true
    };
  }

  createOfflineBill(body, token) {
    if (!isOfflineDraftFormat(body.format)) throw offlineDraftError(body.format);
    const id = crypto.randomUUID();
    const number = this.nextOfflineNumber(body);
    const user = this.offlineUserIdentity(token);
    const item = {
      id, number, status: 'pending', token: this.protectToken(token), body,
      created_by: user?.id || null, created_by_name: user?.name || '',
      created_by_username: user?.username || '',
      created_at: new Date().toISOString(), error: ''
    };
    item.optimistic = this.projectOfflineBill(item);
    this.queue.items.push(item);
    this.saveQueue();
    const bill = item.optimistic;
    return { success: true, id: bill.id, bill, offline_pending: true, sync_status: 'pending' };
  }

  createOfflineJob(body, token) {
    const id = crypto.randomUUID();
    const provisionalToken = `OFF-${this.deviceCode}-${Date.now().toString(36).toUpperCase()}`;
    const parties = this.cachedJson(`/api/parties?org_id=${body.org_id}`, []) || [];
    const suppliedParty = body.offline_party && typeof body.offline_party === 'object'
      ? {
        id: `local:${id}`,
        name: String(body.offline_party.name || '').trim(),
        phone: String(body.offline_party.phone || '').trim(),
        email: String(body.offline_party.email || '').trim(),
        address: String(body.offline_party.address || '').trim(),
        type: 'customer'
      }
      : null;
    const party = parties.find(row => Number(row.id) === Number(body.party_id)) || suppliedParty;
    if (!party) {
      const error = new Error('Select a customer cached on this computer before working offline');
      error.status = 409;
      throw error;
    }
    if (suppliedParty && (!party.name || !party.phone)) {
      const error = new Error('New offline customers require name and phone number');
      error.status = 400;
      throw error;
    }
    const catalog = this.cachedJson(`/api/jobs/catalog?org_id=${body.org_id}`, {
      categories: [], subcategories: [], services: []
    });
    const items = (body.items || []).map((item, index) => {
      const service = catalog.services.find(row => Number(row.id) === Number(item.service_id));
      if (!service) {
        const error = new Error('Open Service Catalog once online before creating offline jobs');
        error.status = 409;
        throw error;
      }
      return {
        id: `offline-item:${id}:${index}`, service_id: service.id,
        category_snapshot: catalog.categories.find(row => Number(row.id) === Number(service.category_id))?.name || '',
        subcategory_snapshot: catalog.subcategories.find(row => Number(row.id) === Number(service.subcategory_id))?.name || null,
        service_snapshot: service.name, description: item.description || service.name,
        specifications: item.specifications || {}, quantity: Number(item.quantity || 1),
        unit: item.unit || service.default_unit || 'NOS'
      };
    });
    const estimateLines = body.estimate_lines || [];
    const subtotalPaise = estimateLines.reduce((sum, line) =>
      sum + Math.round(Number(line.line_total ?? Number(line.quantity || 1) * Number(line.unit_price || 0)) * 100), 0);
    const taxPaise = estimateLines.reduce((sum, line) => {
      const base = Number(line.line_total ?? Number(line.quantity || 1) * Number(line.unit_price || 0));
      return sum + Math.round(base * Number(line.tax_rate || 0));
    }, 0);
    const job = {
      id: `offline:${id}`, org_id: Number(body.org_id), job_token: provisionalToken,
      provisional_token: provisionalToken, priority: body.priority || 'NORMAL',
      promised_delivery_at: body.promised_delivery_at, current_status: 'WAITING',
      customer_commitment: body.customer_commitment || '', version: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      customer: { id: party.id, name: party.name, phone: party.phone, email: party.email, address: party.address },
      assignment: null, items,
      attachments: (body.attachments || []).map((file, index) => ({
        id: `offline-attachment:${id}:${index}`, file_name: file.file_name,
        mime_type: file.mime_type, byte_size: file.byte_size
      })),
      status_events: [{ to_status: 'WAITING', reason: 'Job saved offline', occurred_at: new Date().toISOString() }],
      assignments: [], work_reports: [], additions: [],
      finance: {
        financial_status: 'OPEN', advance_paise: Math.round(
          (body.advance_payments || []).reduce((sum, payment) => sum + Number(payment.amount || 0), 0) * 100
        ),
        estimate: { total_paise: subtotalPaise + taxPaise, lines: estimateLines }
      }
    };
    this.queue.items.push({
      id, type: 'job-create', number: provisionalToken, status: 'pending',
      token: this.protectToken(token), body: { ...body, provisional_token: provisionalToken },
      optimistic: job, created_at: job.created_at, error: ''
    });
    this.saveQueue();
    return {
      success: true, id: job.id, token: provisionalToken, job,
      offline_pending: true, sync_status: 'pending'
    };
  }

  createOfflineJobStatus(centralId, body, token) {
    const job = this.cachedJob(centralId);
    if (!job || !Number(job.id) || !Number(job.org_id)) {
      const error = new Error('Open this assigned job once while online before updating it offline');
      error.status = 409;
      throw error;
    }
    const user = this.offlineUserIdentity(token);
    const assignment = job.assignment || {};
    // The server projects only the accepted assignment in `job.assignment`.
    const isAssignee = Number(assignment.employee_id) === Number(user?.id);
    const isSupervisor = user?.role === 'owner' ||
      (user?.role === 'senior_operator' && Boolean(user?.permissions?.jobs_assign_any));
    if (!isAssignee && !isSupervisor) {
      const error = new Error('Only the accepted assignee may queue this offline work update');
      error.status = 403;
      throw error;
    }
    const target = String(body.status || '').trim().toUpperCase();
    if (!SAFE_OFFLINE_JOB_TRANSITIONS[String(job.current_status || '').toUpperCase()]?.includes(target)) {
      const error = new Error('This job action requires the Main System. Only normal production progress can be queued offline');
      error.status = 409;
      throw error;
    }
    const id = crypto.randomUUID();
    const reason = String(body.reason || '').trim().slice(0, 5000);
    const optimistic = {
      ...job,
      current_status: target,
      version: Number(job.version || 0) + 1,
      updated_at: new Date().toISOString(),
      status_events: [{
        from_status: job.current_status, to_status: target, reason: reason || 'Queued while offline',
        occurred_at: new Date().toISOString(), offline_pending: true
      }, ...(Array.isArray(job.status_events) ? job.status_events : [])]
    };
    this.queue.items.push({
      id, type: 'job-status', number: job.job_token || `JOB-${centralId}`, status: 'pending',
      token: this.protectToken(token), central_id: Number(centralId),
      body: {
        org_id: Number(job.org_id), status: target, reason,
        base_version: Number(job.version || 0), offline_change_id: id
      },
      optimistic, created_at: new Date().toISOString(), error: ''
    });
    this.saveCachedJob(optimistic);
    this.saveQueue();
    return { success: true, job: optimistic, offline_pending: true, sync_status: 'pending' };
  }

  createOfflineIntake(body) {
    const orgId = Number(body.org_id || 0);
    if (!orgId || !String(body.customer_name || '').trim() || !String(body.customer_phone || '').trim() ||
        !String(body.issue_summary || '').trim()) {
      const error = new Error('Customer name, phone, and job summary are required');
      error.status = 400;
      throw error;
    }
    if (!body.consent_status) {
      const error = new Error('Customer confirmation is required before submitting the request');
      error.status = 400;
      throw error;
    }
    const clientRequestId = String(body.client_request_id || '').trim() || crypto.randomUUID();
    const duplicate = this.queue.items.find(item =>
      item.type === 'intake-submit' &&
      (item.id === clientRequestId || item.body?.client_request_id === clientRequestId)
    );
    if (duplicate?.optimistic) {
      return { ...duplicate.optimistic, duplicate: true };
    }
    const createdAt = new Date().toISOString();
    const requestNumber = this.nextLocalIntakeNumber(body);
    const payload = {
      ...body,
      client_request_id: clientRequestId,
      offline_id: clientRequestId,
      offline_device: this.deviceCode,
      offline_created_at: createdAt
    };
    const attachmentCount = Array.isArray(payload.attachments) ? payload.attachments.length : 0;
    const optimistic = {
      success: true,
      id: `offline-intake:${clientRequestId}`,
      order_id: requestNumber,
      request_number: requestNumber,
      party_id: null,
      billing_party_linked: false,
      status: 'LOCAL_PENDING',
      attachment_count: attachmentCount,
      offline_pending: true,
      sync_status: 'pending',
      submitted_at: createdAt,
      message: 'Saved on this section computer. It will sync when the Main System is online.'
    };
    this.queue.items.push({
      id: clientRequestId,
      type: 'intake-submit',
      number: requestNumber,
      status: 'pending',
      body: payload,
      optimistic,
      created_at: createdAt,
      error: ''
    });
    this.saveQueue();
    return optimistic;
  }

  createOfflineEdit(centralId, body, token) {
    const saved = this.offlineUserForToken(token);
    let user = null;
    try { user = JSON.parse(Buffer.from(saved?.response || '', 'base64').toString('utf8')).user; } catch (_) {}
    if (String(user?.username || '').toLowerCase() !== 'owner1' || user?.role !== 'owner') {
      const error = new Error('Only Owner1 can queue an emergency invoice edit');
      error.status = 403;
      throw error;
    }
    if (String(body.emergency_reason || '').trim().length < 5) {
      const error = new Error('Enter an emergency correction reason of at least 5 characters');
      error.status = 400;
      throw error;
    }
    const existing = this.cachedBill(centralId);
    if (!existing) {
      const error = new Error('Open this invoice once while the main system is online before editing it offline');
      error.status = 409;
      throw error;
    }
    const items = (body.items || []).map((item, index) => {
      const qty = Number(item.qty || 0);
      const rate = Number(item.rate || 0);
      return { ...item, sno: index + 1, qty, rate, amount: Number(item.amount || qty * rate) };
    });
    const subtotal = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const discount = Number(body.discount || 0);
    const grossBeforeTax = subtotal - discount;
    const org = this.orgFor(existing.org_id) || {};
    const taxRate = org.gst_type === 'composition' || ['QUOT', 'DC'].includes(existing.format) ? 0 : 18;
    const totalTax = body.tax_inclusive ? grossBeforeTax * taxRate / (100 + taxRate) : grossBeforeTax * taxRate / 100;
    const taxable = body.tax_inclusive ? grossBeforeTax - totalTax : grossBeforeTax;
    const grandTotal = grossBeforeTax + (body.tax_inclusive ? 0 : totalTax) + Number(body.swipe_charge || 0);
    const bill = {
      ...existing, ...body, id: Number(centralId), items, items_json: JSON.stringify(items),
      subtotal, discount, taxable_amount: taxable, tax_rate: taxRate,
      cgst: totalTax / 2, sgst: totalTax / 2, total_tax: totalTax, grand_total: grandTotal,
      tax_inclusive: body.tax_inclusive ? 1 : 0,
      status: 'emergency edit pending sync', org,
      party: (this.cachedJson(`/api/parties?org_id=${existing.org_id}`, []) || [])
        .find(row => Number(row.id) === Number(existing.party_id)) || null
    };
    const id = crypto.randomUUID();
    this.queue.items.push({
      id, operation: 'edit', central_id: Number(centralId), number: existing.bill_number,
      status: 'pending', token: this.protectToken(token), body,
      created_at: new Date().toISOString(), error: ''
    });
    this.saveQueue();
    return { success: true, bill, offline_pending: true, emergency_edit_pending: true };
  }

  async refreshToken(item) {
    const result = await requestRemote(this.serverUrl, 'POST', '/api/auth/refresh',
      { 'content-type': 'application/json' }, JSON.stringify({ token: this.unprotectToken(item.token) }));
    if (result.status !== 200) return false;
    const data = JSON.parse(result.body.toString('utf8'));
    item.token = this.protectToken(data.token);
    return true;
  }

  wipeLocalData(reason) {
    const completedAt = new Date().toISOString();
    this.queue = { sequence: {}, items: [] };
    this.cache = {
      device_wipe: {
        completed_at: completedAt,
        reason: String(reason || 'Device access revoked').slice(0, 500)
      }
    };
    this.localWipedAt = completedAt;
    try {
      if (fs.existsSync(this.replicaDir)) {
        for (const name of fs.readdirSync(this.replicaDir)) fs.rmSync(path.join(this.replicaDir, name), { force: true });
      }
    } catch (_) {}
    this.saveQueue();
    this.saveCache();
    this.broadcast();
  }

  async enforceDevicePolicy(item) {
    const orgId = Number(item?.body?.org_id || 0);
    const deviceId = this.deviceIdentity.deviceId || '';
    if (!orgId || !deviceId || !item?.token) return;
    const token = this.unprotectToken(item.token);
    const policyPath = `/api/advanced/registered-devices/policy?org_id=${orgId}&device_id=${encodeURIComponent(deviceId)}`;
    let result = await requestRemote(this.serverUrl, 'GET', policyPath, {
      'x-tarangini-device-id': deviceId,
      authorization: `Bearer ${token}`
    }, null, 5000);
    if (result.status === 401 && await this.refreshToken(item)) {
      result = await requestRemote(this.serverUrl, 'GET', policyPath, {
        'x-tarangini-device-id': deviceId,
        authorization: `Bearer ${this.unprotectToken(item.token)}`
      }, null, 5000);
    }
    let policy = {};
    try { policy = JSON.parse(result.body.toString('utf8')); } catch (_) {}
    if (result.status === 200 && policy.wipe_required) {
      const acknowledgementToken = this.unprotectToken(item.token);
      this.wipeLocalData(policy.device?.wipe_reason || 'Device access revoked by owner');
      await requestRemote(this.serverUrl, 'POST', '/api/advanced/registered-devices/wipe-ack', {
        'content-type': 'application/json',
        'x-tarangini-device-id': deviceId,
        authorization: `Bearer ${acknowledgementToken}`
      }, JSON.stringify({ org_id: orgId, device_id: deviceId }), 5000);
      const error = new Error('This device was revoked. Protected local work and cached data were erased.');
      error.code = 'DEVICE_WIPED';
      throw error;
    }
    if (result.status === 403 || (result.status === 200 && !policy.active)) {
      const error = new Error(policy.error || 'This device is not active for synchronization');
      error.code = 'DEVICE_NOT_ACTIVE';
      throw error;
    }
  }

  async pullOrganizationSnapshot(orgId, token) {
    const item = { body: { org_id: orgId }, token: this.protectToken(token) };
    await this.enforceDevicePolicy(item);
    const deviceId = this.deviceIdentity.deviceId || '';
    const result = await requestRemote(this.serverUrl, 'GET',
      `/api/advanced/sync/snapshot?org_id=${Number(orgId)}&device_id=${encodeURIComponent(deviceId)}`, {
        'x-tarangini-device-id': deviceId,
        authorization: `Bearer ${this.unprotectToken(item.token)}`
      }, null, 30000);
    if (result.status < 200 || result.status >= 300) {
      let data = {};
      try { data = JSON.parse(result.body.toString('utf8')); } catch (_) {}
      throw new Error(data.error || `Snapshot pull failed (${result.status})`);
    }
    const snapshot = JSON.parse(result.body.toString('utf8'));
    const expectedChecksum = String(snapshot.checksum_sha256 || '');
    const payload = { ...snapshot };
    delete payload.checksum_sha256;
    const actualChecksum = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const expectedBuffer = Buffer.from(expectedChecksum);
    const actualBuffer = Buffer.from(actualChecksum);
    if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
      throw new Error('Snapshot checksum verification failed');
    }
    this.cache.organization_snapshots = this.cache.organization_snapshots || {};
    this.cache.organization_snapshots[String(orgId)] = snapshot;
    this.saveReplicaSnapshot(snapshot);
    this.saveCache();
    return {
      success: true,
      org_id: Number(orgId),
      revision: snapshot.revision,
      schema_version: snapshot.schema_version,
      checksum_sha256: expectedChecksum,
      cached_at: new Date().toISOString()
    };
  }

  async pullOrganizationChanges(orgId, token) {
    const cached = this.snapshotForOrg(orgId);
    const afterRevision = Number(cached?.revision || 0);
    const item = { body: { org_id: orgId }, token: this.protectToken(token) };
    await this.enforceDevicePolicy(item);
    const deviceId = this.deviceIdentity.deviceId || '';
    const result = await requestRemote(this.serverUrl, 'GET',
      `/api/advanced/sync/delta?org_id=${Number(orgId)}&device_id=${encodeURIComponent(deviceId)}&after_revision=${afterRevision}`, {
        'x-tarangini-device-id': deviceId,
        authorization: `Bearer ${this.unprotectToken(item.token)}`
      }, null, 10000);
    if (result.status < 200 || result.status >= 300) {
      let data = {};
      try { data = JSON.parse(result.body.toString('utf8')); } catch (_) {}
      throw new Error(data.error || `Delta pull failed (${result.status})`);
    }
    const delta = JSON.parse(result.body.toString('utf8'));
    if (!delta.snapshot_required) {
      return { success: true, refreshed: false, org_id: Number(orgId), revision: afterRevision, changes: 0 };
    }
    const snapshot = await this.pullOrganizationSnapshot(orgId, this.unprotectToken(item.token));
    return { ...snapshot, refreshed: true, changes: delta.changes.length };
  }

  async syncItem(item) {
    if (item.type !== 'intake-submit') await this.enforceDevicePolicy(item);
    if (item.type === 'intake-submit') {
      const payload = {
        ...item.body,
        client_request_id: item.body.client_request_id || item.id,
        offline_id: item.id,
        offline_number: item.number,
        offline_device: this.deviceCode,
        offline_device_id: this.deviceIdentity.deviceId || '',
        offline_created_at: item.created_at
      };
      const result = await requestRemote(this.serverUrl, 'POST', '/api/job-intake/submit', {
        'content-type': 'application/json',
        'x-tarangini-device-id': this.deviceIdentity.deviceId || ''
      }, JSON.stringify(payload), 30000);
      if (result.status >= 200 && result.status < 300) {
        const data = JSON.parse(result.body.toString('utf8'));
        item.status = 'synced';
        item.central_id = data.id;
        item.central_number = data.request_number || data.order_id;
        item.synced_at = new Date().toISOString();
        item.error = '';
        return;
      }
      if (result.status >= 400 && result.status < 500) {
        let data = {};
        try { data = JSON.parse(result.body.toString('utf8')); } catch (_) {}
        item.status = 'conflict';
        item.error = data.error || `Main system rejected intake (${result.status})`;
        return;
      }
      throw new Error(`Main system returned ${result.status}`);
    }
    if (item.type === 'job-status') {
      const payload = {
        ...item.body,
        offline_change_id: item.body.offline_change_id || item.id,
        offline_device_id: this.deviceIdentity.deviceId || ''
      };
      const sendStatusUpdate = () => requestRemote(this.serverUrl, 'POST',
        `/api/jobs/${Number(item.central_id)}/status`, {
          'content-type': 'application/json',
          'x-tarangini-device-id': this.deviceIdentity.deviceId || '',
          authorization: `Bearer ${this.unprotectToken(item.token)}`
        }, JSON.stringify(payload), 20000);
      let result = await sendStatusUpdate();
      if (result.status === 401 && await this.refreshToken(item)) result = await sendStatusUpdate();
      if (result.status >= 200 && result.status < 300) {
        const data = JSON.parse(result.body.toString('utf8'));
        item.status = 'synced';
        item.synced_at = new Date().toISOString();
        item.error = '';
        if (data.job) this.saveCachedJob(data.job);
        return;
      }
      if (result.status >= 400 && result.status < 500) {
        let data = {};
        try { data = JSON.parse(result.body.toString('utf8')); } catch (_) {}
        item.status = 'conflict';
        item.error = data.error || `Main system rejected job update (${result.status})`;
        return;
      }
      throw new Error(`Main system returned ${result.status}`);
    }
    if (item.type === 'job-create') {
      const payload = {
        ...item.body, offline_id: item.id, offline_device: this.deviceCode,
        offline_device_id: this.deviceIdentity.deviceId || '',
        offline_created_at: item.created_at
      };
      let result = await requestRemote(this.serverUrl, 'POST', '/api/jobs', {
        'content-type': 'application/json',
        'x-tarangini-device-id': this.deviceIdentity.deviceId || '',
        authorization: `Bearer ${this.unprotectToken(item.token)}`
      }, JSON.stringify(payload), 20000);
      if (result.status === 401 && await this.refreshToken(item)) {
        result = await requestRemote(this.serverUrl, 'POST', '/api/jobs', {
          'content-type': 'application/json',
          'x-tarangini-device-id': this.deviceIdentity.deviceId || '',
          authorization: `Bearer ${this.unprotectToken(item.token)}`
        }, JSON.stringify(payload), 20000);
      }
      if (result.status >= 200 && result.status < 300) {
        const data = JSON.parse(result.body.toString('utf8'));
        item.status = 'synced';
        item.central_id = data.job?.id || data.id;
        item.synced_at = new Date().toISOString();
        item.error = '';
        return;
      }
      if (result.status >= 400 && result.status < 500) {
        let data = {};
        try { data = JSON.parse(result.body.toString('utf8')); } catch (_) {}
        item.status = 'conflict';
        item.error = data.error || `Main system rejected job (${result.status})`;
        return;
      }
      throw new Error(`Main system returned ${result.status}`);
    }
    const isEdit = item.operation === 'edit';
    const payload = isEdit ? item.body : {
      ...item.body, offline_id: item.id, offline_number: item.number,
      offline_device: this.deviceCode, offline_device_id: this.deviceIdentity.deviceId || '', offline_created_at: item.created_at
    };
    const method = isEdit ? 'PUT' : 'POST';
    const route = isEdit ? `/api/bills/${item.central_id}` : '/api/bills';
    let result = await requestRemote(this.serverUrl, method, route, {
      'content-type': 'application/json',
      'x-tarangini-device-id': this.deviceIdentity.deviceId || '',
      authorization: `Bearer ${this.unprotectToken(item.token)}`
    }, JSON.stringify(payload), 10000);
    if (result.status === 401 && await this.refreshToken(item)) {
      result = await requestRemote(this.serverUrl, method, route, {
        'content-type': 'application/json',
        'x-tarangini-device-id': this.deviceIdentity.deviceId || '',
        authorization: `Bearer ${this.unprotectToken(item.token)}`
      }, JSON.stringify(payload), 10000);
    }
    if (result.status >= 200 && result.status < 300) {
      const data = JSON.parse(result.body.toString('utf8'));
      item.status = 'synced';
      item.central_id = data.bill?.id;
      item.synced_at = new Date().toISOString();
      item.error = '';
      return;
    }
    if (result.status >= 400 && result.status < 500) {
      let data = {};
      try { data = JSON.parse(result.body.toString('utf8')); } catch (_) {}
      item.status = 'conflict';
      item.error = data.error || `Main system rejected invoice (${result.status})`;
      return;
    }
    throw new Error(`Main system returned ${result.status}`);
  }

  async syncNow() {
    if (this.syncing) return this.getStatus();
    this.syncing = true;
    try {
      for (const item of this.queue.items.filter(row => row.status === 'pending')) {
        await this.syncItem(item);
        this.saveQueue();
        this.broadcast();
      }
      this.lastSyncAt = new Date().toISOString();
      this.lastError = '';
      const retainedSynced = this.queue.items.filter(item => item.status === 'synced').slice(-500);
      this.queue.items = [
        ...this.queue.items.filter(item => item.status !== 'synced'),
        ...retainedSynced
      ].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    } catch (error) {
      this.lastError = error.message;
    } finally {
      this.syncing = false;
      this.saveQueue();
    }
    return this.getStatus();
  }

  async retryItem(id) {
    const item = this.queue.items.find(row => row.id === id);
    if (!item) throw new Error('Offline invoice not found');
    item.status = 'pending';
    item.error = '';
    this.saveQueue();
    return this.syncNow();
  }

  async rediscoverMainSystem() {
    if (!this.discoverServer || Date.now() - this.lastDiscoveryAt < 60000) return false;
    this.lastDiscoveryAt = Date.now();
    try {
      const discoveredUrl = await this.discoverServer(this.serverUrl);
      if (!discoveredUrl || discoveredUrl === this.serverUrl) return false;
      this.serverUrl = discoveredUrl.replace(/\/+$/, '');
      if (this.onServerUrlChanged) await this.onServerUrlChanged(this.serverUrl);
      this.lastError = `Main System rediscovered at ${this.serverUrl}`;
      this.broadcast();
      return true;
    } catch (_) {
      return false;
    }
  }

  async checkAndSync() {
    try {
      const health = await requestRemote(this.serverUrl, 'GET', '/api/health', {}, null, 2000);
      const data = JSON.parse(health.body.toString('utf8'));
      const changed = this.remoteRevision !== null && data.revision !== this.remoteRevision;
      this.remoteRevision = data.revision;
      this.remoteVersion = data.version || null;
      this.online = health.status === 200;
      this.lastError = '';
      if (changed) this.broadcast();
      if (this.online && this.queue.items.some(item => item.status === 'pending')) await this.syncNow();
      if (this.online && Date.now() - this.lastPullAt >= 30000) {
        this.lastPullAt = Date.now();
        const token = this.cachedRemoteToken();
        if (token) {
          for (const orgId of Object.keys(this.cache.organization_snapshots || {})) {
            await this.pullOrganizationChanges(Number(orgId), token);
          }
        }
      }
    } catch (error) {
      this.online = false;
      this.lastError = error.message;
      if (await this.rediscoverMainSystem()) return this.checkAndSync();
    }
    return this.getStatus();
  }

  serveStatic(requestPath, response) {
    const pathname = decodeURIComponent(new URL(requestPath, 'http://localhost').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(this.publicDir, relative);
    if (!file.startsWith(`${path.resolve(this.publicDir)}${path.sep}`) && file !== path.join(this.publicDir, 'index.html')) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(this.publicDir, 'index.html');
    response.writeHead(200, { 'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(target).pipe(response);
  }

  send(response, result) {
    const headers = { ...result.headers };
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    response.writeHead(result.status, headers);
    response.end(result.body);
  }

  async handle(request, response) {
    const requestUrl = new URL(request.url, `http://127.0.0.1:${this.port}`);
    if (requestUrl.pathname === '/api/sync/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      response.write(`data: ${JSON.stringify({ revision: Date.now(), connected: true })}\n\n`);
      this.eventClients.add(response);
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 25000);
      request.on('close', () => {
        clearInterval(heartbeat);
        this.eventClients.delete(response);
      });
      return;
    }
    if (!requestUrl.pathname.startsWith('/api/')) return this.serveStatic(request.url, response);

    const bodyBuffer = await bodyFromRequest(request);
    const bodyText = bodyBuffer.toString('utf8');
    let parsedBody = {};
    try { parsedBody = bodyText ? JSON.parse(bodyText) : {}; } catch (_) {}

    const publicApi = ['/api/health', '/api/auth/login', '/api/auth/refresh'];
    const publicIntakePath = requestUrl.pathname.replace(/^\/api\/job-intake\//, '');
    const publicIntakeApi = requestUrl.pathname.startsWith('/api/job-intake/') && (
      (request.method === 'GET' && ['config', 'status'].includes(publicIntakePath)) ||
      (request.method === 'POST' && ['submit', 'analyze-file'].includes(publicIntakePath))
    );
    if (!publicApi.includes(requestUrl.pathname) && !publicIntakeApi && !request.headers.authorization &&
        !requestUrl.pathname.startsWith('/api/offline/')) {
      response.writeHead(401, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ error: 'No token provided' }));
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/offline/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify(this.getStatus()));
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/offline/local-portal-link') {
      const user = this.userFromRequest(request);
      if (user?.role !== 'owner') {
        response.writeHead(403, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ error: 'Owner access required' }));
      }
      if (!this.portalLanEnabled) {
        response.writeHead(409, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ error: 'Enable LAN Customer Portal Mode in Client Setup first' }));
      }
      const orgId = Number(requestUrl.searchParams.get('org_id') || 0);
      const org = this.orgFor(orgId);
      const lanAddress = Object.values(os.networkInterfaces()).flat().find(entry =>
        entry && entry.family === 'IPv4' && !entry.internal)?.address || '';
      if (!org || !lanAddress) {
        response.writeHead(404, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ error: 'Company or LAN address is unavailable' }));
      }
      const url = `http://${lanAddress}:${this.port}/customer-intake.html?org=${orgId}`;
      const qrDataUrl = await QRCode.toDataURL(url, { width: 320, margin: 1 });
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ success: true, org_id: orgId, company_name: org.display_name, url, qr_data_url: qrDataUrl }));
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/offline/sync') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify(await this.syncNow()));
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/offline/pull-snapshot') {
      const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const orgId = Number(parsedBody.org_id || 0);
      if (!token || !orgId) {
        response.writeHead(400, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ error: 'Authenticated org_id is required' }));
      }
      try {
        const pulled = await this.pullOrganizationSnapshot(orgId, token);
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(JSON.stringify(pulled));
      } catch (error) {
        response.writeHead(error.code === 'DEVICE_WIPED' ? 403 : 409, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ error: error.message, code: error.code || 'SNAPSHOT_PULL_FAILED' }));
      }
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/offline/sync-pull') {
      const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const orgId = Number(parsedBody.org_id || 0);
      if (!token || !orgId) {
        response.writeHead(400, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ error: 'Authenticated org_id is required' }));
      }
      try {
        const pulled = await this.pullOrganizationChanges(orgId, token);
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(JSON.stringify(pulled));
      } catch (error) {
        response.writeHead(error.code === 'DEVICE_WIPED' ? 403 : 409, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ error: error.message, code: error.code || 'DELTA_PULL_FAILED' }));
      }
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/auth/login' && !this.online) {
      return this.sendOfflineLogin(response, parsedBody.username, parsedBody.password);
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/auth/unlock' && !this.online) {
      return this.sendOfflineUnlock(response, request, parsedBody.password);
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/auth/lock-event' && !this.online) {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ success: true, offline: true }));
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/bills/next-number' && !this.online) {
      const number = this.nextOfflineNumber({
        org_id: requestUrl.searchParams.get('org_id'),
        format: requestUrl.searchParams.get('format'),
        fy: requestUrl.searchParams.get('fy'),
        bill_date: new Date().toISOString().slice(0, 10)
      }, false);
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ number, offline: true }));
    }
    if (!this.online && this.lastError && request.method === 'GET' && requestUrl.pathname === '/api/bills') {
      response.writeHead(200, { 'content-type': 'application/json', 'x-tarangini-offline-cache': '1' });
      return response.end(JSON.stringify(this.offlineBillList(requestUrl, request)));
    }
    if (!this.online && this.lastError && request.method === 'POST' && requestUrl.pathname === '/api/bills') {
      try {
        const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const result = this.createOfflineBill(parsedBody, token);
        response.writeHead(202, { 'content-type': 'application/json' });
        return response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(error.status || 409, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ error: error.message, code: error.code }));
      }
    }
    const offlineStatusMatch = requestUrl.pathname.match(/^\/api\/jobs\/(\d+)\/status$/);
    if (!this.online && this.lastError && request.method === 'POST' && offlineStatusMatch) {
      try {
        const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const result = this.createOfflineJobStatus(offlineStatusMatch[1], parsedBody, token);
        response.writeHead(202, { 'content-type': 'application/json' });
        return response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(error.status || 409, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ error: error.message, code: error.code }));
      }
    }
    if (!this.online && this.lastError && request.method === 'GET') {
      const offlineFullMatch = requestUrl.pathname.match(/^\/api\/bills\/offline:([a-f0-9-]+)\/full$/i);
      const queued = offlineFullMatch
        ? this.queue.items.find(item => item.id === offlineFullMatch[1] && !item.type && !item.operation)
        : null;
      if (queued) {
        response.writeHead(200, { 'content-type': 'application/json', 'x-tarangini-offline-cache': '1' });
        return response.end(JSON.stringify(this.projectOfflineBill(queued)));
      }
      if (this.cache[request.url]) {
        response.writeHead(200, {
          'content-type': this.cache[request.url].content_type || 'application/json',
          'x-tarangini-offline-cache': '1'
        });
        return response.end(Buffer.from(this.cache[request.url].body, 'base64'));
      }
      const centralFullMatch = requestUrl.pathname.match(/^\/api\/bills\/(\d+)\/full$/);
      const cachedBill = centralFullMatch ? this.cachedBill(centralFullMatch[1]) : null;
      if (cachedBill) {
        response.writeHead(200, { 'content-type': 'application/json', 'x-tarangini-offline-cache': '1' });
        return response.end(JSON.stringify({
          ...cachedBill,
          items: JSON.parse(cachedBill.items_json || '[]'),
          org: this.orgFor(cachedBill.org_id) || {},
          party: (this.cachedJson(`/api/parties?org_id=${cachedBill.org_id}`, []) || [])
            .find(row => Number(row.id) === Number(cachedBill.party_id)) || null
        }));
      }
    }

    try {
      const result = await requestRemote(this.serverUrl, request.method, request.url, request.headers,
        bodyBuffer.length ? bodyBuffer : null);
      this.online = true;
      if (request.method === 'POST' && requestUrl.pathname === '/api/auth/login' && result.status === 200) {
        const username = String(parsedBody.username || '').trim().toLowerCase();
        if (username && parsedBody.password) {
          const salt = crypto.randomBytes(16).toString('hex');
          this.cache.offline_users = this.cache.offline_users || {};
          this.cache.offline_users[username] = {
            salt,
            verifier: passwordVerifier(parsedBody.password, salt),
            response: result.body.toString('base64'),
            cached_at: new Date().toISOString()
          };
          this.saveCache();
        }
      }
      if (request.method === 'GET' && result.status === 200 &&
          String(result.headers['content-type'] || '').includes('application/json')) {
        this.cache[request.url] = {
          body: result.body.toString('base64'),
          content_type: result.headers['content-type'],
          cached_at: new Date().toISOString()
        };
        this.saveCache();
      }
      return this.send(response, result);
    } catch (error) {
      this.online = false;
      this.lastError = error.message;
      if (request.method === 'POST' && requestUrl.pathname === '/api/auth/login') {
        return this.sendOfflineLogin(response, parsedBody.username, parsedBody.password);
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/auth/unlock') {
        return this.sendOfflineUnlock(response, request, parsedBody.password);
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/auth/lock-event') {
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ success: true, offline: true }));
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/bills') {
        try {
          const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
          const result = this.createOfflineBill(parsedBody, token);
          response.writeHead(202, { 'content-type': 'application/json' });
          return response.end(JSON.stringify(result));
        } catch (billError) {
          response.writeHead(billError.status || 409, { 'content-type': 'application/json' });
          return response.end(JSON.stringify({ error: billError.message, code: billError.code }));
        }
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/jobs') {
        try {
          const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
          const result = this.createOfflineJob(parsedBody, token);
          response.writeHead(202, { 'content-type': 'application/json' });
          return response.end(JSON.stringify(result));
        } catch (jobError) {
          response.writeHead(jobError.status || 400, { 'content-type': 'application/json' });
          return response.end(JSON.stringify({ error: jobError.message }));
        }
      }
      const offlineStatusMatch = requestUrl.pathname.match(/^\/api\/jobs\/(\d+)\/status$/);
      if (request.method === 'POST' && offlineStatusMatch) {
        try {
          const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
          const result = this.createOfflineJobStatus(offlineStatusMatch[1], parsedBody, token);
          response.writeHead(202, { 'content-type': 'application/json' });
          return response.end(JSON.stringify(result));
        } catch (jobError) {
          response.writeHead(jobError.status || 409, { 'content-type': 'application/json' });
          return response.end(JSON.stringify({ error: jobError.message, code: jobError.code }));
        }
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/job-intake/submit') {
        try {
          const result = this.createOfflineIntake(parsedBody);
          response.writeHead(202, { 'content-type': 'application/json' });
          return response.end(JSON.stringify(result));
        } catch (intakeError) {
          response.writeHead(intakeError.status || 400, { 'content-type': 'application/json' });
          return response.end(JSON.stringify({ error: intakeError.message }));
        }
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/job-intake/status') {
        const orderId = String(requestUrl.searchParams.get('order_id') || '').trim().toUpperCase();
        const phone = String(requestUrl.searchParams.get('phone') || '').trim();
        const queued = this.queue.items.find(item =>
          item.type === 'intake-submit' &&
          String(item.number || '').toUpperCase() === orderId &&
          String(item.body?.customer_phone || '').trim() === phone
        );
        if (queued?.optimistic) {
          response.writeHead(200, {
            'content-type': 'application/json',
            'x-tarangini-offline-cache': '1'
          });
          return response.end(JSON.stringify({
            success: true,
            order_id: queued.number,
            request_number: queued.number,
            request_status: queued.status === 'synced' ? 'SYNCED' : 'LOCAL_PENDING',
            customer_name: queued.body.customer_name,
            customer_phone: queued.body.customer_phone,
            issue_summary: queued.body.issue_summary,
            submitted_at: queued.created_at,
            attachment_count: Array.isArray(queued.body.attachments) ? queued.body.attachments.length : 0,
            offline_pending: queued.status !== 'synced',
            message: queued.status === 'synced'
              ? 'This local request has synced to the Main System.'
              : 'This request is saved on the section computer and waiting for the Main System.'
          }));
        }
      }
      const offlineJobMatch = requestUrl.pathname.match(/^\/api\/jobs\/offline:([a-f0-9-]+)$/i);
      if (request.method === 'GET' && offlineJobMatch) {
        const queued = this.queue.items.find(item => item.type === 'job-create' && item.id === offlineJobMatch[1]);
        if (queued?.optimistic) {
          response.writeHead(200, {
            'content-type': 'application/json',
            'x-tarangini-offline-cache': '1'
          });
          return response.end(JSON.stringify(queued.optimistic));
        }
      }
      const editMatch = requestUrl.pathname.match(/^\/api\/bills\/(\d+)$/);
      if (request.method === 'PUT' && editMatch) {
        try {
          const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
          const result = this.createOfflineEdit(editMatch[1], parsedBody, token);
          response.writeHead(202, { 'content-type': 'application/json' });
          return response.end(JSON.stringify(result));
        } catch (editError) {
          response.writeHead(editError.status || 400, { 'content-type': 'application/json' });
          return response.end(JSON.stringify({ error: editError.message }));
        }
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/bills') {
        response.writeHead(200, {
          'content-type': 'application/json',
          'x-tarangini-offline-cache': '1'
        });
        return response.end(JSON.stringify(this.offlineBillList(requestUrl, request)));
      }
      const offlineFullMatch = requestUrl.pathname.match(/^\/api\/bills\/offline:([a-f0-9-]+)\/full$/i);
      if (request.method === 'GET' && offlineFullMatch) {
        const queued = this.queue.items.find(item => item.id === offlineFullMatch[1] && !item.type && !item.operation);
        if (queued) {
          response.writeHead(200, {
            'content-type': 'application/json',
            'x-tarangini-offline-cache': '1'
          });
          return response.end(JSON.stringify(this.projectOfflineBill(queued)));
        }
      }
      if (request.method === 'GET' && this.cache[request.url]) {
        response.writeHead(200, {
          'content-type': this.cache[request.url].content_type || 'application/json',
          'x-tarangini-offline-cache': '1'
        });
        return response.end(Buffer.from(this.cache[request.url].body, 'base64'));
      }
      const fullMatch = requestUrl.pathname.match(/^\/api\/bills\/(\d+)\/full$/);
      if (request.method === 'GET' && fullMatch) {
        const bill = this.cachedBill(fullMatch[1]);
        if (bill) {
          const full = {
            ...bill,
            items: JSON.parse(bill.items_json || '[]'),
            org: this.orgFor(bill.org_id) || {},
            party: (this.cachedJson(`/api/parties?org_id=${bill.org_id}`, []) || [])
              .find(row => Number(row.id) === Number(bill.party_id)) || null
          };
          response.writeHead(200, {
            'content-type': 'application/json',
            'x-tarangini-offline-cache': '1'
          });
          return response.end(JSON.stringify(full));
        }
      }
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: 'Main system is offline. New invoices and job orders can be queued; this operation requires the main system.'
      }));
    }
  }
}

module.exports = { OfflineProxy, requestRemote, safeDeviceCode };
