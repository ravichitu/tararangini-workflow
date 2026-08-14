const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.attachment-pipeline-test');
const attachmentDir = path.join(root, '.attachment-pipeline-files');
const port = 3237;
fs.rmSync(dataDir, { recursive: true, force: true });
fs.rmSync(attachmentDir, { recursive: true, force: true });

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    TARANGINI_DATA_DIR: dataDir,
    TARANGINI_ATTACHMENT_DIR: attachmentDir,
    TARANGINI_DEPLOYMENT_PROFILE: 'store'
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

async function request(method, route, body, token, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  assert.strictEqual(response.status, expected, `${method} ${route}: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitForAttachmentReady(token, jobId, fileName) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const detail = await request('GET', `/jobs/${jobId}`, undefined, token);
    const file = detail.attachments.find(attachment => attachment.file_name === fileName);
    if (file?.analysis_status === 'READY') return file;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Attachment ${fileName} did not finish analysis`);
}

(async () => {
  try {
    await waitForServer();
    const health = await request('GET', '/health');
    assert.strictEqual(health.deployment_profile.profile_name, 'store');
    assert.strictEqual(health.deployment_profile.attachment_storage_mode, 'filesystem');
    assert.strictEqual(health.deployment_profile.attachment_analysis_mode, 'async');
    assert.strictEqual(health.storage_locations.attachment_dir, attachmentDir);

    const owner = await request('POST', '/auth/login', { username: 'owner1', password: 'owner123' });
    const customer = await request('POST', '/parties', {
      org_id: 1,
      type: 'customer',
      name: 'Pipeline Customer',
      phone: '9000000050',
      email: 'pipeline@example.test'
    }, owner.token);
    const catalog = await request('GET', '/jobs/catalog?org_id=1', undefined, owner.token);
    const created = await request('POST', '/jobs', {
      org_id: 1,
      party_id: customer.id,
      priority: 'NORMAL',
      promised_delivery_at: '2026-06-25T18:00:00.000Z',
      customer_commitment: 'Check async storage pipeline.',
      items: [{
        service_id: catalog.services[0].id,
        description: 'Pipeline binding',
        specifications: { size: 'A4' },
        quantity: 1,
        unit: 'BOOKS'
      }],
      estimate_lines: [{
        description: 'Pipeline binding',
        quantity: 1,
        unit: 'BOOKS',
        unit_price: 100,
        tax_rate: 0,
        line_total: 100
      }]
    }, owner.token);

    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn9xJgAAAAASUVORK5CYII=';
    const uploaded = await request('POST', `/jobs/${created.id}/attachments`, {
      file_name: 'pipeline-proof.png',
      mime_type: 'image/png',
      content_base64: pngBase64,
      visible_to_customer: true
    }, owner.token);
    assert.strictEqual(uploaded.analysis_status, 'PENDING');

    const readyAttachment = await waitForAttachmentReady(owner.token, created.id, 'pipeline-proof.png');
    assert.strictEqual(readyAttachment.analysis_status, 'READY');
    assert.strictEqual(readyAttachment.pixel_width, 1);
    assert.strictEqual(readyAttachment.pixel_height, 1);

    const attachmentRoot = attachmentDir;
    assert.ok(fs.existsSync(attachmentRoot));
    const files = fs.readdirSync(attachmentRoot, { recursive: true });
    assert.ok(files.some(entry => String(entry).includes('pipeline') || String(entry).endsWith('.png')));

    const content = await fetch(`http://127.0.0.1:${port}/api/jobs/attachments/${uploaded.id}/content`, {
      headers: { Authorization: `Bearer ${owner.token}` }
    });
    const bytes = Buffer.from(await content.arrayBuffer());
    assert.strictEqual(content.status, 200);
    assert.strictEqual(bytes.length > 0, true);

    const backup = await request('GET', '/backup/export?org_id=1', undefined, owner.token);
    const exportedAttachment = backup.job_attachments.find(file => file.file_name === 'pipeline-proof.png');
    assert.ok(exportedAttachment);
    assert.strictEqual(exportedAttachment.storage_path, null);
    assert.strictEqual(exportedAttachment.content_base64, null);
    assert.strictEqual(exportedAttachment.backup_content_included, false);
    assert.strictEqual(exportedAttachment.sha256, readyAttachment.sha256);

    const archived = await request('PATCH', `/jobs/attachments/${uploaded.id}`, {
      archive_attachment: true,
      archive_reason: 'Repeat customer reference file'
    }, owner.token);
    assert.strictEqual(archived.retention_state, 'ARCHIVED');
    assert.strictEqual(archived.retention_policy, 'ARCHIVE');
    assert.strictEqual(archived.content_available, true);

    const integrity = await request('GET', '/advanced/integrity', undefined, owner.token);
    assert.ok(integrity.maintenance.attachment_analysis_jobs.started);
    assert.ok(integrity.maintenance.attachment_analysis_jobs.counts.DONE >= 1);
    assert.strictEqual(integrity.maintenance.storage_locations.attachment_dir, attachmentDir);

    console.log('Attachment storage and async analysis integration tests passed');
  } finally {
    if (!server.killed) {
      server.kill();
      await new Promise(resolve => {
        server.once('exit', resolve);
        setTimeout(resolve, 2000);
      });
    }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.rmSync(attachmentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => {
  console.error(error);
  console.error(output);
  process.exitCode = 1;
});
