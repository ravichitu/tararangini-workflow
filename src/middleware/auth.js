const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { get } = require('../db/db');
const { getFY } = require('../accounting/accounting');
const { sessionToken } = require('../security/session');
const { adminIpAllowed, adminIpRestricted } = require('../security/runtime-config');

function persistentJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const dataDir = process.env.TARANGINI_DATA_DIR || path.join(__dirname, '../../database');
  const secretPath = path.join(dataDir, '.jwt-secret');
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const saved = fs.readFileSync(secretPath, 'utf8').trim();
    if (saved.length >= 48) return saved;
  } catch (_) {}
  const generated = crypto.randomBytes(48).toString('base64url');
  try {
    fs.writeFileSync(secretPath, generated, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return generated;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const saved = fs.readFileSync(secretPath, 'utf8').trim();
    if (saved.length < 48) throw new Error('Stored authentication secret is invalid');
    return saved;
  }
}

const JWT_SECRET = persistentJwtSecret();

function authMiddleware(req, res, next) {
  const token = sessionToken(req);
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const session = get('SELECT * FROM sessions WHERE token=? AND active=1', [token]);
    if (!session) return res.status(401).json({ error: 'Session expired' });

    const user = get('SELECT * FROM users WHERE id=? AND active=1', [decoded.userId]);
    if (!user) return res.status(401).json({ error: 'User not found' });

    req.user = user;
    req.token = token;
    next();
  } catch(e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function ownerOnly(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  next();
}

function checkOrgAccess(req, res, next) {
  const orgId = parseInt(req.params.org_id || req.query.org_id || req.body?.org_id);
  if (!orgId) return next();
  
  if (req.user.org_access === 'all') return next();
  
  try {
    const access = JSON.parse(req.user.org_access || '[]');
    if (!access.includes(orgId)) return res.status(403).json({ error: 'No access to this organization' });
  } catch(e) {}
  next();
}

function canAccessOrg(user, orgId) {
  const id = Number(orgId);
  if (!id) return false;
  if (user?.org_access === 'all') return true;
  try {
    return JSON.parse(user?.org_access || '[]').map(Number).includes(id);
  } catch (_) {
    return false;
  }
}

function requireOrgAccess(req, res, orgId) {
  if (canAccessOrg(req.user, orgId)) return true;
  res.status(403).json({ error: 'No access to this organization' });
  return false;
}

function userPermissions(user) {
  if (user.role === 'owner') return {
    billing: true, purchases: true, inventory: true, accounting: true,
    reports: true, settings: true, delete: true, pos: true, returns: true,
    shifts: true, bank_import: true, backup: true, profit: true,
    purchase_orders: true, diagnostics: true, scheduled_reports: true,
    jobs_counter: true, jobs_operations: true, jobs_assign: true, jobs_assign_any: true,
    jobs_finance: true, jobs_catalog: true, jobs_whatsapp: true
  };
  const roleDefaults = {
    counter: {
      billing: true, inventory: true, reports: true, pos: true, shifts: true,
      jobs_counter: true, jobs_operations: false, jobs_assign: true, jobs_assign_any: false,
      jobs_finance: true, jobs_catalog: false, jobs_whatsapp: true
    },
    operator: {
      billing: true, inventory: true, reports: false, pos: true, shifts: true,
      jobs_counter: false, jobs_operations: true, jobs_assign: true, jobs_assign_any: false,
      jobs_finance: false, jobs_catalog: false, jobs_whatsapp: false
    },
    senior_operator: {
      billing: false, inventory: false, reports: false, pos: false, shifts: false,
      jobs_counter: false, jobs_operations: true, jobs_assign: true, jobs_assign_any: true,
      jobs_finance: false, jobs_catalog: false, jobs_whatsapp: false
    },
    engineer: {
      billing: false, inventory: false, reports: false, pos: false, shifts: false,
      jobs_counter: false, jobs_operations: true, jobs_assign: true, jobs_assign_any: false,
      jobs_finance: false, jobs_catalog: false, jobs_whatsapp: false
    }
  };
  try {
    return {
      billing: true,
      purchases: false,
      inventory: true,
      accounting: false,
      reports: true,
      settings: false,
      delete: false,
      pos: true,
      returns: false,
      shifts: true,
      bank_import: false,
      backup: false,
      profit: false,
      purchase_orders: false,
      diagnostics: false,
      scheduled_reports: false,
      jobs_counter: false,
      jobs_operations: false,
      jobs_assign: false,
      jobs_assign_any: false,
      jobs_finance: false,
      jobs_catalog: false,
      jobs_whatsapp: false,
      ...(roleDefaults[user.role] || {}),
      ...JSON.parse(user.permissions || '{}')
    };
  } catch (_) {
    return { billing: true, inventory: true, reports: true };
  }
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!userPermissions(req.user)[permission]) {
      return res.status(403).json({ error: `${permission} permission required` });
    }
    next();
  };
}

function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    const granted = userPermissions(req.user);
    if (!permissions.some(permission => granted[permission])) {
      return res.status(403).json({ error: `${permissions.join(' or ')} permission required` });
    }
    next();
  };
}

function requireAdminNetworkAccess(req, res, next) {
  if (!adminIpRestricted() || adminIpAllowed(req)) return next();
  return res.status(403).json({ error: 'Administrator access is restricted to approved network addresses' });
}

function isPeriodLocked(orgId, dateValue) {
  const row = get('SELECT locked FROM financial_year_locks WHERE org_id=? AND fy=?', [orgId, getFY(dateValue)]);
  return Boolean(row?.locked);
}

function rejectLockedPeriod(req, res, next) {
  const orgId = Number(req.body?.org_id || req.query?.org_id);
  const dateValue = req.body?.bill_date || req.body?.purchase_date || req.body?.expense_date ||
    req.body?.note_date || req.body?.payment_date || req.body?.entry_date || req.body?.po_date;
  if (orgId && dateValue && isPeriodLocked(orgId, dateValue)) {
    return res.status(423).json({ error: `Financial year ${getFY(dateValue)} is locked` });
  }
  next();
}

module.exports = {
  authMiddleware, ownerOnly, checkOrgAccess, JWT_SECRET, userPermissions,
  requirePermission, requireAnyPermission, canAccessOrg, requireOrgAccess,
  isPeriodLocked, rejectLockedPeriod, requireAdminNetworkAccess
};
