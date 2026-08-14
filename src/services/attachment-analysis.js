const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { imageSize } = require('image-size');
const {
  CUSTOMER_UPLOAD_LIMIT_MB,
  STAFF_UPLOAD_LIMIT_MB
} = require('../config/deployment-profile');

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
  if (normalizedMime.startsWith('image/')) {
    try {
      const image = imageSize(bytes);
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
    return;
  }
  const allowed = normalized.startsWith('image/') || [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ].includes(normalized);
  if (!allowed) throw new Error('Unsupported attachment type');
}

module.exports = {
  analyzeAttachment,
  normalizeCustomerPdfPrintRequest,
  validateAttachmentInput,
  normalizeMimeType
};
