const assert = require('assert');
const {
  analyzeAttachment,
  validateAttachmentInput,
  imagePayloadMatchesMime,
  imageDimensions
} = require('../src/services/attachment-analysis');

const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
const JXL = Buffer.from('ff0a0000', 'hex');

(async () => {
  assert.strictEqual(imagePayloadMatchesMime(PNG, 'image/png'), true);
  assert.strictEqual(imagePayloadMatchesMime(JXL, 'image/jpeg'), false);
  assert.deepStrictEqual(imageDimensions(PNG, 'image/png'), { width: 1, height: 1, type: 'png' });
  assert.doesNotThrow(() => validateAttachmentInput({
    bytes: PNG,
    mimeType: 'image/png',
    uploadOrigin: 'CUSTOMER_PORTAL'
  }));
  assert.throws(() => validateAttachmentInput({
    bytes: JXL,
    mimeType: 'image/jxl',
    uploadOrigin: 'STAFF'
  }), /Unsupported attachment type/);
  assert.throws(() => validateAttachmentInput({
    bytes: JXL,
    mimeType: 'image/jpeg',
    uploadOrigin: 'STAFF'
  }), /does not match/);

  const result = await analyzeAttachment({
    fileName: 'unsafe.jxl',
    mimeType: 'image/jxl',
    bytes: JXL
  });
  assert.strictEqual(result.analysisStatus, 'FAILED');
  assert.match(result.analysisError, /not supported/);
  console.log('Attachment safety regression test passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
