const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { get, run, all } = require('../db/db');
const {
  authMiddleware, JWT_SECRET, userPermissions, requireAdminNetworkAccess
} = require('../middleware/auth');
const {
  sessionToken, setSessionCookie, clearSessionCookie
} = require('../security/session');

function primaryOwnerOnly(req, res) {
  if (String(req.user?.username || '').toLowerCase() !== 'owner1' || req.user?.role !== 'owner') {
    res.status(403).json({ error: 'Only Owner1 can manage user accounts and reset passwords' });
    return false;
  }
  return true;
}

// Login
router.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const secret = String(req.body.pin || req.body.password || '');
  if (!username || !secret) return res.status(400).json({ error: 'Username and PIN required' });

  const user = get('SELECT * FROM users WHERE username=? AND active=1', [username]);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const validPin = user.pin_hash && /^\d{4,6}$/.test(secret) && bcrypt.compareSync(secret, user.pin_hash);
  const validRecoveryPassword = bcrypt.compareSync(secret, user.password_hash);
  const valid = validPin || validRecoveryPassword;
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ userId: user.id, role: user.role, jti: crypto.randomUUID() }, JWT_SECRET, { expiresIn: '8h' });
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();

  run('INSERT INTO sessions (user_id, token, ip_address, expires_at) VALUES (?,?,?,?)',
    [user.id, token, req.ip, expiresAt]);

  run('UPDATE users SET last_login=? WHERE id=?', [new Date().toISOString(), user.id]);

  // Log
  run('INSERT INTO audit_log (user_id, action, table_name, ip_address) VALUES (?,?,?,?)',
    [user.id, 'LOGIN', 'users', req.ip]);

  setSessionCookie(res, req, token);
  res.json({
    token,
    user: { id: user.id, name: user.name, username: user.username, role: user.role,
      org_access: user.org_access, permissions: userPermissions(user), pin_configured: Boolean(user.pin_hash) }
  });
});

router.post('/refresh', (req, res) => {
  const oldToken = req.body.token || sessionToken(req);
  if (!oldToken) return res.status(401).json({ error: 'Session token required' });
  try {
    const decoded = jwt.verify(oldToken, JWT_SECRET, { ignoreExpiration: true });
    const session = get('SELECT * FROM sessions WHERE token=? AND active=1', [oldToken]);
    const user = get('SELECT * FROM users WHERE id=? AND active=1', [decoded.userId]);
    if (!session || !user) return res.status(401).json({ error: 'Session expired' });
    const token = jwt.sign({ userId: user.id, role: user.role, jti: crypto.randomUUID() }, JWT_SECRET, { expiresIn: '8h' });
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    run('UPDATE sessions SET active=0 WHERE token=?', [oldToken]);
    run('INSERT INTO sessions (user_id,token,ip_address,expires_at) VALUES (?,?,?,?)',
      [user.id, token, req.ip, expiresAt]);
    setSessionCookie(res, req, token);
    res.json({
      token,
      user: { id: user.id, name: user.name, username: user.username, role: user.role,
        org_access: user.org_access, permissions: userPermissions(user), pin_configured: Boolean(user.pin_hash) }
    });
  } catch (_) {
    res.status(401).json({ error: 'Session expired' });
  }
});

// Logout
router.post('/logout', authMiddleware, (req, res) => {
  run('UPDATE sessions SET active=0 WHERE token=?', [req.token]);
  clearSessionCookie(res, req);
  res.json({ success: true });
});

// Me
router.get('/me', authMiddleware, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, name: u.name, username: u.username, role: u.role,
    org_access: u.org_access, permissions: userPermissions(u), pin_configured: Boolean(u.pin_hash) });
});

router.get('/security-settings', authMiddleware, (req, res) => {
  const settings = all(`SELECT key,value FROM system_settings WHERE key IN
    ('auto_lock_enabled','auto_lock_minutes','auto_lock_warning_seconds')`);
  const values = Object.fromEntries(settings.map(row => [row.key, row.value]));
  res.json({
    enabled: values.auto_lock_enabled !== '0',
    minutes: Math.max(1, Number(values.auto_lock_minutes || 15)),
    warning_seconds: Math.max(10, Number(values.auto_lock_warning_seconds || 60))
  });
});

router.put('/security-settings', authMiddleware, requireAdminNetworkAccess, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const enabled = req.body.enabled ? '1' : '0';
  const minutes = Math.round(Number(req.body.minutes));
  const warningSeconds = Math.round(Number(req.body.warning_seconds));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 480) {
    return res.status(400).json({ error: 'Idle time must be between 1 and 480 minutes' });
  }
  if (!Number.isFinite(warningSeconds) || warningSeconds < 10 || warningSeconds > 300 || warningSeconds >= minutes * 60) {
    return res.status(400).json({ error: 'Warning must be 10-300 seconds and shorter than the idle time' });
  }
  [
    ['auto_lock_enabled', enabled],
    ['auto_lock_minutes', String(minutes)],
    ['auto_lock_warning_seconds', String(warningSeconds)]
  ].forEach(([key, value]) => run(
    `INSERT INTO system_settings (key,value,updated_by,updated_at) VALUES (?,?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=datetime('now')`,
    [key, value, req.user.id]
  ));
  run('INSERT INTO audit_log (user_id,action,table_name,new_data,ip_address) VALUES (?,?,?,?,?)',
    [req.user.id, 'UPDATE_SECURITY_SETTINGS', 'system_settings',
     JSON.stringify({ enabled: enabled === '1', minutes, warning_seconds: warningSeconds }), req.ip]);
  res.json({ success: true, enabled: enabled === '1', minutes, warning_seconds: warningSeconds });
});

router.post('/unlock', authMiddleware, (req, res) => {
  const secret = String(req.body.pin || req.body.password || '');
  if (!secret) return res.status(400).json({ error: 'PIN required' });
  const user = get('SELECT * FROM users WHERE id=? AND active=1', [req.user.id]);
  const validPin = user?.pin_hash && /^\d{4,6}$/.test(secret) && bcrypt.compareSync(secret, user.pin_hash);
  const validRecoveryPassword = user && bcrypt.compareSync(secret, user.password_hash);
  if (!user || (!validPin && !validRecoveryPassword)) {
    run('INSERT INTO audit_log (user_id,action,table_name,ip_address) VALUES (?,?,?,?)',
      [req.user.id, 'UNLOCK_FAILED', 'sessions', req.ip]);
    return res.status(401).json({ error: 'Incorrect PIN' });
  }
  run('INSERT INTO audit_log (user_id,action,table_name,ip_address) VALUES (?,?,?,?)',
    [req.user.id, 'UNLOCK', 'sessions', req.ip]);
  res.json({ success: true });
});

router.post('/lock-event', authMiddleware, (req, res) => {
  run('INSERT INTO audit_log (user_id,action,table_name,new_data,ip_address) VALUES (?,?,?,?,?)',
    [req.user.id, 'AUTO_LOCK', 'sessions', JSON.stringify({ reason: req.body.reason || 'idle' }), req.ip]);
  res.json({ success: true });
});

// Change password
router.post('/change-password', authMiddleware, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const user = get('SELECT * FROM users WHERE id=?', [req.user.id]);
  if (!bcrypt.compareSync(current_password, user.password_hash))
    return res.status(400).json({ error: 'Current password incorrect' });

  const hash = bcrypt.hashSync(new_password, 10);
  run('UPDATE users SET password_hash=? WHERE id=?', [hash, req.user.id]);
  run('UPDATE sessions SET active=0 WHERE user_id=? AND token!=?', [req.user.id, req.token]);
  res.json({ success: true, message: 'Password changed successfully' });
});

router.post('/change-pin', authMiddleware, (req, res) => {
  const currentSecret = String(req.body.current_pin || req.body.current_password || '');
  const newPin = String(req.body.new_pin || '');
  if (!currentSecret || !newPin) return res.status(400).json({ error: 'Current and new PIN are required' });
  if (!/^\d{4,6}$/.test(newPin)) return res.status(400).json({ error: 'PIN must contain 4 to 6 digits' });
  const user = get('SELECT * FROM users WHERE id=? AND active=1', [req.user.id]);
  const validPin = user?.pin_hash && /^\d{4,6}$/.test(currentSecret) &&
    bcrypt.compareSync(currentSecret, user.pin_hash);
  const validRecoveryPassword = user && bcrypt.compareSync(currentSecret, user.password_hash);
  if (!validPin && !validRecoveryPassword) return res.status(400).json({ error: 'Current PIN is incorrect' });
  run('UPDATE users SET pin_hash=? WHERE id=?', [bcrypt.hashSync(newPin, 10), user.id]);
  run('UPDATE sessions SET active=0 WHERE user_id=? AND token!=?', [user.id, req.token]);
  run('INSERT INTO audit_log (user_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?)',
    [user.id, 'CHANGE_OWN_PIN', 'users', user.id, JSON.stringify({ sessions_revoked: true }), req.ip]);
  res.json({ success: true, message: 'PIN changed successfully' });
});

// Get all users (owner only)
router.get('/users', authMiddleware, requireAdminNetworkAccess, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const users = all('SELECT id,name,username,role,org_access,permissions,active,last_login,created_at FROM users ORDER BY id');
  res.json(users);
});

router.get('/users-audit', authMiddleware, requireAdminNetworkAccess, (req, res) => {
  if (!primaryOwnerOnly(req, res)) return;
  res.json(all(
    `SELECT a.id,a.action,a.record_id,a.old_data,a.new_data,a.ip_address,a.timestamp,
      actor.username actor_username,target.username target_username
     FROM audit_log a
     LEFT JOIN users actor ON actor.id=a.user_id
     LEFT JOIN users target ON target.id=a.record_id
     WHERE a.table_name='users'
     ORDER BY a.id DESC LIMIT 200`
  ));
});

// Create user (owner only)
router.post('/users', authMiddleware, requireAdminNetworkAccess, (req, res) => {
  if (!primaryOwnerOnly(req, res)) return;
  const { name, username, pin, password, role, org_access, permissions } = req.body;
  if (!name || !username || (!pin && !password)) {
    return res.status(400).json({ error: 'Name, username and PIN are required' });
  }
  if (pin && !/^\d{4,6}$/.test(String(pin))) {
    return res.status(400).json({ error: 'PIN must contain 4 to 6 digits' });
  }
  if (!pin && String(password).length < 6) {
    return res.status(400).json({ error: 'Recovery password must be at least 6 characters' });
  }

  const exists = get('SELECT id FROM users WHERE username=?', [username]);
  if (exists) return res.status(400).json({ error: 'Username already exists' });

  const recoveryPassword = String(password || crypto.randomBytes(24).toString('base64url'));
  const hash = bcrypt.hashSync(recoveryPassword, 10);
  const pinHash = pin ? bcrypt.hashSync(String(pin), 10) : null;
  const allowedRoles = new Set(['owner', 'counter', 'operator', 'senior_operator', 'engineer']);
  const cleanRole = allowedRoles.has(role) ? role : 'operator';
  let cleanOrgAccess = 'all';
  if (org_access !== 'all') {
    try {
      const access = Array.isArray(org_access) ? org_access : JSON.parse(org_access || '[]');
      cleanOrgAccess = JSON.stringify(access.map(Number).filter(Number.isInteger));
    } catch (_) {
      return res.status(400).json({ error: 'Organization access is invalid' });
    }
  }
  const cleanPermissions = JSON.stringify(
    permissions && typeof permissions === 'object' && !Array.isArray(permissions) ? permissions : {}
  );
  const result = run('INSERT INTO users (name,username,password_hash,pin_hash,role,org_access,permissions) VALUES (?,?,?,?,?,?,?)',
    [String(name).trim(), String(username).trim(), hash, pinHash, cleanRole, cleanOrgAccess, cleanPermissions]);
  run('INSERT INTO audit_log (user_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?)',
    [req.user.id, 'CREATE_USER', 'users', result.lastInsertRowid,
     JSON.stringify({ username: String(username).trim(), name: String(name).trim(), role: cleanRole,
       org_access: cleanOrgAccess, permissions: JSON.parse(cleanPermissions), active: true }), req.ip]);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Update user (owner only)
router.put('/users/:id', authMiddleware, requireAdminNetworkAccess, (req, res) => {
  if (!primaryOwnerOnly(req, res)) return;
  const { name, role, org_access, active, permissions } = req.body;
  const existing = get('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'User not found' });
  const cleanName = String(name || '').trim();
  if (!cleanName) return res.status(400).json({ error: 'User name is required' });
  const allowedRoles = new Set(['owner', 'counter', 'operator', 'senior_operator', 'engineer']);
  const cleanRole = allowedRoles.has(role) ? role : 'operator';
  let cleanOrgAccess = 'all';
  if (org_access !== 'all') {
    try {
      const access = Array.isArray(org_access) ? org_access : JSON.parse(org_access || '[]');
      cleanOrgAccess = JSON.stringify(access.map(Number).filter(Number.isInteger));
    } catch (_) {
      return res.status(400).json({ error: 'Organization access is invalid' });
    }
  }
  const cleanPermissions = JSON.stringify(
    permissions && typeof permissions === 'object' && !Array.isArray(permissions) ? permissions : {}
  );
  const cleanActive = active === false || active === 0 || active === '0' ? 0 : 1;
  if (String(existing.username).toLowerCase() === 'owner1' &&
      (cleanRole !== 'owner' || cleanActive !== 1 || cleanOrgAccess !== 'all')) {
    return res.status(400).json({ error: 'Owner1 must remain an active owner with access to all organizations' });
  }
  run('UPDATE users SET name=?,role=?,org_access=?,permissions=?,active=? WHERE id=?',
    [cleanName, cleanRole, cleanOrgAccess, cleanPermissions, cleanActive, req.params.id]);
  if (!cleanActive || existing.role !== cleanRole || existing.org_access !== cleanOrgAccess ||
      existing.permissions !== cleanPermissions) {
    run('UPDATE sessions SET active=0 WHERE user_id=?', [existing.id]);
  }
  run('INSERT INTO audit_log (user_id,action,table_name,record_id,old_data,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
    [req.user.id, 'UPDATE_USER', 'users', existing.id,
     JSON.stringify({ username: existing.username, name: existing.name, role: existing.role,
       org_access: existing.org_access, permissions: JSON.parse(existing.permissions || '{}'), active: Boolean(existing.active) }),
     JSON.stringify({ username: existing.username, name: cleanName, role: cleanRole,
       org_access: cleanOrgAccess, permissions: JSON.parse(cleanPermissions), active: Boolean(cleanActive) }), req.ip]);
  res.json({ success: true });
});

router.post('/users/:id/reset-pin', authMiddleware, requireAdminNetworkAccess, (req, res) => {
  if (!primaryOwnerOnly(req, res)) return;
  const target = get('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const newPin = String(req.body.new_pin || '');
  if (!/^\d{4,6}$/.test(newPin)) return res.status(400).json({ error: 'PIN must contain 4 to 6 digits' });
  run('UPDATE users SET pin_hash=? WHERE id=?', [bcrypt.hashSync(newPin, 10), target.id]);
  run('UPDATE sessions SET active=0 WHERE user_id=?', [target.id]);
  run('INSERT INTO audit_log (user_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?)',
    [req.user.id, 'RESET_USER_PIN', 'users', target.id,
     JSON.stringify({ username: target.username, sessions_revoked: true }), req.ip]);
  res.json({ success: true, message: `PIN reset for ${target.username}` });
});

module.exports = router;
