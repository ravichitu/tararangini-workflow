const OFFLINE_DRAFT_FORMATS = new Set(['QUOT', 'DC', 'PI']);

function isOfflineDraftFormat(format) {
  return OFFLINE_DRAFT_FORMATS.has(String(format || '').trim().toUpperCase());
}

function offlineDraftError(format) {
  const normalized = String(format || '').trim().toUpperCase() || 'UNKNOWN';
  const error = new Error(
    `${normalized} cannot be finalized while the Main System is offline. Save a quotation, delivery challan, or proforma draft and sync it later.`
  );
  error.code = 'OFFLINE_FINANCIAL_REVIEW_REQUIRED';
  error.status = 409;
  return error;
}

module.exports = { OFFLINE_DRAFT_FORMATS, isOfflineDraftFormat, offlineDraftError };
