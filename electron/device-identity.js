const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function normalizeMac(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/-/g, ':');
}

function visibleMac(value) {
  const normalized = normalizeMac(value);
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(normalized) ? normalized : '';
}

function collectMacReferences(networkInterfaces = os.networkInterfaces()) {
  const macs = new Set();
  for (const entries of Object.values(networkInterfaces || {})) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      const mac = visibleMac(entry.mac);
      if (!mac || mac === '00:00:00:00:00:00') continue;
      macs.add(mac);
    }
  }
  return [...macs].sort();
}

function shortHash(value, length = 10) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').toUpperCase().slice(0, length);
}

function safeDeviceCode(value) {
  return String(value || 'CLIENT')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8) || 'CLIENT';
}

function buildIdentity({ systemName = os.hostname(), macReferences = collectMacReferences(), stored = {} } = {}) {
  const cleanName = String(systemName || 'WINDOWS-PC').trim() || 'WINDOWS-PC';
  const macs = [...new Set((macReferences || []).map(visibleMac).filter(Boolean))].sort();
  const basis = macs.length ? `${cleanName}|${macs.join('|')}` : `${cleanName}|${stored.installationSeed || ''}`;
  const fingerprint = shortHash(basis, 16);
  const installationSeed = stored.installationSeed || crypto.randomUUID();
  const deviceId = stored.deviceId || `DEV-${shortHash(`${fingerprint}|${installationSeed}`, 18)}`;
  const deviceCode = safeDeviceCode(stored.deviceCode || `D${shortHash(deviceId, 7)}`);
  return {
    deviceId,
    deviceCode,
    systemName: cleanName,
    displayName: stored.displayName || cleanName,
    macReferences: macs,
    fingerprint,
    installationSeed,
    generatedAt: stored.generatedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function identityPath(userData) {
  return path.join(userData, 'device-identity.json');
}

function readStoredIdentity(userData) {
  try {
    return JSON.parse(fs.readFileSync(identityPath(userData), 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeStoredIdentity(userData, identity) {
  fs.mkdirSync(userData, { recursive: true });
  const target = identityPath(userData);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(identity, null, 2));
  fs.renameSync(temp, target);
}

function getDeviceIdentity(userData, options = {}) {
  const stored = readStoredIdentity(userData);
  const identity = buildIdentity({
    systemName: options.systemName || os.hostname(),
    macReferences: options.macReferences || collectMacReferences(),
    stored
  });
  const changed = JSON.stringify(stored) !== JSON.stringify(identity);
  if (changed) writeStoredIdentity(userData, identity);
  return identity;
}

module.exports = {
  buildIdentity,
  collectMacReferences,
  getDeviceIdentity,
  safeDeviceCode
};
