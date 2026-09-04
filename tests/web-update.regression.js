const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UpdateService } = require('../electron/update-service');

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.quitAndInstallCalls = 0;
  }

  async checkForUpdates() {
    this.emit('checking-for-update');
    this.emit('update-available', { version: '1.2.1', releaseNotes: 'Verified release' });
  }

  async downloadUpdate() {
    this.emit('download-progress', { percent: 48.5 });
    this.emit('update-downloaded', { version: '1.2.1', releaseNotes: 'Verified release' });
  }

  quitAndInstall() {
    this.quitAndInstallCalls += 1;
  }
}

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarangini-web-update-'));
  const updater = new FakeUpdater();
  let safeToInstall = false;
  const service = new UpdateService({
    app: {
      isPackaged: true,
      getVersion: () => '1.2.0',
      getPath: () => tempDir
    },
    autoUpdater: updater,
    canInstall: () => safeToInstall
      ? { safe: true }
      : { safe: false, reason: 'Pending offline work must sync first.' },
    setInitialCheckTimer: () => ({ unref() {} }),
    setTimer: () => ({})
  });

  const initial = service.start();
  assert.strictEqual(initial.enabled, true);
  assert.strictEqual(updater.autoDownload, false, 'Downloads must require an explicit owner/client action.');
  assert.strictEqual(updater.autoInstallOnAppQuit, false, 'Updates must never install silently on quit.');
  await service.checkNow();
  assert.strictEqual(service.snapshot().state, 'available');
  assert.strictEqual(service.snapshot().availableVersion, '1.2.1');

  await service.download();
  assert.strictEqual(service.snapshot().state, 'downloaded');
  await assert.rejects(service.install(), /Pending offline work must sync first/);
  assert.strictEqual(updater.quitAndInstallCalls, 0);

  safeToInstall = true;
  await service.install();
  assert.strictEqual(updater.quitAndInstallCalls, 1);
  assert.strictEqual(service.snapshot().state, 'installing');

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.strictEqual(pkg.build.publish[0].provider, 'github');
  assert.strictEqual(pkg.build.publish[0].repo, 'tarangini-suite-updates');
  assert.strictEqual(pkg.build.electronUpdaterCompatibility, '>= 2.16');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8'), /new UpdateService/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8'), /checkAppUpdates/);
  console.log('Web update regression test passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
