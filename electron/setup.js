const roleInputs = [...document.querySelectorAll('input[name="role"]')];
const serverFields = document.getElementById('server-fields');
const hostFields = document.getElementById('host-fields');
const hostKeepAlive = document.getElementById('host-keepalive');
const hostStartLogin = document.getElementById('host-start-login');
const hostDataDir = document.getElementById('host-data-dir');
const hostAttachmentDir = document.getElementById('host-attachment-dir');
const hostBackupDir = document.getElementById('host-backup-dir');
const serviceStatus = document.getElementById('service-status');
const serverUrl = document.getElementById('server-url');
const clientPortalLan = document.getElementById('client-portal-lan');
const firewallStatus = document.getElementById('firewall-status');
const deviceCode = document.getElementById('device-code');
const deviceSystemName = document.getElementById('device-system-name');
const deviceMacs = document.getElementById('device-macs');
const error = document.getElementById('error');
const save = document.getElementById('save');
const savedConfig = document.getElementById('saved-config');
const findMain = document.getElementById('find-main');
const testMain = document.getElementById('test-main');
const discoveryResults = document.getElementById('discovery-results');

function selectedRole() {
  return roleInputs.find(input => input.checked).value;
}

function updateFields() {
  serverFields.style.display = selectedRole() === 'client' ? 'block' : 'none';
  hostFields.style.display = selectedRole() === 'host' ? 'block' : 'none';
  if (selectedRole() === 'host') refreshServiceStatus();
}

roleInputs.forEach(input => input.addEventListener('change', updateFields));

function setStatus(message, isError = false) {
  error.textContent = isError ? message : '';
  savedConfig.textContent = isError ? savedConfig.textContent : message;
}

function renderDiscoveredHosts(hosts) {
  discoveryResults.innerHTML = '';
  if (!hosts.length) {
    discoveryResults.innerHTML = '<div class="discovery-result"><strong>No main system found</strong><small>Check that the Main System is open in Host mode and firewall allows port 3000.</small></div>';
    return;
  }
  discoveryResults.innerHTML = hosts.map(host => `
    <div class="discovery-result" data-url="${host.url}">
      <strong>${host.url}</strong>
      <small>Tarangini ${host.version || ''} | Click to use this Main System</small>
    </div>`).join('');
  discoveryResults.querySelectorAll('.discovery-result[data-url]').forEach(row => {
    row.addEventListener('click', () => {
      serverUrl.value = row.dataset.url;
      setStatus(`Selected ${row.dataset.url}`);
    });
  });
}

findMain?.addEventListener('click', async () => {
  error.textContent = '';
  discoveryResults.innerHTML = '<div class="discovery-result"><strong>Searching...</strong><small>Scanning this LAN for Tarangini Main System on port 3000.</small></div>';
  findMain.disabled = true;
  try {
    renderDiscoveredHosts(await window.taranginiDesktop.discoverHosts());
  } catch (err) {
    error.textContent = err.message;
  } finally {
    findMain.disabled = false;
  }
});

testMain?.addEventListener('click', async () => {
  error.textContent = '';
  if (!serverUrl.value.trim()) {
    error.textContent = 'Enter or find the Main System IP address first.';
    return;
  }
  testMain.disabled = true;
  try {
    const result = await window.taranginiDesktop.testServerUrl(serverUrl.value);
    serverUrl.value = result.url;
    setStatus(`Connection OK: ${result.url} Tarangini ${result.version || ''}`);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    testMain.disabled = false;
  }
});

async function refreshServiceStatus() {
  if (!serviceStatus || !window.taranginiDesktop.getWindowsServiceStatus) return;
  try {
    const status = await window.taranginiDesktop.getWindowsServiceStatus();
    if (!status.supported) {
      serviceStatus.textContent = 'Windows Service mode is available only on Windows.';
      return;
    }
    serviceStatus.textContent = status.installed
      ? `Installed: ${status.status || 'unknown'} (${status.service_name})`
      : `Not installed (${status.service_name})`;
  } catch (err) {
    serviceStatus.textContent = `Could not read service status: ${err.message}`;
  }
}

async function refreshFirewallStatus() {
  if (!firewallStatus || !window.taranginiDesktop.getWindowsFirewallStatus) return;
  try {
    const status = await window.taranginiDesktop.getWindowsFirewallStatus();
    firewallStatus.textContent = status.enabled
      ? `Firewall enabled: Private network, TCP ${status.port || 3001}, local subnet only.`
      : `Firewall rule: ${status.status || 'not configured'}. It will be enabled when this option is saved.`;
  } catch (err) {
    firewallStatus.textContent = `Could not read firewall status: ${err.message}`;
  }
}

document.querySelectorAll('[data-service-action]').forEach(button => {
  button.addEventListener('click', async () => {
    const action = button.dataset.serviceAction;
    error.textContent = '';
    button.disabled = true;
    try {
      await window.taranginiDesktop.windowsServiceAction(action);
      setStatus(`Windows Service ${action} completed.`);
      await refreshServiceStatus();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
});

window.taranginiDesktop.getConfig().then(config => {
  if (!config) {
    savedConfig.textContent = 'No previous system selection is saved.';
    return;
  }
  const input = roleInputs.find(item => item.value === config.role);
  if (input) input.checked = true;
  serverUrl.value = config.serverUrl || '';
  if (hostKeepAlive) hostKeepAlive.checked = config.keepAliveOnClose !== false;
  if (hostStartLogin) hostStartLogin.checked = Boolean(config.startAtLogin);
  if (hostDataDir) hostDataDir.value = config.hostDataDir || '';
  if (hostAttachmentDir) hostAttachmentDir.value = config.hostAttachmentDir || '';
  if (hostBackupDir) hostBackupDir.value = config.hostBackupDir || '';
  if (clientPortalLan) clientPortalLan.checked = Boolean(config.clientPortalLanEnabled);
  if (config.deviceCode && deviceCode) deviceCode.textContent = `Assigned code: ${config.deviceCode}`;
  savedConfig.textContent = config.role === 'host'
    ? 'Previous selection: MAIN SYSTEM'
    : `Previous selection: CLIENT SYSTEM (${config.serverUrl || 'IP not saved'})`;
  updateFields();
});

window.taranginiDesktop.getDeviceIdentity?.().then(identity => {
  if (!identity) return;
  deviceSystemName.textContent = identity.displayName || identity.systemName || 'This computer';
  deviceCode.textContent = `Assigned code: ${identity.deviceCode} | Device ID: ${identity.deviceId}`;
  deviceMacs.textContent = identity.macReferences?.length
    ? `MAC reference: ${identity.macReferences.join(', ')}`
    : 'MAC reference unavailable; a protected local installation ID will be used.';
}).catch(err => {
  deviceSystemName.textContent = 'Could not read this computer identity';
  deviceCode.textContent = err.message;
});

save.addEventListener('click', async () => {
  error.textContent = '';
  const role = selectedRole();
  if (role === 'client' && !serverUrl.value.trim()) {
    error.textContent = 'Enter the IP address of the main computer.';
    return;
  }
  save.disabled = true;
  try {
    if (role === 'client') {
      const result = await window.taranginiDesktop.testServerUrl(serverUrl.value);
      serverUrl.value = result.url;
    }
    await window.taranginiDesktop.saveConfig({
      role,
      serverUrl: serverUrl.value,
      keepAliveOnClose: hostKeepAlive?.checked !== false,
      startAtLogin: Boolean(hostStartLogin?.checked),
      hostDataDir: hostDataDir?.value || '',
      hostAttachmentDir: hostAttachmentDir?.value || '',
      hostBackupDir: hostBackupDir?.value || '',
      clientPortalLanEnabled: Boolean(clientPortalLan?.checked)
    });
  } catch (err) {
    error.textContent = err.message;
    save.disabled = false;
  }
});

updateFields();
refreshServiceStatus();
refreshFirewallStatus();
