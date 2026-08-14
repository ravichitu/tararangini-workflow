const TRANSACTION_TYPES = [
  ['SALE', 'Sale Invoice'],
  ['PP', 'Project Printing Invoice'],
  ['QUOT', 'Quotation'],
  ['PI', 'Proforma Invoice'],
  ['DC', 'Delivery Challan / Delivery Note'],
  ['POS', 'POS Bill'],
  ['PR', 'Receipt Voucher'],
  ['PV', 'Payment Voucher'],
  ['JOURNAL', 'Journal Voucher'],
  ['PURCHASE', 'Purchase Bill'],
  ['PO', 'Purchase Order'],
  ['EXPENSE', 'Expense Voucher'],
  ['CN', 'Credit Note'],
  ['DN', 'Debit Note'],
  ['RETURN', 'Sales Return'],
  ['JOB_FINAL', 'Job Final Invoice']
];

const COMMON_FIELDS = [
  ['party', 'Party / Customer / Vendor'],
  ['gstin', 'GSTIN'],
  ['billing_address', 'Billing Address'],
  ['delivery_address', 'Delivery Address'],
  ['recipient', 'Recipient Name / Phone'],
  ['transport', 'Transport / Courier'],
  ['tracking', 'Tracking / LR / Consignment No.'],
  ['dispatch_date', 'Dispatch Date'],
  ['po_details', 'PO Number / Date'],
  ['hsn', 'HSN Code'],
  ['item_description', 'Item Description / Serial'],
  ['qty_unit', 'Qty / Unit'],
  ['rate', 'Rate'],
  ['amount', 'Amount'],
  ['gst_split', 'GST / Tax Split'],
  ['tax_inclusive', 'Tax-Inclusive Value / Note'],
  ['discount', 'Discount'],
  ['round_off', 'Round Off'],
  ['payment_mode', 'Payment Mode'],
  ['split_payment', 'Split Payment Details'],
  ['bank_details', 'Bank Account Details'],
  ['qr_code', 'QR Code'],
  ['signature_image', 'Authorised Signature Image'],
  ['digital_signature', 'USB DSC Digital Signature Note / Status'],
  ['footer', 'Footer Terms / Narration'],
  ['operator', 'Operator / User Name'],
  ['company_logo', 'Company Logo']
];

const FIELD_SETS = {
  SALE: COMMON_FIELDS,
  PP: COMMON_FIELDS,
  QUOT: [
    ...COMMON_FIELDS,
    ['payment_status', 'Payment Status']
  ],
  PI: COMMON_FIELDS,
  DC: COMMON_FIELDS,
  POS: [
    ...COMMON_FIELDS,
    ['held_bill', 'Held Bill Button / Draft Controls'],
    ['compact_print', 'Compact POS Print Fields']
  ],
  PR: [
    ['party', 'Party'],
    ['payment_mode', 'Payment Mode'],
    ['reference', 'Reference Number / UTR'],
    ['bank_reference', 'Bank Reference'],
    ['linked_bills', 'Linked Bills'],
    ['amount', 'Amount'],
    ['footer', 'Narration'],
    ['operator', 'Operator / User Name']
  ],
  PV: [
    ['party', 'Payee / Vendor'],
    ['payment_mode', 'Payment Mode'],
    ['reference', 'Reference Number / UTR'],
    ['bank_reference', 'Bank Reference'],
    ['linked_bills', 'Linked Bills'],
    ['amount', 'Amount'],
    ['footer', 'Narration'],
    ['operator', 'Operator / User Name']
  ],
  JOURNAL: [
    ['voucher_type', 'Voucher Type'],
    ['account_codes', 'Account Codes'],
    ['debit_credit_lines', 'Debit / Credit Lines'],
    ['footer', 'Narration'],
    ['operator', 'Operator / User Name']
  ],
  PURCHASE: [
    ['party', 'Vendor'],
    ['supplier_invoice', 'Supplier Invoice Number'],
    ['vendor_gstin', 'Vendor GSTIN'],
    ['hsn', 'Item HSN'],
    ['qty_unit', 'Qty / Unit'],
    ['rate', 'Rate'],
    ['amount', 'Amount'],
    ['gst_split', 'GST / Tax Split'],
    ['tax_inclusive', 'Tax-Inclusive Mode'],
    ['round_off', 'Round Off'],
    ['payment_mode', 'Payment Mode'],
    ['footer', 'Narration']
  ],
  PO: [
    ['party', 'Vendor'],
    ['supplier_invoice', 'Supplier Invoice / Reference'],
    ['expected_date', 'Expected Date'],
    ['vendor_gstin', 'Vendor GSTIN'],
    ['hsn', 'Item HSN'],
    ['qty_unit', 'Qty / Unit'],
    ['rate', 'Rate'],
    ['amount', 'Amount'],
    ['tax_inclusive', 'Tax-Inclusive Mode'],
    ['round_off', 'Round Off'],
    ['footer', 'Narration']
  ],
  EXPENSE: [
    ['party', 'Payee'],
    ['account_codes', 'Expense Account'],
    ['payment_mode', 'Payment Mode'],
    ['amount', 'Amount'],
    ['gst_split', 'Input GST'],
    ['tax_inclusive', 'Tax-Inclusive Mode'],
    ['reference', 'Reference Number'],
    ['round_off', 'Round Off'],
    ['footer', 'Narration']
  ],
  CN: [
    ['party', 'Party'],
    ['linked_bills', 'Original Invoice Link'],
    ['reason', 'Reason'],
    ['stock_adjustment', 'Stock Adjustment'],
    ['hsn', 'Item HSN'],
    ['qty_unit', 'Qty / Unit'],
    ['rate', 'Rate'],
    ['amount', 'Amount'],
    ['gst_split', 'GST / Tax Details'],
    ['tax_inclusive', 'Tax-Inclusive Mode'],
    ['round_off', 'Round Off']
  ],
  DN: [
    ['party', 'Party'],
    ['linked_bills', 'Original Invoice Link'],
    ['reason', 'Reason'],
    ['stock_adjustment', 'Stock Adjustment'],
    ['hsn', 'Item HSN'],
    ['qty_unit', 'Qty / Unit'],
    ['rate', 'Rate'],
    ['amount', 'Amount'],
    ['gst_split', 'GST / Tax Details'],
    ['tax_inclusive', 'Tax-Inclusive Mode'],
    ['round_off', 'Round Off']
  ],
  RETURN: [
    ['party', 'Customer'],
    ['linked_bills', 'Original Invoice Link'],
    ['reason', 'Reason'],
    ['stock_adjustment', 'Stock Adjustment'],
    ['hsn', 'Item HSN'],
    ['qty_unit', 'Qty / Unit'],
    ['rate', 'Rate'],
    ['amount', 'Amount'],
    ['gst_split', 'GST / Tax Details'],
    ['tax_inclusive', 'Tax-Inclusive Mode'],
    ['round_off', 'Round Off']
  ],
  JOB_FINAL: COMMON_FIELDS
};

const REQUIRED_BY_DEFAULT = {
  SALE: ['qty_unit'],
  PP: ['party'],
  QUOT: ['qty_unit'],
  PI: ['qty_unit'],
  DC: ['qty_unit'],
  POS: ['qty_unit'],
  PR: ['amount'],
  PV: ['amount'],
  JOURNAL: ['debit_credit_lines'],
  PURCHASE: ['qty_unit', 'amount'],
  PO: ['party', 'qty_unit'],
  EXPENSE: ['account_codes', 'amount'],
  CN: ['party', 'qty_unit'],
  DN: ['party', 'qty_unit'],
  RETURN: ['party', 'qty_unit'],
  JOB_FINAL: ['party', 'qty_unit', 'amount']
};

function truthMap(fields, value = true) {
  return Object.fromEntries(fields.map(([key]) => [key, value]));
}

function defaultControl(type, invoicePrintOptions = {}) {
  const fields = FIELD_SETS[type] || COMMON_FIELDS;
  const form = truthMap(fields, true);
  const print = truthMap(fields, true);
  if (['SALE', 'PP', 'QUOT', 'PI', 'DC', 'POS'].includes(type)) {
    if (invoicePrintOptions.hsn === false) print.hsn = false;
    if (invoicePrintOptions.rate === false) print.rate = false;
    if (invoicePrintOptions.tax_inclusive_value === false) print.tax_inclusive = false;
    if (invoicePrintOptions.bank_details === false) print.bank_details = false;
  }
  if (type === 'QUOT') {
    // Quotations are pre-payment documents; keep operational approval/sign-off
    // data available internally without printing it by default.
    print.payment_status = false;
    print.operator = false;
    print.digital_signature = false;
  }
  const required = {};
  (REQUIRED_BY_DEFAULT[type] || []).forEach(key => {
    if (form[key] !== false) required[key] = true;
  });
  return { form_options: form, required_fields: required, print_options: print };
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch (_) { return fallback; }
}

function sanitizeControl(type, control = {}, invoicePrintOptions = {}) {
  const fields = FIELD_SETS[type] || COMMON_FIELDS;
  const allowed = new Set(fields.map(([key]) => key));
  const defaults = defaultControl(type, invoicePrintOptions);
  const clean = {
    form_options: { ...defaults.form_options },
    required_fields: { ...defaults.required_fields },
    print_options: { ...defaults.print_options }
  };
  const form = parseJson(control.form_options, control.form_options || {});
  const required = parseJson(control.required_fields, control.required_fields || {});
  const print = parseJson(control.print_options, control.print_options || {});
  fields.forEach(([key]) => {
    if (Object.prototype.hasOwnProperty.call(form, key)) clean.form_options[key] = form[key] !== false;
    if (Object.prototype.hasOwnProperty.call(print, key)) clean.print_options[key] = print[key] !== false;
    if (Object.prototype.hasOwnProperty.call(required, key)) clean.required_fields[key] = required[key] === true;
    if (clean.form_options[key] === false) clean.required_fields[key] = false;
  });
  Object.keys(clean.required_fields).forEach(key => {
    if (!allowed.has(key)) delete clean.required_fields[key];
  });
  return clean;
}

function typeMeta(invoicePrintOptions = {}) {
  return TRANSACTION_TYPES.map(([type, label]) => ({
    type,
    label,
    fields: FIELD_SETS[type] || COMMON_FIELDS,
    defaults: defaultControl(type, invoicePrintOptions)
  }));
}

module.exports = {
  TRANSACTION_TYPES,
  FIELD_SETS,
  defaultControl,
  sanitizeControl,
  typeMeta,
  parseJson
};
