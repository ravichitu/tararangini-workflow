const assert = require('assert');
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
const installer = path.join(dist, `Tarangini Workflow Suite Setup ${packageJson.version}.exe`);
const metadata = path.join(dist, 'latest.yml');
const archive = path.join(dist, 'win-unpacked', 'resources', 'app.asar');

assert.ok(fs.existsSync(installer), `Missing installer: ${installer}`);
assert.ok(fs.existsSync(metadata), `Missing updater metadata: ${metadata}`);
assert.ok(fs.existsSync(archive), `Missing packaged application archive: ${archive}`);

const latest = fs.readFileSync(metadata, 'utf8');
assert.match(latest, new RegExp(`version: ${packageJson.version.replaceAll('.', '\\.')}`));
assert.match(latest, /sha512: /);
const files = asar.listPackage(archive).map(file => file.replaceAll('\\', '/'));
for (const expected of ['/electron/update-service.js', '/electron/main.js', '/electron/preload.js']) {
  assert.ok(files.includes(expected), `Packaged updater is missing ${expected}`);
}
const feed = fs.readFileSync(path.join(dist, 'win-unpacked', 'resources', 'app-update.yml'), 'utf8');
assert.match(feed, /provider: github/);
assert.match(feed, /repo: tarangini-suite-updates/);
console.log('Packaged web-update payload verification passed');
