const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'output', 'soak');
const dataDir = path.join(root, '.production-soak-test');
const attachmentDir = path.join(root, '.production-soak-files');
const port = Number(process.env.SOAK_PORT || 3271);
const clients = Math.max(1, Math.min(50, Number(process.env.SOAK_CLIENTS || 10)));
const seconds = Math.max(2, Math.min(7 * 24 * 60 * 60, Number(process.env.SOAK_SECONDS || 900)));
const intervalMs = Math.max(100, Math.min(30000, Number(process.env.SOAK_OPERATION_INTERVAL_MS || 1000)));
const reportPath = path.join(outputDir, 'production-soak-report.json');

fs.rmSync(dataDir, { recursive: true, force: true });
fs.rmSync(attachmentDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    TARANGINI_DATA_DIR: dataDir,
    TARANGINI_ATTACHMENT_DIR: attachmentDir,
    TARANGINI_DEPLOYMENT_PROFILE: 'store',
    TARANGINI_CUSTOMER_PORTAL_RATE_LIMIT_MAX: '5000'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverOutput = '';
server.stdout.on('data', chunk => { serverOutput += chunk; });
server.stderr.on('data', chunk => { serverOutput += chunk; });

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function request(method, route, body, token) {
  const started = process.hrtime.bigint();
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
  try { payload = JSON.parse(text); } catch (_) { payload = { raw: text }; }
  return {
    ok: response.ok,
    status: response.status,
    payload,
    milliseconds: Number(process.hrtime.bigint() - started) / 1e6
  };
}

async function required(method, route, body, token) {
  const result = await request(method, route, body, token);
  if (!result.ok) throw new Error(`${method} ${route} ${result.status}: ${result.payload.error || 'request failed'}`);
  return result.payload;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch (_) {}
    await sleep(100);
  }
  throw new Error(`Soak server did not become ready\n${serverOutput}`);
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

(async () => {
  const startedAt = new Date().toISOString();
  const results = [];
  let sequence = 0;
  try {
    await waitForServer();
    const owner = await required('POST', '/auth/login', { username: 'owner1', password: 'owner123' });
    const party = await required('POST', '/parties', {
      org_id: 1, type: 'customer', name: 'Soak Test Customer', phone: '9000000999'
    }, owner.token);
    const item = await required('POST', '/items', {
      org_id: 1, name: 'Soak Test Service', unit: 'NOS', gst_rate: 0, last_sale_price: 10
    }, owner.token);
    const catalog = await required('GET', '/jobs/catalog?org_id=1', undefined, owner.token);
    assert.ok(catalog.services.length, 'Job service catalog must be available');
    const before = await required('GET', '/advanced/performance?org_id=1', undefined, owner.token);
    const deadline = Date.now() + seconds * 1000;

    async function oneOperation(clientNumber) {
      const index = sequence++;
      const mode = index % 4;
      if (mode === 0) return request('GET', '/health');
      if (mode === 1) return request('POST', '/bills', {
        org_id: 1, format: 'QUOT', bill_date: new Date().toISOString().slice(0, 10), party_id: party.id,
        payment_mode: 'credit', description: `Soak quotation ${index}`,
        items: [{ item_id: item.id, item_name: item.name, qty: 1, unit: 'NOS', rate: 10, amount: 10, gst_rate: 0 }]
      }, owner.token);
      if (mode === 2) return request('POST', '/jobs', {
        org_id: 1, party_id: party.id, priority: 'NORMAL',
        promised_delivery_at: new Date(Date.now() + 86400000).toISOString(),
        customer_commitment: `Soak client ${clientNumber} job ${index}`,
        items: [{ service_id: catalog.services[0].id, description: 'Soak workflow service', quantity: 1, unit: 'NOS' }],
        estimate_lines: [{ description: 'Soak workflow service', quantity: 1, unit: 'NOS', unit_price: 10, tax_rate: 0, line_total: 10 }]
      }, owner.token);
      return request('POST', '/job-intake/submit', {
        org_id: 1, client_request_id: `soak-${clientNumber}-${index}`,
        source_channel: 'COUNTER', customer_name: `Soak Intake ${clientNumber}-${index}`,
        customer_phone: `91${String(7000000000 + (index % 999999999)).padStart(10, '0')}`.slice(-10),
        issue_summary: 'Controlled soak-test intake request', consent_status: true,
        consent_text: 'Soak-test customer consent record'
      });
    }

    async function clientLoop(clientNumber) {
      while (Date.now() < deadline) {
        try {
          const result = await oneOperation(clientNumber);
          results.push({ client: clientNumber, ...result });
        } catch (error) {
          results.push({ client: clientNumber, ok: false, status: 0, milliseconds: 0, error: error.message });
        }
        await sleep(intervalMs);
      }
    }

    await Promise.all(Array.from({ length: clients }, (_, index) => clientLoop(index + 1)));
    const after = await required('GET', '/advanced/performance?org_id=1', undefined, owner.token);
    const latencies = results.map(result => result.milliseconds).filter(Number.isFinite);
    const report = {
      tested_at: startedAt,
      duration_seconds: seconds,
      virtual_clients: clients,
      operation_interval_ms: intervalMs,
      scope: 'Virtual-client mixed smoke: health, quotation draft, job creation and consented customer intake. This does not replace a physical multi-PC soak.',
      operations: results.length,
      successful_operations: results.filter(result => result.ok).length,
      failed_operations: results.filter(result => !result.ok).length,
      status_codes: results.reduce((summary, result) => {
        const key = String(result.status || 0);
        summary[key] = (summary[key] || 0) + 1;
        return summary;
      }, {}),
      latency_ms: {
        p50: Number(percentile(latencies, 0.5).toFixed(2)),
        p95: Number(percentile(latencies, 0.95).toFixed(2)),
        max: Number(Math.max(...latencies, 0).toFixed(2))
      },
      server_memory_mb: {
        before: before.process.memory_mb,
        after: after.process.memory_mb,
        rss_delta: Number((after.process.memory_mb - before.process.memory_mb).toFixed(2))
      },
      failures: results.filter(result => !result.ok).slice(0, 20)
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    assert.strictEqual(report.failed_operations, 0, JSON.stringify(report.failures));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    server.kill();
    await sleep(300);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.rmSync(attachmentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => {
  console.error(error);
  console.error(serverOutput);
  process.exitCode = 1;
});
