const DEFAULT_PREFIXES = {
  SALE: 'SB',
  PP: 'PP',
  QUOT: 'QT',
  DC: 'DC',
  PI: 'PI'
};

function organizationCode(org) {
  return String(org?.display_name || 'ORG')
    .replace(/[^A-Z0-9]/gi, '')
    .slice(0, 3)
    .toUpperCase() || 'ORG';
}

function invoicePrefixes(org) {
  let configured = {};
  try { configured = JSON.parse(org?.invoice_prefixes || '{}'); } catch (_) {}
  return Object.fromEntries(Object.entries(DEFAULT_PREFIXES).map(([format, fallback]) => {
    const value = String(configured[format] || `${organizationCode(org)}-${fallback}`)
      .replace(/[^A-Z0-9_-]/gi, '')
      .slice(0, 7)
      .toUpperCase();
    return [format, value || `${organizationCode(org)}-${fallback}`];
  }));
}

function invoicePrefix(org, format) {
  return invoicePrefixes(org)[format] || String(format || 'INV').slice(0, 7).toUpperCase();
}

function invoiceNumber(prefix, fy, next) {
  const yearMatch = String(fy || '').match(/^20(\d{2})-\d{2}$/);
  const compactFy = yearMatch ? yearMatch[1] : String(fy || '').replace(/\D/g, '').slice(-2);
  return `${String(prefix || 'INV').slice(0, 7)}/${compactFy}/${String(next).padStart(4, '0')}`;
}

module.exports = { DEFAULT_PREFIXES, invoicePrefixes, invoicePrefix, invoiceNumber };
