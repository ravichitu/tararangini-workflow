const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'output', 'capacity');
const dataDir = path.join(root, '.customer-portal-300-test');
const attachmentDir = path.join(root, '.customer-portal-300-files');
const reportPath = path.join(outputDir, 'customer-portal-300-upload-report.json');
const port = 3248;
const count = 300;
const uploadBytes = Math.max(1024, Number(process.env.TEST_UPLOAD_BYTES || 64 * 1024));
const uploadMode = String(process.env.TEST_UPLOAD_MODE || 'json').toLowerCase();

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
    TARANGINI_DEPLOYMENT_PROFILE: 'public',
    TARANGINI_CUSTOMER_PORTAL_RATE_LIMIT_MAX: '5000',
    TARANGINI_TARGET_CONCURRENT_CUSTOMERS: String(count)
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start\n${output}`);
}

async function request(method, route, body, token) {
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
  if (!response.ok) throw new Error(`${method} ${route} ${response.status}: ${payload.error || text}`);
  return payload;
}

function memory() {
  const usage = process.memoryUsage();
  return Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, Math.round(value / 1024 / 1024 * 100) / 100]));
}

function directoryBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    total += entry.isDirectory() ? directoryBytes(full) : fs.statSync(full).size;
  }
  return total;
}

(async () => {
  const startedAt = new Date().toISOString();
  try {
    await waitForServer();
    const health = await request('GET', '/health');
    assert.strictEqual(health.deployment_profile.profile_name, 'public');
    assert.strictEqual(health.deployment_profile.attachment_storage_mode, 'filesystem');
    assert.strictEqual(health.deployment_profile.attachment_analysis_mode, 'async');
    const owner = await request('POST', '/auth/login', { username: 'owner1', password: 'owner123' });
    const party = await request('POST', '/parties', {
      org_id: 1, type: 'customer', name: 'Capacity Test Customer', phone: '9000000300'
    }, owner.token);
    const catalog = await request('GET', '/jobs/catalog?org_id=1', undefined, owner.token);
    assert.ok(catalog.services.length, 'Service catalog must contain a service');
    const serverBefore = await request('GET', '/advanced/performance?org_id=1', undefined, owner.token);

    const tokens = [];
    for (let index = 0; index < count; index += 1) {
      const job = await request('POST', '/jobs', {
        org_id: 1, party_id: party.id, priority: 'NORMAL',
        promised_delivery_at: '2026-07-20T18:00:00.000Z',
        customer_commitment: `Capacity customer ${index}`,
        items: [{ service_id: catalog.services[0].id, description: 'Portal capacity upload', quantity: 1, unit: 'NOS' }],
        estimate_lines: [{ description: 'Portal capacity upload', quantity: 1, unit: 'NOS', unit_price: 10, tax_rate: 0, line_total: 10 }]
      }, owner.token);
      const access = await request('POST', `/jobs/${job.id}/customer-access`, {
        expires_in_days: 7
      }, owner.token);
      tokens.push(access.token);
    }

    const pngHeader = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn9xJgAAAAASUVORK5CYII=', 'base64');
    const bytes = Buffer.alloc(uploadBytes, 65);
    pngHeader.copy(bytes);
    const uploadBufferFor = index => {
      // Distinct payloads prevent attachment content-deduplication from hiding
      // the real disk demand of 300 independent customer uploads.
      const payload = Buffer.from(bytes);
      payload.writeUInt32BE(index + 1, Math.max(0, payload.length - 4));
      return payload;
    };
    const before = memory();
    const started = process.hrtime.bigint();
    const results = await Promise.all(tokens.map((token, index) => (async () => {
      const requestStarted = process.hrtime.bigint();
      try {
        let payload;
        const uploadBytesForCustomer = uploadBufferFor(index);
        if (uploadMode === 'multipart') {
          const form = new FormData();
          form.append('file', new Blob([uploadBytesForCustomer], { type: 'image/png' }), `customer-${String(index + 1).padStart(3, '0')}.png`);
          form.append('purpose', 'CUSTOMER_UPLOAD');
          let response;
          for (let attempt = 0; attempt < 40; attempt += 1) {
            response = await fetch(`http://127.0.0.1:${port}/api/job-portal/${token}/uploads-multipart`, {
              method: 'POST', body: form
            });
            payload = await response.json();
            if (response.status !== 429) break;
            await new Promise(resolve => setTimeout(resolve, 3200));
          }
          if (!response.ok) throw new Error(payload.error || `Upload failed: ${response.status}`);
        } else {
          payload = await request('POST', `/job-portal/${token}/uploads`, {
            file_name: `customer-${String(index + 1).padStart(3, '0')}.png`,
            mime_type: 'image/png', content_base64: uploadBytesForCustomer.toString('base64'), purpose: 'CUSTOMER_UPLOAD'
          });
        }
        return {
          ok: true,
          id: payload.id,
          milliseconds: Number(process.hrtime.bigint() - requestStarted) / 1e6
        };
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          milliseconds: Number(process.hrtime.bigint() - requestStarted) / 1e6
        };
      }
    })()));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const latencies = results.map(result => result.milliseconds).sort((a, b) => a - b);
    const percentile = value => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * value))];
    const after = memory();
    const serverAfter = await request('GET', '/advanced/performance?org_id=1', undefined, owner.token);
    const report = {
      tested_at: startedAt,
      profile: health.deployment_profile,
      customers: count,
      simultaneous_upload_requests: count,
      upload_mode: uploadMode,
      unique_payloads: true,
      bytes_per_upload: uploadBytes,
      total_upload_bytes: uploadBytes * count,
      successful_uploads: results.filter(result => result.ok).length,
      failed_uploads: results.filter(result => !result.ok).length,
      elapsed_seconds: Math.round(elapsedMs / 10) / 100,
      latency_ms: {
        p50: Math.round(percentile(0.50) * 100) / 100,
        p95: Math.round(percentile(0.95) * 100) / 100,
        max: Math.round(latencies[latencies.length - 1] * 100) / 100
      },
      memory_mb: {
        // The load generator creates all browser upload bodies in one process. Keep this
        // distinct from the authenticated Tarangini server measurement below.
        load_generator: { before, after, rss_delta: Math.round((after.rss - before.rss) * 100) / 100 },
        server: {
          before: serverBefore.process.memory_mb,
          after: serverAfter.process.memory_mb,
          rss_delta: Number((serverAfter.process.memory_mb - serverBefore.process.memory_mb).toFixed(2))
        }
      },
      storage_mb: {
        attachment_files: Math.round(directoryBytes(attachmentDir) / 1024 / 1024 * 100) / 100,
        database: Math.round(directoryBytes(dataDir) / 1024 / 1024 * 100) / 100
      },
      failures: results.filter(result => !result.ok).slice(0, 10)
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    assert.strictEqual(report.failed_uploads, 0, JSON.stringify(report.failures));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    server.kill();
    await new Promise(resolve => setTimeout(resolve, 500));
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.rmSync(attachmentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => {
  console.error(error);
  console.error(output);
  process.exitCode = 1;
});
