const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output', 'release');
const REPORT_JSON = path.join(OUTPUT_DIR, 'Tarangini_Release_Test_Report.json');
const REPORT_MD = path.join(OUTPUT_DIR, 'Tarangini_Release_Test_Report.md');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const full = process.argv.includes('--full');

const suites = [
  ['security', 'npm run test:security'],
  ['security-hardening', 'npm run test:security-hardening'],
  ['operator-log', 'npm run test:operator-log'],
  ['backup', 'npm run test:backup'],
  ['deployment', 'npm run test:deployment'],
  ['attachments', 'npm run test:attachments'],
  ['tax-inclusive', 'npm run test:tax-inclusive'],
  ['device-identity', 'npm run test:device-identity'],
  ['new-features', 'node tests/new-features.integration.js'],
  ['advanced-upgrades', 'node tests/advanced-upgrades.integration.js'],
  ['user-admin', 'npm run test:user-admin'],
  ['jobs', 'npm run test:jobs'],
  ['offline-sync', 'npm run test:offline-sync'],
  ['v2.3', 'npm run test:v2.3'],
  ['responsive-web', 'npm run test:responsive-web'],
  ['responsive-ui', 'npm run test:responsive']
];

function run(command, timeoutMs = 180000) {
  return new Promise(resolve => {
    const started = Date.now();
    const normalized = process.platform === 'win32' ? command.replace(/^npm\b/, 'npm.cmd') : command;
    const child = spawn(normalized, [], { cwd: ROOT, windowsHide: true, shell: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ status: 'timeout', exit_code: null, seconds: (Date.now() - started) / 1000, output: output.slice(-4000) });
    }, timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ status: 'failed', exit_code: null, seconds: (Date.now() - started) / 1000, output: `${output}\n${error.stack || error.message}`.slice(-4000) });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ status: code === 0 ? 'passed' : 'failed', exit_code: code, seconds: (Date.now() - started) / 1000, output: output.slice(-4000) });
    });
  });
}

function request(url) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const req = http.get(url, response => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
    });
    req.on('error', reject);
  });
}

async function waitForServer(port) {
  // First startup may run migrations and catalogue preload on a cold database.
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try { await request(`http://127.0.0.1:${port}/api/health`); return; } catch (_) { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error('Server did not become ready');
}

async function concurrencySmoke() {
  const port = 39127;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, PORT: String(port), STATE_FILE: path.join(ROOT, 'tmp', 'release-agent-state.json') }
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    await waitForServer(port);
    const results = await Promise.all(Array.from({ length: 200 }, () => request(`http://127.0.0.1:${port}/api/health`)));
    const times = results.map(row => row.ms).sort((a, b) => a - b);
    const percentile = p => times[Math.min(times.length - 1, Math.floor(times.length * p))];
    return {
      status: results.every(row => row.status === 200) ? 'passed' : 'failed',
      requests: results.length,
      successful: results.filter(row => row.status === 200).length,
      p50_ms: Number(percentile(0.50).toFixed(2)),
      p95_ms: Number(percentile(0.95).toFixed(2)),
      max_ms: Number(Math.max(...times).toFixed(2)),
      note: 'Health-endpoint smoke only; not a full customer upload or invoice-write benchmark.'
    };
  } finally {
    child.kill();
    if (output) fs.writeFileSync(path.join(ROOT, 'tmp', 'release-agent-server.log'), output, 'utf8');
  }
}

function readCapacityEvidence() {
  const files = ['capacity-100k-results.json', 'capacity-million-each-results.json'];
  return files.map(file => {
    const fullPath = path.join(__dirname, file);
    if (!fs.existsSync(fullPath)) return { file, status: 'missing' };
    try { return { file, status: 'available', data: JSON.parse(fs.readFileSync(fullPath, 'utf8')) }; }
    catch (error) { return { file, status: 'invalid', error: error.message }; }
  });
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const started = new Date().toISOString();
  const results = [];
  if (full) {
    for (const [name, command] of suites) {
      process.stdout.write(`Running ${name}...\n`);
      results.push({ name, command, ...(await run(command)) });
    }
  }
  const smoke = await concurrencySmoke();
  const report = {
    generated_at: new Date().toISOString(),
    started_at: started,
    application_version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
    mode: full ? 'full-suite-plus-concurrency-smoke' : 'concurrency-smoke',
    suites: results,
    concurrency_smoke: smoke,
    capacity_evidence: readCapacityEvidence(),
    recommendation: 'Treat 200 as the configured target for customer sessions only after deployment uses HTTPS, sufficient RAM/SSD, controlled upload sizing, and a dedicated Main System. This smoke test does not certify 200 simultaneous heavy uploads or writes.'
  };
  fs.writeFileSync(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const lines = [
    '# Tarangini Release Test Report',
    '',
    `- Generated: ${report.generated_at}`,
    `- Version: ${report.application_version}`,
    `- Mode: ${report.mode}`,
    '',
    '## Concurrency Smoke',
    '',
    `- Status: **${smoke.status}**`,
    `- Requests: ${smoke.requests}`,
    `- Successful: ${smoke.successful}`,
    `- p50: ${smoke.p50_ms} ms; p95: ${smoke.p95_ms} ms; max: ${smoke.max_ms} ms`,
    `- Scope: ${smoke.note}`,
    '',
    '## Suite Results',
    '',
    ...(results.length ? results.map(row => `- ${row.name}: **${row.status}** (${row.seconds.toFixed(1)} s)`) : ['- Full suite not requested; run `node tests/release-test-agent.js --full`.']),
    '',
    '## Capacity Interpretation',
    '',
    report.recommendation,
    '',
    'Record-volume evidence is included in the JSON report. It demonstrates database scale and query behavior, not the number of people who can simultaneously upload files or post transactions.'
  ];
  fs.writeFileSync(REPORT_MD, `${lines.join('\n')}\n`, 'utf8');
  console.log(REPORT_JSON);
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
