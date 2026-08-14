const crypto = require('crypto');

const AUTOMATIC_MAGIC = Buffer.from('TARANGINIAUTO1');

function encryptAutomaticBackup(buffer, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Automatic backup key is invalid');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([AUTOMATIC_MAGIC, iv, cipher.getAuthTag(), encrypted]);
}

function decryptAutomaticBackup(buffer, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Automatic backup key is invalid');
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, AUTOMATIC_MAGIC.length).equals(AUTOMATIC_MAGIC)) {
    throw new Error('Invalid automatic encrypted backup');
  }
  const ivStart = AUTOMATIC_MAGIC.length;
  const tagStart = ivStart + 12;
  const dataStart = tagStart + 16;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(ivStart, tagStart));
  decipher.setAuthTag(buffer.subarray(tagStart, dataStart));
  return Buffer.concat([decipher.update(buffer.subarray(dataStart)), decipher.final()]);
}

module.exports = { encryptAutomaticBackup, decryptAutomaticBackup };
