const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function messageFor(error) {
  return String(error?.message || error || 'Unknown update error')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

function updateInfo(info = {}) {
  return {
    version: String(info.version || ''),
    releaseDate: info.releaseDate || null,
    releaseName: String(info.releaseName || ''),
    releaseNotes: Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map(note => String(note?.note || note || '')).join('\n')
      : String(info.releaseNotes || '')
  };
}

class UpdateService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.app = options.app;
    this.autoUpdater = options.autoUpdater;
    this.dialog = options.dialog;
    this.canInstall = options.canInstall || (() => ({ safe: true }));
    this.checkIntervalMs = options.checkIntervalMs || DEFAULT_CHECK_INTERVAL_MS;
    this.setTimer = options.setTimer || setInterval;
    this.clearTimer = options.clearTimer || clearInterval;
    this.setInitialCheckTimer = options.setInitialCheckTimer || setTimeout;
    this.timer = null;
    this.started = false;
    this.eventsBound = false;
    this.state = {
      enabled: false,
      state: 'not-started',
      currentVersion: String(this.app?.getVersion?.() || ''),
      availableVersion: '',
      downloadedVersion: '',
      releaseDate: null,
      releaseNotes: '',
      percent: 0,
      lastCheckedAt: null,
      lastError: '',
      reason: ''
    };
  }

  snapshot() {
    return { ...this.state };
  }

  setState(change) {
    this.state = { ...this.state, ...change };
    this.emit('status', this.snapshot());
    return this.snapshot();
  }

  writeLog(message) {
    try {
      const logDir = path.join(this.app.getPath('userData'), 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, 'application-updates.log'),
        `${new Date().toISOString()} ${message}\n`
      );
    } catch (_) {
      // Update logging must never stop the billing application.
    }
  }

  start() {
    if (this.started) return this.snapshot();
    this.started = true;
    if (!this.app?.isPackaged) {
      return this.setState({ state: 'disabled', reason: 'Updates are available only in installed releases.' });
    }
    if (process.env.TARANGINI_DISABLE_AUTO_UPDATE === '1') {
      return this.setState({ state: 'disabled', reason: 'Updates are disabled by local policy.' });
    }
    if (!this.autoUpdater) {
      return this.setState({ state: 'disabled', reason: 'Update component is unavailable.' });
    }

    this.autoUpdater.autoDownload = false;
    this.autoUpdater.autoInstallOnAppQuit = false;
    this.autoUpdater.allowPrerelease = false;
    this.autoUpdater.allowDowngrade = false;
    this.bindEvents();
    this.setState({ enabled: true, state: 'idle', reason: '' });
    const initialTimer = this.setInitialCheckTimer(() => this.checkNow().catch(() => {}), 4000);
    initialTimer?.unref?.();
    this.timer = this.setTimer(() => this.checkNow().catch(() => {}), this.checkIntervalMs);
    return this.snapshot();
  }

  stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  bindEvents() {
    if (this.eventsBound) return;
    this.eventsBound = true;
    this.autoUpdater.on('checking-for-update', () => {
      this.setState({ state: 'checking', lastError: '' });
    });
    this.autoUpdater.on('update-available', info => {
      const release = updateInfo(info);
      this.writeLog(`Update ${release.version} is available.`);
      this.setState({
        state: 'available',
        availableVersion: release.version,
        releaseDate: release.releaseDate,
        releaseNotes: release.releaseNotes,
        percent: 0,
        lastError: ''
      });
    });
    this.autoUpdater.on('update-not-available', () => {
      this.setState({ state: 'up-to-date', availableVersion: '', downloadedVersion: '', percent: 0, lastError: '' });
    });
    this.autoUpdater.on('download-progress', progress => {
      this.setState({ state: 'downloading', percent: Number(progress?.percent || 0) });
    });
    this.autoUpdater.on('update-downloaded', info => {
      const release = updateInfo(info);
      this.writeLog(`Update ${release.version} was verified and downloaded.`);
      this.setState({
        state: 'downloaded',
        availableVersion: release.version,
        downloadedVersion: release.version,
        releaseDate: release.releaseDate,
        releaseNotes: release.releaseNotes,
        percent: 100,
        lastError: ''
      });
    });
    this.autoUpdater.on('error', error => {
      const message = messageFor(error);
      this.writeLog(`Update error: ${message}`);
      this.setState({ state: 'error', lastError: message });
    });
  }

  async checkNow() {
    if (!this.state.enabled) return this.snapshot();
    this.setState({ state: 'checking', lastCheckedAt: new Date().toISOString(), lastError: '' });
    try {
      await this.autoUpdater.checkForUpdates();
      return this.snapshot();
    } catch (error) {
      const message = messageFor(error);
      this.writeLog(`Update check failed: ${message}`);
      this.setState({ state: 'error', lastError: message });
      throw new Error(message);
    }
  }

  async download() {
    if (!this.state.enabled) throw new Error(this.state.reason || 'Web updates are not enabled.');
    if (this.state.state !== 'available') {
      throw new Error('Check for an available update before downloading it.');
    }
    try {
      this.setState({ state: 'downloading', percent: 0, lastError: '' });
      await this.autoUpdater.downloadUpdate();
      return this.snapshot();
    } catch (error) {
      const message = messageFor(error);
      this.writeLog(`Update download failed: ${message}`);
      this.setState({ state: 'error', lastError: message });
      throw new Error(message);
    }
  }

  async install() {
    if (this.state.state !== 'downloaded') {
      throw new Error('Download and verify the update before installation.');
    }
    const safety = await Promise.resolve(this.canInstall());
    if (safety?.safe === false) {
      throw new Error(safety.reason || 'Sync outstanding work before installing this update.');
    }
    this.writeLog(`Installing verified update ${this.state.downloadedVersion}.`);
    this.setState({ state: 'installing', lastError: '' });
    this.autoUpdater.quitAndInstall(false, true);
    return this.snapshot();
  }
}

module.exports = { UpdateService, DEFAULT_CHECK_INTERVAL_MS, updateInfo };
