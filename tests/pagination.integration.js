const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.pagination-test');
const port = 3255;
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
  throw new Error(`Pagination server did not start:\n${output}`);
}

async function request(route, token) {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch (_) { payload = text; }
  assert.strictEqual(response.status, 200, `${route}: ${text}\n${output}`);
  return { payload, headers: response.headers };
}

(async () => {
  try {
    await waitForServer();
    const loginResponse = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner1', password: 'owner123' })
    });
    const login = await loginResponse.json();
    assert.strictEqual(loginResponse.status, 200);

    for (const route of [
      '/parties?org_id=1&limit=1&offset=0',
      '/items?org_id=1&limit=1&offset=0',
      '/jobs?org_id=1&limit=1&offset=0'
    ]) {
      const result = await request(route, login.token);
      assert.ok(Array.isArray(result.payload));
      assert.ok(result.payload.length <= 1);
      assert.ok(Number(result.headers.get('x-total-count')) >= result.payload.length);
      assert.strictEqual(result.headers.get('x-page-limit'), '1');
      assert.strictEqual(result.headers.get('x-page-offset'), '0');
    }

    const secondPage = await request('/items?org_id=1&limit=1&offset=1', login.token);
    assert.strictEqual(secondPage.headers.get('x-page-offset'), '1');
    console.log('Pagination integration tests passed');
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
