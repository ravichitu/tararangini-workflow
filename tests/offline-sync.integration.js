const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const { OfflineProxy, requestRemote } = require('../electron/offline-proxy');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.offline-sync-test');
const clientDir = path.join(root, '.offline-client-test');
const recoveryClientDir = path.join(root, '.offline-client-recovery-test');
const mainPort = 3210;
const proxyPort = 3211;
const proxyPort2 = 3212;
fs.rmSync(dataDir, { recursive: true, force: true });
fs.rmSync(clientDir, { recursive: true, force: true });
fs.rmSync(recoveryClientDir, { recursive: true, force: true });

let server;
let output = '';

function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(mainPort), TARANGINI_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start\n${output}`);
}

async function request(base, method, route, body, token) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${method} ${route}: ${payload.error || response.status}`);
  return { response, payload };
}

(async () => {
  const mainUrl = `http://127.0.0.1:${mainPort}`;
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  let proxy;
  let proxy2;
  let discoveryProxy;
  let originProbe;
  let assignedJob;
  try {
    // A local bridge must remove browser-only Origin metadata before forwarding
    // a request to the central server.
    originProbe = http.createServer((req, res) => {
      assert.strictEqual(req.headers.origin, undefined);
      assert.strictEqual(req.headers.referer, undefined);
      assert.strictEqual(req.headers['sec-fetch-site'], undefined);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    await new Promise(resolve => originProbe.listen(0, '127.0.0.1', resolve));
    const originProbePort = originProbe.address().port;
    const originProbeResult = await requestRemote(`http://127.0.0.1:${originProbePort}`, 'POST', '/probe', {
      origin: `http://127.0.0.1:${proxyPort}`,
      referer: `http://127.0.0.1:${proxyPort}/`,
      'sec-fetch-site': 'same-origin',
      cookie: 'tarangini_session=test-session'
    }, JSON.stringify({ test: true }));
    assert.strictEqual(originProbeResult.status, 200);
    await new Promise(resolve => originProbe.close(resolve));
    originProbe = null;

    const recoveryStoreDir = path.join(recoveryClientDir, 'offline-client');
    fs.mkdirSync(recoveryStoreDir, { recursive: true });
    fs.writeFileSync(path.join(recoveryStoreDir, 'queue.json'), '{damaged protected queue', 'utf8');
    fs.writeFileSync(path.join(recoveryStoreDir, 'cache.json.tmp'), JSON.stringify({ recovered: true }), 'utf8');
    const recoveryProxy = new OfflineProxy({
      appPath: root, userData: recoveryClientDir, serverUrl: 'http://127.0.0.1:3999',
      deviceCode: 'RC1', port: 3998
    });
    assert.strictEqual(recoveryProxy.getStatus().counts.pending, 0);
    assert.strictEqual(recoveryProxy.cache.recovered, true);
    assert.ok(recoveryProxy.getStatus().storage_recovery_events
      .some(event => event.action === 'QUARANTINED_CORRUPT_STORE' && event.store === 'queue.json'));
    assert.ok(recoveryProxy.getStatus().storage_recovery_events
      .some(event => event.action === 'RECOVERED_INTERRUPTED_WRITE' && event.store === 'cache.json'));
    assert.ok(fs.readdirSync(recoveryStoreDir).some(name => name.startsWith('queue.json.corrupt-')));
    const marchNumber = recoveryProxy.nextOfflineNumber({
      org_id: 1, format: 'QUOT', bill_date: '2027-03-31'
    });
    const aprilNumber = recoveryProxy.nextOfflineNumber({
      org_id: 1, format: 'QUOT', bill_date: '2027-04-01'
    });
    assert.match(marchNumber, /\/QUOT\/2026-27\/0001$/);
    assert.match(aprilNumber, /\/QUOT\/2027-28\/0001$/);

    startServer();
    await waitFor(`${mainUrl}/api/health`);
    const login = (await request(mainUrl, 'POST', '/auth/login', {
      username: 'owner1', password: 'owner123'
    })).payload;
    const token = login.token;
    const org = (await request(mainUrl, 'POST', '/orgs', {
      display_name: 'Offline Test', registered_name: 'Offline Test', gst_type: 'regular'
    }, token)).payload;
    for (const deviceId of ['DEV-CLIENT1', 'DEV-CLIENT2']) {
      const registered = await request(mainUrl, 'POST', '/advanced/registered-devices', {
        org_id: org.id, device_id: deviceId, device_name: deviceId
      }, token);
      assert.strictEqual(registered.response.status, 201);
    }
    const party = (await request(mainUrl, 'POST', '/parties', {
      org_id: org.id, type: 'customer', name: 'Offline Customer'
    }, token)).payload;
    const item = (await request(mainUrl, 'POST', '/items', {
      org_id: org.id, name: 'Offline Item', hsn_code: '84716040', unit: 'NOS', gst_rate: 18,
      last_sale_price: 100, opening_stock: 1
    }, token)).payload;

    let rediscoveredUrl = '';
    discoveryProxy = new OfflineProxy({
      appPath: root, userData: `${clientDir}-discovery`, serverUrl: 'http://127.0.0.1:3299',
      deviceCode: 'C3', port: 3213,
      discoverServer: async () => mainUrl,
      onServerUrlChanged: url => { rediscoveredUrl = url; }
    });
    await discoveryProxy.start();
    for (let attempt = 0; attempt < 40 && !discoveryProxy.online; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.strictEqual(discoveryProxy.online, true);
    assert.strictEqual(discoveryProxy.serverUrl, mainUrl);
    assert.strictEqual(rediscoveredUrl, mainUrl);
    discoveryProxy.stop();
    discoveryProxy = null;

    proxy = new OfflineProxy({
      appPath: root, userData: clientDir, serverUrl: mainUrl, deviceCode: 'C1', port: proxyPort,
      deviceIdentity: { deviceId: 'DEV-CLIENT1', systemName: 'TEST-C1', displayName: 'TEST-C1' }
    });
    proxy2 = new OfflineProxy({
      appPath: root, userData: `${clientDir}-2`, serverUrl: mainUrl, deviceCode: 'C2', port: proxyPort2,
      deviceIdentity: { deviceId: 'DEV-CLIENT2', systemName: 'TEST-C2', displayName: 'TEST-C2' }
    });
    await proxy.start();
    await proxy2.start();
    await waitFor(`${proxyUrl}/api/health`);
    await waitFor(`http://127.0.0.1:${proxyPort2}/api/health`);
    const cachedLoginResult = await request(proxyUrl, 'POST', '/auth/login', {
      username: 'owner1', password: 'owner123'
    });
    const cachedLogin = cachedLoginResult.payload;
    assert.strictEqual(cachedLogin.user.username, 'owner1');
    for (const clientUrl of [proxyUrl, `http://127.0.0.1:${proxyPort2}`]) {
      await request(clientUrl, 'GET', '/orgs', undefined, token);
      await request(clientUrl, 'GET', `/parties?org_id=${org.id}`, undefined, token);
      await request(clientUrl, 'GET', `/items?org_id=${org.id}`, undefined, token);
      await request(clientUrl, 'GET', '/auth/me', undefined, token);
    }
    const jobCatalog = (await request(proxyUrl, 'GET', `/jobs/catalog?org_id=${org.id}`, undefined, token)).payload;
    const operator = (await request(mainUrl, 'POST', '/auth/users', {
      name: 'Offline Operator', username: 'offlineoperator', pin: '2345', role: 'operator', org_access: [org.id]
    }, token)).payload;
    const operatorLogin = (await request(proxyUrl, 'POST', '/auth/login', {
      username: 'offlineoperator', pin: '2345'
    })).payload;
    assignedJob = (await request(mainUrl, 'POST', '/jobs', {
      org_id: org.id, party_id: party.id, priority: 'NORMAL',
      promised_delivery_at: '2026-06-12T18:00:00.000Z', customer_commitment: 'Assigned offline progress test',
      items: [{ service_id: jobCatalog.services[0].id, description: 'Assigned progress task', quantity: 1, unit: 'NOS' }],
      estimate_lines: [{ description: 'Assigned progress task', quantity: 1, unit: 'NOS', unit_price: 100, tax_rate: 0, line_total: 100 }]
    }, token)).payload.job;
    const assignment = (await request(mainUrl, 'POST', `/jobs/${assignedJob.id}/assign`, {
      employee_id: operator.id, reason: 'Offline progress test assignment', instructions: 'Advance normal work only'
    }, token)).payload;
    await request(proxyUrl, 'POST', `/jobs/assignments/${assignment.id}/respond`, { decision: 'ACCEPT' }, operatorLogin.token);
    const cachedAssignedJob = (await request(proxyUrl, 'GET', `/jobs/${assignedJob.id}`, undefined, operatorLogin.token)).payload;
    assert.strictEqual(cachedAssignedJob.current_status, 'ACCEPTED');
    const pulledSnapshot = (await request(proxyUrl, 'POST', '/offline/pull-snapshot', {
      org_id: org.id
    }, token)).payload;
    assert.strictEqual(pulledSnapshot.success, true);
    assert.strictEqual(pulledSnapshot.org_id, org.id);
    assert.match(pulledSnapshot.checksum_sha256, /^[a-f0-9]{64}$/);
    assert.strictEqual(proxy.cache.organization_snapshots[String(org.id)].org.id, org.id);
    const unchangedPull = (await request(proxyUrl, 'POST', '/offline/sync-pull', {
      org_id: org.id
    }, token)).payload;
    assert.strictEqual(unchangedPull.refreshed, false);
    await request(mainUrl, 'POST', '/parties', {
      org_id: org.id, type: 'customer', name: 'Delta Pull Customer'
    }, token);
    const changedPull = (await request(proxyUrl, 'POST', '/offline/sync-pull', {
      org_id: org.id
    }, token)).payload;
    assert.strictEqual(changedPull.refreshed, true);
    assert.ok(changedPull.changes >= 1);
    assert.ok(proxy.cache.organization_snapshots[String(org.id)].tables.parties
      .some(row => row.name === 'Delta Pull Customer'));
    await request(mainUrl, 'POST', '/parties', {
      org_id: org.id, type: 'customer', name: 'Automatic Delta Customer'
    }, token);
    proxy.lastPullAt = 0;
    await proxy.checkAndSync();
    assert.ok(proxy.cache.organization_snapshots[String(org.id)].tables.parties
      .some(row => row.name === 'Automatic Delta Customer'));

    server.kill();
    await new Promise(resolve => setTimeout(resolve, 500));

    proxy.stop();
    await new Promise(resolve => setTimeout(resolve, 250));
    proxy = new OfflineProxy({
      appPath: root, userData: clientDir, serverUrl: mainUrl, deviceCode: 'C1', port: proxyPort,
      deviceIdentity: { deviceId: 'DEV-CLIENT1', systemName: 'TEST-C1', displayName: 'TEST-C1' }
    });
    await proxy.start();
    await waitFor(`${proxyUrl}/`);
    const offlineLogin = (await request(proxyUrl, 'POST', '/auth/login', {
      username: 'owner1', password: 'owner123'
    })).payload;
    assert.strictEqual(offlineLogin.user.username, 'owner1');
    assert.strictEqual((await request(proxyUrl, 'POST', '/auth/unlock', {
      password: 'owner123'
    }, offlineLogin.token)).payload.offline, true);
    const offlineStatus = (await request(proxyUrl, 'POST', `/jobs/${assignedJob.id}/status`, {
      status: 'IN_PROGRESS', reason: 'Started work during planned Main System outage'
    }, operatorLogin.token)).payload;
    assert.strictEqual(offlineStatus.offline_pending, true);
    assert.strictEqual(offlineStatus.job.current_status, 'IN_PROGRESS');
    assert.strictEqual(proxy.getStatus().counts.pending, 1);

    const blockedOfflineSale = await fetch(`${proxyUrl}/api/bills`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        org_id: org.id, format: 'SALE', bill_date: '2026-06-07', party_id: party.id,
        payment_mode: 'cash',
        items: [{ item_id: item.id, item_name: 'Offline Item', qty: 2, unit: 'NOS', rate: 100, amount: 200, gst_rate: 18 }]
      })
    });
    assert.strictEqual(blockedOfflineSale.status, 409);
    assert.strictEqual((await blockedOfflineSale.json()).code, 'OFFLINE_FINANCIAL_REVIEW_REQUIRED');

    const offline = (await request(proxyUrl, 'POST', '/bills', {
      org_id: org.id, format: 'QUOT', bill_date: '2026-06-07', party_id: party.id,
      payment_mode: 'cash',
      items: [{ item_id: item.id, item_name: 'Offline Draft Item', qty: 2, unit: 'NOS', rate: 100, amount: 200, gst_rate: 18 }]
    }, token)).payload;
    assert.strictEqual(offline.offline_pending, true);
    assert.match(offline.bill.bill_number, /OFF-C1\/QUOT\/2026-27\/0001/);
    assert.strictEqual(proxy.getStatus().counts.pending, 2);
    const offlineQuotation = (await request(proxyUrl, 'POST', '/bills', {
      org_id: org.id, format: 'QUOT', bill_date: '2026-06-07', party_id: party.id,
      payment_mode: 'credit', description: 'Offline quotation visibility test',
      items: [{ item_id: item.id, item_name: 'Offline Quotation Item', qty: 1, unit: 'NOS', rate: 75, amount: 75 }]
    }, token)).payload;
    assert.strictEqual(offlineQuotation.offline_pending, true);
    assert.match(offlineQuotation.bill.bill_number, /OFF-C1\/QUOT\/2026-27\/0002/);
    assert.strictEqual(proxy.getStatus().counts.pending, 3);
    const localQuotations = (await request(proxyUrl, 'GET',
      `/bills?org_id=${org.id}&fy=2026-27&format=QUOT`, undefined, offlineLogin.token)).payload;
    assert.strictEqual(localQuotations.length, 2);
    assert.strictEqual(localQuotations[0].offline_id, offlineQuotation.bill.offline_id);
    assert.strictEqual(localQuotations[0].status, 'pending sync');
    const localQuotationFull = (await request(proxyUrl, 'GET',
      `/bills/${offlineQuotation.bill.id}/full`, undefined, offlineLogin.token)).payload;
    assert.strictEqual(localQuotationFull.description, 'Offline quotation visibility test');
    const offlineJob = (await request(proxyUrl, 'POST', '/jobs', {
      org_id: org.id,
      party_id: party.id,
      priority: 'HIGH',
      promised_delivery_at: '2026-06-13T18:00:00.000Z',
      customer_commitment: 'Offline job commitment',
      items: [{
        service_id: jobCatalog.services[0].id,
        description: 'Offline service work',
        specifications: { notes: 'Created without main-system connectivity' },
        quantity: 1,
        unit: 'NOS'
      }],
      estimate_lines: [{
        description: 'Offline service work', quantity: 1, unit: 'NOS',
        unit_price: 250, tax_rate: 0, line_total: 250
      }],
      attachments: [{
        file_name: 'offline-reference.pdf', mime_type: 'application/pdf',
        content_base64: Buffer.from('offline attachment').toString('base64')
      }]
    }, token)).payload;
    assert.strictEqual(offlineJob.offline_pending, true);
    assert.match(offlineJob.token, /^OFF-C1-/);
    const offlineJobDetail = (await request(proxyUrl, 'GET',
      `/jobs/${offlineJob.id}`, undefined, token)).payload;
    assert.strictEqual(offlineJobDetail.attachments[0].file_name, 'offline-reference.pdf');
    assert.strictEqual(proxy.getStatus().counts.pending, 4);
    const offlineLocalCustomerJob = (await request(proxyUrl, 'POST', '/jobs', {
      org_id: org.id,
      party_id: null,
      offline_party: {
        name: 'Home Planned Customer', phone: '8888888888',
        email: 'home-planned@example.test', address: 'Prepared from home'
      },
      priority: 'NORMAL',
      promised_delivery_at: '2026-06-14T18:00:00.000Z',
      customer_commitment: 'Ready for operator tomorrow',
      items: [{
        service_id: jobCatalog.services[0].id,
        description: 'Home planned service work', quantity: 1, unit: 'NOS'
      }],
      estimate_lines: [{
        description: 'Home planned service work', quantity: 1, unit: 'NOS',
        unit_price: 125, tax_rate: 0, line_total: 125
      }]
    }, token)).payload;
    assert.strictEqual(offlineLocalCustomerJob.offline_pending, true);
    assert.strictEqual(offlineLocalCustomerJob.job.customer.name, 'Home Planned Customer');
    assert.strictEqual(proxy.getStatus().counts.pending, 5);
    const offlineIntake = (await request(proxyUrl, 'POST', '/job-intake/submit', {
      org_id: org.id,
      client_request_id: 'offline-customer-intake-1',
      source_channel: 'QR',
      customer_name: 'Section Walkin Customer',
      customer_phone: '9999999999',
      customer_email: 'section@example.test',
      customer_address: 'Local section counter',
      issue_summary: 'Customer submitted print work while main system was off',
      issue_details: 'Saved locally from section customer portal',
      consent_status: true,
      consent_text: 'Customer confirmed the request'
    })).payload;
    assert.strictEqual(offlineIntake.offline_pending, true);
    assert.match(offlineIntake.order_id, /^LOCAL-ORG\d+-C1-0001$/);
    const localStatus = (await request(proxyUrl, 'GET',
      `/job-intake/status?org_id=${org.id}&order_id=${offlineIntake.order_id}&phone=9999999999`)).payload;
    assert.strictEqual(localStatus.request_status, 'LOCAL_PENDING');
    assert.strictEqual(proxy.getStatus().counts.pending, 6);
    const offline2 = (await request(`http://127.0.0.1:${proxyPort2}`, 'POST', '/bills', {
      org_id: org.id, format: 'QUOT', bill_date: '2026-06-07', party_id: party.id,
      payment_mode: 'cash',
      items: [{ item_id: item.id, item_name: 'Offline Item', qty: 1, unit: 'NOS', rate: 50, amount: 50, gst_rate: 18 }]
    }, token)).payload;
    assert.match(offline2.bill.bill_number, /OFF-C2\/QUOT\/2026-27\/0001/);

    const conflict = (await request(proxyUrl, 'POST', '/bills', {
      org_id: org.id, format: 'QUOT', bill_date: '2026-06-07', party_id: 999999,
      payment_mode: 'cash', items: [{ item_name: 'Service', qty: 1, rate: 10, amount: 10 }]
    }, token)).payload;
    assert.strictEqual(conflict.offline_pending, true);
    assert.match(conflict.bill.bill_number, /0003/);

    startServer();
    await waitFor(`${mainUrl}/api/health`);
    const sync = await proxy.syncNow();
    const sync2 = await proxy2.syncNow();
    assert.strictEqual(sync.counts.synced, 6);
    assert.strictEqual(sync.counts.conflict, 1);
    assert.strictEqual(sync.counts.pending, 0);
    assert.strictEqual(sync2.counts.synced, 1);
    assert.strictEqual(sync2.counts.conflict, 0);

    const bills = (await request(mainUrl, 'GET', `/bills?org_id=${org.id}&fy=2026-27`, undefined, token)).payload;
    const synced = bills.find(bill => bill.offline_id === offline.bill.offline_id);
    assert.ok(synced);
    assert.strictEqual(synced.bill_number, offline.bill.bill_number);
    assert.ok(bills.find(bill => bill.offline_id === offline2.bill.offline_id));
    const syncedQuotation = bills.find(bill => bill.offline_id === offlineQuotation.bill.offline_id);
    assert.ok(syncedQuotation);
    assert.strictEqual(syncedQuotation.format, 'QUOT');
    const syncedJobs = (await request(mainUrl, 'GET', `/jobs?org_id=${org.id}`, undefined, token)).payload;
    const syncedJob = syncedJobs.find(job => job.provisional_token === offlineJob.token);
    assert.ok(syncedJob);
    assert.match(syncedJob.job_token, /^JOB-/);
    const syncedJobDetail = (await request(mainUrl, 'GET', `/jobs/${syncedJob.id}`, undefined, token)).payload;
    assert.strictEqual(syncedJobDetail.attachments[0].file_name, 'offline-reference.pdf');
    const syncedAssignedJob = (await request(mainUrl, 'GET', `/jobs/${assignedJob.id}`, undefined, token)).payload;
    assert.strictEqual(syncedAssignedJob.current_status, 'IN_PROGRESS');
    const syncedLocalCustomerJob = syncedJobs.find(job => job.provisional_token === offlineLocalCustomerJob.token);
    assert.ok(syncedLocalCustomerJob);
    assert.strictEqual(syncedLocalCustomerJob.customer.name, 'Home Planned Customer');
    const syncedParties = (await request(mainUrl, 'GET', `/parties?org_id=${org.id}`, undefined, token)).payload;
    assert.strictEqual(syncedParties.filter(row => row.name === 'Home Planned Customer').length, 1);
    const syncedIntakeItem = proxy.queue.items.find(row => row.id === 'offline-customer-intake-1');
    assert.strictEqual(syncedIntakeItem.status, 'synced');
    assert.match(syncedIntakeItem.central_number, /^INQ-/);
    const syncedIntakeStatus = (await request(mainUrl, 'GET',
      `/job-intake/status?org_id=${org.id}&order_id=${syncedIntakeItem.central_number}&phone=9999999999`)).payload;
    assert.strictEqual(syncedIntakeStatus.customer_name, 'Section Walkin Customer');

    const rejectedEdit = await fetch(`${mainUrl}/api/bills/${synced.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        bill_date: synced.bill_date,
        items: JSON.parse(synced.items_json),
        payment_mode: synced.payment_mode
      })
    });
    assert.strictEqual(rejectedEdit.status, 400);
    const emergencyEdit = (await request(mainUrl, 'PUT', `/bills/${synced.id}`, {
      bill_date: synced.bill_date,
      items: JSON.parse(synced.items_json),
      payment_mode: synced.payment_mode,
      emergency_reason: 'Corrected quantity during server outage review'
    }, token)).payload;
    assert.strictEqual(emergencyEdit.success, true);

    await request(proxyUrl, 'GET', `/bills?org_id=${org.id}&fy=2026-27`, undefined, offlineLogin.token);
    server.kill();
    await new Promise(resolve => setTimeout(resolve, 500));
    const cachedFull = (await request(proxyUrl, 'GET', `/bills/${synced.id}/full`, undefined, offlineLogin.token)).payload;
    assert.strictEqual(cachedFull.bill_number, synced.bill_number);
    const queuedEdit = (await request(proxyUrl, 'PUT', `/bills/${synced.id}`, {
      bill_date: synced.bill_date,
      items: JSON.parse(synced.items_json),
      payment_mode: synced.payment_mode,
      emergency_reason: 'Emergency correction entered while main system was off'
    }, offlineLogin.token)).payload;
    assert.strictEqual(queuedEdit.emergency_edit_pending, true);
    assert.strictEqual(proxy.getStatus().counts.pending, 1);
    startServer();
    await waitFor(`${mainUrl}/api/health`);
    const editSync = await proxy.syncNow();
    assert.strictEqual(editSync.counts.pending, 0);
    assert.strictEqual(editSync.counts.conflict, 1);

    const duplicate = (await request(mainUrl, 'POST', '/bills', {
      org_id: org.id, format: 'QUOT', bill_date: '2026-06-07', party_id: party.id,
      offline_id: offline.bill.offline_id, offline_number: offline.bill.bill_number,
      offline_device: 'C1', offline_device_id: 'DEV-CLIENT1', items: [{ item_id: item.id, item_name: 'Offline Item', qty: 2, rate: 100 }]
    }, token)).payload;
    assert.strictEqual(duplicate.sync_duplicate, true);
    const afterDuplicate = (await request(mainUrl, 'GET', `/bills?org_id=${org.id}&fy=2026-27`, undefined, token)).payload;
    assert.strictEqual(afterDuplicate.filter(bill => bill.offline_id === offline.bill.offline_id).length, 1);

    server.kill();
    await new Promise(resolve => setTimeout(resolve, 500));
    const revokedDeviceDraft = (await request(`http://127.0.0.1:${proxyPort2}`, 'POST', '/bills', {
      org_id: org.id, format: 'QUOT', bill_date: '2026-06-07', party_id: party.id,
      payment_mode: 'cash', items: [{ item_name: 'Must Be Wiped', qty: 1, rate: 25, amount: 25 }]
    }, token)).payload;
    assert.strictEqual(revokedDeviceDraft.offline_pending, true);
    assert.strictEqual(proxy2.getStatus().counts.pending, 1);
    proxy2.stop();
    startServer();
    await waitFor(`${mainUrl}/api/health`);
    const devices = (await request(mainUrl, 'GET', `/advanced/registered-devices?org_id=${org.id}`, undefined, token)).payload;
    const device2 = devices.find(row => row.device_id === 'DEV-CLIENT2');
    assert.ok(device2);
    await request(mainUrl, 'POST', `/advanced/registered-devices/${device2.id}/revoke`, {
      reason: 'Security test requires remote local data wipe'
    }, token);
    await proxy2.start();
    await proxy2.syncNow();
    assert.strictEqual(proxy2.getStatus().counts.pending, 0);
    assert.ok(proxy2.getStatus().local_wiped_at);
    const wipedPolicy = (await request(mainUrl, 'GET',
      `/advanced/registered-devices/policy?org_id=${org.id}&device_id=DEV-CLIENT2`, undefined, token)).payload;
    assert.strictEqual(wipedPolicy.wipe_required, false);
    const wipedBills = (await request(mainUrl, 'GET', `/bills?org_id=${org.id}&fy=2026-27`, undefined, token)).payload;
    assert.strictEqual(wipedBills.some(row => row.offline_id === revokedDeviceDraft.bill.offline_id), false);

    console.log('Offline synchronization integration tests passed');
  } finally {
    if (originProbe) await new Promise(resolve => originProbe.close(resolve));
    if (proxy) proxy.stop();
    if (proxy2) proxy2.stop();
    if (discoveryProxy) discoveryProxy.stop();
    if (server) server.kill();
    setTimeout(() => {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(clientDir, { recursive: true, force: true });
      fs.rmSync(`${clientDir}-2`, { recursive: true, force: true });
      fs.rmSync(`${clientDir}-discovery`, { recursive: true, force: true });
      fs.rmSync(recoveryClientDir, { recursive: true, force: true });
    }, 300);
  }
})().catch(error => {
  console.error(error);
  console.error(output);
  process.exitCode = 1;
});
