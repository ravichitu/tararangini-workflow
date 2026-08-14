const assert = require('assert');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const APP_VERSION = require('../package.json').version;

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.deployment-test');
const certDir = path.join(dataDir, 'certificates');
const backupDir = path.join(dataDir, 'second-drive-backups');
const pfxPath = path.join(certDir, 'localhost.pfx');
const pfxPassphrase = 'tarangini-test-certificate';
const port = 3235;
const redirectPort = 3236;
const publicBaseUrl = 'https://billing.example.com';
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(certDir, { recursive: true });

const certificateScript = `
$ErrorActionPreference='Stop'
$rsa=[System.Security.Cryptography.RSA]::Create(2048)
$request=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
  'CN=localhost',$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,
  [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$cert=$request.CreateSelfSigned([DateTimeOffset]::Now.AddMinutes(-5),[DateTimeOffset]::Now.AddDays(2))
$bytes=$cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,'${pfxPassphrase}')
[IO.File]::WriteAllBytes('${pfxPath.replace(/'/g, "''")}',$bytes)
`;
const generated = spawnSync('powershell.exe', ['-NoProfile', '-Command', certificateScript], {
  encoding: 'utf8'
});
if (generated.status !== 0) {
  throw new Error(`Could not generate HTTPS test certificate: ${generated.stderr || generated.stdout}`);
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    TARANGINI_DATA_DIR: dataDir,
    TARANGINI_HTTPS_PFX: pfxPath,
    TARANGINI_HTTPS_PFX_PASSPHRASE: pfxPassphrase,
    TARANGINI_HTTP_REDIRECT_PORT: String(redirectPort),
    TARANGINI_INTERNET_MODE: '1',
    TARANGINI_PUBLIC_BASE_URL: publicBaseUrl,
    TARANGINI_ALLOWED_HOSTS: '127.0.0.1,localhost,billing.example.com',
    TARANGINI_DEFAULT_BACKUP_DIR: backupDir
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => { output += chunk; });
server.stderr.on('data', chunk => { output += chunk; });

function secureRequest(method, route, body, token) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: '127.0.0.1',
      port,
      path: `/api${route}`,
      method,
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let payload;
        try { payload = JSON.parse(text); } catch (_) { payload = text; }
        resolve({ status: response.statusCode, payload, headers: response.headers });
      });
    });
    request.on('error', reject);
    if (body !== undefined) request.write(JSON.stringify(body));
    request.end();
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const response = await secureRequest('GET', '/health');
      if (response.status === 200) return response.payload;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`HTTPS server did not start:\n${output}`);
}

(async () => {
  try {
    const health = await waitForServer();
    assert.strictEqual(health.version, APP_VERSION);
    assert.strictEqual(health.transport, 'https');
    assert.strictEqual(health.secure, true);
    assert.strictEqual(health.internet_mode, true);
    assert.strictEqual(health.public_base_url, publicBaseUrl);
    assert.strictEqual(health.deployment_profile.target_concurrent_customers, 200);
    assert.strictEqual(health.deployment_profile.attachment_storage_mode, 'inline-db');
    assert.strictEqual(health.storage_locations.database_path, path.join(dataDir, 'tarangini.db'));
    assert.strictEqual(health.storage_locations.attachment_dir, path.join(dataDir, 'attachments'));
    assert.strictEqual(health.storage_locations.backup_dir, backupDir);

    const redirect = await fetch(`http://127.0.0.1:${redirectPort}/mobile`, { redirect: 'manual' });
    assert.strictEqual(redirect.status, 308);
    assert.strictEqual(redirect.headers.get('location'), `https://127.0.0.1:${port}/mobile`);

    const login = await secureRequest('POST', '/auth/login', {
      username: 'owner1', password: 'owner123'
    });
    assert.strictEqual(login.status, 200);
    const token = login.payload.token;

    const qr = await secureRequest('GET', '/advanced/mobile-login-qr', undefined, token);
    assert.strictEqual(qr.status, 200);
    assert.strictEqual(qr.payload.url, `${publicBaseUrl}/mobile-${APP_VERSION}`);

    const diagnostics = await secureRequest('GET', '/advanced/integrity', undefined, token);
    assert.strictEqual(diagnostics.status, 200);
    assert.strictEqual(diagnostics.payload.deployment.transport, 'https');
    assert.strictEqual(diagnostics.payload.deployment.internet_mode, true);
    assert.strictEqual(diagnostics.payload.deployment.public_base_url, publicBaseUrl);
    assert.strictEqual(diagnostics.payload.deployment.profile.target_concurrent_customers, 200);
    assert.ok(Number(diagnostics.payload.maintenance.database_size_mb) >= 0);
    assert.strictEqual(diagnostics.payload.maintenance.storage_locations.database_path, path.join(dataDir, 'tarangini.db'));
    assert.strictEqual(diagnostics.payload.maintenance.storage_locations.backup_dir, backupDir);
    assert.strictEqual(diagnostics.payload.production_health.automatic_backup.effective_directory, backupDir);
    assert.strictEqual(diagnostics.payload.production_health.service_mode, false);
    assert.ok(diagnostics.payload.production_health.customer_portal_url.includes('/customer-intake.html?org='));
    assert.ok(Array.isArray(diagnostics.payload.production_health.lan_addresses));

    const performance = await secureRequest('GET', '/advanced/performance?org_id=1', undefined, token);
    assert.strictEqual(performance.status, 200);
    assert.ok(Number(performance.payload.query_ms) >= 0);
    assert.ok(Number(performance.payload.database.page_count) >= 0);
    assert.strictEqual(performance.payload.database.journal_mode.toLowerCase(), 'wal');
    assert.ok(Number(performance.payload.process.memory_mb) > 0);
    assert.ok(Number(performance.payload.records.bills) >= 0);
    assert.ok(Number(performance.payload.records.attachments) >= 0);
    assert.ok(Object.prototype.hasOwnProperty.call(performance.payload.queue, 'attachment_analysis_pending'));

    const maintenance = await secureRequest('POST', '/advanced/maintenance', {}, token);
    assert.strictEqual(maintenance.status, 200);
    assert.strictEqual(maintenance.payload.success, true);
    assert.ok(maintenance.payload.preserved.includes('financial records'));
    console.log('HTTPS deployment and maintenance integration tests passed');
  } finally {
    if (!server.killed) {
      server.kill();
      await new Promise(resolve => {
        server.once('exit', resolve);
        setTimeout(resolve, 2000);
      });
    }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => {
  console.error(error);
  console.error(output);
  process.exitCode = 1;
});
