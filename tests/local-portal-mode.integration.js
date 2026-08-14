const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { OfflineProxy } = require('../electron/offline-proxy');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public', 'app-2.4.0.js'), 'utf8');
const electronMain = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const firewallScript = fs.readFileSync(path.join(root, 'tools', 'windows-firewall', 'tarangini-firewall.ps1'), 'utf8');
const apiFunction = appSource.slice(appSource.indexOf('async function api('), appSource.indexOf('function showLoading('));
assert.ok(appSource.includes('Continue Locally for 1 Hour'));
assert.ok(appSource.includes('60 * 60 * 1000'));
assert.ok(apiFunction.includes('noteClientOffline('));
assert.ok(!apiFunction.includes('showClientOfflineScreen('));
assert.match(electronMain, /portalWillBeEnabled[\s\S]*runFirewallScript\('enable'\)/);
assert.match(electronMain, /portalWasEnabled[\s\S]*runFirewallScript\('disable'\)/);
assert.match(firewallScript, /-Profile Private/);
assert.match(firewallScript, /-Direction Inbound/);
assert.match(firewallScript, /-Protocol TCP/);
assert.match(firewallScript, /-RemoteAddress LocalSubnet/);
assert.match(firewallScript, /\[int\]\$Port = 3001/);
assert.match(firewallScript, /Remove-NetFirewallRule/);
const clientDir = path.join(root, '.local-portal-mode-test');
const proxyPort = 3253;
fs.rmSync(clientDir, { recursive: true, force: true });

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for offline proxy');
}

async function request(baseUrl, method, route, body, token) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = {};
  try { payload = await response.json(); } catch (_) {}
  return { response, payload };
}

(async () => {
  const proxy = new OfflineProxy({
    appPath: root,
    userData: clientDir,
    serverUrl: 'http://127.0.0.1:3999',
    deviceCode: 'PORTAL-TEST',
    port: proxyPort,
    portalLanEnabled: true,
    deviceIdentity: { deviceId: 'DEV-PORTAL-001', systemName: 'PORTAL-TEST', displayName: 'Portal Test' },
    protectToken: value => value,
    unprotectToken: value => value,
    protectData: value => value,
    unprotectData: value => value
  });
  try {
    proxy.cache['/api/orgs'] = {
      content_type: 'application/json', body: Buffer.from(JSON.stringify([{ id: 1, display_name: 'Portal Test Store' }])).toString('base64')
    };
    proxy.cache['/api/job-intake/config?org_id=1'] = {
      content_type: 'application/json', body: Buffer.from(JSON.stringify({
        org: { id: 1, name: 'Portal Test Store' }, services: [], service_groups: []
      })).toString('base64')
    };
    proxy.cache.offline_users = {
      owner1: { response: Buffer.from(JSON.stringify({ token: 'portal-owner-token', user: { id: 1, role: 'owner' } })).toString('base64') }
    };
    proxy.saveCache();
    await proxy.start();
    await waitFor(() => proxy.lastError && proxy.online === false);
    const baseUrl = `http://127.0.0.1:${proxyPort}`;
    const status = proxy.getStatus();
    assert.strictEqual(status.portal_lan_enabled, true);
    assert.match(status.portal_base_url, /^http:\/\//);

    const config = await request(baseUrl, 'GET', '/api/job-intake/config?org_id=1');
    assert.strictEqual(config.response.status, 200);
    assert.strictEqual(config.payload.org.name, 'Portal Test Store');
    const qr = await request(baseUrl, 'GET', '/api/offline/local-portal-link?org_id=1', undefined, 'portal-owner-token');
    assert.strictEqual(qr.response.status, 200);
    assert.match(qr.payload.url, /customer-intake\.html\?org=1$/);
    assert.match(qr.payload.qr_data_url, /^data:image\/png;base64,/);

    const staffApi = await request(baseUrl, 'GET', '/api/orgs');
    assert.strictEqual(staffApi.response.status, 401);

    const intakeBody = {
      org_id: 1, client_request_id: 'portal-local-001', customer_name: 'LAN Customer',
      customer_phone: '9999999999', issue_summary: 'Local portal order',
      issue_details: 'Submitted while Main System is offline', consent_status: 'CONFIRMED'
    };
    const submitted = await request(baseUrl, 'POST', '/api/job-intake/submit', intakeBody);
    assert.strictEqual(submitted.response.status, 202);
    assert.strictEqual(submitted.payload.offline_pending, true);
    const duplicate = await request(baseUrl, 'POST', '/api/job-intake/submit', intakeBody);
    assert.strictEqual(duplicate.response.status, 202);
    assert.strictEqual(duplicate.payload.duplicate, true);
    assert.strictEqual(duplicate.payload.order_id, submitted.payload.order_id);

    const tracked = await request(baseUrl, 'GET', `/api/job-intake/status?org_id=1&order_id=${encodeURIComponent(submitted.payload.order_id)}&phone=9999999999`);
    assert.strictEqual(tracked.response.status, 200);
    assert.strictEqual(tracked.payload.request_status, 'LOCAL_PENDING');
    console.log('Local portal mode integration tests passed');
  } finally {
    proxy.stop();
    setTimeout(() => fs.rmSync(clientDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), 300);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
