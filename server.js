const express = require('express');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { initDB, initializeDB, getDBPath, getAppDataDir } = require('./src/db/db');
const APP_VERSION = require('./package.json').version;
const FRONTEND_ASSET = 'app-2.4.0.js';
const {
  REQUEST_BODY_LIMIT_MB,
  AUTH_RATE_LIMIT_MAX,
  CUSTOMER_PORTAL_RATE_LIMIT_MAX,
  deploymentProfile
} = require('./src/config/deployment-profile');
const {
  INTERNET_MODE, PUBLIC_BASE_URL, ALLOWED_ORIGINS, isLoopbackAddress,
  requestIp, requestIsRemote, hostAllowed, publicBaseUrl
} = require('./src/security/runtime-config');
const { startAttachmentAnalysisWorker } = require('./src/services/attachment-processing');
const { startAttachmentRetentionWorker } = require('./src/services/attachment-retention');
const { attachmentRoot } = require('./src/services/attachment-storage');
const { backupDirectory } = require('./src/services/automatic-backup');

const app = express();
const PORT = process.env.PORT || 3000;
const HTTPS_KEY_PATH = String(process.env.TARANGINI_HTTPS_KEY || '').trim();
const HTTPS_CERT_PATH = String(process.env.TARANGINI_HTTPS_CERT || '').trim();
const HTTPS_PFX_PATH = String(process.env.TARANGINI_HTTPS_PFX || '').trim();
const HTTPS_PFX_PASSPHRASE = String(process.env.TARANGINI_HTTPS_PFX_PASSPHRASE || '');
const HTTPS_ENABLED = Boolean(HTTPS_PFX_PATH || (HTTPS_KEY_PATH && HTTPS_CERT_PATH));
const HTTP_REDIRECT_PORT = Number(process.env.TARANGINI_HTTP_REDIRECT_PORT || 0);
const REQUIRE_HTTPS = process.env.TARANGINI_REQUIRE_HTTPS === '1' || INTERNET_MODE;
let revision = Date.now();
const syncClients = new Set();
const allowedOrigins = [...ALLOWED_ORIGINS];

if (INTERNET_MODE && !HTTPS_ENABLED) {
  throw new Error('Tarangini internet mode requires HTTPS certificates or a PFX configuration.');
}
if (INTERNET_MODE && PUBLIC_BASE_URL && !PUBLIC_BASE_URL.startsWith('https://')) {
  throw new Error('Tarangini internet mode requires TARANGINI_PUBLIC_BASE_URL to use https://');
}

function sameOriginRequest(req, origin) {
  try {
    const parsed = new URL(origin);
    const expectedProtocol = req.secure ? 'https:' : 'http:';
    return parsed.protocol === expectedProtocol && parsed.host === req.get('host');
  } catch (_) {
    return false;
  }
}

function broadcastChange(pathname, sourceClientId = '') {
  revision += 1;
  const payload = `data: ${JSON.stringify({
    revision,
    changed: pathname || '',
    source_client_id: String(sourceClientId || ''),
    time: new Date().toISOString()
  })}\n\n`;
  for (const client of syncClients) client.write(payload);
}

// Middleware
app.use(compression());
app.disable('x-powered-by');
app.set('trust proxy', process.env.TARANGINI_TRUST_PROXY === '1' ? 1 : false);
app.use((req, res, next) => {
  if (!hostAllowed(req)) {
    const remote = requestIsRemote(req);
    if (!remote && !INTERNET_MODE) return next();
    return res.status(421).json({ error: 'Request host is not allowed for this Tarangini server' });
  }
  next();
});
app.use((req, res, next) => {
  const remoteAddress = requestIp(req);
  if (REQUIRE_HTTPS && !req.secure && !isLoopbackAddress(remoteAddress)) {
    if (req.path.startsWith('/api/')) {
      return res.status(426).json({ error: 'HTTPS is required for remote Tarangini access' });
    }
    return res.status(426).type('text/plain').send('HTTPS is required for remote Tarangini access.');
  }
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(null, false);
  },
  credentials: false
}));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; " +
    "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; " +
    "connect-src 'self'; form-action 'self'");
  if (_req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(express.json({ limit: `${REQUEST_BODY_LIMIT_MB}mb` }));
app.use(express.urlencoded({ extended: true, limit: `${REQUEST_BODY_LIMIT_MB}mb` }));
app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const hasCookieSession = /(?:^|;\s*)tarangini_session=/.test(String(req.headers.cookie || ''));
  const hasBearer = /^Bearer\s+\S+/i.test(String(req.headers.authorization || ''));
  if (!hasCookieSession || hasBearer) return next();
  const origin = String(req.headers.origin || '').trim();
  if (!origin || sameOriginRequest(req, origin) || allowedOrigins.includes(origin)) return next();
  return res.status(403).json({ error: 'Cross-origin request blocked' });
});

app.get('/api/sync/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive'
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ revision, connected: true })}\n\n`);
  syncClients.add(res);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    syncClients.delete(res);
  });
});

app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        broadcastChange(req.originalUrl, req.get('x-tarangini-client-id'));
      }
    });
  }
  next();
});

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  version: APP_VERSION,
  frontend_asset: FRONTEND_ASSET,
  transport: HTTPS_ENABLED ? 'https' : 'http',
  secure: req.secure,
  require_https: REQUIRE_HTTPS,
  remote_http_blocked: REQUIRE_HTTPS,
  internet_mode: INTERNET_MODE,
  public_base_url: publicBaseUrl(req),
  request_ip: requestIp(req),
  deployment_profile: deploymentProfile(),
  service_mode: process.env.TARANGINI_WINDOWS_SERVICE === '1' ||
    process.argv.includes('--tarangini-service'),
  storage_locations: {
    app_data_dir: getAppDataDir(),
    database_path: getDBPath(),
    attachment_dir: attachmentRoot(),
    backup_dir: backupDirectory()
  },
  revision,
  time: new Date().toISOString()
}));

// Rate limiting for auth
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: AUTH_RATE_LIMIT_MAX,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Try after 15 minutes.' }
});
const customerPortalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: CUSTOMER_PORTAL_RATE_LIMIT_MAX,
  message: { error: 'Too many customer portal requests. Try again later.' }
});

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(?:html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
app.get('/app.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', FRONTEND_ASSET));
});

// Initialize DB then start
initDB().then(() => {
  initializeDB();

  // Routes
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/unlock', authLimiter);
  app.use('/api/auth', require('./src/routes/auth'));
  app.use('/api/orgs', require('./src/routes/orgs'));
  app.use('/api/parties', require('./src/routes/parties'));
  app.use('/api/items', require('./src/routes/items'));
  app.use('/api/job-portal', customerPortalLimiter, require('./src/routes/job-portal'));
  app.use('/api/job-intake', customerPortalLimiter, require('./src/routes/job-intake'));
  app.use('/api/jobs', require('./src/routes/jobs'));
  app.use('/api/operator-logs', require('./src/routes/operator-logs'));
  app.use('/api/warranty-replacements', require('./src/routes/warranty-replacements'));
  app.use('/api/bills', require('./src/routes/bills'));
  app.use('/api/accounting', require('./src/routes/accounting'));
  app.use('/api/business', require('./src/routes/business'));
  const advanced = require('./src/routes/advanced');
  app.use('/api/advanced', advanced.router);

  const { paymentsRouter, reportsRouter } = require('./src/routes/reports');
  app.use('/api', paymentsRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/backup', require('./src/routes/backup'));
  require('./src/services/automatic-backup').startAutomaticBackups();
  startAttachmentAnalysisWorker();
  startAttachmentRetentionWorker();
  advanced.startScheduledReports();

  // SPA fallback
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
  });
  app.use('/api', (err, req, res, _next) => {
    console.error(`API error ${req.method} ${req.originalUrl}:`, err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'The operation could not be completed. Check the server log for details.' });
  });

  const server = HTTPS_ENABLED
    ? https.createServer(HTTPS_PFX_PATH
      ? {
        pfx: fs.readFileSync(HTTPS_PFX_PATH),
        passphrase: HTTPS_PFX_PASSPHRASE
      }
      : {
        key: fs.readFileSync(HTTPS_KEY_PATH),
        cert: fs.readFileSync(HTTPS_CERT_PATH)
      }, app)
    : http.createServer(app);
  server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔════════════════════════════════════════════╗');
    console.log('║   TARANGINI WORKFLOW SUITE                 ║');
    console.log('║   Billing, Production & Customer Portal    ║');
    console.log('╠════════════════════════════════════════════╣');
    console.log(`║   Local:    http://localhost:${PORT}           ║`);
    console.log(`║   Network:  http://[YOUR-IP]:${PORT}           ║`);
    console.log('║                                            ║');
    console.log('║   Initial Recovery Logins:                 ║');
    console.log('║   owner1 / owner123   (Owner)              ║');
    console.log('║   operator1 / operator123  (Operator)      ║');
    console.log('║                                            ║');
    console.log('║   ⚠ OWNER1 SHOULD ASSIGN USER PINS!        ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log('');
  });
  server.on('error', err => {
    if (err?.code === 'EADDRINUSE') {
      console.error(`Tarangini Workflow Suite cannot start because port ${PORT} is already in use.`);
      return;
    }
    console.error('Tarangini Workflow Suite server error:', err);
  });
  if (HTTPS_ENABLED && HTTP_REDIRECT_PORT > 0 && HTTP_REDIRECT_PORT !== Number(PORT)) {
    const redirect = http.createServer((req, res) => {
      const host = String(req.headers.host || 'localhost').replace(/:\d+$/, `:${PORT}`);
      res.writeHead(308, { Location: `https://${host}${req.url || '/'}` });
      res.end();
    });
    redirect.listen(HTTP_REDIRECT_PORT, '0.0.0.0');
    redirect.on('error', err => console.error('HTTPS redirect server error:', err.message));
  }
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
