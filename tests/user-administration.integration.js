const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.user-admin-test');
const port = 3214;
fs.rmSync(dataDir, { recursive: true, force: true });

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), TARANGINI_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });

async function request(method, route, body, token, expectedStatus = 200) {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch (_) { payload = text; }
  assert.strictEqual(response.status, expectedStatus, `${method} ${route}: ${text}\n${output}`);
  assert.notStrictEqual(String(response.headers.get('content-type')), 'text/html; charset=utf-8');
  return payload;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(output);
}

(async () => {
  try {
    await waitForServer();
    const owner1 = await request('POST', '/auth/login', { username: 'owner1', password: 'owner123' });
    const orgA = await request('POST', '/orgs', {
      display_name: 'User Admin A', registered_name: 'User Admin A', gst_type: 'regular'
    }, owner1.token);
    const orgB = await request('POST', '/orgs', {
      display_name: 'User Admin B', registered_name: 'User Admin B', gst_type: 'regular'
    }, owner1.token);
    const posItem = await request('POST', '/items', {
      org_id: orgA.id, name: 'Mobile POS Item', hsn_code: '84716040', unit: 'NOS', gst_rate: 18,
      last_sale_price: 100, opening_stock: 10, barcode: 'MOBILEPOS1'
    }, owner1.token);

    const secondOwner = await request('POST', '/auth/users', {
      name: 'Second Owner Test', username: 'secondowner-test', pin: '2202',
      role: 'owner', org_access: 'all', permissions: {}
    }, owner1.token);
    const operator = await request('POST', '/auth/users', {
      name: 'Operator Test', username: 'operator-test', pin: '3303',
      role: 'operator', org_access: JSON.stringify([orgA.id]),
      permissions: { billing: true, pos: true, inventory: false, reports: false, settings: false }
    }, owner1.token);

    const owner2Login = await request('POST', '/auth/login', {
      username: 'secondowner-test', pin: '2202'
    });
    await request('POST', '/auth/users', {
      name: 'Forbidden User', username: 'forbidden-user', password: 'forbidden123',
      role: 'operator', org_access: 'all'
    }, owner2Login.token, 403);
    await request('POST', `/auth/users/${operator.id}/reset-pin`, {
      new_pin: '4404'
    }, owner2Login.token, 403);

    let operatorLogin = await request('POST', '/auth/login', {
      username: 'operator-test', pin: '3303'
    });
    await request('GET', `/parties?org_id=${orgA.id}`, undefined, operatorLogin.token);
    await request('GET', `/parties?org_id=${orgB.id}`, undefined, operatorLogin.token, 403);
    await request('GET', '/auth/users', undefined, operatorLogin.token, 403);
    const orgAStaff = await request('GET', `/jobs/staff?org_id=${orgA.id}`, undefined, owner1.token);
    const orgBStaff = await request('GET', `/jobs/staff?org_id=${orgB.id}`, undefined, owner1.token);
    assert.ok(orgAStaff.some(user => user.id === operator.id));
    assert.ok(!orgBStaff.some(user => user.id === operator.id));
    const operatorShift = await request('POST', '/advanced/shifts/open', {
      org_id: orgA.id, counter_name: 'Mobile Counter', opening_cash: 0
    }, operatorLogin.token);
    assert.strictEqual(operatorShift.shift.status, 'open');
    const operatorHeld = await request('POST', '/advanced/held-bills', {
      org_id: orgA.id, shift_id: operatorShift.shift.id, hold_name: 'Mobile held bill',
      cart: { items: [{ item_id: posItem.id, item_name: posItem.name, qty: 1, rate: 100 }] }
    }, operatorLogin.token);
    assert.ok(operatorHeld.id);
    assert.strictEqual(
      (await request('GET', `/advanced/held-bills?org_id=${orgA.id}`, undefined, operatorLogin.token)).length,
      1
    );
    const operatorSale = await request('POST', '/bills', {
      org_id: orgA.id, format: 'SALE', bill_date: '2026-06-09',
      payment_mode: 'cash', split_payments: [{ mode: 'cash', amount: 118 }],
      shift_id: operatorShift.shift.id,
      items: [{ item_id: posItem.id, item_name: posItem.name, qty: 1, unit: 'NOS',
        rate: 100, amount: 100, gst_rate: 18 }]
    }, operatorLogin.token);
    assert.strictEqual(operatorSale.bill.grand_total, 118);

    await request('PUT', `/auth/users/${operator.id}`, {
      name: 'Operator Updated', username: 'operator-test', role: 'operator',
      org_access: JSON.stringify([orgA.id, orgB.id]),
      permissions: { billing: true, pos: true, inventory: true, reports: true, settings: false },
      active: true
    }, owner1.token);
    await request('GET', '/auth/me', undefined, operatorLogin.token, 401);
    operatorLogin = await request('POST', '/auth/login', {
      username: 'operator-test', pin: '3303'
    });
    await request('GET', `/parties?org_id=${orgB.id}`, undefined, operatorLogin.token);

    await request('POST', `/auth/users/${operator.id}/reset-pin`, {
      new_pin: '4404'
    }, owner1.token);
    await request('GET', '/auth/me', undefined, operatorLogin.token, 401);
    await request('POST', '/auth/login', {
      username: 'operator-test', pin: '3303'
    }, undefined, 401);
    operatorLogin = await request('POST', '/auth/login', {
      username: 'operator-test', pin: '4404'
    });
    assert.strictEqual(operatorLogin.user.role, 'operator');
    await request('POST', '/auth/change-pin', {
      current_pin: '4404', new_pin: '6606'
    }, operatorLogin.token);
    await request('POST', '/auth/login', {
      username: 'operator-test', pin: '4404'
    }, undefined, 401);
    operatorLogin = await request('POST', '/auth/login', {
      username: 'operator-test', pin: '6606'
    });

    await request('PUT', `/auth/users/${secondOwner.id}`, {
      name: 'Second Owner Updated', username: 'secondowner-test', role: 'owner',
      org_access: 'all', permissions: {}, active: true
    }, owner1.token);
    await request('POST', `/auth/users/${secondOwner.id}/reset-pin`, {
      new_pin: '5505'
    }, owner1.token);
    await request('GET', '/auth/me', undefined, owner2Login.token, 401);
    await request('POST', '/auth/login', {
      username: 'secondowner-test', pin: '2202'
    }, undefined, 401);
    const resetOwner2 = await request('POST', '/auth/login', {
      username: 'secondowner-test', pin: '5505'
    });
    assert.strictEqual(resetOwner2.user.role, 'owner');

    const users = await request('GET', '/auth/users', undefined, owner1.token);
    const primary = users.find(user => user.username === 'owner1');
    await request('PUT', `/auth/users/${primary.id}`, {
      name: primary.name, username: primary.username, role: 'operator',
      org_access: JSON.stringify([orgA.id]), permissions: {}, active: false
    }, owner1.token, 400);
    await request('PUT', `/auth/users/${operator.id}`, {
      name: 'Operator Updated', username: 'operator-test', role: 'operator',
      org_access: JSON.stringify([orgA.id, orgB.id]), permissions: { billing: true }, active: false
    }, owner1.token);
    await request('GET', '/auth/me', undefined, operatorLogin.token, 401);
    await request('POST', '/auth/login', {
      username: 'operator-test', pin: '6606'
    }, undefined, 401);

    const audit = await request('GET', '/auth/users-audit', undefined, owner1.token);
    const actions = new Set(audit.map(row => row.action));
    assert.ok(actions.has('CREATE_USER'));
    assert.ok(actions.has('UPDATE_USER'));
    assert.ok(actions.has('RESET_USER_PIN'));
    assert.ok(actions.has('CHANGE_OWN_PIN'));
    assert.ok(audit.every(row => !/4404|6606/.test(String(row.new_data || ''))));

    console.log('User administration integration tests passed');
  } catch (error) {
    console.error(error);
    console.error(output);
    process.exitCode = 1;
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
})();
