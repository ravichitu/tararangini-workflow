const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taranginiDesktop', {
  getConfig: () => ipcRenderer.invoke('get-network-config'),
  getDeviceIdentity: () => ipcRenderer.invoke('get-device-identity'),
  discoverHosts: () => ipcRenderer.invoke('discover-main-systems'),
  testServerUrl: serverUrl => ipcRenderer.invoke('test-server-url', serverUrl),
  saveConfig: config => ipcRenderer.invoke('save-network-config', config),
  openNetworkSetup: () => ipcRenderer.invoke('open-network-setup'),
  getOfflineStatus: () => ipcRenderer.invoke('get-offline-status'),
  retryConnection: () => ipcRenderer.invoke('retry-client-connection'),
  syncOfflineNow: () => ipcRenderer.invoke('sync-offline-now'),
  retryOfflineItem: id => ipcRenderer.invoke('retry-offline-item', id),
  getAppUpdateStatus: () => ipcRenderer.invoke('get-app-update-status'),
  checkAppUpdates: () => ipcRenderer.invoke('check-app-updates'),
  downloadAppUpdate: () => ipcRenderer.invoke('download-app-update'),
  installAppUpdate: () => ipcRenderer.invoke('install-app-update'),
  getWindowsServiceStatus: () => ipcRenderer.invoke('windows-service-status'),
  windowsServiceAction: action => ipcRenderer.invoke('windows-service-action', action),
  getWindowsFirewallStatus: () => ipcRenderer.invoke('windows-firewall-status'),
  saveInvoicePDF: suggestedName => ipcRenderer.invoke('save-invoice-pdf', suggestedName)
});
