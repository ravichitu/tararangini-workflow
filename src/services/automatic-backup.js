const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { get, run, getDBPath, getAppDataDir, saveDB } = require('../db/db');
const { encryptAutomaticBackup, decryptAutomaticBackup } = require('../security/backup-crypto');

let timer = null;

function setting(key, fallback) {
  return get('SELECT value FROM system_settings WHERE key=?', [key])?.value ?? fallback;
}

function backupDirectory() {
  const configured = String(setting('automatic_backup_directory', '') || '').trim();
  const defaultBackupDir = String(process.env.TARANGINI_DEFAULT_BACKUP_DIR || '').trim();
  return configured || defaultBackupDir || path.join(getAppDataDir(), 'backups');
}

function backupRetentionCount() {
  return Math.max(1, Math.min(365, Number(setting('automatic_backup_retention_count', '30')) || 30));
}

function backupStorageHealth() {
  const directory = backupDirectory();
  const minimumFreeMb = Math.max(128, Math.min(1048576, Number(setting('automatic_backup_min_free_mb', '2048')) || 2048));
  try {
    fs.mkdirSync(directory, { recursive: true });
    if (typeof fs.statfsSync !== 'function') {
      return { status: 'unknown', healthy: true, directory, minimum_free_mb: minimumFreeMb,
        message: 'Free-space inspection is not available in this Node runtime.' };
    }
    const stat = fs.statfsSync(directory);
    const freeBytes = Number(stat.bavail ?? stat.bfree) * Number(stat.bsize);
    const freeMb = Math.floor(freeBytes / 1048576);
    const dbRoot = path.parse(path.resolve(getDBPath())).root.toLowerCase();
    const backupRoot = path.parse(path.resolve(directory)).root.toLowerCase();
    return {
      status: freeMb >= minimumFreeMb ? 'healthy' : 'critical',
      healthy: freeMb >= minimumFreeMb,
      directory,
      free_bytes: freeBytes,
      free_mb: freeMb,
      minimum_free_mb: minimumFreeMb,
      same_volume_as_live_database: backupRoot === dbRoot,
      message: freeMb >= minimumFreeMb
        ? 'Backup storage has enough free space.'
        : `Only ${freeMb} MB free; automatic backups require at least ${minimumFreeMb} MB.`
    };
  } catch (error) {
    return { status: 'unknown', healthy: false, directory, minimum_free_mb: minimumFreeMb, error: error.message };
  }
}

function pruneAutomaticBackups() {
  const directory = path.resolve(backupDirectory());
  const retentionCount = backupRetentionCount();
  try {
    const files = fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^tarangini-auto-.*\.tbe$/i.test(entry.name))
      .map(entry => {
        const file = path.join(directory, entry.name);
        return { file, name: entry.name, modified_at: fs.statSync(file).mtimeMs };
      })
      .sort((left, right) => right.modified_at - left.modified_at);
    const pruned = [];
    const errors = [];
    files.slice(retentionCount).forEach(entry => {
      try {
        fs.rmSync(entry.file, { force: true });
        pruned.push(entry.name);
      } catch (error) {
        errors.push({ file: entry.name, error: error.message });
      }
    });
    return { retention_count: retentionCount, retained: Math.min(files.length, retentionCount), pruned, errors };
  } catch (error) {
    return { retention_count: retentionCount, retained: 0, pruned: [], errors: [{ error: error.message }] };
  }
}

function automaticBackupKeyPath() {
  return path.join(getAppDataDir(), '.automatic-backup-key');
}

function automaticBackupKey() {
  const file = automaticBackupKeyPath();
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    const key = Buffer.from(saved, 'base64url');
    if (key.length === 32) return key;
  } catch (_) {}
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, key.toString('base64url'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const saved = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64url');
    if (saved.length !== 32) throw new Error('Stored automatic backup key is invalid');
    return saved;
  }
  return key;
}

function automaticBackupRecoveryKey() {
  return automaticBackupKey().toString('base64url');
}

const REQUIRED_TABLES = [
  'orgs', 'parties', 'items', 'bills', 'payments', 'purchases', 'stock_movements',
  'journal_entries', 'journal_lines', 'job_orders', 'job_items', 'audit_log'
];

function verifyAutomaticBackup(fileName, backupLogId = null, verifiedBy = null) {
  const target = path.resolve(String(fileName || ''));
  const allowedDirectory = `${path.resolve(backupDirectory())}${path.sep}`;
  if (!target.startsWith(allowedDirectory) || path.extname(target).toLowerCase() !== '.tbe') {
    throw new Error('Backup verification is restricted to automatic .tbe files in the configured backup directory');
  }
  const verificationDirectory = path.join(getAppDataDir(), 'backup-verification-temp');
  fs.mkdirSync(verificationDirectory, { recursive: true });
  const temporary = path.join(verificationDirectory, `verify-${crypto.randomUUID()}.db`);
  let database = null;
  try {
    const encrypted = fs.readFileSync(target);
    const decrypted = decryptAutomaticBackup(encrypted, automaticBackupKey());
    if (decrypted.subarray(0, 16).toString() !== 'SQLite format 3\u0000') {
      throw new Error('Decrypted backup is not a SQLite database');
    }
    fs.writeFileSync(temporary, decrypted, { mode: 0o600 });
    database = new DatabaseSync(temporary, { readOnly: true });
    const integrityRows = database.prepare('PRAGMA integrity_check').all();
    const integrity = String(Object.values(integrityRows[0] || {})[0] || 'unknown');
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(row => row.name);
    const missingTables = REQUIRED_TABLES.filter(table => !tables.includes(table));
    const summary = {
      organizations: Number(database.prepare('SELECT COUNT(*) count FROM orgs').get()?.count || 0),
      parties: Number(database.prepare('SELECT COUNT(*) count FROM parties').get()?.count || 0),
      bills: Number(database.prepare('SELECT COUNT(*) count FROM bills').get()?.count || 0),
      jobs: Number(database.prepare('SELECT COUNT(*) count FROM job_orders').get()?.count || 0),
      missing_required_tables: missingTables
    };
    if (integrity.toLowerCase() !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}`);
    if (missingTables.length) throw new Error(`Backup is missing required tables: ${missingTables.join(', ')}`);
    const result = run(`INSERT INTO backup_verification_log
      (backup_log_id,backup_file,status,integrity_result,schema_table_count,database_size_bytes,summary_json,verified_by)
      VALUES (?,?, 'PASSED',?,?,?,?,?)`,
    [backupLogId, target, integrity, tables.length, decrypted.length, JSON.stringify(summary), verifiedBy]);
    return { success: true, verification_id: result.lastInsertRowid, status: 'PASSED', integrity, tables: tables.length, summary };
  } catch (error) {
    const result = run(`INSERT INTO backup_verification_log
      (backup_log_id,backup_file,status,error,verified_by) VALUES (?,?, 'FAILED',?,?)`,
    [backupLogId, target, error.message, verifiedBy]);
    return { success: false, verification_id: result.lastInsertRowid, status: 'FAILED', error: error.message };
  } finally {
    try { database?.close(); } catch (_) {}
    for (const file of [temporary, `${temporary}-wal`, `${temporary}-shm`]) {
      try { fs.rmSync(file, { force: true }); } catch (_) {}
    }
  }
}

function createAutomaticBackup(createdBy = null) {
  const directory = backupDirectory();
  try {
    fs.mkdirSync(directory, { recursive: true });
    const storageHealth = backupStorageHealth();
    if (!storageHealth.healthy) {
      return { success: false, storage_health: storageHealth, error: storageHealth.error || storageHealth.message };
    }
    saveDB();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `tarangini-auto-${stamp}.tbe`;
    const destination = path.join(directory, fileName);
    const encrypted = encryptAutomaticBackup(fs.readFileSync(getDBPath()), automaticBackupKey());
    fs.writeFileSync(destination, encrypted, { mode: 0o600 });
    const logged = run('INSERT INTO backup_log (org_id,fy,file_name,created_by) VALUES (NULL,?,?,?)',
      ['automatic', destination, createdBy]);
    const verification = verifyAutomaticBackup(destination, logged.lastInsertRowid, createdBy);
    if (!verification.success) {
      return {
        success: false,
        backup_created: true,
        file_name: destination,
        backup_log_id: logged.lastInsertRowid,
        verification,
        error: `Backup was created but restore verification failed: ${verification.error}`
      };
    }
    const retention = pruneAutomaticBackups();
    return {
      success: true, file_name: destination, backup_log_id: logged.lastInsertRowid, verification,
      storage_health: storageHealth, retention
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function startAutomaticBackups() {
  clearInterval(timer);
  const check = () => {
    if (setting('automatic_backup_enabled', '1') === '0') return;
    const hours = Math.max(1, Number(setting('automatic_backup_hours', '24')));
    const last = get(`SELECT bl.backup_date FROM backup_log bl
      JOIN backup_verification_log bv ON bv.backup_log_id=bl.id AND bv.status='PASSED'
      WHERE bl.fy='automatic' ORDER BY bl.backup_date DESC LIMIT 1`);
    const due = !last || Date.now() - new Date(`${last.backup_date}Z`).getTime() >= hours * 3600000;
    if (due) createAutomaticBackup();
  };
  check();
  timer = setInterval(check, 60 * 60 * 1000);
}

module.exports = {
  startAutomaticBackups,
  createAutomaticBackup,
  backupDirectory,
  backupRetentionCount,
  backupStorageHealth,
  pruneAutomaticBackups,
  automaticBackupRecoveryKey,
  verifyAutomaticBackup
};
