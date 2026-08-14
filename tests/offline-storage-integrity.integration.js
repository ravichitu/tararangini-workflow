const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OfflineProxy } = require('../electron/offline-proxy');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarangini-offline-integrity-'));
const proxy = new OfflineProxy({
  appPath: tempDir,
  userData: tempDir,
  serverUrl: 'http://127.0.0.1:1',
  deviceCode: 'TEST',
  protectData: value => Buffer.from(value, 'utf8').toString('base64'),
  unprotectData: value => Buffer.from(value, 'base64').toString('utf8')
});

proxy.writeStore(path.join(tempDir, 'valid.json'), { queue: [{ id: 'one' }] });
const valid = proxy.readStore(path.join(tempDir, 'valid.json'), {});
assert.deepStrictEqual(valid, { queue: [{ id: 'one' }] });

const corruptedPath = path.join(tempDir, 'corrupted.json');
proxy.writeStore(corruptedPath, { cache: ['original'] });
const envelope = JSON.parse(fs.readFileSync(corruptedPath, 'utf8'));
envelope.data = Buffer.from(JSON.stringify({ cache: ['tampered'] }), 'utf8').toString('base64');
fs.writeFileSync(corruptedPath, JSON.stringify(envelope));
const recovered = proxy.readStore(corruptedPath, { cache: [] });
assert.deepStrictEqual(recovered, { cache: [] });
assert.strictEqual(fs.readdirSync(tempDir).some(name => name.startsWith('corrupted.json.corrupt-')), true);

fs.rmSync(tempDir, { recursive: true, force: true });
console.log('Offline storage integrity tests passed');
