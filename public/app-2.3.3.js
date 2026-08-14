// ═══════════════════════════════════════════════════════
//  TARANGINI ACCOUNTING SUITE — Frontend Application
// ═══════════════════════════════════════════════════════

const API = '';

function readStoredUser() {
  try {
    const value = localStorage.getItem('user');
    return value ? JSON.parse(value) : null;
  } catch (_) {
    localStorage.removeItem('user');
    localStorage.removeItem('token');
    return null;
  }
}

var APP_STATE = {
  token: localStorage.getItem('token'),
  user: readStoredUser(),
  orgs: [],
  currentOrg: null,
  currentFY: getCurrentFY(),
  parties: [],
  items: [],
  categories: [],
  transactionControls: {},
  transactionControlMeta: [],
  currentPage: 'dashboard',
  editingBill: null,
  editingPayment: null,
  emergencyEditReason: '',
  previewBill: null,
};
window.STATE = APP_STATE;

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  const button = document.getElementById('install-mobile-app');
  if (button) button.style.display = 'inline-flex';
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const button = document.getElementById('install-mobile-app');
  if (button) button.style.display = 'none';
});
document.addEventListener('click', async event => {
  if (event.target?.id !== 'install-mobile-app' || !deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  event.target.style.display = 'none';
});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(error => {
      console.error('Mobile app foundation registration failed:', error);
    });
  });
}
let syncEvents = null;
let syncRefreshTimer = null;
let lastSyncRevision = null;
let SECURITY_POLICY = { enabled: true, minutes: 15, warning_seconds: 60 };
let lastActivityAt = Date.now();
let idleSecurityTimer = null;
let applicationLocked = false;
let idleWarningVisible = false;
let tokenRefreshPromise = null;
let OFFLINE_STATUS = null;
let offlineStatusTimer = null;
const DRAFT_PAGES = new Set([
  'sale','project-printing','quotation','challan','proforma','payment-received','payment-voucher',
  'purchase','expense','notes','journal-entry','pos','returns','purchase-orders'
]);

function connectAutoSync() {
  if (syncEvents) syncEvents.close();
  syncEvents = new EventSource('/api/sync/events');
  syncEvents.onmessage = event => {
    const update = JSON.parse(event.data);
    if (lastSyncRevision === null) {
      lastSyncRevision = update.revision;
      return;
    }
    if (!update.revision || update.revision === lastSyncRevision) return;
    lastSyncRevision = update.revision;
    clearTimeout(syncRefreshTimer);
    syncRefreshTimer = setTimeout(async () => {
      if (!APP_STATE.user || !APP_STATE.currentOrg) return;
      await loadSecurityPolicy();
      await loadMasterData();
      if (DRAFT_PAGES.has(APP_STATE.currentPage)) {
        toast('Data synced from another computer. Your current draft was preserved.', 'info');
      } else {
        navigate(APP_STATE.currentPage);
        toast('Data synced from another computer', 'info');
      }
    }, 400);
  };
}

async function loadSecurityPolicy() {
  if (!APP_STATE.token) return;
  try {
    SECURITY_POLICY = await api('GET', '/auth/security-settings');
    lastActivityAt = Date.now();
    hideIdleWarning();
    startIdleSecurityMonitor();
  } catch (e) {
    console.error('Security settings load error:', e);
  }
}

function startIdleSecurityMonitor() {
  clearInterval(idleSecurityTimer);
  if (!SECURITY_POLICY.enabled || !APP_STATE.user) return;
  idleSecurityTimer = setInterval(checkIdleSecurity, 1000);
}

function registerUserActivity() {
  if (!APP_STATE.user || applicationLocked) return;
  lastActivityAt = Date.now();
  if (idleWarningVisible) hideIdleWarning();
}

function checkIdleSecurity() {
  if (!APP_STATE.user || applicationLocked || !SECURITY_POLICY.enabled) return;
  const idleSeconds = Math.floor((Date.now() - lastActivityAt) / 1000);
  const lockSeconds = SECURITY_POLICY.minutes * 60;
  const remaining = lockSeconds - idleSeconds;
  if (remaining <= 0) {
    lockApplication('idle');
  } else if (remaining <= SECURITY_POLICY.warning_seconds) {
    showIdleWarning(remaining);
  }
}

function showIdleWarning(seconds) {
  idleWarningVisible = true;
  document.getElementById('idle-countdown').textContent = Math.max(0, seconds);
  document.getElementById('idle-warning').style.display = 'flex';
}

function hideIdleWarning() {
  idleWarningVisible = false;
  const warning = document.getElementById('idle-warning');
  if (warning) warning.style.display = 'none';
}

function continueSession() {
  lastActivityAt = Date.now();
  hideIdleWarning();
}

function lockApplication(reason = 'manual') {
  if (!APP_STATE.user || applicationLocked) return;
  applicationLocked = true;
  hideIdleWarning();
  document.getElementById('lock-user-name').textContent = APP_STATE.user.name;
  document.getElementById('unlock-password').value = '';
  document.getElementById('unlock-error').style.display = 'none';
  document.getElementById('application-lock').style.display = 'flex';
  setTimeout(() => document.getElementById('unlock-password').focus(), 50);
  api('POST', '/auth/lock-event', { reason }).catch(() => {});
}

async function unlockApplication() {
  const pin = document.getElementById('unlock-password').value;
  const error = document.getElementById('unlock-error');
  const button = document.getElementById('unlock-button');
  if (!pin) {
    error.textContent = 'Enter your PIN';
    error.style.display = 'block';
    return;
  }
  button.disabled = true;
  try {
    await api('POST', '/auth/unlock', { pin, password: pin });
    applicationLocked = false;
    lastActivityAt = Date.now();
    document.getElementById('application-lock').style.display = 'none';
    error.style.display = 'none';
    toast('Application unlocked', 'success');
  } catch (e) {
    error.textContent = e.message;
    error.style.display = 'block';
    document.getElementById('unlock-password').select();
  } finally {
    button.disabled = false;
  }
}

async function logoutFromLock() {
  applicationLocked = false;
  document.getElementById('application-lock').style.display = 'none';
  await doLogout();
}

['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(eventName => {
  document.addEventListener(eventName, registerUserActivity, { passive: true });
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkIdleSecurity();
});

// ── UTILS ──────────────────────────────────────────────
function getCurrentFY() {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${y}-${String(y + 1).slice(-2)}`;
}

function getFYForDate(dateValue) {
  const now = dateValue ? new Date(`${dateValue}T00:00:00`) : new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${y}-${String(y + 1).slice(-2)}`;
}

function voucherCompanyOptions(selectedId) {
  return APP_STATE.orgs.map(org =>
    `<option value="${org.id}" ${Number(org.id) === Number(selectedId) ? 'selected' : ''}>${esc(org.display_name)}</option>`
  ).join('');
}

async function switchVoucherCompany(orgId, context, subtype) {
  const org = APP_STATE.orgs.find(item => Number(item.id) === Number(orgId));
  if (!org || Number(org.id) === Number(APP_STATE.currentOrg?.id)) return;
  APP_STATE.currentOrg = org;
  const sidebar = document.getElementById('org-selector');
  if (sidebar) sidebar.value = org.id;
  updateOrgDisplay();
  await loadMasterData();
  if (context === 'bill') await renderBillForm(subtype);
  if (context === 'project-printing') await renderProjectPrintingInvoice();
  if (context === 'payment') await renderPaymentForm(subtype === 'paid' ? 'voucher' : undefined);
  if (context === 'journal') await renderJournalEntry();
}

function getFYList() {
  const base = 2023;
  const cur = parseInt(getCurrentFY().split('-')[0]);
  const list = [];
  for (let y = base; y <= cur + 1; y++) list.push(`${y}-${String(y + 1).slice(-2)}`);
  return list.reverse();
}

function fmt(n) { return '₹' + parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtN(n) { return parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtDate(d) { if (!d) return '—'; const dt = new Date(d); return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
function today() { return new Date().toISOString().split('T')[0]; }
function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  el.innerHTML = `<span>${icons[type] || ''}</span><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function openDesktopNetworkSetup() {
  if (!window.taranginiDesktop?.openNetworkSetup) {
    toast('Main / Client setup is available in the installed desktop application', 'info');
    return;
  }
  try {
    await window.taranginiDesktop.openNetworkSetup();
  } catch (error) {
    toast(`Cannot open system setup: ${error.message}`, 'error');
  }
}

async function refreshSessionToken() {
  if (tokenRefreshPromise) return tokenRefreshPromise;
  if (!APP_STATE?.token) throw new Error('Please sign in again');
  tokenRefreshPromise = fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: APP_STATE.token })
  }).then(async response => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Session expired');
    APP_STATE.token = data.token;
    APP_STATE.user = data.user;
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    return data.token;
  }).finally(() => { tokenRefreshPromise = null; });
  return tokenRefreshPromise;
}

async function api(method, path, body, retried = false) {
  const requestToken = APP_STATE?.token || '';
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${requestToken}` }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + '/api' + path, opts);
  const responseText = await res.text();
  let data = {};
  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch (_) {
    const plainMessage = responseText
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    data = { error: plainMessage || `Server returned ${res.status}` };
  }
  if (res.status === 401 && APP_STATE.token && path !== '/auth/login' && path !== '/auth/refresh' && !retried) {
    // Another in-flight request may already have rotated the session token.
    // Retry with that token instead of refreshing again and invalidating it.
    if (requestToken === APP_STATE.token) await refreshSessionToken();
    return api(method, path, body, true);
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function showLoading(container) {
  document.getElementById(container || 'content').innerHTML = `<div class="loading"><div class="spinner"></div> Loading...</div>`;
}

let confirmCallback = null;
function showConfirm(title, msg, okLabel = 'Confirm', danger = true) {
  return new Promise(resolve => {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-msg').textContent = msg;
    const btn = document.getElementById('confirm-ok-btn');
    btn.textContent = okLabel;
    btn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    confirmCallback = resolve;
    document.getElementById('confirm-modal').style.display = 'flex';
  });
}
function closeConfirm(val) {
  document.getElementById('confirm-modal').style.display = 'none';
  if (confirmCallback) confirmCallback(val);
}

// ── AUTH ───────────────────────────────────────────────
async function doLogin() {
  const username = document.getElementById('login-username').value.trim();
  const pin = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  if (!username || !pin) { errEl.textContent = 'Enter username and PIN'; errEl.style.display = 'block'; return; }
  try {
    const data = await api('POST', '/auth/login', { username, pin, password: pin });
    if (!data?.token || !data?.user) throw new Error(data?.error || 'Login response was incomplete. Please retry.');
    APP_STATE.token = data.token;
    APP_STATE.user = data.user;
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    errEl.style.display = 'none';
    initApp();
  } catch(e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

function showChangePinModal() {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'change-pin-modal';
  modal.innerHTML = `<div class="modal-box modal-small">
    <div class="modal-header"><h3>Change My PIN</h3>
      <button class="btn btn-secondary btn-sm" onclick="document.getElementById('change-pin-modal').remove()">Close</button></div>
    <div class="modal-body">
      <div class="form-group"><label>Current PIN or Recovery Password</label>
        <input type="password" id="pin-current" autocomplete="current-password"></div>
      <div class="form-group"><label>New PIN</label>
        <input type="password" inputmode="numeric" maxlength="6" id="pin-new" placeholder="4-6 digits"></div>
      <div class="form-group"><label>Confirm New PIN</label>
        <input type="password" inputmode="numeric" maxlength="6" id="pin-confirm" placeholder="Repeat PIN"></div>
      <button class="btn btn-success btn-full" onclick="changeMyPin()">Update PIN</button>
    </div></div>`;
  document.body.appendChild(modal);
}

async function changeMyPin() {
  const current = document.getElementById('pin-current').value;
  const next = document.getElementById('pin-new').value;
  const confirm = document.getElementById('pin-confirm').value;
  if (!/^\d{4,6}$/.test(next)) return toast('PIN must contain 4 to 6 digits','error');
  if (next !== confirm) return toast('PINs do not match','error');
  try {
    await api('POST','/auth/change-pin',{ current_pin: current, current_password: current, new_pin: next });
    document.getElementById('change-pin-modal')?.remove();
    toast('PIN updated','success');
  } catch (error) { toast(error.message,'error'); }
}

async function doLogout() {
  try { await api('POST', '/auth/logout'); } catch(e) {}
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  APP_STATE.token = null; APP_STATE.user = null;
  clearInterval(idleSecurityTimer);
  applicationLocked = false;
  hideIdleWarning();
  document.getElementById('application-lock').style.display = 'none';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('login-screen').style.display !== 'none') doLogin();
  if (e.key === 'Enter' && applicationLocked) unlockApplication();
});

// ── APP INIT ───────────────────────────────────────────
async function initApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';

  // User display
  document.getElementById('user-name-display').textContent = APP_STATE.user.name;
  document.getElementById('user-role-display').textContent = APP_STATE.user.role;
  document.getElementById('user-avatar').textContent = APP_STATE.user.name[0].toUpperCase();
  const footer = document.querySelector('.sidebar-footer');
  if (footer && !document.getElementById('change-pin-button')) {
    const button = document.createElement('button');
    button.id = 'change-pin-button';
    button.className = 'system-setup-button';
    button.textContent = 'Change My PIN';
    button.onclick = showChangePinModal;
    footer.insertBefore(button, footer.querySelector('.user-info'));
  }

  // FY selector
  const fySelect = document.getElementById('fy-selector');
  fySelect.innerHTML = getFYList().map(fy => `<option value="${fy}" ${fy === APP_STATE.currentFY ? 'selected' : ''}>${fy}</option>`).join('');

  // Hide owner-only nav items for operators
  if (APP_STATE.user.role !== 'owner') {
    document.getElementById('nav-owner-only').style.display = 'none';
    document.getElementById('nav-journal').style.display = 'none';
  }
  applyPermissionNavigation();

  // Load orgs
  await loadOrgs();
  await loadMasterData();
  await checkBackupStatus();
  await loadSecurityPolicy();
  connectAutoSync();
  startOfflineStatusMonitor();
  navigate('dashboard');
  startPresenceHeartbeat();
}

async function getOfflineStatus() {
  if (window.taranginiDesktop?.getOfflineStatus) return window.taranginiDesktop.getOfflineStatus();
  try { return await api('GET', '/offline/status'); }
  catch (_) { return { role: 'browser', online: true, counts: { pending: 0, synced: 0, conflict: 0 }, items: [] }; }
}

function startOfflineStatusMonitor() {
  clearInterval(offlineStatusTimer);
  refreshOfflineStatus();
  offlineStatusTimer = setInterval(refreshOfflineStatus, 5000);
}

async function refreshOfflineStatus() {
  try {
    OFFLINE_STATUS = await getOfflineStatus();
    const chip = document.getElementById('offline-status-chip');
    if (!chip) return;
    if (OFFLINE_STATUS.role !== 'client') {
      chip.style.display = 'none';
      return;
    }
    chip.style.display = '';
    const pending = Number(OFFLINE_STATUS.counts?.pending || 0);
    const conflicts = Number(OFFLINE_STATUS.counts?.conflict || 0);
    chip.textContent = OFFLINE_STATUS.online
      ? `${OFFLINE_STATUS.device_code} Online${pending ? ` | ${pending} pending` : ''}`
      : `${OFFLINE_STATUS.device_code} Offline${pending ? ` | ${pending} pending` : ''}`;
    chip.style.color = conflicts ? 'var(--red)' : OFFLINE_STATUS.online ? 'var(--green)' : 'var(--gold)';
    if (OFFLINE_STATUS.version_mismatch && !sessionStorage.getItem('tarangini_version_warning')) {
      sessionStorage.setItem('tarangini_version_warning', '1');
      toast(`Client ${OFFLINE_STATUS.app_version} does not match main system ${OFFLINE_STATUS.server_version}. Update this client.`, 'warning');
    }
    if (APP_STATE.currentPage === 'offline-sync') renderOfflineSync(false);
  } catch (_) {}
}

function hasPermission(permission) {
  return APP_STATE.user?.role === 'owner' || Boolean(APP_STATE.user?.permissions?.[permission]);
}

function applyPermissionNavigation() {
  const required = {
    pos:'pos', returns:'returns', shifts:'shifts', 'purchase-orders':'purchase_orders',
    purchase:'purchases', expense:'accounting', notes:'billing', stock:'inventory',
    'bank-reconciliation':'bank_import', 'party-statement':'reports', 'sales-report':'reports',
    'financial-reports':'reports', 'invoice-status':'reports', 'gst-reports':'reports',
    profitability:'profit', 'journal-entry':'accounting', backup:'backup',
    'network-status':'settings', 'scheduled-reports':'scheduled_reports', diagnostics:'diagnostics',
    settings:'settings', 'update-manager':'settings',
    jobs:['jobs_counter','jobs_operations'], 'job-new':'jobs_counter',
    'job-catalog':'jobs_catalog', 'job-whatsapp':'jobs_whatsapp'
  };
  Object.entries(required).forEach(([page, permission]) => {
    const element = document.querySelector(`[data-page="${page}"]`);
    const allowed = Array.isArray(permission)
      ? permission.some(item => hasPermission(item))
      : hasPermission(permission);
    if (element && !allowed) element.style.display = 'none';
  });
  const jobSection = document.getElementById('nav-job-workflow-section');
  if (jobSection) {
    const visibleItems = [...jobSection.querySelectorAll('.nav-item')]
      .some(item => item.style.display !== 'none');
    jobSection.style.display = visibleItems ? '' : 'none';
  }
}

let presenceTimer = null;
function startPresenceHeartbeat() {
  if (presenceTimer) clearInterval(presenceTimer);
  const clientId = localStorage.getItem('tarangini_client_id') ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem('tarangini_client_id', clientId);
  const send = () => {
    if (!APP_STATE.token || !APP_STATE.currentOrg) return;
    api('POST', '/advanced/presence', {
      client_id: clientId,
      client_name: localStorage.getItem('tarangini_counter_name') || 'Tarangini Computer',
      org_id: APP_STATE.currentOrg.id,
      page: APP_STATE.currentPage,
      app_version: OFFLINE_STATUS.app_version || '',
      pending_sync: Number(OFFLINE_STATUS.counts?.pending || 0),
      sync_conflicts: Number(OFFLINE_STATUS.counts?.conflict || 0)
    }).catch(() => {});
  };
  send();
  presenceTimer = setInterval(send, 30000);
}

function toggleMobileSidebar(force) {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  sidebar.classList.toggle('mobile-open', force === undefined ? !sidebar.classList.contains('mobile-open') : Boolean(force));
}

async function loadOrgs() {
  const selectedId = APP_STATE.currentOrg?.id;
  APP_STATE.orgs = await api('GET', '/orgs');
  const sel = document.getElementById('org-selector');
  sel.innerHTML = APP_STATE.orgs.map(o => `<option value="${o.id}">${o.display_name}</option>`).join('');
  if (APP_STATE.orgs.length) {
    APP_STATE.currentOrg = APP_STATE.orgs.find(org => Number(org.id) === Number(selectedId)) || APP_STATE.orgs[0];
    sel.value = APP_STATE.currentOrg.id;
    sel.value = APP_STATE.currentOrg.id;
    updateOrgDisplay();
    await loadTransactionControls();
  }
}

async function loadTransactionControls() {
  APP_STATE.transactionControls = {};
  APP_STATE.transactionControlMeta = [];
  if (!APP_STATE.currentOrg) return;
  try {
    const result = await api('GET', `/orgs/${APP_STATE.currentOrg.id}/transaction-controls`);
    APP_STATE.transactionControlMeta = result.meta || [];
    (result.controls || []).forEach(row => {
      APP_STATE.transactionControls[row.transaction_type] = row;
    });
  } catch (error) {
    console.warn('Transaction controls unavailable:', error.message);
  }
}

async function switchOrg(id) {
  APP_STATE.currentOrg = APP_STATE.orgs.find(o => o.id == id);
  updateOrgDisplay();
  await loadTransactionControls();
  await loadMasterData();
  navigate(APP_STATE.currentPage);
}

function switchFY(fy) {
  APP_STATE.currentFY = fy;
  document.getElementById('topbar-fy').textContent = `FY ${fy}`;
  navigate(APP_STATE.currentPage);
}

function updateOrgDisplay() {
  if (!APP_STATE.currentOrg) return;
  document.getElementById('sidebar-org-name').textContent = APP_STATE.currentOrg.display_name;
  document.getElementById('topbar-org').textContent = APP_STATE.currentOrg.display_name;
  document.getElementById('topbar-fy').textContent = `FY ${APP_STATE.currentFY}`;
  document.body.dataset.companyTheme = invoiceTheme(APP_STATE.currentOrg);
}

function invoiceTheme(org) {
  const value = String(org?.invoice_theme || 'classic').toLowerCase();
  return ['classic', 'sapphire', 'emerald', 'sunset', 'common-gst'].includes(value) ? value : 'classic';
}

function invoicePrintOptions(org) {
  let parsed = {};
  try {
    parsed = typeof org?.invoice_print_options === 'string'
      ? JSON.parse(org.invoice_print_options || '{}')
      : (org?.invoice_print_options || {});
  } catch (_) { parsed = {}; }
  return {
    hsn: parsed.hsn !== false,
    rate: parsed.rate !== false,
    tax_inclusive_value: parsed.tax_inclusive_value !== false,
    bank_details: parsed.bank_details !== false
  };
}

function transactionControl(type) {
  const meta = APP_STATE.transactionControlMeta?.find(row => row.type === type);
  const control = APP_STATE.transactionControls?.[type] || {
    transaction_type: type,
    form_options: {},
    required_fields: {},
    print_options: {}
  };
  return { label: meta?.label || type, ...control };
}

function txShow(type, field) {
  return transactionControl(type).form_options?.[field] !== false;
}

function txRequired(type, field) {
  const control = transactionControl(type);
  return control.form_options?.[field] !== false && control.required_fields?.[field] === true;
}

function txPrint(type, field) {
  return transactionControl(type).print_options?.[field] !== false;
}

function txGroup(type, field, html) {
  return txShow(type, field) ? html : '';
}

function requireVisibleFields(type, checks) {
  const missing = checks
    .filter(check => txRequired(type, check.field) && !check.valid())
    .map(check => check.label);
  if (missing.length) {
    toast(`${transactionControl(type).label || type}: required field missing - ${missing.join(', ')}`, 'error');
    return false;
  }
  return true;
}

async function loadMasterData() {
  if (!APP_STATE.currentOrg) return;
  try {
    [APP_STATE.parties, APP_STATE.items, APP_STATE.categories] = await Promise.all([
      api('GET', `/parties?org_id=${APP_STATE.currentOrg.id}`),
      api('GET', `/items?org_id=${APP_STATE.currentOrg.id}`),
      api('GET', `/items/categories?org_id=${APP_STATE.currentOrg.id}`)
    ]);
  } catch(e) { console.error('Master data load error:', e); }
}

async function checkBackupStatus() {
  if (!APP_STATE.currentOrg) return;
  try {
    const status = await api('GET', `/backup/status?org_id=${APP_STATE.currentOrg.id}`);
    const navBackup = document.getElementById('nav-backup');
    if (status.critical) {
      navBackup.innerHTML = `<span class="icon">💾</span> Backup <span class="nav-badge">!</span>`;
    } else if (status.warning) {
      navBackup.innerHTML = `<span class="icon">💾</span> Backup <span class="nav-badge warn">!</span>`;
    }
  } catch(e) {}
}

// ── NAVIGATION ─────────────────────────────────────────
function navigate(page) {
  const protectedPages = {
    pos:'pos', returns:'returns', shifts:'shifts', 'purchase-orders':'purchase_orders',
    profitability:'profit', 'network-status':'settings',
    'scheduled-reports':'scheduled_reports', diagnostics:'diagnostics',
    'update-manager':'settings', 'invoice-corrections':'billing',
    jobs:['jobs_counter','jobs_operations'], 'job-new':'jobs_counter',
    'job-catalog':'jobs_catalog', 'job-whatsapp':'jobs_whatsapp'
  };
  const pagePermission = protectedPages[page];
  const pageAllowed = Array.isArray(pagePermission)
    ? pagePermission.some(item => hasPermission(item))
    : !pagePermission || hasPermission(pagePermission);
  if (!pageAllowed) {
    toast('You do not have permission to open this screen', 'error');
    return;
  }
  APP_STATE.currentPage = page;
  APP_STATE.editingBill = null;
  toggleMobileSidebar(false);

  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const navEl = document.querySelector(`[data-page="${page}"]`);
  if (navEl) navEl.classList.add('active');

  const titles = {
    dashboard: 'Dashboard', sale: 'New Sale Bill', 'project-printing': 'Project Printing Invoice', quotation: 'New Quotation',
    pos: 'Fast POS Counter', returns: 'Returns & Refunds', shifts: 'Counter Shifts',
    'purchase-orders': 'Purchase Orders',
    challan: 'Delivery Challan', proforma: 'Proforma Invoice',
    'payment-received': 'Payment Received', 'payment-voucher': 'Payment Voucher',
    'bills-list': 'All Bills', parties: 'Parties Master', items: 'Items Master',
    'party-statement': 'Party Statement', 'sales-report': 'Sales Report',
    'financial-reports': 'Financial Reports', 'journal-entry': 'Journal Entry',
    purchase: 'Purchase Bills', expense: 'Expense Vouchers', notes: 'Credit / Debit Notes',
    stock: 'Inventory & Stock', 'bank-reconciliation': 'Bank Reconciliation',
    'invoice-status': 'Invoice Payment Status', 'gst-reports': 'GST Reports',
    profitability: 'Profitability', 'network-status': 'Network Status',
    'scheduled-reports': 'Scheduled Reports', diagnostics: 'Data Diagnostics',
    'invoice-corrections': 'Invoice Corrections', 'update-manager': 'Update Manager',
    'offline-sync': 'Offline Billing Sync', backup: 'Backup & Restore', settings: 'Settings',
    help: 'Help & FAQ', jobs: 'Job Workflow', 'job-new': 'New Job Order',
    'job-catalog': 'Service Catalog', 'job-whatsapp': 'Open WhatsApp'
  };
  document.getElementById('page-title').textContent = titles[page] || page;
  document.getElementById('topbar-actions').innerHTML = '';

  const pages = {
    dashboard: renderDashboard, sale: () => renderBillForm('SALE'),
    pos: renderPOS, returns: renderReturns, shifts: renderShifts,
    'purchase-orders': renderPurchaseOrders,
    'project-printing': renderProjectPrintingInvoice,
    quotation: () => renderBillForm('QUOT'), challan: () => renderBillForm('DC'),
    proforma: () => renderBillForm('PI'), 'payment-received': renderPaymentForm,
    'payment-voucher': () => renderPaymentForm('voucher'),
    'bills-list': renderBillsList, parties: renderParties, items: renderItems,
    'party-statement': renderPartyStatement, 'sales-report': renderSalesReport,
    'financial-reports': renderFinancialReports, 'journal-entry': renderJournalEntry,
    purchase: renderPurchases, expense: renderExpenses, notes: renderNotes,
    stock: renderStock, 'bank-reconciliation': renderBankReconciliation,
    'invoice-status': renderInvoiceStatus, 'gst-reports': renderGSTReports,
    profitability: renderProfitability, 'network-status': renderNetworkStatus,
    'scheduled-reports': renderScheduledReports, diagnostics: renderDiagnostics,
    'invoice-corrections': renderInvoiceCorrections, 'update-manager': renderUpdateManager,
    'offline-sync': renderOfflineSync, backup: renderBackup, settings: renderSettings,
    help: renderHelp, jobs: renderJobs, 'job-new': renderNewJob,
    'job-catalog': renderJobCatalog, 'job-whatsapp': renderJobWhatsApp
  };

  if (pages[page]) pages[page]();
  else document.getElementById('content').innerHTML = `<div class="empty-state"><div class="icon">🚧</div><p>Coming soon</p></div>`;
}

// ── DASHBOARD ──────────────────────────────────────────
async function renderDashboard() {
  if (!APP_STATE.currentOrg) return;
  showLoading();
  try {
    const [data, mobileLogin] = await Promise.all([
      api('GET', `/reports/dashboard?org_id=${APP_STATE.currentOrg.id}&fy=${APP_STATE.currentFY}`),
      api('GET', '/advanced/mobile-login-qr').catch(() => null)
    ]);
    const monthNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const maxSale = Math.max(...(data.monthly_sales || []).map(m => m.total), 1);

    document.getElementById('content').innerHTML = `
    <div class="stats-grid">
      <div class="stat-card gold">
        <div class="stat-label">Total Sales (${APP_STATE.currentFY})</div>
        <div class="stat-value">${fmt(data.total_sales)}</div>
        <div class="stat-sub">${data.total_bills} bills</div>
      </div>
      <div class="stat-card green">
        <div class="stat-label">Cash Sales</div>
        <div class="stat-value">${fmt(data.cash_sales)}</div>
        <div class="stat-sub">Cash transactions</div>
      </div>
      <div class="stat-card red">
        <div class="stat-label">Credit Sales</div>
        <div class="stat-value">${fmt(data.credit_sales)}</div>
        <div class="stat-sub">Pending collection</div>
      </div>
      <div class="stat-card blue">
        <div class="stat-label">Cash Received</div>
        <div class="stat-value">${fmt(data.cash_balance)}</div>
        <div class="stat-sub">Payments collected</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Quotations</div>
        <div class="stat-value">${data.total_quotations}</div>
        <div class="stat-sub">This year</div>
      </div>
      <div class="stat-card red">
        <div class="stat-label">Overdue Invoices</div>
        <div class="stat-value">${data.overdue_count || 0}</div>
        <div class="stat-sub">${fmt(data.overdue_total)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Low Stock</div>
        <div class="stat-value">${data.low_stock_count || 0}</div>
        <div class="stat-sub">At or below reorder level</div>
      </div>
    </div>

    <div class="alert-grid">
      <div class="card card-sm"><strong>Receivables:</strong> ${fmt(data.receivable)}</div>
      ${(data.cash_bank || []).map(row => `<div class="card card-sm"><strong>${row.system_key === 'cash' ? 'Cash' : 'Bank'}:</strong> ${fmt(row.balance)}</div>`).join('')}
      <div class="card card-sm"><strong>Last Backup:</strong> ${data.backup_date ? fmtDate(data.backup_date) : 'Not yet created'}</div>
    </div>

    ${mobileLogin ? `
      <div class="card mobile-login-card">
        <div>
          <div class="section-title">Mobile Operator Login</div>
          <p>Connect the phone or tablet to the same Wi-Fi/LAN, scan this QR code, then sign in with the operator username and PIN.</p>
          <div class="mobile-login-url mono">${esc(mobileLogin.url)}</div>
          <div class="security-setting-note">The QR contains only the server address. It does not contain a password, PIN or login token.</div>
        </div>
        <img src="${esc(mobileLogin.qr_data_url)}" alt="QR code for mobile operator login">
      </div>` : ''}

    <div class="dash-grid">
      <div class="chart-card">
        <div class="chart-title">📊 Monthly Sales — ${APP_STATE.currentFY}</div>
        <div class="bar-chart">
          ${(data.monthly_sales || []).map(m => `
            <div class="bar-wrap">
              <div class="bar-val">${m.total >= 1000 ? (m.total/1000).toFixed(1)+'k' : fmtN(m.total).split('.')[0]}</div>
              <div class="bar" style="height:${Math.max(4, (m.total/maxSale)*100)}px" title="${fmt(m.total)}"></div>
              <div class="bar-label">${monthNames[parseInt(m.month)]}</div>
            </div>`).join('') || '<div style="color:var(--text3);padding:20px">No sales data yet</div>'}
        </div>
      </div>
      <div class="chart-card">
        <div class="chart-title">🏆 Top Parties</div>
        ${(data.top_parties || []).slice(0,6).map((p,i) => `
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">
            <span style="color:var(--text2)">${i+1}. ${esc(p.name)}</span>
            <span class="mono" style="color:var(--gold)">${fmt(p.total)}</span>
          </div>`).join('') || '<div style="color:var(--text3);padding:10px">No data</div>'}
      </div>
    </div>

    <div style="margin-top:16px">
      <div class="chart-card">
        <div class="chart-title">📦 Top Items by Revenue</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Item</th><th>Qty Sold</th><th>Revenue</th></tr></thead>
            <tbody>
              ${(data.top_items || []).slice(0,10).map((it,i) => `
                <tr><td>${i+1}</td><td>${esc(it.item_name||'—')}</td>
                <td class="mono">${fmtN(it.total_qty)}</td>
                <td class="amount">${fmt(it.total_amount)}</td></tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:20px">No data</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="navigate('sale')">+ New Sale Bill</button>
      <button class="btn btn-secondary" onclick="navigate('quotation')">+ New Quotation</button>
      <button class="btn btn-secondary" onclick="navigate('bills-list')">📑 View All Bills</button>
    </div>`;
  } catch(e) {
    document.getElementById('content').innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>${e.message}</p></div>`;
  }
}

// ── BILL FORM ──────────────────────────────────────────
let billItems = [];
let billFormData = {};

async function renderBillForm(format, existingBill) {
  if (!APP_STATE.currentOrg) { toast('Select an organization first', 'error'); return; }
  activeBillFormat = format;
  billItems = existingBill ? JSON.parse(existingBill.items_json || '[]') : [emptyItem()];
  billFormData = existingBill || {};
  payMode = existingBill?.payment_mode || 'cash';

  const formatLabels = { SALE:'Sale Bill', QUOT:'Quotation', DC:'Delivery Challan', PI:'Proforma Invoice' };
  const org = APP_STATE.currentOrg;
  const gstType = org.gst_type || 'regular';
  taxInclusive = existingBill
    ? Boolean(Number(existingBill.tax_inclusive || 0))
    : Boolean(Number(org.default_tax_inclusive || 0));
  const selectedParty = existingBill?.party_id ? APP_STATE.parties.find(p => p.id == existingBill.party_id) : null;
  const dscRequired = existingBill
    ? Boolean(Number(existingBill.digital_signature_required || 0))
    : Boolean(Number(selectedParty?.digital_signature_required || 0));
  const dscNote = existingBill?.digital_signature_note
    || (dscRequired ? 'Digital signature required before issue. Use the USB DSC token externally; Tarangini does not store DSC passwords.' : '');

  // Get next bill number
  let nextNum = '—';
  try {
    if (!existingBill) {
      const numberDate = existingBill?.bill_date || today();
      const r = await api('GET', `/bills/next-number?org_id=${org.id}&format=${format}&fy=${getFYForDate(numberDate)}`);
      nextNum = r.number;
    } else { nextNum = existingBill.bill_number; }
  } catch(e) {}

  const showPO = format !== 'DC';
  const showTax = format !== 'DC';
  const isDC = format === 'DC';

  // Topbar action buttons
  document.getElementById('topbar-actions').innerHTML = `
    <button class="btn btn-secondary btn-sm" onclick="navigate('bills-list')">📑 Bills List</button>`;

  document.getElementById('content').innerHTML = `
  <div class="bill-form">
    <div class="voucher-access-bar">
      <div class="form-group">
        <label>Voucher Company</label>
        <select id="voucher-org" onchange="switchVoucherCompany(this.value,'bill','${format}')" ${existingBill ? 'disabled' : ''}>
          ${voucherCompanyOptions(org.id)}
        </select>
      </div>
      <div class="form-group">
        <label>${formatLabels[format]} Number</label>
        <input type="text" id="bf-billno" value="${esc(nextNum)}" readonly>
      </div>
      <div class="voucher-company-summary">
        <span>Company</span><strong>${esc(org.display_name)}</strong>
      </div>
    </div>
    <!-- Header Info -->
    <div class="card">
      <div class="section-title">${formatLabels[format]} Details</div>
      <div class="form-row cols-4">
        <div class="form-group">
          <label>Date <span class="req">*</span></label>
          <input type="date" id="bf-date" value="${existingBill?.bill_date || today()}" onchange="refreshBillVoucherNumber('${format}')">
        </div>
        ${showPO ? `
        <div class="form-group">
          <label>PO Number <span style="color:var(--text3)">(opt)</span></label>
          <input type="text" id="bf-pono" placeholder="Purchase order no" value="${esc(billFormData.po_number||'')}">
        </div>
        <div class="form-group">
          <label>PO Date</label>
          <input type="date" id="bf-podate" value="${billFormData.po_date||''}">
        </div>` : '<div></div>'}
        <div></div>
      </div>
      <div class="form-row cols-4">
        <div class="form-group" ${format !== 'SALE' ? 'style="display:none"' : ''}>
          <label>Payment Mode</label>
          <div class="toggle-group" id="bf-paymode">
            <button class="toggle-btn ${payMode==='cash'?'active':''}" onclick="setPayMode('cash',this)">Cash</button>
            <button class="toggle-btn ${payMode==='credit'?'active':''}" onclick="setPayMode('credit',this)">Credit</button>
            <button class="toggle-btn ${['account','bank','upi','card'].includes(payMode)?'active':''}" onclick="setPayMode('account',this)">Bank / UPI / Card</button>
            <button class="toggle-btn ${payMode==='split'?'active':''}" onclick="setPayMode('split',this)">Split</button>
          </div>
        </div>
        <div class="form-group" ${format !== 'SALE' ? 'style="display:none"' : ''}>
          <label>Credit Days <span style="color:var(--text3)">(opt)</span></label>
          <input type="number" id="bf-creditdays" placeholder="e.g. 30" value="${billFormData.credit_days||''}">
        </div>
        ${showTax && gstType === 'regular' ? `
        <div class="form-group">
          <label>Tax Type</label>
          <div class="toggle-group" id="bf-taxtype">
            <button class="toggle-btn ${taxInclusive?'':'active'}" onclick="setTaxInclusive(false,this)">+ GST</button>
            <button class="toggle-btn ${taxInclusive?'active':''}" onclick="setTaxInclusive(true,this)">Incl. GST</button>
          </div>
        </div>` : '<div></div>'}
        <div class="form-group">
          <label>GST Type: <strong style="color:var(--gold)">${gstType === 'composition' ? 'Composition (Bill of Supply)' : 'Regular (18%)'}</strong></label>
          <input type="text" value="${org.display_name}" readonly style="background:var(--surface3);font-size:12px">
        </div>
      </div>
      <div id="bf-split-panel" class="form-row cols-4" style="${payMode==='split'?'':'display:none'}">
        ${['cash','bank','upi','card'].map(mode => `<div class="form-group"><label>${mode.toUpperCase()}</label>
          <input type="number" min="0" step="0.01" id="bf-split-${mode}" value="0" oninput="updateBillSplitBalance()"></div>`).join('')}
        <div id="bf-split-balance" class="security-setting-note"></div>
      </div>
    </div>

    <!-- Party -->
    <div class="card">
      <div class="section-title">Party Details</div>
      <div class="form-row cols-2">
        <div class="form-group">
          <label>${format === 'SALE' || format === 'DC' ? 'Customer' : 'Party'} Name <span class="req">*</span></label>
          <div class="autocomplete-wrap">
            <input type="text" id="bf-party-search" placeholder="Search party name..." oninput="partySearch(this.value)" autocomplete="off"
              value="${billFormData.party_id ? (APP_STATE.parties.find(p=>p.id==billFormData.party_id)?.name||'') : ''}">
            <div id="party-autocomplete" class="autocomplete-list" style="display:none"></div>
          </div>
          <input type="hidden" id="bf-party-id" value="${billFormData.party_id||''}">
        </div>
        <div class="form-group">
          <label>Delivery Address <span style="color:var(--text3)">(opt)</span></label>
          <input type="text" id="bf-delivery-addr" placeholder="Delivery address if different" value="${esc(billFormData.delivery_address||'')}">
        </div>
      </div>
      <div class="form-row cols-3">
        <div class="form-group"><label>Recipient Name</label><input id="bf-recipient-name"></div>
        <div class="form-group"><label>Recipient Phone</label><input id="bf-recipient-phone"></div>
        <div class="form-group"><label>Courier / Transportation Name</label><input id="bf-transport-name"></div>
      </div>
      <div class="form-row cols-2">
        <div class="form-group"><label>Tracking ID / LR / Consignment No.</label><input id="bf-tracking-id"></div>
        <div class="form-group"><label>Dispatch Date</label><input type="date" id="bf-dispatch-date"></div>
      </div>
      <label class="security-setting-toggle">
        <input type="checkbox" id="bf-digital-signature-required" ${dscRequired ? 'checked' : ''} onchange="toggleBillDscNote()">
        <span><strong>Digital signature required for this invoice</strong>
        <small>Use when this bill must be signed with a USB DSC token. The DSC password is not stored.</small></span>
      </label>
      <div class="form-group" id="bf-digital-signature-note-wrap" style="${dscRequired ? '' : 'display:none'}">
        <label>Digital Signature Note</label>
        <input id="bf-digital-signature-note" value="${esc(dscNote)}" placeholder="Digital signature required before issue">
      </div>
      <div id="party-details-display" style="font-size:12px;color:var(--text2);margin-top:-8px"></div>
    </div>

    <!-- Items Table -->
    <div class="card">
      <div class="section-title">${isDC ? 'Items (Delivery Only — No Pricing)' : 'Items'}</div>
      <div class="items-table-wrap">
        <div class="items-table-head" style="grid-template-columns:${isDC ? '32px 1fr 80px 70px 70px 90px 36px' : '32px 1fr 80px 70px 80px 90px 90px 70px 36px'}">
          <span>#</span><span>Item Name</span><span>HSN</span><span>Qty</span><span>Unit</span>
          ${isDC ? '<span id="item-rate-heading">Rate</span>' : `<span id="item-rate-heading">${taxInclusive ? 'Rate (Incl. GST)' : 'Rate (+ GST)'}</span><span>Amount</span><span>GST%</span>`}
          <span></span>
        </div>
        <div id="items-rows"></div>
        <div class="items-add-row">
          <button class="btn btn-outline btn-sm" onclick="addItemRow()">+ Add Item</button>
          <button class="btn btn-secondary btn-sm" onclick="addItemFromMaster()" style="margin-left:6px">📦 From Master</button>
        </div>
      </div>
    </div>

    <!-- Totals & Footer -->
    ${!isDC ? `
    <div class="bill-totals">
      <div>
        <div class="form-group">
          <label>Description (shown at bottom of invoice)</label>
          <textarea id="bf-description" rows="3" placeholder="Work details, delivery information or other description">${esc(billFormData.description||org.invoice_description||'')}</textarea>
        </div>
        <div class="form-group">
          <label>Swipe / Card Charges (optional)</label>
          <input type="number" id="bf-swipe-charge" value="${billFormData.swipe_charge||0}" min="0" step="0.01" oninput="recalcTotals()">
        </div>
      </div>
      <div class="totals-table card card-sm">
        <div class="totals-row"><span>Subtotal</span><span class="mono" id="tot-subtotal">₹0.00</span></div>
        <div class="totals-row"><span>Discount</span>
          <span><input type="number" id="bf-discount" placeholder="0" style="width:80px;text-align:right;padding:3px 6px"
            value="${billFormData.discount||0}" oninput="recalcTotals()"></span>
        </div>
        <div class="totals-row"><span>Taxable Amount</span><span class="mono" id="tot-taxable">₹0.00</span></div>
        ${gstType === 'regular' ? `
        <div class="totals-row tax"><span id="tot-cgst-label">CGST</span><span class="mono" id="tot-cgst">₹0.00</span></div>
        <div class="totals-row tax"><span id="tot-sgst-label">SGST</span><span class="mono" id="tot-sgst">₹0.00</span></div>
        <div class="totals-row tax"><span>Total Tax</span><span class="mono" id="tot-tax">₹0.00</span></div>` : ''}
        <div class="totals-row"><span>Swipe Charges</span><span class="mono" id="tot-swipe">₹0.00</span></div>
        <div class="totals-row"><span>Round Off</span><span class="mono" id="tot-roundoff">₹0.00</span></div>
        <div class="totals-row grand"><span>Grand Total</span><span class="mono" id="tot-grand">₹0.00</span></div>
      </div>
    </div>
    <label class="security-setting-note" style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" id="bf-round-off"
        ${existingBill
          ? (Math.abs(Number(existingBill.round_off || 0)) > 0.001 ||
             Math.abs(Number(existingBill.grand_total || 0) - Math.round(Number(existingBill.grand_total || 0))) < 0.001
              ? 'checked' : '')
          : 'checked'}
        onchange="recalcTotals()"><strong>Round off final total to nearest rupee</strong>
    </label>
    <div class="amount-words" id="tot-words">Amount in words will appear here</div>` : ''}

    <div class="bill-form-actions">
      <button class="btn btn-success" onclick="saveBill('${format}')">💾 Save ${formatLabels[format]}</button>
      <button class="btn btn-secondary" onclick="navigate('bills-list')">Cancel</button>
    </div>
  </div>`;

  renderItemRows(isDC);
  recalcTotals();
  let delivery = {};
  try { delivery = existingBill?.delivery || JSON.parse(existingBill?.delivery_info || '{}'); } catch (_) {}
  const deliveryValues = {
    'bf-recipient-name': delivery.recipient_name,
    'bf-recipient-phone': delivery.recipient_phone,
    'bf-transport-name': delivery.transport_name,
    'bf-tracking-id': delivery.tracking_id,
    'bf-dispatch-date': delivery.dispatch_date
  };
  Object.entries(deliveryValues).forEach(([id, value]) => {
    const input = document.getElementById(id);
    if (input) input.value = value || '';
  });
  try {
    const split = JSON.parse(existingBill?.split_payments || '[]');
    split.forEach(row => {
      const input = document.getElementById(`bf-split-${row.mode}`);
      if (input) input.value = Number(row.amount || 0);
    });
  } catch (_) {}
  updateBillSplitBalance();

  // Pre-fill party if editing
  if (billFormData.party_id) {
    const p = APP_STATE.parties.find(x => x.id == billFormData.party_id);
    if (p) showPartyDetails(p);
  }
}

let projectPrintRows = [];

function emptyProjectPrintRow() {
  return { file_name: '', bw_prints: 0, colour_prints: 0, books: 0 };
}

async function renderProjectPrintingInvoice(existingBill = null) {
  if (!APP_STATE.currentOrg) return toast('Select an organization first', 'error');
  const org = APP_STATE.currentOrg;
  let custom = existingBill?.custom_data || {};
  if (typeof custom === 'string') {
    try { custom = JSON.parse(custom); } catch (_) { custom = {}; }
  }
  projectPrintRows = custom.rows?.length ? custom.rows : [emptyProjectPrintRow()];
  const rates = custom.rates || {};
  const optional = custom.optional || [];
  const optionalAmount = name => Number(optional.find(item => item.name === name)?.amount || 0);
  let nextNum = '-';
  if (existingBill) {
    nextNum = existingBill.bill_number;
  } else try {
    const result = await api('GET', `/bills/next-number?org_id=${org.id}&format=PP&fy=${getFYForDate(today())}`);
    nextNum = result.number;
  } catch (_) {}

  document.getElementById('topbar-actions').innerHTML =
    `<button class="btn btn-secondary btn-sm" onclick="navigate('bills-list')">Bills List</button>`;
  document.getElementById('content').innerHTML = `
    <div class="bill-form">
      <div class="voucher-access-bar">
        <div class="form-group"><label>Voucher Company</label>
          <select id="voucher-org" onchange="switchVoucherCompany(this.value,'project-printing')">${voucherCompanyOptions(org.id)}</select></div>
        <div class="form-group"><label>Project Printing Invoice Number</label>
          <input id="pp-billno" value="${esc(nextNum)}" readonly></div>
        <div class="voucher-company-summary"><span>Company</span><strong>${esc(org.display_name)}</strong></div>
      </div>
      <div class="card">
        <div class="section-title">Project Printing Invoice Details</div>
        <div class="form-row cols-2">
          <div class="form-group"><label>Date</label><input type="date" id="pp-date" value="${existingBill?.bill_date || today()}" onchange="refreshProjectPrintNumber()"></div>
          <div class="form-group"><label>Customer Name</label>
            <div class="autocomplete-wrap">
              <input id="bf-party-search" placeholder="Search or add customer..." oninput="partySearch(this.value)" autocomplete="off">
              <div id="party-autocomplete" class="autocomplete-list" style="display:none"></div>
            </div>
            <input type="hidden" id="bf-party-id">
          </div>
        </div>
        <div id="party-details-display" style="font-size:12px;color:var(--text2)"></div>
      </div>
      <div class="card">
        <div class="section-title">Files and Printing</div>
        ${org.gst_type === 'regular' ? `<label class="security-setting-note" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="pp-tax-inclusive"
            ${Number(existingBill?.tax_inclusive ?? org.default_tax_inclusive ?? 0) ? 'checked' : ''}
            onchange="recalcProjectPrinting()"><strong>Rates include GST</strong></label>` : ''}
        ${roundOffCheckbox('pp-round-off','recalcProjectPrinting()')}
        <div class="form-row cols-3" style="margin-bottom:12px">
          <div class="form-group"><label>B/W Price per Print</label><input type="number" min="0" step="0.01" id="pp-bw-rate" value="${Number(rates.bw ?? org.project_bw_rate ?? 0)}" oninput="recalcProjectPrinting()"></div>
          <div class="form-group"><label>Colour Price per Print</label><input type="number" min="0" step="0.01" id="pp-colour-rate" value="${Number(rates.colour ?? org.project_colour_rate ?? 0)}" oninput="recalcProjectPrinting()"></div>
          <div class="form-group"><label>Cost per Book</label><input type="number" min="0" step="0.01" id="pp-book-rate" value="${Number(rates.book ?? org.project_book_rate ?? 0)}" oninput="recalcProjectPrinting()"></div>
        </div>
        <div style="display:grid;grid-template-columns:32px 1fr 110px 110px 100px 110px 36px;gap:6px;font-size:11px;font-weight:700;margin-bottom:6px">
          <span>#</span><span>File Name</span><span>B/W Pages / Book</span><span>Colour Pages / Book</span><span>No. of Books</span><span>Amount</span><span></span>
        </div>
        <div id="pp-rows"></div>
        <button class="btn btn-outline btn-sm" onclick="addProjectPrintRow()">+ Add File</button>
      </div>
      <div class="card">
        <div class="section-title">Optional Items</div>
        <div class="form-row cols-3">
          ${['Waste Prints','DTP','CD','Courier Charges'].map((name, i) =>
            `<div class="form-group"><label>${name}</label><input type="number" min="0" step="0.01" id="pp-extra-${i}" value="${optionalAmount(name)}" oninput="recalcProjectPrinting()"></div>`).join('')}
          <div class="form-group"><label>Other Item Name</label><input id="pp-other-name" value="${esc(optional.find(item => !['Waste Prints','DTP','CD','Courier Charges'].includes(item.name))?.name || '')}" placeholder="Other charge description"></div>
          <div class="form-group"><label>Other Amount</label><input type="number" min="0" step="0.01" id="pp-extra-4" value="${Number(optional.find(item => !['Waste Prints','DTP','CD','Courier Charges'].includes(item.name))?.amount || 0)}" oninput="recalcProjectPrinting()"></div>
        </div>
      </div>
      <div class="bill-totals">
        <div>
          <div class="form-group"><label>Description (shown at bottom)</label>
            <textarea id="pp-description" rows="3">${esc(existingBill?.description ?? org.invoice_description ?? '')}</textarea></div>
          <div class="form-group"><label>Swipe / Card Charges</label>
            <input type="number" min="0" step="0.01" id="pp-swipe" value="${Number(existingBill?.swipe_charge || 0)}" oninput="recalcProjectPrinting()"></div>
        </div>
        <div class="totals-table card card-sm">
          <div class="totals-row"><span>Subtotal</span><span id="pp-subtotal">${fmt(0)}</span></div>
          ${org.gst_type === 'regular' ? `<div class="totals-row"><span>GST (18%)</span><span id="pp-tax">${fmt(0)}</span></div>` : ''}
          <div class="totals-row"><span>Swipe Charges</span><span id="pp-swipe-total">${fmt(0)}</span></div>
          <div class="totals-row"><span>Round Off</span><span id="pp-round-off-total">${fmt(0)}</span></div>
          <div class="totals-row grand"><span>Grand Total</span><span id="pp-grand">${fmt(0)}</span></div>
        </div>
      </div>
      <div class="bill-form-actions">
        <button class="btn btn-success" onclick="saveProjectPrintingInvoice()">Save Project Printing Invoice</button>
        <button class="btn btn-secondary" onclick="navigate('bills-list')">Cancel</button>
      </div>
    </div>`;
  renderProjectPrintRows();
  applyProjectPrintControlVisibility();
  recalcProjectPrinting();
  if (existingBill?.party_id) {
    const party = APP_STATE.parties.find(item => item.id == existingBill.party_id);
    if (party) selectParty(party.id);
  }
}

function renderProjectPrintRows() {
  const container = document.getElementById('pp-rows');
  if (!container) return;
  container.innerHTML = projectPrintRows.map((row, i) => `
    <div style="display:grid;grid-template-columns:32px 1fr 110px 110px 100px 110px 36px;gap:6px;margin-bottom:7px;align-items:center">
      <span>${i + 1}</span>
      <input id="pp-file-${i}" value="${esc(row.file_name)}" placeholder="File / project name">
      <input type="number" min="0" id="pp-bw-${i}" value="${row.bw_prints || 0}" oninput="recalcProjectPrinting()">
      <input type="number" min="0" id="pp-colour-${i}" value="${row.colour_prints || 0}" oninput="recalcProjectPrinting()">
      <input type="number" min="0" id="pp-books-${i}" value="${row.books || 0}" oninput="recalcProjectPrinting()">
      <input id="pp-amount-${i}" value="0.00" readonly>
      <button class="btn btn-xs btn-secondary" onclick="removeProjectPrintRow(${i})">x</button>
    </div>`).join('');
  applyProjectPrintControlVisibility();
}

function applyProjectPrintControlVisibility() {
  setInputGroupVisible('bf-party-search', txShow('PP', 'party'));
  setElementVisible(document.getElementById('pp-tax-inclusive')?.closest('label'), txShow('PP', 'tax_inclusive'));
  setElementVisible(document.getElementById('pp-round-off')?.closest('label'), txShow('PP', 'round_off'));
  setInputGroupVisible('pp-description', txShow('PP', 'footer'));
  setInputGroupVisible('pp-swipe', txShow('PP', 'payment_mode'));
  document.querySelectorAll('[id^="pp-amount-"]').forEach(el => setElementVisible(el, txShow('PP', 'amount')));
}

function addProjectPrintRow() {
  projectPrintRows.push(emptyProjectPrintRow());
  renderProjectPrintRows();
  recalcProjectPrinting();
}

function removeProjectPrintRow(index) {
  if (projectPrintRows.length === 1) return;
  projectPrintRows.splice(index, 1);
  renderProjectPrintRows();
  recalcProjectPrinting();
}

function collectProjectPrintRows() {
  return projectPrintRows.map((_, i) => ({
    file_name: document.getElementById(`pp-file-${i}`)?.value?.trim() || '',
    bw_prints: Number(document.getElementById(`pp-bw-${i}`)?.value || 0),
    colour_prints: Number(document.getElementById(`pp-colour-${i}`)?.value || 0),
    books: Number(document.getElementById(`pp-books-${i}`)?.value || 0)
  })).filter(row => row.file_name);
}

function recalcProjectPrinting() {
  const bwRate = Number(document.getElementById('pp-bw-rate')?.value || 0);
  const colourRate = Number(document.getElementById('pp-colour-rate')?.value || 0);
  const bookRate = Number(document.getElementById('pp-book-rate')?.value || 0);
  let subtotal = 0;
  projectPrintRows.forEach((_, i) => {
    const books = Number(document.getElementById(`pp-books-${i}`)?.value || 0);
    const amount = Number(document.getElementById(`pp-bw-${i}`)?.value || 0) * bwRate * books +
      Number(document.getElementById(`pp-colour-${i}`)?.value || 0) * colourRate * books +
      books * bookRate;
    const amountEl = document.getElementById(`pp-amount-${i}`);
    if (amountEl) amountEl.value = amount.toFixed(2);
    subtotal += amount;
  });
  for (let i = 0; i < 5; i++) subtotal += Number(document.getElementById(`pp-extra-${i}`)?.value || 0);
  const inclusive = Boolean(document.getElementById('pp-tax-inclusive')?.checked);
  const tax = APP_STATE.currentOrg.gst_type === 'regular'
    ? inclusive ? subtotal * 18 / 118 : subtotal * 0.18
    : 0;
  const swipe = Number(document.getElementById('pp-swipe')?.value || 0);
  const totalBeforeRound = subtotal + (inclusive ? 0 : tax) + swipe;
  const roundOff = document.getElementById('pp-round-off')?.checked
    ? Math.round(totalBeforeRound) - totalBeforeRound : 0;
  if (document.getElementById('pp-subtotal')) document.getElementById('pp-subtotal').textContent = fmt(subtotal);
  if (document.getElementById('pp-tax')) document.getElementById('pp-tax').textContent = fmt(tax);
  if (document.getElementById('pp-swipe-total')) document.getElementById('pp-swipe-total').textContent = fmt(swipe);
  if (document.getElementById('pp-round-off-total')) document.getElementById('pp-round-off-total').textContent = fmt(roundOff);
  if (document.getElementById('pp-grand')) {
    document.getElementById('pp-grand').textContent = fmt(totalBeforeRound + roundOff);
  }
}

async function refreshProjectPrintNumber() {
  if (APP_STATE.editingBill) return;
  try {
    const date = document.getElementById('pp-date').value;
    const result = await api('GET', `/bills/next-number?org_id=${APP_STATE.currentOrg.id}&format=PP&fy=${getFYForDate(date)}`);
    document.getElementById('pp-billno').value = result.number;
  } catch (_) {}
}

async function saveProjectPrintingInvoice() {
  const rows = collectProjectPrintRows();
  const partyId = document.getElementById('bf-party-id').value;
  const typedName = document.getElementById('bf-party-search').value.trim();
  if (txShow('PP', 'party') && !partyId) return toast(typedName ? 'Select or add the customer before saving' : 'Customer is required', 'error');
  if (!rows.length) return toast('Add at least one file', 'error');
  if (!requireVisibleFields('PP', [
    { field: 'party', label: 'Customer', valid: () => Boolean(partyId) },
    { field: 'amount', label: 'Amount', valid: () => rows.length > 0 },
    { field: 'footer', label: 'Description / Narration', valid: () => Boolean(document.getElementById('pp-description')?.value) }
  ])) return;
  const rates = {
    bw: Number(document.getElementById('pp-bw-rate').value || 0),
    colour: Number(document.getElementById('pp-colour-rate').value || 0),
    book: Number(document.getElementById('pp-book-rate').value || 0)
  };
  const items = rows.map(row => ({
    item_name: row.file_name, qty: 1, unit: 'JOB',
    rate: row.bw_prints * rates.bw * row.books + row.colour_prints * rates.colour * row.books + row.books * rates.book,
    amount: row.bw_prints * rates.bw * row.books + row.colour_prints * rates.colour * row.books + row.books * rates.book,
    gst_rate: APP_STATE.currentOrg.gst_type === 'regular' ? 18 : 0
  }));
  const optionalNames = ['Waste Prints', 'DTP', 'CD', 'Courier Charges',
    document.getElementById('pp-other-name').value.trim() || 'Others'];
  const optional = optionalNames.map((name, i) => ({
    name, amount: Number(document.getElementById(`pp-extra-${i}`).value || 0)
  })).filter(item => item.amount > 0);
  optional.forEach(item => items.push({
    item_name: item.name, qty: 1, unit: 'NOS', rate: item.amount, amount: item.amount,
    gst_rate: APP_STATE.currentOrg.gst_type === 'regular' ? 18 : 0
  }));
  try {
    const method = APP_STATE.editingBill ? 'PUT' : 'POST';
    const url = APP_STATE.editingBill ? `/bills/${APP_STATE.editingBill}` : '/bills';
    const result = await api(method, url, {
      org_id: APP_STATE.currentOrg.id, format: 'PP',
      bill_date: document.getElementById('pp-date').value,
      party_id: Number(partyId), payment_mode: 'cash',
      description: document.getElementById('pp-description').value,
      swipe_charge: Number(document.getElementById('pp-swipe').value || 0),
      tax_inclusive: Boolean(document.getElementById('pp-tax-inclusive')?.checked),
      round_off_enabled: Boolean(document.getElementById('pp-round-off')?.checked),
      items, custom_data: { project_printing: true, rates, rows, optional },
      emergency_reason: APP_STATE.emergencyEditReason || undefined
    });
    toast(result.offline_pending
      ? `Offline invoice ${result.bill.bill_number} saved. It will sync automatically.`
      : `Project Printing Invoice ${APP_STATE.editingBill ? 'updated' : 'saved'}`,
    result.offline_pending ? 'warning' : 'success');
    showStockWarnings(result.stock_warnings);
    APP_STATE.editingBill = null;
    APP_STATE.emergencyEditReason = '';
    showBillPreview(result.bill);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function refreshBillVoucherNumber(format) {
  if (APP_STATE.editingBill) return;
  const orgId = document.getElementById('voucher-org')?.value || APP_STATE.currentOrg.id;
  const date = document.getElementById('bf-date')?.value || today();
  try {
    const result = await api('GET', `/bills/next-number?org_id=${orgId}&format=${format}&fy=${getFYForDate(date)}`);
    document.getElementById('bf-billno').value = result.number;
  } catch (_) {}
}

let payMode = 'cash';
let taxInclusive = false;
let activeBillFormat = 'SALE';
function setPayMode(mode, btn) {
  payMode = mode;
  document.querySelectorAll('#bf-paymode .toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const panel = document.getElementById('bf-split-panel');
  if (panel) panel.style.display = mode === 'split' && txShow(activeBillFormat, 'split_payment') ? '' : 'none';
  updateBillSplitBalance();
}
function setTaxInclusive(val, btn) {
  taxInclusive = val;
  document.querySelectorAll('#bf-taxtype .toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const heading = document.getElementById('item-rate-heading');
  if (heading) heading.textContent = val ? 'Rate (Incl. GST)' : 'Rate (+ GST)';
  recalcTotals();
}

function emptyItem() {
  return { item_id: null, item_name: '', item_description: '', hsn_code: '',
    qty: '', unit: 'NOS', rate: '', amount: '', gst_rate: 18 };
}

function renderItemRows(isDC) {
  const container = document.getElementById('items-rows');
  if (!container) return;
  container.innerHTML = billItems.map((item, i) => renderItemRow(item, i, isDC)).join('');
  applyBillControlVisibility(activeBillFormat);
}

function setElementVisible(element, visible) {
  if (!element) return;
  element.style.display = visible ? '' : 'none';
}

function setInputGroupVisible(id, visible) {
  const input = document.getElementById(id);
  const group = input?.closest('.form-group') || input?.parentElement;
  setElementVisible(group, visible);
}

function applyBillControlVisibility(format) {
  if (!format) return;
  setInputGroupVisible('bf-party-search', txShow(format, 'party'));
  setInputGroupVisible('bf-delivery-addr', txShow(format, 'delivery_address'));
  setInputGroupVisible('bf-recipient-name', txShow(format, 'recipient'));
  setInputGroupVisible('bf-recipient-phone', txShow(format, 'recipient'));
  setInputGroupVisible('bf-transport-name', txShow(format, 'transport'));
  setInputGroupVisible('bf-tracking-id', txShow(format, 'tracking'));
  setInputGroupVisible('bf-dispatch-date', txShow(format, 'dispatch_date'));
  setInputGroupVisible('bf-pono', txShow(format, 'po_details'));
  setInputGroupVisible('bf-podate', txShow(format, 'po_details'));
  setInputGroupVisible('bf-discount', txShow(format, 'discount'));
  setInputGroupVisible('bf-description', txShow(format, 'footer'));
  setInputGroupVisible('bf-swipe-charge', txShow(format, 'payment_mode'));
  setElementVisible(document.getElementById('bf-paymode')?.closest('.form-group'), txShow(format, 'payment_mode'));
  setElementVisible(document.getElementById('bf-split-panel'), txShow(format, 'split_payment') && payMode === 'split');
  setElementVisible(document.getElementById('bf-taxtype')?.closest('.form-group'), txShow(format, 'tax_inclusive'));
  setElementVisible(document.getElementById('bf-digital-signature-required')?.closest('.security-setting-toggle'), txShow(format, 'digital_signature'));
  setInputGroupVisible('bf-digital-signature-note', txShow(format, 'digital_signature') && Boolean(document.getElementById('bf-digital-signature-required')?.checked));
  setElementVisible(document.getElementById('bf-round-off')?.closest('label'), txShow(format, 'round_off'));
  document.querySelectorAll('[id^="item-hsn-"]').forEach(el => setElementVisible(el, txShow(format, 'hsn')));
  document.querySelectorAll('[id^="item-description-"]').forEach(el => setElementVisible(el, txShow(format, 'item_description')));
  document.querySelectorAll('[id^="item-rate-"]').forEach(el => setElementVisible(el, format === 'DC' || txShow(format, 'rate')));
  document.querySelectorAll('[id^="item-amount-"]').forEach(el => setElementVisible(el, txShow(format, 'amount')));
  document.querySelectorAll('[id^="item-gst-"]').forEach(el => setElementVisible(el, txShow(format, 'gst_split')));
  const head = document.querySelector('.items-table-head');
  if (head) {
    const spans = [...head.children];
    if (spans[2]) setElementVisible(spans[2], txShow(format, 'hsn'));
    if (spans[5]) setElementVisible(spans[5], format === 'DC' || txShow(format, 'rate'));
    if (spans[6]) setElementVisible(spans[6], txShow(format, 'amount'));
    if (spans[7]) setElementVisible(spans[7], txShow(format, 'gst_split'));
  }
}

function renderItemRow(item, i, isDC) {
  const units = ['NOS','PCS','PKT','BOX','KG','MTR','SET','LTR','SQF','RMT'];
  const dc = isDC || document.querySelector('[id="items-rows"]')?.closest('.card')?.querySelector('.section-title')?.textContent?.includes('Delivery');
  return `
  <div class="item-row" id="item-row-${i}" style="grid-template-columns:${dc ? '32px 1fr 80px 70px 70px 90px 36px' : '32px 1fr 80px 70px 80px 90px 90px 70px 36px'}">
    <span class="sno">${i + 1}</span>
    <div class="autocomplete-wrap">
      <input type="text" placeholder="Item name" value="${esc(item.item_name||'')}"
        oninput="itemSearch(this.value,${i})" onblur="hideItemAC(${i})" autocomplete="off" id="item-name-${i}">
      <input type="text" class="item-line-description" placeholder="Description / serial number"
        value="${esc(item.item_description||'')}" id="item-description-${i}">
      <div id="item-ac-${i}" class="autocomplete-list" style="display:none"></div>
    </div>
    <input type="text" placeholder="HSN" value="${esc(item.hsn_code||'')}" id="item-hsn-${i}" style="text-align:center">
    <input type="number" placeholder="Qty" value="${item.qty||''}" id="item-qty-${i}"
      oninput="calcItemAmount(${i})" min="0" step="0.01">
    <select id="item-unit-${i}">
      ${units.map(u => `<option ${u === (item.unit||'NOS') ? 'selected' : ''}>${u}</option>`).join('')}
    </select>
    ${dc ? `
    <input type="number" placeholder="Rate" value="${item.rate||''}" id="item-rate-${i}"
      oninput="calcItemAmount(${i})" min="0" step="0.01">
    ` : `
    <input type="number" placeholder="Rate" value="${item.rate||''}" id="item-rate-${i}"
      oninput="calcItemAmount(${i})" min="0" step="0.01">
    <input type="number" placeholder="Amount" value="${item.amount||''}" id="item-amount-${i}"
      oninput="calcItemRate(${i})" min="0" step="0.01">
    <input type="number" placeholder="GST%" value="${item.gst_rate||18}" id="item-gst-${i}"
      oninput="recalcTotals()" min="0" max="28" step="0.01" style="text-align:center">`}
    <button class="btn btn-xs btn-danger" onclick="removeItemRow(${i})" style="padding:4px 8px">✕</button>
  </div>`;
}

function addItemRow() {
  billItems.push(emptyItem());
  const isDC = activeBillFormat === 'DC';
  const container = document.getElementById('items-rows');
  const div = document.createElement('div');
  div.innerHTML = renderItemRow(billItems[billItems.length - 1], billItems.length - 1, isDC);
  container.appendChild(div.firstElementChild);
  applyBillControlVisibility(activeBillFormat);
  document.getElementById(`item-name-${billItems.length-1}`)?.focus();
}

function removeItemRow(i) {
  billItems.splice(i, 1);
  const isDC = activeBillFormat === 'DC';
  renderItemRows(isDC);
  recalcTotals();
}

function calcItemAmount(i) {
  const qty = parseFloat(document.getElementById(`item-qty-${i}`)?.value) || 0;
  const rate = parseFloat(document.getElementById(`item-rate-${i}`)?.value) || 0;
  if (qty && rate) {
    const amtEl = document.getElementById(`item-amount-${i}`);
    if (amtEl) amtEl.value = (qty * rate).toFixed(2);
  }
  recalcTotals();
}

function calcItemRate(i) {
  const qty = parseFloat(document.getElementById(`item-qty-${i}`)?.value) || 0;
  const amount = parseFloat(document.getElementById(`item-amount-${i}`)?.value) || 0;
  if (qty && amount) {
    const rateEl = document.getElementById(`item-rate-${i}`);
    if (rateEl) rateEl.value = (amount / qty).toFixed(2);
  }
  recalcTotals();
}

function recalcTotals() {
  let subtotal = 0;
  const org = APP_STATE.currentOrg;
  const gstType = org?.gst_type || 'regular';
  const taxRate = gstType === 'regular' ? 18 : 0;

  // Sum all item amounts
  document.querySelectorAll('[id^="item-amount-"]').forEach(el => {
    subtotal += parseFloat(el.value) || 0;
  });
  // Also handle DC (no amount field, use qty*rate if any)
  if (!document.getElementById('item-amount-0')) {
    document.querySelectorAll('[id^="item-qty-"]').forEach((el, i) => {
      const qty = parseFloat(el.value) || 0;
      const rate = parseFloat(document.getElementById(`item-rate-${i}`)?.value) || 0;
      subtotal += qty * rate;
    });
  }

  const discount = parseFloat(document.getElementById('bf-discount')?.value) || 0;
  const grossBeforeTax = subtotal - discount;

  let cgst = 0, sgst = 0;
  const taxEl = document.getElementById('tot-tax');
  if (taxEl) {
    if (taxInclusive) {
      const tp = grossBeforeTax * taxRate / (100 + taxRate);
      cgst = tp / 2; sgst = tp / 2;
    } else {
      cgst = grossBeforeTax * (taxRate / 2) / 100;
      sgst = grossBeforeTax * (taxRate / 2) / 100;
    }
  }

  const totalTax = cgst + sgst;
  const taxable = taxInclusive ? grossBeforeTax - totalTax : grossBeforeTax;
  const swipeCharge = parseFloat(document.getElementById('bf-swipe-charge')?.value) || 0;
  const totalBeforeRound = grossBeforeTax + (taxEl && !taxInclusive ? totalTax : 0) + swipeCharge;
  const roundOff = document.getElementById('bf-round-off')?.checked
    ? Math.round(totalBeforeRound) - totalBeforeRound : 0;
  const grandTotal = totalBeforeRound + roundOff;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('tot-subtotal', fmt(subtotal));
  set('tot-taxable', fmt(taxable));
  set('tot-cgst', fmt(cgst));
  set('tot-sgst', fmt(sgst));
  set('tot-tax', fmt(totalTax));
  set('tot-swipe', fmt(swipeCharge));
  set('tot-roundoff', fmt(roundOff));
  set('tot-grand', fmt(grandTotal));
  const grand = document.getElementById('tot-grand');
  if (grand) grand.dataset.amount = String(grandTotal);
  const lbl = `(${taxRate/2}%)`;
  set('tot-cgst-label', `CGST ${lbl}`);
  set('tot-sgst-label', `SGST ${lbl}`);
  const wordsEl = document.getElementById('tot-words');
  if (wordsEl) wordsEl.textContent = numberToWords(grandTotal);
  updateBillSplitBalance();
}

function updateBillSplitBalance() {
  const output = document.getElementById('bf-split-balance');
  if (!output) return;
  const total = Number(document.getElementById('tot-grand')?.dataset.amount || 0);
  const entered = ['cash','bank','upi','card'].reduce((sum, mode) =>
    sum + Number(document.getElementById(`bf-split-${mode}`)?.value || 0), 0);
  output.textContent = `Split balance: ${fmt(total - entered)}`;
}

// Party search autocomplete
function partySearch(val) {
  const ac = document.getElementById('party-autocomplete');
  if (!val || val.length < 1) { ac.style.display = 'none'; return; }
  const matches = APP_STATE.parties.filter(p => p.name.toLowerCase().includes(val.toLowerCase())).slice(0, 8);
  const exactMatch = APP_STATE.parties.some(p => p.name.toLowerCase() === val.trim().toLowerCase());
  ac.innerHTML = matches.map(p => `
    <div class="autocomplete-item" onmousedown="selectParty(${p.id})">
      ${esc(p.name)}
      <div class="sub">${p.phone || ''} ${p.gstin ? '| GST: ' + p.gstin : ''}</div>
    </div>`).join('') + (!exactMatch ? `
    <div class="autocomplete-item" onmousedown="quickAddCustomer(decodeURIComponent('${encodeURIComponent(val.trim())}'))">
      <strong>+ Add New Customer: ${esc(val.trim())}</strong>
      <div class="sub">Create and select this customer</div>
    </div>` : '');
  ac.style.display = 'block';
}

function quickAddCustomer(name) {
  if (!name) return;
  document.getElementById('party-autocomplete').style.display = 'none';
  showPartyModal(null, { quickSelect: true, name, type: 'customer' });
}

function selectParty(id) {
  const p = APP_STATE.parties.find(x => x.id === id);
  if (!p) return;
  document.getElementById('bf-party-search').value = p.name;
  document.getElementById('bf-party-id').value = p.id;
  document.getElementById('party-autocomplete').style.display = 'none';
  const dscToggle = document.getElementById('bf-digital-signature-required');
  if (dscToggle) {
    dscToggle.checked = Boolean(Number(p.digital_signature_required || 0));
    const note = document.getElementById('bf-digital-signature-note');
    if (dscToggle.checked && note && !note.value) {
      note.value = 'Digital signature required before issue. Use the USB DSC token externally; Tarangini does not store DSC passwords.';
    }
    toggleBillDscNote();
  }
  showPartyDetails(p);
}

function toggleBillDscNote() {
  const checked = Boolean(document.getElementById('bf-digital-signature-required')?.checked);
  const wrap = document.getElementById('bf-digital-signature-note-wrap');
  if (wrap) wrap.style.display = checked ? '' : 'none';
}

function showPartyDetails(p) {
  const el = document.getElementById('party-details-display');
  if (!el) return;
  el.innerHTML = `<span style="color:var(--text2)">Address: ${esc(p.address||'')}${p.city ? ', '+esc(p.city) : ''}</span>
    ${p.gstin ? `<span style="margin-left:12px;color:var(--gold)">GST: ${esc(p.gstin)} (${p.gst_type||''})</span>` : ''}
    ${p.phone ? `<span style="margin-left:12px;color:var(--text3)">Phone: ${esc(p.phone)}</span>` : ''}
    ${p.email ? `<span style="margin-left:12px;color:var(--text3)">Email: ${esc(p.email)}</span>` : ''}`;
}

// Item search autocomplete
function itemSearch(val, rowIdx) {
  const ac = document.getElementById(`item-ac-${rowIdx}`);
  if (!val || val.length < 1) { ac.style.display = 'none'; return; }
  const matches = APP_STATE.items.filter(i => i.name.toLowerCase().includes(val.toLowerCase())).slice(0, 8);
  if (!matches.length) { ac.style.display = 'none'; return; }
  ac.innerHTML = matches.map(item => `
    <div class="autocomplete-item" onmousedown="selectItem(${item.id},${rowIdx})">
      ${esc(item.name)}
      <div class="sub">HSN: ${item.hsn_code||'—'} | ${item.unit} | Last Price: ${fmt(item.last_sale_price)}</div>
    </div>`).join('');
  ac.style.display = 'block';
}

function hideItemAC(i) { setTimeout(() => { const el = document.getElementById(`item-ac-${i}`); if (el) el.style.display = 'none'; }, 200); }

function selectItem(itemId, rowIdx) {
  const item = APP_STATE.items.find(i => i.id === itemId);
  if (!item) return;
  const nameEl = document.getElementById(`item-name-${rowIdx}`);
  const hsnEl = document.getElementById(`item-hsn-${rowIdx}`);
  const rateEl = document.getElementById(`item-rate-${rowIdx}`);
  const gstEl = document.getElementById(`item-gst-${rowIdx}`);
  const unitEl = document.getElementById(`item-unit-${rowIdx}`);
  if (nameEl) nameEl.value = item.name;
  if (hsnEl) hsnEl.value = item.hsn_code || '';
  if (rateEl) rateEl.value = item.last_sale_price || '';
  if (gstEl) gstEl.value = item.gst_rate || 18;
  if (unitEl) unitEl.value = item.unit || 'NOS';
  const descriptionEl = document.getElementById(`item-description-${rowIdx}`);
  if (descriptionEl && !descriptionEl.value) descriptionEl.value = item.description || '';
  // Store item_id in billItems
  if (!billItems[rowIdx]) billItems[rowIdx] = emptyItem();
  billItems[rowIdx].item_id = itemId;
  document.getElementById(`item-ac-${rowIdx}`).style.display = 'none';
  recalcTotals();
  // Auto focus qty
  document.getElementById(`item-qty-${rowIdx}`)?.focus();
}

function addItemFromMaster() {
  // Show a modal to pick from master list
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'item-master-modal';
  modal.innerHTML = `
    <div class="modal-box modal-medium">
      <div class="modal-header"><h3>Select Item from Master</h3>
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('item-master-modal').remove()">✕</button>
      </div>
      <div class="modal-body">
        <input type="text" placeholder="Search items..." oninput="filterMasterItems(this.value)" style="margin-bottom:12px">
        <div id="master-items-list" style="max-height:360px;overflow-y:auto">
          ${APP_STATE.items.map(item => `
            <div class="autocomplete-item" onclick="addMasterItem(${item.id})">
              <strong>${esc(item.name)}</strong>
              <div class="sub">HSN: ${item.hsn_code||'—'} | Unit: ${item.unit} | Last Price: ${fmt(item.last_sale_price)} | GST: ${item.gst_rate}%</div>
            </div>`).join('')}
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function filterMasterItems(val) {
  const items = APP_STATE.items.filter(i => !val || i.name.toLowerCase().includes(val.toLowerCase()));
  document.getElementById('master-items-list').innerHTML = items.map(item => `
    <div class="autocomplete-item" onclick="addMasterItem(${item.id})">
      <strong>${esc(item.name)}</strong>
      <div class="sub">HSN: ${item.hsn_code||'—'} | Unit: ${item.unit} | Last Price: ${fmt(item.last_sale_price)}</div>
    </div>`).join('');
}

function addMasterItem(itemId) {
  const item = APP_STATE.items.find(i => i.id === itemId);
  if (!item) return;
  const newItem = { item_id: item.id, item_name: item.name, item_description: item.description || '',
    hsn_code: item.hsn_code, qty: '', unit: item.unit, rate: item.last_sale_price,
    amount: '', gst_rate: item.gst_rate };
  billItems.push(newItem);
  renderItemRows(activeBillFormat === 'DC');
  recalcTotals();
  document.getElementById('item-master-modal')?.remove();
  // Focus on qty of new row
  setTimeout(() => document.getElementById(`item-qty-${billItems.length-1}`)?.focus(), 100);
}

function collectBillItems(isDC) {
  const rows = [];
  let i = 0;
  while (document.getElementById(`item-name-${i}`) !== null) {
    const name = document.getElementById(`item-name-${i}`)?.value?.trim();
    if (name) {
      const item = {
        item_id: billItems[i]?.item_id || null,
        item_name: name,
        item_description: document.getElementById(`item-description-${i}`)?.value?.trim() || '',
        hsn_code: document.getElementById(`item-hsn-${i}`)?.value || '',
        qty: parseFloat(document.getElementById(`item-qty-${i}`)?.value) || 0,
        unit: document.getElementById(`item-unit-${i}`)?.value || 'NOS',
      };
      if (isDC) {
        item.rate = parseFloat(document.getElementById(`item-rate-${i}`)?.value) || 0;
        item.amount = parseFloat((item.qty * item.rate).toFixed(2)) || 0;
      } else {
        item.rate = parseFloat(document.getElementById(`item-rate-${i}`)?.value) || 0;
        item.amount = parseFloat(document.getElementById(`item-amount-${i}`)?.value) || 0;
        item.gst_rate = parseFloat(document.getElementById(`item-gst-${i}`)?.value) || 18;
      }
      rows.push(item);
    }
    i++;
  }
  return rows;
}

async function saveBill(format) {
  const isDC = format === 'DC';
  const partyId = document.getElementById('bf-party-id')?.value;
  const typedPartyName = document.getElementById('bf-party-search')?.value?.trim();
  const items = collectBillItems(isDC);

  if (!items.length) { toast('Add at least one item', 'error'); return; }
  if (typedPartyName && !partyId) {
    toast('Select the customer or use Add New Customer before saving', 'error');
    document.getElementById('bf-party-search')?.focus();
    return;
  }
  if (!requireVisibleFields(format, [
    { field: 'party', label: 'Party / Customer', valid: () => Boolean(partyId) },
    { field: 'delivery_address', label: 'Delivery Address', valid: () => Boolean(document.getElementById('bf-delivery-addr')?.value) },
    { field: 'recipient', label: 'Recipient Name / Phone', valid: () => Boolean(document.getElementById('bf-recipient-name')?.value || document.getElementById('bf-recipient-phone')?.value) },
    { field: 'transport', label: 'Transport / Courier', valid: () => Boolean(document.getElementById('bf-transport-name')?.value) },
    { field: 'tracking', label: 'Tracking / LR', valid: () => Boolean(document.getElementById('bf-tracking-id')?.value) },
    { field: 'dispatch_date', label: 'Dispatch Date', valid: () => Boolean(document.getElementById('bf-dispatch-date')?.value) },
    { field: 'po_details', label: 'PO Number / Date', valid: () => Boolean(document.getElementById('bf-pono')?.value || document.getElementById('bf-podate')?.value) },
    { field: 'hsn', label: 'HSN Code', valid: () => items.some(item => item.hsn_code) },
    { field: 'item_description', label: 'Item Description / Serial', valid: () => items.some(item => item.item_description) },
    { field: 'qty_unit', label: 'Qty / Unit', valid: () => items.every(item => Number(item.qty || 0) > 0 && item.unit) },
    { field: 'rate', label: 'Rate', valid: () => isDC || items.every(item => Number(item.rate || 0) > 0) },
    { field: 'amount', label: 'Amount', valid: () => isDC || items.every(item => Number(item.amount || 0) > 0) },
    { field: 'payment_mode', label: 'Payment Mode', valid: () => Boolean(payMode) },
    { field: 'split_payment', label: 'Split Payment Details', valid: () => payMode !== 'split' || ['cash','bank','upi','card'].some(mode => Number(document.getElementById(`bf-split-${mode}`)?.value || 0) > 0) },
    { field: 'digital_signature', label: 'USB DSC Digital Signature', valid: () => Boolean(document.getElementById('bf-digital-signature-required')?.checked) }
  ])) return;

  const payload = {
    org_id: Number(document.getElementById('voucher-org')?.value || APP_STATE.currentOrg.id),
    format,
    bill_date: document.getElementById('bf-date')?.value || today(),
    party_id: partyId || null,
    po_number: document.getElementById('bf-pono')?.value || null,
    po_date: document.getElementById('bf-podate')?.value || null,
    credit_days: document.getElementById('bf-creditdays')?.value || null,
    payment_mode: payMode,
    delivery_address: document.getElementById('bf-delivery-addr')?.value || null,
    delivery_info: {
      recipient_name: document.getElementById('bf-recipient-name')?.value || '',
      recipient_phone: document.getElementById('bf-recipient-phone')?.value || '',
      transport_name: document.getElementById('bf-transport-name')?.value || '',
      tracking_id: document.getElementById('bf-tracking-id')?.value || '',
      dispatch_date: document.getElementById('bf-dispatch-date')?.value || ''
    },
    description: document.getElementById('bf-description')?.value || '',
    swipe_charge: parseFloat(document.getElementById('bf-swipe-charge')?.value) || 0,
    discount: parseFloat(document.getElementById('bf-discount')?.value) || 0,
    tax_inclusive: taxInclusive,
    round_off_enabled: Boolean(document.getElementById('bf-round-off')?.checked),
    digital_signature_required: Boolean(document.getElementById('bf-digital-signature-required')?.checked),
    digital_signature_note: document.getElementById('bf-digital-signature-note')?.value || '',
    items,
    emergency_reason: APP_STATE.emergencyEditReason || undefined
  };
  if (payMode === 'split') {
    payload.split_payments = ['cash','bank','upi','card'].map(mode => ({
      mode, amount: Number(document.getElementById(`bf-split-${mode}`)?.value || 0)
    })).filter(row => row.amount > 0);
    const splitTotal = payload.split_payments.reduce((sum, row) => sum + row.amount, 0);
    const billTotal = Number(document.getElementById('tot-grand')?.dataset.amount || 0);
    if (Math.abs(splitTotal - billTotal) > 0.02) {
      toast('Split payment amounts must equal the invoice total', 'error');
      return;
    }
  }

  try {
    let result;
    if (APP_STATE.editingBill) {
      result = await api('PUT', `/bills/${APP_STATE.editingBill}`, payload);
    } else {
      result = await api('POST', '/bills', payload);
    }
    toast(result.offline_pending
      ? `Offline invoice ${result.bill.bill_number} saved. It will sync automatically.`
      : `${format === 'SALE' ? 'Sale Bill' : format} saved!`,
    result.offline_pending ? 'warning' : 'success');
    showStockWarnings(result.stock_warnings);
    if (!result.offline_pending && format === 'SALE' && !APP_STATE.editingBill) {
      await offerLinkedBankReceipt(result.bill, payload);
    }
    showBillPreview(result.bill);
    APP_STATE.emergencyEditReason = '';
  } catch(e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function offerLinkedBankReceipt(bill, payload) {
  let bankAmount = 0;
  let mode = 'account';
  if (payload.payment_mode === 'split') {
    const nonCash = (payload.split_payments || []).filter(row => row.mode !== 'cash');
    bankAmount = nonCash.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    mode = nonCash.length === 1 ? nonCash[0].mode : 'account';
  } else if (payload.payment_mode !== 'cash' && payload.payment_mode !== 'credit') {
    bankAmount = Number(bill.grand_total || 0);
    mode = payload.payment_mode;
  }
  if (bankAmount <= 0) return;
  const received = window.confirm(
    `Bank / UPI / Card amount ${fmt(bankAmount)} selected.\n\nHas the customer completed this payment now?`
  );
  if (!received) {
    toast('Invoice saved as payment pending. Enter a linked receipt voucher when payment arrives.', 'warning');
    return;
  }
  const reference = window.prompt('Enter bank transaction / UPI / card reference number');
  if (!reference?.trim()) {
    toast('Receipt was not created. The invoice remains payment pending.', 'warning');
    return;
  }
  const receipt = await api('POST', '/payments', {
    org_id: bill.org_id,
    payment_date: bill.bill_date,
    party_id: bill.party_id || null,
    type: 'received',
    mode,
    amount: bankAmount,
    reference: reference.trim(),
    linked_bills: [{ bill_id: bill.id, amount: bankAmount }],
    shift_id: bill.shift_id || null,
    narration: `Immediate receipt against ${bill.bill_number}`
  });
  const settlement = receipt.settlements?.[0];
  if (settlement) Object.assign(bill, settlement);
  toast(`Linked receipt created: ${receipt.payment_number}`, 'success');
}

function showStockWarnings(warnings) {
  if (!warnings?.length) return;
  const items = warnings.map(item =>
    `${item.item_name}: ${fmtN(item.available)} available, ${fmtN(item.requested)} billed`
  ).join('; ');
  toast(`Bill saved with negative stock. ${items}`, 'warning');
}

// ── BILL PREVIEW ───────────────────────────────────────
function showBillPreview(bill) {
  APP_STATE.previewBill = bill;
  if (bill.format === 'PP') {
    showProjectPrintingPreview(bill);
    return;
  }
  const org = bill.org || APP_STATE.currentOrg;
  const party = bill.party || bill.party_data || (bill.party_snapshot ? JSON.parse(bill.party_snapshot) : null);
  const bank = bill.bank || (bill.bank_details ? JSON.parse(bill.bank_details) : {});
  const items = bill.items || [];
  let delivery = bill.delivery || {};
  try { if (!Object.keys(delivery).length) delivery = JSON.parse(bill.delivery_info || '{}'); } catch (_) {}
  let paymentSplit = [];
  try { paymentSplit = JSON.parse(bill.split_payments || '[]'); } catch (_) {}
  const ratesIncludeGST = Boolean(Number(bill.tax_inclusive || 0));
  const printOptions = invoicePrintOptions(org);
  const txType = bill.format === 'SALE' && bill.shift_id ? 'POS' : (bill.format || 'SALE');
  const printParty = txPrint(txType, 'party');
  const printGstin = txPrint(txType, 'gstin');
  const printBillingAddress = txPrint(txType, 'billing_address');

  const formatTitles = {
    SALE: org?.gst_type === 'composition' ? 'BILL OF SUPPLY' : 'TAX INVOICE',
    PP: 'PROJECT PRINTING INVOICE',
    QUOT: 'QUOTATION', DC: 'DELIVERY CHALLAN', PI: 'PROFORMA INVOICE',
    PR: 'PAYMENT RECEIPT', PV: 'PAYMENT VOUCHER'
  };

  const isDC = bill.format === 'DC';
  const showTax = !isDC && bill.format !== 'QUOT' && org?.gst_type === 'regular' && txPrint(txType, 'gst_split');
  const showHsn = showTax && printOptions.hsn && txPrint(txType, 'hsn');
  const showRate = !isDC && printOptions.rate && txPrint(txType, 'rate');
  const showQtyUnit = txPrint(txType, 'qty_unit');
  const showAmount = !isDC && txPrint(txType, 'amount');
  const showTaxInclusiveNote = ratesIncludeGST && showTax && printOptions.tax_inclusive_value && txPrint(txType, 'tax_inclusive');
  const itemColumnCount = 2 + (showHsn ? 1 : 0) + (showQtyUnit ? 2 : 0) + (showRate ? 1 : 0) + (showAmount ? 1 : 0);
  const subtotalColspan = showAmount ? itemColumnCount - 1 : itemColumnCount;

  // Build tax summary table from items
  const hsnMap = {};
  items.forEach(item => {
    const hsn = item.hsn_code || 'N/A';
    if (!hsnMap[hsn]) hsnMap[hsn] = { hsn, taxable: 0, gst_rate: item.gst_rate || 18 };
    const lineAmount = parseFloat(item.amount || 0);
    const rate = Number(item.gst_rate || 18);
    hsnMap[hsn].taxable += ratesIncludeGST && rate > 0
      ? lineAmount / (1 + rate / 100)
      : lineAmount;
  });

  const taxRows = Object.values(hsnMap).map(h => {
    const taxRate = h.gst_rate;
    const cgstRate = taxRate / 2;
    const cgst = h.taxable * cgstRate / 100;
    return `<tr>
      <td>${esc(h.hsn)}</td>
      <td class="right">${fmtN(h.taxable)}</td>
      <td class="center">${cgstRate}%</td>
      <td class="right">${fmtN(cgst)}</td>
      <td class="center">${cgstRate}%</td>
      <td class="right">${fmtN(cgst)}</td>
      <td class="right">${fmtN(cgst*2)}</td>
    </tr>`;
  }).join('');

  const html = `
  <div class="a4-page invoice-theme-${invoiceTheme(org)}" id="a4-content">
  <div class="invoice-page-content" id="invoice-page-content">
    <!-- HEADER -->
    <div class="invoice-header">
      ${txPrint(txType, 'company_logo') && org?.logo_base64 ? `<img src="${org.logo_base64}" class="invoice-logo">` : `<div class="invoice-logo-placeholder">LOGO</div>`}
      <div class="invoice-shop-details">
        <div class="invoice-shop-name">${esc(org?.display_name || '')}</div>
        <div class="invoice-shop-sub">
          ${org?.registered_name && org.registered_name !== org.display_name ? `Regd: ${esc(org.registered_name)}<br>` : ''}
          ${esc(org?.address || '')}<br>
          ${org?.phone ? `📞 ${esc(org.phone)}` : ''} ${org?.email ? `✉ ${esc(org.email)}` : ''}<br>
          ${printGstin && org?.gstin ? `GSTIN: <strong>${esc(org.gstin)}</strong>` : ''}
          ${org?.gst_type === 'composition' ? ' | <em>Composition Taxpayer</em>' : ''}
        </div>
      </div>
    </div>

    <div class="invoice-format-title">${formatTitles[bill.format] || bill.format}</div>
    ${printGstin && invoiceTheme(org) === 'common-gst' && org?.gst_type === 'regular' ? `
      <div class="common-gst-strip">
        <span><strong>GSTIN:</strong> ${esc(org.gstin || 'Not provided')}</span>
        <span><strong>Reverse Charge:</strong> No</span>
        <span><strong>Copy:</strong> Original for Recipient</span>
      </div>` : ''}

    <!-- META -->
    <div class="invoice-meta">
      <div class="invoice-meta-col">
        ${printParty ? `<div class="invoice-meta-label">Bill To</div>
        <div style="font-size:13px;font-weight:700">${esc(party?.name || party?.registered_name || 'Cash Customer')}</div>
        ${printBillingAddress ? `<div style="font-size:10px;color:#444;margin-top:3px">${esc(party?.address || '')}</div>` : ''}
        ${printGstin && party?.gstin ? `<div style="font-size:10px;margin-top:2px">GSTIN: <strong>${esc(party.gstin)}</strong> | ${esc(party.gst_type||'')}</div>` : ''}
        ${party?.phone ? `<div style="font-size:10px;color:#666">Phone: ${esc(party.phone)}</div>` : ''}
        ${party?.email ? `<div style="font-size:10px;color:#666">Email: ${esc(party.email)}</div>` : ''}` : ''}
        ${txPrint(txType, 'delivery_address') && bill.delivery_address ? `<div style="font-size:10px;color:#555;margin-top:5px"><strong>Delivery To:</strong><br>${esc(bill.delivery_address)}</div>` : ''}
        ${txPrint(txType, 'recipient') && delivery.recipient_name ? `<div style="font-size:10px">Recipient: ${esc(delivery.recipient_name)} ${delivery.recipient_phone ? `(${esc(delivery.recipient_phone)})` : ''}</div>` : ''}
      </div>
      <div class="invoice-meta-col">
        <div class="invoice-meta-row"><span>Bill No.</span><strong>${esc(bill.bill_number)}</strong></div>
        <div class="invoice-meta-row"><span>Date</span><strong>${fmtDate(bill.bill_date)}</strong></div>
        ${txPrint(txType, 'po_details') && bill.po_number ? `<div class="invoice-meta-row"><span>PO No.</span><span>${esc(bill.po_number)}</span></div>` : ''}
        ${txPrint(txType, 'po_details') && bill.po_date ? `<div class="invoice-meta-row"><span>PO Date</span><span>${fmtDate(bill.po_date)}</span></div>` : ''}
        ${bill.credit_days ? `<div class="invoice-meta-row"><span>Credit Days</span><span>${bill.credit_days} days</span></div>` : ''}
        ${txPrint(txType, 'payment_mode') && bill.format === 'SALE' ? `<div class="invoice-meta-row"><span>Payment</span><strong style="text-transform:uppercase">${bill.payment_mode||'Cash'}</strong></div>` : ''}
        ${txPrint(txType, 'transport') && delivery.transport_name ? `<div class="invoice-meta-row"><span>Transport</span><span>${esc(delivery.transport_name)}</span></div>` : ''}
        ${txPrint(txType, 'tracking') && delivery.tracking_id ? `<div class="invoice-meta-row"><span>Tracking / LR</span><span>${esc(delivery.tracking_id)}</span></div>` : ''}
        ${txPrint(txType, 'dispatch_date') && delivery.dispatch_date ? `<div class="invoice-meta-row"><span>Dispatch Date</span><span>${fmtDate(delivery.dispatch_date)}</span></div>` : ''}
      </div>
    </div>

    <!-- NOTE HEADER -->
    ${bill.note_header ? `<div class="invoice-note">📝 ${esc(bill.note_header)}</div>` : ''}

    <!-- ITEMS TABLE -->
    <table class="invoice-items-table">
      <thead>
        <tr>
          <th style="width:28px">#</th>
          <th>Description</th>
          ${showHsn ? '<th style="width:55px">HSN</th>' : ''}
          ${showQtyUnit ? '<th style="width:45px" class="center">Qty</th><th style="width:35px" class="center">Unit</th>' : ''}
          ${!isDC ? `${showRate ? `<th style="width:76px" class="right">Rate${showTaxInclusiveNote ? '<br>(Incl. GST)' : ''}</th>` : ''}${showAmount ? '<th style="width:70px" class="right">Amount</th>' : ''}` : ''}
        </tr>
      </thead>
      <tbody>
        ${items.map((item, i) => `
          <tr>
            <td class="center">${i + 1}</td>
            <td>${esc(item.item_name)}
              ${txPrint(txType, 'item_description') && item.item_description ? `<div style="font-size:9px;color:#555;margin-top:2px">${esc(item.item_description)}</div>` : ''}</td>
            ${showHsn ? `<td class="center" style="font-size:9px">${esc(item.hsn_code||'')}</td>` : ''}
            ${showQtyUnit ? `<td class="center">${fmtN(item.qty)}</td><td class="center">${esc(item.unit||'NOS')}</td>` : ''}
            ${!isDC ? `${showRate ? `<td class="right">${fmtN(item.rate)}</td>` : ''}${showAmount ? `<td class="right"><strong>${fmtN(item.amount)}</strong></td>` : ''}` : ''}
          </tr>`).join('')}
        ${!isDC ? `<tr style="background:#f9f9f9">
          <td colspan="${subtotalColspan}" style="text-align:right;font-weight:600">Subtotal</td>
          ${showAmount ? `<td class="right"><strong>${fmtN(bill.subtotal)}</strong></td>` : ''}
        </tr>` : `<tr><td colspan="${showQtyUnit ? itemColumnCount - 1 : itemColumnCount}" style="text-align:right;font-weight:600">Total Items</td>${showQtyUnit ? `<td class="center"><strong>${items.length}</strong></td>` : ''}</tr>`}
      </tbody>
    </table>
    ${showTaxInclusiveNote ? `<div class="invoice-tax-mode-note">Item rates and amounts shown above are inclusive of GST.</div>` : ''}

    ${showTax && showHsn && taxRows ? `
    <!-- TAX TABLE -->
    <table class="invoice-tax-table">
      <thead><tr><th>HSN</th><th>Taxable Amt</th><th>CGST %</th><th>CGST ₹</th><th>SGST %</th><th>SGST ₹</th><th>Total Tax</th></tr></thead>
      <tbody>${taxRows}</tbody>
    </table>` : ''}

    ${!isDC ? `
    <!-- TOTALS -->
    <div class="invoice-totals">
      <div class="invoice-totals-box">
        ${txPrint(txType, 'discount') && bill.discount > 0 ? `<div class="invoice-total-row"><span>Discount</span><span>- ${fmtN(bill.discount)}</span></div>` : ''}
        ${showTax ? `
        <div class="invoice-total-row"><span>Taxable Amount</span><span>${fmtN(bill.taxable_amount)}</span></div>
        <div class="invoice-total-row"><span>CGST</span><span>${fmtN(bill.cgst)}</span></div>
        <div class="invoice-total-row"><span>SGST</span><span>${fmtN(bill.sgst)}</span></div>` : ''}
        ${Number(bill.swipe_charge || 0) > 0 ? `<div class="invoice-total-row"><span>Swipe Charges</span><span>${fmtN(bill.swipe_charge)}</span></div>` : ''}
        ${txPrint(txType, 'round_off') && Math.abs(Number(bill.round_off || 0)) > 0.001 ? `<div class="invoice-total-row"><span>Round Off</span><span>${fmtN(bill.round_off)}</span></div>` : ''}
        <div class="invoice-total-row grand"><span>TOTAL</span><span>₹ ${fmtN(bill.grand_total)}</span></div>
        ${txPrint(txType, 'split_payment') && paymentSplit.length ? paymentSplit.map(row =>
          `<div class="invoice-total-row"><span>${esc(String(row.mode).toUpperCase())}</span><span>${fmtN(row.amount)}</span></div>`
        ).join('') : ''}
        ${bill.payment_status ? `<div class="invoice-total-row"><span>Payment Status</span><strong>${esc(bill.payment_status.toUpperCase())}</strong></div>` : ''}
      </div>
    </div>

    <!-- AMOUNT IN WORDS -->
    <div class="invoice-words">Amount in Words: <strong>${esc(bill.total_in_words || '')}</strong></div>` : ''}

    <!-- NOTE FOOTER -->
    ${txPrint(txType, 'footer') && bill.note_footer ? `<div class="invoice-note">${esc(bill.note_footer)}</div>` : ''}
    ${txPrint(txType, 'footer') && bill.description ? `<div class="invoice-note"><strong>Description:</strong> ${esc(bill.description)}</div>` : ''}
    ${txPrint(txType, 'operator') && (bill.created_by_name || bill.created_by_username) ? `<div class="invoice-note"><strong>Prepared By:</strong> ${esc(bill.created_by_name || bill.created_by_username)}</div>` : ''}
    ${txPrint(txType, 'digital_signature') && Number(bill.digital_signature_required || 0) ? `<div class="invoice-note"><strong>Digital Signature:</strong> ${esc(bill.digital_signature_note || 'Digital signature required before issue. Use the USB DSC token externally; Tarangini does not store DSC passwords.')}</div>` : ''}

    <!-- FOOTER: BANK + SIGNATURE -->
    <div class="invoice-footer">
      <div class="invoice-bank">
        ${printOptions.bank_details && txPrint(txType, 'bank_details') && (bank?.bank_name || bank?.account_no) ? `
        <div class="invoice-bank-title">Bank Details</div>
        ${bank.bank_name ? `Bank: ${esc(bank.bank_name)}<br>` : ''}
        ${bank.account_no ? `A/C No: ${esc(bank.account_no)}<br>` : ''}
        ${bank.branch ? `Branch: ${esc(bank.branch)}<br>` : ''}
        ${bank.ifsc ? `IFSC: ${esc(bank.ifsc)}<br>` : ''}
        ${bank.upi_id ? `UPI: ${esc(bank.upi_id)}` : ''}` : ''}
      </div>
      <div class="invoice-sign">
        <div>For <strong>${esc(org?.signature_name || org?.display_name || '')}</strong></div>
        ${txPrint(txType, 'signature_image') && org?.signature_image ? `<img src="${org.signature_image}" style="max-width:120px;max-height:55px;object-fit:contain">` : ''}
        <div class="invoice-sign-line">Authorised Signatory</div>
      </div>
    </div>
    ${txPrint(txType, 'qr_code') && org?.invoice_qr_enabled !== 0 ? `<div style="display:flex;justify-content:flex-end;margin-top:6px">
      <img id="invoice-qr-image" alt="Invoice QR" style="width:76px;height:76px"></div>` : ''}

    ${bill.format === 'DC' ? `<div class="invoice-note" style="margin-top:8px">
      <strong>Note:</strong> This is a Delivery Challan only. No tax is charged on this document.
      Goods are dispatched subject to return/acceptance.
    </div>` : ''}
    ${org?.gst_type === 'composition' ? `<div class="invoice-note">
      <strong>Note:</strong> We are a Composition Taxpayer as per Section 10 of CGST Act, 2017.
      We are not eligible to collect tax on supplies.
    </div>` : ''}
  </div>
  </div>`;

  document.getElementById('preview-content').innerHTML = html;
  document.getElementById('preview-title').textContent = `${formatTitles[bill.format] || 'Bill'} — ${bill.bill_number}`;
  document.getElementById('preview-modal').style.display = 'flex';
  addInvoiceShareAction(bill);
  if (org?.invoice_qr_enabled !== 0) loadInvoiceQR(bill.id);
  requestAnimationFrame(fitInvoiceToA4);

  // Show linked workflow actions without changing the existing print layout.
  if (['QUOT','DC','PI'].includes(bill.format) && bill.status !== 'converted') {
    const hdr = document.querySelector('#preview-modal .modal-header');
    if (['QUOT','SALE','PI'].includes(bill.format)) {
      const dcBtn = document.createElement('button');
      dcBtn.className = 'btn btn-secondary';
      dcBtn.textContent = 'Create DC';
      dcBtn.onclick = () => deriveBill(bill.id, 'DC');
      hdr.insertBefore(dcBtn, hdr.children[1]);
    }
    const invoiceBtn = document.createElement('button');
    invoiceBtn.className = 'btn btn-primary';
    invoiceBtn.textContent = 'Create Invoice';
    invoiceBtn.onclick = () => deriveBill(bill.id, 'SALE');
    hdr.insertBefore(invoiceBtn, hdr.children[1]);
    const convertBtn = document.createElement('button');
    convertBtn.className = 'btn btn-gold';
    convertBtn.innerHTML = '🔄 Convert to Sale Bill';
    convertBtn.onclick = () => convertToSale(bill.id);
    hdr.insertBefore(convertBtn, hdr.children[1]);
  }
  if (Array.isArray(bill.linked_documents) && bill.linked_documents.length) {
    const hdr = document.querySelector('#preview-modal .modal-header');
    const linked = document.createElement('span');
    linked.className = 'badge badge-saved';
    linked.style.marginLeft = '8px';
    linked.textContent = `${bill.linked_documents.length} linked document(s)`;
    hdr.appendChild(linked);
  }
}

function showProjectPrintingPreview(bill) {
  const org = bill.org || APP_STATE.currentOrg;
  const party = bill.party || bill.party_data || (bill.party_snapshot ? JSON.parse(bill.party_snapshot) : null);
  const bank = bill.bank || (bill.bank_details ? JSON.parse(bill.bank_details) : {});
  const custom = typeof bill.custom_data === 'string' ? JSON.parse(bill.custom_data || '{}') : (bill.custom_data || {});
  const rows = custom.rows || [];
  const optional = custom.optional || [];
  const bookRate = Number(custom.rates?.book || 0);
  const txType = 'PP';
  const printOptions = invoicePrintOptions(org);
  const printGstin = txPrint(txType, 'gstin');
  const showTax = org?.gst_type === 'regular' && txPrint(txType, 'gst_split');
  const showQtyUnit = txPrint(txType, 'qty_unit');
  const showRate = printOptions.rate && txPrint(txType, 'rate');
  const showAmount = txPrint(txType, 'amount');
  const showTaxInclusiveNote = Number(bill.tax_inclusive || 0) && showTax && printOptions.tax_inclusive_value && txPrint(txType, 'tax_inclusive');
  const projectColumnCount = 2 + (showQtyUnit ? 3 : 0) + (showRate ? 1 : 0) + (showAmount ? 1 : 0);
  const optionalColspan = Math.max(1, showAmount ? projectColumnCount - 2 : projectColumnCount - 1);
  document.getElementById('preview-content').innerHTML = `
    <div class="a4-page invoice-theme-${invoiceTheme(org)}" id="a4-content"><div class="invoice-page-content" id="invoice-page-content">
      <div class="invoice-header">
        ${txPrint(txType, 'company_logo') && org?.logo_base64 ? `<img src="${org.logo_base64}" class="invoice-logo">` : `<div class="invoice-logo-placeholder">LOGO</div>`}
        <div class="invoice-shop-details">
          <div class="invoice-shop-name">${esc(org?.display_name || '')}</div>
          <div class="invoice-shop-sub">${esc(org?.address || '')}<br>
            ${org?.phone ? esc(org.phone) : ''} ${org?.email ? ` | ${esc(org.email)}` : ''}
            ${printGstin && org?.gstin ? `<br>GSTIN: <strong>${esc(org.gstin)}</strong>` : ''}
          </div>
        </div>
      </div>
      <div class="invoice-format-title">PROJECT PRINTING INVOICE</div>
      <div class="invoice-meta">
        <div class="invoice-meta-col">
          ${txPrint(txType, 'party') ? `<div class="invoice-meta-label">Customer</div>
          <div style="font-size:13px;font-weight:700">${esc(party?.name || 'Cash Customer')}</div>
          ${txPrint(txType, 'billing_address') ? `<div style="font-size:10px">${esc(party?.address || '')}</div>` : ''}
          ${party?.phone ? `<div style="font-size:10px">Phone: ${esc(party.phone)}</div>` : ''}
          ${party?.email ? `<div style="font-size:10px">Email: ${esc(party.email)}</div>` : ''}` : ''}
        </div>
        <div class="invoice-meta-col">
          <div class="invoice-meta-row"><span>Invoice No.</span><strong>${esc(bill.bill_number)}</strong></div>
          <div class="invoice-meta-row"><span>Date</span><strong>${fmtDate(bill.bill_date)}</strong></div>
        </div>
      </div>
      ${bill.note_header ? `<div class="invoice-note">${esc(bill.note_header)}</div>` : ''}
      <table class="invoice-items-table">
        <thead><tr><th style="width:28px">#</th><th>File Name</th>
          ${showQtyUnit ? '<th class="center">B/W Print</th><th class="center">Colour Print</th><th class="center">No. of Books</th>' : ''}
          ${showRate ? '<th class="right">Each Book Cost</th>' : ''}${showAmount ? '<th class="right">Amount</th>' : ''}</tr></thead>
        <tbody>
          ${rows.map((row, i) => {
            const amount = Number(row.bw_prints || 0) * Number(custom.rates?.bw || 0) +
              Number(row.colour_prints || 0) * Number(custom.rates?.colour || 0) +
              Number(row.books || 0) * bookRate;
            return `<tr><td class="center">${i + 1}</td><td>${esc(row.file_name)}</td>
              ${showQtyUnit ? `<td class="center">${Number(row.bw_prints || 0)}</td><td class="center">${Number(row.colour_prints || 0)}</td>
              <td class="center">${Number(row.books || 0)}</td>` : ''}${showRate ? `<td class="right">${fmtN(bookRate)}</td>` : ''}
              ${showAmount ? `<td class="right"><strong>${fmtN(amount)}</strong></td>` : ''}</tr>`;
          }).join('')}
          ${optional.map((item, i) => `<tr><td class="center">${rows.length + i + 1}</td>
            <td colspan="${optionalColspan}">${esc(item.name)}</td>${showAmount ? `<td class="right"><strong>${fmtN(item.amount)}</strong></td>` : ''}</tr>`).join('')}
        </tbody>
      </table>
      ${showTaxInclusiveNote
        ? `<div class="invoice-tax-mode-note">Project printing rates shown above are inclusive of GST.</div>` : ''}
      <div class="invoice-totals"><div class="invoice-totals-box">
        ${showAmount ? `<div class="invoice-total-row"><span>Subtotal</span><span>${fmtN(bill.subtotal)}</span></div>` : ''}
        ${showTax ? `<div class="invoice-total-row"><span>CGST</span><span>${fmtN(bill.cgst)}</span></div>
          <div class="invoice-total-row"><span>SGST</span><span>${fmtN(bill.sgst)}</span></div>` : ''}
        ${Number(bill.swipe_charge || 0) > 0 ? `<div class="invoice-total-row"><span>Swipe Charges</span><span>${fmtN(bill.swipe_charge)}</span></div>` : ''}
        ${txPrint(txType, 'round_off') && Math.abs(Number(bill.round_off || 0)) > 0.001 ? `<div class="invoice-total-row"><span>Round Off</span><span>${fmtN(bill.round_off)}</span></div>` : ''}
        <div class="invoice-total-row grand"><span>TOTAL</span><span>₹ ${fmtN(bill.grand_total)}</span></div>
      </div></div>
      <div class="invoice-words">Amount in Words: <strong>${esc(bill.total_in_words || '')}</strong></div>
      ${txPrint(txType, 'footer') && bill.note_footer ? `<div class="invoice-note">${esc(bill.note_footer)}</div>` : ''}
      ${txPrint(txType, 'footer') && bill.description ? `<div class="invoice-note"><strong>Description:</strong> ${esc(bill.description)}</div>` : ''}
      ${txPrint(txType, 'operator') && (bill.created_by_name || bill.created_by_username) ? `<div class="invoice-note"><strong>Prepared By:</strong> ${esc(bill.created_by_name || bill.created_by_username)}</div>` : ''}
      <div class="invoice-footer">
        <div class="invoice-bank">${printOptions.bank_details && txPrint(txType, 'bank_details') && (bank?.bank_name || bank?.account_no) ? `
          <div class="invoice-bank-title">Bank Details</div>
          ${bank.bank_name ? `Bank: ${esc(bank.bank_name)}<br>` : ''}
          ${bank.account_no ? `A/C No: ${esc(bank.account_no)}<br>` : ''}
          ${bank.ifsc ? `IFSC: ${esc(bank.ifsc)}<br>` : ''}` : ''}</div>
        <div class="invoice-sign"><div>For <strong>${esc(org?.signature_name || org?.display_name || '')}</strong></div>
          ${txPrint(txType, 'signature_image') && org?.signature_image ? `<img src="${org.signature_image}" style="max-width:120px;max-height:55px;object-fit:contain">` : ''}
          <div class="invoice-sign-line">Authorised Signatory</div></div>
      </div>
      ${txPrint(txType, 'qr_code') && org?.invoice_qr_enabled !== 0 ? `<div style="display:flex;justify-content:flex-end"><img id="invoice-qr-image" alt="Invoice QR" style="width:76px;height:76px"></div>` : ''}
      ${org?.gst_type === 'composition' ? `<div class="invoice-note"><strong>Bill of Supply:</strong>
        Composition taxable person, not eligible to collect GST.</div>` : ''}
    </div></div>`;
  document.getElementById('preview-title').textContent = `Project Printing Invoice - ${bill.bill_number}`;
  document.getElementById('preview-modal').style.display = 'flex';
  addInvoiceShareAction(bill);
  if (org?.invoice_qr_enabled !== 0) loadInvoiceQR(bill.id);
  requestAnimationFrame(fitInvoiceToA4);
}

function addInvoiceShareAction(bill) {
  document.getElementById('preview-whatsapp-action')?.remove();
  const header = document.querySelector('#preview-modal .modal-header');
  if (!header) return;
  const button = document.createElement('button');
  button.id = 'preview-whatsapp-action';
  button.className = 'btn btn-success';
  button.textContent = 'Send WhatsApp Reminder';
  button.onclick = () => whatsappInvoice(bill);
  header.insertBefore(button, header.children[1]);
}

function closePreview() {
  document.getElementById('preview-modal').style.display = 'none';
  APP_STATE.previewBill = null;
}

function fitInvoiceToA4() {
  const page = document.getElementById('a4-content');
  const content = document.getElementById('invoice-page-content');
  if (!page || !content) return;
  content.style.zoom = '1';
  const availableHeight = page.clientHeight - 76;
  const availableWidth = page.clientWidth - 76;
  const heightScale = availableHeight / Math.max(content.scrollHeight, 1);
  const widthScale = availableWidth / Math.max(content.scrollWidth, 1);
  const scale = Math.min(1, heightScale, widthScale);
  content.style.zoom = String(Math.max(0.25, scale));
  page.dataset.invoiceScale = scale.toFixed(3);
}

function printBill() {
  fitInvoiceToA4();
  window.print();
}

function downloadBillPDF() {
  toast('Use browser Print → Save as PDF for best results', 'info');
  fitInvoiceToA4();
  window.print();
}

async function convertToSale(billId) {
  const ok = await showConfirm('Convert to Sale Bill', 'This will create a new Sale Bill from this document. Continue?', 'Convert', false);
  if (!ok) return;
  try {
    const result = await api('POST', `/bills/${billId}/convert`);
    toast('Converted to Sale Bill!', 'success');
    closePreview();
    showBillPreview(result.bill);
  } catch(e) { toast(e.message, 'error'); }
}

// ── BILLS LIST ─────────────────────────────────────────
async function renderBillsList() {
  if (!APP_STATE.currentOrg) return;
  showLoading();

  document.getElementById('topbar-actions').innerHTML = `
    <button class="btn btn-primary btn-sm" onclick="navigate('sale')">+ Sale Bill</button>`;

  try {
    const bills = await api('GET', `/bills?org_id=${APP_STATE.currentOrg.id}&fy=${APP_STATE.currentFY}`);
    const formatLabels = { SALE:'Sale', PP:'Project Printing', QUOT:'Quotation', DC:'Challan', PI:'Proforma', PR:'Payment Rcvd', PV:'Pay Voucher' };

    document.getElementById('content').innerHTML = `
    <div class="page-header">
      <h2>All Bills — ${APP_STATE.currentFY}</h2>
    </div>
    <div class="search-bar">
      <div class="search-input">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="Search bill no, party..." oninput="filterBills(this.value,'${APP_STATE.currentOrg.id}','${APP_STATE.currentFY}')">
      </div>
      <select onchange="filterBillsByFormat(this.value)" id="format-filter">
        <option value="">All Formats</option>
        <option value="SALE">Sale Bills</option>
        <option value="QUOT">Quotations</option>
        <option value="DC">Delivery Challans</option>
        <option value="PI">Proforma</option>
      </select>
    </div>
    <div class="table-wrap" id="bills-table-wrap">
      <table>
        <thead><tr><th>Bill No.</th><th>Date</th><th>Party</th><th>Created By</th><th>Format</th><th>Amount</th><th>Mode</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody id="bills-tbody">
          ${bills.length ? bills.map(b => billRow(b, formatLabels)).join('') :
            '<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--text3)">No bills found</td></tr>'}
        </tbody>
      </table>
    </div>`;
  } catch(e) {
    document.getElementById('content').innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`;
  }
}

function billRow(b, formatLabels) {
  const fl = formatLabels || { SALE:'Sale', QUOT:'Quotation', DC:'Challan', PI:'Proforma' };
  return `<tr>
    <td class="mono">${esc(b.bill_number)}</td>
    <td>${fmtDate(b.bill_date)}</td>
    <td>${esc(b.party_name || 'Cash')}</td>
    <td>${esc(b.created_by_name || b.created_by_username || '-')}</td>
    <td><span class="badge badge-saved">${fl[b.format] || b.format}</span></td>
    <td class="amount">${fmt(b.grand_total)}</td>
    <td><span class="badge badge-${b.payment_mode}">${b.payment_mode||'cash'}</span></td>
    <td><span class="badge badge-${b.status}">${b.status}</span></td>
    <td>
      <button class="btn btn-xs btn-outline" onclick="showDuplicateVoucher('bill',${b.id},'bills-list')">Duplicate</button>
      <button class="btn btn-xs btn-secondary" onclick="previewBillById(${b.id})">👁 View</button>
      <button class="btn btn-xs btn-outline" onclick="editBill(${b.id},'${b.format}')">✏ Edit</button>
      ${['QUOT','SALE','PI'].includes(b.format) ? `<button class="btn btn-xs btn-outline" onclick="deriveBill(${b.id},'DC')">Create DC</button>` : ''}
      ${['QUOT','DC','PI'].includes(b.format) ? `<button class="btn btn-xs btn-primary" onclick="deriveBill(${b.id},'SALE')">Invoice</button>` : ''}
      ${['SALE','PP'].includes(b.format) ? `<button class="btn btn-xs btn-outline" onclick="requestInvoiceCorrection(${b.id})">Correction</button>` : ''}
      ${APP_STATE.user.role === 'owner' ? `<button class="btn btn-xs btn-danger" onclick="deleteBill(${b.id})">🗑</button>` : ''}
    </td>
  </tr>`;
}

function showDuplicateVoucher(type, id, returnPage) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'duplicate-voucher-modal';
  modal.innerHTML = `<div class="modal-box modal-small">
    <div class="modal-header"><h3>Duplicate Voucher</h3>
      <button class="btn btn-secondary btn-sm" onclick="this.closest('.modal-overlay').remove()">Close</button></div>
    <div class="form-group"><label>New Voucher Company</label>
      <select id="duplicate-org">${voucherCompanyOptions(APP_STATE.currentOrg.id)}</select></div>
    <div class="form-group"><label>New Voucher Date</label>
      <input type="date" id="duplicate-date" value="${today()}"></div>
    <p style="font-size:12px;color:var(--text2)">The original remains unchanged. A new voucher number is generated automatically.</p>
    <button class="btn btn-success" onclick="duplicateVoucher('${type}',${id},'${returnPage}')">Create Duplicate</button>
  </div>`;
  document.body.appendChild(modal);
}

async function duplicateVoucher(type, id, returnPage) {
  try {
    const result = await api('POST', '/advanced/duplicate', {
      type, id, org_id: Number(document.getElementById('duplicate-org').value),
      date: document.getElementById('duplicate-date').value
    });
    document.getElementById('duplicate-voucher-modal')?.remove();
    toast(`Duplicate created: ${result.number}`, 'success');
    if (returnPage) await navigate(returnPage);
  } catch (error) { toast(error.message, 'error'); }
}

async function filterBills(val, orgId, fy) {
  try {
    const bills = await api('GET', `/bills?org_id=${orgId}&fy=${fy}&search=${encodeURIComponent(val)}`);
    const formatLabels = { SALE:'Sale', QUOT:'Quotation', DC:'Challan', PI:'Proforma' };
    document.getElementById('bills-tbody').innerHTML = bills.length ?
      bills.map(b => billRow(b, formatLabels)).join('') :
      '<tr><td colspan="9" style="text-align:center;padding:20px;color:var(--text3)">No bills found</td></tr>';
  } catch(e) {}
}

async function filterBillsByFormat(format) {
  try {
    const bills = await api('GET', `/bills?org_id=${APP_STATE.currentOrg.id}&fy=${APP_STATE.currentFY}${format ? '&format='+format : ''}`);
    const formatLabels = { SALE:'Sale', QUOT:'Quotation', DC:'Challan', PI:'Proforma' };
    document.getElementById('bills-tbody').innerHTML = bills.length ?
      bills.map(b => billRow(b, formatLabels)).join('') :
      '<tr><td colspan="9" style="text-align:center;padding:20px;color:var(--text3)">No bills found</td></tr>';
  } catch(e) {}
}

async function previewBillById(id) {
  try {
    const bill = await api('GET', `/bills/${id}/full`);
    showBillPreview(bill);
  } catch(e) { toast(e.message, 'error'); }
}

async function editBill(id, format) {
  try {
    const bill = await api('GET', `/bills/${id}/full`);
    APP_STATE.emergencyEditReason = '';
    if (bill.offline_id) {
      if (String(APP_STATE.user?.username || '').toLowerCase() !== 'owner1') {
        throw new Error('Only Owner1 can emergency-edit a synchronized offline invoice');
      }
      const reason = window.prompt(
        `Emergency Edit: ${bill.bill_number}\nEnter the correction reason. This will be permanently recorded in the audit log.`
      );
      if (reason === null) return;
      if (reason.trim().length < 5) {
        throw new Error('Enter an emergency correction reason of at least 5 characters');
      }
      APP_STATE.emergencyEditReason = reason.trim();
    }
    billFormData = bill;
    const fmtMap = { SALE:'sale', PP:'project-printing', QUOT:'quotation', DC:'challan', PI:'proforma' };
    await navigate(fmtMap[format] || 'sale');
    APP_STATE.editingBill = id;
    if (format === 'PP') await renderProjectPrintingInvoice(bill);
    else await renderBillForm(format, bill);
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteBill(id) {
  const ok = await showConfirm('Delete Bill', 'This action cannot be undone. The bill will be cancelled.', 'Delete');
  if (!ok) return;
  try {
    await api('DELETE', `/bills/${id}`);
    toast('Bill deleted', 'success');
    renderBillsList();
  } catch(e) { toast(e.message, 'error'); }
}

async function requestInvoiceCorrection(id) {
  try {
    const bill = await api('GET', `/bills/${id}`);
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'correction-request-modal';
    modal.innerHTML = `<div class="modal-box modal-large">
      <div class="modal-header"><h3>Request Correction: ${esc(bill.bill_number)}</h3>
        <button class="btn btn-secondary btn-sm" onclick="this.closest('.modal-overlay').remove()">Close</button></div>
      <div class="modal-body">
        <p class="security-setting-note">Enter the corrected quantity for each row. Owner approval creates a linked Credit Note; the original invoice remains unchanged.</p>
        <div class="table-wrap"><table><thead><tr><th>Item</th><th>Description / Serial</th><th>Original Qty</th><th>Corrected Qty</th></tr></thead>
          <tbody>${(bill.items || []).map((item, index) => `<tr>
            <td>${esc(item.item_name)}</td><td>${esc(item.item_description || '-')}</td><td>${fmtN(item.qty)}</td>
            <td><input type="number" min="0" max="${Number(item.qty)}" step="0.01" id="correction-qty-${index}" value="${Number(item.qty)}"></td>
          </tr>`).join('')}</tbody></table></div>
        <div class="form-group" style="margin-top:14px"><label>Reason</label>
          <textarea id="correction-reason" rows="3" placeholder="Explain why item or quantity must be removed"></textarea></div>
        <button class="btn btn-success" onclick="submitInvoiceCorrection(${bill.id})">Submit for Owner Approval</button>
      </div></div>`;
    modal.dataset.items = JSON.stringify(bill.items || []);
    document.body.appendChild(modal);
  } catch (error) { toast(error.message, 'error'); }
}

async function submitInvoiceCorrection(billId) {
  const modal = document.getElementById('correction-request-modal');
  const original = JSON.parse(modal?.dataset.items || '[]');
  const proposed = original.map((item, index) => ({
    ...item,
    qty: Math.max(0, Math.min(Number(item.qty || 0), Number(document.getElementById(`correction-qty-${index}`)?.value || 0)))
  }));
  if (!original.some((item, index) => Number(proposed.find(row =>
    String(row.item_id || row.item_name) === String(item.item_id || item.item_name))?.qty || 0) < Number(item.qty || 0))) {
    return toast('Reduce or remove at least one item quantity', 'error');
  }
  try {
    await api('POST', `/bills/${billId}/correction-request`, {
      reason: document.getElementById('correction-reason').value,
      proposed_items: proposed
    });
    modal.remove();
    toast('Correction request sent to the owner', 'success');
  } catch (error) { toast(error.message, 'error'); }
}

async function renderInvoiceCorrections() {
  const rows = await api('GET', `/bills/corrections/list?org_id=${APP_STATE.currentOrg.id}`);
  document.getElementById('content').innerHTML = `
    <div class="page-header"><h2>Invoice Correction Requests</h2></div>
    ${businessRegister('Correction Audit History',
      ['Invoice','Requested By','Reason','Status','Requested','Reviewed By','Review Note','Credit Note','Action'],
      rows.map(row => [
        row.bill_number, row.requested_by_name, row.reason, row.status, fmtDate(row.created_at),
        row.reviewed_by_name || '-', row.review_note || '-', row.credit_note_id || '-',
        row.status === 'pending' && APP_STATE.user.role === 'owner'
          ? `<button class="btn btn-xs btn-success" onclick="reviewInvoiceCorrection(${row.id},'approve')">Approve</button>
             <button class="btn btn-xs btn-danger" onclick="reviewInvoiceCorrection(${row.id},'reject')">Reject</button>`
          : '-'
      ]))}`;
}

async function reviewInvoiceCorrection(id, decision) {
  const note = prompt(`${decision === 'approve' ? 'Approval' : 'Rejection'} note`, '') ?? '';
  try {
    const result = await api('PUT', `/bills/corrections/${id}/review`, {
      decision, review_note: note, note_date: today()
    });
    toast(result.credit_note ? `Approved with Credit Note ${result.credit_note.note_number}` : 'Correction rejected', 'success');
    renderInvoiceCorrections();
  } catch (error) { toast(error.message, 'error'); }
}

// ── PAYMENT FORM ───────────────────────────────────────
async function renderPaymentForm(type, existingPayment = null) {
  const isVoucher = type === 'voucher';
  const paymentType = isVoucher ? 'paid' : 'received';
  const payments = await api('GET', `/payments?org_id=${APP_STATE.currentOrg.id}&type=${paymentType}&fy=${APP_STATE.currentFY}`);
  let nextNumber = '—';
  try {
    const result = await api('GET', `/payments/next-number?org_id=${APP_STATE.currentOrg.id}&type=${paymentType}&date=${today()}`);
    nextNumber = existingPayment?.payment_number || result.number;
  } catch (_) {}
  paymentMode2 = existingPayment?.mode || 'cash';
  let existingAllocations = [];
  try { existingAllocations = JSON.parse(existingPayment?.linked_bills || '[]'); } catch (_) {}
  const editing = Boolean(existingPayment?.id);
  document.getElementById('content').innerHTML = `
  <div class="bill-form">
    <div class="voucher-access-bar">
      <div class="form-group"><label>Voucher Company</label>
        <select id="voucher-org" onchange="switchVoucherCompany(this.value,'payment','${paymentType}')">${voucherCompanyOptions(APP_STATE.currentOrg.id)}</select>
      </div>
      <div class="form-group"><label>${isVoucher ? 'Payment Voucher' : 'Receipt'} Number</label>
        <input type="text" id="pay-voucher-number" value="${esc(nextNumber)}" readonly>
      </div>
      <div class="voucher-company-summary"><span>Company</span><strong>${esc(APP_STATE.currentOrg.display_name)}</strong></div>
    </div>
    <div class="card">
      <div class="section-title">${isVoucher ? 'Payment Voucher (Expense / Vendor Payment)' : 'Payment Received'}</div>
      <div class="form-row cols-3">
        <div class="form-group">
          <label>Date <span class="req">*</span></label>
          <input type="date" id="pay-date" value="${esc(existingPayment?.payment_date || today())}" onchange="refreshPaymentVoucherNumber('${paymentType}')">
        </div>
        <div class="form-group">
          <label>${isVoucher ? 'Payee' : 'Party'} Name</label>
          <div class="autocomplete-wrap">
            <input type="text" id="pay-party-search" placeholder="Search party..." oninput="partySearchPay(this.value)" autocomplete="off" value="${esc(existingPayment?.party_name || '')}">
            <div id="pay-party-ac" class="autocomplete-list" style="display:none"></div>
          </div>
          <input type="hidden" id="pay-party-id" value="${esc(existingPayment?.party_id || '')}">
        </div>
        <div class="form-group">
          <label>Amount <span class="req">*</span></label>
          <input type="number" id="pay-amount" placeholder="0.00" min="0" step="0.01" value="${esc(existingPayment?.amount || '')}">
        </div>
      </div>
      <div class="form-row cols-3">
        <div class="form-group">
          <label>Payment Mode</label>
          <div class="toggle-group" id="pay-mode-toggle">
            <button class="toggle-btn active" onclick="setPaymentMode('cash',this)">💵 Cash</button>
            <button class="toggle-btn" onclick="setPaymentMode('account',this)">🏦 Account</button>
            <button class="toggle-btn" onclick="setPaymentMode('upi',this)">📱 UPI</button>
          </div>
        </div>
        <div class="form-group">
          <label>Reference (Cheque/UTR)</label>
          <input type="text" id="pay-ref" placeholder="Cheque no / UTR" value="${esc(existingPayment?.reference || '')}">
        </div>
        <div class="form-group">
          <label>Narration</label>
          <input type="text" id="pay-narration" placeholder="${isVoucher ? 'Purpose of payment' : 'Payment details'}" value="${esc(existingPayment?.narration || '')}">
        </div>
      </div>
      <div class="form-group">
        <label>Link to Bills (optional)</label>
        <div id="linkable-bills" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius2);padding:8px">
          <div style="color:var(--text3);font-size:12px">Select a party to see pending bills</div>
        </div>
      </div>
    </div>
    <div style="display:flex;gap:10px">
      <button class="btn btn-success" onclick="savePayment(${isVoucher})">💾 Save ${isVoucher ? 'Voucher' : 'Payment'}</button>
      <button class="btn btn-secondary" onclick="history.back()">Cancel</button>
    </div>
  </div>
  ${businessRegister(isVoucher ? 'Payment Voucher Register' : 'Receipt Register',
    ['Date','Voucher','Party','Mode','Reference','Amount','Action'],
    payments.map(row => [fmtDate(row.payment_date),row.payment_number,row.party_name || (row.party_snapshot ? (() => { try { return JSON.parse(row.party_snapshot).name; } catch (_) { return ''; } })() : '') || '-',row.mode,
      row.reference||'-',fmt(row.amount),
      `<button class="btn btn-xs btn-outline" onclick="editPayment(${row.id},${isVoucher})">Edit</button>
       <button class="btn btn-xs btn-outline" onclick="showDuplicateVoucher('payment',${row.id},'${isVoucher ? 'payment-voucher' : 'payment-received'}')">Duplicate</button>
       ${APP_STATE.user?.role === 'owner' ? `<button class="btn btn-xs btn-danger" onclick="reversePayment(${row.id},'${isVoucher ? 'Payment Voucher' : 'Payment Received'}','${isVoucher ? 'payment-voucher' : 'payment-received'}')">Delete</button>` : ''}`]))}`;
  applyPaymentControlVisibility(isVoucher ? 'PV' : 'PR');
  if (existingPayment?.party_id) {
    await selectPayParty(existingPayment.party_id, existingPayment.party_name || '');
    const selected = new Map(existingAllocations.map(row => [String(row.bill_id), Number(row.amount || 0)]));
    document.querySelectorAll('#linkable-bills input[type="checkbox"]').forEach(input => {
      if (selected.has(String(input.value))) {
        input.checked = true;
        input.dataset.amount = String(selected.get(String(input.value)));
      }
    });
  }
}

async function editPayment(id, isVoucher) {
  try {
    const payment = await api('GET', `/payments/${id}`);
    APP_STATE.editingPayment = payment;
    await navigate(isVoucher ? 'payment-voucher' : 'payment-received');
    await renderPaymentForm(isVoucher ? 'voucher' : undefined, payment);
  } catch (e) { toast(e.message, 'error'); }
}

async function reversePayment(id, label, returnPage) {
  const reason = window.prompt(`Enter the reason for deleting/reversing this ${label}. This is recorded in the audit log.`);
  if (reason === null) return;
  if (reason.trim().length < 10) {
    toast('Enter a deletion reason of at least 10 characters', 'error');
    return;
  }
  try {
    await api('POST', `/payments/${id}/reverse`, { reason: reason.trim(), reversal_date: today() });
    toast(`${label} reversed and removed from the active list`, 'success');
    await navigate(returnPage);
  } catch (e) { toast(e.message, 'error'); }
}

async function refreshPaymentVoucherNumber(type) {
  const orgId = document.getElementById('voucher-org')?.value || APP_STATE.currentOrg.id;
  const date = document.getElementById('pay-date')?.value || today();
  try {
    const result = await api('GET', `/payments/next-number?org_id=${orgId}&type=${type}&date=${date}`);
    document.getElementById('pay-voucher-number').value = result.number;
  } catch (_) {}
}

let paymentMode2 = 'cash';
function setPaymentMode(mode, btn) {
  paymentMode2 = mode;
  document.querySelectorAll('#pay-mode-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function applyPaymentControlVisibility(type) {
  setInputGroupVisible('pay-party-search', txShow(type, 'party'));
  setInputGroupVisible('pay-amount', txShow(type, 'amount'));
  setElementVisible(document.getElementById('pay-mode-toggle')?.closest('.form-group'), txShow(type, 'payment_mode'));
  setInputGroupVisible('pay-ref', txShow(type, 'reference') || txShow(type, 'bank_reference'));
  setInputGroupVisible('pay-narration', txShow(type, 'footer'));
  setElementVisible(document.getElementById('linkable-bills')?.closest('.form-group'), txShow(type, 'linked_bills'));
}

function partySearchPay(val) {
  const ac = document.getElementById('pay-party-ac');
  if (!val) { ac.style.display = 'none'; return; }
  const matches = APP_STATE.parties.filter(p => p.name.toLowerCase().includes(val.toLowerCase())).slice(0,6);
  if (!matches.length) { ac.style.display = 'none'; return; }
  ac.innerHTML = matches.map(p => `<div class="autocomplete-item" onmousedown="selectPayParty(${p.id},'${esc(p.name)}')">${esc(p.name)}</div>`).join('');
  ac.style.display = 'block';
}

async function selectPayParty(id, name) {
  document.getElementById('pay-party-id').value = id;
  document.getElementById('pay-party-search').value = name;
  document.getElementById('pay-party-ac').style.display = 'none';
  // Load pending bills for this party
  try {
    const orgId = document.getElementById('voucher-org')?.value || APP_STATE.currentOrg.id;
    const bills = await api('GET', `/bills?org_id=${orgId}&party_id=${id}&format=SALE&status=saved`);
    const container = document.getElementById('linkable-bills');
    if (!bills.length) { container.innerHTML = '<div style="color:var(--text3);font-size:12px">No pending bills</div>'; return; }
    container.innerHTML = bills.map(b => `
      <label style="display:flex;align-items:center;gap:8px;padding:4px;font-size:12px;cursor:pointer">
        <input type="checkbox" value="${b.id}" data-amount="${b.grand_total}">
        <span class="mono">${esc(b.bill_number)}</span>
        <span style="color:var(--text3)">${fmtDate(b.bill_date)}</span>
        <span style="margin-left:auto;color:var(--gold)">${fmt(b.grand_total)}</span>
      </label>`).join('');
  } catch(e) {}
}

async function savePayment(isVoucher) {
  const type = isVoucher ? 'PV' : 'PR';
  const amount = parseFloat(document.getElementById('pay-amount').value);
  if (!amount) { toast('Enter amount', 'error'); return; }
  const linked = [];
  document.querySelectorAll('#linkable-bills input[type=checkbox]:checked').forEach(el => {
    linked.push({ bill_id: el.value, amount: parseFloat(el.dataset.amount) });
  });
  if (!requireVisibleFields(type, [
    { field: 'party', label: isVoucher ? 'Payee / Vendor' : 'Party', valid: () => Boolean(document.getElementById('pay-party-id')?.value) },
    { field: 'payment_mode', label: 'Payment Mode', valid: () => Boolean(paymentMode2) },
    { field: 'reference', label: 'Reference Number / UTR', valid: () => Boolean(document.getElementById('pay-ref')?.value) },
    { field: 'bank_reference', label: 'Bank Reference', valid: () => paymentMode2 === 'cash' || Boolean(document.getElementById('pay-ref')?.value) },
    { field: 'linked_bills', label: 'Linked Bills', valid: () => linked.length > 0 },
    { field: 'amount', label: 'Amount', valid: () => Number(amount || 0) > 0 },
    { field: 'footer', label: 'Narration', valid: () => Boolean(document.getElementById('pay-narration')?.value) }
  ])) return;
  try {
    const existingPayment = APP_STATE.editingPayment;
    const payload = {
      org_id: Number(document.getElementById('voucher-org')?.value || APP_STATE.currentOrg.id),
      payment_date: document.getElementById('pay-date').value,
      party_id: document.getElementById('pay-party-id').value || null,
      type: isVoucher ? 'paid' : 'received',
      mode: paymentMode2,
      amount,
      reference: document.getElementById('pay-ref').value || null,
      linked_bills: linked,
      narration: document.getElementById('pay-narration').value || null
    };
    if (existingPayment?.id) {
      const reason = window.prompt('Enter the reason for correcting this voucher.');
      if (reason === null) return;
      if (reason.trim().length < 10) {
        toast('Correction reason must be at least 10 characters', 'error');
        return;
      }
      payload.reason = reason.trim();
      await api('PATCH', `/payments/${existingPayment.id}`, payload);
    } else {
      await api('POST', '/payments', payload);
    }
    toast(existingPayment?.id ? 'Payment voucher updated!' : 'Payment saved!', 'success');
    APP_STATE.editingPayment = null;
    await navigate(isVoucher ? 'payment-voucher' : 'payment-received');
  } catch(e) { toast(e.message, 'error'); }
}

// ── PARTIES ────────────────────────────────────────────
async function renderParties() {
  showLoading();
  document.getElementById('topbar-actions').innerHTML = `
    <button class="btn btn-primary btn-sm" onclick="showPartyModal()">+ Add Party</button>`;
  try {
    const parties = await api('GET', `/parties?org_id=${APP_STATE.currentOrg.id}`);
    document.getElementById('content').innerHTML = `
    <div class="page-header">
      <h2>Parties Master</h2>
      <button class="btn btn-primary btn-sm" onclick="showPartyModal()">+ Add Party</button>
    </div>
    <div class="search-bar">
      <div class="search-input">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="Search name, phone, GST..." oninput="searchParties(this.value)">
      </div>
      <select onchange="filterPartiesByType(this.value)">
        <option value="">All Types</option>
        <option value="vendor">Vendors</option>
        <option value="customer">Customers</option>
        <option value="both">Both</option>
      </select>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Phone</th><th>City</th><th>GSTIN</th><th>GST Type</th><th>DSC</th><th>Actions</th></tr></thead>
        <tbody id="parties-tbody">
          ${parties.map(p => partyRow(p)).join('') || '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text3)">No parties yet</td></tr>'}
        </tbody>
      </table>
    </div>`;
    APP_STATE.parties = parties;
  } catch(e) { document.getElementById('content').innerHTML = `<p>${e.message}</p>`; }
}

function partyRow(p) {
  return `<tr>
    <td><strong>${esc(p.name)}</strong>${p.registered_name && p.registered_name !== p.name ? `<br><span style="font-size:11px;color:var(--text3)">${esc(p.registered_name)}</span>` : ''}</td>
    <td><span class="badge badge-saved">${p.type}</span></td>
    <td class="mono">${esc(p.phone||'—')}</td>
    <td>${esc(p.city||'—')}</td>
    <td class="mono" style="font-size:11px">${esc(p.gstin||'—')}</td>
    <td>${esc(p.gst_type||'—')}</td>
    <td>${Number(p.digital_signature_required || 0) ? '<span class="badge badge-pending">Required</span>' : '<span style="color:var(--text3)">No</span>'}</td>
    <td>
      <button class="btn btn-xs btn-secondary" onclick="showPartyModal(${p.id})">✏ Edit</button>
      <button class="btn btn-xs btn-outline" onclick="navigate('party-statement');setTimeout(()=>loadStatementForParty(${p.id}),300)">📊 Statement</button>
    </td>
  </tr>`;
}

async function searchParties(val) {
  try {
    const parties = await api('GET', `/parties?org_id=${APP_STATE.currentOrg.id}&search=${encodeURIComponent(val)}`);
    document.getElementById('parties-tbody').innerHTML = parties.map(p => partyRow(p)).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text3)">No parties found</td></tr>';
  } catch(e) {}
}

function filterPartiesByType(type) { searchParties(''); }

function showPartyModal(partyId, options = {}) {
  const party = partyId ? APP_STATE.parties.find(p => p.id === partyId) : null;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'party-modal';
  modal.dataset.quickSelect = options.quickSelect ? '1' : '0';
  modal.innerHTML = `
    <div class="modal-box modal-medium">
      <div class="modal-header">
        <h3>${party ? 'Edit Party' : 'Add New Party'}</h3>
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('party-modal').remove()">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-row cols-2">
          <div class="form-group">
            <label>Display Name <span class="req">*</span></label>
            <input type="text" id="pm-name" value="${esc(party?.name||options.name||'')}" placeholder="Party / Shop name">
          </div>
          <div class="form-group">
            <label>Registered Name</label>
            <input type="text" id="pm-regname" value="${esc(party?.registered_name||options.name||'')}" placeholder="Legal registered name">
          </div>
        </div>
        <div class="form-row cols-2">
          <div class="form-group">
            <label>Type</label>
            <select id="pm-type">
              <option value="both" ${party?.type==='both'?'selected':''}>Both (Vendor & Customer)</option>
              <option value="vendor" ${party?.type==='vendor'?'selected':''}>Vendor only</option>
              <option value="customer" ${party?.type==='customer' || options.type==='customer'?'selected':''}>Customer only</option>
            </select>
          </div>
          <div class="form-group">
            <label>Phone</label>
            <input type="tel" id="pm-phone" value="${esc(party?.phone||'')}" placeholder="Mobile number">
          </div>
        </div>
        <div class="form-row cols-2">
          <div class="form-group">
            <label>Email</label>
            <input type="email" id="pm-email" value="${esc(party?.email||'')}" placeholder="email@example.com">
          </div>
          <div class="form-group">
            <label>GST Registration Type</label>
            <select id="pm-gsttype" onchange="toggleGSTField(this.value)">
              <option value="unregistered" ${party?.gst_type==='unregistered'?'selected':''}>Unregistered</option>
              <option value="regular" ${party?.gst_type==='regular'?'selected':''}>Regular</option>
              <option value="composition" ${party?.gst_type==='composition'?'selected':''}>Composition</option>
            </select>
          </div>
        </div>
        <div class="form-group" id="pm-gstin-group" style="${party?.gst_type !== 'unregistered' ? '' : 'display:none'}">
          <label>GSTIN</label>
          <div style="display:flex;gap:8px">
            <input type="text" id="pm-gstin" value="${esc(party?.gstin||'')}" placeholder="22AAAAA0000A1Z5" maxlength="15" style="text-transform:uppercase">
            <button class="btn btn-secondary btn-sm" onclick="fetchGST()">🔍 Fetch</button>
          </div>
          <div id="gst-fetch-result" style="font-size:11px;color:var(--green);margin-top:4px"></div>
        </div>
        <div class="form-group">
          <label>Address</label>
          <textarea id="pm-address" rows="2" placeholder="Street address">${esc(party?.address||'')}</textarea>
        </div>
        <div class="form-row cols-3">
          <div class="form-group">
            <label>City</label>
            <input type="text" id="pm-city" value="${esc(party?.city||'')}" placeholder="City">
          </div>
          <div class="form-group">
            <label>State</label>
            <input type="text" id="pm-state" value="${esc(party?.state||'Andhra Pradesh')}" placeholder="State">
          </div>
          <div class="form-group">
            <label>Pincode</label>
            <input type="text" id="pm-pincode" value="${esc(party?.pincode||'')}" placeholder="533001">
          </div>
        </div>
        <div class="form-row cols-2">
          <div class="form-group">
            <label>Opening Balance</label>
            <input type="number" id="pm-opbal" value="${party?.opening_balance||0}" step="0.01">
          </div>
          <div class="form-group">
            <label>Balance Type</label>
            <select id="pm-baltype">
              <option value="dr" ${party?.balance_type==='dr'?'selected':''}>Dr (Debit / Receivable)</option>
              <option value="cr" ${party?.balance_type==='cr'?'selected':''}>Cr (Credit / Payable)</option>
            </select>
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:12px">
          <input type="checkbox" id="pm-shared" ${party?.shared?'checked':''}> Share this party across all organizations
        </label>
        <label class="security-setting-toggle">
          <input type="checkbox" id="pm-digital-signature-required" ${Number(party?.digital_signature_required || 0) ? 'checked' : ''}>
          <span><strong>Digital signature required for invoices</strong>
          <small>Use for parties who need USB DSC-token signed invoices. DSC password is never saved in Tarangini.</small></span>
        </label>
        <button class="btn btn-success" onclick="saveParty(${partyId||'null'})">${party ? 'Update Party' : 'Add Party'}</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function toggleGSTField(val) {
  document.getElementById('pm-gstin-group').style.display = val !== 'unregistered' ? '' : 'none';
}

async function fetchGST() {
  const gstin = document.getElementById('pm-gstin')?.value?.trim().toUpperCase();
  if (!gstin || gstin.length !== 15) { toast('Enter a valid 15-digit GSTIN', 'error'); return; }
  const el = document.getElementById('gst-fetch-result');
  el.textContent = '⏳ Fetching...';
  try {
    const data = await api('GET', `/parties/gst-fetch/${gstin}`);
    if (data.success) {
      if (data.name) document.getElementById('pm-name').value = data.name;
      if (data.address) document.getElementById('pm-address').value = data.address;
      if (data.state) document.getElementById('pm-state').value = data.state;
      if (data.gst_type) document.getElementById('pm-gsttype').value = data.gst_type;
      el.textContent = '✅ Details fetched!';
      el.style.color = 'var(--green)';
    } else {
      el.textContent = '⚠ ' + (data.error || 'Not found');
      el.style.color = 'var(--gold)';
    }
  } catch(e) {
    el.textContent = '❌ Fetch failed (offline?)';
    el.style.color = 'var(--red)';
  }
}

async function saveParty(id) {
  const name = document.getElementById('pm-name').value.trim();
  if (!name) { toast('Party name required', 'error'); return; }
  const payload = {
    org_id: APP_STATE.currentOrg.id,
    type: document.getElementById('pm-type').value,
    name,
    registered_name: document.getElementById('pm-regname').value,
    phone: document.getElementById('pm-phone').value,
    email: document.getElementById('pm-email').value,
    gst_type: document.getElementById('pm-gsttype').value,
    gstin: document.getElementById('pm-gstin')?.value?.toUpperCase() || '',
    address: document.getElementById('pm-address').value,
    city: document.getElementById('pm-city').value,
    state: document.getElementById('pm-state').value,
    pincode: document.getElementById('pm-pincode').value,
    opening_balance: parseFloat(document.getElementById('pm-opbal').value) || 0,
    balance_type: document.getElementById('pm-baltype').value,
    shared: document.getElementById('pm-shared').checked,
    digital_signature_required: Boolean(document.getElementById('pm-digital-signature-required')?.checked)
  };
  try {
    const quickSelect = document.getElementById('party-modal')?.dataset.quickSelect === '1';
    let savedId = id;
    if (id) { await api('PUT', `/parties/${id}`, payload); toast('Party updated', 'success'); }
    else {
      const result = await api('POST', '/parties', payload);
      savedId = Number(result.id);
      toast('Party added', 'success');
    }
    document.getElementById('party-modal')?.remove();
    await loadMasterData();
    if (quickSelect && savedId) {
      selectParty(Number(savedId));
    } else {
      renderParties();
    }
  } catch(e) { toast(e.message, 'error'); }
}

// ── ITEMS ──────────────────────────────────────────────
async function renderItems() {
  showLoading();
  document.getElementById('topbar-actions').innerHTML = `
    <button class="btn btn-primary btn-sm" onclick="showItemModal()">+ Add Item</button>`;
  try {
    const [items, categories] = await Promise.all([
      api('GET', `/items?org_id=${APP_STATE.currentOrg.id}`),
      api('GET', `/items/categories?org_id=${APP_STATE.currentOrg.id}`)
    ]);
    APP_STATE.items = items; APP_STATE.categories = categories;

    document.getElementById('content').innerHTML = `
    <div class="page-header">
      <h2>Items Master</h2>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary btn-sm" onclick="showCategoryModal()">+ Category</button>
        <button class="btn btn-primary btn-sm" onclick="showItemModal()">+ Add Item</button>
      </div>
    </div>
    <div class="search-bar">
      <div class="search-input">
        <span class="search-icon">🔍</span>
        <input type="text" placeholder="Search item name, HSN..." oninput="searchItems(this.value)">
      </div>
      <select onchange="filterItemsByCategory(this.value)" id="cat-filter">
        <option value="">All Categories</option>
        ${categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
      </select>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Item Name</th><th>Category</th><th>HSN</th><th>Unit</th><th>GST%</th><th>Last Sale Price</th><th>Actions</th></tr></thead>
        <tbody id="items-tbody">
          ${items.map(item => itemRow(item)).join('') || '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text3)">No items yet</td></tr>'}
        </tbody>
      </table>
    </div>`;
  } catch(e) { document.getElementById('content').innerHTML = `<p>${e.message}</p>`; }
}

function itemRow(item) {
  return `<tr>
    <td><strong>${esc(item.name)}</strong><br><span class="mono text-xs">${esc(item.item_code||'')}</span>
      ${item.model_number ? `<span class="text-xs"> | ${esc(item.model_number)}</span>` : ''}
      ${item.description ? `<br><span style="font-size:11px;color:var(--text3)">${esc(item.description)}</span>` : ''}</td>
    <td>${esc(item.category_name||'—')}</td>
    <td class="mono">${esc(item.hsn_code||'—')}</td>
    <td>${esc(item.unit)}</td>
    <td class="mono">${item.gst_rate}%</td>
    <td class="amount">${fmt(item.last_sale_price)}</td>
    <td>
      <button class="btn btn-xs btn-secondary" onclick="showItemModal(${item.id})">✏ Edit</button>
      <button class="btn btn-xs btn-outline" onclick="showBarcodeLabels(${item.id})">Barcode</button>
      <button class="btn btn-xs btn-danger" onclick="deleteItem(${item.id})">🗑</button>
    </td>
  </tr>`;
}

async function searchItems(val) {
  try {
    const items = await api('GET', `/items?org_id=${APP_STATE.currentOrg.id}&search=${encodeURIComponent(val)}`);
    document.getElementById('items-tbody').innerHTML = items.map(i => itemRow(i)).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text3)">No items found</td></tr>';
  } catch(e) {}
}

async function filterItemsByCategory(catId) {
  try {
    const items = await api('GET', `/items?org_id=${APP_STATE.currentOrg.id}${catId ? '&category_id='+catId : ''}`);
    document.getElementById('items-tbody').innerHTML = items.map(i => itemRow(i)).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text3)">No items</td></tr>';
  } catch(e) {}
}

function showItemModal(itemId) {
  const item = itemId ? APP_STATE.items.find(i => i.id === itemId) : null;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'item-modal';
  modal.innerHTML = `
    <div class="modal-box modal-medium">
      <div class="modal-header">
        <h3>${item ? 'Edit Item' : 'Add Item'}</h3>
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('item-modal').remove()">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-row cols-2">
          <div class="form-group">
            <label>Item Name <span class="req">*</span></label>
            <input type="text" id="im-name" value="${esc(item?.name||'')}" placeholder="e.g. A4 Paper Ream">
          </div>
          <div class="form-group">
            <label>Category</label>
            <select id="im-category">
              <option value="">— No Category —</option>
              ${APP_STATE.categories.map(c => `<option value="${c.id}" ${item?.category_id==c.id?'selected':''}>${esc(c.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row cols-3">
          <div class="form-group">
            <label>HSN Code</label>
            <input type="text" id="im-hsn" value="${esc(item?.hsn_code||'')}" placeholder="e.g. 4802">
          </div>
          <div class="form-group">
            <label>Unit <span class="req">*</span></label>
            <select id="im-unit">
              ${['NOS','PCS','PKT','BOX','KG','MTR','SET','LTR','SQF','RMT'].map(u => `<option ${u===(item?.unit||'NOS')?'selected':''}>${u}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>GST Rate %</label>
            <select id="im-gstrate">
              ${[0,5,12,18,28].map(r => `<option value="${r}" ${r===(item?.gst_rate??18)?'selected':''}>${r}%</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row cols-2">
          <div class="form-group">
            <label>Last Sale Price (₹)</label>
            <input type="number" id="im-saleprice" value="${item?.last_sale_price||0}" step="0.01" min="0">
          </div>
          <div class="form-group">
            <label>Last Purchase Price (₹)</label>
            <input type="number" id="im-purchaseprice" value="${item?.last_purchase_price||0}" step="0.01" min="0">
          </div>
        </div>
        <div class="form-group">
          <label>Description</label>
          <input type="text" id="im-desc" value="${esc(item?.description||'')}" placeholder="Optional description">
        </div>
        <button class="btn btn-success" onclick="saveItem(${itemId||'null'})">${item ? 'Update Item' : 'Add Item'}</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function saveItem(id) {
  const name = document.getElementById('im-name').value.trim();
  if (!name) { toast('Item name required', 'error'); return; }
  const payload = {
    org_id: APP_STATE.currentOrg.id,
    category_id: document.getElementById('im-category').value || null,
    name,
    hsn_code: document.getElementById('im-hsn').value,
    unit: document.getElementById('im-unit').value,
    gst_rate: parseFloat(document.getElementById('im-gstrate').value),
    last_sale_price: parseFloat(document.getElementById('im-saleprice').value) || 0,
    last_purchase_price: parseFloat(document.getElementById('im-purchaseprice').value) || 0,
    description: document.getElementById('im-desc').value
  };
  try {
    if (id) { await api('PUT', `/items/${id}`, payload); toast('Item updated', 'success'); }
    else { await api('POST', '/items', payload); toast('Item added', 'success'); }
    document.getElementById('item-modal')?.remove();
    await loadMasterData();
    renderItems();
  } catch(e) { toast(e.message, 'error'); }
}

async function deleteItem(id) {
  const ok = await showConfirm('Delete Item', 'Remove this item from master list?', 'Delete');
  if (!ok) return;
  try { await api('DELETE', `/items/${id}`); toast('Item deleted', 'success'); renderItems(); }
  catch(e) { toast(e.message, 'error'); }
}

function showCategoryModal() {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'cat-modal';
  modal.innerHTML = `
    <div class="modal-box modal-small">
      <div class="modal-header"><h3>Add Category</h3>
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('cat-modal').remove()">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group"><label>Category Name</label><input type="text" id="cat-name" placeholder="e.g. Stationery"></div>
        <div class="form-group"><label>Default HSN Code</label><input type="text" id="cat-hsn" placeholder="e.g. 4820"></div>
        <button class="btn btn-success" onclick="saveCategory()">Add Category</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function saveCategory() {
  const name = document.getElementById('cat-name').value.trim();
  if (!name) { toast('Category name required', 'error'); return; }
  try {
    await api('POST', '/items/categories', { org_id: APP_STATE.currentOrg.id, name, hsn_code: document.getElementById('cat-hsn').value });
    toast('Category added', 'success');
    document.getElementById('cat-modal')?.remove();
    await loadMasterData();
    renderItems();
  } catch(e) { toast(e.message, 'error'); }
}

// ── PARTY STATEMENT ────────────────────────────────────
async function renderPartyStatement() {
  document.getElementById('content').innerHTML = `
  <div class="card" style="margin-bottom:16px">
    <div class="form-row cols-3">
      <div class="form-group">
        <label>Select Party</label>
        <div class="autocomplete-wrap">
          <input type="text" id="stmt-party-search" placeholder="Type party name..." oninput="stmtPartySearch(this.value)" autocomplete="off">
          <div id="stmt-party-ac" class="autocomplete-list" style="display:none"></div>
          <input type="hidden" id="stmt-party-id">
        </div>
      </div>
      <div class="form-group">
        <label>Financial Year</label>
        <select id="stmt-fy">
          ${getFYList().map(fy => `<option value="${fy}" ${fy === APP_STATE.currentFY ? 'selected':''}>${fy}</option>`).join('')}
        </select>
      </div>
      <div class="form-group" style="align-self:flex-end">
        <button class="btn btn-primary" onclick="loadStatement()">Load Statement</button>
      </div>
    </div>
  </div>
  <div id="statement-output"></div>`;
}

function stmtPartySearch(val) {
  const ac = document.getElementById('stmt-party-ac');
  if (!val) { ac.style.display='none'; return; }
  const matches = APP_STATE.parties.filter(p => p.name.toLowerCase().includes(val.toLowerCase())).slice(0,6);
  if (!matches.length) { ac.style.display='none'; return; }
  ac.innerHTML = matches.map(p => `<div class="autocomplete-item" onmousedown="selectStmtParty(${p.id},'${esc(p.name)}')">${esc(p.name)}</div>`).join('');
  ac.style.display = 'block';
}

function selectStmtParty(id, name) {
  document.getElementById('stmt-party-id').value = id;
  document.getElementById('stmt-party-search').value = name;
  document.getElementById('stmt-party-ac').style.display = 'none';
}

async function loadStatementForParty(partyId) {
  const p = APP_STATE.parties.find(x => x.id === partyId);
  if (p) {
    document.getElementById('stmt-party-id').value = partyId;
    document.getElementById('stmt-party-search').value = p.name;
    loadStatement();
  }
}

async function loadStatement() {
  const partyId = document.getElementById('stmt-party-id').value;
  const fy = document.getElementById('stmt-fy').value;
  if (!partyId) { toast('Select a party', 'error'); return; }
  try {
    const data = await api('GET', `/reports/party-statement?party_id=${partyId}&org_id=${APP_STATE.currentOrg.id}&fy=${fy}`);
    const { party, entries, closing_balance } = data;
    document.getElementById('statement-output').innerHTML = `
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:18px;font-weight:700">${esc(party?.name)}</div>
          <div style="color:var(--text2);font-size:12px">${esc(party?.address||'')} | ${esc(party?.gstin||'Unregistered')}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:12px;color:var(--text2)">Closing Balance</div>
          <div style="font-size:24px;font-weight:700;color:${closing_balance >= 0 ? 'var(--red)' : 'var(--green)'}">${fmt(Math.abs(closing_balance))} ${closing_balance >= 0 ? 'Dr' : 'Cr'}</div>
        </div>
      </div>
    </div>
    <div class="table-wrap statement-table">
      <table>
        <thead><tr><th>Date</th><th>Ref No.</th><th>Type</th><th>Debit (Dr)</th><th>Credit (Cr)</th><th>Balance</th></tr></thead>
        <tbody>
          ${entries.map(e => `<tr>
            <td>${fmtDate(e.date)}</td>
            <td class="mono">${esc(e.ref_number||'—')}</td>
            <td>${esc(e.entry_type||e.type)}</td>
            <td class="amount dr">${e.debit > 0 ? fmt(e.debit) : '—'}</td>
            <td class="amount cr">${e.credit > 0 ? fmt(e.credit) : '—'}</td>
            <td class="amount"><strong>${fmt(Math.abs(e.balance||0))} ${(e.balance||0) >= 0 ? 'Dr' : 'Cr'}</strong></td>
          </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:20px">No transactions</td></tr>'}
        </tbody>
      </table>
    </div>
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="btn btn-secondary" onclick="window.print()">🖨️ Print Statement</button>
    </div>`;
  } catch(e) { document.getElementById('statement-output').innerHTML = `<p style="color:var(--red)">${e.message}</p>`; }
}

// ── SALES REPORT ───────────────────────────────────────
async function renderSalesReport() {
  showLoading();
  try {
    const data = await api('GET', `/reports/dashboard?org_id=${APP_STATE.currentOrg.id}&fy=${APP_STATE.currentFY}`);
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    document.getElementById('content').innerHTML = `
    <div class="page-header"><h2>Sales Report — ${APP_STATE.currentFY}</h2></div>
    <div class="stats-grid">
      <div class="stat-card gold"><div class="stat-label">Total Sales</div><div class="stat-value">${fmt(data.total_sales)}</div></div>
      <div class="stat-card green"><div class="stat-label">Cash Sales</div><div class="stat-value">${fmt(data.cash_sales)}</div></div>
      <div class="stat-card red"><div class="stat-label">Credit Sales</div><div class="stat-value">${fmt(data.credit_sales)}</div></div>
      <div class="stat-card blue"><div class="stat-label">Total Bills</div><div class="stat-value">${data.total_bills}</div></div>
    </div>
    <div class="table-wrap" style="margin-top:16px">
      <table>
        <thead><tr><th>Month</th><th>Bills Count</th><th>Total Sales</th></tr></thead>
        <tbody>
          ${(data.monthly_sales||[]).map(m => `<tr>
            <td>${monthNames[parseInt(m.month)-1] || m.month}</td>
            <td class="mono">${m.count}</td>
            <td class="amount">${fmt(m.total)}</td>
          </tr>`).join('') || '<tr><td colspan="3" style="text-align:center;color:var(--text3);padding:20px">No data</td></tr>'}
        </tbody>
      </table>
    </div>`;
  } catch(e) { document.getElementById('content').innerHTML = `<p>${e.message}</p>`; }
}

// FINANCIAL ACCOUNTING
let ACCOUNTING_REPORT = null;
let ACCOUNTING_ACCOUNTS = [];

async function renderFinancialReports() {
  showLoading();
  try {
    [ACCOUNTING_REPORT, ACCOUNTING_ACCOUNTS] = await Promise.all([
      api('GET', `/accounting/reports?org_id=${APP_STATE.currentOrg.id}&fy=${APP_STATE.currentFY}`),
      api('GET', `/accounting/accounts?org_id=${APP_STATE.currentOrg.id}`)
    ]);
    document.getElementById('content').innerHTML = `
      <div class="page-header">
        <div><h2>Financial Reports - ${APP_STATE.currentFY}</h2>
          <div style="font-size:12px;color:var(--text2)">Period ${fmtDate(ACCOUNTING_REPORT.period.start)} to ${fmtDate(ACCOUNTING_REPORT.period.end)}</div></div>
        <div style="display:flex;gap:8px">
          ${APP_STATE.user.role === 'owner' ? '<button class="btn btn-primary btn-sm" onclick="navigate(\'journal-entry\')">+ Journal Entry</button>' : ''}
          <button class="btn btn-secondary btn-sm" onclick="window.print()">Print Report</button>
        </div>
      </div>
      <div class="report-tabs">
        ${[
          ['balance-sheet','Balance Sheet'],['profit-loss','Profit & Loss'],['trial-balance','Trial Balance'],
          ['day-book','Day Book'],['cash-bank','Cash / Bank'],['receivables','Receivables'],
          ['payables','Payables'],['gst','GST Summary'],['sales-register','Sales Register'],
          ['payment-register','Payment Register'],['expense-register','Expenses / Purchases']
        ].map(([id,label], index) => `<button class="report-tab ${index === 0 ? 'active' : ''}" onclick="showFinancialReport('${id}',this)">${label}</button>`).join('')}
      </div>
      <div id="financial-report-output"></div>`;
    showFinancialReport('balance-sheet', document.querySelector('.report-tab'));
  } catch (e) {
    document.getElementById('content').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

function reportAmountRows(rows, emptyMessage = 'No balances') {
  return rows.map(row => `<tr>
    <td class="mono">${esc(row.code || '')}</td><td>${esc(row.name)}</td>
    <td class="amount">${fmt(row.amount)}</td></tr>`).join('') ||
    `<tr><td colspan="3" style="text-align:center;color:var(--text3);padding:24px">${emptyMessage}</td></tr>`;
}

function reportRegisterTable(headers, rows, footer = '') {
  return `<div class="table-wrap"><table>
    <thead><tr>${headers.map(header => `<th>${header}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('') ||
      `<tr><td colspan="${headers.length}" style="text-align:center;color:var(--text3);padding:24px">No transactions</td></tr>`}
    ${footer ? `<tr class="total-row"><td colspan="${headers.length}">${footer}</td></tr>` : ''}
    </tbody></table></div>`;
}

function showFinancialReport(type, button) {
  if (button) {
    document.querySelectorAll('.report-tab').forEach(el => el.classList.remove('active'));
    button.classList.add('active');
  }
  const data = ACCOUNTING_REPORT;
  const output = document.getElementById('financial-report-output');
  if (!data || !output) return;

  if (type === 'balance-sheet') {
    const bs = data.balance_sheet;
    const balanced = Math.abs(bs.difference) < 0.02;
    output.innerHTML = `
      <div class="accounting-check ${balanced ? 'balanced' : 'unbalanced'}">
        ${balanced ? 'Books balanced' : `Difference: ${fmt(Math.abs(bs.difference))}`}
      </div>
      <div class="balance-sheet-grid">
        <div class="table-wrap"><table><thead><tr><th colspan="2">Assets</th><th>Amount</th></tr></thead>
          <tbody>${reportAmountRows(bs.assets)}
          <tr class="total-row"><td colspan="2">Total Assets</td><td class="amount">${fmt(bs.total_assets)}</td></tr></tbody></table></div>
        <div class="table-wrap"><table><thead><tr><th colspan="2">Liabilities and Equity</th><th>Amount</th></tr></thead>
          <tbody>${reportAmountRows(bs.liabilities)}${reportAmountRows(bs.equity)}
          <tr><td></td><td>Retained Profit / (Loss)</td><td class="amount">${fmt(bs.retained_profit)}</td></tr>
          <tr class="total-row"><td colspan="2">Total Liabilities and Equity</td><td class="amount">${fmt(bs.total_liabilities_equity)}</td></tr></tbody></table></div>
      </div>`;
  } else if (type === 'profit-loss') {
    const pl = data.profit_loss;
    output.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card green"><div class="stat-label">Income</div><div class="stat-value">${fmt(pl.total_income)}</div></div>
        <div class="stat-card red"><div class="stat-label">Expenses</div><div class="stat-value">${fmt(pl.total_expenses)}</div></div>
        <div class="stat-card ${pl.net_profit >= 0 ? 'gold' : 'red'}"><div class="stat-label">Net ${pl.net_profit >= 0 ? 'Profit' : 'Loss'}</div><div class="stat-value">${fmt(Math.abs(pl.net_profit))}</div></div>
      </div>
      <div class="balance-sheet-grid">
        <div class="table-wrap"><table><thead><tr><th colspan="2">Income</th><th>Amount</th></tr></thead>
          <tbody>${reportAmountRows(pl.income)}<tr class="total-row"><td colspan="2">Total Income</td><td class="amount">${fmt(pl.total_income)}</td></tr></tbody></table></div>
        <div class="table-wrap"><table><thead><tr><th colspan="2">Expenses</th><th>Amount</th></tr></thead>
          <tbody>${reportAmountRows(pl.expenses)}<tr class="total-row"><td colspan="2">Total Expenses</td><td class="amount">${fmt(pl.total_expenses)}</td></tr></tbody></table></div>
      </div>`;
  } else if (type === 'trial-balance') {
    const rows = data.trial_balance;
    const totalDr = rows.reduce((sum,row) => sum + Number(row.debit), 0);
    const totalCr = rows.reduce((sum,row) => sum + Number(row.credit), 0);
    output.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Code</th><th>Account</th><th>Type</th><th>Debit</th><th>Credit</th><th></th></tr></thead>
      <tbody>${rows.map(row => `<tr><td class="mono">${esc(row.code)}</td><td>${esc(row.name)}</td><td>${esc(row.type)}</td>
        <td class="amount">${row.debit ? fmt(row.debit) : '-'}</td><td class="amount">${row.credit ? fmt(row.credit) : '-'}</td>
        <td><button class="btn btn-xs btn-secondary" onclick="showAccountLedger(${row.account_id})">Ledger</button></td></tr>`).join('')}
      <tr class="total-row"><td colspan="3">Total</td><td class="amount">${fmt(totalDr)}</td><td class="amount">${fmt(totalCr)}</td><td></td></tr>
      </tbody></table></div>`;
  } else if (type === 'day-book') {
    output.innerHTML = reportRegisterTable(['Date','Voucher','Number','Narration','Debit','Credit'],
      data.day_book.map(row => [fmtDate(row.entry_date),row.voucher_type,row.voucher_number || '-',row.narration || '-',fmt(row.debit),fmt(row.credit)]));
  } else if (type === 'cash-bank') {
    output.innerHTML = `<div class="stats-grid">${data.cash_bank.map(row => `
      <div class="stat-card blue"><div class="stat-label">${esc(row.name)}</div><div class="stat-value">${fmt(row.amount)}</div></div>`).join('')}</div>`;
  } else if (type === 'receivables' || type === 'payables') {
    const rows = data[type];
    output.innerHTML = reportRegisterTable(['Party','Party Type','Outstanding'],
      rows.map(row => [row.name,row.type,fmt(row.amount)]),
      `${type === 'receivables' ? 'Total Receivable' : 'Total Payable'}: ${fmt(rows.reduce((sum,row) => sum + Number(row.amount),0))}`);
  } else if (type === 'gst') {
    const gst = data.gst;
    output.innerHTML = `<div class="stats-grid">
      <div class="stat-card gold"><div class="stat-label">Taxable Sales</div><div class="stat-value">${fmt(gst.taxable)}</div></div>
      <div class="stat-card blue"><div class="stat-label">CGST</div><div class="stat-value">${fmt(gst.cgst)}</div></div>
      <div class="stat-card blue"><div class="stat-label">SGST</div><div class="stat-value">${fmt(gst.sgst)}</div></div>
      <div class="stat-card blue"><div class="stat-label">IGST</div><div class="stat-value">${fmt(gst.igst)}</div></div>
      <div class="stat-card red"><div class="stat-label">Total Output Tax</div><div class="stat-value">${fmt(gst.total_tax)}</div></div></div>`;
  } else if (type === 'sales-register') {
    output.innerHTML = reportRegisterTable(['Date','Bill No.','Party','Mode','Taxable','CGST','SGST','IGST','Total'],
      data.sales_register.map(row => [fmtDate(row.bill_date),row.bill_number,row.party_name || 'Cash Customer',row.payment_mode,
        fmt(row.taxable_amount),fmt(row.cgst),fmt(row.sgst),fmt(row.igst),fmt(row.grand_total)]));
  } else if (type === 'payment-register') {
    output.innerHTML = reportRegisterTable(['Date','Voucher No.','Party','Type','Mode','Amount','Reference','Narration'],
      data.payment_register.map(row => [fmtDate(row.payment_date),row.payment_number,row.party_name || '-',row.type,row.mode,
        fmt(row.amount),row.reference || '-',row.narration || '-']));
  } else if (type === 'expense-register') {
    output.innerHTML = reportRegisterTable(['Date','Voucher No.','Type','Account','Party','Amount','Narration'],
      data.expense_register.map(row => [fmtDate(row.entry_date),row.voucher_number,row.voucher_type,row.account_name,
        row.party_name || '-',fmt(row.amount),row.narration || '-']));
  }
}

async function showAccountLedger(accountId) {
  try {
    const data = await api('GET', `/accounting/ledger/${accountId}?org_id=${APP_STATE.currentOrg.id}&fy=${APP_STATE.currentFY}`);
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'ledger-modal';
    modal.innerHTML = `<div class="modal-box modal-large">
      <div class="modal-header"><h3>${esc(data.account.code)} - ${esc(data.account.name)}</h3>
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('ledger-modal').remove()">Close</button></div>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Voucher</th><th>Party</th><th>Narration</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
      <tbody>${data.entries.map(row => `<tr><td>${fmtDate(row.entry_date)}</td><td class="mono">${esc(row.voucher_number || row.voucher_type)}</td>
        <td>${esc(row.party_name || '-')}</td><td>${esc(row.narration || '-')}</td>
        <td class="amount">${row.debit ? fmt(row.debit) : '-'}</td><td class="amount">${row.credit ? fmt(row.credit) : '-'}</td>
        <td class="amount">${fmt(Math.abs(row.balance))} ${row.balance >= 0 ? 'Dr' : 'Cr'}</td></tr>`).join('')}</tbody></table></div></div>`;
    document.body.appendChild(modal);
  } catch (e) { toast(e.message, 'error'); }
}

async function renderJournalEntry() {
  if (APP_STATE.user.role !== 'owner') {
    document.getElementById('content').innerHTML = '<div class="empty-state"><p>Owner access required</p></div>';
    return;
  }
  try {
    const [accounts, journals] = await Promise.all([
      api('GET', `/accounting/accounts?org_id=${APP_STATE.currentOrg.id}`),
      api('GET', `/accounting/journals?org_id=${APP_STATE.currentOrg.id}&fy=${APP_STATE.currentFY}`)
    ]);
    ACCOUNTING_ACCOUNTS = accounts;
    let nextNumber = '—';
    try {
      const preview = await api('GET', `/accounting/next-number?org_id=${APP_STATE.currentOrg.id}&voucher_type=JOURNAL&date=${today()}`);
      nextNumber = preview.number;
    } catch (_) {}
    document.getElementById('content').innerHTML = `
      <div class="page-header"><div><h2>Journal Entry</h2><div style="font-size:12px;color:var(--text2)">Purchases, expenses, assets, loans, capital, and adjustments</div></div>
        <button class="btn btn-secondary btn-sm" onclick="showAddAccountModal()">+ New Account</button></div>
      <div class="voucher-access-bar">
        <div class="form-group"><label>Voucher Company</label>
          <select id="voucher-org" onchange="switchVoucherCompany(this.value,'journal','JOURNAL')">${voucherCompanyOptions(APP_STATE.currentOrg.id)}</select>
        </div>
        <div class="form-group"><label>Voucher Number</label>
          <input type="text" id="journal-voucher-number" value="${esc(nextNumber)}" readonly>
        </div>
        <div class="voucher-company-summary"><span>Company</span><strong>${esc(APP_STATE.currentOrg.display_name)}</strong></div>
      </div>
      <div class="card">
        <div class="form-row cols-3">
          <div class="form-group"><label>Date</label><input type="date" id="journal-date" value="${today()}" onchange="refreshJournalVoucherNumber()"></div>
          <div class="form-group"><label>Voucher Type</label><select id="journal-type" onchange="refreshJournalVoucherNumber()">
            <option value="JOURNAL">Journal</option><option value="PURCHASE">Purchase</option><option value="EXPENSE">Expense</option>
            <option value="CONTRA">Cash / Bank Transfer</option><option value="CAPITAL">Capital / Loan</option><option value="ADJUSTMENT">Adjustment</option>
          </select></div>
          <div class="form-group"><label>Narration</label><input id="journal-narration" placeholder="Transaction description"></div>
        </div>
        <div class="table-wrap"><table><thead><tr><th class="journal-account-head">Account</th><th>Party (optional)</th><th class="journal-line-head">Debit</th><th class="journal-line-head">Credit</th><th></th></tr></thead>
          <tbody id="journal-lines"></tbody></table></div>
        <div class="journal-totals"><span>Debit: <strong id="journal-debit-total">₹0.00</strong></span>
          <span>Credit: <strong id="journal-credit-total">₹0.00</strong></span><span id="journal-balance-status"></span></div>
        <div style="display:flex;gap:8px;margin-top:14px">
          <button class="btn btn-secondary" onclick="addJournalLine()">+ Add Line</button>
          <button class="btn btn-success" onclick="saveJournalEntry()">Save Balanced Entry</button>
          <button class="btn btn-secondary" onclick="navigate('financial-reports')">Cancel</button>
        </div>
      </div>
      ${businessRegister('Journal Register',['Date','Voucher','Type','Narration','Debit','Credit','Action'],
        journals.map(row => [fmtDate(row.entry_date),row.voucher_number,row.voucher_type,row.narration||'-',
          fmt(row.total_debit),fmt(row.total_credit),
          `<button class="btn btn-xs btn-outline" onclick="showDuplicateVoucher('journal',${row.id},'journal-entry')">Duplicate</button>`]))}
      <div class="card" style="margin-top:16px"><div class="section-title">Common Entries</div>
        <div class="accounting-help"><span><strong>Expense paid:</strong> Debit expense, Credit Cash/Bank</span>
        <span><strong>Credit purchase:</strong> Debit Purchases, Credit Accounts Payable</span>
        <span><strong>Asset bought:</strong> Debit Fixed Assets, Credit Cash/Bank or Loan</span>
        <span><strong>Capital introduced:</strong> Debit Cash/Bank, Credit Owner Capital</span></div></div>`;
    addJournalLine();
    addJournalLine();
    applyJournalControlVisibility();
  } catch (e) {
    document.getElementById('content').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

async function refreshJournalVoucherNumber() {
  const orgId = document.getElementById('voucher-org')?.value || APP_STATE.currentOrg.id;
  const type = document.getElementById('journal-type')?.value || 'JOURNAL';
  const date = document.getElementById('journal-date')?.value || today();
  try {
    const result = await api('GET', `/accounting/next-number?org_id=${orgId}&voucher_type=${type}&date=${date}`);
    document.getElementById('journal-voucher-number').value = result.number;
  } catch (_) {}
}

function journalAccountOptions() {
  return `<option value="">Select account</option>${ACCOUNTING_ACCOUNTS.map(account =>
    `<option value="${account.id}">${esc(account.code)} - ${esc(account.name)}</option>`).join('')}`;
}

function addJournalLine() {
  const body = document.getElementById('journal-lines');
  if (!body) return;
  const row = document.createElement('tr');
  row.innerHTML = `<td class="journal-account-cell"><select class="jl-account">${journalAccountOptions()}</select></td>
    <td><select class="jl-party"><option value="">No party</option>${APP_STATE.parties.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></td>
    <td class="journal-line-cell"><input class="jl-debit" type="number" min="0" step="0.01" placeholder="0.00" oninput="clearOppositeJournalValue(this,'debit')"></td>
    <td class="journal-line-cell"><input class="jl-credit" type="number" min="0" step="0.01" placeholder="0.00" oninput="clearOppositeJournalValue(this,'credit')"></td>
    <td><button class="btn btn-xs btn-danger" onclick="this.closest('tr').remove();updateJournalTotals()">Remove</button></td>`;
  body.appendChild(row);
  applyJournalControlVisibility();
}

function applyJournalControlVisibility() {
  setInputGroupVisible('journal-type', txShow('JOURNAL', 'voucher_type'));
  setInputGroupVisible('journal-narration', txShow('JOURNAL', 'footer'));
  document.querySelectorAll('.journal-account-head,.journal-account-cell')
    .forEach(el => setElementVisible(el, txShow('JOURNAL', 'account_codes')));
  document.querySelectorAll('.journal-line-head,.journal-line-cell')
    .forEach(el => setElementVisible(el, txShow('JOURNAL', 'debit_credit_lines')));
}

function clearOppositeJournalValue(input, side) {
  if (Number(input.value) > 0) input.closest('tr').querySelector(side === 'debit' ? '.jl-credit' : '.jl-debit').value = '';
  updateJournalTotals();
}

function updateJournalTotals() {
  const rows = [...document.querySelectorAll('#journal-lines tr')];
  const debit = rows.reduce((sum,row) => sum + Number(row.querySelector('.jl-debit').value || 0), 0);
  const credit = rows.reduce((sum,row) => sum + Number(row.querySelector('.jl-credit').value || 0), 0);
  document.getElementById('journal-debit-total').textContent = fmt(debit);
  document.getElementById('journal-credit-total').textContent = fmt(credit);
  const status = document.getElementById('journal-balance-status');
  const balanced = debit > 0 && Math.abs(debit - credit) < 0.01;
  status.textContent = balanced ? 'Balanced' : `Difference ${fmt(Math.abs(debit-credit))}`;
  status.className = balanced ? 'journal-balanced' : 'journal-unbalanced';
}

async function saveJournalEntry() {
  const lines = [...document.querySelectorAll('#journal-lines tr')].map(row => ({
    account_id: row.querySelector('.jl-account').value,
    party_id: row.querySelector('.jl-party').value || null,
    debit: Number(row.querySelector('.jl-debit').value || 0),
    credit: Number(row.querySelector('.jl-credit').value || 0)
  }));
  if (!requireVisibleFields('JOURNAL', [
    { field: 'voucher_type', label: 'Voucher Type', valid: () => Boolean(document.getElementById('journal-type')?.value) },
    { field: 'account_codes', label: 'Account Codes', valid: () => lines.every(line => Number(line.account_id)) },
    { field: 'debit_credit_lines', label: 'Debit / Credit Lines', valid: () => lines.length >= 2 && lines.some(line => Number(line.debit) > 0) && lines.some(line => Number(line.credit) > 0) },
    { field: 'footer', label: 'Narration', valid: () => Boolean(document.getElementById('journal-narration')?.value) }
  ])) return;
  try {
    const result = await api('POST', '/accounting/journals', {
      org_id: Number(document.getElementById('voucher-org')?.value || APP_STATE.currentOrg.id),
      entry_date: document.getElementById('journal-date').value,
      voucher_type: document.getElementById('journal-type').value,
      narration: document.getElementById('journal-narration').value, lines
    });
    toast(`Journal ${result.voucher_number} saved`, 'success');
    navigate('financial-reports');
  } catch (e) { toast(e.message, 'error'); }
}

function showAddAccountModal() {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'account-modal';
  modal.innerHTML = `<div class="modal-box modal-small">
    <div class="modal-header"><h3>Add Ledger Account</h3><button class="btn btn-secondary btn-sm" onclick="document.getElementById('account-modal').remove()">Close</button></div>
    <div class="form-group"><label>Account Code</label><input id="new-account-code" placeholder="Example: 6010"></div>
    <div class="form-group"><label>Account Name</label><input id="new-account-name" placeholder="Example: Office Supplies"></div>
    <div class="form-group"><label>Type</label><select id="new-account-type">
      <option value="expense">Expense</option><option value="asset">Asset</option><option value="liability">Liability</option>
      <option value="income">Income</option><option value="equity">Equity</option></select></div>
    <button class="btn btn-success" onclick="saveNewAccount()">Add Account</button></div>`;
  document.body.appendChild(modal);
}

async function saveNewAccount() {
  try {
    await api('POST', '/accounting/accounts', {
      org_id: APP_STATE.currentOrg.id, code: document.getElementById('new-account-code').value.trim(),
      name: document.getElementById('new-account-name').value.trim(), type: document.getElementById('new-account-type').value
    });
    document.getElementById('account-modal').remove();
    toast('Account added', 'success');
    renderJournalEntry();
  } catch (e) { toast(e.message, 'error'); }
}

// ── BACKUP ─────────────────────────────────────────────
async function renderBackup() {
  let status;
  try { status = await api('GET', `/backup/status?org_id=${APP_STATE.currentOrg?.id}`); } catch(e) { status = { days_since: 0 }; }

  document.getElementById('content').innerHTML = `
  ${status.critical ? `<div class="backup-warning"><span style="font-size:20px">🚨</span><div><strong>Backup Overdue!</strong> Last backup was ${status.days_since} days ago. Please backup now.</div></div>` :
    status.warning ? `<div class="backup-warning warn"><span style="font-size:20px">⚠️</span><div><strong>Backup Due Soon</strong> — ${status.days_since} days since last backup. Recommended every 90 days.</div></div>` : ''}

  <div class="page-header"><h2>Backup & Restore</h2></div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
    <div class="card">
      <div class="section-title">📥 Export Backup</div>
      <div class="form-group">
        <label>Organization</label>
        <select id="bk-org">
          <option value="">All Organizations</option>
          ${APP_STATE.orgs.map(o => `<option value="${o.id}">${esc(o.display_name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Financial Year</label>
        <select id="bk-fy">
          <option value="">All Years</option>
          ${getFYList().map(fy => `<option value="${fy}" ${fy===APP_STATE.currentFY?'selected':''}>${fy}</option>`).join('')}
        </select>
      </div>
      <p style="font-size:12px;color:var(--text2);margin-bottom:12px">
        Exports all data as a compact JSON file. Keep multiple copies in different locations.
      </p>
      <button class="btn btn-primary" onclick="doExportBackup()">⬇️ Download Backup</button>
    </div>

    <div class="card">
      <div class="section-title">📤 Import / Restore</div>
      <p style="font-size:12px;color:var(--text2);margin-bottom:12px">
        Import a previously exported backup file. Existing records will not be overwritten. New records will be added.
      </p>
      <div class="form-group">
        <label>Select Backup File (.json)</label>
        <input type="file" id="bk-file" accept=".json" style="background:var(--surface2);border:1px solid var(--border);padding:8px;border-radius:8px">
      </div>
      <button class="btn btn-gold" onclick="doImportBackup()">📤 Import Backup</button>
      <div id="import-result" style="margin-top:12px;font-size:13px;color:var(--green)"></div>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <div class="section-title">ℹ️ Backup Guide</div>
    <div style="font-size:13px;color:var(--text2);line-height:1.8">
      <p>• Export backup every <strong>3 months</strong> (reminder shown at 75 days)</p>
      <p>• Store backup files in: Google Drive, Pen Drive, another computer</p>
      <p>• Each FY backup is a small JSON file (&lt; 1MB for typical usage)</p>
      <p>• To migrate to a new computer: install app, then import your backup file</p>
      <p>• Last backup: <strong>${status.last_backup ? fmtDate(status.last_backup.backup_date) + ' by ' + (status.last_backup.created_by||'') : 'Never'}</strong></p>
    </div>
  </div>`;
}

async function doExportBackup() {
  const orgId = document.getElementById('bk-org').value;
  const fy = document.getElementById('bk-fy').value;
  let url = `/api/backup/export?`;
  if (orgId) url += `org_id=${orgId}&`;
  if (fy) url += `fy=${fy}`;
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('Authorization', `Bearer ${APP_STATE.token}`);
  // Use fetch to download with auth
  try {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${APP_STATE.token}` } });
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition');
    const filename = disposition?.match(/filename="(.+)"/)?.[1] || 'backup.json';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    toast('Backup downloaded!', 'success');
  } catch(e) { toast('Export failed: ' + e.message, 'error'); }
}

async function doImportBackup() {
  const file = document.getElementById('bk-file').files[0];
  if (!file) { toast('Select a backup file', 'error'); return; }
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const result = await api('POST', '/backup/import', data);
    document.getElementById('import-result').innerHTML = `✅ Import complete! Parties: ${result.imported.parties}, Items: ${result.imported.items}, Bills: ${result.imported.bills}, Payments: ${result.imported.payments}, Journals: ${result.imported.journals || 0}`;
    toast('Import successful!', 'success');
    await loadMasterData();
  } catch(e) { toast('Import failed: ' + e.message, 'error'); }
}

// ── SETTINGS ───────────────────────────────────────────
async function renderSettings() {
  if (APP_STATE.user.role !== 'owner') { document.getElementById('content').innerHTML = '<div class="empty-state"><p>Owner access required</p></div>'; return; }
  const orgs = await api('GET', '/orgs');

  document.getElementById('content').innerHTML = `
  <div class="tabs">
    <div class="tab active" onclick="settingsTab('orgs',this)">🏪 Organizations</div>
    <div class="tab" onclick="settingsTab('invoice-settings',this)">Invoice Settings</div>
    <div class="tab" onclick="settingsTab('transaction-controls',this)">Transaction Controls</div>
    <div class="tab" onclick="settingsTab('users',this)">👤 Users</div>
    <div class="tab" onclick="settingsTab('security',this)">🔒 Auto Lock</div>
    <div class="tab" onclick="settingsTab('backup-auto',this)">Automatic Backup</div>
    <div class="tab" onclick="settingsTab('year-lock',this)">Year Lock</div>
    <div class="tab" onclick="settingsTab('password',this)">🔐 Recovery Password</div>
  </div>
  <div id="settings-content">
    ${renderOrgsSettings(orgs)}
  </div>`;
}

function settingsTab(tab, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  if (tab === 'orgs') api('GET', '/orgs').then(orgs => { document.getElementById('settings-content').innerHTML = renderOrgsSettings(orgs); });
  if (tab === 'invoice-settings') renderInvoiceSettings();
  if (tab === 'transaction-controls') renderTransactionControlsSettings();
  if (tab === 'users') Promise.all([
    api('GET', '/auth/users'),
    String(APP_STATE.user?.username || '').toLowerCase() === 'owner1'
      ? api('GET', '/auth/users-audit') : Promise.resolve([])
  ]).then(([users,audit]) => {
    window.__userAudit = audit;
    document.getElementById('settings-content').innerHTML = renderUsersSettings(users);
  }).catch(error => {
    document.getElementById('settings-content').innerHTML = `<div class="error-msg">${esc(error.message)}</div>`;
  });
  if (tab === 'security') renderSecuritySettings();
  if (tab === 'backup-auto') renderAutomaticBackupSettings();
  if (tab === 'year-lock') renderYearLockSettings();
  if (tab === 'password') document.getElementById('settings-content').innerHTML = renderPasswordSettings();
}

async function renderTransactionControlsSettings(selectedType) {
  await loadTransactionControls();
  const meta = APP_STATE.transactionControlMeta || [];
  const type = selectedType || meta[0]?.type || 'SALE';
  const current = transactionControl(type);
  const typeMeta = meta.find(row => row.type === type) || { label: type, fields: [] };
  const checkbox = (kind, field, checked) =>
    `<input type="checkbox" class="tc-${kind}" data-field="${field}" ${checked ? 'checked' : ''} onchange="syncTransactionControlRow('${field}')">`;
  document.getElementById('settings-content').innerHTML = `
    <div class="card" style="max-width:980px;margin-top:16px">
      <div class="section-title">Transaction Controls - ${esc(APP_STATE.currentOrg?.display_name || '')}</div>
      <p class="security-setting-note">Owner controls are per company. Turning Show off hides the field, removes required validation, and omits it from printed output.</p>
      <div class="form-row cols-2">
        <div class="form-group"><label>Company</label><input value="${esc(APP_STATE.currentOrg?.display_name || '')}" readonly></div>
        <div class="form-group"><label>Transaction Type</label>
          <select id="tc-type" onchange="renderTransactionControlsSettings(this.value)">
            ${meta.map(row => `<option value="${row.type}" ${row.type === type ? 'selected' : ''}>${esc(row.label)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Field</th><th style="width:90px">Show</th><th style="width:110px">Required</th><th style="width:90px">Print</th></tr></thead>
          <tbody>
            ${typeMeta.fields.map(([field,label]) => `
              <tr data-tc-field="${field}">
                <td><strong>${esc(label)}</strong><div style="font-size:11px;color:var(--text3)">${esc(typeMeta.label)}</div></td>
                <td>${checkbox('show', field, current.form_options?.[field] !== false)}</td>
                <td>${checkbox('required', field, current.required_fields?.[field] === true && current.form_options?.[field] !== false)}</td>
                <td>${checkbox('print', field, current.print_options?.[field] !== false)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn btn-success" onclick="saveTransactionControls()">Save Transaction Controls</button>
        <button class="btn btn-secondary" onclick="resetTransactionControlType('${type}')">Reset This Type to Default</button>
      </div>
    </div>`;
  document.querySelectorAll('[data-tc-field]').forEach(row => syncTransactionControlRow(row.dataset.tcField));
}

function syncTransactionControlRow(field) {
  const row = document.querySelector(`[data-tc-field="${field}"]`);
  if (!row) return;
  const show = Boolean(row.querySelector('.tc-show')?.checked);
  const required = row.querySelector('.tc-required');
  const print = row.querySelector('.tc-print');
  if (required) {
    required.disabled = !show;
    if (!show) required.checked = false;
  }
  if (print && !show) print.checked = false;
}

async function saveTransactionControls() {
  const type = document.getElementById('tc-type')?.value;
  if (!type) return;
  const controls = Object.entries(APP_STATE.transactionControls || {}).map(([transaction_type, control]) => ({
    transaction_type,
    form_options: { ...(control.form_options || {}) },
    required_fields: { ...(control.required_fields || {}) },
    print_options: { ...(control.print_options || {}) }
  }));
  let selected = controls.find(row => row.transaction_type === type);
  if (!selected) {
    selected = { transaction_type: type, form_options: {}, required_fields: {}, print_options: {} };
    controls.push(selected);
  }
  document.querySelectorAll('[data-tc-field]').forEach(row => {
    const field = row.dataset.tcField;
    selected.form_options[field] = Boolean(row.querySelector('.tc-show')?.checked);
    selected.required_fields[field] = selected.form_options[field] && Boolean(row.querySelector('.tc-required')?.checked);
    selected.print_options[field] = selected.form_options[field] && Boolean(row.querySelector('.tc-print')?.checked);
  });
  try {
    await api('PUT', `/orgs/${APP_STATE.currentOrg.id}/transaction-controls`, { controls });
    await loadTransactionControls();
    toast('Transaction controls saved', 'success');
    renderTransactionControlsSettings(type);
  } catch (error) { toast(error.message, 'error'); }
}

function resetTransactionControlType(type) {
  const meta = APP_STATE.transactionControlMeta.find(row => row.type === type);
  if (!meta) return;
  const defaults = meta.defaults || {};
  meta.fields.forEach(([field]) => {
    const row = document.querySelector(`[data-tc-field="${field}"]`);
    if (!row) return;
    row.querySelector('.tc-show').checked = defaults.form_options?.[field] !== false;
    row.querySelector('.tc-required').checked = defaults.required_fields?.[field] === true;
    row.querySelector('.tc-print').checked = defaults.print_options?.[field] !== false;
    syncTransactionControlRow(field);
  });
  toast('Defaults loaded on screen. Click Save to apply.', 'info');
}

function renderOrgsSettings(orgs) {
  return `
  <div class="page-header" style="margin-top:16px">
    <h3>Organizations</h3>
    <button class="btn btn-primary btn-sm" onclick="showOrgModal()">+ Add Organization</button>
  </div>
  ${orgs.map(org => `
  <div class="card" style="margin-bottom:12px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between">
      <div>
        <div style="font-size:16px;font-weight:700">${esc(org.display_name)}</div>
        <div style="font-size:12px;color:var(--text2)">${esc(org.registered_name||'')} | ${esc(org.gstin||'No GSTIN')} | ${esc(org.gst_type||'')}</div>
        <div style="font-size:12px;color:var(--text3)">${esc(org.address||'')}</div>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="showOrgModal(${org.id})">✏ Edit</button>
    </div>
  </div>`).join('')}`;
}

function renderUsersSettings(users) {
  return `
  <div class="page-header" style="margin-top:16px">
    <h3>User Accounts</h3>
    <button class="btn btn-primary btn-sm" onclick="showUserModal()">+ Add User</button>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Org Access</th><th>Last Login</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>
        ${users.map(u => `<tr>
          <td>${esc(u.name)}</td>
          <td class="mono">${esc(u.username)}</td>
          <td><span class="badge badge-${u.role==='owner'?'saved':'converted'}">${u.role}</span></td>
          <td>${u.org_access === 'all' ? '🌐 All' : u.org_access}</td>
          <td>${fmtDate(u.last_login)}</td>
          <td><span class="badge ${u.active ? 'badge-saved' : 'badge-cancelled'}">${u.active ? 'Active' : 'Inactive'}</span></td>
          <td><button class="btn btn-xs btn-secondary" onclick="showUserModal(${u.id})">Edit</button></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
  ${String(APP_STATE.user?.username || '').toLowerCase() === 'owner1' ? `
    <div class="section-title" style="margin-top:22px">User Administration Audit</div>
    ${businessRegister('Recent User Changes',
      ['Time','Action','Performed By','Target User','Details'],
      (window.__userAudit || []).map(row => [
        fmtDate(row.timestamp), row.action, row.actor_username || '-', row.target_username || '-',
        esc(row.new_data || '-')
      ]))}` : ''}`;
}

function renderPasswordSettings() {
  return `
  <div class="card" style="max-width:400px;margin-top:16px">
    <div class="section-title">Change Recovery Password</div>
    <p class="text-muted">Use your PIN for normal login. This password is retained only for account recovery.</p>
    <div class="form-group"><label>Current Password</label><input type="password" id="pw-cur" placeholder="Current password"></div>
    <div class="form-group"><label>New Password</label><input type="password" id="pw-new" placeholder="New password (min 6 chars)"></div>
    <div class="form-group"><label>Confirm New Password</label><input type="password" id="pw-confirm" placeholder="Repeat new password"></div>
    <button class="btn btn-success" onclick="changePassword()">Update Password</button>
  </div>`;
}

function renderInvoiceSettings() {
  const org = APP_STATE.currentOrg || {};
  let prefixes = {};
  try { prefixes = JSON.parse(org.invoice_prefixes || '{}'); } catch (_) {}
  const printOptions = invoicePrintOptions(org);
  const code = String(org.display_name || 'ORG').replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase() || 'ORG';
  const prefixValue = (format, suffix) => prefixes[format] || `${code}-${suffix}`;
  document.getElementById('settings-content').innerHTML = `
    <div class="card" style="max-width:760px;margin-top:16px">
      <div class="section-title">Invoice Settings - ${esc(org.display_name || '')}</div>
      <div class="form-group"><label>Header / Note Above Items</label>
        <textarea id="is-note-header" placeholder="Optional text shown above invoice items">${esc(org.note_header || '')}</textarea></div>
      <div class="form-group"><label>Invoice Footer Note</label>
        <textarea id="is-note-footer" placeholder="Terms, thank-you note, or payment note">${esc(org.note_footer || '')}</textarea></div>
      <div class="form-group"><label>Default Bottom Description</label>
        <textarea id="is-description" placeholder="Default description for invoices">${esc(org.invoice_description || '')}</textarea></div>
      <div class="section-title" style="margin-top:18px">GST Rate Entry</div>
      <label class="security-setting-toggle">
        <input type="checkbox" id="is-tax-inclusive" ${Number(org.default_tax_inclusive || 0) ? 'checked' : ''}>
        <span><strong>Item rates include GST by default</strong>
        <small>Regular-taxpayer invoices open in Incl. GST mode and print “Rate (Incl. GST)”. You can still change an individual invoice.</small></span>
      </label>
      <div class="section-title" style="margin-top:18px">Company Print Theme</div>
      <p class="security-setting-note">Owner selection applies to this company's Sale Bills, Project Printing invoices, Quotations, Delivery Challans, Proforma Invoices and POS receipts.</p>
      <div class="invoice-theme-picker">
        ${[
          ['classic','Classic','Clean black and grey'],
          ['sapphire','Sapphire','Blue and violet'],
          ['emerald','Emerald','Green and teal'],
          ['sunset','Sunset','Orange, rose and gold'],
          ['common-gst','Common GST','Accounting-style ruled GST invoice']
        ].map(([value,label,note]) => `
          <label class="invoice-theme-choice theme-preview-${value}">
            <input type="radio" name="invoice-theme" value="${value}" ${invoiceTheme(org) === value ? 'checked' : ''}>
            <span class="theme-preview-band"></span>
            <strong>${label}</strong><small>${note}</small>
          </label>`).join('')}
      </div>
      <div class="section-title" style="margin-top:18px">Company Invoice Number Prefixes</div>
      <div class="form-row cols-3">
        <div class="form-group"><label>Sale Bill</label><input id="is-prefix-sale" maxlength="7" value="${esc(prefixValue('SALE','SB'))}"></div>
        <div class="form-group"><label>Project Printing</label><input id="is-prefix-pp" maxlength="7" value="${esc(prefixValue('PP','PP'))}"></div>
        <div class="form-group"><label>Quotation</label><input id="is-prefix-quot" maxlength="7" value="${esc(prefixValue('QUOT','QT'))}"></div>
        <div class="form-group"><label>Delivery Challan</label><input id="is-prefix-dc" maxlength="7" value="${esc(prefixValue('DC','DC'))}"></div>
        <div class="form-group"><label>Proforma Invoice</label><input id="is-prefix-pi" maxlength="7" value="${esc(prefixValue('PI','PI'))}"></div>
      </div>
        <p class="security-setting-note">Use up to 7 letters, numbers, hyphens or underscores. This keeps new invoice numbers within the GST portal's 16-character limit. Existing invoice numbers are not changed.</p>
      <div class="section-title" style="margin-top:18px">Invoice Output Print Options</div>
      <p class="security-setting-note">Owner selection applies to this company only and controls what appears on saved invoice previews and print/PDF output.</p>
      <div class="form-row cols-2">
        <label class="security-setting-toggle"><input type="checkbox" id="is-print-hsn" ${printOptions.hsn ? 'checked' : ''}>
          <span><strong>Print HSN Code</strong><small>Show HSN column and HSN-wise tax summary on regular GST invoices.</small></span></label>
        <label class="security-setting-toggle"><input type="checkbox" id="is-print-rate" ${printOptions.rate ? 'checked' : ''}>
          <span><strong>Print Item Rate</strong><small>Show the rate column. Amount column remains visible for totals.</small></span></label>
        <label class="security-setting-toggle"><input type="checkbox" id="is-print-tax-inclusive-value" ${printOptions.tax_inclusive_value ? 'checked' : ''}>
          <span><strong>Print Tax-Inclusive Value Note</strong><small>Show Incl. GST wording when invoice rates include GST.</small></span></label>
        <label class="security-setting-toggle"><input type="checkbox" id="is-print-bank-details" ${printOptions.bank_details ? 'checked' : ''}>
          <span><strong>Print Bank Account Details</strong><small>Show company bank, IFSC and UPI details in invoice footer.</small></span></label>
      </div>
      <div class="section-title" style="margin-top:18px">Project Printing Default Prices</div>
      <div class="form-row cols-3">
        <div class="form-group"><label>B/W Print Price</label><input type="number" min="0" step="0.01" id="is-bw-rate" value="${Number(org.project_bw_rate || 0)}"></div>
        <div class="form-group"><label>Colour Print Price</label><input type="number" min="0" step="0.01" id="is-colour-rate" value="${Number(org.project_colour_rate || 0)}"></div>
        <div class="form-group"><label>Book Cost</label><input type="number" min="0" step="0.01" id="is-book-rate" value="${Number(org.project_book_rate || 0)}"></div>
      </div>
      <div class="section-title" style="margin-top:18px">Invoice Security and Stock Controls</div>
      <div class="form-row cols-2">
        <div class="form-group"><label>Authorised Signature Image</label>
          <input type="file" id="is-signature-image" accept="image/*" onchange="invoiceSignaturePreview(this)">
          <div id="is-signature-preview">${org.signature_image ? `<img src="${org.signature_image}" style="max-height:70px">` : ''}</div></div>
        <div>
          <label class="security-setting-toggle"><input type="checkbox" id="is-qr-enabled" ${org.invoice_qr_enabled !== 0 ? 'checked' : ''}>
            <span><strong>Invoice QR Code</strong><small>Print invoice number, date, seller, GSTIN and total as a QR code.</small></span></label>
          <label class="security-setting-toggle"><input type="checkbox" id="is-negative-stock" checked disabled>
            <span><strong>Negative Stock Billing Enabled</strong><small>Invoices always save. Low or negative stock remains visible as a warning.</small></span></label>
        </div>
      </div>
      <button class="btn btn-success" onclick="saveInvoiceSettings()">Save Invoice Settings</button>
    </div>`;
}

async function saveInvoiceSettings() {
  const org = APP_STATE.currentOrg;
  try {
    await api('PUT', `/orgs/${org.id}`, {
      ...org,
      note_header: document.getElementById('is-note-header').value,
      note_footer: document.getElementById('is-note-footer').value,
      invoice_description: document.getElementById('is-description').value,
      project_bw_rate: Number(document.getElementById('is-bw-rate').value || 0),
      project_colour_rate: Number(document.getElementById('is-colour-rate').value || 0),
      project_book_rate: Number(document.getElementById('is-book-rate').value || 0),
      signature_image: document.getElementById('is-signature-image')?.dataset.b64 || org.signature_image || null,
      invoice_qr_enabled: document.getElementById('is-qr-enabled').checked,
      negative_stock_allowed: document.getElementById('is-negative-stock').checked,
      default_tax_inclusive: document.getElementById('is-tax-inclusive').checked,
      invoice_theme: document.querySelector('input[name="invoice-theme"]:checked')?.value || 'classic',
      invoice_prefixes: {
        SALE: document.getElementById('is-prefix-sale').value,
        PP: document.getElementById('is-prefix-pp').value,
        QUOT: document.getElementById('is-prefix-quot').value,
        DC: document.getElementById('is-prefix-dc').value,
        PI: document.getElementById('is-prefix-pi').value
      },
      invoice_print_options: {
        hsn: document.getElementById('is-print-hsn').checked,
        rate: document.getElementById('is-print-rate').checked,
        tax_inclusive_value: document.getElementById('is-print-tax-inclusive-value').checked,
        bank_details: document.getElementById('is-print-bank-details').checked
      }
    });
    await loadOrgs();
    toast('Invoice settings saved', 'success');
    renderInvoiceSettings();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function invoiceSignaturePreview(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = event => {
    input.dataset.b64 = event.target.result;
    document.getElementById('is-signature-preview').innerHTML =
      `<img src="${event.target.result}" style="max-height:70px">`;
  };
  reader.readAsDataURL(file);
}

async function renderSecuritySettings() {
  try {
    const settings = await api('GET', '/auth/security-settings');
    document.getElementById('settings-content').innerHTML = `
      <div class="card" style="max-width:650px;margin-top:16px">
        <div class="section-title">Automatic Idle Lock</div>
        <label class="security-setting-toggle">
          <input type="checkbox" id="security-enabled" ${settings.enabled ? 'checked' : ''}>
          <span><strong>Enable automatic application lock</strong>
          <small>Locks every connected computer after its configured period of no activity.</small></span>
        </label>
        <div class="form-row cols-2" style="margin-top:18px">
          <div class="form-group">
            <label>Lock After No Activity</label>
            <select id="security-minutes">
              ${[1,2,5,10,15,20,30,45,60,120].map(value =>
                `<option value="${value}" ${Number(settings.minutes) === value ? 'selected' : ''}>${value} minute${value === 1 ? '' : 's'}</option>`).join('')}
              ${![1,2,5,10,15,20,30,45,60,120].includes(Number(settings.minutes)) ?
                `<option value="${settings.minutes}" selected>${settings.minutes} minutes</option>` : ''}
            </select>
          </div>
          <div class="form-group">
            <label>Warning Notice Before Lock</label>
            <select id="security-warning">
              ${[10,15,30,45,60,90,120,180,300].map(value =>
                `<option value="${value}" ${Number(settings.warning_seconds) === value ? 'selected' : ''}>${value} seconds</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="security-setting-note">
          The user receives a countdown notice before locking. Unlocking requires the password of the currently signed-in user.
          Current billing screens and unsaved form contents remain open behind the security lock.
        </div>
        <div style="display:flex;gap:8px;margin-top:16px">
          <button class="btn btn-success" onclick="saveSecuritySettings()">Save Security Settings</button>
          <button class="btn btn-secondary" onclick="lockApplication('settings_test')">Lock Now / Test</button>
        </div>
      </div>`;
  } catch (e) {
    document.getElementById('settings-content').innerHTML = `<div class="error-msg">${esc(e.message)}</div>`;
  }
}

async function saveSecuritySettings() {
  try {
    const result = await api('PUT', '/auth/security-settings', {
      enabled: document.getElementById('security-enabled').checked,
      minutes: Number(document.getElementById('security-minutes').value),
      warning_seconds: Number(document.getElementById('security-warning').value)
    });
    SECURITY_POLICY = result;
    lastActivityAt = Date.now();
    startIdleSecurityMonitor();
    toast('Automatic lock settings saved for all computers', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function changePassword() {
  const cur = document.getElementById('pw-cur').value;
  const nw = document.getElementById('pw-new').value;
  const cf = document.getElementById('pw-confirm').value;
  if (!cur || !nw) { toast('Fill all fields', 'error'); return; }
  if (nw !== cf) { toast('Passwords do not match', 'error'); return; }
  try {
    await api('POST', '/auth/change-password', { current_password: cur, new_password: nw });
    toast('Password changed! Please login again.', 'success');
    setTimeout(doLogout, 2000);
  } catch(e) { toast(e.message, 'error'); }
}

function showOrgModal(orgId) {
  const org = orgId ? APP_STATE.orgs.find(o => o.id === orgId) : null;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'org-modal';
  modal.innerHTML = `
    <div class="modal-box modal-medium">
      <div class="modal-header">
        <h3>${org ? 'Edit Organization' : 'Add Organization'}</h3>
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('org-modal').remove()">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-row cols-2">
          <div class="form-group"><label>Display Name *</label><input type="text" id="om-dname" value="${esc(org?.display_name||'')}"></div>
          <div class="form-group"><label>Registered Name</label><input type="text" id="om-rname" value="${esc(org?.registered_name||'')}"></div>
        </div>
        <div class="form-group"><label>Address</label><textarea id="om-addr">${esc(org?.address||'')}</textarea></div>
        <div class="form-row cols-2">
          <div class="form-group"><label>Phone</label><input type="text" id="om-phone" value="${esc(org?.phone||'')}"></div>
          <div class="form-group"><label>Email</label><input type="email" id="om-email" value="${esc(org?.email||'')}"></div>
        </div>
        <div class="form-row cols-2">
          <div class="form-group"><label>GSTIN</label><input type="text" id="om-gstin" value="${esc(org?.gstin||'')}" style="text-transform:uppercase"></div>
          <div class="form-group"><label>GST Type</label>
            <select id="om-gsttype">
              <option value="regular" ${org?.gst_type==='regular'?'selected':''}>Regular (18% GST)</option>
              <option value="composition" ${org?.gst_type==='composition'?'selected':''}>Composition (Bill of Supply, no GST)</option>
            </select>
          </div>
        </div>
        <div class="section-title" style="margin-top:8px">Bank Details</div>
        <div class="form-row cols-2">
          <div class="form-group"><label>Bank Name</label><input type="text" id="om-bank" value="${esc(org?.bank_name||'')}"></div>
          <div class="form-group"><label>Account Number</label><input type="text" id="om-accno" value="${esc(org?.account_no||'')}"></div>
        </div>
        <div class="form-row cols-3">
          <div class="form-group"><label>Branch</label><input type="text" id="om-branch" value="${esc(org?.branch||'')}"></div>
          <div class="form-group"><label>IFSC Code</label><input type="text" id="om-ifsc" value="${esc(org?.ifsc||'')}"></div>
          <div class="form-group"><label>UPI ID</label><input type="text" id="om-upi" value="${esc(org?.upi_id||'')}"></div>
        </div>
        <div class="form-group"><label>Signature Name (e.g. For Shop Name)</label><input type="text" id="om-signame" value="${esc(org?.signature_name||'')}"></div>
        <div class="form-group">
          <label>Logo</label>
          <input type="file" id="om-logo" accept="image/*" onchange="previewLogo(this)">
          <small class="text-muted">After choosing an image, crop, reposition and resize it for invoice printing.</small>
          <div id="om-logo-preview" style="margin-top:8px">${org?.logo_base64 ? `<img src="${org.logo_base64}" style="height:60px;border-radius:4px">` : ''}</div>
        </div>
        <button class="btn btn-success" onclick="saveOrg(${orgId||'null'})">${org ? 'Update' : 'Add Organization'}</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function previewLogo(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    openLogoEditor(e.target.result, input);
  };
  reader.readAsDataURL(file);
}

let logoEditorState = null;

function openLogoEditor(source, input) {
  const image = new Image();
  image.onload = () => {
    logoEditorState = { image, input, zoom: 1, x: 0, y: 0 };
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'logo-editor-modal';
    modal.innerHTML = `<div class="modal-box modal-medium">
      <div class="modal-header"><h3>Crop and Resize Logo</h3>
        <button class="btn btn-secondary btn-sm" onclick="closeLogoEditor()">Close</button></div>
      <div class="modal-body">
        <canvas id="logo-editor-canvas" width="600" height="300"></canvas>
        <div class="form-row cols-3" style="margin-top:14px">
          <div class="form-group"><label>Size / Zoom</label><input type="range" min="50" max="250" value="100" oninput="updateLogoEditor('zoom',this.value)"></div>
          <div class="form-group"><label>Horizontal Position</label><input type="range" min="-100" max="100" value="0" oninput="updateLogoEditor('x',this.value)"></div>
          <div class="form-group"><label>Vertical Position</label><input type="range" min="-100" max="100" value="0" oninput="updateLogoEditor('y',this.value)"></div>
        </div>
        <p class="security-setting-note">The saved logo is resized to 600 × 300 pixels for clear invoices without storing the original large image.</p>
        <button class="btn btn-success" onclick="applyLogoCrop()">Use Cropped Logo</button>
      </div></div>`;
    document.body.appendChild(modal);
    drawLogoEditor();
  };
  image.onerror = () => toast('This logo image could not be opened', 'error');
  image.src = source;
}

function updateLogoEditor(key, value) {
  if (!logoEditorState) return;
  logoEditorState[key] = key === 'zoom' ? Number(value) / 100 : Number(value) / 100;
  drawLogoEditor();
}

function drawLogoEditor() {
  const canvas = document.getElementById('logo-editor-canvas');
  if (!canvas || !logoEditorState) return;
  const context = canvas.getContext('2d');
  const { image, zoom, x, y } = logoEditorState;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const baseScale = Math.max(canvas.width / image.width, canvas.height / image.height);
  const scale = baseScale * zoom;
  const width = image.width * scale;
  const height = image.height * scale;
  const left = (canvas.width - width) / 2 + x * Math.max(0, width - canvas.width) / 2;
  const top = (canvas.height - height) / 2 + y * Math.max(0, height - canvas.height) / 2;
  context.drawImage(image, left, top, width, height);
  context.strokeStyle = '#087f86';
  context.lineWidth = 4;
  context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
}

function applyLogoCrop() {
  const canvas = document.getElementById('logo-editor-canvas');
  if (!canvas || !logoEditorState) return;
  const value = canvas.toDataURL('image/png', 0.92);
  logoEditorState.input.dataset.b64 = value;
  document.getElementById('om-logo-preview').innerHTML =
    `<img src="${value}" style="max-width:240px;max-height:90px;object-fit:contain;border-radius:4px">`;
  closeLogoEditor();
}

function closeLogoEditor() {
  document.getElementById('logo-editor-modal')?.remove();
  logoEditorState = null;
}

async function saveOrg(id) {
  const dname = document.getElementById('om-dname').value.trim();
  if (!dname) { toast('Display name required', 'error'); return; }
  const logoInput = document.getElementById('om-logo');
  const logo = logoInput.dataset.b64 || null;
  const existing = id ? APP_STATE.orgs.find(org => Number(org.id) === Number(id)) : {};
  const payload = {
    display_name: dname,
    registered_name: document.getElementById('om-rname').value,
    address: document.getElementById('om-addr').value,
    phone: document.getElementById('om-phone').value,
    email: document.getElementById('om-email').value,
    gstin: document.getElementById('om-gstin').value.toUpperCase(),
    gst_type: document.getElementById('om-gsttype').value,
    bank_name: document.getElementById('om-bank').value,
    account_no: document.getElementById('om-accno').value,
    branch: document.getElementById('om-branch').value,
    ifsc: document.getElementById('om-ifsc').value,
    upi_id: document.getElementById('om-upi').value,
    note_header: existing?.note_header || '',
    note_footer: existing?.note_footer || '',
    invoice_description: existing?.invoice_description || '',
    project_bw_rate: Number(existing?.project_bw_rate || 0),
    project_colour_rate: Number(existing?.project_colour_rate || 0),
    project_book_rate: Number(existing?.project_book_rate || 0),
    signature_image: existing?.signature_image || null,
    invoice_qr_enabled: existing?.invoice_qr_enabled !== 0,
    negative_stock_allowed: Boolean(existing?.negative_stock_allowed),
    default_tax_inclusive: Boolean(existing?.default_tax_inclusive),
    invoice_theme: invoiceTheme(existing),
    invoice_prefixes: (() => {
      try { return JSON.parse(existing?.invoice_prefixes || '{}'); } catch (_) { return {}; }
    })(),
    signature_name: document.getElementById('om-signame').value,
    logo_base64: logo
  };
  try {
    if (id) { await api('PUT', `/orgs/${id}`, payload); toast('Organization updated', 'success'); }
    else { await api('POST', '/orgs', payload); toast('Organization added', 'success'); }
    document.getElementById('org-modal')?.remove();
    await loadOrgs();
    renderSettings();
  } catch(e) { toast(e.message, 'error'); }
}

function showUserModal(userId) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'user-modal';
  modal.innerHTML = `
    <div class="modal-box modal-small">
      <div class="modal-header"><h3>${userId ? 'Edit User' : 'Add User'}</h3>
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('user-modal').remove()">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group"><label>Full Name *</label><input type="text" id="um-name" placeholder="e.g. Raj Kumar"></div>
        <div class="form-group"><label>Username *</label><input type="text" id="um-uname" placeholder="e.g. raj"></div>
        ${!userId ? `<div class="form-group"><label>Login PIN *</label>
          <input type="password" inputmode="numeric" maxlength="6" id="um-pin" placeholder="4-6 digits"></div>` : ''}
        <div class="form-group"><label>Role</label>
          <select id="um-role">
            <option value="owner">Owner (Full access)</option>
            <option value="counter">Counter</option>
            <option value="operator">Operator</option>
            <option value="senior_operator">Senior Operator</option>
            <option value="engineer">Engineer / Technician</option>
          </select>
        </div>
        <div class="form-group"><label>Organization Access</label>
          <select id="um-orgaccess">
            <option value="all">All Organizations</option>
            ${APP_STATE.orgs.map(o => `<option value="[${o.id}]">${esc(o.display_name)} only</option>`).join('')}
          </select>
        </div>
        <label class="security-setting-toggle"><input type="checkbox" id="um-active" checked>
          <span><strong>Active user</strong><small>Inactive users cannot sign in.</small></span></label>
        ${userId && String(APP_STATE.user?.username || '').toLowerCase() === 'owner1'
          ? `<div class="section-title" style="margin-top:16px">Assign / Reset PIN</div>
             <div class="form-row cols-2">
               <div class="form-group"><label>New PIN</label>
                 <input type="password" inputmode="numeric" maxlength="6" id="um-reset-pin" placeholder="Leave blank to keep current PIN"></div>
               <div class="form-group"><label>Confirm PIN</label>
                 <input type="password" inputmode="numeric" maxlength="6" id="um-reset-confirm" placeholder="Repeat PIN"></div>
             </div>` : ''}
        <button class="btn btn-success" onclick="saveUser(${userId||'null'})">${userId ? 'Update' : 'Add User'}</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function saveUser(id) {
  const name = document.getElementById('um-name').value.trim();
  const username = document.getElementById('um-uname').value.trim();
  if (!name || !username) { toast('Name and username required', 'error'); return; }
  const payload = {
    name, username, role: document.getElementById('um-role').value,
    org_access: document.getElementById('um-orgaccess').value,
    active: document.getElementById('um-active').checked
  };
  if (!id) { payload.pin = document.getElementById('um-pin').value; }
  try {
    if (id) { await api('PUT', `/auth/users/${id}`, payload); toast('User updated', 'success'); }
    else { await api('POST', '/auth/users', payload); toast('User added', 'success'); }
    document.getElementById('user-modal')?.remove();
    renderSettings();
  } catch(e) { toast(e.message, 'error'); }
}

// ── NUMBER TO WORDS (client side) ─────────────────────
// BUSINESS UPGRADES
let businessItems = [];

function businessCompanyBar(numberId, label) {
  return `<div class="voucher-access-bar">
    <div class="form-group"><label>Voucher Company</label>
      <select id="voucher-org">${voucherCompanyOptions(APP_STATE.currentOrg.id)}</select></div>
    <div class="form-group"><label>${label}</label><input id="${numberId}" readonly value="Loading..."></div>
    <div class="voucher-company-summary"><span>Company</span><strong>${esc(APP_STATE.currentOrg.display_name)}</strong></div>
  </div>`;
}

function regularTaxCheckbox(id, onchange = '') {
  if (APP_STATE.currentOrg?.gst_type !== 'regular') return '';
  const checked = Number(APP_STATE.currentOrg.default_tax_inclusive || 0) ? 'checked' : '';
  return `<label class="security-setting-note" style="display:flex;align-items:center;gap:8px">
    <input type="checkbox" id="${id}" ${checked} ${onchange ? `onchange="${onchange}"` : ''}>
    <strong>Rates include GST</strong>
  </label>`;
}

function roundOffCheckbox(id, onchange = '') {
  return `<label class="security-setting-note" style="display:flex;align-items:center;gap:8px">
    <input type="checkbox" id="${id}" checked ${onchange ? `onchange="${onchange}"` : ''}>
    <strong>Round off final total to nearest rupee</strong>
  </label>`;
}

async function businessNextNumber(type, dateId, outputId) {
  const orgId = document.getElementById('voucher-org')?.value || APP_STATE.currentOrg.id;
  const date = document.getElementById(dateId)?.value || today();
  const result = await api('GET', `/business/next-number?org_id=${orgId}&type=${type}&date=${date}`);
  const output = document.getElementById(outputId);
  if (output) output.value = result.number;
}

function resetBusinessItems() {
  businessItems = [{ item_id: '', qty: 1, rate: 0, gst_rate: 18 }];
}

function renderBusinessItems() {
  const container = document.getElementById('business-items');
  if (!container) return;
  container.innerHTML = businessItems.map((row, index) => `
    <div class="business-item-row">
      <select id="bi-item-${index}" onchange="selectBusinessItem(${index},this.value)">
        <option value="">Select item</option>
        ${APP_STATE.items.map(item => `<option value="${item.id}" ${Number(row.item_id) === Number(item.id) ? 'selected' : ''}>
          ${esc(item.name)}${item.model_number ? ` - ${esc(item.model_number)}` : ''}</option>`).join('')}
      </select>
      <input type="number" id="bi-qty-${index}" value="${row.qty}" min="0" step="0.001" placeholder="Qty">
      <input type="number" id="bi-rate-${index}" value="${row.rate}" min="0" step="0.01" placeholder="Rate">
      <input type="number" id="bi-gst-${index}" value="${row.gst_rate}" min="0" step="0.01" placeholder="GST%">
      <button class="btn btn-xs btn-danger" onclick="removeBusinessItem(${index})">Remove</button>
    </div>`).join('');
  applyBusinessControlVisibility(window.__activeBusinessControlType || '');
}

function selectBusinessItem(index, itemId) {
  const item = APP_STATE.items.find(row => Number(row.id) === Number(itemId));
  businessItems[index] = {
    item_id: Number(itemId) || '',
    qty: Number(document.getElementById(`bi-qty-${index}`)?.value || 1),
    rate: Number(item?.last_purchase_price || item?.last_sale_price || 0),
    gst_rate: Number(item?.gst_rate || 0)
  };
  renderBusinessItems();
}

function collectBusinessItems() {
  businessItems = businessItems.map((row, index) => {
    const item = APP_STATE.items.find(value => Number(value.id) === Number(document.getElementById(`bi-item-${index}`)?.value));
    return {
      item_id: Number(document.getElementById(`bi-item-${index}`)?.value) || null,
      item_name: item?.name || '', hsn_code: item?.hsn_code || '', unit: item?.unit || 'NOS',
      qty: Number(document.getElementById(`bi-qty-${index}`)?.value || 0),
      rate: Number(document.getElementById(`bi-rate-${index}`)?.value || 0),
      gst_rate: Number(document.getElementById(`bi-gst-${index}`)?.value || 0)
    };
  });
  return businessItems.filter(row => row.item_id && row.qty > 0);
}

function addBusinessItem() {
  collectBusinessItems();
  businessItems.push({ item_id: '', qty: 1, rate: 0, gst_rate: 18 });
  renderBusinessItems();
}

function removeBusinessItem(index) {
  collectBusinessItems();
  businessItems.splice(index, 1);
  if (!businessItems.length) resetBusinessItems();
  renderBusinessItems();
}

function businessRegister(title, headers, rows) {
  return `<div class="card" style="margin-top:16px"><div class="page-header"><h3>${title}</h3>
    <div><button class="btn btn-sm btn-secondary" onclick="exportVisibleTable('${title}')">Export Excel</button>
    <button class="btn btn-sm btn-secondary" onclick="window.print()">Print / PDF</button></div></div>
    <div class="table-wrap"><table><thead><tr>${headers.map(header => `<th>${esc(header)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(row => `<tr>${row.map(cell => {
        const text = String(cell ?? '');
        return `<td>${text.trim().startsWith('<') ? text : esc(text)}</td>`;
      }).join('')}</tr>`).join('') || `<tr><td colspan="${headers.length}" class="empty-state">No transactions</td></tr>`}
      </tbody></table></div></div>`;
}

function applyBusinessControlVisibility(type) {
  if (!type) return;
  if (type === 'PURCHASE') {
    setInputGroupVisible('purchase-party', txShow(type, 'party'));
    setInputGroupVisible('purchase-supplier-invoice', txShow(type, 'supplier_invoice'));
    setInputGroupVisible('purchase-mode', txShow(type, 'payment_mode'));
    setInputGroupVisible('purchase-narration', txShow(type, 'footer'));
    setElementVisible(document.getElementById('purchase-tax-inclusive')?.closest('label'), txShow(type, 'tax_inclusive'));
    setElementVisible(document.getElementById('purchase-round-off')?.closest('label'), txShow(type, 'round_off'));
  }
  if (type === 'PO') {
    setInputGroupVisible('po-party', txShow(type, 'party'));
    setInputGroupVisible('po-expected', txShow(type, 'expected_date'));
    setInputGroupVisible('po-narration', txShow(type, 'footer'));
    setElementVisible(document.getElementById('po-tax-inclusive')?.closest('label'), txShow(type, 'tax_inclusive'));
    setElementVisible(document.getElementById('po-round-off')?.closest('label'), txShow(type, 'round_off'));
  }
  if (type === 'EXPENSE') {
    setInputGroupVisible('expense-party', txShow(type, 'party'));
    setInputGroupVisible('expense-account', txShow(type, 'account_codes'));
    setInputGroupVisible('expense-mode', txShow(type, 'payment_mode'));
    setInputGroupVisible('expense-amount', txShow(type, 'amount'));
    setInputGroupVisible('expense-gst-rate', txShow(type, 'gst_split'));
    setInputGroupVisible('expense-gst', txShow(type, 'gst_split'));
    setInputGroupVisible('expense-reference', txShow(type, 'reference'));
    setInputGroupVisible('expense-narration', txShow(type, 'footer'));
    setElementVisible(document.getElementById('expense-tax-inclusive')?.closest('label'), txShow(type, 'tax_inclusive'));
    setElementVisible(document.getElementById('expense-round-off')?.closest('label'), txShow(type, 'round_off'));
  }
  if (type === 'CN' || type === 'DN') {
    setInputGroupVisible('note-party', txShow(type, 'party'));
    setInputGroupVisible('note-narration', txShow(type, 'reason') || txShow(type, 'footer'));
    setElementVisible(document.getElementById('note-tax-inclusive')?.closest('label'), txShow(type, 'tax_inclusive'));
    setElementVisible(document.getElementById('note-round-off')?.closest('label'), txShow(type, 'round_off'));
  }
  document.querySelectorAll('[id^="bi-qty-"]').forEach(el => setElementVisible(el, txShow(type, 'qty_unit')));
  document.querySelectorAll('[id^="bi-rate-"]').forEach(el => setElementVisible(el, txShow(type, 'rate')));
  document.querySelectorAll('[id^="bi-gst-"]').forEach(el => setElementVisible(el, txShow(type, 'gst_split')));
}

function requireBusinessVisibleFields(type, body) {
  const items = body.items || [];
  return requireVisibleFields(type, [
    { field: 'party', label: 'Party', valid: () => Boolean(body.party_id) },
    { field: 'supplier_invoice', label: 'Supplier Invoice / Reference', valid: () => Boolean(body.supplier_invoice) },
    { field: 'expected_date', label: 'Expected Date', valid: () => Boolean(body.expected_date) },
    { field: 'account_codes', label: 'Account', valid: () => Boolean(body.account_id) },
    { field: 'payment_mode', label: 'Payment Mode', valid: () => Boolean(body.payment_mode) },
    { field: 'reference', label: 'Reference Number', valid: () => Boolean(body.reference) },
    { field: 'reason', label: 'Reason / Narration', valid: () => Boolean(body.narration) },
    { field: 'footer', label: 'Narration', valid: () => Boolean(body.narration) },
    { field: 'qty_unit', label: 'Qty / Unit', valid: () => type === 'EXPENSE' || items.every(item => Number(item.qty || 0) > 0) },
    { field: 'rate', label: 'Rate', valid: () => type === 'EXPENSE' || items.every(item => Number(item.rate || 0) > 0) },
    { field: 'amount', label: 'Amount', valid: () => type === 'EXPENSE' ? Number(body.amount || 0) > 0 : items.length > 0 }
  ]);
}

async function renderPurchases() {
  window.__activeBusinessControlType = 'PURCHASE';
  resetBusinessItems();
  const rows = await api('GET', `/business/purchases?org_id=${APP_STATE.currentOrg.id}&fy=${APP_STATE.currentFY}`);
  document.getElementById('content').innerHTML = `
    ${businessCompanyBar('purchase-number','Purchase Voucher Number')}
    <div class="card business-form"><div class="section-title">Vendor Invoice</div>
      <div class="form-row cols-4">
        <div class="form-group"><label>Date</label><input type="date" id="purchase-date" value="${today()}" onchange="businessNextNumber('PURCHASE','purchase-date','purchase-number')"></div>
        <div class="form-group"><label>Vendor</label><select id="purchase-party"><option value="">Select vendor</option>${APP_STATE.parties.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
        <div class="form-group"><label>Supplier Invoice No.</label><input id="purchase-supplier-invoice"></div>
        <div class="form-group"><label>Payment</label><select id="purchase-mode"><option value="credit">Credit</option><option value="cash">Cash</option><option value="account">Bank / UPI</option></select></div>
      </div>
      <div id="business-items"></div><button class="btn btn-secondary btn-sm" onclick="addBusinessItem()">+ Add Item</button>
      ${regularTaxCheckbox('purchase-tax-inclusive')}
      ${roundOffCheckbox('purchase-round-off')}
      <div class="form-group" style="margin-top:12px"><label>Narration</label><input id="purchase-narration"></div>
      <button class="btn btn-success" onclick="savePurchase()">Save Purchase Bill</button>
    </div>
    ${businessRegister('Purchase Register',['Date','Voucher','Supplier Invoice','Vendor','Taxable','Tax','Total','Action'],
      rows.map(row => [fmtDate(row.purchase_date),row.purchase_number,row.supplier_invoice||'-',row.party_name||'-',
        fmt(row.taxable_amount),fmt(row.total_tax),fmt(row.grand_total),
        `<button class="btn btn-xs btn-outline" onclick="showDuplicateVoucher('purchase',${row.id},'purchase')">Duplicate</button>`]))}`;
  renderBusinessItems();
  applyBusinessControlVisibility('PURCHASE');
  businessNextNumber('PURCHASE','purchase-date','purchase-number');
}

async function savePurchase() {
  const items = collectBusinessItems();
  if (!items.length) return toast('Add at least one purchase item', 'error');
  if (!requireBusinessVisibleFields('PURCHASE', {
    party_id: document.getElementById('purchase-party')?.value,
    supplier_invoice: document.getElementById('purchase-supplier-invoice')?.value,
    payment_mode: document.getElementById('purchase-mode')?.value,
    narration: document.getElementById('purchase-narration')?.value,
    items
  })) return;
  try {
    await api('POST','/business/purchases',{
      org_id:Number(document.getElementById('voucher-org').value), purchase_date:document.getElementById('purchase-date').value,
      party_id:document.getElementById('purchase-party').value || null,
      supplier_invoice:document.getElementById('purchase-supplier-invoice').value,
      payment_mode:document.getElementById('purchase-mode').value,
      narration:document.getElementById('purchase-narration').value,
      tax_inclusive:Boolean(document.getElementById('purchase-tax-inclusive')?.checked), items
      ,round_off_enabled:Boolean(document.getElementById('purchase-round-off')?.checked)
    });
    toast('Purchase bill saved and stock updated','success');
    await loadMasterData(); renderPurchases();
  } catch (error) { toast(error.message,'error'); }
}

async function renderExpenses() {
  window.__activeBusinessControlType = 'EXPENSE';
  const [rows, accounts] = await Promise.all([
    api('GET',`/business/expenses?org_id=${APP_STATE.currentOrg.id}&fy=${APP_STATE.currentFY}`),
    api('GET',`/accounting/accounts?org_id=${APP_STATE.currentOrg.id}`)
  ]);
  const expenseAccounts = accounts.filter(account => account.type === 'expense');
  document.getElementById('content').innerHTML = `
    ${businessCompanyBar('expense-number','Expense Voucher Number')}
    <div class="card business-form"><div class="section-title">Expense Entry</div>
      <div class="form-row cols-4">
        <div class="form-group"><label>Date</label><input type="date" id="expense-date" value="${today()}" onchange="businessNextNumber('EXPENSE','expense-date','expense-number')"></div>
        <div class="form-group"><label>Expense Category</label><select id="expense-account">${expenseAccounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
        <div class="form-group"><label>Payee</label><select id="expense-party"><option value="">No party</option>${APP_STATE.parties.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
        <div class="form-group"><label>Payment Mode</label><select id="expense-mode"><option value="cash">Cash</option><option value="account">Bank / UPI</option></select></div>
      </div>
      <div class="form-row cols-4">
        <div class="form-group"><label>Total Amount</label><input type="number" id="expense-amount" step="0.01" oninput="recalcExpenseGST()"></div>
        <div class="form-group"><label>GST Rate %</label><input type="number" id="expense-gst-rate" value="${APP_STATE.currentOrg.gst_type === 'regular' ? 18 : 0}" step="0.01" oninput="recalcExpenseGST()"></div>
        <div class="form-group"><label>Input GST Amount</label><input type="number" id="expense-gst" value="0" step="0.01"></div>
        <div class="form-group"><label>Reference</label><input id="expense-reference"></div>
        <div class="form-group"><label>Narration</label><input id="expense-narration"></div>
      </div>${regularTaxCheckbox('expense-tax-inclusive','recalcExpenseGST()')}
      ${roundOffCheckbox('expense-round-off')}
      <button class="btn btn-success" onclick="saveExpense()">Save Expense Voucher</button>
    </div>
    ${businessRegister('Expense Register',['Date','Voucher','Account','Payee','Mode','GST','Amount','Action'],
      rows.map(row => [fmtDate(row.expense_date),row.expense_number,row.account_name,row.party_name||'-',row.payment_mode,
        fmt(row.gst_amount),fmt(row.amount),
        `<button class="btn btn-xs btn-outline" onclick="showDuplicateVoucher('expense',${row.id},'expense')">Duplicate</button>`]))}`;
  applyBusinessControlVisibility('EXPENSE');
  businessNextNumber('EXPENSE','expense-date','expense-number');
}

function recalcExpenseGST() {
  const amount = Number(document.getElementById('expense-amount')?.value || 0);
  const rate = Number(document.getElementById('expense-gst-rate')?.value || 0);
  const inclusive = Boolean(document.getElementById('expense-tax-inclusive')?.checked);
  const gst = inclusive && rate > 0 ? amount * rate / (100 + rate) : amount * rate / 100;
  const input = document.getElementById('expense-gst');
  if (input) input.value = gst.toFixed(2);
}

async function saveExpense() {
  if (!requireBusinessVisibleFields('EXPENSE', {
    party_id: document.getElementById('expense-party')?.value,
    account_id: document.getElementById('expense-account')?.value,
    payment_mode: document.getElementById('expense-mode')?.value,
    amount: Number(document.getElementById('expense-amount')?.value || 0),
    reference: document.getElementById('expense-reference')?.value,
    narration: document.getElementById('expense-narration')?.value,
    items: []
  })) return;
  try {
    await api('POST','/business/expenses',{
      org_id:Number(document.getElementById('voucher-org').value), expense_date:document.getElementById('expense-date').value,
      account_id:Number(document.getElementById('expense-account').value), party_id:document.getElementById('expense-party').value || null,
      payment_mode:document.getElementById('expense-mode').value, amount:Number(document.getElementById('expense-amount').value),
      gst_amount:Number(document.getElementById('expense-gst').value || 0), reference:document.getElementById('expense-reference').value,
      gst_rate:Number(document.getElementById('expense-gst-rate').value || 0),
      tax_inclusive:Boolean(document.getElementById('expense-tax-inclusive')?.checked),
      round_off_enabled:Boolean(document.getElementById('expense-round-off')?.checked),
      narration:document.getElementById('expense-narration').value
    });
    toast('Expense voucher saved','success'); renderExpenses();
  } catch (error) { toast(error.message,'error'); }
}

async function renderNotes() {
  window.__activeBusinessControlType = 'CN';
  resetBusinessItems();
  const rows = await api('GET',`/business/notes?org_id=${APP_STATE.currentOrg.id}&fy=${APP_STATE.currentFY}`);
  document.getElementById('content').innerHTML = `
    ${businessCompanyBar('note-number','Credit Note Number')}
    <div class="card business-form"><div class="section-title">Sales Return / Purchase Return</div>
      <div class="form-row cols-3">
        <div class="form-group"><label>Note Type</label><select id="note-type" onchange="window.__activeBusinessControlType=this.value==='credit'?'CN':'DN';applyBusinessControlVisibility(window.__activeBusinessControlType);businessNextNumber(this.value==='credit'?'CREDIT_NOTE':'DEBIT_NOTE','note-date','note-number')">
          <option value="credit">Credit Note - Customer Return</option><option value="debit">Debit Note - Vendor Return</option></select></div>
        <div class="form-group"><label>Date</label><input type="date" id="note-date" value="${today()}"></div>
        <div class="form-group"><label>Party</label><select id="note-party">${APP_STATE.parties.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
      </div>
      <div id="business-items"></div><button class="btn btn-secondary btn-sm" onclick="addBusinessItem()">+ Add Returned Item</button>
      ${regularTaxCheckbox('note-tax-inclusive')}
      ${roundOffCheckbox('note-round-off')}
      <div class="form-group" style="margin-top:12px"><label>Reason / Narration</label><input id="note-narration"></div>
      <button class="btn btn-success" onclick="saveNote()">Save Note and Adjust Stock</button>
    </div>
    ${businessRegister('Credit / Debit Notes',['Date','Number','Type','Party','Taxable','Tax','Total','Action'],
      rows.map(row => [fmtDate(row.note_date),row.note_number,row.note_type,row.party_name||'-',
        fmt(row.taxable_amount),fmt(row.tax_amount),fmt(row.grand_total),
        `<button class="btn btn-xs btn-outline" onclick="showDuplicateVoucher('note',${row.id},'notes')">Duplicate</button>`]))}`;
  renderBusinessItems(); applyBusinessControlVisibility('CN'); businessNextNumber('CREDIT_NOTE','note-date','note-number');
}

async function saveNote() {
  const items = collectBusinessItems();
  if (!items.length) return toast('Add at least one returned item','error');
  const type = document.getElementById('note-type')?.value === 'debit' ? 'DN' : 'CN';
  if (!requireBusinessVisibleFields(type, {
    party_id: document.getElementById('note-party')?.value,
    narration: document.getElementById('note-narration')?.value,
    items
  })) return;
  try {
    await api('POST','/business/notes',{
      org_id:Number(document.getElementById('voucher-org').value), note_date:document.getElementById('note-date').value,
      note_type:document.getElementById('note-type').value, party_id:document.getElementById('note-party').value,
      narration:document.getElementById('note-narration').value,
      tax_inclusive:Boolean(document.getElementById('note-tax-inclusive')?.checked), items
      ,round_off_enabled:Boolean(document.getElementById('note-round-off')?.checked)
    });
    toast('Note saved and stock adjusted','success'); renderNotes();
  } catch (error) { toast(error.message,'error'); }
}

async function renderStock() {
  const [data, movements] = await Promise.all([
    api('GET',`/business/stock?org_id=${APP_STATE.currentOrg.id}`),
    api('GET',`/business/stock-movements?org_id=${APP_STATE.currentOrg.id}`)
  ]);
  document.getElementById('content').innerHTML = `
    <div class="stats-grid"><div class="stat-card"><div class="stat-label">Stock Items</div><div class="stat-value">${data.items.length}</div></div>
      <div class="stat-card red"><div class="stat-label">Low Stock</div><div class="stat-value">${data.low_stock.length}</div></div></div>
    ${businessRegister('Inventory Stock',['Item No.','Item','Model','Opening','In Stock','Reorder','MRP','Label'],
      data.items.map(item => [item.item_code||'-',item.name,item.model_number||'-',fmtN(item.opening_stock),
        fmtN(item.current_stock),fmtN(item.reorder_level),fmt(item.mrp),
        `<button class="btn btn-xs btn-outline" onclick="showBarcodeLabels(${item.id})">Barcode</button>`]))}
    <div style="height:16px"></div>
    ${businessRegister('Stock Movement Journal',
      ['Date','Reference','Type','Item','Qty In','Qty Out','Rate','Movement Value'],
      movements.map(row => [
        fmtDate(row.movement_date),row.ref_number||'-',
        String(row.source_type||'').replaceAll('_',' ').toUpperCase(),
        `${esc(row.item_name)}${row.item_code ? ` (${esc(row.item_code)})` : ''}`,
        fmtN(row.qty_in),fmtN(row.qty_out),fmt(row.rate),
        fmt((Number(row.qty_in||0)+Number(row.qty_out||0))*Number(row.rate||0))
      ]))}`;
}

const HELP_TOPICS = [
  ['PIN login and recovery', 'Use your username and 4 to 6 digit PIN for daily login. Owner1 can assign or reset PINs in Settings > Users. The recovery password is only for migration or account recovery.'],
  ['Owner1, Owner2 and operator roles', 'Owner1 controls user creation, PIN resets, company access and permissions. Owner2 can work in allowed companies but cannot change Owner1 or other users. Operators see only their assigned features.'],
  ['Sale payment workflow', 'Cash posts immediately. Bank, UPI and card remain receivable until a linked Payment Received voucher is created. After saving an invoice, choose Payment received only when the transaction is confirmed.'],
  ['Split payments', 'Select split payment and enter the cash and non-cash portions. Cash updates immediately. Bank, UPI and card portions require receipt vouchers and transaction references.'],
  ['Paid and pending invoices', 'Invoice Status shows Paid, Partly Paid, Unpaid and Overdue. Use Payment Received to allocate a later receipt to the pending invoice.'],
  ['Stock Movement Journal', 'Open Inventory & Stock and scroll below the stock summary. The journal lists purchase, sale, return and correction movements with reference, quantity, rate and movement value.'],
  ['Invoice corrections', 'An operator requests removal of an item or quantity and gives a reason. Owner1 reviews it. Approval creates a linked Credit Note and updates stock, GST, customer balance and audit history.'],
  ['GST GSTR-1 export', 'Open GST Reports, select the filing month and export GSTR-1 JSON. Validate GSTINs and invoice details, then upload the JSON as a regular taxpayer on the GST portal.'],
  ['Backup settings and location', 'Open Settings > Automatic Backup to choose and verify the backup folder. Open Backup & Restore for a manual backup. Keep another copy on an external drive or secure network location.'],
  ['Offline sync safety', 'Offline invoices stay pending until the main system is reachable. Check Offline Sync for pending or conflict records. Do not upgrade a client while pending offline invoices exist.'],
  ['Update Manager', 'Owner1 publishes a verified installer from the main system. The manager checks SHA-256, creates a pre-upgrade database recovery copy and warns when client versions differ.'],
  ['Mobile and LAN access', 'Connect the phone or tablet to the same LAN and open the main system IP and port in a browser. Permissions and audit history are the same as desktop access.']
  ,['Job order workflow', 'Counter creates the job, estimate, commitment and advance. Production accepts the assignment, records work updates, completes quality check, and marks it ready. Counter creates the final invoice only during delivery.']
  ,['Job roles and price privacy', 'Owner and Counter can see estimates, advances and delivery payments. Operators, Senior Operators and Engineers see only the Job ID, specifications, attachments, commitments, priority, deadline and work history.']
  ,['Assignments and forwarding', 'Counter can make the initial assignment. The assigned Operator, Senior Operator or Engineer must accept it. Current assignees may forward or return work with a reason; Senior Operator and Owner can reassign any active job.']
  ,['Additional work approval', 'Production proposes extra work with a technical reason. Owner or Counter sets the customer-facing charge. It is billable only after OTP, digital signature, WhatsApp or recorded verbal approval. Rejections remain in history.']
  ,['Open WhatsApp', 'Select a job and choose Open WhatsApp. Tarangini opens WhatsApp in the computer browser with the customer number and a prepared message. Tarangini does not send or store the WhatsApp conversation.']
  ,['Job files and photos', 'Attach supported images, PDF, Word or Excel files up to 10 MB each. Attachments are hashed and retained with the job audit history.']
];

let ACTIVE_JOB_ID = null;

function jobStatusLabel(status) {
  return String(status || '').replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, value => value.toUpperCase());
}

function jobStatusClass(status) {
  return ['COMPLETED', 'READY_FOR_DELIVERY', 'DELIVERED'].includes(status) ? 'saved'
    : status === 'WAITING_FOR_MATERIAL' ? 'cancelled'
      : ['ACCEPTED', 'IN_PROGRESS', 'QUALITY_CHECK'].includes(status) ? 'converted' : 'draft';
}

function jobMoney(paiseValue) {
  return fmt(Number(paiseValue || 0) / 100);
}

async function renderJobs() {
  if (!APP_STATE.currentOrg) return;
  showLoading();
  try {
    const [summary, jobs] = await Promise.all([
      api('GET', `/jobs/dashboard/summary?org_id=${APP_STATE.currentOrg.id}`),
      api('GET', `/jobs?org_id=${APP_STATE.currentOrg.id}`)
    ]);
    const counts = summary.counts || {};
    document.getElementById('topbar-actions').innerHTML = hasPermission('jobs_counter')
      ? `<button class="btn btn-primary" onclick="navigate('job-new')">+ New Job</button>` : '';
    document.getElementById('content').innerHTML = `
      <div class="job-metrics">
        ${['WAITING','ACCEPTED','IN_PROGRESS','WAITING_FOR_MATERIAL','QUALITY_CHECK','READY_FOR_DELIVERY']
          .map(status => `<div class="stat-card"><div class="stat-label">${jobStatusLabel(status)}</div>
            <div class="stat-value">${Number(counts[status] || 0)}</div></div>`).join('')}
      </div>
      <div class="card">
        <div class="page-header">
          <div><h2>Active Job Orders</h2><div class="text-muted">${Number(summary.overdue || 0)} overdue commitments</div></div>
          <div class="job-filter-bar">
            <input id="job-search" placeholder="Search Job ID or customer" oninput="filterJobRows()">
            <select id="job-status-filter" onchange="filterJobRows()">
              <option value="">All statuses</option>
              ${['WAITING','ACCEPTED','IN_PROGRESS','WAITING_FOR_MATERIAL','QUALITY_CHECK','COMPLETED','READY_FOR_DELIVERY','DELIVERED']
                .map(status => `<option value="${status}">${jobStatusLabel(status)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="table-wrap"><table><thead><tr>
          <th>Job ID</th><th>Customer</th><th>Status</th><th>Assigned</th><th>Priority</th><th>Deadline</th>
          ${hasPermission('jobs_finance') ? '<th>Estimate</th>' : ''}<th></th>
        </tr></thead><tbody id="job-list-body">
          ${jobs.map(job => `<tr data-search="${esc(`${job.job_token} ${job.customer?.name || job.customer?.reference || ''}`.toLowerCase())}"
              data-status="${job.current_status}">
            <td><strong>${esc(job.job_token)}</strong></td>
            <td>${esc(job.customer?.name || job.customer?.reference || '-')}</td>
            <td><span class="badge badge-${jobStatusClass(job.current_status)}">${esc(jobStatusLabel(job.current_status))}</span></td>
            <td>${esc(job.assignment?.employee_name || 'Unassigned')}</td>
            <td><span class="job-priority job-priority-${String(job.priority).toLowerCase()}">${esc(job.priority)}</span></td>
            <td>${esc(fmtDate(job.promised_delivery_at))}</td>
            ${hasPermission('jobs_finance') ? `<td>${job.finance?.estimate ? jobMoney(job.finance.estimate.total_paise) : '-'}</td>` : ''}
            <td><button class="btn btn-secondary btn-xs" onclick="openJob(${job.id})">Open</button></td>
          </tr>`).join('')}
        </tbody></table></div>
      </div>`;
  } catch (error) {
    document.getElementById('content').innerHTML = `<div class="error-msg">${esc(error.message)}</div>`;
  }
}

function filterJobRows() {
  const query = String(document.getElementById('job-search')?.value || '').trim().toLowerCase();
  const status = document.getElementById('job-status-filter')?.value || '';
  document.querySelectorAll('#job-list-body tr').forEach(row => {
    row.style.display = (!query || row.dataset.search.includes(query)) &&
      (!status || row.dataset.status === status) ? '' : 'none';
  });
}

async function renderNewJob() {
  if (!APP_STATE.currentOrg || !hasPermission('jobs_counter')) return;
  showLoading();
  const catalog = await api('GET', `/jobs/catalog?org_id=${APP_STATE.currentOrg.id}`);
  const customers = (APP_STATE.parties || []).filter(party => ['customer', 'both'].includes(party.type));
  document.getElementById('content').innerHTML = `
    <div class="page-header"><div><h2>Create Job Order</h2><div class="text-muted">Customer commitment, service scope, estimate and advance</div></div></div>
    <div class="job-form-layout">
      <div class="card">
        <div class="section-title">Customer and Commitment</div>
        <div class="form-row cols-2">
          <div class="form-group"><label>Customer <span class="req">*</span></label>
            <select id="job-party"><option value="">Select customer</option>
              ${customers.map(party => `<option value="${party.id}">${esc(party.name)}${party.phone ? ` · ${esc(party.phone)}` : ''}</option>`).join('')}
            </select></div>
          <div class="form-group"><label>Priority</label><select id="job-priority">
            <option>NORMAL</option><option>HIGH</option><option>URGENT</option><option>LOW</option>
          </select></div>
          <div class="form-group"><label>Promised Date</label><input type="date" id="job-date" value="${today()}"></div>
          <div class="form-group"><label>Promised Time</label><input type="time" id="job-time" value="18:00"></div>
        </div>
        <div class="form-group"><label>Customer Commitment</label>
          <textarea id="job-commitment" placeholder="Exact delivery and quality commitment"></textarea></div>
        <div class="section-title">Service Specification</div>
        <div class="form-row cols-3">
          <div class="form-group"><label>Category</label><select id="job-category" onchange="refreshJobServiceSelectors()">
            ${catalog.categories.map(category => `<option value="${category.id}">${esc(category.name)}</option>`).join('')}
          </select></div>
          <div class="form-group"><label>Subcategory</label><select id="job-subcategory" onchange="refreshJobServiceOptions()"></select></div>
          <div class="form-group"><label>Service</label><select id="job-service"></select></div>
          <div class="form-group"><label>Quantity</label><input type="number" id="job-qty" min="0.001" step="0.001" value="1"></div>
          <div class="form-group"><label>Unit</label><input id="job-unit" value="NOS"></div>
          <div class="form-group"><label>Description</label><input id="job-description" placeholder="Work description"></div>
        </div>
        <div class="form-group"><label>Specifications</label>
          <textarea id="job-specifications" placeholder="Size, material, color, finish, device fault, accessories, instructions"></textarea></div>
        <div class="form-group"><label>Files / Photos</label>
          <input type="file" id="job-files" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx"></div>
      </div>
      <div class="card job-finance-card">
        <div class="section-title">Estimate and Advance</div>
        <div class="form-group"><label>Estimated Unit Price</label><input type="number" id="job-unit-price" min="0" step="0.01" value="0"></div>
        <div class="form-group"><label>Tax %</label><input type="number" id="job-tax-rate" min="0" step="0.01" value="0"></div>
        ${regularTaxCheckbox('job-tax-inclusive')}
        ${roundOffCheckbox('job-round-off')}
        <div class="form-group"><label>Advance Amount</label><input type="number" id="job-advance" min="0" step="0.01" value="0"></div>
        <div class="form-group"><label>Advance Mode</label><select id="job-advance-mode">
          <option value="cash">Cash</option><option value="upi">UPI</option><option value="bank">Bank</option><option value="card">Card</option>
        </select></div>
        <div class="form-group"><label>Reference for non-cash advance</label><input id="job-advance-reference"></div>
        <button class="btn btn-primary btn-full" onclick="saveJobOrder()">Create Job and Token</button>
      </div>
    </div>`;
  APP_STATE.jobCatalog = catalog;
  refreshJobServiceSelectors();
}

function refreshJobServiceSelectors() {
  const catalog = APP_STATE.jobCatalog || { subcategories: [], services: [] };
  const categoryId = Number(document.getElementById('job-category')?.value);
  const subcategory = document.getElementById('job-subcategory');
  const rows = catalog.subcategories.filter(item => Number(item.category_id) === categoryId);
  subcategory.innerHTML = `<option value="">No subcategory</option>` +
    rows.map(item => `<option value="${item.id}">${esc(item.name)}</option>`).join('');
  refreshJobServiceOptions();
}

function refreshJobServiceOptions() {
  const catalog = APP_STATE.jobCatalog || { services: [] };
  const categoryId = Number(document.getElementById('job-category')?.value);
  const subcategoryId = Number(document.getElementById('job-subcategory')?.value || 0);
  const services = catalog.services.filter(service =>
    Number(service.category_id) === categoryId &&
    (!subcategoryId || Number(service.subcategory_id || 0) === subcategoryId)
  );
  const select = document.getElementById('job-service');
  select.innerHTML = services.map(service => `<option value="${service.id}">${esc(service.name)}</option>`).join('');
  if (services[0]) document.getElementById('job-unit').value = services[0].default_unit || 'NOS';
}

async function filePayloads(input) {
  const files = [...(input?.files || [])];
  return Promise.all(files.map(file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      file_name: file.name, mime_type: file.type, byte_size: file.size,
      content_base64: String(reader.result || '').split(',')[1] || ''
    });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  })));
}

async function saveJobOrder() {
  try {
    const service = (APP_STATE.jobCatalog?.services || [])
      .find(item => Number(item.id) === Number(document.getElementById('job-service').value));
    const quantity = Number(document.getElementById('job-qty').value || 0);
    const unitPrice = Number(document.getElementById('job-unit-price').value || 0);
    const taxRate = Number(document.getElementById('job-tax-rate').value || 0);
    const advance = Number(document.getElementById('job-advance').value || 0);
    const description = document.getElementById('job-description').value || service?.name || 'Service';
    if (!service) throw new Error('Select a service');
    if (!Number(document.getElementById('job-party').value)) throw new Error('Select a customer');
    if (quantity <= 0) throw new Error('Quantity must be greater than zero');
    if (unitPrice <= 0) throw new Error('Estimated unit price must be greater than zero');
    const attachments = await filePayloads(document.getElementById('job-files'));
    const payload = {
      org_id: APP_STATE.currentOrg.id,
      party_id: Number(document.getElementById('job-party').value),
      priority: document.getElementById('job-priority').value,
      promised_delivery_at: `${document.getElementById('job-date').value}T${document.getElementById('job-time').value}:00`,
      customer_commitment: document.getElementById('job-commitment').value,
      tax_inclusive: Boolean(document.getElementById('job-tax-inclusive')?.checked),
      round_off_enabled: Boolean(document.getElementById('job-round-off')?.checked),
      items: [{
        service_id: service?.id, description, quantity,
        unit: document.getElementById('job-unit').value,
        specifications: { notes: document.getElementById('job-specifications').value }
      }],
      estimate_lines: unitPrice > 0 ? [{
        description, quantity, unit: document.getElementById('job-unit').value,
        unit_price: unitPrice, tax_rate: taxRate, line_total: quantity * unitPrice
      }] : [],
      advance_payments: advance > 0 ? [{
        amount: advance, mode: document.getElementById('job-advance-mode').value,
        reference: document.getElementById('job-advance-reference').value
      }] : [],
      attachments
    };
    const created = await api('POST', '/jobs', payload);
    toast(created.offline_pending
      ? `Job ${created.token} saved offline and queued for sync`
      : `Job ${created.token} created`, 'success');
    openJob(created.id);
  } catch (error) { toast(error.message, 'error'); }
}

async function openJob(id) {
  ACTIVE_JOB_ID = Number(id);
  APP_STATE.currentPage = 'job-detail';
  document.getElementById('page-title').textContent = 'Job Detail';
  showLoading();
  try {
    const job = await api('GET', `/jobs/${id}`);
    APP_STATE.activeJob = job;
    const isFinance = hasPermission('jobs_finance');
    const isOperations = hasPermission('jobs_operations');
    const canAssign = hasPermission('jobs_assign');
    const nextStatuses = {
      WAITING: [], ACCEPTED: ['IN_PROGRESS'], IN_PROGRESS: ['WAITING_FOR_MATERIAL','QUALITY_CHECK'],
      WAITING_FOR_MATERIAL: ['IN_PROGRESS'], QUALITY_CHECK: ['IN_PROGRESS','COMPLETED'],
      COMPLETED: ['IN_PROGRESS','READY_FOR_DELIVERY'], READY_FOR_DELIVERY: []
    }[job.current_status] || [];
    const staff = canAssign ? await api('GET', `/jobs/staff?org_id=${APP_STATE.currentOrg.id}`) : [];
    document.getElementById('content').innerHTML = `
      <div class="page-header">
        <div><h2>${esc(job.job_token)}</h2><div class="text-muted">${esc(job.customer?.name || job.customer?.reference || '')} · Due ${esc(fmtDate(job.promised_delivery_at))}</div></div>
        <div><span class="badge badge-${jobStatusClass(job.current_status)}">${esc(jobStatusLabel(job.current_status))}</span>
          <button class="btn btn-secondary btn-sm" onclick="renderJobs()">Back</button></div>
      </div>
      <div class="job-detail-grid">
        <div>
          <div class="card">
            <div class="section-title">Work Specification</div>
            ${job.items.map(item => `<div class="job-item-block"><strong>${esc(item.service_snapshot)}</strong>
              <span>${esc(item.description)} · ${item.quantity} ${esc(item.unit)}</span>
              <p>${esc(item.specifications?.notes || JSON.stringify(item.specifications || {}))}</p></div>`).join('')}
            <div class="job-commitment"><strong>Customer commitment</strong><p>${esc(job.customer_commitment || '-')}</p></div>
            <div class="job-attachment-list">${job.attachments.map(file => `<span class="chip">${esc(file.file_name)}</span>`).join('') || '<span class="text-muted">No attachments</span>'}</div>
          </div>
          ${canAssign ? `<div class="card" style="margin-top:16px">
            <div class="section-title">Assignment and Handoff</div>
            <div class="job-current-assignment">${job.assignment
              ? `<strong>${esc(job.assignment.employee_name)}</strong><span>${esc(job.assignment.assigned_role)} · ${esc(job.assignment.status)}</span>`
              : '<span>Unassigned</span>'}</div>
            <div class="form-row cols-2">
              <div class="form-group"><label>Assign / Forward To</label><select id="job-assignee">
                ${staff.map(user => `<option value="${user.id}">${esc(user.name)} · ${esc(user.role.replaceAll('_',' '))}</option>`).join('')}
              </select></div>
              <div class="form-group"><label>Action</label><select id="job-handoff-type">
                <option>FORWARD</option><option>RETURN</option><option>ESCALATE</option><option>REASSIGN</option>
              </select></div>
            </div>
            <div class="form-group"><label>Reason / Instructions</label><textarea id="job-handoff-reason"></textarea></div>
            <button class="btn btn-primary" onclick="assignJob()">Send for Acceptance</button>
            ${job.assignment?.status === 'PENDING_ACCEPTANCE' && Number(job.assignment.employee_id) === Number(APP_STATE.user.id)
              ? `<button class="btn btn-success" onclick="respondAssignment('ACCEPT')">Accept</button>
                 <button class="btn btn-danger" onclick="respondAssignment('DECLINE')">Decline</button>` : ''}
          </div>` : ''}
          ${isOperations ? `<div class="card" style="margin-top:16px">
            <div class="section-title">Work Update</div>
            <div class="job-action-row">${nextStatuses.map(status =>
              `<button class="btn btn-secondary" onclick="updateJobStatus('${status}')">${esc(jobStatusLabel(status))}</button>`).join('')}</div>
            <div class="form-row cols-2" style="margin-top:14px">
              <div class="form-group"><label>Progress %</label><input type="number" id="job-progress" min="0" max="100" value="50"></div>
              <div class="form-group"><label>Report type</label><select id="job-report-type">
                <option>PROGRESS</option><option>MATERIAL</option><option>QC</option><option>COMPLETION</option><option>REWORK</option>
              </select></div>
            </div>
            <div class="form-group"><label>Work report</label><textarea id="job-report-text"></textarea></div>
            <button class="btn btn-primary" onclick="addWorkReport()">Add Work Report</button>
          </div>
          <div class="card" style="margin-top:16px">
            <div class="section-title">Propose Additional Work</div>
            <textarea id="job-addition-reason" placeholder="Technical reason and finding"></textarea>
            <div class="form-group" style="margin-top:8px"><label>Evidence Photos / PDF</label>
              <input type="file" id="job-addition-files" multiple accept="image/*,.pdf"></div>
            <button class="btn btn-secondary" style="margin-top:8px" onclick="proposeJobAddition()">Submit Proposal</button>
          </div>` : ''}
        </div>
        <div>
          ${isFinance ? `<div class="card job-finance-card">
            <div class="section-title">Financial Summary</div>
            <div class="summary-row"><span>Estimate</span><strong>${job.finance?.estimate ? jobMoney(job.finance.estimate.total_paise) : '-'}</strong></div>
            <div class="summary-row"><span>Advance</span><strong>${jobMoney(job.finance?.advance_paise)}</strong></div>
            <div class="summary-row"><span>Status</span><strong>${esc(job.finance?.financial_status || 'OPEN')}</strong></div>
            ${job.current_status === 'READY_FOR_DELIVERY' ? `<button class="btn btn-success btn-full" onclick="showJobDelivery()">Invoice and Deliver</button>` : ''}
          </div>` : ''}
          <div class="card" style="margin-top:16px"><div class="section-title">Additional Work</div>
            ${job.additions.map(addition => `<div class="job-addition">
              <strong>${esc(addition.customer_description || addition.internal_reason)}</strong>
              <span class="badge badge-${addition.state === 'APPROVED' ? 'saved' : addition.state === 'REJECTED' ? 'cancelled' : 'draft'}">${esc(addition.state)}</span>
              ${isFinance && addition.state === 'PROPOSED' ? `<button class="btn btn-xs btn-secondary" onclick="priceJobAddition(${addition.id})">Set Charge</button>` : ''}
              ${isFinance && addition.state === 'AWAITING_CUSTOMER' ? `<button class="btn btn-xs btn-success" onclick="approveJobAddition(${addition.id},'APPROVED')">Approve</button>
                <button class="btn btn-xs btn-danger" onclick="approveJobAddition(${addition.id},'REJECTED')">Reject</button>` : ''}
              ${isFinance && addition.total_paise !== undefined ? `<small>${jobMoney(addition.total_paise)}</small>` : ''}
            </div>`).join('') || '<div class="text-muted">No proposals</div>'}
          </div>
          <div class="card" style="margin-top:16px"><div class="section-title">Timeline</div>
            ${job.status_events.map(event => `<div class="job-timeline-row"><strong>${esc(jobStatusLabel(event.to_status))}</strong>
              <span>${esc(event.actor_name || '')} · ${esc(fmtDate(event.occurred_at))}</span><small>${esc(event.reason || '')}</small></div>`).join('')}
          </div>
        </div>
      </div>`;
  } catch (error) {
    document.getElementById('content').innerHTML = `<div class="error-msg">${esc(error.message)}</div>`;
  }
}

async function assignJob() {
  try {
    const result = await api('POST', `/jobs/${ACTIVE_JOB_ID}/assign`, {
      employee_id: Number(document.getElementById('job-assignee').value),
      handoff_type: document.getElementById('job-handoff-type').value,
      reason: document.getElementById('job-handoff-reason').value
    });
    toast('Assignment sent for acceptance', 'success');
    openJob(ACTIVE_JOB_ID);
  } catch (error) { toast(error.message, 'error'); }
}

async function respondAssignment(decision) {
  try {
    await api('POST', `/jobs/assignments/${APP_STATE.activeJob.assignment.id}/respond`, {
      decision, reason: decision === 'DECLINE' ? prompt('Decline reason') : ''
    });
    toast(`Assignment ${decision.toLowerCase()}ed`, 'success');
    openJob(ACTIVE_JOB_ID);
  } catch (error) { toast(error.message, 'error'); }
}

async function updateJobStatus(status) {
  try {
    await api('POST', `/jobs/${ACTIVE_JOB_ID}/status`, { status, reason: `Moved to ${jobStatusLabel(status)}` });
    toast('Job status updated', 'success');
    openJob(ACTIVE_JOB_ID);
  } catch (error) { toast(error.message, 'error'); }
}

async function addWorkReport() {
  try {
    await api('POST', `/jobs/${ACTIVE_JOB_ID}/reports`, {
      report_type: document.getElementById('job-report-type').value,
      progress_percent: Number(document.getElementById('job-progress').value),
      report_text: document.getElementById('job-report-text').value
    });
    toast('Work report recorded', 'success');
    openJob(ACTIVE_JOB_ID);
  } catch (error) { toast(error.message, 'error'); }
}

async function proposeJobAddition() {
  try {
    const attachments = await filePayloads(document.getElementById('job-addition-files'));
    await api('POST', `/jobs/${ACTIVE_JOB_ID}/additions`, {
      reason: document.getElementById('job-addition-reason').value,
      attachments
    });
    toast('Additional work proposed', 'success');
    openJob(ACTIVE_JOB_ID);
  } catch (error) { toast(error.message, 'error'); }
}

async function priceJobAddition(id) {
  const description = prompt('Customer-facing description');
  if (!description) return;
  const unitPrice = Number(prompt('Unit price') || 0);
  const quantity = Number(prompt('Quantity') || 1);
  try {
    await api('PUT', `/jobs/additions/${id}/price`, {
      customer_description: description, unit_price: unitPrice, quantity, unit: 'NOS', tax_rate: 0
    });
    toast('Customer charge set', 'success');
    openJob(ACTIVE_JOB_ID);
  } catch (error) { toast(error.message, 'error'); }
}

async function approveJobAddition(id, decision) {
  const method = prompt('Approval method: OTP, DIGITAL_SIGNATURE, VERBAL_RECORDED', 'OTP');
  const approver = prompt('Customer approver name');
  if (!method || !approver) return;
  try {
    await api('POST', `/jobs/additions/${id}/approval`, {
      decision, method, approver_name: approver, evidence_text: `${method} evidence recorded by ${APP_STATE.user.name}`
    });
    toast(`Addition ${decision.toLowerCase()}`, 'success');
    openJob(ACTIVE_JOB_ID);
  } catch (error) { toast(error.message, 'error'); }
}

function showJobDelivery() {
  document.getElementById('confirm-title').textContent = 'Invoice and Deliver Job';
  document.getElementById('confirm-msg').innerHTML = `
    <div class="form-group"><label>Receiver Name</label><input id="delivery-receiver"></div>
    <div class="form-group"><label>Warranty / Service Notes</label><textarea id="delivery-warranty"></textarea></div>
    <div class="form-row cols-2">
      <div class="form-group"><label>Cash</label><input type="number" id="delivery-cash" min="0" step="0.01" value="0"></div>
      <div class="form-group"><label>UPI / Bank / Card</label><input type="number" id="delivery-noncash" min="0" step="0.01" value="0"></div>
    </div>
    <div class="form-group"><label>Non-cash Mode</label><select id="delivery-mode"><option value="upi">UPI</option><option value="bank">Bank</option><option value="card">Card</option></select></div>
    <div class="form-group"><label>Reference</label><input id="delivery-reference"></div>`;
  document.getElementById('confirm-ok-btn').textContent = 'Post Invoice and Deliver';
  document.getElementById('confirm-ok-btn').className = 'btn btn-success';
  document.getElementById('confirm-modal').style.display = 'flex';
  confirmResolver = async accepted => {
    if (!accepted) return;
    try {
      const payments = [];
      const cash = Number(document.getElementById('delivery-cash').value || 0);
      const noncash = Number(document.getElementById('delivery-noncash').value || 0);
      if (cash > 0) payments.push({ mode: 'cash', amount: cash });
      if (noncash > 0) payments.push({
        mode: document.getElementById('delivery-mode').value, amount: noncash,
        reference: document.getElementById('delivery-reference').value
      });
      const result = await api('POST', `/jobs/${ACTIVE_JOB_ID}/deliver`, {
        receiver_name: document.getElementById('delivery-receiver').value,
        acknowledgement_method: 'OTP',
        warranty_notes: document.getElementById('delivery-warranty').value,
        payments
      });
      toast(`Delivered with invoice ${result.bill_number}`, 'success');
      openJob(ACTIVE_JOB_ID);
    } catch (error) { toast(error.message, 'error'); }
  };
}

async function renderJobCatalog() {
  if (!hasPermission('jobs_catalog')) return;
  const catalog = await api('GET', `/jobs/catalog?org_id=${APP_STATE.currentOrg.id}&include_inactive=1`);
  APP_STATE.jobCatalog = catalog;
  document.getElementById('content').innerHTML = `
    <div class="page-header"><div><h2>Service Catalog</h2><div class="text-muted">Category → Subcategory → Service</div></div>
      <button class="btn btn-primary" onclick="addJobCatalogEntry('category')">+ Category</button></div>
    <div class="job-catalog-layout">
      <div class="card">${catalog.categories.map(category => `
        <div class="catalog-group"><div class="catalog-group-head"><strong>${esc(category.name)}</strong>
          <button class="btn btn-xs btn-secondary" onclick="addJobCatalogEntry('subcategory',${category.id})">+ Subcategory</button>
          <button class="btn btn-xs btn-secondary" onclick="addJobCatalogEntry('service',${category.id})">+ Service</button></div>
          ${catalog.services.filter(service => Number(service.category_id) === Number(category.id)).map(service => {
            const sub = catalog.subcategories.find(item => Number(item.id) === Number(service.subcategory_id));
            return `<div class="catalog-service-row"><span>${esc(sub?.name || 'No subcategory')}</span><strong>${esc(service.name)}</strong>
              <span class="badge badge-${service.active ? 'saved' : 'cancelled'}">${service.active ? 'Active' : 'Inactive'}</span>
              <button class="btn btn-xs btn-outline" onclick="toggleJobCatalog('services',${service.id},${service.active ? 0 : 1})">${service.active ? 'Deactivate' : 'Activate'}</button></div>`;
          }).join('')}</div>`).join('')}</div>
      <div class="card"><div class="section-title">Catalog Rules</div>
        <p class="text-muted">Used entries are deactivated instead of deleted. Existing jobs keep their category, subcategory and service snapshots.</p></div>
    </div>`;
}

async function addJobCatalogEntry(type, categoryId) {
  const name = prompt(`${type} name`);
  if (!name) return;
  const code = prompt(`${type} code`, name.replace(/\W+/g, '-').toUpperCase());
  try {
    if (type === 'category') {
      await api('POST', '/jobs/catalog/categories', { org_id: APP_STATE.currentOrg.id, name, code });
    } else if (type === 'subcategory') {
      await api('POST', '/jobs/catalog/subcategories', {
        org_id: APP_STATE.currentOrg.id, category_id: categoryId, name, code
      });
    } else {
      const subcategoryId = Number(prompt('Subcategory ID (leave blank for none)') || 0);
      await api('POST', '/jobs/catalog/services', {
        org_id: APP_STATE.currentOrg.id, category_id: categoryId,
        subcategory_id: subcategoryId || null, name, code, default_unit: 'NOS'
      });
    }
    toast('Catalog entry added', 'success');
    renderJobCatalog();
  } catch (error) { toast(error.message, 'error'); }
}

async function toggleJobCatalog(entity, id, active) {
  try {
    await api('PATCH', `/jobs/catalog/${entity}/${id}`, { active, reason: 'Catalog availability updated' });
    renderJobCatalog();
  } catch (error) { toast(error.message, 'error'); }
}

async function renderJobWhatsApp() {
  const jobs = await api('GET', `/jobs?org_id=${APP_STATE.currentOrg.id}`);
  const selected = ACTIVE_JOB_ID || jobs[0]?.id;
  if (!selected) {
    document.getElementById('content').innerHTML = '<div class="empty-state"><p>No jobs available</p></div>';
    return;
  }
  ACTIVE_JOB_ID = selected;
  const job = await api('GET', `/jobs/${selected}`);
  APP_STATE.activeJob = job;
  const defaultMessage = `Hello ${job.customer?.name || ''}, regarding job ${job.job_token}: current status is ${jobStatusLabel(job.current_status)} and promised delivery is ${fmtDate(job.promised_delivery_at)}.`;
  document.getElementById('content').innerHTML = `
    <div class="page-header"><div><h2>Open WhatsApp</h2><div class="text-muted">Opens WhatsApp in your browser. Tarangini does not send or store the message.</div></div></div>
    <div class="job-whatsapp-layout">
      <div class="card job-conversation-list">${jobs.map(row => `<button class="${row.id === selected ? 'active' : ''}"
        onclick="ACTIVE_JOB_ID=${row.id};renderJobWhatsApp()"><strong>${esc(row.job_token)}</strong><span>${esc(row.customer?.name || '')}</span></button>`).join('')}</div>
      <div class="card job-chat">
        <div class="section-title">${esc(job.job_token)} · ${esc(job.customer?.name || '')}</div>
        <div class="form-group"><label>Customer mobile</label>
          <input id="job-whatsapp-phone" value="${esc(job.customer?.phone || '')}" inputmode="tel"></div>
        <div class="form-group"><label>Prepared message</label>
          <textarea id="job-message-text">${esc(defaultMessage)}</textarea></div>
        <button class="btn btn-primary btn-full" onclick="openJobWhatsApp()">Open in Browser WhatsApp</button>
      </div>
      <div class="card"><div class="section-title">Customer Status Link</div>
        <p class="text-muted">Optional secure status and approval link. Create it, then paste it into WhatsApp.</p>
        <button class="btn btn-secondary btn-full" onclick="createCustomerJobLink()">Create and Copy Status Link</button>
        <div id="job-customer-link" class="text-muted text-sm" style="margin-top:10px"></div></div>
    </div>`;
}

function openJobWhatsApp() {
  let phone = String(document.getElementById('job-whatsapp-phone')?.value || '').replace(/\D/g, '');
  if (phone.startsWith('0')) phone = phone.slice(1);
  if (phone.length === 10) phone = `91${phone}`;
  if (phone.length < 10) return toast('Enter a valid customer mobile number', 'error');
  const message = document.getElementById('job-message-text')?.value || '';
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank', 'noopener');
}

async function createCustomerJobLink() {
  try {
    const result = await api('POST', `/jobs/${ACTIVE_JOB_ID}/customer-access`, { valid_days: 30 });
    const url = `${location.origin}${result.path}`;
    document.getElementById('job-customer-link').innerHTML =
      `<strong>Secure link:</strong><br><span class="mono">${esc(url)}</span>`;
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
    toast('Customer link created and copied', 'success');
  } catch (error) { toast(error.message, 'error'); }
}

function renderHelp() {
  document.getElementById('content').innerHTML = `
    <div class="card help-card">
      <div class="section-title">Preloaded User Help</div>
      <p class="text-muted">This guide is stored inside Tarangini Billing and works without internet.</p>
      <input id="help-search" type="search" placeholder="Search PIN, stock, GST, backup, payment..."
        oninput="filterHelp(this.value)">
    </div>
    <div id="help-topics" class="help-topics">
      ${HELP_TOPICS.map(([title,body],index) => `
        <details class="help-topic" data-help="${esc(`${title} ${body}`.toLowerCase())}" ${index === 0 ? 'open' : ''}>
          <summary>${esc(title)}</summary><p>${esc(body)}</p>
        </details>`).join('')}
    </div>`;
}

function filterHelp(value) {
  const query = String(value || '').trim().toLowerCase();
  document.querySelectorAll('.help-topic').forEach(topic => {
    const match = !query || topic.dataset.help.includes(query);
    topic.style.display = match ? '' : 'none';
    if (query && match) topic.open = true;
  });
}

async function renderBankReconciliation() {
  const [rows, statementRows] = await Promise.all([
    api('GET',`/business/bank?org_id=${APP_STATE.currentOrg.id}&fy=${APP_STATE.currentFY}`),
    api('GET',`/business/bank-statements?org_id=${APP_STATE.currentOrg.id}`)
  ]);
  document.getElementById('content').innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="section-title">Upload Bank Statement</div>
      <div class="form-row cols-2">
        <div class="form-group"><label>Excel or CSV Statement</label>
          <input type="file" id="bank-statement-file" accept=".xlsx,.xls,.csv"></div>
        <div class="form-group" style="justify-content:flex-end">
          <button class="btn btn-success" onclick="importBankStatement()">Upload and Auto Match</button>
        </div>
      </div>
      <div style="font-size:12px;color:var(--text2)">
        Supported columns include Date / Transaction Date, Narration / Description, Reference,
        Debit / Withdrawal, Credit / Deposit and Balance.
      </div>
    </div>
    ${businessRegister('Imported Bank Statement',
      ['Status','Date','Description','Reference','Debit','Credit','Balance','Ledger Match'],
      statementRows.map(row => [
        `<span class="badge badge-${row.matched ? 'saved' : 'draft'}">${row.matched ? 'Matched' : 'Unmatched'}</span>`,
        fmtDate(row.transaction_date),row.description||'-',row.reference||'-',
        fmt(row.debit),fmt(row.credit),fmt(row.balance),
        `<select onchange="saveStatementMatch(${row.id},this.value)" style="min-width:170px">
          <option value="">Unmatched</option>
          ${rows.map(line => `<option value="${line.journal_line_id}" ${Number(row.journal_line_id) === Number(line.journal_line_id) ? 'selected' : ''}>
            ${esc(line.entry_date)} | ${esc(line.voucher_number || line.voucher_type)} | ${fmt(Number(line.debit || line.credit))}
          </option>`).join('')}
        </select>`
      ]))}
    ${businessRegister('Software Bank Ledger',
    ['Matched','Date','Voucher','Narration','Debit','Credit','Statement Date','Reference'],
    rows.map(row => [
      `<input type="checkbox" ${row.matched ? 'checked' : ''} onchange="saveBankMatch(${row.journal_line_id},this.checked)">`,
      fmtDate(row.entry_date),row.voucher_number||row.voucher_type,row.narration||'-',fmt(row.debit),fmt(row.credit),
      `<input type="date" id="bank-date-${row.journal_line_id}" value="${row.statement_date||''}">`,
      `<input id="bank-ref-${row.journal_line_id}" value="${esc(row.statement_reference||'')}" onchange="saveBankMatch(${row.journal_line_id},true)">`
    ]))}`;
}

function normalizeBankHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findBankValue(row, aliases) {
  const entries = Object.entries(row);
  for (const alias of aliases) {
    const found = entries.find(([key]) => normalizeBankHeader(key) === alias ||
      normalizeBankHeader(key).includes(alias));
    if (found) return found[1];
  }
  return '';
}

function findBankKey(row, aliases) {
  return Object.keys(row).find(key => aliases.some(alias =>
    normalizeBankHeader(key) === alias || normalizeBankHeader(key).includes(alias))) || '';
}

function parseBankDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  if (typeof value === 'number' && window.XLSX?.SSF) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  const text = String(value || '').trim();
  const indian = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (indian) {
    const year = indian[3].length === 2 ? `20${indian[3]}` : indian[3];
    return `${year}-${indian[2].padStart(2, '0')}-${indian[1].padStart(2, '0')}`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function parseBankAmount(value) {
  if (typeof value === 'number') return value;
  const text = String(value || '').replace(/,/g, '').trim();
  const amount = Number(text.replace(/[^\d.-]/g, ''));
  return Number.isFinite(amount) ? Math.abs(amount) : 0;
}

async function importBankStatement() {
  const file = document.getElementById('bank-statement-file')?.files?.[0];
  if (!file) return toast('Select an Excel or CSV bank statement', 'error');
  if (!window.XLSX) return toast('Excel reader is unavailable', 'error');
  try {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const sourceRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
    const sample = sourceRows[0] || {};
    const mapping = {
      transaction_date: findBankKey(sample, ['transactiondate','valuedate','date']),
      description: findBankKey(sample, ['narration','description','particulars','remarks']),
      reference: findBankKey(sample, ['referenceno','reference','refno','chequeno','chqno']),
      debit: findBankKey(sample, ['debitamount','withdrawalamount','withdrawal','debit']),
      credit: findBankKey(sample, ['creditamount','depositamount','deposit','credit']),
      balance: findBankKey(sample, ['closingbalance','balance'])
    };
    const rows = sourceRows.map(row => ({
      transaction_date: parseBankDate(findBankValue(row, ['transactiondate','valuedate','date'])),
      description: findBankValue(row, ['narration','description','particulars','remarks']),
      reference: findBankValue(row, ['referenceno','reference','refno','chequeno','chqno']),
      debit: parseBankAmount(findBankValue(row, ['debitamount','withdrawalamount','withdrawal','debit'])),
      credit: parseBankAmount(findBankValue(row, ['creditamount','depositamount','deposit','credit'])),
      balance: parseBankAmount(findBankValue(row, ['closingbalance','balance']))
    })).filter(row => row.transaction_date && (row.debit || row.credit || row.balance));
    if (!rows.length) return toast('No recognizable bank transactions found in the first sheet', 'error');
    const result = await api('POST', '/business/bank-statements/import', {
      org_id: APP_STATE.currentOrg.id, file_name: file.name,
      file_hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())))
        .map(byte => byte.toString(16).padStart(2, '0')).join(''),
      mapping, rows
    });
    toast(`${result.imported} rows imported; ${result.matched} automatically matched`, 'success');
    renderBankReconciliation();
  } catch (error) {
    toast(`Statement import failed: ${error.message}`, 'error');
  }
}

async function saveStatementMatch(rowId, journalLineId) {
  try {
    await api('PUT', `/business/bank-statements/${rowId}/match`, {
      journal_line_id: journalLineId ? Number(journalLineId) : null
    });
    toast('Statement match updated', 'success');
    renderBankReconciliation();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function saveBankMatch(lineId, matched) {
  try {
    await api('PUT',`/business/bank/${lineId}`,{
      org_id:APP_STATE.currentOrg.id, matched,
      statement_date:document.getElementById(`bank-date-${lineId}`)?.value || null,
      statement_reference:document.getElementById(`bank-ref-${lineId}`)?.value || ''
    });
    toast('Bank match updated','success');
  } catch (error) { toast(error.message,'error'); }
}

async function renderInvoiceStatus() {
  const rows = await api('GET',`/reports/invoice-status?org_id=${APP_STATE.currentOrg.id}`);
  document.getElementById('content').innerHTML = businessRegister('Invoice Payment Status',
    ['Bill','Date','Due Date','Party','Total','Paid','Outstanding','Status','Reminder'],
    rows.map(row => [row.bill_number,fmtDate(row.bill_date),fmtDate(row.due_date),row.party_name||'Cash',
      fmt(row.grand_total),fmt(row.paid_amount),fmt(row.outstanding),
      `<span class="badge badge-${row.payment_status === 'paid' ? 'saved' : row.payment_status === 'overdue' ? 'cancelled' : 'draft'}">${row.payment_status}</span>`,
      row.payment_status === 'paid' ? '-' : `<button class="btn btn-xs btn-success" onclick="sendInvoiceReminder(${row.id})">WhatsApp</button>`]));
}

async function sendInvoiceReminder(id) {
  whatsappInvoice(await api('GET', `/bills/${id}`));
}

async function renderGSTReports() {
  const [data, gstr2b] = await Promise.all([
    api('GET',`/reports/gst?org_id=${APP_STATE.currentOrg.id}&fy=${APP_STATE.currentFY}`),
    api('GET',`/reports/gst/gstr2b?org_id=${APP_STATE.currentOrg.id}&fy=${APP_STATE.currentFY}`)
  ]);
  document.getElementById('content').innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="section-title">GST JSON Files</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
        <div class="form-group" style="margin:0;min-width:170px"><label>GSTR-1 Return Month</label>
          <input type="month" id="gstr1-period" value="${today().slice(0,7)}"></div>
        <button class="btn btn-primary" onclick="downloadGSTJson('gstr1')">Export GSTR-1 JSON</button>
        <button class="btn btn-primary" onclick="downloadGSTJson('gstr3b')">Export GSTR-3B JSON</button>
        <div class="form-group" style="margin:0;min-width:260px"><label>Import GSTR-2B JSON</label>
          <input type="file" id="gstr2b-json-file" accept=".json,application/json"></div>
        <button class="btn btn-success" onclick="importGSTR2B()">Import and Reconcile</button>
      </div>
      <p style="font-size:11px;color:var(--text2);margin-top:8px">GSTR-1 exports GST Portal-compatible JSON for regular taxpayers. Review the portal summary before filing.</p>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="section-title">Tally Prime - Regular GST Party Masters</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
        <div class="form-group" style="margin:0;min-width:300px;flex:1"><label>Exact Company Name in Tally Prime</label>
          <input type="text" id="tally-company-name" value="${esc(APP_STATE.currentOrg.registered_name || APP_STATE.currentOrg.display_name || '')}"
            placeholder="Company name exactly as shown in Tally Prime"></div>
        <button class="btn btn-primary" onclick="downloadTallyParties()">Export Customers and Vendors XML</button>
      </div>
      <p style="font-size:11px;color:var(--text2);margin-top:8px">Exports regular-GST B2B customers under Sundry Debtors and vendors under Sundry Creditors. In Tally Prime, open that company and import the downloaded XML as Masters.</p>
    </div>
    <div class="stats-grid">
      <div class="stat-card gold"><div class="stat-label">Taxable Sales</div><div class="stat-value">${fmt(data.gstr3b.taxable_sales)}</div></div>
      <div class="stat-card red"><div class="stat-label">Output Tax</div><div class="stat-value">${fmt(data.gstr3b.output_tax)}</div></div>
      <div class="stat-card green"><div class="stat-label">Input Tax Credit</div><div class="stat-value">${fmt(data.gstr3b.input_tax_credit)}</div></div>
      <div class="stat-card blue"><div class="stat-label">Net Tax Payable</div><div class="stat-value">${fmt(data.gstr3b.net_tax_payable)}</div></div>
    </div>
    ${businessRegister('GSTR-1 Sales',['Date','Invoice','GSTIN','Party','Taxable','CGST','SGST','IGST','Total'],
      data.gstr1.map(row => [fmtDate(row.bill_date),row.bill_number,row.gstin||'-',row.party_name||'-',fmt(row.taxable_amount),fmt(row.cgst),fmt(row.sgst),fmt(row.igst),fmt(row.grand_total)]))}
    ${businessRegister('GSTR-2B Reconciliation',['Date','Supplier GSTIN','Supplier','Invoice','Portal Taxable','Portal Tax','Book Taxable','Book Tax','Status'],
      gstr2b.map(row => [fmtDate(row.invoice_date),row.supplier_gstin||'-',row.supplier_name||'-',row.invoice_number||'-',
        fmt(row.taxable_amount),fmt(row.total_tax),row.purchase_id?fmt(row.book_taxable):'-',row.purchase_id?fmt(row.book_tax):'-',
        `<span class="badge badge-${row.match_status==='matched'?'saved':row.match_status==='value mismatch'?'draft':'cancelled'}">${row.match_status}</span>`]))}
    ${businessRegister('HSN Summary',['HSN','Quantity','Taxable Value'],data.hsn.map(row => [row.hsn||'-',fmtN(row.quantity),fmt(row.taxable)]))}`;
}

async function downloadTallyParties() {
  const company = document.getElementById('tally-company-name')?.value.trim();
  if (!company) return toast('Enter the company name exactly as shown in Tally Prime', 'error');
  try {
    const url = `/api/reports/tally/regular-parties.xml?org_id=${APP_STATE.currentOrg.id}&tally_company=${encodeURIComponent(company)}`;
    let response = await fetch(url, { headers: { Authorization: `Bearer ${APP_STATE.token}` } });
    if (response.status === 401) {
      await refreshSessionToken();
      response = await fetch(url, { headers: { Authorization: `Bearer ${APP_STATE.token}` } });
    }
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || 'Tally export failed');
    }
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    const disposition = response.headers.get('Content-Disposition') || '';
    link.download = disposition.match(/filename="([^"]+)"/)?.[1] || 'regular-gst-parties.xml';
    link.click();
    URL.revokeObjectURL(link.href);
    toast(`${response.headers.get('X-Tarangini-Ledger-Count') || 0} Tally party ledgers exported`, 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function downloadGSTJson(type) {
  try {
    const period = document.getElementById('gstr1-period')?.value || today().slice(0,7);
    const response = await fetch(`/api/reports/gst/export?org_id=${APP_STATE.currentOrg.id}&fy=${APP_STATE.currentFY}&period=${period}&type=${type}`, {
      headers: { Authorization: `Bearer ${APP_STATE.token}` }
    });
    if (response.status === 401) {
      await refreshSessionToken();
      return downloadGSTJson(type);
    }
    if (!response.ok) {
      const result = await response.json();
      const details = Array.isArray(result.details) ? `\n${result.details.join('\n')}` : '';
      throw new Error(`${result.error || 'GST export failed'}${details}`);
    }
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    const disposition = response.headers.get('Content-Disposition') || '';
    const filename = disposition.match(/filename="([^"]+)"/)?.[1];
    link.download = filename || `${type}-${type === 'gstr1' ? period : APP_STATE.currentFY}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) { toast(error.message, 'error'); }
}

async function importGSTR2B() {
  const file = document.getElementById('gstr2b-json-file')?.files?.[0];
  if (!file) return toast('Select a GSTR-2B JSON file', 'error');
  try {
    const json = JSON.parse(await file.text());
    const result = await api('POST', '/reports/gst/gstr2b/import', {
      org_id: APP_STATE.currentOrg.id, fy: APP_STATE.currentFY, file_name: file.name, json
    });
    toast(`${result.imported} GSTR-2B invoices imported`, 'success');
    renderGSTReports();
  } catch (error) {
    toast(error instanceof SyntaxError ? 'Invalid JSON file' : error.message, 'error');
  }
}

function exportVisibleTable(title) {
  const table = document.querySelector('#content table');
  if (!table) return toast('No table to export','error');
  const blob = new Blob([`<html><head><meta charset="utf-8"></head><body>${table.outerHTML}</body></html>`],
    { type:'application/vnd.ms-excel' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${title.replace(/[^a-z0-9]+/gi,'-').toLowerCase()}-${APP_STATE.currentFY}.xls`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function code39Svg(value, width, height) {
  const patterns = {
    '0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw','5':'wnnwwnnnn',
    '6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn','A':'wnnnnwnnw','B':'nnwnnwnnw',
    'C':'wnwnnwnnn','D':'nnnnwwnnw','E':'wnnnwwnnn','F':'nnwnwwnnn','G':'nnnnnwwnw','H':'wnnnnwwnn',
    'I':'nnwnnwwnn','J':'nnnnwwwnn','K':'wnnnnnnww','L':'nnwnnnnww','M':'wnwnnnnwn','N':'nnnnwnnww',
    'O':'wnnnwnnwn','P':'nnwnwnnwn','Q':'nnnnnnwww','R':'wnnnnnwwn','S':'nnwnnnwwn','T':'nnnnwnwwn',
    'U':'wwnnnnnnw','V':'nwwnnnnnw','W':'wwwnnnnnn','X':'nwnnwnnnw','Y':'wwnnwnnnn','Z':'nwwnwnnnn',
    '-':'nwnnnnwnw','.':'wwnnnnwnn',' ':'nwwnnnwnn','*':'nwnnwnwnn'
  };
  const clean = String(value || '').toUpperCase().replace(/[^0-9A-Z.\- ]/g,'-');
  const encoded = `*${clean}*`;
  const units = [...encoded].reduce((sum,char) => sum + [...patterns[char]].reduce((s,v) => s + (v === 'w' ? 3 : 1),0) + 1,0);
  const unit = Math.max(0.5,(width - 8) / units);
  let x = 4; let bars = '';
  [...encoded].forEach(char => {
    [...patterns[char]].forEach((kind,index) => {
      const barWidth = unit * (kind === 'w' ? 3 : 1);
      if (index % 2 === 0) bars += `<rect x="${x.toFixed(2)}" y="2" width="${barWidth.toFixed(2)}" height="${height-16}" fill="#000"/>`;
      x += barWidth;
    });
    x += unit;
  });
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${bars}
    <text x="${width/2}" y="${height-3}" text-anchor="middle" font-size="9" font-family="Arial">${esc(clean)}</text></svg>`;
}

function showBarcodeLabels(itemId) {
  const item = APP_STATE.items.find(row => Number(row.id) === Number(itemId));
  if (!item) return;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay'; modal.id = 'barcode-modal';
  modal.innerHTML = `<div class="modal-box modal-large"><div class="modal-header"><h3>Barcode Labels</h3>
    <button class="btn btn-secondary" onclick="document.getElementById('barcode-modal').remove()">Close</button></div>
    <div class="modal-body"><div class="form-row cols-4">
      <div class="form-group"><label>Printer / Sheet Type</label><select id="barcode-paper" onchange="updateBarcodeLayoutOptions(${item.id})">
        <option value="roll100">100 mm Label Printer Roll</option><option value="a4">A4 Label Sheet</option></select></div>
      <div class="form-group"><label>Label Size</label><select id="barcode-size" onchange="renderBarcodeSheet(${item.id})">
        <option value="38x25">Small 38 x 25 mm</option><option value="50x25" selected>Standard 50 x 25 mm</option>
        <option value="50x30">Medium 50 x 30 mm</option><option value="70x40">Large 70 x 40 mm</option></select></div>
      <div class="form-group"><label>Number of Labels</label><input type="number" id="barcode-count" min="1" max="100" value="12" onchange="renderBarcodeSheet(${item.id})"></div>
      <div class="form-group" style="align-self:end"><button class="btn btn-primary" onclick="printBarcodeSheet()">Print Labels</button></div>
    </div>
    <div id="barcode-layout-options" class="barcode-layout-options"></div>
    <div id="barcode-layout-summary" class="security-setting-note" style="margin-bottom:12px"></div>
    <div id="barcode-sheet"></div></div></div>`;
  document.body.appendChild(modal); updateBarcodeLayoutOptions(item.id);
}

function updateBarcodeLayoutOptions(itemId) {
  const paper = document.getElementById('barcode-paper')?.value || 'roll100';
  const options = document.getElementById('barcode-layout-options');
  if (paper === 'roll100') {
    options.innerHTML = `<div class="form-row cols-4">
      <div class="form-group"><label>Labels Per Row</label><select id="barcode-up" onchange="renderBarcodeSheet(${itemId})">
        <option value="1">1-up (one label per row)</option><option value="2" selected>2-up (two labels per row)</option></select></div>
      <div class="form-group"><label>Horizontal Gap (mm)</label><input type="number" id="barcode-gap-x" value="0" min="0" max="20" step="0.5" onchange="renderBarcodeSheet(${itemId})"></div>
      <div class="form-group"><label>Vertical Gap (mm)</label><input type="number" id="barcode-gap-y" value="2" min="0" max="20" step="0.5" onchange="renderBarcodeSheet(${itemId})"></div>
      <div class="form-group"><label>Roll Side Margin (mm)</label><input type="number" id="barcode-margin" value="0" min="0" max="20" step="0.5" onchange="renderBarcodeSheet(${itemId})"></div>
    </div>`;
  } else {
    options.innerHTML = `<div class="form-row cols-4">
      <div class="form-group"><label>Labels Per Row</label><input type="number" id="barcode-up" value="4" min="1" max="8" onchange="renderBarcodeSheet(${itemId})"></div>
      <div class="form-group"><label>Horizontal Gap (mm)</label><input type="number" id="barcode-gap-x" value="2" min="0" max="20" step="0.5" onchange="renderBarcodeSheet(${itemId})"></div>
      <div class="form-group"><label>Vertical Gap (mm)</label><input type="number" id="barcode-gap-y" value="2" min="0" max="20" step="0.5" onchange="renderBarcodeSheet(${itemId})"></div>
      <div class="form-group"><label>A4 Page Margin (mm)</label><input type="number" id="barcode-margin" value="5" min="0" max="30" step="0.5" onchange="renderBarcodeSheet(${itemId})"></div>
    </div>`;
  }
  renderBarcodeSheet(itemId);
}

function renderBarcodeSheet(itemId) {
  const item = APP_STATE.items.find(row => Number(row.id) === Number(itemId));
  const [width,height] = (document.getElementById('barcode-size')?.value || '50x25').split('x').map(Number);
  const count = Math.max(1,Math.min(100,Number(document.getElementById('barcode-count')?.value || 12)));
  const paper = document.getElementById('barcode-paper')?.value || 'roll100';
  const gapX = Math.max(0,Number(document.getElementById('barcode-gap-x')?.value || 0));
  const gapY = Math.max(0,Number(document.getElementById('barcode-gap-y')?.value || 0));
  const margin = Math.max(0,Number(document.getElementById('barcode-margin')?.value || 0));
  const requestedColumns = Math.max(1,Number(document.getElementById('barcode-up')?.value || 1));
  const printableWidth = (paper === 'a4' ? 210 : 100) - margin * 2;
  const maximumColumns = Math.max(1,Math.floor((printableWidth + gapX) / (width + gapX)));
  const columns = Math.min(requestedColumns,maximumColumns);
  const sheetWidth = paper === 'a4' ? 210 : 100;
  const summary = document.getElementById('barcode-layout-summary');
  if (summary) summary.textContent = `${paper === 'a4' ? 'A4 sheet (210 x 297 mm)' : '100 mm roll'}: ${columns}-up, ${width} x ${height} mm labels, ${gapX} mm horizontal gap, ${gapY} mm vertical gap, ${margin} mm margin.`;
  document.getElementById('barcode-sheet').innerHTML = `<div class="barcode-sheet ${paper === 'a4' ? 'barcode-a4' : 'barcode-roll'}"
    style="width:${sheetWidth}mm;padding:${margin}mm;grid-template-columns:repeat(${columns},${width}mm);column-gap:${gapX}mm;row-gap:${gapY}mm">${Array.from({length:count},() => `
    <div class="barcode-label" style="width:${width}mm;height:${height}mm">
      <div class="barcode-company">${esc(APP_STATE.currentOrg.display_name)}</div>
      <div class="barcode-name">${esc(item.name)}</div><div class="barcode-model">${esc(item.model_number || item.item_code || '')}</div>
      ${code39Svg(item.barcode || item.item_code,220,55)}
      <div class="barcode-mrp">MRP: ${fmt(item.mrp || item.last_sale_price)}</div>
    </div>`).join('')}</div>`;
}

function printBarcodeSheet() {
  const paper = document.getElementById('barcode-paper')?.value || 'roll100';
  document.body.dataset.barcodePaper = paper;
  let pageStyle = document.getElementById('barcode-page-style');
  if (!pageStyle) {
    pageStyle = document.createElement('style');
    pageStyle.id = 'barcode-page-style';
    document.head.appendChild(pageStyle);
  }
  pageStyle.textContent = paper === 'a4'
    ? '@media print { @page { size: A4 portrait; margin: 0; } }'
    : '@media print { @page { size: 100mm auto; margin: 0; } }';
  document.body.classList.add('printing-barcodes'); window.print();
  setTimeout(() => {
    document.body.classList.remove('printing-barcodes');
    delete document.body.dataset.barcodePaper;
    pageStyle.remove();
  },500);
}

async function renderAutomaticBackupSettings() {
  const settings = await api('GET','/backup/automatic-settings');
  document.getElementById('settings-content').innerHTML = `<div class="card" style="max-width:720px;margin-top:16px">
    <div class="section-title">Scheduled Automatic Backup</div>
    <label class="security-setting-toggle"><input type="checkbox" id="auto-backup-enabled" ${settings.enabled?'checked':''}>
      <span><strong>Enable automatic backup</strong><small>Creates a complete database copy on the main host computer.</small></span></label>
    <div class="form-row cols-2" style="margin-top:16px">
      <div class="form-group"><label>Backup Every (hours)</label><input type="number" id="auto-backup-hours" value="${settings.hours}" min="1" max="720"></div>
      <div class="form-group"><label>Local / Network / Cloud Sync Folder</label><input id="auto-backup-directory" value="${esc(settings.directory)}" placeholder="${esc(settings.effective_directory)}"></div>
    </div><p class="text-sm text-muted">Active folder: ${esc(settings.effective_directory)}</p>
    <div style="margin-top:14px"><button class="btn btn-success" onclick="saveAutomaticBackupSettings()">Save</button>
      <button class="btn btn-secondary" onclick="runAutomaticBackup()">Run Backup Now</button></div></div>`;
}

async function saveAutomaticBackupSettings() {
  try {
    await api('PUT','/backup/automatic-settings',{ enabled:document.getElementById('auto-backup-enabled').checked,
      hours:Number(document.getElementById('auto-backup-hours').value), directory:document.getElementById('auto-backup-directory').value });
    toast('Automatic backup settings saved','success');
  } catch (error) { toast(error.message,'error'); }
}

async function runAutomaticBackup() {
  try { const result=await api('POST','/backup/run-automatic',{}); toast(`Backup created: ${result.file_name}`,'success'); }
  catch (error) { toast(error.message,'error'); }
}

async function renderYearLockSettings() {
  const locks = await api('GET',`/business/locks?org_id=${APP_STATE.currentOrg.id}`);
  const locked = new Set(locks.filter(row => row.locked).map(row => row.fy));
  document.getElementById('settings-content').innerHTML = `<div class="card" style="max-width:650px;margin-top:16px">
    <div class="section-title">Financial Year Audit Lock</div>
    <p class="text-sm text-muted" style="margin-bottom:14px">Locked years reject new edits and vouchers. Unlocking is recorded.</p>
    ${getFYList().map(fy => `<div class="year-lock-row"><strong>${fy}</strong><label>
      <input type="checkbox" ${locked.has(fy)?'checked':''} onchange="setYearLock('${fy}',this.checked)"> Locked</label></div>`).join('')}</div>`;
}

async function setYearLock(fy,locked) {
  try { await api('PUT',`/business/locks/${fy}`,{org_id:APP_STATE.currentOrg.id,locked}); toast(`${fy} ${locked?'locked':'unlocked'}`,'success'); }
  catch (error) { toast(error.message,'error'); renderYearLockSettings(); }
}

const originalRenderUsersSettings = renderUsersSettings;
renderUsersSettings = function(users) {
  window.__settingsUsers = users;
  return originalRenderUsersSettings(users);
};

const originalShowUserModal = showUserModal;
showUserModal = function(userId) {
  originalShowUserModal(userId);
  const user = window.__settingsUsers?.find(row => Number(row.id) === Number(userId));
  let permissions = {};
  try { permissions = JSON.parse(user?.permissions || '{}'); } catch (_) {}
  const body = document.querySelector('#user-modal .modal-body');
  if (!body) return;
  const block = document.createElement('div');
  block.innerHTML = `<div class="section-title">Permissions</div><div class="permission-grid">
    ${['billing','pos','returns','shifts','purchases','purchase_orders','inventory','accounting',
      'bank_import','reports','profit','backup','scheduled_reports','diagnostics','settings','delete',
      'jobs_counter','jobs_operations','jobs_assign','jobs_assign_any','jobs_finance','jobs_catalog','jobs_whatsapp'].map(key =>
      `<label><input type="checkbox" id="perm-${key}" ${permissions[key] || user?.role === 'owner' ? 'checked' : ''}> ${key}</label>`).join('')}</div>`;
  body.insertBefore(block,body.lastElementChild);
  if (user) {
    document.getElementById('um-name').value=user.name; document.getElementById('um-uname').value=user.username;
    document.getElementById('um-uname').readOnly=true; document.getElementById('um-role').value=user.role;
    document.getElementById('um-orgaccess').value=user.org_access;
    document.getElementById('um-active').checked=Boolean(user.active);
  }
};

const originalSaveUser = saveUser;
saveUser = async function(id) {
  const permissionInputs = document.querySelectorAll('[id^="perm-"]');
  if (!permissionInputs.length) return originalSaveUser(id);
  const permissions={};
  permissionInputs.forEach(input => { permissions[input.id.replace('perm-','')]=input.checked; });
  const payload={name:document.getElementById('um-name').value.trim(),username:document.getElementById('um-uname').value.trim(),
    role:document.getElementById('um-role').value,org_access:document.getElementById('um-orgaccess').value,
    permissions,active:document.getElementById('um-active').checked};
  if (!id) payload.pin=document.getElementById('um-pin').value;
  const resetPin = id ? document.getElementById('um-reset-pin')?.value || '' : '';
  const resetConfirm = id ? document.getElementById('um-reset-confirm')?.value || '' : '';
  if (!id && !/^\d{4,6}$/.test(payload.pin)) return toast('PIN must contain 4 to 6 digits','error');
  if (resetPin || resetConfirm) {
    if (!/^\d{4,6}$/.test(resetPin)) return toast('PIN must contain 4 to 6 digits','error');
    if (resetPin !== resetConfirm) return toast('PINs do not match','error');
  }
  try {
    await api(id?'PUT':'POST',id?`/auth/users/${id}`:'/auth/users',payload);
    if (id && resetPin) await api('POST', `/auth/users/${id}/reset-pin`, { new_pin: resetPin });
    document.getElementById('user-modal')?.remove(); toast(id?'User updated':'User added','success'); renderSettings();
  } catch (error) { toast(error.message,'error'); }
};

const originalShowItemModal = showItemModal;
showItemModal = function(itemId) {
  originalShowItemModal(itemId);
  const item=APP_STATE.items.find(row => Number(row.id)===Number(itemId));
  const body=document.querySelector('#item-modal .modal-body');
  if (!body) return;
  const block=document.createElement('div');
  block.innerHTML=`<div class="section-title">Barcode and Stock</div>
    <div class="form-row cols-3">
      <div class="form-group"><label>Item Number</label><input id="im-code" value="${esc(item?.item_code||'')}" placeholder="Automatic"></div>
      <div class="form-group"><label>Model Name / Number</label><input id="im-model" value="${esc(item?.model_number||'')}"></div>
      <div class="form-group"><label>Barcode</label><input id="im-barcode" value="${esc(item?.barcode||'')}" placeholder="Automatic"></div>
    </div><div class="form-row cols-3">
      <div class="form-group"><label>MRP</label><input type="number" id="im-mrp" value="${item?.mrp||item?.last_sale_price||0}"></div>
      <div class="form-group"><label>Opening Stock</label><input type="number" id="im-opening" value="${item?.opening_stock||0}" step="0.001"></div>
      <div class="form-group"><label>Reorder Level</label><input type="number" id="im-reorder" value="${item?.reorder_level||0}" step="0.001"></div>
    </div>`;
  body.insertBefore(block,body.lastElementChild);
};

// ADVANCED POS, OPERATIONS AND PRODUCTION TOOLS
let posCart = [];
let activeShift = null;
let barcodeCameraStream = null;
let barcodeCameraTimer = null;

async function renderPOS() {
  if (!APP_STATE.currentOrg || !APP_STATE.user) return;
  let shifts;
  let held;
  try {
    [shifts, held] = await Promise.all([
      api('GET', `/advanced/shifts?org_id=${APP_STATE.currentOrg.id}`),
      api('GET', `/advanced/held-bills?org_id=${APP_STATE.currentOrg.id}`)
    ]);
  } catch (error) {
    document.getElementById('content').innerHTML = `
      <div class="empty-state"><p>POS could not load: ${esc(error.message)}</p>
        <button class="btn btn-primary" onclick="renderPOS()">Retry</button></div>`;
    return;
  }
  activeShift = shifts.find(shift => shift.status === 'open' && Number(shift.user_id) === Number(APP_STATE.user.id)) || null;
  document.getElementById('content').innerHTML = `
    <div class="card" style="margin-bottom:12px">
      <div class="page-header pos-page-header"><h3>Fast POS Counter</h3>
        <div class="pos-header-actions">
          ${activeShift ? `<span class="badge badge-saved">Shift Open: ${esc(activeShift.counter_name)}</span>`
            : `<button class="btn btn-primary" onclick="openShiftFromPOS()">Open Shift</button>`}
          <button class="btn btn-secondary pos-held-bills-button" id="pos-held-bills-button"
            onclick="showPOSHeldBills()">Held Bills${held.length ? ` (${held.length})` : ''}</button>
        </div>
      </div>
      <div class="form-row cols-3">
        <div class="form-group"><label>Scan Barcode / Item Number (F2)</label>
          <div style="display:flex;gap:6px"><input id="pos-scan" placeholder="Scan and press Enter" onkeydown="posScanKey(event)" autofocus>
            <button class="btn btn-outline" type="button" onclick="openBarcodeCamera()">Camera</button></div>
          <input type="file" id="pos-camera-file" accept="image/*" capture="environment" style="display:none" onchange="scanBarcodePhoto(this)"></div>
        <div class="form-group"><label>Quick Item Search</label>
          <input id="pos-item-search" list="pos-item-options" placeholder="Type item name" onchange="addPOSItem(Number(this.value));this.value=''">
          <datalist id="pos-item-options">${APP_STATE.items.map(item => `<option value="${item.id}">${esc(item.name)} | ${esc(item.barcode || item.item_code || '')}</option>`).join('')}</datalist>
        </div>
        <div class="form-group"><label>Customer</label>
          <select id="pos-party"><option value="">Cash Customer</option>${APP_STATE.parties.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
      </div>
    </div>
    <div class="card">
      <div style="display:grid;grid-template-columns:36px 1fr 90px 110px 120px 42px;gap:7px;font-weight:700;font-size:12px">
        <span>#</span><span>Item</span><span>Qty</span><span>Rate</span><span>Amount</span><span></span>
      </div>
      ${regularTaxCheckbox('pos-tax-inclusive','recalcPOS()')}
      ${roundOffCheckbox('pos-round-off','recalcPOS()')}
      <div id="pos-cart"></div>
      <div class="empty-state" id="pos-empty" style="padding:28px"><p>Scan an item to start billing</p></div>
    </div>
    <div class="bill-totals">
      <div class="card">
        <div class="section-title">Split Payment</div>
        <div class="form-row cols-4">
          ${['Cash','Card','UPI','Credit'].map(mode => `<div class="form-group"><label>${mode}</label>
            <input type="number" min="0" step="0.01" id="pos-pay-${mode.toLowerCase()}" value="0" oninput="recalcPOS()"></div>`).join('')}
        </div>
        <div id="pos-payment-balance" style="font-weight:700"></div>
      </div>
      <div class="totals-table card card-sm">
        <div class="totals-row"><span>Subtotal</span><span id="pos-subtotal">${fmt(0)}</span></div>
        <div class="totals-row"><span>Tax</span><span id="pos-tax">${fmt(0)}</span></div>
        <div class="totals-row"><span>Round Off</span><span id="pos-round-off-total">${fmt(0)}</span></div>
        <div class="totals-row grand"><span>Total</span><span id="pos-total">${fmt(0)}</span></div>
      </div>
    </div>
    <div class="pos-actions" style="flex-wrap:wrap">
      <button class="btn btn-secondary" onclick="holdPOSBill()">Hold Bill (F4)</button>
      <button class="btn btn-success" onclick="savePOSBill()">Pay & Save (F9)</button>
      <button class="btn btn-outline" onclick="posCart=[];renderPOSCart()">Clear</button>
      <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="pos-auto-print"
        ${localStorage.getItem('tarangini_pos_auto_print') === '1' ? 'checked' : ''}
        onchange="localStorage.setItem('tarangini_pos_auto_print',this.checked?'1':'0')"> Automatically print after sale</label>
    </div>
    <div class="card" id="pos-held-bills" style="margin-top:16px" tabindex="-1">
      <div class="section-title">Held Bills</div>
      ${held.length ? held.map(row => `<div class="year-lock-row"><span>${esc(row.hold_name)} <small>${fmtDate(row.updated_at)}</small></span>
        <button class="btn btn-xs btn-primary" onclick="resumePOSBill(${row.id})">Resume</button></div>`).join('')
        : '<p class="text-muted">No held bills.</p>'}
    </div>`;
  renderPOSCart();
  applyPOSControlVisibility();
  document.onkeydown = event => {
    if (APP_STATE.currentPage !== 'pos') return;
    if (event.key === 'F2') { event.preventDefault(); document.getElementById('pos-scan')?.focus(); }
    if (event.key === 'F4') { event.preventDefault(); holdPOSBill(); }
    if (event.key === 'F9') { event.preventDefault(); savePOSBill(); }
  };
}

function applyPOSControlVisibility() {
  setInputGroupVisible('pos-party', txShow('POS', 'party'));
  setElementVisible(document.getElementById('pos-held-bills-button'), txShow('POS', 'held_bill'));
  setElementVisible(document.getElementById('pos-held-bills'), txShow('POS', 'held_bill'));
  setElementVisible(document.getElementById('pos-tax-inclusive')?.closest('label'), txShow('POS', 'tax_inclusive'));
  setElementVisible(document.getElementById('pos-round-off')?.closest('label'), txShow('POS', 'round_off'));
  setElementVisible(document.querySelector('.bill-totals .card'), txShow('POS', 'split_payment') || txShow('POS', 'payment_mode'));
}

function showPOSHeldBills() {
  const section = document.getElementById('pos-held-bills');
  if (!section) return;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  section.focus({ preventScroll: true });
}

function posScanKey(event) {
  if (event.key !== 'Enter') return;
  const code = event.target.value.trim().toLowerCase();
  const item = APP_STATE.items.find(row =>
    String(row.barcode || '').toLowerCase() === code ||
    String(row.item_code || '').toLowerCase() === code ||
    String(row.name || '').toLowerCase() === code);
  if (!item) return toast(`Item not found: ${event.target.value}`, 'error');
  addPOSItem(item.id);
  event.target.value = '';
}

function addPOSItemByCode(rawCode) {
  const code = String(rawCode || '').trim().toLowerCase();
  const item = APP_STATE.items.find(row =>
    String(row.barcode || '').toLowerCase() === code ||
    String(row.item_code || '').toLowerCase() === code ||
    String(row.name || '').toLowerCase() === code);
  if (!item) {
    toast(`Item not found: ${rawCode}`, 'error');
    return false;
  }
  addPOSItem(item.id);
  return true;
}

async function openBarcodeCamera() {
  if (!('BarcodeDetector' in window)) {
    document.getElementById('pos-camera-file')?.click();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    document.getElementById('pos-camera-file')?.click();
    return;
  }
  try {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'barcode-camera-modal';
    modal.innerHTML = `<div class="modal-box modal-medium">
      <div class="modal-header"><h3>Scan Item Barcode</h3>
        <button class="btn btn-secondary btn-sm" onclick="closeBarcodeCamera()">Close</button></div>
      <div class="modal-body"><video id="barcode-camera-video" autoplay playsinline
        style="width:100%;max-height:60vh;background:#000;border-radius:10px"></video>
        <p class="text-muted" style="margin-top:8px">Hold the barcode steady inside the camera view.</p></div></div>`;
    document.body.appendChild(modal);
    barcodeCameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }, audio: false
    });
    const video = document.getElementById('barcode-camera-video');
    video.srcObject = barcodeCameraStream;
    const detector = new BarcodeDetector();
    barcodeCameraTimer = setInterval(async () => {
      if (video.readyState < 2) return;
      try {
        const codes = await detector.detect(video);
        if (codes[0]?.rawValue && addPOSItemByCode(codes[0].rawValue)) closeBarcodeCamera();
      } catch (_) {}
    }, 500);
  } catch (error) {
    closeBarcodeCamera();
    toast('Live camera is unavailable here. Opening the phone camera for a barcode photo.', 'warning');
    document.getElementById('pos-camera-file')?.click();
  }
}

function closeBarcodeCamera() {
  clearInterval(barcodeCameraTimer);
  barcodeCameraTimer = null;
  barcodeCameraStream?.getTracks().forEach(track => track.stop());
  barcodeCameraStream = null;
  document.getElementById('barcode-camera-modal')?.remove();
}

async function scanBarcodePhoto(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!('BarcodeDetector' in window)) {
    toast('Automatic photo scanning is not supported by this browser. Enter the barcode manually.', 'warning');
    document.getElementById('pos-scan')?.focus();
    return;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const codes = await new BarcodeDetector().detect(bitmap);
    bitmap.close();
    if (!codes[0]?.rawValue || !addPOSItemByCode(codes[0].rawValue)) {
      toast('No known barcode was found in the photo', 'error');
    }
  } catch (error) {
    toast('Could not read that barcode photo', 'error');
  }
}

function addPOSItem(itemId) {
  const item = APP_STATE.items.find(row => Number(row.id) === Number(itemId));
  if (!item) return;
  const existing = posCart.find(row => Number(row.item_id) === Number(item.id));
  if (existing) existing.qty += 1;
  else posCart.push({
    item_id: item.id, item_name: item.name, hsn_code: item.hsn_code || '',
    qty: 1, unit: item.unit || 'NOS', rate: Number(item.last_sale_price || item.mrp || 0),
    gst_rate: Number(item.gst_rate || 18)
  });
  renderPOSCart();
}

function renderPOSCart() {
  const container = document.getElementById('pos-cart');
  if (!container) return;
  container.innerHTML = posCart.map((item, index) => `
    <div style="display:grid;grid-template-columns:36px 1fr 90px 110px 120px 42px;gap:7px;margin-top:8px;align-items:center">
      <span>${index + 1}</span><strong>${esc(item.item_name)}</strong>
      <input type="number" min="0.001" step="0.001" value="${item.qty}" oninput="posCart[${index}].qty=Number(this.value);recalcPOS()">
      <input type="number" min="0" step="0.01" value="${item.rate}" oninput="posCart[${index}].rate=Number(this.value);recalcPOS()">
      <span id="pos-line-${index}">${fmt(item.qty * item.rate)}</span>
      <button class="btn btn-xs btn-secondary" onclick="posCart.splice(${index},1);renderPOSCart()">x</button>
    </div>`).join('');
  document.getElementById('pos-empty').style.display = posCart.length ? 'none' : '';
  recalcPOS();
}

function posTotals() {
  const subtotal = posCart.reduce((sum, item) => sum + Number(item.qty) * Number(item.rate), 0);
  const inclusive = Boolean(document.getElementById('pos-tax-inclusive')?.checked);
  const tax = APP_STATE.currentOrg.gst_type === 'regular'
    ? inclusive ? subtotal * 18 / 118 : subtotal * 0.18
    : 0;
  const beforeRound = inclusive ? subtotal : subtotal + tax;
  const roundOff = document.getElementById('pos-round-off')?.checked
    ? Math.round(beforeRound) - beforeRound : 0;
  return { subtotal, tax, roundOff, total: beforeRound + roundOff, inclusive };
}

function recalcPOS() {
  posCart.forEach((item, index) => {
    const line = document.getElementById(`pos-line-${index}`);
    if (line) line.textContent = fmt(Number(item.qty) * Number(item.rate));
  });
  const totals = posTotals();
  const paid = ['cash','card','upi','credit'].reduce((sum, mode) =>
    sum + Number(document.getElementById(`pos-pay-${mode}`)?.value || 0), 0);
  if (document.getElementById('pos-subtotal')) document.getElementById('pos-subtotal').textContent = fmt(totals.subtotal);
  if (document.getElementById('pos-tax')) document.getElementById('pos-tax').textContent = fmt(totals.tax);
  if (document.getElementById('pos-round-off-total')) document.getElementById('pos-round-off-total').textContent = fmt(totals.roundOff);
  if (document.getElementById('pos-total')) document.getElementById('pos-total').textContent = fmt(totals.total);
  const balance = document.getElementById('pos-payment-balance');
  if (balance) balance.textContent = `Payment balance: ${fmt(totals.total - paid)}`;
}

async function openShiftFromPOS() {
  const counter = prompt('Counter name', localStorage.getItem('tarangini_counter_name') || 'Main Counter');
  if (!counter) return;
  const opening = Number(prompt('Opening cash amount', '0') || 0);
  localStorage.setItem('tarangini_counter_name', counter);
  try {
    await api('POST', '/advanced/shifts/open', {
      org_id: APP_STATE.currentOrg.id, counter_name: counter, opening_cash: opening
    });
    toast('Counter shift opened', 'success');
    await renderPOS();
  } catch (error) {
    toast(`Could not open shift: ${error.message}`, 'error');
  }
}

async function holdPOSBill() {
  if (!posCart.length) return toast('Cart is empty', 'error');
  const holdName = prompt('Name this held bill', `Held ${new Date().toLocaleTimeString('en-IN')}`);
  if (!holdName) return;
  try {
    await api('POST', '/advanced/held-bills', {
      org_id: APP_STATE.currentOrg.id, shift_id: activeShift?.id, hold_name: holdName,
      cart: {
        items: posCart, party_id: document.getElementById('pos-party').value,
        payments: ['cash','card','upi','credit'].reduce((out, mode) => {
          out[mode] = Number(document.getElementById(`pos-pay-${mode}`).value || 0); return out;
        }, {}),
        tax_inclusive: Boolean(document.getElementById('pos-tax-inclusive')?.checked)
        ,round_off_enabled: Boolean(document.getElementById('pos-round-off')?.checked)
      }
    });
    posCart = [];
    toast('Bill held', 'success');
    await renderPOS();
  } catch (error) {
    toast(`Could not hold bill: ${error.message}`, 'error');
  }
}

async function resumePOSBill(id) {
  const rows = await api('GET', `/advanced/held-bills?org_id=${APP_STATE.currentOrg.id}`);
  const held = rows.find(row => Number(row.id) === Number(id));
  if (!held) return;
  const cart = JSON.parse(held.cart_json || '{}');
  posCart = cart.items || [];
  await api('DELETE', `/advanced/held-bills/${id}`);
  await renderPOS();
  document.getElementById('pos-party').value = cart.party_id || '';
  if (document.getElementById('pos-tax-inclusive')) {
    document.getElementById('pos-tax-inclusive').checked = Boolean(cart.tax_inclusive);
  }
  if (document.getElementById('pos-round-off')) {
    document.getElementById('pos-round-off').checked = cart.round_off_enabled !== false;
  }
  Object.entries(cart.payments || {}).forEach(([mode, amount]) => {
    const input = document.getElementById(`pos-pay-${mode}`);
    if (input) input.value = amount;
  });
  recalcPOS();
}

async function savePOSBill() {
  if (!activeShift) return toast('Open a counter shift before billing', 'error');
  if (!posCart.length) return toast('Cart is empty', 'error');
  const totals = posTotals();
  let split = ['cash','card','upi','credit'].map(mode => ({
    mode, amount: Number(document.getElementById(`pos-pay-${mode}`).value || 0)
  })).filter(payment => payment.amount > 0);
  if (!split.length) {
    document.getElementById('pos-pay-cash').value = totals.total.toFixed(2);
    split = [{ mode: 'cash', amount: totals.total }];
  }
  const paid = split.reduce((sum, payment) => sum + payment.amount, 0);
  if (Math.abs(paid - totals.total) > 0.02) return toast('Split payments must equal the invoice total', 'error');
  if (split.some(payment => payment.mode === 'credit') && !document.getElementById('pos-party').value) {
    return toast('Select a customer for credit payment', 'error');
  }
  if (!requireVisibleFields('POS', [
    { field: 'party', label: 'Customer', valid: () => Boolean(document.getElementById('pos-party')?.value) },
    { field: 'qty_unit', label: 'Qty / Unit', valid: () => posCart.every(item => Number(item.qty || 0) > 0) },
    { field: 'rate', label: 'Rate', valid: () => posCart.every(item => Number(item.rate || 0) > 0) },
    { field: 'amount', label: 'Amount', valid: () => totals.total > 0 },
    { field: 'split_payment', label: 'Split Payment', valid: () => split.length > 0 }
  ])) return;
  try {
    const result = await api('POST', '/bills', {
      org_id: APP_STATE.currentOrg.id, format: 'SALE', bill_date: today(),
      party_id: document.getElementById('pos-party').value || null,
      payment_mode: split.length > 1 ? 'split' : split[0].mode,
      split_payments: split, shift_id: activeShift.id,
      tax_inclusive: Boolean(document.getElementById('pos-tax-inclusive')?.checked),
      round_off_enabled: Boolean(document.getElementById('pos-round-off')?.checked),
      items: posCart.map(item => ({ ...item, amount: Number(item.qty) * Number(item.rate) }))
    });
    toast(result.offline_pending ? 'POS invoice saved offline and queued for sync' : 'POS invoice saved',
      result.offline_pending ? 'warning' : 'success');
    if (!result.offline_pending) {
      const receiptSplit = split.filter(payment => !['cash', 'credit'].includes(payment.mode));
      if (receiptSplit.length) {
        await offerLinkedBankReceipt(result.bill, {
          payment_mode: receiptSplit.length === split.length && receiptSplit.length === 1 ? receiptSplit[0].mode : 'split',
          split_payments: [
            ...receiptSplit,
            ...(split.some(payment => payment.mode === 'cash') ? [{ mode: 'cash', amount: 0 }] : [])
          ]
        });
      }
    }
    posCart = [];
    renderPOSCart();
    showThermalReceipt(result.bill);
    if (localStorage.getItem('tarangini_pos_auto_print') === '1') setTimeout(() => printThermal(80), 250);
  } catch (error) {
    toast(`POS invoice was not saved: ${error.message}`, 'error');
  }
}

function showThermalReceipt(bill) {
  const org = bill.org || APP_STATE.currentOrg;
  const party = bill.party || (bill.party_snapshot ? JSON.parse(bill.party_snapshot) : null);
  const items = bill.items || JSON.parse(bill.items_json || '[]');
  let paymentSplit = [];
  try { paymentSplit = JSON.parse(bill.split_payments || '[]'); } catch (_) {}
  const showQtyUnit = txPrint('POS', 'qty_unit');
  const showAmount = txPrint('POS', 'amount');
  document.getElementById('preview-content').innerHTML = `
    <div class="thermal-actions"><button class="btn btn-primary" onclick="printThermal(80)">Print 80 mm</button>
      <button class="btn btn-secondary" onclick="printThermal(58)">Print 58 mm</button></div>
    <div class="thermal-receipt invoice-theme-${invoiceTheme(org)}" id="thermal-content">
      ${txPrint('POS', 'company_logo') && org.logo_base64 ? `<img src="${org.logo_base64}" style="max-width:80px;max-height:45px">` : ''}
      <h2>${esc(org.display_name)}</h2><div>${esc(org.address || '')}</div>
      ${txPrint('POS', 'gstin') && org.gstin ? `<div>GSTIN: ${esc(org.gstin)}</div>` : ''}
      <hr><strong>${org.gst_type === 'composition' ? 'BILL OF SUPPLY' : 'TAX INVOICE'}</strong>
      <div>${esc(bill.bill_number)} | ${fmtDate(bill.bill_date)}</div>
      ${txPrint('POS', 'party') ? `<div>Customer: ${esc(party?.name || 'Cash Customer')}</div>` : ''}<hr>
      ${items.map(item => `<div class="thermal-line"><span>${esc(item.item_name)}${showQtyUnit ? ` x ${fmtN(item.qty)}` : ''}</span>
        ${showAmount ? `<strong>${fmt(Number(item.qty) * Number(item.rate))}</strong>` : ''}</div>`).join('')}
      ${txPrint('POS', 'round_off') && Math.abs(Number(bill.round_off || 0)) > 0.001
        ? `<div class="thermal-line"><span>Round Off</span><strong>${fmt(bill.round_off)}</strong></div>` : ''}
      <hr><div class="thermal-line"><strong>TOTAL</strong><strong>${fmt(bill.grand_total)}</strong></div>
      ${txPrint('POS', 'split_payment') && paymentSplit.length ? paymentSplit.map(row =>
        `<div class="thermal-line"><span>${esc(String(row.mode).toUpperCase())}</span><span>${fmt(row.amount)}</span></div>`
      ).join('') : ''}
      ${txPrint('POS', 'operator') && (bill.created_by_name || bill.created_by_username) ? `<div>By: ${esc(bill.created_by_name || bill.created_by_username)}</div>` : ''}
      <div style="text-align:center;margin-top:12px">Thank you</div>
    </div>`;
  document.getElementById('preview-title').textContent = `Thermal Receipt - ${bill.bill_number}`;
  document.getElementById('preview-modal').style.display = 'flex';
}

function printThermal(width = 80) {
  document.body.dataset.thermalWidth = width;
  window.print();
  setTimeout(() => delete document.body.dataset.thermalWidth, 500);
}

async function renderReturns() {
  const bills = await api('GET', `/bills?org_id=${APP_STATE.currentOrg.id}&format=SALE&fy=${APP_STATE.currentFY}`);
  document.getElementById('content').innerHTML = `
    <div class="card">
      <div class="section-title">Return Against Original Invoice</div>
      <div class="form-row cols-3">
        <div class="form-group"><label>Invoice</label><select id="return-bill" onchange="loadReturnBill()">
          <option value="">Select invoice</option>${bills.map(b => `<option value="${b.id}">${esc(b.bill_number)} | ${esc(b.party_name || 'Cash')} | ${fmt(b.grand_total)}</option>`).join('')}</select></div>
        <div class="form-group"><label>Return Date</label><input type="date" id="return-date" value="${today()}"></div>
        <div class="form-group"><label>Refund Method</label><select id="return-refund"><option value="">Credit note only</option>
          <option value="cash">Cash Refund</option><option value="account">Bank / UPI Refund</option></select></div>
      </div>
      ${regularTaxCheckbox('return-tax-inclusive')}
      ${roundOffCheckbox('return-round-off')}
      <div id="return-items"></div>
      <div class="form-group"><label>Reason</label><input id="return-reason" placeholder="Return / exchange reason"></div>
      <button class="btn btn-success" onclick="saveReturn()">Save Return</button>
    </div>`;
  applyReturnControlVisibility();
}

function applyReturnControlVisibility() {
  setInputGroupVisible('return-bill', txShow('RETURN', 'linked_bills'));
  setInputGroupVisible('return-refund', txShow('RETURN', 'payment_mode'));
  setInputGroupVisible('return-reason', txShow('RETURN', 'reason'));
  setElementVisible(document.getElementById('return-tax-inclusive')?.closest('label'), txShow('RETURN', 'tax_inclusive'));
  setElementVisible(document.getElementById('return-round-off')?.closest('label'), txShow('RETURN', 'round_off'));
}

let returnBillData = null;
async function loadReturnBill() {
  const id = document.getElementById('return-bill').value;
  if (!id) return;
  returnBillData = await api('GET', `/bills/${id}`);
  if (document.getElementById('return-tax-inclusive')) {
    document.getElementById('return-tax-inclusive').checked = Boolean(Number(returnBillData.tax_inclusive || 0));
  }
  const items = returnBillData.items || [];
  document.getElementById('return-items').innerHTML = `
    <div class="table-wrap"><table><thead><tr><th>Return</th><th>Item</th><th>Sold</th><th>Return Qty</th><th>Rate</th></tr></thead><tbody>
    ${items.map((item, i) => `<tr><td><input type="checkbox" id="ret-use-${i}"></td><td>${esc(item.item_name)}</td>
      <td>${fmtN(item.qty)}</td><td><input type="number" id="ret-qty-${i}" min="0" max="${item.qty}" value="0"></td>
      <td>${fmt(item.rate)}</td></tr>`).join('')}</tbody></table></div>`;
}

async function saveReturn() {
  if (!returnBillData) return toast('Select an invoice', 'error');
  const items = returnBillData.items.map((item, i) => ({
    ...item, qty: Number(document.getElementById(`ret-qty-${i}`)?.value || 0)
  })).filter((item, i) => document.getElementById(`ret-use-${i}`)?.checked && item.qty > 0);
  if (!items.length) return toast('Select returned items and quantities', 'error');
  if (!requireVisibleFields('RETURN', [
    { field: 'linked_bills', label: 'Original Invoice Link', valid: () => Boolean(returnBillData) },
    { field: 'reason', label: 'Reason', valid: () => Boolean(document.getElementById('return-reason')?.value) },
    { field: 'qty_unit', label: 'Qty / Unit', valid: () => items.every(item => Number(item.qty || 0) > 0) },
    { field: 'amount', label: 'Amount', valid: () => items.length > 0 }
  ])) return;
  await api('POST', '/advanced/returns', {
    org_id: APP_STATE.currentOrg.id, bill_id: returnBillData.id,
    note_date: document.getElementById('return-date').value,
    refund_mode: document.getElementById('return-refund').value,
    tax_inclusive: Boolean(document.getElementById('return-tax-inclusive')?.checked),
    round_off_enabled: Boolean(document.getElementById('return-round-off')?.checked),
    shift_id: activeShift?.id, narration: document.getElementById('return-reason').value, items
  });
  toast('Return and refund recorded', 'success');
  renderReturns();
}

async function renderShifts() {
  const shifts = await api('GET', `/advanced/shifts?org_id=${APP_STATE.currentOrg.id}`);
  document.getElementById('content').innerHTML = `
    <div class="page-header"><h3>Counter Shifts</h3><button class="btn btn-primary" onclick="openShiftFromPOS()">Open My Shift</button></div>
    ${businessRegister('Shift History',['Status','Counter','User','Opened','Closed','Opening','Sales','Expected','Counted','Variance','Action'],
      shifts.map(shift => [
        shift.status,shift.counter_name,shift.user_name,fmtDate(shift.opened_at),fmtDate(shift.closed_at),
        fmt(shift.opening_cash),fmt(shift.sales_total),fmt(shift.expected_cash),shift.counted_cash==null?'-':fmt(shift.counted_cash),
        shift.counted_cash==null?'-':fmt(shift.variance),
        `${shift.status === 'open' ? `<button class="btn btn-xs btn-success" onclick="closeShift(${shift.id})">Close</button>` : ''}
         <button class="btn btn-xs btn-outline" onclick="showShiftReport(${shift.id})">Handover</button>
         ${shift.owner_accepted ? '<span class="badge badge-saved">Accepted</span>' : ''}`
      ]))}`;
}

async function closeShift(id) {
  const counted = prompt('Counted cash amount');
  if (counted === null) return;
  const result = await api('PUT', `/advanced/shifts/${id}/close`, { counted_cash: Number(counted) });
  toast(`Shift closed. Variance: ${fmt(result.variance)}`, result.variance ? 'warning' : 'success');
  renderShifts();
}

async function showShiftReport(id) {
  try {
    const report = await api('GET', `/advanced/shifts/${id}/report`);
    const c = report.collections || {};
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'shift-report-modal';
    modal.innerHTML = `<div class="modal-box modal-large">
      <div class="modal-header"><h3>Collection / Handover Report</h3>
        <button class="btn btn-secondary btn-sm" onclick="this.closest('.modal-overlay').remove()">Close</button></div>
      <div class="modal-body">
        <div class="form-row cols-4">
          <div class="stat-card"><div class="stat-label">Operator</div><div class="stat-value" style="font-size:16px">${esc(report.shift.user_name)}</div></div>
          <div class="stat-card"><div class="stat-label">Counter</div><div class="stat-value" style="font-size:16px">${esc(report.shift.counter_name)}</div></div>
          <div class="stat-card"><div class="stat-label">Opened</div><div class="stat-value" style="font-size:16px">${fmtDate(report.shift.opened_at)}</div></div>
          <div class="stat-card"><div class="stat-label">Closed</div><div class="stat-value" style="font-size:16px">${fmtDate(report.shift.closed_at)}</div></div>
        </div>
        ${businessRegister('Collections',['Cash','Bank','UPI','Card','Credit / Pending','Refunds'],
          [[fmt(c.cash),fmt(c.bank),fmt(c.upi),fmt(c.card),fmt(report.pending_amount),fmt(report.refund_amount)]])}
        ${businessRegister('Cash Handover',['Expected Cash','Actual Handover','Variance'],
          [[fmt(report.expected_cash),report.actual_cash == null ? '-' : fmt(report.actual_cash),report.variance == null ? '-' : fmt(report.variance)]])}
        ${businessRegister('Bank References',['Voucher','Mode','Amount','Reference'],
          (report.bank_references || []).map(row => [row.payment_number,row.mode,fmt(row.amount),row.reference || '-']))}
        ${report.shift.owner_accepted
          ? `<p class="security-setting-note">Accepted by ${esc(report.shift.accepted_by_name || 'Owner')} on ${fmtDate(report.shift.accepted_at)}. ${esc(report.shift.acceptance_note || '')}</p>`
          : APP_STATE.user.role === 'owner' && report.shift.status === 'closed'
            ? `<div class="form-group"><label>Owner acceptance note</label><textarea id="shift-accept-note"></textarea></div>
               <button class="btn btn-success" onclick="acceptShiftHandover(${report.shift.id})">Accept Handover</button>`
            : '<p class="security-setting-note">Awaiting owner acceptance.</p>'}
      </div></div>`;
    document.body.appendChild(modal);
  } catch (error) { toast(error.message, 'error'); }
}

async function acceptShiftHandover(id) {
  try {
    await api('PUT', `/advanced/shifts/${id}/accept`, {
      note: document.getElementById('shift-accept-note')?.value || ''
    });
    document.getElementById('shift-report-modal')?.remove();
    toast('Shift handover accepted', 'success');
    renderShifts();
  } catch (error) { toast(error.message, 'error'); }
}

async function renderUpdateManager() {
  const status = await api('GET', '/advanced/update-status');
  const unsafe = status.unsafe_clients || [];
  document.getElementById('content').innerHTML = `
    <div class="page-header"><h2>Update Manager</h2>
      ${status.update_available ? '<button class="btn btn-primary" onclick="downloadVerifiedUpdate()">Download Verified Installer</button>' : ''}
    </div>
    <div class="form-row cols-3">
      <div class="stat-card"><div class="stat-label">Current Version</div><div class="stat-value">${esc(status.current_version)}</div></div>
      <div class="stat-card ${status.update_available ? 'gold' : 'green'}"><div class="stat-label">Latest Version</div><div class="stat-value">${esc(status.latest_version)}</div></div>
      <div class="stat-card ${status.upgrade_safe ? 'green' : 'red'}"><div class="stat-label">Upgrade Preflight</div>
        <div class="stat-value" style="font-size:18px">${status.upgrade_safe ? 'Safe' : 'Blocked'}</div></div>
    </div>
    ${status.package ? `<div class="card" style="margin-top:16px">
      <div class="section-title">Published LAN Package</div>
      <p><strong>${esc(status.package.file_name)}</strong></p>
      <p class="mono text-sm">SHA-256: ${esc(status.package.sha256)}</p>
      <p class="text-muted">${esc(status.package.release_notes || 'No release notes')}</p>
    </div>` : ''}
    ${unsafe.length ? businessRegister('Unsafe Clients',['Client','IP','Version','Pending','Conflicts','Last Seen'],
      unsafe.map(client => [client.client_name,client.ip,client.app_version || '-',client.pending_sync,client.sync_conflicts,fmtDate(client.last_seen)])) : ''}
    ${APP_STATE.user.role === 'owner' ? `<div class="card" style="margin-top:16px">
      <div class="section-title">Publish Installer on Main System</div>
      <p class="security-setting-note">Registration recomputes SHA-256, blocks pending offline work, and creates a pre-upgrade database recovery copy.</p>
      <div class="form-row cols-2">
        <div class="form-group"><label>Version</label><input id="update-version" value="2.3.3"></div>
        <div class="form-group"><label>Installer path on main system</label><input id="update-file-path" placeholder="C:\\path\\Tarangini Billing Setup 2.3.3.exe"></div>
      </div>
      <div class="form-group"><label>Expected SHA-256</label><input id="update-sha256" class="mono" maxlength="64"></div>
      <div class="form-group"><label>Release notes</label><textarea id="update-release-notes" rows="3"></textarea></div>
      <button class="btn btn-success" onclick="publishUpdatePackage()">Verify and Publish</button>
    </div>` : ''}`;
}

async function publishUpdatePackage() {
  try {
    const result = await api('POST', '/advanced/update-packages', {
      version: document.getElementById('update-version').value,
      file_path: document.getElementById('update-file-path').value,
      sha256: document.getElementById('update-sha256').value,
      release_notes: document.getElementById('update-release-notes').value
    });
    toast(`Update published. Recovery backup: ${result.recovery_backup}`, 'success');
    renderUpdateManager();
  } catch (error) { toast(error.message, 'error'); }
}

async function downloadVerifiedUpdate() {
  try {
    const response = await fetch('/api/advanced/update-package/download', {
      headers: { Authorization: `Bearer ${APP_STATE.token}` }
    });
    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error || 'Update download failed');
    }
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = response.headers.get('content-disposition')?.match(/filename="?([^";]+)"?/)?.[1] || 'Tarangini-update.exe';
    link.click();
    URL.revokeObjectURL(link.href);
    toast('Verified installer downloaded. Close Tarangini Billing before running it.', 'success');
  } catch (error) { toast(error.message, 'error'); }
}

async function renderPurchaseOrders() {
  window.__activeBusinessControlType = 'PO';
  const [orders, suppliers] = await Promise.all([
    api('GET', `/advanced/purchase-orders?org_id=${APP_STATE.currentOrg.id}&fy=${APP_STATE.currentFY}`),
    api('GET', `/advanced/supplier-balances?org_id=${APP_STATE.currentOrg.id}`)
  ]);
  businessItems = [{}];
  document.getElementById('content').innerHTML = `
    <div class="card">
      <div class="section-title">New Purchase Order</div>
      <div class="form-row cols-3">
        <div class="form-group"><label>Date</label><input type="date" id="po-date" value="${today()}"></div>
        <div class="form-group"><label>Expected Date</label><input type="date" id="po-expected"></div>
        <div class="form-group"><label>Supplier</label><select id="po-party"><option value="">Select supplier</option>
          ${APP_STATE.parties.filter(p => ['supplier','both'].includes(p.type)).map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
      </div>
      <div id="business-items"></div><button class="btn btn-outline btn-sm" onclick="addBusinessItem()">+ Add Item</button>
      ${regularTaxCheckbox('po-tax-inclusive')}
      ${roundOffCheckbox('po-round-off')}
      <div class="form-group"><label>Narration</label><input id="po-narration"></div>
      <button class="btn btn-success" onclick="savePurchaseOrder()">Save Purchase Order</button>
    </div>
    ${businessRegister('Purchase Orders',['Date','PO Number','Supplier','Expected','Amount','Status','Action'],
      orders.map(order => [fmtDate(order.po_date),order.po_number,order.party_name||'-',fmtDate(order.expected_date),
        fmt(order.subtotal),order.status,
        `${order.status==='open'?`<button class="btn btn-xs btn-primary" onclick="convertPurchaseOrder(${order.id})">Convert to Purchase</button>`:''}
         <button class="btn btn-xs btn-outline" onclick="showDuplicateVoucher('purchase_order',${order.id},'purchase-orders')">Duplicate</button>`]))}
    ${businessRegister('Supplier Outstanding',['Supplier','Outstanding','Action'],
      suppliers.map(row => [row.name,fmt(row.outstanding),`<button class="btn btn-xs btn-success" onclick="paySupplier(${row.id},${row.outstanding})">Record Payment</button>`]))}`;
  renderBusinessItems();
  applyBusinessControlVisibility('PO');
}

async function paySupplier(partyId, outstanding) {
  const amount = Number(prompt('Supplier payment amount', Number(outstanding).toFixed(2)));
  if (!amount) return;
  const mode = prompt('Payment mode: cash or account', 'account') || 'account';
  await api('POST', '/payments', {
    org_id: APP_STATE.currentOrg.id, payment_date: today(), party_id: partyId,
    type: 'paid', mode, amount, narration: 'Supplier payment'
  });
  toast('Supplier payment recorded', 'success');
  renderPurchaseOrders();
}

async function savePurchaseOrder() {
  const items = collectBusinessItems();
  if (!items.length) return toast('Add purchase-order items', 'error');
  if (!requireBusinessVisibleFields('PO', {
    party_id: document.getElementById('po-party')?.value,
    expected_date: document.getElementById('po-expected')?.value,
    narration: document.getElementById('po-narration')?.value,
    items
  })) return;
  await api('POST', '/advanced/purchase-orders', {
    org_id: APP_STATE.currentOrg.id, po_date: document.getElementById('po-date').value,
    expected_date: document.getElementById('po-expected').value,
    party_id: document.getElementById('po-party').value || null,
    narration: document.getElementById('po-narration').value,
    tax_inclusive: Boolean(document.getElementById('po-tax-inclusive')?.checked),
    round_off_enabled: Boolean(document.getElementById('po-round-off')?.checked),
    items
  });
  toast('Purchase order saved', 'success');
  renderPurchaseOrders();
}

async function convertPurchaseOrder(id) {
  const supplierInvoice = prompt('Supplier invoice number (optional)', '') ?? '';
  await api('POST', `/advanced/purchase-orders/${id}/convert`, {
    purchase_date: today(), supplier_invoice: supplierInvoice, payment_mode: 'credit'
  });
  toast('Purchase order converted and stock updated', 'success');
  await loadMasterData();
  renderPurchaseOrders();
}

async function renderProfitability() {
  const data = await api('GET', `/advanced/profitability?org_id=${APP_STATE.currentOrg.id}&fy=${APP_STATE.currentFY}`);
  document.getElementById('content').innerHTML = `
    <div class="stats-grid"><div class="stat-card gold"><div class="stat-label">Revenue</div><div class="stat-value">${fmt(data.totals.revenue)}</div></div>
      <div class="stat-card red"><div class="stat-label">Estimated Cost</div><div class="stat-value">${fmt(data.totals.cost)}</div></div>
      <div class="stat-card green"><div class="stat-label">Gross Profit</div><div class="stat-value">${fmt(data.totals.profit)}</div></div></div>
    ${businessRegister('Invoice Profitability',['Date','Invoice','Customer','Revenue','Cost','Gross Profit'],
      data.invoices.map(row => [fmtDate(row.bill_date),row.bill_number,row.party_name||'Cash',fmt(row.taxable_amount),fmt(row.cost_total),fmt(row.gross_profit)]))}
    ${businessRegister('Item Profitability',['Item','Revenue','Estimated Cost','Gross Profit'],
      data.items.map(row => [row.item_name,fmt(row.revenue),fmt(row.cost),fmt(row.profit)]))}
    ${businessRegister('Customer Profitability',['Customer','Invoices','Revenue','Estimated Cost','Gross Profit'],
      data.customers.map(row => [row.customer_name,row.invoice_count,fmt(row.revenue),fmt(row.cost),fmt(row.profit)]))}`;
}

async function renderNetworkStatus() {
  const data = await api('GET', '/advanced/network-status');
  document.getElementById('content').innerHTML = `
    <div class="stats-grid"><div class="stat-card green"><div class="stat-label">Connected Computers</div>
      <div class="stat-value">${data.connected_clients}</div></div></div>
    ${businessRegister('Live Intranet Clients',['Computer','User','Role','Company ID','Current Screen','IP','Last Seen'],
      data.clients.map(client => [client.client_name,client.user_name,client.role,client.org_id,client.page,client.ip,fmtDate(client.last_seen)]))}`;
  setTimeout(() => { if (APP_STATE.currentPage === 'network-status') renderNetworkStatus(); }, 30000);
}

async function renderOfflineSync(showLoader = true) {
  if (showLoader) showLoading();
  const status = OFFLINE_STATUS || await getOfflineStatus();
  OFFLINE_STATUS = status;
  const counts = status.counts || { pending: 0, synced: 0, conflict: 0 };
  document.getElementById('content').innerHTML = `
    <div class="stats-grid">
      <div class="stat-card ${status.online ? 'green' : 'gold'}"><div class="stat-label">Main System</div>
        <div class="stat-value" style="font-size:22px">${status.online ? 'Online' : 'Offline'}</div></div>
      <div class="stat-card gold"><div class="stat-label">Pending Sync</div><div class="stat-value">${counts.pending || 0}</div></div>
      <div class="stat-card green"><div class="stat-label">Synced</div><div class="stat-value">${counts.synced || 0}</div></div>
      <div class="stat-card red"><div class="stat-label">Conflicts</div><div class="stat-value">${counts.conflict || 0}</div></div>
    </div>
    <div class="card">
      <div class="page-header"><div><h3>Offline Invoice Queue</h3>
        <div style="font-size:12px;color:var(--text2)">Client ${esc(status.device_code || '-')} | ${esc(status.server_url || 'Main system')}</div></div>
        <button class="btn btn-primary" onclick="syncOfflineNow()" ${status.role !== 'client' || !status.online ? 'disabled' : ''}>Sync Now</button></div>
      ${status.role !== 'client' ? '<p>This is the Main System. Offline invoices from clients appear in the normal bills list after synchronization.</p>' : ''}
      ${status.last_error ? `<div class="backup-warning warn"><strong>Connection:</strong> ${esc(status.last_error)}</div>` : ''}
      <div class="table-wrap"><table><thead><tr><th>Created</th><th>Invoice</th><th>Date</th><th>Type</th><th>Status</th><th>Details</th><th>Action</th></tr></thead>
        <tbody>${(status.items || []).map(item => `<tr>
          <td>${fmtDate(item.created_at)}</td><td class="mono">${esc(item.number)}</td><td>${fmtDate(item.date)}</td>
          <td>${esc(item.format)}</td>
          <td><span class="badge badge-${item.status === 'synced' ? 'saved' : item.status === 'conflict' ? 'cancelled' : 'draft'}">${esc(item.status)}</span></td>
          <td>${esc(item.error || (item.synced_at ? `Synced ${fmtDate(item.synced_at)}` : 'Waiting for main system'))}</td>
          <td>${item.status === 'conflict' ? `<button class="btn btn-xs btn-outline" onclick="retryOfflineItem('${item.id}')">Retry</button>` : '-'}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="empty-state">No offline invoices on this computer</td></tr>'}</tbody>
      </table></div>
    </div>`;
}

async function syncOfflineNow() {
  try {
    OFFLINE_STATUS = window.taranginiDesktop?.syncOfflineNow
      ? await window.taranginiDesktop.syncOfflineNow()
      : await api('POST', '/offline/sync', {});
    toast(OFFLINE_STATUS.counts?.conflict
      ? 'Synchronization finished with conflicts. Review the queue.'
      : 'Offline synchronization completed', OFFLINE_STATUS.counts?.conflict ? 'warning' : 'success');
    renderOfflineSync(false);
  } catch (error) { toast(error.message, 'error'); }
}

async function retryOfflineItem(id) {
  try {
    if (!window.taranginiDesktop?.retryOfflineItem) return toast('Retry is available in the desktop application', 'error');
    OFFLINE_STATUS = await window.taranginiDesktop.retryOfflineItem(id);
    toast(OFFLINE_STATUS.counts?.conflict ? 'Invoice still has a conflict' : 'Invoice synchronized', OFFLINE_STATUS.counts?.conflict ? 'warning' : 'success');
    renderOfflineSync(false);
  } catch (error) { toast(error.message, 'error'); }
}

async function renderDiagnostics() {
  const data = await api('GET', '/advanced/integrity');
  document.getElementById('content').innerHTML = `
    <div class="card">
      <div class="section-title">Database Integrity and Recovery</div>
      <div class="backup-warning ${data.healthy ? '' : 'warn'}"><strong>${data.healthy ? 'Database check passed' : 'Issues detected'}</strong></div>
      <p>SQLite integrity: <strong>${esc(data.checks.database)}</strong></p>
      <p>Missing bill customers: <strong>${data.checks.orphan_bill_parties}</strong></p>
      <p>Orphan journal lines: <strong>${data.checks.orphan_journal_lines}</strong></p>
      <p>Unbalanced journals: <strong>${data.checks.unbalanced_journals.length}</strong></p>
      <p>Database size: <strong>${data.maintenance.database_size_mb} MB</strong></p>
      <p>Expired sessions eligible for cleanup: <strong>${data.maintenance.expired_sessions}</strong></p>
      <p>Old revoked customer links eligible for cleanup: <strong>${data.maintenance.old_revoked_customer_tokens}</strong></p>
      <p>Server transport: <strong>${esc(data.deployment.transport.toUpperCase())}</strong></p>
      <p>CORS allowlist: <strong>${data.deployment.allowed_origins_configured ? 'Configured' : 'Closed by default'}</strong></p>
      <button class="btn btn-primary" onclick="repairDatabase()">Rebuild Accounting and Stock Indexes</button>
      <button class="btn btn-secondary" onclick="runDatabaseMaintenance()">Run Safe Maintenance</button>
    </div>`;
}

async function repairDatabase() {
  const ok = await showConfirm('Repair Database', 'This rebuilds accounting and stock movements from saved vouchers. Continue?', 'Repair', false);
  if (!ok) return;
  await api('POST', '/advanced/integrity/repair', {});
  toast('Database indexes rebuilt', 'success');
  renderDiagnostics();
}

async function runDatabaseMaintenance() {
  const ok = await showConfirm(
    'Safe Database Maintenance',
    'This removes only expired sessions and old revoked customer links, then optimizes the database. Financial and audit records are preserved. Continue?',
    'Run Maintenance',
    false
  );
  if (!ok) return;
  const result = await api('POST', '/advanced/maintenance', {});
  toast(`Maintenance complete: ${result.removed_sessions} sessions and ${result.removed_customer_tokens} old links removed`, 'success');
  renderDiagnostics();
}

async function renderScheduledReports() {
  const data = await api('GET', `/advanced/report-schedules?org_id=${APP_STATE.currentOrg.id}`);
  document.getElementById('content').innerHTML = `
    <div class="card">
      <div class="section-title">Monthly Report Schedule</div>
      <div class="form-row cols-3">
        <div class="form-group"><label>Recipient Email</label><input type="email" id="schedule-email"></div>
        <div class="form-group"><label>Day of Month</label><input type="number" id="schedule-day" min="1" max="28" value="1"></div>
        <div class="form-group"><label>Output / Sync Folder</label><input id="schedule-directory" placeholder="Optional local or cloud-sync folder"></div>
      </div>
      <button class="btn btn-success" onclick="saveReportSchedule()">Add Schedule</button>
    </div>
    <div class="card">
      <div class="section-title">Email Server (SMTP)</div>
      <div class="form-row cols-3">
        <div class="form-group"><label>SMTP Host</label><input id="smtp-host" value="${esc(data.smtp.host)}"></div>
        <div class="form-group"><label>Port</label><input type="number" id="smtp-port" value="${esc(data.smtp.port)}"></div>
        <div class="form-group"><label>Username</label><input id="smtp-user" value="${esc(data.smtp.user)}"></div>
        <div class="form-group"><label>Password / App Password</label><input type="password" id="smtp-password"></div>
        <div class="form-group"><label>From Address</label><input id="smtp-from" value="${esc(data.smtp.from)}"></div>
        <label><input type="checkbox" id="smtp-secure" ${data.smtp.secure?'checked':''}> Secure TLS connection</label>
      </div>
      <button class="btn btn-primary" onclick="saveSMTPSettings()">Save Email Settings</button>
    </div>
    ${businessRegister('Scheduled Reports',['Email','Day','Folder','Last Run','Status','Action'],
      data.schedules.map(row => [row.recipient_email,row.day_of_month,row.output_directory||'Default',
        fmtDate(row.last_run_at),row.last_status||'Not run',
        `<button class="btn btn-xs btn-primary" onclick="runReportSchedule(${row.id})">Run Now</button>
         <button class="btn btn-xs btn-secondary" onclick="deleteReportSchedule(${row.id})">Delete</button>`]))}`;
}

async function saveReportSchedule() {
  await api('POST', '/advanced/report-schedules', {
    org_id: APP_STATE.currentOrg.id, report_type: 'monthly_summary',
    recipient_email: document.getElementById('schedule-email').value,
    day_of_month: Number(document.getElementById('schedule-day').value),
    output_directory: document.getElementById('schedule-directory').value
  });
  toast('Monthly report scheduled', 'success');
  renderScheduledReports();
}

async function saveSMTPSettings() {
  await api('PUT', '/advanced/report-schedules/smtp', {
    host: document.getElementById('smtp-host').value, port: Number(document.getElementById('smtp-port').value),
    user: document.getElementById('smtp-user').value, password: document.getElementById('smtp-password').value,
    from: document.getElementById('smtp-from').value, secure: document.getElementById('smtp-secure').checked
  });
  toast('Email settings saved', 'success');
}

async function runReportSchedule(id) {
  const result = await api('POST', `/advanced/report-schedules/${id}/run`, {});
  toast(result.emailed ? 'Report emailed' : `Report saved: ${result.file}`, 'success');
  renderScheduledReports();
}

async function deleteReportSchedule(id) {
  await api('DELETE', `/advanced/report-schedules/${id}`);
  renderScheduledReports();
}

async function downloadEncryptedBackup() {
  const password = prompt('Enter a new backup password (minimum 8 characters)');
  if (!password) return;
  const response = await fetch('/api/advanced/encrypted-backup', {
    method: 'POST', headers: { Authorization: `Bearer ${APP_STATE.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  if (!response.ok) return toast((await response.json()).error, 'error');
  const blob = await response.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || 'tarangini-encrypted.tbe';
  link.click();
  URL.revokeObjectURL(link.href);
}

async function restoreEncryptedBackup() {
  const file = document.getElementById('encrypted-backup-file')?.files?.[0];
  if (!file) return toast('Select an encrypted .tbe backup', 'error');
  const password = prompt('Enter the backup password');
  if (!password) return;
  const response = await fetch('/api/advanced/encrypted-backup/restore', {
    method: 'POST', headers: { Authorization: `Bearer ${APP_STATE.token}`, 'Content-Type': 'application/octet-stream',
      'X-Backup-Password': password }, body: await file.arrayBuffer()
  });
  const result = await response.json();
  if (!response.ok) return toast(result.error, 'error');
  toast('Backup restored. Restart Tarangini Billing now.', 'warning');
}

function whatsappInvoice(bill) {
  const party = bill.party || (bill.party_snapshot ? JSON.parse(bill.party_snapshot) : null);
  const phone = String(party?.phone || '').replace(/\D/g, '');
  if (!phone) return toast('Customer phone number is not available', 'error');
  const number = phone.length === 10 ? `91${phone}` : phone;
  const message = encodeURIComponent(`Dear ${party.name || 'Customer'}, invoice ${bill.bill_number} dated ${fmtDate(bill.bill_date)} totals ${fmt(bill.grand_total)}. Thank you.`);
  window.open(`https://wa.me/${number}?text=${message}`, '_blank');
}

async function loadInvoiceQR(billId) {
  const target = document.getElementById('invoice-qr-image');
  if (!target) return;
  const response = await fetch(`/api/advanced/invoice-qr/${billId}`, {
    headers: { Authorization: `Bearer ${APP_STATE.token}` }
  });
  if (response.ok) target.src = URL.createObjectURL(await response.blob());
}

const originalRenderBackupAdvanced = renderBackup;
renderBackup = async function() {
  await originalRenderBackupAdvanced();
  const content = document.getElementById('content');
  const card = document.createElement('div');
  card.className = 'card';
  card.style.marginTop = '16px';
  card.innerHTML = `<div class="section-title">Encrypted Disaster-Recovery Backup</div>
    <p class="text-muted">Password-protected AES-256 database backup. Keep the password separately.</p>
    <button class="btn btn-success" onclick="downloadEncryptedBackup()">Download Encrypted Backup</button>
    <div class="form-row cols-2" style="margin-top:14px"><div class="form-group"><label>Restore .tbe Backup</label>
      <input type="file" id="encrypted-backup-file" accept=".tbe"></div>
      <div class="form-group" style="justify-content:flex-end"><button class="btn btn-secondary" onclick="restoreEncryptedBackup()">Restore and Restart</button></div></div>`;
  content.appendChild(card);
};

const originalSaveItem = saveItem;
saveItem = async function(id) {
  if (!document.getElementById('im-code')) return originalSaveItem(id);
  const name=document.getElementById('im-name').value.trim();
  if (!name) return toast('Item name required','error');
  const payload={org_id:APP_STATE.currentOrg.id,category_id:document.getElementById('im-category').value||null,name,
    hsn_code:document.getElementById('im-hsn').value,unit:document.getElementById('im-unit').value,
    gst_rate:Number(document.getElementById('im-gstrate').value),last_sale_price:Number(document.getElementById('im-saleprice').value||0),
    last_purchase_price:Number(document.getElementById('im-purchaseprice').value||0),description:document.getElementById('im-desc').value,
    item_code:document.getElementById('im-code').value,model_number:document.getElementById('im-model').value,
    barcode:document.getElementById('im-barcode').value,mrp:Number(document.getElementById('im-mrp').value||0),
    opening_stock:Number(document.getElementById('im-opening').value||0),reorder_level:Number(document.getElementById('im-reorder').value||0)};
  try {
    await api(id?'PUT':'POST',id?`/items/${id}`:'/items',payload);
    document.getElementById('item-modal')?.remove(); toast(id?'Item updated':'Item added with automatic barcode','success');
    await loadMasterData(); renderItems();
  } catch (error) { toast(error.message,'error'); }
};

function numberToWords(n) {
  if (!n || n === 0) return 'Zero Rupees Only';
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve',
    'Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function convert(num) {
    if (num < 20) return ones[num];
    if (num < 100) return tens[Math.floor(num/10)] + (num%10 ? ' '+ones[num%10] : '');
    if (num < 1000) return ones[Math.floor(num/100)]+' Hundred'+(num%100?' '+convert(num%100):'');
    if (num < 100000) return convert(Math.floor(num/1000))+' Thousand'+(num%1000?' '+convert(num%1000):'');
    if (num < 10000000) return convert(Math.floor(num/100000))+' Lakh'+(num%100000?' '+convert(num%100000):'');
    return convert(Math.floor(num/10000000))+' Crore'+(num%10000000?' '+convert(num%10000000):'');
  }
  const rupees = Math.floor(n);
  const paise = Math.round((n - rupees) * 100);
  let words = convert(rupees) + ' Rupees';
  if (paise > 0) words += ' and ' + convert(paise) + ' Paise';
  return words + ' Only';
}

// ── BOOT ───────────────────────────────────────────────
if (APP_STATE.token && APP_STATE.user) {
  api('GET', '/auth/me')
    .then(u => { APP_STATE.user = u; localStorage.setItem('user', JSON.stringify(u)); initApp(); })
    .catch(() => {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      APP_STATE.token = null;
      APP_STATE.user = null;
      document.getElementById('login-screen').style.display = 'flex';
      document.getElementById('app').style.display = 'none';
    });
} else {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}
async function deriveBill(billId, targetFormat) {
  const title = targetFormat === 'DC' ? 'Create Delivery Challan' : 'Create Invoice';
  const raw = window.prompt(`${title}\nEnter source line and quantity pairs, or leave blank for all remaining quantities. Example: 0=2,1=1`, '');
  if (raw === null) return;
  const items = [];
  if (raw.trim()) {
    raw.split(',').forEach(pair => {
      const [source_line_key, qty] = pair.split('=').map(value => value.trim());
      if (source_line_key !== '' && Number(qty) > 0) items.push({ source_line_key, qty: Number(qty) });
    });
    if (!items.length) return toast('Use the format 0=2,1=1 or leave the field blank', 'error');
  }
  try {
    const result = await api('POST', `/bills/${billId}/derive`, {
      target_format: targetFormat,
      ...(items.length ? { items } : {})
    });
    toast(`${targetFormat === 'DC' ? 'Delivery Challan' : 'Invoice'} created: ${result.bill.bill_number}`, 'success');
    closePreview();
    showBillPreview(result.bill);
    if (typeof renderBillsList === 'function') renderBillsList();
  } catch (error) { toast(error.message, 'error'); }
}
