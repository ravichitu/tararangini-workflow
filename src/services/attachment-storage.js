const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getAppDataDir } = require('../db/db');
const { ATTACHMENT_STORAGE_MODE } = require('../config/deployment-profile');

function attachmentRoot() {
  const configured = String(process.env.TARANGINI_ATTACHMENT_DIR || '').trim();
  return configured ? path.resolve(configured) : path.join(getAppDataDir(), 'attachments');
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function safeExtension(fileName) {
  return path.extname(String(fileName || '')).replace(/[^a-z0-9.]/gi, '').toLowerCase().slice(0, 12);
}

function relativeStoragePath(scope, sha256, fileName) {
  const extension = safeExtension(fileName);
  const hash = String(sha256 || crypto.randomBytes(16).toString('hex')).toLowerCase();
  return path.join(scope, hash.slice(0, 2), `${hash}${extension}`);
}

function absoluteStoragePath(storagePath) {
  const root = attachmentRoot();
  const target = path.resolve(root, String(storagePath || ''));
  if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) {
    throw new Error('Attachment path is outside the permitted storage root');
  }
  return target;
}

function persistAttachmentBytes({ scope, fileName, sha256, bytes }) {
  if (ATTACHMENT_STORAGE_MODE === 'inline-db') {
    return {
      storage_path: null,
      content_base64: Buffer.from(bytes).toString('base64')
    };
  }
  const storagePath = relativeStoragePath(scope, sha256, fileName);
  const absolute = absoluteStoragePath(storagePath);
  ensureDir(path.dirname(absolute));
  fs.writeFileSync(absolute, bytes);
  return {
    storage_path: storagePath.replace(/\\/g, '/'),
    content_base64: null
  };
}

function loadAttachmentBytes(record) {
  if (record?.content_base64) {
    return Buffer.from(String(record.content_base64).replace(/\s/g, ''), 'base64');
  }
  if (record?.storage_path) {
    return fs.readFileSync(absoluteStoragePath(record.storage_path));
  }
  throw new Error('Attachment content is unavailable');
}

function exportAttachmentRecord(record) {
  if (!record) return record;
  return {
    ...record,
    storage_path: null,
    content_base64: null,
    backup_content_included: false
  };
}

function hasAttachmentBytes(record) {
  if (record?.content_base64) return true;
  if (!record?.storage_path) return false;
  try {
    return fs.existsSync(absoluteStoragePath(record.storage_path));
  } catch (_) {
    return false;
  }
}

function deleteStoredAttachmentBytes(record) {
  if (record?.storage_path) {
    const absolute = absoluteStoragePath(record.storage_path);
    try {
      if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return {
    storage_path: null,
    content_base64: null
  };
}

function importAttachmentRecord({ scope, file_name, sha256, content_base64 }) {
  if (!content_base64) {
    return {
      storage_path: null,
      content_base64: null
    };
  }
  const bytes = Buffer.from(String(content_base64 || '').replace(/\s/g, ''), 'base64');
  return persistAttachmentBytes({
    scope,
    fileName: file_name,
    sha256,
    bytes
  });
}

module.exports = {
  attachmentRoot,
  persistAttachmentBytes,
  loadAttachmentBytes,
  hasAttachmentBytes,
  deleteStoredAttachmentBytes,
  exportAttachmentRecord,
  importAttachmentRecord
};
