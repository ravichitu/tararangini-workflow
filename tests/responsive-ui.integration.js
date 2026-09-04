const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const runner = path.join(__dirname, 'responsive-ui.runner.js');
const resultFile = path.join(root, '.responsive-ui-result.json');
const dataDir = path.join(root, '.responsive-ui-data');
const port = 3210;

async function waitForServer(server, output) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Responsive test server exited:\n${output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Responsive test server did not start:\n${output()}`);
}

function stopProcess(child) {
  if (!child || child.exitCode !== null || child.killed) return Promise.resolve();
  child.kill();
  return new Promise(resolve => {
    child.once('exit', resolve);
    setTimeout(resolve, 2000);
  });
}

(async () => {
  fs.rmSync(resultFile, { force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  let serverOutput = '';
  let electronOutput = '';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), TARANGINI_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => { serverOutput += chunk; });
  server.stderr.on('data', chunk => { serverOutput += chunk; });
  let child;
  let testTimeout;

  try {
    await waitForServer(server, () => serverOutput);
    child = spawn(electron, [runner], {
      cwd: root,
      env: {
        ...process.env,
        RESPONSIVE_RESULT_FILE: resultFile,
        RESPONSIVE_APP_URL: `http://127.0.0.1:${port}`
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { electronOutput += chunk; });
    child.stderr.on('data', chunk => { electronOutput += chunk; });
    const code = await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise((_, reject) => {
        testTimeout = setTimeout(() => reject(new Error('Responsive UI test timed out')), 90000);
      })
    ]);
    assert.strictEqual(code, 0, electronOutput);
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.checked, 18);
    console.log('Responsive UI integration tests passed');
  } finally {
    if (testTimeout) clearTimeout(testTimeout);
    await stopProcess(child);
    await stopProcess(server);
    fs.rmSync(resultFile, { force: true });
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
