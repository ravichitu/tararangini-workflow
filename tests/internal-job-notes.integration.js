const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.internal-job-notes-test');
const port = 3254;
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
  throw new Error(`Internal job note server did not start:\n${output}`);
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

(async () => {
  try {
    await waitForServer();
    const owner = await request('POST', '/auth/login', { username: 'owner1', password: 'owner123' });
    const operator = await request('POST', '/auth/login', { username: 'operator1', password: 'operator123' });
    const party = await request('POST', '/parties', {
      org_id: 1, type: 'customer', name: 'Internal Notes Customer'
    }, owner.token);
    const catalog = await request('GET', '/jobs/catalog?org_id=1', undefined, owner.token);
    const created = await request('POST', '/jobs', {
      org_id: 1,
      party_id: party.id,
      promised_delivery_at: '2026-07-20T18:00:00.000Z',
      items: [{
        service_id: catalog.services[0].id,
        description: 'Internal note test service',
        quantity: 1,
        unit: 'JOB'
      }],
      estimate_lines: [{
        description: 'Internal note test service',
        quantity: 1,
        unit: 'JOB',
        unit_price: 100,
        tax_rate: 0,
        line_total: 100
      }]
    }, owner.token);

    const ownerNote = await request('POST', `/jobs/${created.id}/internal-notes`, {
      note_type: 'INSTRUCTION',
      note_text: 'Owner instruction: verify the supplied sample before production.',
      file_names: ['C:\\Customer Files\\sample.pdf', '../private/operator-secret.txt', 'sample.pdf']
    }, owner.token, 201);
    assert.strictEqual(ownerNote.success, true);

    const operatorNote = await request('POST', `/jobs/${created.id}/internal-notes`, {
      note_type: 'PROGRESS',
      note_text: 'Operator progress: sample checked and ready for production.',
      file_names: ['production-proof.pdf']
    }, operator.token, 201);
    assert.strictEqual(operatorNote.success, true);

    const notes = await request('GET', `/jobs/${created.id}/internal-notes`, undefined, owner.token);
    assert.strictEqual(notes.length, 2);
    const instruction = notes.find(note => note.note_type === 'INSTRUCTION');
    assert.deepStrictEqual(instruction.file_names.sort(), ['operator-secret.txt', 'sample.pdf'].sort());
    assert.strictEqual(instruction.author_role, 'owner');
    assert.strictEqual(notes.some(note => note.author_role === 'operator'), true);

    const detail = await request('GET', `/jobs/${created.id}`, undefined, operator.token);
    assert.strictEqual(detail.internal_notes.length, 2);
    assert.strictEqual(detail.internal_notes.some(note => note.note_text.includes('Owner instruction')), true);

    const backup = await request('GET', '/backup/export?org_id=1', undefined, owner.token);
    assert.strictEqual(backup.job_internal_notes.length, 2);
    assert.strictEqual(backup.job_internal_notes.every(note => note.org_id === 1), true);

    console.log('Internal job notes integration tests passed');
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
