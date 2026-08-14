const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');

const root = path.resolve(__dirname, '..');
const baseUrl = process.env.MANUAL_APP_URL || 'http://127.0.0.1:3220';
const outputDir = process.env.MANUAL_SCREENSHOT_DIR || path.join(root, 'manual_assets');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function evaluate(window, expression) {
  return window.webContents.executeJavaScript(expression, true);
}

async function waitFor(window, predicate, attempts = 300) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await delay(100);
    if (await evaluate(window, predicate)) return;
  }
  throw new Error(`Timed out waiting for ${predicate}`);
}

async function capture(window, fileName) {
  await delay(350);
  const image = await window.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, fileName), image.toPNG());
  fs.appendFileSync(path.join(outputDir, 'capture-progress.txt'), `${fileName}\n`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const window = new BrowserWindow({
    width: 1365,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      offscreen: true
    }
  });

  try {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner1', password: 'owner123' })
    });
    if (!response.ok) throw new Error(`Login failed: ${response.status}`);
    const login = await response.json();
    await window.webContents.session.cookies.set({
      url: baseUrl,
      name: 'tarangini_session',
      value: login.token,
      httpOnly: true,
      sameSite: 'strict',
      expirationDate: Math.floor(Date.now() / 1000) + (8 * 60 * 60)
    });
    await window.loadURL(baseUrl);
    await evaluate(window, `localStorage.setItem('user',${JSON.stringify(JSON.stringify(login.user))}); true`);
    await window.reload();
    await waitFor(window, `Boolean(STATE.currentOrg && STATE.currentPage === 'dashboard' &&
      document.getElementById('content')?.innerText.trim())`);
    await capture(window, '01-dashboard.png');

    const pages = [
      ['sale', 'SALE BILL DETAILS', '02-sale-bill.png'],
      ['payment-received', 'PAYMENT RECEIVED', '03-payment-received.png'],
      ['pos', 'FAST POS COUNTER', '04-pos-counter.png'],
      ['invoice-status', 'INVOICE PAYMENT STATUS', '05-invoice-status.png'],
      ['invoice-corrections', 'CORRECTION AUDIT HISTORY', '06-invoice-corrections.png'],
      ['shifts', 'SHIFT HISTORY', '07-shifts.png'],
      ['backup', 'BACKUP & RESTORE', '08-backup-restore.png'],
      ['update-manager', 'CURRENT VERSION', '11-update-manager.png']
    ];
    for (const [page, text, file] of pages) {
      await evaluate(window, `navigate(${JSON.stringify(page)}); true`);
      await waitFor(window, `document.getElementById('content')?.innerText.toUpperCase().includes(${JSON.stringify(text)})`);
      await capture(window, file);
    }

    await evaluate(window, `navigate('settings'); true`);
    await waitFor(window, `document.getElementById('content')?.innerText.toUpperCase().includes('SETTINGS')`);
    await evaluate(window, `settingsTab('backup-auto', document.querySelectorAll('.tabs .tab')[3]); true`);
    await waitFor(window, `document.getElementById('settings-content')?.innerText.toUpperCase().includes('SCHEDULED AUTOMATIC BACKUP')`);
    await capture(window, '09-automatic-backup-settings.png');

    await window.loadFile(path.join(root, 'electron', 'setup.html'));
    await waitFor(window, `document.body?.innerText.toUpperCase().includes('MAIN SYSTEM')`);
    await capture(window, '12-main-client-setup.png');

    fs.writeFileSync(path.join(outputDir, 'capture-complete.txt'), new Date().toISOString());
  } finally {
    window.destroy();
    app.quit();
  }
}).catch(error => {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'capture-error.txt'), error.stack || error.message);
  app.exit(1);
});
