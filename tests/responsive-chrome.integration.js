const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, '.responsive-chrome-data');
const outputDir = path.join(root, 'output', 'responsive-chrome');
const chromeData = path.join(root, '.responsive-chrome-profile');
const appPort = 3215;
const debugPort = 9300 + (process.pid % 500);
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
fs.rmSync(dataDir, { recursive: true, force: true });
fs.rmSync(chromeData, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(appPort), TARANGINI_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverOutput = '';
server.stdout.on('data', chunk => { serverOutput += chunk; });
server.stderr.on('data', chunk => { serverOutput += chunk; });
let chrome = null;
let chromeOutput = '';

async function waitFor(url, attempts = 180, diagnostics = () => serverOutput) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}\n${diagnostics()}`);
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    };
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Browser evaluation failed');
    return result.result.value;
  }
}

async function stopProcess(child) {
  if (!child || child.killed) return;
  child.kill();
  await new Promise(resolve => {
    child.once('exit', resolve);
    setTimeout(resolve, 2000);
  });
}

(async () => {
  try {
    await waitFor(`http://127.0.0.1:${appPort}/api/health`);
    chrome = spawn(chromePath, [
      '--headless=new', '--disable-gpu', '--disable-software-rasterizer', '--disable-dev-shm-usage',
      '--no-sandbox', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${debugPort}`, `--user-data-dir=${chromeData}`,
      `http://127.0.0.1:${appPort}`
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    chrome.stdout.on('data', chunk => { chromeOutput += chunk; });
    chrome.stderr.on('data', chunk => { chromeOutput += chunk; });
    await waitFor(
      `http://127.0.0.1:${debugPort}/json/version`,
      150,
      () => `${serverOutput}\nChrome output:\n${chromeOutput}\nChrome exit code: ${chrome.exitCode}`
    );
    let pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const target = pages.find(page => page.type === 'page');
    assert.ok(target?.webSocketDebuggerUrl, 'Chrome page target was not found');
    const cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${appPort}` });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const ready = await cdp.evaluate(`location.origin === 'http://127.0.0.1:${appPort}' && document.readyState === 'complete'`);
      if (ready) break;
      if (attempt === 99) throw new Error('Chrome did not load the application');
    }
    await cdp.evaluate(`(async () => {
      const response = await fetch('/api/auth/login', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username:'owner1',password:'owner123'})
      });
      const login = await response.json();
      localStorage.setItem('token',login.token);
      localStorage.setItem('user',JSON.stringify(login.user));
      location.reload();
      return true;
    })()`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (await cdp.evaluate(`Boolean(typeof STATE !== 'undefined' && STATE.currentOrg && STATE.currentPage === 'dashboard')`)) break;
      if (attempt === 99) throw new Error('Application initialization did not complete');
    }
    const appScriptResponse = await fetch(`http://127.0.0.1:${appPort}/app-2.4.0.js`);
    assert.match(appScriptResponse.headers.get('cache-control') || '', /no-store/);
    const legacyScriptResponse = await fetch(`http://127.0.0.1:${appPort}/app.js?v=2.3.0-mobile2`);
    assert.match(legacyScriptResponse.headers.get('content-type') || '', /javascript/);
    assert.match(await legacyScriptResponse.text(), /var APP_STATE =/);
    const indexResponse = await fetch(`http://127.0.0.1:${appPort}/`);
    assert.match(await indexResponse.text(), /app-2\.4\.0\.js/);
    const health = await (await fetch(`http://127.0.0.1:${appPort}/api/health`)).json();
    assert.strictEqual(health.frontend_asset, 'app-2.4.0.js');

    await cdp.evaluate(`(async () => {
      const response = await fetch('/api/auth/login', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username:'operator1',password:'operator123'})
      });
      const login = await response.json();
      if (!response.ok || !login.token || !login.user) throw new Error(login.error || 'Operator login failed');
      localStorage.setItem('token',login.token);
      localStorage.setItem('user',JSON.stringify(login.user));
      location.reload();
      return true;
    })()`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (await cdp.evaluate(`Boolean(window.STATE?.currentOrg && STATE.user?.username === 'operator1' &&
        STATE.currentPage === 'dashboard' && document.getElementById('content')?.innerText.includes('My Work Desk') &&
        !document.getElementById('content')?.innerText.includes('Total Receivables'))`)) break;
      if (attempt === 99) {
        const diagnostic = await cdp.evaluate(`({
          user:window.STATE?.user,
          page:window.STATE?.currentPage,
          org:Boolean(window.STATE?.currentOrg),
          content:document.getElementById('content')?.innerText,
          loginError:document.getElementById('login-error')?.innerText
        })`);
        throw new Error(`Operator application initialization did not complete: ${JSON.stringify(diagnostic)}`);
      }
    }

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: true
    });
    await cdp.evaluate(`navigate('pos'); true`);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (await cdp.evaluate(`document.getElementById('content')?.innerText.includes('Fast POS Counter')`)) break;
      if (attempt === 49) {
        const diagnostic = await cdp.evaluate(`({
          page:window.STATE?.currentPage,
          user:window.STATE?.user?.username,
          content:document.getElementById('content')?.innerText,
          token:Boolean(window.STATE?.token)
        })`);
        throw new Error(`Mobile POS did not load: ${JSON.stringify(diagnostic)}`);
      }
    }
    const mobilePOS = await cdp.evaluate(`(async () => {
      const waitFor = async (predicate, label = 'POS UI action') => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const value = predicate();
          if (value) return value;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Timed out waiting for ' + label + ': ' + JSON.stringify({
          content: document.getElementById('content')?.innerText.slice(0, 800),
          dialog: document.querySelector('[data-input-dialog]')?.innerText,
          shifts: window.__posShiftRows,
          buttons: [...document.querySelectorAll('button')].map(button => button.textContent.trim()).slice(0, 20),
          toasts: document.getElementById('toast-container')?.innerText
        }));
      };
      const fillInputDialog = async value => {
        const input = await waitFor(() => document.querySelector('[data-input-dialog-field]'), 'input dialog');
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.closest('form').requestSubmit();
        await new Promise(resolve => setTimeout(resolve, 150));
      };
      const clickButton = label => {
        const button = [...document.querySelectorAll('button')]
          .find(item => item.textContent.trim().includes(label));
        if (!button) throw new Error(label + ' button was not found');
        button.click();
      };
      clickButton('Open Shift');
      await fillInputDialog('Phone Test');
      await fillInputDialog('0');
      const shiftsAfterOpen = await api('GET','/advanced/shifts?org_id='+STATE.currentOrg.id);
      window.__posShiftRows = shiftsAfterOpen.map(row => ({
        id: row.id, user_id: row.user_id, status: row.status, counter_name: row.counter_name
      }));
      await waitFor(() => document.getElementById('content')?.innerText.toLowerCase().includes('shift open: phone test'), 'opened shift badge');
      const heldButton = document.getElementById('pos-held-bills-button');
      const header = document.querySelector('.pos-page-header');
      if (!heldButton || !header) throw new Error('Held Bills header button is missing');
      const heldRect = heldButton.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      if (!STATE.items.length) throw new Error('No item available for mobile POS test');
      addPOSItem(STATE.items[0].id);
      clickButton('Hold Bill');
      await fillInputDialog('Phone held bill');
      const held = await api('GET','/advanced/held-bills?org_id='+STATE.currentOrg.id);
      if (!held.length) throw new Error('Held bill did not appear');
      const heldVisible = document.getElementById('content').innerText.includes('Phone held bill');
      await resumePOSBill(held[0].id);
      document.getElementById('pos-pay-cash').value = posTotals().total.toFixed(2);
      clickButton('Pay & Save');
      await waitFor(() => document.getElementById('preview-modal')?.style.display === 'flex', 'thermal receipt preview');
      return {
        heldVisible,
        heldButtonTopRight: heldRect.right <= headerRect.right + 1 &&
          heldRect.left > headerRect.left + (headerRect.width / 2),
        receipt: document.getElementById('preview-title').textContent,
        stateReady: Boolean(window.STATE && STATE.currentOrg)
      };
    })()`);
    assert.strictEqual(mobilePOS.heldVisible, true);
    assert.strictEqual(mobilePOS.heldButtonTopRight, true);
    assert.match(mobilePOS.receipt, /Thermal Receipt/);
    assert.strictEqual(mobilePOS.stateReady, true);
    await cdp.evaluate(`closePreview(); true`);

    const mobileSale = await cdp.evaluate(`(async () => {
      navigate('sale');
      for (let attempt = 0; attempt < 50 && !document.querySelector('.bill-form-actions'); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!STATE.items.length) throw new Error('No item available for mobile sale test');
      selectItem(STATE.items[0].id, 0);
      document.getElementById('item-qty-0').value = '1';
      calcItemAmount(0);
      const saveButton = document.querySelector('.bill-form-actions .btn-success');
      const stickyPosition = getComputedStyle(document.querySelector('.bill-form-actions')).position;
      const saveVisibleBeforeSubmit = Boolean(saveButton && saveButton.getBoundingClientRect().height >= 40);
      await saveBill('SALE');
      for (let attempt = 0; attempt < 200 && !(STATE.currentPage === 'bills-list' && document.getElementById('transaction-register-table')); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const bills = await api('GET','/bills?org_id='+STATE.currentOrg.id+'&fy='+STATE.currentFY);
      return {
        saveVisible: saveVisibleBeforeSubmit,
        stickyPosition,
        saved: STATE.currentPage === 'bills-list' && Boolean(document.getElementById('transaction-register-table')),
        operatorBillVisible: bills.some(bill => bill.created_by_username === 'operator1'),
        currentPage: STATE.currentPage,
        hasRegister: Boolean(document.getElementById('transaction-register-table')),
        previewDisplay: document.getElementById('preview-modal')?.style.display || '',
        toastText: document.getElementById('toast')?.textContent || ''
      };
    })()`);
    assert.strictEqual(mobileSale.saveVisible, true);
    assert.strictEqual(mobileSale.stickyPosition, 'sticky');
    assert.strictEqual(mobileSale.saved, true, JSON.stringify(mobileSale));
    assert.strictEqual(mobileSale.operatorBillVisible, true, JSON.stringify(mobileSale));
    await cdp.evaluate(`closePreview(); true`);

    await cdp.evaluate(`(async () => {
      const response = await fetch('/api/auth/login', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username:'owner1',password:'owner123'})
      });
      const login = await response.json();
      localStorage.setItem('token',login.token);
      localStorage.setItem('user',JSON.stringify(login.user));
      location.reload();
      return true;
    })()`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (await cdp.evaluate(`Boolean(window.STATE?.currentOrg && STATE.user?.username === 'owner1' &&
        STATE.currentPage === 'dashboard' && document.getElementById('content')?.innerText.includes('MOBILE OPERATOR LOGIN'))`)) break;
      if (attempt === 99) throw new Error('Owner application initialization did not complete');
    }

    const transactionControlSave = await cdp.evaluate(`(async () => {
      const waitFor = async predicate => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const result = predicate();
          if (result) return result;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Timed out waiting for Transaction Controls save');
      };
      navigate('settings');
      await waitFor(() => document.getElementById('settings-content'));
      const tab = [...document.querySelectorAll('.tabs .tab')]
        .find(item => item.textContent.includes('Transaction Controls'));
      if (!tab) throw new Error('Transaction Controls tab is missing');
      tab.click();
      await waitFor(() => document.getElementById('tc-type'));
      await renderTransactionControlsSettings('SALE');
      const checkbox = document.querySelector('[data-tc-field="hsn"] .tc-print');
      if (!checkbox) throw new Error('HSN print control is missing');
      const expected = !checkbox.checked;
      checkbox.checked = expected;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      const saveButton = [...document.querySelectorAll('#settings-content button')]
        .find(item => item.textContent.includes('Save Transaction Controls'));
      if (!saveButton) throw new Error('Save Transaction Controls button is missing');
      saveButton.click();
      await waitFor(() => document.getElementById('toast-container')?.innerText.includes('Transaction controls saved'));
      await new Promise(resolve => setTimeout(resolve, 1000));
      const payload = await api('GET', '/orgs/' + STATE.currentOrg.id + '/transaction-controls');
      const saved = payload.controls.find(row => row.transaction_type === 'SALE');
      return {
        expected,
        persisted: saved?.print_options?.hsn,
        rendered: document.querySelector('[data-tc-field="hsn"] .tc-print')?.checked,
        currentPage: STATE.currentPage,
        activeTab: document.querySelector('.tabs .tab.active')?.textContent,
        transactionType: document.getElementById('tc-type')?.value,
        syncResetShown: document.getElementById('toast-container')?.innerText.includes('Data synced from another computer')
      };
    })()`);
    assert.strictEqual(transactionControlSave.persisted, transactionControlSave.expected);
    assert.strictEqual(transactionControlSave.rendered, transactionControlSave.expected);
    assert.strictEqual(transactionControlSave.currentPage, 'settings');
    assert.match(transactionControlSave.activeTab, /Transaction Controls/);
    assert.strictEqual(transactionControlSave.transactionType, 'SALE');
    assert.strictEqual(transactionControlSave.syncResetShown, false);

    const quotationInclusiveRate = await cdp.evaluate(`(async () => {
      const bits = STATE.orgs.find(org => org.display_name === 'BITS & BINARY');
      if (!bits) throw new Error('BITS & BINARY company is missing');
      STATE.currentOrg = bits;
      document.getElementById('org-selector').value = bits.id;
      updateOrgDisplay();
      await loadTransactionControls();
      await loadMasterData();
      const replacementVendorResult = await api('POST', '/parties', {
        org_id: bits.id, type: 'vendor', name: 'Browser Vendor Replacement',
        address: 'Replacement Vendor Road', city: 'Kakinada', gst_type: 'unregistered'
      });
      await loadMasterData();
      const replacementVendor = STATE.parties.find(party => Number(party.id) === Number(replacementVendorResult.id));
      const originalVendor = STATE.parties.find(party => Number(party.id) !== Number(replacementVendor.id));
      if (!replacementVendor || !originalVendor) throw new Error('Quotation vendor-change test requires two parties');
      navigate('quotation');
      for (let attempt = 0; attempt < 60 && !document.getElementById('item-rate-inclusive-0'); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!document.getElementById('item-rate-inclusive-0')) {
        throw new Error('Quotation tax-inclusive rate input is missing: ' + JSON.stringify({
          org: STATE.currentOrg,
          page: STATE.currentPage,
          content: document.getElementById('content')?.innerText.slice(0, 1200),
          rateInputs: [...document.querySelectorAll('input')].map(input => input.id).filter(id => id.includes('rate')).slice(0, 30)
        }));
      }
      if (!STATE.items.length || !STATE.parties.length) throw new Error('Quotation test requires an item and party');
      selectParty(originalVendor.id);
      selectItem(STATE.items[0].id, 0);
      document.getElementById('item-qty-0').value = '1';
      document.getElementById('item-gst-0').value = '18';
      document.getElementById('item-rate-inclusive-0').value = '118';
      syncInvoiceRateRow(0, 'inclusive');
      const baseRate = Number(document.getElementById('item-rate-base-0').value);
      const enteredRate = Number(document.getElementById('item-rate-0').value);
      const amount = Number(document.getElementById('item-amount-0').value);
      const quotationFormText = document.getElementById('content')?.innerText || '';
      await saveBill('QUOT');
      for (let attempt = 0; attempt < 200 && !(STATE.currentPage === 'bills-list' && document.getElementById('transaction-register-table')); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const bills = await api('GET','/bills?org_id='+STATE.currentOrg.id+'&fy='+STATE.currentFY);
      const previewBill = bills.find(bill => bill.format === 'QUOT' && Number(bill.grand_total) === 118);
      await editBill(previewBill.id, 'QUOT');
      for (let attempt = 0; attempt < 80 && !document.getElementById('bf-party-search'); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const search = document.getElementById('bf-party-search');
      search.value = replacementVendor.name;
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const staleIdentityCleared = !document.getElementById('bf-party-id').value;
      selectParty(replacementVendor.id);
      const selectedBanner = document.getElementById('bf-selected-party')?.innerText || '';
      const confirmedPartyId = document.getElementById('bf-party-search')?.dataset.selectedPartyId;
      await saveBill('QUOT');
      for (let attempt = 0; attempt < 200 && !(STATE.currentPage === 'bills-list' && document.getElementById('transaction-register-table')); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const changedBill = await api('GET', '/bills/' + previewBill.id + '/full');
      STATE.previewBill = changedBill;
      return {
        baseRate, enteredRate, amount,
        taxInclusive,
        labelHasQuotationNo: quotationFormText.includes('Quotation No.'),
        labelHasCustomerVendorName: quotationFormText.includes('Customer / Vendor Name'),
        staleIdentityCleared,
        selectedBanner,
        confirmedPartyId: Number(confirmedPartyId),
        changedPartyId: Number(changedBill.party_id),
        changedPartyName: changedBill.party?.name,
        format: changedBill?.format,
        taxable: Number(changedBill?.taxable_amount),
        tax: Number(changedBill?.total_tax),
        total: Number(changedBill?.grand_total),
        replacementVendorId: Number(replacementVendor.id)
      };
    })()`);
    assert.strictEqual(quotationInclusiveRate.baseRate, 100);
    assert.strictEqual(quotationInclusiveRate.enteredRate, 118);
    assert.strictEqual(quotationInclusiveRate.amount, 118);
    assert.strictEqual(quotationInclusiveRate.taxInclusive, true);
    assert.strictEqual(quotationInclusiveRate.labelHasQuotationNo, true);
    assert.strictEqual(quotationInclusiveRate.labelHasCustomerVendorName, true);
    assert.strictEqual(quotationInclusiveRate.staleIdentityCleared, true);
    assert.match(quotationInclusiveRate.selectedBanner, /Browser Vendor Replacement/);
    assert.strictEqual(quotationInclusiveRate.confirmedPartyId, quotationInclusiveRate.replacementVendorId);
    assert.strictEqual(quotationInclusiveRate.changedPartyId, quotationInclusiveRate.replacementVendorId);
    assert.strictEqual(quotationInclusiveRate.changedPartyName, 'Browser Vendor Replacement');
    assert.strictEqual(quotationInclusiveRate.format, 'QUOT');
    assert.strictEqual(quotationInclusiveRate.taxable, 100);
    assert.strictEqual(quotationInclusiveRate.tax, 18);
    assert.strictEqual(quotationInclusiveRate.total, 118);
    const quotationPreviewActions = await cdp.evaluate(`(() => {
      const bill = STATE.previewBill;
      showBillPreview(bill);
      showBillPreview(bill);
      const actionMatrix = {};
      ['QUOT', 'DC', 'SALE'].forEach(format => {
        showBillPreview({ ...bill, format, status: 'saved', linked_documents: [] });
        actionMatrix[format] = [...document.querySelectorAll('#preview-workflow-actions button')]
          .map(button => button.textContent.trim());
      });
      showBillPreview(bill);
      const previewText = document.getElementById('preview-content')?.innerText || '';
      return {
        actionMatrix,
        workflowButtons: [...document.querySelectorAll('#preview-workflow-actions button')].map(button => button.textContent.trim()),
        workflowButtonCount: document.querySelectorAll('#preview-workflow-actions button').length,
        pdfFunction: downloadBillPDF.constructor.name,
        pdfBridgeExpected: typeof downloadBillPDF === 'function',
        previewHasQuotationTo: previewText.toUpperCase().includes('QUOTATION TO'),
        previewHasQuotationNo: previewText.toUpperCase().includes('QUOTATION NO.')
      };
    })()`);
    assert.deepStrictEqual(quotationPreviewActions.workflowButtons, ['Create DC', 'Create Invoice']);
    assert.strictEqual(quotationPreviewActions.workflowButtonCount, 2);
    assert.deepStrictEqual(quotationPreviewActions.actionMatrix.QUOT, ['Create DC', 'Create Invoice']);
    assert.deepStrictEqual(quotationPreviewActions.actionMatrix.DC, ['Create Invoice']);
    assert.deepStrictEqual(quotationPreviewActions.actionMatrix.SALE, []);
    assert.strictEqual(quotationPreviewActions.pdfFunction, 'AsyncFunction');
    assert.strictEqual(quotationPreviewActions.pdfBridgeExpected, true);
    assert.strictEqual(quotationPreviewActions.previewHasQuotationTo, true);
    assert.strictEqual(quotationPreviewActions.previewHasQuotationNo, true);
    await cdp.evaluate(`closePreview(); true`);
    const transactionRegister = await cdp.evaluate(`(async () => {
      navigate('bills-list');
      for (let attempt = 0; attempt < 80 && !document.getElementById('transaction-register-table'); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const tabs = [...document.querySelectorAll('.transaction-register-tab')].map(button => button.textContent.trim());
      const quotationTab = document.querySelector('.transaction-register-tab[data-type="QUOT"]');
      quotationTab?.click();
      return {
        tabs,
        table: Boolean(document.getElementById('transaction-register-table')),
        activeTitle: document.getElementById('transaction-register-title')?.textContent,
        quotationVisible: document.getElementById('transaction-register-body')?.innerText.includes(STATE.previewBill?.bill_number || ''),
        newQuotationAction: document.getElementById('transaction-register-inline-action')?.innerText.includes('New Quotation')
      };
    })()`);
    assert.strictEqual(transactionRegister.table, true);
    assert.strictEqual(transactionRegister.newQuotationAction, true);
    ['All Bills','Sale Invoices','Project Printing','Quotations','Delivery Challans','Proforma Invoices',
      'Receipts','Payment Vouchers','Purchases','Expenses','Credit / Debit Notes','Purchase Orders','Journals']
      .forEach(label => assert.ok(transactionRegister.tabs.some(tab => tab.includes(label)), `${label} tab missing`));
    assert.match(transactionRegister.activeTitle, /Quotations/);
    await cdp.evaluate(`(async () => {
      const firstOrg = STATE.orgs[0];
      STATE.currentOrg = firstOrg;
      document.getElementById('org-selector').value = firstOrg.id;
      updateOrgDisplay();
      await loadTransactionControls();
      await loadMasterData();
      return true;
    })()`);

    const transactionControls = await cdp.evaluate(`(async () => {
      const inclusive = {};
      const roundOff = {};
      const inclusiveRateInput = {};
      const originalGstType = STATE.currentOrg.gst_type;
      STATE.currentOrg.gst_type = 'regular';
      navigate('sale');
      for (let attempt = 0; attempt < 50 && !document.getElementById('bf-round-off'); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      inclusive.sale = [...document.querySelectorAll('.toggle-btn')]
        .some(button => button.textContent.includes('Incl. GST'));
      inclusiveRateInput.sale = Boolean(document.getElementById('item-rate-inclusive-0'));
      roundOff.sale = Boolean(document.getElementById('bf-round-off'));
      await renderPurchases();
      inclusive.purchase = Boolean(document.getElementById('purchase-tax-inclusive'));
      inclusiveRateInput.purchase = Boolean(document.getElementById('bi-rate-inclusive-0'));
      roundOff.purchase = Boolean(document.getElementById('purchase-round-off'));
      await renderExpenses();
      inclusive.expense = Boolean(document.getElementById('expense-tax-inclusive'));
      inclusiveRateInput.expense = Boolean(document.getElementById('expense-amount'));
      roundOff.expense = Boolean(document.getElementById('expense-round-off'));
      await renderNotes();
      inclusive.note = Boolean(document.getElementById('note-tax-inclusive'));
      inclusiveRateInput.note = Boolean(document.getElementById('bi-rate-inclusive-0'));
      roundOff.note = Boolean(document.getElementById('note-round-off'));
      await renderPurchaseOrders();
      inclusive.purchaseOrder = Boolean(document.getElementById('po-tax-inclusive'));
      inclusiveRateInput.purchaseOrder = Boolean(document.getElementById('bi-rate-inclusive-0'));
      roundOff.purchaseOrder = Boolean(document.getElementById('po-round-off'));
      await renderReturns();
      inclusive.return = Boolean(document.getElementById('return-tax-inclusive'));
      roundOff.return = Boolean(document.getElementById('return-round-off'));
      await renderPOS();
      inclusive.pos = Boolean(document.getElementById('pos-tax-inclusive'));
      roundOff.pos = Boolean(document.getElementById('pos-round-off'));
      if (STATE.items.length) addPOSItem(STATE.items[0].id);
      inclusiveRateInput.pos = Boolean(document.getElementById('pos-rate-inclusive-0'));
      await renderProjectPrintingInvoice();
      inclusive.projectPrinting = Boolean(document.getElementById('pp-tax-inclusive'));
      inclusiveRateInput.projectPrinting = Boolean(document.getElementById('pp-bw-rate-inclusive'));
      roundOff.projectPrinting = Boolean(document.getElementById('pp-round-off'));
      await renderNewJob();
      inclusive.jobEstimate = Boolean(document.getElementById('job-tax-inclusive'));
      inclusiveRateInput.jobEstimate = Boolean(document.getElementById('job-unit-price'));
      roundOff.jobEstimate = Boolean(document.getElementById('job-round-off'));
      STATE.currentOrg.gst_type = originalGstType;
      return { inclusive, roundOff, inclusiveRateInput };
    })()`);
    Object.entries(transactionControls.inclusive).forEach(([screen, visible]) => {
      assert.strictEqual(visible, true, `Rates include GST checkbox missing on ${screen}`);
    });
    Object.entries(transactionControls.roundOff).forEach(([screen, visible]) => {
      assert.strictEqual(visible, true, `Round-off checkbox missing on ${screen}`);
    });
    Object.entries(transactionControls.inclusiveRateInput).forEach(([screen, visible]) => {
      assert.strictEqual(visible, true, `Tax-inclusive rate input missing on ${screen}`);
    });

    const themeResult = await cdp.evaluate(`(async () => {
      navigate('settings');
      for (let attempt = 0; attempt < 50 && !document.getElementById('settings-content'); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      renderInvoiceSettings();
      const theme = document.querySelector('input[name="invoice-theme"][value="statutory-gst"]');
      if (!theme) throw new Error('Invoice theme selector was not rendered');
      const themeChoices = document.querySelectorAll('input[name="invoice-theme"]').length;
      const commonGstAvailable = Boolean(document.querySelector('input[name="invoice-theme"][value="common-gst"]'));
      const gstInvoiceAvailable = Boolean(document.querySelector('input[name="invoice-theme"][value="gst-invoice"]'));
      const tallyAvailable = Boolean(document.querySelector('input[name="invoice-theme"][value="tally"]'));
      const referenceThemesAvailable = ['modern-wave', 'retail-grid', 'corporate-tax', 'commercial-red', 'statutory-gst']
        .every(value => Boolean(document.querySelector('input[name="invoice-theme"][value="' + value + '"]')));
      theme.checked = true;
      await saveInvoiceSettings();
      navigate('sale');
      for (let attempt = 0; attempt < 50 && !document.querySelector('.bill-form-actions'); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      selectItem(STATE.items[0].id, 0);
      document.getElementById('item-qty-0').value = '1';
      calcItemAmount(0);
      await saveBill('SALE');
      for (let attempt = 0; attempt < 200 && !(STATE.currentPage === 'bills-list' && document.getElementById('transaction-register-table')); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const bills = await api('GET','/bills?org_id='+STATE.currentOrg.id+'&fy='+STATE.currentFY);
      const saleBill = bills.filter(bill => bill.format === 'SALE').sort((a, b) => b.id - a.id)[0];
      showBillPreview(saleBill);
      return {
        savedTheme: STATE.currentOrg.invoice_theme,
        previewClass: document.getElementById('a4-content')?.className || '',
        themeChoices,
        commonGstAvailable,
        gstInvoiceAvailable,
        tallyAvailable,
        referenceThemesAvailable
      };
    })()`);
    assert.strictEqual(themeResult.savedTheme, 'statutory-gst');
    assert.match(themeResult.previewClass, /invoice-theme-statutory-gst/);
    assert.strictEqual(themeResult.themeChoices, 22);
    assert.strictEqual(themeResult.commonGstAvailable, true);
    assert.strictEqual(themeResult.gstInvoiceAvailable, true);
    assert.strictEqual(themeResult.tallyAvailable, true);
    assert.strictEqual(themeResult.referenceThemesAvailable, true);
    await cdp.evaluate(`closePreview(); true`);

    const errors = [];
    let checked = 0;
    for (const viewport of [
      { name: 'phone', width: 390, height: 844 },
      { name: 'tablet', width: 820, height: 1180 },
      { name: 'desktop', width: 1440, height: 900 }
    ]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width, height: viewport.height, deviceScaleFactor: 1,
        mobile: viewport.width < 900
      });
      for (const [page, expectedText] of Object.entries({
        pos: 'Fast POS Counter',
        sale: 'New Sale Bill',
        'invoice-corrections': 'Correction Audit History',
        shifts: 'Shift History',
        'update-manager': 'Current Version',
        stock: 'Stock Movement Journal',
        help: 'Preloaded User Help',
        dashboard: 'Mobile Operator Login'
      })) {
        await cdp.evaluate(`navigate(${JSON.stringify(page)}); true`);
        let state = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
          state = await cdp.evaluate(`({
            page:STATE.currentPage,
            content:document.getElementById('content')?.innerText.slice(0,5000),
            overflow:document.documentElement.scrollWidth-innerWidth,
            menuDisplay:getComputedStyle(document.querySelector('.mobile-menu-button')).display
          })`);
          if (state.content?.toLowerCase().includes(expectedText.toLowerCase())) break;
        }
        if (state.page !== page) errors.push(`${viewport.name}: failed to navigate to ${page}`);
        if (!state.content?.toLowerCase().includes(expectedText.toLowerCase())) {
          errors.push(`${viewport.name}: ${page} did not render`);
        }
        if (state.overflow > 1) errors.push(`${viewport.name}: ${page} overflowed by ${state.overflow}px`);
        if (viewport.width < 900 && state.menuDisplay === 'none') {
          errors.push(`${viewport.name}: mobile menu is hidden`);
        }
        if (viewport.name === 'desktop' && ['sale', 'stock', 'help', 'dashboard'].includes(page)) {
          if (page === 'stock') {
            await cdp.evaluate(`{
              const content = document.getElementById('content');
              content.scrollTop = content.scrollHeight;
              true;
            }`);
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          const pageImage = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
          fs.writeFileSync(
            path.join(outputDir, `desktop-${page}.png`),
            Buffer.from(pageImage.data, 'base64')
          );
          if (page === 'sale') {
            await cdp.evaluate(`openSaleMoreDetails(); true`);
            await new Promise(resolve => setTimeout(resolve, 220));
            const drawerImage = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
            fs.writeFileSync(path.join(outputDir, 'desktop-sale-f4.png'), Buffer.from(drawerImage.data, 'base64'));
            await cdp.evaluate(`closeSaleMoreDetails(); true`);
          }
          if (page === 'stock') {
            await cdp.evaluate(`{ document.getElementById('content').scrollTop = 0; true; }`);
          }
        }
        checked += 1;
      }
      const image = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(path.join(outputDir, `${viewport.name}.png`), Buffer.from(image.data, 'base64'));
    }
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(checked, 24);
    cdp.socket.close();
    console.log('Responsive Chrome integration tests passed');
  } catch (error) {
    console.error(error);
    console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    await stopProcess(chrome);
    await stopProcess(server);
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (_) {}
    try { fs.rmSync(chromeData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (_) {}
  }
})();
