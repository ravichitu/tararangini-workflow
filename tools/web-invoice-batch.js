#!/usr/bin/env node
'use strict';

// Creates clearly marked QA invoices through Tarangini's authenticated HTTP API.
// It is intentionally safe-by-default: --commit is required before any write occurs.

const fs = require('fs');
const path = require('path');

const DEFAULT_COUNT = 5;
const MAX_COUNT = 250;
const DEFAULT_RATE = 100;

class BatchError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'BatchError';
    this.status = status;
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function timestampId() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function safeBatchId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,78}$/.test(id)) {
    throw new BatchError('Batch ID must use 2-79 letters, numbers, dots, underscores, or hyphens.');
  }
  return id;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new BatchError(`${label} must be a whole number from 1 to ${maximum}.`);
  }
  return number;
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 100000000) {
    throw new BatchError(`${label} must be greater than zero and within the allowed limit.`);
  }
  return Number(number.toFixed(2));
}

function normalizeServerUrl(value) {
  let url;
  try {
    url = new URL(String(value || 'http://127.0.0.1:3000').trim());
  } catch (_) {
    throw new BatchError('Server must be a valid URL, for example http://192.168.1.20:3000.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new BatchError('Server must use http:// or https://.');
  }
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function parseArgs(argv) {
  const options = {
    server: 'http://127.0.0.1:3000',
    count: DEFAULT_COUNT,
    rate: DEFAULT_RATE,
    commit: false,
    help: false
  };
  const named = new Map([
    ['--server', 'server'], ['--username', 'username'], ['--org-id', 'orgId'],
    ['--count', 'count'], ['--batch-id', 'batchId'], ['--party-id', 'partyId'],
    ['--party-name', 'partyName'], ['--item-name', 'itemName'], ['--rate', 'rate'],
    ['--report', 'reportPath'], ['--bill-date', 'billDate']
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '');
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--commit') {
      options.commit = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.commit = false;
      continue;
    }
    if (arg === '--password' || arg === '--pin') {
      throw new BatchError('Do not pass credentials on the command line. Use the secure prompt in the Windows launcher.');
    }
    const key = named.get(arg);
    if (!key) throw new BatchError(`Unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || String(value).startsWith('--')) throw new BatchError(`${arg} needs a value.`);
    options[key] = String(value);
    index += 1;
  }
  return options;
}

function usage() {
  return [
    'Tarangini Web Invoice Batch Creator',
    '',
    'Creates clearly marked QA SALE invoices through the authenticated Tarangini API.',
    'Dry-run is the default. Add --commit only after reviewing the plan.',
    '',
    'Usage:',
    '  Run Web Invoice Batch.cmd --server http://192.168.1.20:3000 --username operator1 --org-id 1 --count 5 --dry-run',
    '  Run Web Invoice Batch.cmd --server http://192.168.1.20:3000 --username operator1 --org-id 1 --count 5 --batch-id QA-OPERATOR-001 --commit',
    '',
    'Options:',
    '  --server URL       Main System URL (default: http://127.0.0.1:3000)',
    '  --username NAME    Existing Tarangini user account (required)',
    '  --org-id ID        Accessible company ID; first accessible company if omitted',
    `  --count N          Invoices to plan/create, from 1 to ${MAX_COUNT} (default: ${DEFAULT_COUNT})`,
    '  --batch-id ID      Reusable idempotency ID; defaults to a timestamp ID',
    '  --party-id ID      Existing party ID; otherwise a QA party is reused/created',
    '  --party-name NAME  QA party name when --party-id is not used',
    '  --item-name NAME   Test service item name',
    `  --rate AMOUNT      Per-invoice amount (default: ${DEFAULT_RATE})`,
    '  --bill-date YYYY-MM-DD  Invoice date (default: today)',
    '  --report PATH      JSON audit report path',
    '  --dry-run          Validate and report only (default)',
    '  --commit           Create the batch after validation',
    '',
    'The launcher prompts for the password/PIN securely. Credentials, tokens, and passwords are never written to the report.'
  ].join('\n');
}

function normalizeOptions(input) {
  const raw = { ...input };
  const server = normalizeServerUrl(raw.server);
  const username = String(raw.username || '').trim();
  if (!username || username.length > 80) throw new BatchError('A valid Tarangini username is required.');
  const secret = String(raw.secret || process.env.TARANGINI_BATCH_SECRET || '');
  if (!secret) throw new BatchError('A password or PIN is required. Use the Windows launcher secure prompt.');
  const batchId = safeBatchId(raw.batchId || `WEB-BATCH-${timestampId()}`);
  const count = positiveInteger(raw.count ?? DEFAULT_COUNT, 'Count', MAX_COUNT);
  const orgId = raw.orgId === undefined || raw.orgId === '' ? null : positiveInteger(raw.orgId, 'Organization ID');
  const partyId = raw.partyId === undefined || raw.partyId === '' ? null : positiveInteger(raw.partyId, 'Party ID');
  const rate = positiveNumber(raw.rate ?? DEFAULT_RATE, 'Rate');
  const partyName = String(raw.partyName || `Web Batch Customer - ${batchId}`).trim().slice(0, 120);
  const itemName = String(raw.itemName || 'Web Batch Test Service').trim().slice(0, 120);
  if (!partyId && !partyName) throw new BatchError('Party name is required when party ID is not supplied.');
  if (!itemName) throw new BatchError('Item name is required.');
  const billDate = String(raw.billDate || today()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(billDate) || Number.isNaN(Date.parse(`${billDate}T00:00:00Z`))) {
    throw new BatchError('Bill date must be YYYY-MM-DD.');
  }
  const reportDir = String(process.env.TARANGINI_BATCH_REPORT_DIR || process.cwd());
  const reportPath = path.resolve(raw.reportPath || path.join(reportDir, `tarangini-web-invoice-batch-${batchId}.json`));
  return {
    server, username, secret, batchId, count, orgId, partyId, partyName, itemName, rate, billDate,
    reportPath, commit: Boolean(raw.commit)
  };
}

async function requestJson(options, route, method = 'GET', body) {
  const response = await fetch(`${options.server}/api${route}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { error: text || `HTTP ${response.status}` }; }
  if (!response.ok) {
    throw new BatchError(`${method} ${route} failed: ${payload.error || response.statusText || response.status}`, response.status);
  }
  return payload;
}

function markerFor(batchId, serial) {
  return `WEB-BATCH ${batchId} #${String(serial).padStart(3, '0')}`;
}

function batchSerial(description, batchId) {
  const match = new RegExp(`^WEB-BATCH ${batchId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} #(\\d{3})$`).exec(String(description || '').trim());
  return match ? Number(match[1]) : null;
}

function publicReport(options) {
  return {
    tool: 'Tarangini Web Invoice Batch Creator',
    version: 1,
    batch_id: options.batchId,
    started_at: new Date().toISOString(),
    mode: options.commit ? 'commit' : 'dry-run',
    server: options.server,
    username: options.username,
    requested: {
      org_id: options.orgId,
      count: options.count,
      party_id: options.partyId,
      party_name: options.partyId ? undefined : options.partyName,
      item_name: options.itemName,
      rate: options.rate,
      bill_date: options.billDate
    },
    created: [],
    reused: [],
    warnings: [],
    errors: []
  };
}

function writeReport(report, reportPath) {
  report.completed_at = new Date().toISOString();
  report.report_path = reportPath;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function requestedReportPath(argv) {
  const index = argv.indexOf('--report');
  if (index >= 0 && argv[index + 1]) return path.resolve(String(argv[index + 1]));
  const reportDir = String(process.env.TARANGINI_BATCH_REPORT_DIR || process.cwd());
  return path.resolve(reportDir, `tarangini-web-invoice-batch-failed-${timestampId()}.json`);
}

async function resolveParty(options, report, orgId) {
  if (options.partyId) {
    const party = await requestJson(options, `/parties/${options.partyId}?org_id=${orgId}`);
    return { id: Number(party.id), name: party.name, source: 'existing-id' };
  }
  const parties = await requestJson(options, `/parties?org_id=${orgId}&type=all&search=${encodeURIComponent(options.partyName)}&limit=500`);
  const exact = parties.find(party => String(party.name || '').trim().toLowerCase() === options.partyName.toLowerCase());
  if (exact) return { id: Number(exact.id), name: exact.name, source: 'existing-name' };
  if (!options.commit) return { id: null, name: options.partyName, source: 'planned-create' };
  const created = await requestJson(options, '/parties', 'POST', {
    org_id: orgId,
    type: 'customer',
    name: options.partyName,
    registered_name: options.partyName,
    shared: false,
    state: 'Andhra Pradesh'
  });
  report.created_party = { id: Number(created.id), name: options.partyName };
  return { id: Number(created.id), name: options.partyName, source: 'created' };
}

async function runBatch(input) {
  const options = normalizeOptions(input);
  const report = publicReport(options);
  try {
    const login = await requestJson({ ...options, token: null }, '/auth/login', 'POST', {
      username: options.username,
      password: options.secret
    });
    options.token = login.token;
    report.actor = {
      id: login.user?.id,
      name: login.user?.name,
      username: login.user?.username,
      role: login.user?.role
    };
    if (!options.token || !report.actor.username) throw new BatchError('Login did not return an authenticated user.');
    if (report.actor.username.toLowerCase() !== options.username.toLowerCase()) {
      throw new BatchError('Logged-in username does not match the requested username.');
    }

    const orgs = await requestJson(options, '/orgs');
    const org = options.orgId
      ? orgs.find(row => Number(row.id) === options.orgId)
      : orgs[0];
    if (!org) throw new BatchError('The selected company is not accessible to this role.');
    report.organization = { id: Number(org.id), display_name: org.display_name, gst_type: org.gst_type };

    const existingRows = await requestJson(options,
      `/bills?org_id=${org.id}&format=SALE&search=${encodeURIComponent(`WEB-BATCH ${options.batchId}`)}&limit=500`);
    const existingBySerial = new Map();
    existingRows.forEach(row => {
      const serial = batchSerial(row.description, options.batchId);
      if (serial && serial <= options.count) existingBySerial.set(serial, row);
    });

    const party = await resolveParty(options, report, Number(org.id));
    report.party = party;
    const planned = [];
    for (let serial = 1; serial <= options.count; serial += 1) {
      const existing = existingBySerial.get(serial);
      if (existing) {
        report.reused.push({ id: Number(existing.id), bill_number: existing.bill_number, marker: markerFor(options.batchId, serial) });
      } else {
        planned.push(serial);
      }
    }
    report.planned = planned.map(serial => ({ marker: markerFor(options.batchId, serial), amount: options.rate }));
    if (!options.commit) {
      report.status = 'dry-run-complete';
      return report;
    }
    if (!party.id) throw new BatchError('No usable party was available for this batch.');

    for (const serial of planned) {
      const marker = markerFor(options.batchId, serial);
      const response = await requestJson(options, '/bills', 'POST', {
        org_id: Number(org.id),
        format: 'SALE',
        bill_date: options.billDate,
        party_id: party.id,
        party_name_confirmation: party.name,
        payment_mode: 'cash',
        tax_inclusive: false,
        round_off_enabled: true,
        description: marker,
        note_footer: marker,
        items: [{
          item_name: options.itemName,
          item_description: marker,
          hsn_code: '998314',
          qty: 1,
          unit: 'NOS',
          rate: options.rate,
          amount: options.rate,
          gst_rate: 18
        }]
      });
      const bill = response.bill || {};
      report.created.push({
        id: Number(response.id || bill.id),
        bill_number: bill.bill_number,
        marker,
        grand_total: Number(bill.grand_total || 0),
        stock_warnings: response.stock_warnings || []
      });
      if (Array.isArray(response.stock_warnings) && response.stock_warnings.length) {
        report.warnings.push(...response.stock_warnings.map(warning => `${bill.bill_number || marker}: ${warning}`));
      }
    }

    const verification = [];
    for (const row of [...report.created, ...report.reused]) {
      const bill = await requestJson(options, `/bills/${row.id}/full`);
      const valid = bill.format === 'SALE' && String(bill.description || '') === row.marker &&
        Number(bill.org_id) === Number(org.id) && String(bill.created_by_username || '').toLowerCase() === options.username.toLowerCase();
      verification.push({ id: row.id, bill_number: bill.bill_number, valid, created_by: bill.created_by_username || null });
      if (!valid) throw new BatchError(`Verification failed for ${bill.bill_number || `invoice ${row.id}`}.`);
    }
    report.verification = verification;
    report.status = 'commit-complete';
    return report;
  } catch (error) {
    report.status = 'failed';
    report.errors.push(error.message || String(error));
    throw Object.assign(error, { report });
  } finally {
    options.token = undefined;
    writeReport(report, options.reportPath);
  }
}

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
    if (parsed.help) {
      console.log(usage());
      return 0;
    }
    const report = await runBatch(parsed);
    const action = report.mode === 'commit' ? `${report.created.length} created, ${report.reused.length} reused` : `${report.planned.length} planned, ${report.reused.length} existing`;
    console.log(`Web invoice batch ${report.batch_id}: ${action}.`);
    console.log(`Report: ${report.report_path}`);
    return 0;
  } catch (error) {
    const reportPath = error.report?.report_path || parsed?.reportPath || requestedReportPath(argv);
    if (!error.report) {
      try {
        writeReport({
          tool: 'Tarangini Web Invoice Batch Creator',
          version: 1,
          status: 'failed',
          mode: 'unknown',
          started_at: new Date().toISOString(),
          errors: [error.message || String(error)]
        }, reportPath);
      } catch (_) {
        // The caller still receives the original error when an invalid report path is supplied.
      }
    }
    console.error(`Web invoice batch failed: ${error.message || error}`);
    if (reportPath) console.error(`Report: ${reportPath}`);
    return 1;
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; });
}

module.exports = { BatchError, parseArgs, normalizeOptions, runBatch, main, usage };
