const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildIdentity,
  collectMacReferences,
  getDeviceIdentity,
  safeDeviceCode
} = require('../electron/device-identity');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.device-identity-test');
fs.rmSync(dataDir, { recursive: true, force: true });

const interfaces = {
  Ethernet: [
    { internal: false, mac: 'aa-bb-cc-dd-ee-ff' },
    { internal: true, mac: '11:22:33:44:55:66' }
  ],
  WiFi: [
    { internal: false, mac: '01:23:45:67:89:ab' },
    { internal: false, mac: '00:00:00:00:00:00' }
  ]
};

const macs = collectMacReferences(interfaces);
assert.deepStrictEqual(macs, ['01:23:45:67:89:AB', 'AA:BB:CC:DD:EE:FF']);

const identityA = buildIdentity({
  systemName: 'PRINTING-PC',
  macReferences: macs,
  stored: { installationSeed: 'seed-1' }
});
const identityB = buildIdentity({
  systemName: 'PRINTING-PC',
  macReferences: [...macs].reverse(),
  stored: { installationSeed: 'seed-1' }
});
assert.strictEqual(identityA.fingerprint, identityB.fingerprint);
assert.strictEqual(identityA.deviceId, identityB.deviceId);
assert.match(identityA.deviceCode, /^D[A-Z0-9]{7}$/);
assert.strictEqual(safeDeviceCode('shop pc #1'), 'SHOPPC1');

const persistedA = getDeviceIdentity(dataDir, {
  systemName: 'ENGINEER-PC',
  macReferences: ['10:20:30:40:50:60']
});
const persistedB = getDeviceIdentity(dataDir, {
  systemName: 'ENGINEER-PC',
  macReferences: ['10:20:30:40:50:60']
});
assert.strictEqual(persistedA.deviceId, persistedB.deviceId);
assert.strictEqual(persistedA.deviceCode, persistedB.deviceCode);
assert.strictEqual(persistedB.systemName, 'ENGINEER-PC');

fs.rmSync(dataDir, { recursive: true, force: true });
console.log('Device identity integration tests passed');
