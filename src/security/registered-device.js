const { get, run } = require('../db/db');

function offlineDeviceId(req) {
  return String(req.get('x-tarangini-device-id') || req.body?.offline_device_id || '').trim().slice(0, 120);
}

function requireRegisteredOfflineDevice(req, res, orgId) {
  if (!req.body?.offline_id) return true;
  const deviceId = offlineDeviceId(req);
  if (!deviceId) {
    res.status(403).json({ error: 'Registered device identity is required for offline synchronization', code: 'DEVICE_REGISTRATION_REQUIRED' });
    return false;
  }
  const device = get("SELECT * FROM registered_devices WHERE org_id=? AND device_id=? AND status='active'", [Number(orgId), deviceId]);
  if (!device) {
    res.status(403).json({ error: 'This device is not registered or has been revoked for this organization', code: 'DEVICE_NOT_REGISTERED' });
    return false;
  }
  run('UPDATE registered_devices SET last_sync_at=? WHERE id=?', [new Date().toISOString(), device.id]);
  return true;
}

module.exports = { offlineDeviceId, requireRegisteredOfflineDevice };
