const { app, BrowserWindow, ipcMain, Menu, dialog, safeStorage, shell, Tray } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const childProcess = require('child_process');
const { autoUpdater } = require('electron-updater');
const { OfflineProxy } = require('./offline-proxy');
const { getDeviceIdentity } = require('./device-identity');
const { UpdateService } = require('./update-service');
const EXPECTED_FRONTEND_ASSET = 'app-2.4.0.js';
const SERVICE_NAME = 'TaranginiWorkflowMain';
const FIREWALL_RULE_NAME = 'Tarangini Workflow Local Portal';
const CLIENT_PORTAL_PORT = 3001;
const isServiceMode = process.argv.includes('--tarangini-service') ||
  process.env.TARANGINI_WINDOWS_SERVICE === '1';
const isWebInvoiceBatchMode = process.argv.includes('--web-invoice-batch');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');

let mainWindow;
let serverStarted = false;
let offlineProxy = null;
let tray = null;
let allowQuit = false;
let activeConfig = null;
let updateService = null;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

const hasSingleInstanceLock = isServiceMode || isWebInvoiceBatchMode || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else if (!isServiceMode && !isWebInvoiceBatchMode) {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function configPath() {
  if (isServiceMode && argValue('--tarangini-config')) return path.resolve(argValue('--tarangini-config'));
  return path.join(app.getPath('userData'), 'network.json');
}

function serviceScriptPath() {
  return path.join(app.getAppPath(), 'tools', 'windows-service', 'tarangini-service.ps1');
}

function firewallScriptPath() {
  return path.join(app.getAppPath(), 'tools', 'windows-firewall', 'tarangini-firewall.ps1');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  const temporary = `${configPath()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2));
  fs.renameSync(temporary, configPath());
}

function currentDeviceIdentity() {
  return getDeviceIdentity(app.getPath('userData'));
}

function shouldKeepHostAlive() {
  return activeConfig?.role === 'host' && activeConfig.keepAliveOnClose !== false;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function updateInstallSafety() {
  if (!offlineProxy) return { safe: true };
  const counts = offlineProxy.getStatus()?.counts || {};
  const pending = Number(counts.pending || 0);
  const conflicts = Number(counts.conflict || 0);
  if (pending || conflicts) {
    return {
      safe: false,
      reason: `Sync ${pending} pending item(s) and resolve ${conflicts} conflict(s) before installing this update.`
    };
  }
  return { safe: true };
}

function getUpdateService() {
  if (isServiceMode || isWebInvoiceBatchMode) return null;
  if (!updateService) {
    updateService = new UpdateService({
      app,
      autoUpdater,
      dialog,
      canInstall: updateInstallSafety
    });
  }
  return updateService;
}

async function checkForWebUpdates() {
  const service = getUpdateService();
  if (!service) return { enabled: false, state: 'disabled', reason: 'Updates are unavailable in service mode.' };
  service.start();
  return service.checkNow();
}

function ensureTray() {
  if (tray) return tray;
  tray = new Tray(path.join(__dirname, '..', 'assets', 'tarangini.png'));
  tray.setToolTip('Tarangini Workflow Suite');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Tarangini', click: showMainWindow },
    {
      label: 'Main / Client System Setup',
      click: () => {
        showMainWindow();
        mainWindow.loadFile(path.join(__dirname, 'setup.html'));
      }
    },
    { type: 'separator' },
    {
      label: 'Quit Tarangini Server',
      click: () => {
        allowQuit = true;
        app.quit();
      }
    }
  ]));
  tray.on('double-click', showMainWindow);
  return tray;
}

function applyHostStartupSetting(config) {
  if (config?.role !== 'host') return;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(config.startAtLogin),
      openAsHidden: Boolean(config.startAtLogin)
    });
  } catch (_) {
    // Login item support depends on the Windows install context.
  }
}

function runServiceScript(action, extra = {}) {
  return new Promise((resolve, reject) => {
    const script = serviceScriptPath();
    if (!fs.existsSync(script)) {
      reject(new Error(`Windows Service helper script was not found at ${script}`));
      return;
    }
    const args = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-Action', action,
      '-ServiceName', SERVICE_NAME,
      '-AppExe', process.execPath,
      '-ConfigPath', configPath()
    ];
    if (extra.startAfterInstall) args.push('-StartAfterInstall');
    childProcess.execFile('powershell.exe', args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || stdout || error.message || '').trim();
        reject(new Error(message || `Windows Service ${action} failed`));
        return;
      }
      resolve({ action, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    });
  });
}

function runFirewallScript(action) {
  return new Promise((resolve, reject) => {
    const script = firewallScriptPath();
    if (!fs.existsSync(script)) return reject(new Error(`Windows Firewall helper was not found at ${script}`));
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Action', action, '-Port', String(CLIENT_PORTAL_PORT), '-RuleName', FIREWALL_RULE_NAME
    ];
    childProcess.execFile('powershell.exe', args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || stdout || error.message || '').trim() || `Firewall ${action} failed`));
      let status = {};
      try { status = JSON.parse(String(stdout || '{}').trim()); } catch (_) {}
      resolve({ action, ...status });
    });
  });
}

async function getWindowsServiceStatus() {
  if (process.platform !== 'win32') {
    return { supported: false, installed: false, status: 'unsupported', service_name: SERVICE_NAME };
  }
  try {
    const result = await runServiceScript('status');
    return { supported: true, service_name: SERVICE_NAME, ...JSON.parse(result.stdout || '{}') };
  } catch (error) {
    return {
      supported: true,
      installed: false,
      status: 'unknown',
      service_name: SERVICE_NAME,
      error: error.message
    };
  }
}

function normalizeServerUrl(value) {
  let url = String(value || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  const parsed = new URL(url);
  if (!parsed.port) parsed.port = '3000';
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const privateHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ||
    /^10\./.test(hostname) || /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
  if (parsed.protocol !== 'https:' && !privateHost) {
    throw new Error('Internet or public server addresses must use HTTPS');
  }
  return parsed.origin;
}

function normalizeOptionalDir(value) {
  const text = String(value || '').trim();
  return text ? path.resolve(text) : '';
}

function ensureConfiguredDir(value, label) {
  const dir = normalizeOptionalDir(value);
  if (!dir) return '';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    return dir;
  } catch (error) {
    throw new Error(`${label} is not writable: ${error.message}`);
  }
}

function waitForServer(url, attempts = 40) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const client = new URL(url).protocol === 'https:' ? https : http;
      const request = client.get(`${url}/api/health`, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => {
          if (response.statusCode === 200) {
            try {
              const health = JSON.parse(body);
              if (health.frontend_asset === EXPECTED_FRONTEND_ASSET) return resolve();
            } catch (_) {}
          }
          retry();
        });
      });
      request.setTimeout(1000, () => request.destroy());
      request.on('error', retry);
    };
    const retry = () => {
      attempts -= 1;
      if (attempts <= 0) return reject(new Error(`Cannot connect to ${url}`));
      setTimeout(check, 500);
    };
    check();
  });
}

function requestHealth(url, timeoutMs = 700) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const client = new URL(url).protocol === 'https:' ? https : http;
      const request = client.get(`${url.replace(/\/+$/, '')}/api/health`, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => {
          try {
            const health = JSON.parse(body || '{}');
            finish({
              ok: response.statusCode === 200 && health.frontend_asset === EXPECTED_FRONTEND_ASSET,
              status: response.statusCode,
              url: url.replace(/\/+$/, ''),
              version: health.version || '',
              app: health.app || '',
              frontend_asset: health.frontend_asset || ''
            });
          } catch (error) {
            finish({ ok: false, url, error: error.message });
          }
        });
      });
      request.setTimeout(timeoutMs, () => {
        request.destroy();
        finish({ ok: false, url, error: 'Connection timed out' });
      });
      request.on('error', error => finish({ ok: false, url, error: error.message }));
    } catch (error) {
      finish({ ok: false, url, error: error.message });
    }
  });
}

function localLanPrefixes() {
  const prefixes = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const parts = String(entry.address || '').split('.');
      if (parts.length !== 4) continue;
      if (/^(10|192)$/.test(parts[0]) || (parts[0] === '172' && Number(parts[1]) >= 16 && Number(parts[1]) <= 31)) {
        prefixes.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
      }
    }
  }
  return [...prefixes];
}

async function discoverMainSystems() {
  const candidates = new Set(['http://127.0.0.1:3000']);
  for (const prefix of localLanPrefixes()) {
    for (let i = 1; i <= 254; i += 1) candidates.add(`http://${prefix}.${i}:3000`);
  }
  const urls = [...candidates];
  const found = [];
  const concurrency = 32;
  let index = 0;
  async function worker() {
    while (index < urls.length) {
      const url = urls[index++];
      const result = await requestHealth(url, 450);
      if (result.ok) found.push(result);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return found.sort((a, b) => a.url.localeCompare(b.url));
}

function startCentralServer(config = {}) {
  if (serverStarted) return;
  serverStarted = true;
  process.env.PORT = '3000';
  const defaultDataDir = config.serviceUserDataDir
    ? path.join(config.serviceUserDataDir, 'database')
    : path.join(app.getPath('userData'), 'database');
  process.env.TARANGINI_DATA_DIR = ensureConfiguredDir(config.hostDataDir, 'Database folder') ||
    defaultDataDir;
  const attachmentDir = ensureConfiguredDir(config.hostAttachmentDir, 'Attachment folder');
  if (attachmentDir) {
    process.env.TARANGINI_ATTACHMENT_DIR = attachmentDir;
    process.env.TARANGINI_DEPLOYMENT_PROFILE = process.env.TARANGINI_DEPLOYMENT_PROFILE || 'store';
  }
  const backupDir = ensureConfiguredDir(config.hostBackupDir, 'Backup folder');
  if (backupDir) process.env.TARANGINI_DEFAULT_BACKUP_DIR = backupDir;
  require(path.join(app.getAppPath(), 'server.js'));
}

async function openServiceMode() {
  const config = readConfig() || {};
  if (config.role && config.role !== 'host') {
    throw new Error('Windows Service mode can only run on the configured Main System.');
  }
  activeConfig = { ...config, role: 'host', serviceUserDataDir: path.dirname(configPath()) };
  startCentralServer(activeConfig);
  await waitForServer('http://127.0.0.1:3000', 80);
}

async function openConfiguredApp(config) {
  activeConfig = config;
  applyHostStartupSetting(config);
  if (config.role === 'host') {
    if (offlineProxy) {
      offlineProxy.stop();
      offlineProxy = null;
    }
    startCentralServer(config);
    const serverUrl = 'http://127.0.0.1:3000';
    try {
      await waitForServer(serverUrl);
      await mainWindow.loadURL(serverUrl);
    } catch (error) {
      await dialog.showMessageBox(mainWindow, {
        type: 'error', title: 'Server not available',
        message: 'Tarangini Billing could not start the updated main system.',
        detail: `${error.message}\n\nClose every older Tarangini Billing window and start version 2.4.1 again.`
      });
      await mainWindow.loadFile(path.join(__dirname, 'setup.html'));
    }
    return;
  }

  try {
    if (offlineProxy) offlineProxy.stop();
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows secure storage is unavailable. Offline client data cannot be stored safely on this computer.');
    }
    offlineProxy = new OfflineProxy({
      appPath: app.getAppPath(),
      userData: app.getPath('userData'),
      serverUrl: normalizeServerUrl(config.serverUrl),
      deviceCode: config.deviceCode,
      deviceIdentity: config.deviceIdentity || currentDeviceIdentity(),
      portalLanEnabled: Boolean(config.clientPortalLanEnabled),
      protectToken: token => safeStorage.encryptString(token).toString('base64'),
      unprotectToken: token => {
        try { return safeStorage.decryptString(Buffer.from(token, 'base64')); }
        catch (_) { throw new Error('Stored offline token could not be decrypted'); }
      },
      protectData: value => safeStorage.encryptString(value).toString('base64'),
      unprotectData: value => {
        try { return safeStorage.decryptString(Buffer.from(value, 'base64')); }
        catch (_) { throw new Error('Stored offline data could not be decrypted'); }
      },
      discoverServer: async currentUrl => {
        const discovered = (await discoverMainSystems())
          .filter(item => !/^http:\/\/(127\.0\.0\.1|localhost):/i.test(item.url));
        if (discovered.some(item => item.url === currentUrl)) return currentUrl;
        return discovered.length === 1 ? discovered[0].url : null;
      },
      onServerUrlChanged: discoveredUrl => {
        config.serverUrl = normalizeServerUrl(discoveredUrl);
        activeConfig = config;
        writeConfig(config);
      }
    });
    await offlineProxy.start();
    await mainWindow.loadURL('http://127.0.0.1:3001');
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Offline client could not start',
      message: 'Tarangini Billing could not start the local offline billing service.',
      detail: error.message
    });
    await mainWindow.loadFile(path.join(__dirname, 'setup.html'));
  }
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Tarangini Billing',
      submenu: [
        {
          label: 'Main / Client System Setup',
          click: () => mainWindow.loadFile(path.join(__dirname, 'setup.html'))
        },
        {
          label: 'Check for Web Updates',
          click: async () => {
            try {
              const status = await checkForWebUpdates();
              const detail = status.state === 'available'
                ? `Version ${status.availableVersion} is ready to download from the verified release feed.`
                : status.state === 'up-to-date'
                  ? 'This computer already has the latest published version.'
                  : status.reason || status.lastError || 'Update check completed.';
              await dialog.showMessageBox(mainWindow, { type: 'info', title: 'Tarangini Updates', message: 'Update check completed', detail });
            } catch (error) {
              await dialog.showMessageBox(mainWindow, { type: 'error', title: 'Update check failed', message: error.message });
            }
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'togglefullscreen' }
      ]
    }
  ]);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    icon: path.join(__dirname, '..', 'assets', 'tarangini.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', event => {
    if (!allowQuit && shouldKeepHostAlive()) {
      event.preventDefault();
      ensureTray();
      mainWindow.hide();
      const config = readConfig() || {};
      if (!config.keepAliveNoticeShown) {
        dialog.showMessageBox({
          type: 'info',
          title: 'Main System still running',
          message: 'Tarangini Main System is still active in the tray.',
          detail: 'Customer portal, QR intake, and client computers can continue using this Main System. Use the tray menu to reopen or quit the server.'
        }).catch(() => {});
        fs.writeFileSync(configPath(), JSON.stringify({ ...config, keepAliveNoticeShown: true }, null, 2));
      }
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:3000') || url.startsWith('http://localhost:3000')) {
      return { action: 'allow' };
    }
    if (url.startsWith('https://wa.me/') || url.startsWith('https://web.whatsapp.com/')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  const config = readConfig();
  getUpdateService()?.start();
  if (config?.role === 'host' || config?.role === 'client') {
    openConfiguredApp(config);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'setup.html'));
  }
}

ipcMain.handle('get-network-config', () => readConfig());
ipcMain.handle('get-device-identity', () => currentDeviceIdentity());
ipcMain.handle('discover-main-systems', () => discoverMainSystems());
ipcMain.handle('test-server-url', async (_event, value) => {
  const url = normalizeServerUrl(value);
  const result = await requestHealth(url, 1800);
  if (!result.ok) {
    throw new Error(`Cannot reach Tarangini Main System at ${url}. Check Host mode, firewall, and port 3000.`);
  }
  return result;
});
ipcMain.handle('open-network-setup', async () => {
  await mainWindow.loadFile(path.join(__dirname, 'setup.html'));
  return true;
});
ipcMain.handle('save-network-config', async (_event, config) => {
  const previous = readConfig() || {};
  const identity = currentDeviceIdentity();
  const clean = config.role === 'host'
    ? {
      role: 'host',
      keepAliveOnClose: config.keepAliveOnClose !== false,
      startAtLogin: Boolean(config.startAtLogin),
      hostDataDir: ensureConfiguredDir(config.hostDataDir, 'Database folder'),
      hostAttachmentDir: ensureConfiguredDir(config.hostAttachmentDir, 'Attachment folder'),
      hostBackupDir: ensureConfiguredDir(config.hostBackupDir, 'Backup folder')
    }
    : {
      role: 'client',
      serverUrl: normalizeServerUrl(config.serverUrl),
      deviceCode: identity.deviceCode,
      deviceIdentity: identity,
      clientPortalLanEnabled: Boolean(config.clientPortalLanEnabled)
    };
  const portalWasEnabled = previous.role === 'client' && Boolean(previous.clientPortalLanEnabled);
  const portalWillBeEnabled = clean.role === 'client' && Boolean(clean.clientPortalLanEnabled);
  if (portalWillBeEnabled) await runFirewallScript('enable');
  else if (portalWasEnabled) await runFirewallScript('disable');
  writeConfig(clean);
  await openConfiguredApp(clean);
  return clean;
});
ipcMain.handle('get-offline-status', () => offlineProxy
  ? offlineProxy.getStatus()
  : { role: 'host', online: true, counts: { pending: 0, synced: 0, conflict: 0 }, items: [] });
ipcMain.handle('sync-offline-now', () => offlineProxy
  ? offlineProxy.syncNow()
  : { role: 'host', online: true, counts: { pending: 0, synced: 0, conflict: 0 }, items: [] });
ipcMain.handle('retry-client-connection', async () => {
  if (!offlineProxy) return { role: 'host', online: true, counts: { pending: 0, synced: 0, conflict: 0 }, items: [] };
  await offlineProxy.checkAndSync();
  return offlineProxy.getStatus();
});
ipcMain.handle('retry-offline-item', (_event, id) => offlineProxy
  ? offlineProxy.retryItem(id)
  : { role: 'host', online: true, counts: { pending: 0, synced: 0, conflict: 0 }, items: [] });
ipcMain.handle('get-app-update-status', () => getUpdateService()?.snapshot() || {
  enabled: false,
  state: 'disabled',
  reason: 'Updates are unavailable in service mode.'
});
ipcMain.handle('check-app-updates', () => checkForWebUpdates());
ipcMain.handle('download-app-update', async () => {
  const service = getUpdateService();
  if (!service) throw new Error('Updates are unavailable in service mode.');
  service.start();
  return service.download();
});
ipcMain.handle('install-app-update', async () => {
  const service = getUpdateService();
  if (!service) throw new Error('Updates are unavailable in service mode.');
  return service.install();
});
ipcMain.handle('windows-service-status', () => getWindowsServiceStatus());
ipcMain.handle('windows-firewall-status', () => process.platform === 'win32'
  ? runFirewallScript('status')
  : { enabled: false, status: 'unsupported' });
ipcMain.handle('windows-service-action', async (_event, action) => {
  const allowed = new Set(['install', 'uninstall', 'start', 'stop', 'restart', 'status']);
  if (!allowed.has(action)) throw new Error('Unsupported Windows Service action');
  const config = readConfig() || {};
  if (['install', 'start', 'restart'].includes(action) && config.role !== 'host') {
    throw new Error('Select MAIN SYSTEM and save the configuration before enabling service mode.');
  }
  const result = await runServiceScript(action, { startAfterInstall: action === 'install' });
  return action === 'status' ? getWindowsServiceStatus() : result;
});
ipcMain.handle('save-invoice-pdf', async (_event, suggestedName) => {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Application window is unavailable');
  const safeName = String(suggestedName || 'Tarangini-Invoice')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim() || 'Tarangini-Invoice';
  const selection = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Invoice PDF',
    defaultPath: path.join(app.getPath('documents'), `${safeName}.pdf`),
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
  });
  if (selection.canceled || !selection.filePath) return { canceled: true };
  const pdf = await mainWindow.webContents.printToPDF({
    printBackground: true,
    pageSize: 'A4',
    margins: { marginType: 'none' },
    preferCSSPageSize: true
  });
  fs.writeFileSync(selection.filePath, pdf);
  return { canceled: false, filePath: selection.filePath };
});

if (hasSingleInstanceLock) {
  app.whenReady().then(() => {
    if (isWebInvoiceBatchMode) {
      const batchArgs = process.argv.slice(process.argv.indexOf('--web-invoice-batch') + 1);
      return require(path.join(app.getAppPath(), 'tools', 'web-invoice-batch')).main(batchArgs)
        .then(code => app.exit(code))
        .catch(error => {
          console.error(error.stack || error);
          app.exit(1);
        });
    }
    if (isServiceMode) {
      openServiceMode().catch(error => {
        fs.mkdirSync(path.dirname(configPath()), { recursive: true });
        fs.writeFileSync(
          path.join(app.getPath('userData'), 'service-error.log'),
          `${new Date().toISOString()} ${error.stack || error.message}\n`,
          { flag: 'a' }
        );
        app.exit(1);
      });
      return;
    }
    Menu.setApplicationMenu(buildMenu());
    createWindow();
  });
}

app.on('before-quit', () => {
  allowQuit = true;
  updateService?.stop();
});

app.on('window-all-closed', () => {
  if (shouldKeepHostAlive() && !allowQuit) return;
  if (process.platform !== 'darwin') app.quit();
});
