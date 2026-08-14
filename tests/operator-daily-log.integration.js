const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.operator-log-test');
const port = 3253;
fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

let output = '';
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), TARANGINI_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Operator log server did not start:\n${output}`);
}

async function request(method, route, body, token, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch (_) { payload = text; }
  assert.strictEqual(response.status, expected, `${method} ${route}: ${text}\n${output}`);
  return payload;
}

function indiaDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

(async () => {
  try {
    await waitForServer();
    const owner = await request('POST', '/auth/login', { username: 'owner1', password: 'owner123' });
    const org = await request('POST', '/orgs', {
      display_name: 'Daily Log Test Company', registered_name: 'Daily Log Test Company'
    }, owner.token);
    const operator = await request('POST', '/auth/users', {
      name: 'Daily Log Operator', username: 'daily-log-operator', pin: '5417', role: 'operator',
      org_access: JSON.stringify([org.id]),
      permissions: { billing: true, pos: true, inventory: false, reports: false, jobs_operator: true }
    }, owner.token);
    const operatorLogin = await request('POST', '/auth/login', { username: 'daily-log-operator', pin: '5417' });
    const ownerBill = (await request('POST', '/bills', {
      org_id: org.id, format: 'QUOT', bill_date: indiaDate(), payment_mode: 'credit',
      items: [{ item_name: 'Owner consultation', qty: 1, unit: 'NOS', rate: 100, amount: 100 }]
    }, owner.token)).bill;
    const operatorBill = (await request('POST', '/bills', {
      org_id: org.id, format: 'QUOT', bill_date: indiaDate(), payment_mode: 'credit',
      items: [{ item_name: 'Operator service', qty: 1, unit: 'NOS', rate: 200, amount: 200 }]
    }, operatorLogin.token)).bill;

    const visibleBills = await request('GET', `/bills?org_id=${org.id}`, undefined, operatorLogin.token);
    assert.deepStrictEqual(visibleBills.map(row => Number(row.id)), [Number(operatorBill.id)]);
    await request('GET', `/bills/${ownerBill.id}/full`, undefined, operatorLogin.token, 404);
    await request('POST', '/advanced/duplicate', {
      type: 'bill', id: ownerBill.id, org_id: org.id, date: indiaDate()
    }, operatorLogin.token, 404);
    const hiddenSearch = await request(
      'GET', `/advanced/transaction-search?org_id=${org.id}&q=${encodeURIComponent(ownerBill.bill_number)}`,
      undefined, operatorLogin.token
    );
    assert.strictEqual(hiddenSearch.some(row => row.source === 'bill' && Number(row.id) === Number(ownerBill.id)), false);

    const editPayload = {
      bill_date: indiaDate(), payment_mode: 'credit',
      items: [{ item_name: 'Operator service corrected', qty: 1, unit: 'NOS', rate: 210, amount: 210 }]
    };
    await request('PUT', `/bills/${operatorBill.id}`, editPayload, operatorLogin.token, 400);
    await request('PUT', `/bills/${operatorBill.id}`, {
      ...editPayload, edit_reason: 'Corrected service rate after customer confirmation'
    }, operatorLogin.token);

    const date = indiaDate();
    const logUsers = await request('GET', `/operator-logs/users?org_id=${org.id}`, undefined, owner.token);
    assert.ok(logUsers.some(user => Number(user.id) === Number(owner.user.id) && user.role === 'owner'));
    await request('POST', '/operator-logs/entries', {
      org_id: org.id, work_date: date, entry_type: 'ADMIN', title: 'Owner priority review',
      work_done: 'Reviewed the next-day work plan and customer follow-ups.',
      pending_work: 'Confirm one pending customer approval', duration_minutes: 20
    }, owner.token);
    const ownerLog = await request('GET', `/operator-logs?org_id=${org.id}&date=${date}`, undefined, owner.token);
    assert.strictEqual(ownerLog.totals.manual_count, 1);
    assert.ok(ownerLog.entries.some(row => row.title === 'Owner priority review'));
    await request('POST', '/operator-logs/entries', {
      org_id: org.id, work_date: date, entry_type: 'MAINTENANCE', title: 'Cleaned production printer',
      work_done: 'Cleaned rollers and completed a test print successfully.',
      pending_work: 'Replace pickup roller when stock arrives', duration_minutes: 35,
      file_names: ['C:\\Customers\\secret\\test-output.pdf', '../private/photo.jpg', 'test-output.pdf']
    }, operatorLogin.token);
    let logData = await request('GET', `/operator-logs?org_id=${org.id}&date=${date}`, undefined, operatorLogin.token);
    assert.strictEqual(logData.totals.manual_count, 1);
    assert.ok(logData.entries.some(row => row.entry_type === 'BILL_CREATED'));
    assert.ok(logData.entries.some(row => row.entry_type === 'BILL_EDITED' && /customer confirmation/.test(row.work_done)));
    const manual = logData.entries.find(row => !row.auto_generated);
    assert.deepStrictEqual(manual.file_names.sort(), ['photo.jpg', 'test-output.pdf'].sort());
    assert.strictEqual(JSON.stringify(manual).includes('Customers'), false);

    const submitted = await request('POST', '/operator-logs/submit', {
      org_id: org.id, work_date: date,
      daily_summary: 'Completed customer quotation and printer maintenance.',
      pending_summary: 'Pickup roller replacement remains pending.'
    }, operatorLogin.token);
    assert.strictEqual(submitted.status, 'SUBMITTED');
    await request('POST', '/operator-logs/entries', {
      org_id: org.id, work_date: date, title: 'Late change', work_done: 'Should remain locked.'
    }, operatorLogin.token, 423);

    const ownerSummary = await request('GET', `/operator-logs/summary?org_id=${org.id}&date=${date}`, undefined, owner.token);
    const operatorSummary = ownerSummary.find(row => Number(row.id) === Number(operator.id));
    assert.strictEqual(operatorSummary.status, 'SUBMITTED');
    await request('POST', `/operator-logs/${submitted.id}/review`, {
      decision: 'REOPENED', note: 'Add the final customer callback outcome'
    }, owner.token);
    await request('POST', '/operator-logs/entries', {
      org_id: org.id, work_date: date, entry_type: 'CUSTOMER_SUPPORT',
      title: 'Customer callback', work_done: 'Confirmed completion and informed customer.'
    }, operatorLogin.token);
    logData = await request('GET', `/operator-logs?org_id=${org.id}&date=${date}&user_id=${operator.id}`, undefined, owner.token);
    assert.strictEqual(logData.totals.manual_count, 2);
    assert.strictEqual(logData.log.status, 'REOPENED');

    const exported = await request('GET', `/backup/export?org_id=${org.id}`, undefined, owner.token);
    assert.strictEqual(exported.operator_daily_logs.length, 2);
    assert.strictEqual(exported.operator_log_entries.length, 3);
    assert.strictEqual(JSON.stringify(exported.operator_log_entries).includes('Cleaned production printer'), true);

    console.log('Operator daily log integration tests passed');
  } finally {
    server.kill();
    await new Promise(resolve => {
      server.once('exit', resolve);
      setTimeout(resolve, 2000);
    });
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => {
  console.error(error);
  console.error(output);
  process.exitCode = 1;
});
