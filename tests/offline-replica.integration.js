const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OfflineProxy } = require('../electron/offline-proxy');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarangini-offline-replica-'));
const proxy = new OfflineProxy({
  appPath: tempDir,
  userData: tempDir,
  serverUrl: 'http://127.0.0.1:1',
  deviceCode: 'TEST',
  protectData: value => Buffer.from(value, 'utf8').toString('base64'),
  unprotectData: value => Buffer.from(value, 'base64').toString('utf8')
});

const snapshot = {
  org_id: 42,
  schema_version: 3,
  revision: 17,
  checksum_sha256: 'abc123',
  org: { id: 42, display_name: 'Test Company' },
  parties: [{ id: 1, name: 'Customer' }]
};
proxy.saveReplicaSnapshot(snapshot);
assert.deepStrictEqual(proxy.readReplicaSnapshot(42), snapshot);
proxy.cache.organization_snapshots = {};
assert.deepStrictEqual(proxy.snapshotForOrg(42), snapshot);
assert.deepStrictEqual(proxy.replicaSummary(), [{
  org_id: 42, schema_version: 3, revision: 17, checksum_sha256: 'abc123',
  saved_at: proxy.replicaSummary()[0].saved_at
}]);

proxy.wipeLocalData('test revoke');
assert.strictEqual(proxy.readReplicaSnapshot(42), null);
assert.deepStrictEqual(proxy.replicaSummary(), []);
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('Offline encrypted replica tests passed');
