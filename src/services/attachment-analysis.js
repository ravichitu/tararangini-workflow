const path = require('path');
const { PDFDocument } = require('pdf-lib');
const {
  CUSTOMER_UPLOAD_LIMIT_MB,
  STAFF_UPLOAD_LIMIT_MB
} = require('../config/deployment-profile');

const SAFE_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
]);

function imagePayloadMatchesMime(bytes, mimeType) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (mimeType === 'image/jpeg') {
    return value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === 'image/gif') {
    return value.length >= 6 && ['GIF87a', 'GIF89a'].includes(value.subarray(0, 6).toString('ascii'));
  }
  if (mimeType === 'image/webp') {
    return value.length >= 12 && value.subarray(0, 4).toString('ascii') === 'RIFF' && value.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

function readUInt16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUInt24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUInt32BE(bytes, offset) {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = readUInt16BE(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return null;
    const sof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (sof && length >= 7) {
      const height = readUInt16BE(bytes, offset + 3);
      const width = readUInt16BE(bytes, offset + 5);
      return width && height ? { width, height, type: 'jpg' } : null;
    }
    offset += length;
  }
  return null;
}

function webpDimensions(bytes) {
  const chunk = bytes.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return {
      width: readUInt24LE(bytes, 24) + 1,
      height: readUInt24LE(bytes, 27) + 1,
      type: 'webp'
    };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
      type: 'webp'
    };
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10)),
      type: 'webp'
    };
  }
  return null;
}

// Parse only the formats accepted at upload time. Each parser advances through a bounded buffer.
function imageDimensions(bytes, mimeType) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!imagePayloadMatchesMime(value, mimeType)) return null;
  if (mimeType === 'image/png' && value.length >= 24 && value.subarray(12, 16).toString('ascii') === 'IHDR') {
    const width = readUInt32BE(value, 16);
    const height = readUInt32BE(value, 20);
    return width && height ? { width, height, type: 'png' } : null;
  }
  if (mimeType === 'image/gif' && value.length >= 10) {
    const width = value[6] | (value[7] << 8);
    const height = value[8] | (value[9] << 8);
    return width && height ? { width, height, type: 'gif' } : null;
  }
  if (mimeType === 'image/jpeg') return jpegDimensions(value);
  if (mimeType === 'image/webp') return webpDimensions(value);
  return null;
}

function roughlyEqual(a, b, tolerance = 12) {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= tolerance;
}

function pdfPageSizeLabel(width, height) {
  const short = Math.min(Number(width || 0), Number(height || 0));
  const long = Math.max(Number(width || 0), Number(height || 0));
  const knownSizes = [
    ['A5', 420, 595],
    ['A4', 595, 842],
    ['A3', 842, 1191],
    ['Letter', 612, 792],
    ['Legal', 612, 1008],
    ['Tabloid', 792, 1224]
  ];
  const match = knownSizes.find(([, knownShort, knownLong]) =>
    roughlyEqual(short, knownShort) && roughlyEqual(long, knownLong)
  );
  return match ? match[0] : `${short} x ${long} pt`;
}

function summarizePdfPages(pageSizes) {
  const counts = new Map();
  let portraitPages = 0;
  let landscapePages = 0;
  for (const page of pageSizes) {
    const label = pdfPageSizeLabel(page.width, page.height);
    counts.set(label, Number(counts.get(label) || 0) + 1);
    if (Number(page.height || 0) >= Number(page.width || 0)) portraitPages += 1;
    else landscapePages += 1;
  }
  const parts = [...counts.entries()].map(([label, count]) => `${count} x ${label}`);
  return {
    labels: pageSizes.map(page => pdfPageSizeLabel(page.width, page.height)),
    pageSizeSummary: parts.join(', '),
    dominantPageSize: parts[0] ? parts[0].replace(/^\d+\s+x\s+/, '') : null,
    uniformPageSize: counts.size === 1 ? [...counts.keys()][0] : null,
    hasMixedPageSizes: counts.size > 1,
    portraitPages,
    landscapePages
  };
}

function detectPdfColourUsage(bytes, pageCount) {
  const text = bytes.toString('latin1');
  let colourDetected = /\/(?:DeviceRGB|CalRGB|ICCBased|Separation|DeviceN)\b/.test(text);
  let colourOperators = 0;
  const rgbPattern = /(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(?:rg|RG)\b/g;
  const cmykPattern = /(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(?:k|K)\b/g;
  let match;
  while ((match = rgbPattern.exec(text))) {
    const values = match.slice(1, 4).map(Number);
    if (values.some(value => value > 0) && !(values[0] === values[1] && values[1] === values[2])) {
      colourDetected = true;
      colourOperators += 1;
    }
  }
  while ((match = cmykPattern.exec(text))) {
    const [c, m, y] = match.slice(1, 4).map(Number);
    if (c > 0 || m > 0 || y > 0) {
      colourDetected = true;
      colourOperators += 1;
    }
  }
  return {
    detected: colourDetected,
    confidence: colourOperators > 0 ? 'operator' : colourDetected ? 'document-hint' : 'none',
    operator_count: colourOperators,
    estimated_colour_pages: colourDetected ? pageCount : 0,
    estimated_bw_pages: colourDetected ? 0 : pageCount,
    note: colourDetected
      ? 'Best-effort PDF scan found colour drawing or colour-space hints. Operator should verify before billing.'
      : 'No colour drawing operators were detected by the best-effort scan.'
  };
}

function normalizeMimeType(fileName, mimeType) {
  const lowered = String(mimeType || '').toLowerCase();
  if (lowered) return lowered;
  const extension = path.extname(String(fileName || '')).toLowerCase();
  if (extension === '.pdf') return 'application/pdf';
  if (['.jpg', '.jpeg'].includes(extension)) return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.doc') return 'application/msword';
  if (extension === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (extension === '.xls') return 'application/vnd.ms-excel';
  if (extension === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return 'application/octet-stream';
}

function normalizeCustomerPdfPrintRequest(request, analysis = {}) {
  if (!request || typeof request !== 'object') return null;
  const analyzerTotalPages = Number(analysis.pdfPageCount || 0) || 0;
  let confirmedTotalPages = Number(
    request.customer_confirmed_total_pages ?? request.confirmed_total_pages ?? analyzerTotalPages
  );
  if (!Number.isFinite(confirmedTotalPages) || confirmedTotalPages <= 0) {
    confirmedTotalPages = analyzerTotalPages;
  }
  if (!Number.isFinite(confirmedTotalPages) || confirmedTotalPages <= 0) {
    throw new Error('PDF page count confirmation is required');
  }
  const colourPrintActive = Boolean(request.colour_print_active ?? request.color_print_active);
  let confirmedColorPages = Number(
    request.customer_confirmed_color_pages ?? request.confirmed_color_pages ?? 0
  );
  if (!Number.isFinite(confirmedColorPages) || confirmedColorPages < 0) confirmedColorPages = 0;
  let confirmedBwPages = Number(
    request.customer_confirmed_bw_pages ?? request.confirmed_bw_pages ??
    (colourPrintActive ? confirmedTotalPages - confirmedColorPages : confirmedTotalPages)
  );
  if (!Number.isFinite(confirmedBwPages) || confirmedBwPages < 0) confirmedBwPages = 0;
  if (!colourPrintActive) {
    confirmedColorPages = 0;
    confirmedBwPages = confirmedTotalPages;
  } else if ((request.customer_confirmed_bw_pages ?? request.confirmed_bw_pages) === undefined) {
    confirmedBwPages = Math.max(0, confirmedTotalPages - confirmedColorPages);
  }
  if (confirmedColorPages + confirmedBwPages !== confirmedTotalPages) {
    throw new Error('Confirmed color and B/W page counts must match the confirmed total pages');
  }
  return {
    print_job_requested: true,
    colour_print_active: colourPrintActive,
    analyzer_total_pages: analyzerTotalPages || null,
    customer_confirmed_total_pages: confirmedTotalPages,
    customer_confirmed_color_pages: confirmedColorPages,
    customer_confirmed_bw_pages: confirmedBwPages,
    customer_page_confirmation: Boolean(
      request.customer_page_confirmation ?? request.page_confirmation ?? false
    ),
    confirmation_notes: String(request.confirmation_notes || '').trim().slice(0, 1000),
    confirmed_total_differs_from_analyzer: analyzerTotalPages > 0 && confirmedTotalPages !== analyzerTotalPages
  };
}

async function analyzeAttachment({ fileName, mimeType, bytes }) {
  const normalizedMime = normalizeMimeType(fileName, mimeType);
  const metadata = {
    file_name: fileName,
    mime_type: normalizedMime,
    byte_size: bytes.length
  };
  if (SAFE_IMAGE_MIME_TYPES.has(normalizedMime)) {
    if (!imagePayloadMatchesMime(bytes, normalizedMime)) {
      return {
        mimeType: normalizedMime,
        pixelWidth: null,
        pixelHeight: null,
        pdfPageCount: null,
        analysisStatus: 'FAILED',
        analysisError: 'Image content does not match its declared safe file type.',
        metadata
      };
    }
    try {
      const image = imageDimensions(bytes, normalizedMime);
      if (!image) throw new Error('Image dimensions could not be read safely');
      return {
        mimeType: normalizedMime,
        pixelWidth: image.width || null,
        pixelHeight: image.height || null,
        pdfPageCount: null,
        analysisStatus: 'READY',
        analysisError: null,
        metadata: {
          ...metadata,
          image_type: image.type || null,
          original_width: image.width || null,
          original_height: image.height || null
        }
      };
    } catch (error) {
      return {
        mimeType: normalizedMime,
        pixelWidth: null,
        pixelHeight: null,
        pdfPageCount: null,
        analysisStatus: 'FAILED',
        analysisError: `Image analysis failed: ${error.message}`,
        metadata
      };
    }
  }
  if (normalizedMime.startsWith('image/')) {
    return {
      mimeType: normalizedMime,
      pixelWidth: null,
      pixelHeight: null,
      pdfPageCount: null,
      analysisStatus: 'FAILED',
      analysisError: 'This image format is not supported for analysis.',
      metadata
    };
  }
  if (normalizedMime === 'application/pdf') {
    try {
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
      const pageSizes = pdf.getPages().map((page, index) => {
        const { width, height } = page.getSize();
        return {
          page: index + 1,
          width: Math.round(width),
          height: Math.round(height)
        };
      });
      const summary = summarizePdfPages(pageSizes);
      const colourUsage = detectPdfColourUsage(bytes, pageSizes.length);
      return {
        mimeType: normalizedMime,
        pixelWidth: null,
        pixelHeight: null,
        pdfPageCount: pageSizes.length,
        analysisStatus: 'READY',
        analysisError: null,
        metadata: {
          ...metadata,
          pdf_page_count: pageSizes.length,
          page_sizes: pageSizes,
          page_size_labels: summary.labels,
          page_size_summary: summary.pageSizeSummary,
          dominant_page_size: summary.dominantPageSize,
          uniform_page_size: summary.uniformPageSize,
          has_mixed_page_sizes: summary.hasMixedPageSizes,
          portrait_pages: summary.portraitPages,
          landscape_pages: summary.landscapePages,
          colour_detection: colourUsage,
          auto_detected_colour_pages: colourUsage.estimated_colour_pages,
          auto_detected_bw_pages: colourUsage.estimated_bw_pages
        }
      };
    } catch (error) {
      return {
        mimeType: normalizedMime,
        pixelWidth: null,
        pixelHeight: null,
        pdfPageCount: null,
        analysisStatus: 'FAILED',
        analysisError: `PDF analysis failed: ${error.message}`,
        metadata
      };
    }
  }
  return {
    mimeType: normalizedMime,
    pixelWidth: null,
    pixelHeight: null,
    pdfPageCount: null,
    analysisStatus: 'READY',
    analysisError: null,
    metadata
  };
}

function validateAttachmentInput({ bytes, mimeType, uploadOrigin }) {
  const normalized = String(mimeType || '').toLowerCase();
  if (!bytes.length) throw new Error('Attachment content is required');
  const maxBytes = (
    uploadOrigin === 'CUSTOMER_PORTAL' ? CUSTOMER_UPLOAD_LIMIT_MB : STAFF_UPLOAD_LIMIT_MB
  ) * 1024 * 1024;
  if (bytes.length > maxBytes) {
    throw new Error(`Attachment exceeds ${Math.floor(maxBytes / (1024 * 1024))} MB limit`);
  }
  if (uploadOrigin === 'CUSTOMER_PORTAL') {
    const allowed = new Set([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp'
    ]);
    if (!allowed.has(normalized)) {
      throw new Error('Customer portal supports PDF, JPG, PNG, and WebP files only');
    }
    if (SAFE_IMAGE_MIME_TYPES.has(normalized) && !imagePayloadMatchesMime(bytes, normalized)) {
      throw new Error('Image content does not match its declared file type');
    }
    return;
  }
  const allowed = SAFE_IMAGE_MIME_TYPES.has(normalized) || [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ].includes(normalized);
  if (!allowed) throw new Error('Unsupported attachment type');
  if (SAFE_IMAGE_MIME_TYPES.has(normalized) && !imagePayloadMatchesMime(bytes, normalized)) {
    throw new Error('Image content does not match its declared file type');
  }
}

module.exports = {
  analyzeAttachment,
  normalizeCustomerPdfPrintRequest,
  validateAttachmentInput,
  normalizeMimeType,
  imagePayloadMatchesMime,
  imageDimensions,
  SAFE_IMAGE_MIME_TYPES
};
