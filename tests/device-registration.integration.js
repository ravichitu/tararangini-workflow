const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.device-registration-test');
const port = 3222;
fs.rmSync(dataDir, { recursive: true, force: true });

let server;
let output = '';
async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start: ${output}`);
}
async function request(method, route, body, token) {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = {};
  try { payload = await response.json(); } catch (_) {}
  return { response, payload };
}

(async () => {
  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: root, env: { ...process.env, PORT: String(port), TARANGINI_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => { output += chunk; });
    server.stderr.on('data', chunk => { output += chunk; });
    await waitForServer();
    const owner = (await request('POST', '/auth/login', { username: 'owner1', password: 'owner123' })).payload;
    const operator = (await request('POST', '/auth/login', { username: 'operator1', password: 'operator123' })).payload;
    const org = (await request('POST', '/orgs', { display_name: 'Device Registry Test' }, owner.token)).payload;
    const registration = await request('POST', '/advanced/registered-devices', {
      org_id: org.id, device_id: 'DEV-TEST-001', device_name: 'Take Home Laptop', assigned_to: 'Operator',
      fingerprint: 'TEST-FINGERPRINT', mac_references: ['AA:BB:CC:DD:EE:FF']
    }, owner.token);
    assert.strictEqual(registration.response.status, 201);
    assert.strictEqual(registration.payload.device.status, 'active');
    const listed = await request('GET', `/advanced/registered-devices?org_id=${org.id}`, undefined, owner.token);
    assert.strictEqual(listed.response.status, 200);
    assert.strictEqual(listed.payload.length, 1);
    assert.strictEqual((await request('POST', '/advanced/registered-devices', {
      org_id: org.id, device_id: 'DEV-TEST-001'
    }, owner.token)).response.status, 409);
    assert.strictEqual((await request('POST', `/advanced/registered-devices/${registration.payload.device.id}/revoke`, {
      reason: 'lost laptop'
    }, owner.token)).response.status, 200);
    const revokedPolicy = await request('GET', `/advanced/registered-devices/policy?org_id=${org.id}&device_id=DEV-TEST-001`, undefined, owner.token);
    assert.strictEqual(revokedPolicy.response.status, 200);
    assert.strictEqual(revokedPolicy.payload.active, false);
    assert.strictEqual(revokedPolicy.payload.wipe_required, true);
    assert.strictEqual((await request('GET',
      `/advanced/sync/snapshot?org_id=${org.id}&device_id=DEV-TEST-001`, undefined, owner.token)).response.status, 403);
    const wipeAck = await request('POST', '/advanced/registered-devices/wipe-ack', {
      org_id: org.id, device_id: 'DEV-TEST-001'
    }, owner.token);
    assert.strictEqual(wipeAck.response.status, 200);
    const acknowledgedPolicy = await request('GET', `/advanced/registered-devices/policy?org_id=${org.id}&device_id=DEV-TEST-001`, undefined, owner.token);
    assert.strictEqual(acknowledgedPolicy.payload.wipe_required, false);
    const reactivated = await request('POST', '/advanced/registered-devices', {
      org_id: org.id, device_id: 'DEV-TEST-001', device_name: 'Returned Laptop'
    }, owner.token);
    assert.strictEqual(reactivated.response.status, 200);
    assert.strictEqual(reactivated.payload.device.status, 'active');
    assert.strictEqual(reactivated.payload.device.wipe_requested_at, null);
    const snapshotParty = (await request('POST', '/parties', {
      org_id: org.id, type: 'customer', name: 'Snapshot Company Customer'
    }, owner.token)).payload;
    const otherOrg = (await request('POST', '/orgs', { display_name: 'Other Snapshot Company' }, owner.token)).payload;
    await request('POST', '/parties', { org_id: otherOrg.id, type: 'customer', name: 'Must Not Leak' }, owner.token);
    const snapshot = await request('GET',
      `/advanced/sync/snapshot?org_id=${org.id}&device_id=DEV-TEST-001`, undefined, owner.token);
    assert.strictEqual(snapshot.response.status, 200);
    assert.strictEqual(snapshot.payload.schema_version, 1);
    assert.match(snapshot.payload.checksum_sha256, /^[a-f0-9]{64}$/);
    assert.strictEqual(snapshot.payload.org.id, org.id);
    assert.ok(snapshot.payload.tables.parties.some(row => row.name === 'Snapshot Company Customer'));
    assert.strictEqual(snapshot.payload.tables.parties.some(row => row.name === 'Must Not Leak'), false);
    assert.strictEqual(Object.hasOwn(snapshot.payload.tables, 'users'), false);
    assert.strictEqual(Object.hasOwn(snapshot.payload.tables, 'sessions'), false);
    await request('POST', '/parties', { org_id: otherOrg.id, type: 'customer', name: 'Other Company Later Change' }, owner.token);
    const updatedParty = await request('PUT', `/parties/${snapshotParty.id}`, {
      type: 'customer', name: 'Snapshot Company Customer Updated', phone: '9000000000'
    }, owner.token);
    assert.strictEqual(updatedParty.response.status, 200);
    const delta = await request('GET',
      `/advanced/sync/delta?org_id=${org.id}&device_id=DEV-TEST-001&after_revision=${snapshot.payload.revision}`,
      undefined, owner.token);
    assert.strictEqual(delta.response.status, 200);
    assert.strictEqual(delta.payload.snapshot_required, true);
    assert.ok(delta.payload.changes.some(change =>
      change.entity_type === 'parties' && Number(change.entity_id) === Number(snapshotParty.id) && change.operation === 'UPDATE'));
    assert.strictEqual(delta.payload.changes.some(change => change.entity_type === 'users'), false);
    const noChanges = await request('GET',
      `/advanced/sync/delta?org_id=${org.id}&device_id=DEV-TEST-001&after_revision=${delta.payload.current_revision}`,
      undefined, owner.token);
    assert.strictEqual(noChanges.payload.snapshot_required, false);
    assert.strictEqual(noChanges.payload.changes.length, 0);
    assert.strictEqual((await request('GET',
      `/advanced/sync/delta?org_id=${org.id}&device_id=DEV-UNKNOWN-999&after_revision=0`,
      undefined, owner.token)).response.status, 403);
    assert.strictEqual((await request('GET', `/advanced/registered-devices?org_id=${org.id}`, undefined, operator.token)).response.status, 403);
    console.log('Device registration integration tests passed');
  } finally {
    if (server) server.kill();
    setTimeout(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), 300);
  }
})().catch(error => { console.error(error); console.error(output); process.exitCode = 1; });
