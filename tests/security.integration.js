const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { hostAllowed } = require('../src/security/runtime-config');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.security-test');
const port = 3231;
fs.rmSync(dataDir, { recursive: true, force: true });
assert.strictEqual(hostAllowed({ hostname: '192.168.1.10', headers: { host: '192.168.1.10:3000' }, ip: '192.168.1.25' }), true);
assert.strictEqual(hostAllowed({ hostname: '10.0.0.5', headers: { host: '10.0.0.5:3000' }, ip: '10.0.0.20' }), true);

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    TARANGINI_DATA_DIR: dataDir,
    TARANGINI_ALLOWED_ORIGINS: 'https://allowed.example',
    TARANGINI_TRUST_PROXY: '1',
    TARANGINI_ADMIN_ALLOWED_IPS: '127.0.0.1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Security test server did not start:\n${output}`);
}

async function request(method, route, body, token, expected = 200, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch (_) { payload = text; }
  assert.strictEqual(response.status, expected, `${method} ${route}: ${text}\n${output}`);
  return { payload, response };
}

(async () => {
  try {
    await waitForServer();
    const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Origin: 'https://evil.example' }
    });
    assert.strictEqual(health.headers.get('access-control-allow-origin'), null);
    assert.strictEqual(health.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(health.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(health.headers.get('referrer-policy'), 'no-referrer');

    const allowed = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Origin: 'https://allowed.example' }
    });
    assert.strictEqual(allowed.headers.get('access-control-allow-origin'), 'https://allowed.example');

    const owner = (await request('POST', '/auth/login', {
      username: 'owner1', password: 'owner123'
    })).payload;
    await request('POST', '/auth/users', {
      name: 'Blocked Admin Action', username: 'blocked-admin', pin: '8844', role: 'operator'
    }, owner.token, 403, { 'X-Forwarded-For': '198.51.100.20' });
    const orgA = (await request('POST', '/orgs', {
      display_name: 'Security A', registered_name: 'Security A', gst_type: 'regular'
    }, owner.token)).payload;
    const orgB = (await request('POST', '/orgs', {
      display_name: 'Security B', registered_name: 'Security B', gst_type: 'regular'
    }, owner.token)).payload;
    const partyB = (await request('POST', '/parties', {
      org_id: orgB.id, type: 'customer', name: 'Restricted Customer'
    }, owner.token)).payload;
    const itemB = (await request('POST', '/items', {
      org_id: orgB.id, name: 'Restricted Item', hsn_code: '84716040', unit: 'NOS', gst_rate: 18, last_sale_price: 100
    }, owner.token)).payload;
    const billB = (await request('POST', '/bills', {
      org_id: orgB.id, format: 'SALE', bill_date: '2026-06-13',
      party_id: partyB.id, payment_mode: 'cash',
      items: [{ item_id: itemB.id, item_name: 'Restricted Item', qty: 1, unit: 'NOS',
        rate: 100, amount: 100, gst_rate: 18 }]
    }, owner.token)).payload;
    await request('POST', '/auth/users', {
      name: 'Restricted Operator', username: 'restricted-operator', pin: '7319',
      role: 'operator', org_access: JSON.stringify([orgA.id]),
      permissions: { billing: true, inventory: true, reports: true, pos: true }
    }, owner.token);
    const operator = (await request('POST', '/auth/login', {
      username: 'restricted-operator', pin: '7319'
    })).payload;

    await request('GET', `/orgs/${orgB.id}`, undefined, operator.token, 403);
    await request('GET', `/parties/${partyB.id}`, undefined, operator.token, 403);
    await request('GET', `/items/${itemB.id}`, undefined, operator.token, 403);
    await request('GET', `/bills/${billB.id}`, undefined, operator.token, 403);
    await request('GET', `/bills/${billB.id}/full`, undefined, operator.token, 403);
    await request('GET', `/advanced/invoice-qr/${billB.id}`, undefined, operator.token, 403);
    await request('PUT', `/items/${itemB.id}`, {
      name: 'Tampered', hsn_code: '84716060', unit: 'NOS', gst_rate: 18
    }, operator.token, 403);
    await request('DELETE', `/parties/${partyB.id}`, undefined, operator.token, 403);
    const visibleBills = (await request('GET', '/bills', undefined, operator.token)).payload;
    assert.ok(visibleBills.every(bill => Number(bill.org_id) === Number(orgA.id)));

    const serviceWorker = fs.readFileSync(path.join(root, 'public', 'service-worker.js'), 'utf8');
    assert.match(serviceWorker, /url\.pathname\.startsWith\('\/api\/'\)/);
    assert.doesNotMatch(serviceWorker, /cache\.put\(request[\s\S]*\/api\//);
    console.log('Security integration tests passed');
  } finally {
    if (!server.killed) {
      server.kill();
      await new Promise(resolve => {
        server.once('exit', resolve);
        setTimeout(resolve, 2000);
      });
    }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => {
  console.error(error);
  console.error(output);
  process.exitCode = 1;
});
