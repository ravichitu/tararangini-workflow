const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.transaction-control-profile-test');
const port = 3255;
fs.rmSync(dataDir, { recursive: true, force: true });

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), TARANGINI_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });

async function request(method, route, body, token, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch (_) { payload = text; }
  assert.strictEqual(response.status, expected, `${method} ${route}: ${text}\n${output}`);
  return payload;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Transaction-control profile test server did not start:\n${output}`);
}

(async () => {
  try {
    await waitForServer();
    const owner = await request('POST', '/auth/login', { username: 'owner1', password: 'owner123' });
    const source = await request('POST', '/orgs', {
      display_name: 'Profile Source Company', registered_name: 'Profile Source Company', gst_type: 'regular'
    }, owner.token);
    const target = await request('POST', '/orgs', {
      display_name: 'Profile Target Company', registered_name: 'Profile Target Company', gst_type: 'regular'
    }, owner.token);

    const sourceControls = await request('GET', `/orgs/${source.id}/transaction-controls`, undefined, owner.token);
    assert.strictEqual(sourceControls.controls.length, sourceControls.meta.length);
    const controls = sourceControls.controls.map(control => ({
      transaction_type: control.transaction_type,
      form_options: { ...control.form_options },
      required_fields: { ...control.required_fields },
      print_options: { ...control.print_options }
    }));
    const quotation = controls.find(control => control.transaction_type === 'QUOT');
    quotation.form_options.tracking = false;
    quotation.required_fields.tracking = false;
    quotation.print_options.tracking = false;
    await request('PUT', `/orgs/${source.id}/transaction-controls`, { controls }, owner.token);

    const propagated = await request('POST', `/orgs/${source.id}/transaction-controls/propagate`, {
      target_org_ids: [target.id], use_for_future_companies: true
    }, owner.token);
    assert.strictEqual(propagated.updated_companies, 1);
    assert.strictEqual(propagated.future_company_default, true);

    const targetControls = await request('GET', `/orgs/${target.id}/transaction-controls`, undefined, owner.token);
    assert.strictEqual(targetControls.controls.length, sourceControls.meta.length);
    const targetQuotation = targetControls.controls.find(control => control.transaction_type === 'QUOT');
    assert.strictEqual(targetQuotation.form_options.tracking, false);
    assert.strictEqual(targetQuotation.required_fields.tracking, false);
    assert.strictEqual(targetQuotation.print_options.tracking, false);

    const future = await request('POST', '/orgs', {
      display_name: 'Profile Future Company', registered_name: 'Profile Future Company', gst_type: 'regular'
    }, owner.token);
    const futureControls = await request('GET', `/orgs/${future.id}/transaction-controls`, undefined, owner.token);
    assert.strictEqual(futureControls.controls.length, sourceControls.meta.length);
    const futureQuotation = futureControls.controls.find(control => control.transaction_type === 'QUOT');
    assert.strictEqual(futureQuotation.form_options.tracking, false);
    assert.strictEqual(futureQuotation.required_fields.tracking, false);
    assert.strictEqual(futureQuotation.print_options.tracking, false);
    console.log('Transaction-control profile integration tests passed');
  } finally {
    server.kill();
    await new Promise(resolve => {
      if (server.exitCode !== null) return resolve();
      const timeout = setTimeout(resolve, 1500);
      server.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
