const COOKIE_NAME = 'tarangini_session';
const SESSION_SECONDS = 8 * 60 * 60;

function parseCookies(header) {
  return String(header || '').split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator < 1) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch (_) {
      cookies[key] = value;
    }
    return cookies;
  }, {});
}

function bearerToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  const token = String(match?.[1] || '').trim();
  return token && token !== 'null' && token !== 'undefined' ? token : '';
}

function cookieToken(req) {
  return String(parseCookies(req.headers.cookie)[COOKIE_NAME] || '').trim();
}

function sessionToken(req) {
  return bearerToken(req) || cookieToken(req);
}

function requestIsSecure(req) {
  return Boolean(req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
}

function setSessionCookie(res, req, token) {
  const attributes = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_SECONDS}`,
    'Priority=High'
  ];
  if (requestIsSecure(req)) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function clearSessionCookie(res, req) {
  const attributes = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    'Priority=High'
  ];
  if (requestIsSecure(req)) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

module.exports = {
  COOKIE_NAME,
  bearerToken,
  cookieToken,
  sessionToken,
  requestIsSecure,
  setSessionCookie,
  clearSessionCookie
};
