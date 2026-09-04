const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { runBatch, main } = require('../tools/web-invoice-batch');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.web-invoice-batch-test');
const reportDir = path.join(root, '.web-invoice-batch-reports');
const port = 3247;
fs.rmSync(dataDir, { recursive: true, force: true });
fs.rmSync(reportDir, { recursive: true, force: true });
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), TARANGINI_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });

async function waitForServer() {
  for (let i = 0; i < 160; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Test server did not start.\n${output}`);
}

async function api(route, token) {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `${response.status}`);
  return payload;
}

async function stopServer() {
  if (server.exitCode !== null || server.signalCode) return;
  await new Promise(resolve => {
    const timeout = setTimeout(resolve, 5000);
    server.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    server.kill();
  });
}

(async () => {
  try {
    await waitForServer();
    const base = {
      server: `http://127.0.0.1:${port}`,
      username: 'operator1',
      secret: 'operator123',
      orgId: 1,
      count: 3,
      batchId: 'QA-OPERATOR-ROLE-TEST',
      itemName: 'Web Batch Test Service',
      partyName: 'Web Batch Customer - QA Operator Role Test',
      billDate: '2026-08-16',
      reportPath: path.join(reportDir, 'commit.json')
    };

    const created = await runBatch({ ...base, commit: true });
    assert.strictEqual(created.status, 'commit-complete');
    assert.strictEqual(created.actor.role, 'operator');
    assert.strictEqual(created.organization.id, 1);
    assert.strictEqual(created.created.length, 3);
    assert.strictEqual(created.reused.length, 0);
    assert.ok(created.verification.every(row => row.valid && row.created_by === 'operator1'));

    const rerun = await runBatch({ ...base, commit: true, reportPath: path.join(reportDir, 'rerun.json') });
    assert.strictEqual(rerun.status, 'commit-complete');
    assert.strictEqual(rerun.created.length, 0);
    assert.strictEqual(rerun.reused.length, 3);
    assert.ok(rerun.verification.every(row => row.valid));

    const dryRun = await runBatch({
      ...base,
      commit: false,
      count: 2,
      batchId: 'QA-OPERATOR-DRY-RUN',
      reportPath: path.join(reportDir, 'dry-run.json')
    });
    assert.strictEqual(dryRun.status, 'dry-run-complete');
    assert.strictEqual(dryRun.created.length, 0);
    assert.strictEqual(dryRun.planned.length, 2);

    const loginResponse = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner1', password: 'owner123' })
    });
    const owner = await loginResponse.json();
    const bills = await api('/bills?org_id=1&format=SALE&search=QA-OPERATOR-ROLE-TEST&limit=50', owner.token);
    assert.strictEqual(bills.length, 3, 'The rerun must not create duplicate invoices.');
    const dryBills = await api('/bills?org_id=1&format=SALE&search=QA-OPERATOR-DRY-RUN&limit=50', owner.token);
    assert.strictEqual(dryBills.length, 0, 'Dry-run must not write invoices.');
    const reportText = fs.readFileSync(path.join(reportDir, 'commit.json'), 'utf8');
    assert.ok(!reportText.includes('operator123'), 'Reports must never contain login secrets.');
    const failedReport = path.join(reportDir, 'parse-failure.json');
    assert.strictEqual(await main(['--not-a-real-option', '--report', failedReport]), 1);
    assert.match(fs.readFileSync(failedReport, 'utf8'), /Unknown option/);
    console.log('Web invoice batch integration tests passed');
  } finally {
    await stopServer();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
