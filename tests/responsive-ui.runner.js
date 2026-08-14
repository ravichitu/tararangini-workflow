const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const baseUrl = process.env.RESPONSIVE_APP_URL;
const resultFile = process.env.RESPONSIVE_RESULT_FILE;
const outputDir = path.join(path.resolve(__dirname, '..'), 'output', 'responsive');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

async function evaluate(window, expression) {
  return window.webContents.executeJavaScript(expression, true);
}

function requestJson(url, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.request(parsed, { method, headers }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          json: async () => JSON.parse(data || '{}')
        });
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

app.whenReady().then(async () => {
  const errors = [];
  let checked = 0;
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  window.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer exited: ${details.reason}`));
  window.webContents.on('console-message', (_event, details) => {
    const message = typeof details === 'object' ? details.message : String(details || '');
    if (/ReferenceError|TypeError|SyntaxError|Unhandled/i.test(message)) errors.push(message);
  });

  try {
    const loginResponse = await requestJson(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner1', password: 'owner123' })
    });
    if (!loginResponse.ok) throw new Error(`Login failed: ${loginResponse.status}`);
    const login = await loginResponse.json();
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
    let initialized = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await delay(100);
      initialized = await evaluate(window, `Boolean(
        STATE.currentOrg && STATE.currentPage === 'dashboard' &&
        document.getElementById('content')?.innerText.trim()
      )`);
      if (initialized) break;
    }
    if (!initialized) throw new Error('Application initialization did not complete');
    await delay(300);
    fs.mkdirSync(outputDir, { recursive: true });

    for (const viewport of [
      { name: 'phone', width: 390, height: 844 },
      { name: 'tablet', width: 820, height: 1180 },
      { name: 'desktop', width: 1440, height: 900 }
    ]) {
      window.setContentSize(viewport.width, viewport.height);
      await delay(150);
      const pages = {
        pos: 'Fast POS Counter',
        sale: 'Sale Bill Details',
        'invoice-corrections': 'Correction Audit History',
        shifts: 'Shift History',
        'operator-log': 'Owner & Operator Daily Log',
        'update-manager': 'Current Version'
      };
      for (const [page, expectedText] of Object.entries(pages)) {
        await evaluate(window, `navigate(${JSON.stringify(page)}); true`);
        let state = null;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          await delay(100);
          state = await evaluate(window, `({
            page: STATE.currentPage,
            title: document.getElementById('page-title')?.textContent,
            content: document.getElementById('content')?.innerText.slice(0, 600),
            overflow: document.documentElement.scrollWidth - innerWidth,
            menuDisplay: getComputedStyle(document.querySelector('.mobile-menu-button')).display
          })`);
          if (state.content?.toLowerCase().includes(expectedText.toLowerCase())) break;
        }
        if (state.page !== page) errors.push(`${viewport.name}: failed to navigate to ${page}`);
        const expectedTitle = {
          pos: 'Fast POS Counter', sale: 'New Sale Bill',
          'invoice-corrections': 'Invoice Corrections', shifts: 'Counter Shifts',
          'operator-log': 'Owner & Operator Daily Log',
          'update-manager': 'Update Manager'
        }[page];
        if (state.title !== expectedTitle) errors.push(`${viewport.name}: ${page} title was ${state.title}`);
        if (!state.content?.toLowerCase().includes(expectedText.toLowerCase()) || /is not defined|coming soon/i.test(state.content)) {
          errors.push(`${viewport.name}: ${page} did not render (${state.content || 'empty'})`);
        }
        if (state.overflow > 1) errors.push(`${viewport.name}: ${page} overflowed by ${state.overflow}px`);
        if (viewport.width < 900 && state.menuDisplay === 'none') {
          errors.push(`${viewport.name}: mobile menu is hidden`);
        }
        checked += 1;
      }
      if (viewport.width < 900) {
        const sidebarOpen = await evaluate(window, `toggleMobileSidebar(true);
          document.getElementById('sidebar').classList.contains('mobile-open')`);
        if (!sidebarOpen) errors.push(`${viewport.name}: sidebar did not open`);
        await evaluate(window, 'toggleMobileSidebar(false); true');
      }
      await delay(300);
      const image = await window.webContents.capturePage();
      fs.writeFileSync(path.join(outputDir, `${viewport.name}-update-manager.png`), image.toPNG());
    }
  } catch (error) {
    errors.push(error.stack || error.message);
  } finally {
    fs.writeFileSync(resultFile, JSON.stringify({ errors, checked }, null, 2));
    window.destroy();
    app.quit();
  }
}).catch(error => {
  fs.writeFileSync(resultFile, JSON.stringify({ errors: [error.stack || error.message], checked: 0 }, null, 2));
  app.exit(1);
});
