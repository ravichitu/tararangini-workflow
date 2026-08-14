function csvList(value) {
  return String(value || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const url = new URL(raw);
  return url.toString().replace(/\/$/, '');
}

function isLoopbackAddress(value) {
  const address = String(value || '').replace(/^::ffff:/, '').toLowerCase();
  return address === '127.0.0.1' || address === '::1' || address === 'localhost';
}

function isPrivateLanHost(value) {
  const host = String(value || '').replace(/^\[|\]$/g, '').trim().toLowerCase();
  return isLoopbackAddress(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

function normalizedIp(value) {
  return String(value || '').replace(/^::ffff:/, '').trim().toLowerCase();
}

const PUBLIC_BASE_URL = normalizeBaseUrl(process.env.TARANGINI_PUBLIC_BASE_URL || '');
const INTERNET_MODE = process.env.TARANGINI_INTERNET_MODE === '1' || Boolean(PUBLIC_BASE_URL);
const PUBLIC_URL = PUBLIC_BASE_URL ? new URL(PUBLIC_BASE_URL) : null;
const ALLOWED_ORIGINS = new Set([
  ...csvList(process.env.TARANGINI_ALLOWED_ORIGINS),
  ...(PUBLIC_URL ? [PUBLIC_URL.origin] : [])
]);
const ALLOWED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  ...csvList(process.env.TARANGINI_ALLOWED_HOSTS).map(host => host.toLowerCase()),
  ...(PUBLIC_URL ? [PUBLIC_URL.hostname.toLowerCase()] : [])
]);
const ADMIN_ALLOWED_IPS = new Set(
  csvList(process.env.TARANGINI_ADMIN_ALLOWED_IPS).map(normalizedIp)
);

function requestIp(req) {
  return normalizedIp(req.ip || req.socket?.remoteAddress || '');
}

function requestIsRemote(req) {
  return !isLoopbackAddress(requestIp(req));
}

function requestHost(req) {
  return String(req.hostname || req.headers.host || '')
    .trim()
    .replace(/:\d+$/, '')
    .toLowerCase();
}

function hostAllowed(req) {
  if (!INTERNET_MODE && isPrivateLanHost(requestHost(req))) return true;
  if (!ALLOWED_HOSTS.size) return true;
  return ALLOWED_HOSTS.has(requestHost(req));
}

function publicBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const protocol = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
    ? 'https'
    : 'http';
  return `${protocol}://${String(req.headers.host || 'localhost').trim().replace(/\/$/, '')}`;
}

function buildAbsoluteUrl(req, pathname) {
  const base = publicBaseUrl(req);
  const path = String(pathname || '').startsWith('/') ? String(pathname || '') : `/${pathname || ''}`;
  return `${base}${path}`;
}

function adminIpRestricted() {
  return ADMIN_ALLOWED_IPS.size > 0;
}

function adminIpAllowed(req) {
  if (!adminIpRestricted()) return true;
  return ADMIN_ALLOWED_IPS.has(requestIp(req));
}

module.exports = {
  PUBLIC_BASE_URL,
  INTERNET_MODE,
  ALLOWED_ORIGINS,
  ALLOWED_HOSTS,
  ADMIN_ALLOWED_IPS,
  normalizeBaseUrl,
  isLoopbackAddress,
  isPrivateLanHost,
  requestIp,
  requestIsRemote,
  requestHost,
  hostAllowed,
  publicBaseUrl,
  buildAbsoluteUrl,
  adminIpRestricted,
  adminIpAllowed
};
