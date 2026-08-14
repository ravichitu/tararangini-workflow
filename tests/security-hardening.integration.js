const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.security-hardening-test');
const port = 3241;
fs.rmSync(dataDir, { recursive: true, force: true });

function startServer(extraEnv = {}) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      TARANGINI_DATA_DIR: dataDir,
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  return { server, output: () => output };
}

async function waitForServer(instance) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Security hardening server did not start:\n${instance.output()}`);
}

async function stopServer(instance) {
  if (!instance || instance.server.killed) return;
  instance.server.kill();
  await new Promise(resolve => {
    instance.server.once('exit', resolve);
    setTimeout(resolve, 2000);
  });
}

(async () => {
  let instance;
  try {
    instance = startServer();
    await waitForServer(instance);

    const loginResponse = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner1', password: 'owner123' })
    });
    assert.strictEqual(loginResponse.status, 200);
    const login = await loginResponse.json();
    const setCookie = loginResponse.headers.get('set-cookie');
    assert.match(setCookie, /tarangini_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Max-Age=28800/i);
    const cookie = setCookie.split(';')[0];

    const me = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { Cookie: cookie }
    });
    assert.strictEqual(me.status, 200);
    assert.strictEqual((await me.json()).username, 'owner1');

    const csrf = await fetch(`http://127.0.0.1:${port}/api/auth/lock-event`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'https://evil.example',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ reason: 'csrf-test' })
    });
    assert.strictEqual(csrf.status, 403);

    const runBackup = await fetch(`http://127.0.0.1:${port}/api/backup/run-automatic`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.strictEqual(runBackup.status, 200);
    const backup = await runBackup.json();
    assert.match(backup.file_name, /\.tbe$/);
    const encrypted = fs.readFileSync(backup.file_name);
    assert.strictEqual(encrypted.subarray(0, 16).toString() === 'SQLite format 3\u0000', false);
    assert.strictEqual(encrypted.subarray(0, 14).toString(), 'TARANGINIAUTO1');

    const keyResponse = await fetch(`http://127.0.0.1:${port}/api/backup/automatic-recovery-key`, {
      headers: { Authorization: `Bearer ${login.token}` }
    });
    assert.strictEqual(keyResponse.status, 200);
    const keyText = await keyResponse.text();
    const recoveryKey = keyText.split(/\s+/).find(value => /^[A-Za-z0-9_-]{43}$/.test(value));
    assert.ok(recoveryKey);

    const invalidRestore = await fetch(`http://127.0.0.1:${port}/api/backup/restore-automatic`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${login.token}`,
        'Content-Type': 'application/octet-stream',
        'X-Backup-Recovery-Key': Buffer.alloc(32, 1).toString('base64url')
      },
      body: encrypted
    });
    assert.strictEqual(invalidRestore.status, 400);

    await stopServer(instance);
    instance = null;

    fs.rmSync(dataDir, { recursive: true, force: true });
    instance = startServer({
      TARANGINI_REQUIRE_HTTPS: '1',
      TARANGINI_TRUST_PROXY: '1'
    });
    await waitForServer(instance);
    const remoteHttp = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { 'X-Forwarded-For': '203.0.113.10' }
    });
    assert.strictEqual(remoteHttp.status, 426);

    console.log('Security hardening integration tests passed');
  } finally {
    await stopServer(instance);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
