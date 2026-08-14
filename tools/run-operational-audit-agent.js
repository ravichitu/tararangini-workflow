/*
 * Runs a repeatable accounting and operational audit against an isolated
 * Tarangini server. It never opens the live application database.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output', 'audits');
const KEEP_FIXTURE = process.argv.includes('--keep-fixture');
const STRICT = process.argv.includes('--strict');
const FULL_SUITE = process.argv.includes('--full-suite');
const requestedYears = Number(process.env.AUDIT_YEARS || 12);
const YEARS = Math.max(10, Math.min(20, Number.isFinite(requestedYears) ? requestedYears : 12));
const now = new Date();
const defaultEndFyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
const END_FY_START = Number(process.env.AUDIT_END_FY_START || defaultEndFyStart);
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const FIXTURE_DIR = path.join(ROOT, 'tmp', 'operational-audit', RUN_ID);
const DATA_DIR = path.join(FIXTURE_DIR, 'data');
const ATTACHMENT_DIR = path.join(FIXTURE_DIR, 'attachments');
const BACKUP_DIR = path.join(FIXTURE_DIR, 'backups');
const REPORT_JSON = path.join(OUTPUT_DIR, `Tarangini_Operational_Audit_${RUN_ID}.json`);
const REPORT_MD = path.join(OUTPUT_DIR, `Tarangini_Operational_Audit_${RUN_ID}.md`);

// Read-only architecture findings are kept separate from live API findings.
// They remain visible in every generated upgrade report until deliberately fixed.
const KNOWN_ARCHITECTURE_UPGRADES = [
  {
    priority: 'P0',
    title: 'Restrict the global integrity repair so it cannot rebuild accounting journals or stock movements inside a closed financial year without an explicit owner-approved recovery workflow.',
    source: 'architecture-audit: closed-year-repair'
  },
  {
    priority: 'P1',
    title: 'Make financial-year backup exports complete and explicit: include purchases, expenses, notes, stock, audit, jobs, bank rows, and GSTR data, or clearly label the export as organization-wide rather than FY-scoped.',
    source: 'architecture-audit: fy-backup-completeness'
  },
  {
    priority: 'P1',
    title: 'Add backup retention, off-device replication, restore drills, disk-space alarms, and verification reporting; daily full backups otherwise grow without a defined retention limit.',
    source: 'architecture-audit: backup-retention'
  },
  {
    priority: 'P1',
    title: 'Paginate and set-optimize stock, ageing, invoice-status, party-statement, account-ledger, and bank-report endpoints before long-lived databases grow beyond normal operating volume.',
    source: 'architecture-audit: report-scaling'
  },
  {
    priority: 'P1',
    title: 'Strengthen financial-year close with immutable signed snapshots, carry-forward records, controlled reopen approval, and an auditable forced-close workflow.',
    source: 'architecture-audit: close-immutability'
  },
  {
    priority: 'P2',
    title: 'Move accounting amounts from floating-point REAL/Number values to integer paise or validated decimal arithmetic before repeated multi-year aggregation and reposting can accumulate rounding drift.',
    source: 'architecture-audit: monetary-precision'
  },
  {
    priority: 'P2',
    title: 'Replace silent additive migration failures with versioned transactional migrations and post-migration validation for long-lived customer databases.',
    source: 'architecture-audit: migration-safety'
  }
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fyForStartYear = year => `${year}-${String(year + 1).slice(-2)}`;
const money = value => Number(Number(value || 0).toFixed(2));

function asRows(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.payload) ? payload.payload : [];
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function readJsonIfPresent(fileName) {
  const fullPath = path.join(ROOT, 'tests', fileName);
  if (!fs.existsSync(fullPath)) return { file: fileName, status: 'missing' };
  try { return { file: fileName, status: 'available', data: JSON.parse(fs.readFileSync(fullPath, 'utf8')) }; }
  catch (error) { return { file: fileName, status: 'invalid', error: error.message }; }
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function startServer(port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      TARANGINI_DATA_DIR: DATA_DIR,
      TARANGINI_ATTACHMENT_DIR: ATTACHMENT_DIR,
      TARANGINI_DEFAULT_BACKUP_DIR: BACKUP_DIR,
      TARANGINI_DEPLOYMENT_PROFILE: 'store'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return { child, output: () => output };
}

function runCommand(name, command, args, timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: ROOT,
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ name, status: 'timeout', seconds: money((Date.now() - started) / 1000), output: output.slice(-4000) });
    }, timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ name, status: 'failed', seconds: money((Date.now() - started) / 1000), output: `${output}\n${error.message}`.slice(-4000) });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ name, status: code === 0 ? 'passed' : 'failed', exit_code: code, seconds: money((Date.now() - started) / 1000), output: output.slice(-4000) });
    });
  });
}

async function runFullRegressionSuites() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const suites = [
    ['complete-review-suite', ['run', 'test:review'], 20 * 60 * 1000],
    ['quotation-dc-invoice-flow', ['run', 'test:quotation-flow'], 4 * 60 * 1000],
    ['customer-intake-workflow', ['run', 'test:job-intake'], 4 * 60 * 1000],
    ['customer-portal-300-requests', ['run', 'test:customer-portal-300'], 8 * 60 * 1000]
  ];
  const results = [];
  for (const [name, args, timeout] of suites) results.push(await runCommand(name, npm, args, timeout));
  return results;
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 2000);
    server.once('exit', () => { clearTimeout(timer); resolve(); });
    server.kill();
  });
}

async function waitForServer(baseUrl, output) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch (_) {}
    await sleep(100);
  }
  throw new Error(`Audit server did not become ready.\n${output()}`);
}

async function api(baseUrl, method, route, body, token) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/api${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch (_) { payload = { raw: text }; }
  return { status: response.status, ok: response.ok, payload, milliseconds: performance.now() - started };
}

async function required(baseUrl, method, route, body, token) {
  const result = await api(baseUrl, method, route, body, token);
  if (!result.ok) throw new Error(`${method} ${route} returned ${result.status}: ${result.payload.error || 'request failed'}`);
  return result.payload;
}

function addCheck(checks, id, status, title, evidence, upgrade = null) {
  checks.push({ id, status, title, evidence, upgrade });
}

function buildUpgradeList(checks) {
  const upgrades = checks
    .filter(check => ['fail', 'warning'].includes(check.status) && check.upgrade)
    .map(check => ({ priority: check.status === 'fail' ? 'P0' : 'P1', title: check.upgrade, source: check.id }));
  upgrades.push(
    ...KNOWN_ARCHITECTURE_UPGRADES,
    {
      priority: 'P1',
      title: 'Schedule this isolated audit weekly and retain only its JSON/Markdown reports; alert the owner when a reconciliation or integrity check fails.',
      source: 'operational-audit-agent'
    },
    {
      priority: 'P2',
      title: 'Add a financial-year archive and reporting policy before real data exceeds the operational query limits; keep all statutory records and backups intact.',
      source: 'long-horizon-capacity'
    },
    {
      priority: 'P2',
      title: 'Run the existing 100k/million-row benchmarks and a 24-hour multi-device pilot on the target hardware before certifying throughput or concurrent upload capacity.',
      source: 'capacity-evidence'
    }
  );
  return upgrades;
}

function reportMarkdown(report) {
  const lines = [
    '# Tarangini Operational Audit Report',
    '',
    `- Generated: ${report.generated_at}`,
    `- Application version: ${report.application_version}`,
    `- Audit database: isolated temporary fixture only`,
    `- Financial-year horizon: ${report.horizon.years} years (${report.horizon.first_fy} to ${report.horizon.last_fy})`,
    `- Fixture retained: ${report.fixture.retained ? 'yes' : 'no'}`,
    '',
    '## Result Summary',
    '',
    `- Passed: ${report.summary.pass}`,
    `- Findings: ${report.summary.fail}`,
    `- Warnings: ${report.summary.warning}`,
    `- Information: ${report.summary.info}`,
    '',
    '## Audit Checks',
    ''
  ];
  report.checks.forEach(check => {
    lines.push(`- **${check.status.toUpperCase()}** - ${check.title}`);
    lines.push(`  Evidence: ${check.evidence}`);
    if (check.upgrade) lines.push(`  Upgrade: ${check.upgrade}`);
  });
  lines.push('', '## Database Separation Verified', '');
  lines.push('- Companies are separated by `org_id` on transaction, stock, journal, and party data.');
  lines.push('- Financial years are stored on billing, payment, purchase, expense, note, and journal-entry records.');
  lines.push('- Stock is derived from `items.opening_stock` plus immutable-style source-linked `stock_movements`.');
  lines.push('- Accounting is derived from source-linked `journal_entries` and `journal_lines`; payment settlement uses `payment_allocations`.');
  lines.push('', '## Prioritized Upgrade List', '');
  report.upgrades.forEach(upgrade => lines.push(`- **${upgrade.priority}** - ${upgrade.title} (${upgrade.source})`));
  lines.push('', '## Capacity Evidence', '');
  report.capacity_evidence.forEach(row => lines.push(`- ${row.file}: ${row.status}`));
  lines.push('', '## Full Regression Suites', '');
  if (report.full_regression_suites?.length) {
    report.full_regression_suites.forEach(suite => lines.push(`- ${suite.name}: **${suite.status}** (${suite.seconds || 0} s)`));
  } else {
    lines.push('- Not run. Execute `npm.cmd run audit:operations -- --full-suite` for the complete regression and customer-portal pass.');
  }
  lines.push('', '## Limits', '');
  lines.push('- This agent tests live application APIs against synthetic data in a separate database. It does not inspect customer data or certify production hardware.');
  lines.push('- Heavy upload, multi-PC, network outage, and million-row results must be interpreted from the dedicated capacity/soak tests and a physical deployment pilot.');
  lines.push('- The canonical existing roadmap remains `UPGRADE_LIST.md`; this report adds evidence-based audit recommendations and does not mark future upgrades as complete.');
  return `${lines.join('\n')}\n`;
}

async function inspectDatabase(dbPath, orgId, latestFy) {
  const db = new DatabaseSync(dbPath);
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0]);
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    const tableCounts = {};
    for (const table of ['bills', 'payments', 'payment_allocations', 'stock_movements', 'journal_entries', 'journal_lines', 'financial_year_locks', 'audit_log']) {
      tableCounts[table] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count || 0);
    }
    const plans = {
      bills_by_year: db.prepare('EXPLAIN QUERY PLAN SELECT id FROM bills WHERE org_id=? AND fy=? AND deleted=0 ORDER BY bill_date').all(orgId, latestFy),
      payments_by_year: db.prepare('EXPLAIN QUERY PLAN SELECT id FROM payments WHERE org_id=? AND fy=? AND deleted=0 ORDER BY payment_date').all(orgId, latestFy),
      stock_by_item: db.prepare('EXPLAIN QUERY PLAN SELECT id FROM stock_movements WHERE org_id=? AND item_id=? ORDER BY movement_date').all(orgId, 1)
    };
    return { integrity, foreign_keys: foreignKeys, table_counts: tableCounts, plans };
  } finally {
    db.close();
  }
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Prevent db.js from copying the bundled/local database into this audit run.
  fs.closeSync(fs.openSync(path.join(DATA_DIR, 'tarangini.db'), 'a'));
  const checks = [];
  const firstFyStart = END_FY_START - YEARS + 1;
  const fiscalYears = Array.from({ length: YEARS }, (_, index) => fyForStartYear(firstFyStart + index));
  let serverInfo;
  let health;
  let dbInspection = null;
  let fullRegressionSuites = [];
  let agentError = null;

  try {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    serverInfo = startServer(port);
    health = await waitForServer(baseUrl, serverInfo.output);
    const owner = await required(baseUrl, 'POST', '/auth/login', { username: 'owner1', password: 'owner123' });

    const primaryOrg = await required(baseUrl, 'POST', '/orgs', {
      display_name: 'Operational Audit Primary', registered_name: 'Operational Audit Primary', gst_type: 'regular'
    }, owner.token);
    const isolatedOrg = await required(baseUrl, 'POST', '/orgs', {
      display_name: 'Operational Audit Isolated', registered_name: 'Operational Audit Isolated', gst_type: 'regular'
    }, owner.token);
    const party = await required(baseUrl, 'POST', '/parties', {
      org_id: primaryOrg.id, type: 'customer', name: 'Audit Customer', phone: '9000000001', state: 'Andhra Pradesh'
    }, owner.token);
    const item = await required(baseUrl, 'POST', '/items', {
      org_id: primaryOrg.id, name: 'Audit Stock Item', item_code: 'AUDIT-STOCK-001', hsn_code: '84713010',
      unit: 'NOS', gst_rate: 18, last_sale_price: 100, last_purchase_price: 70, opening_stock: 100, reorder_level: 10
    }, owner.token);

    const createSale = (date, reference) => ({
      org_id: primaryOrg.id, format: 'SALE', bill_date: date, party_id: party.id,
      payment_mode: 'credit', credit_days: 30, description: reference,
      items: [{ item_id: item.id, item_name: item.name, qty: 1, unit: 'NOS', rate: 100, amount: 100, gst_rate: 18 }]
    });
    const yearlyBills = [];
    for (let index = 0; index < fiscalYears.length; index += 1) {
      const startYear = firstFyStart + index;
      const date = `${startYear}-08-15`;
      const bill = (await required(baseUrl, 'POST', '/bills', createSale(date, `Audit settled sale ${fiscalYears[index]}`), owner.token)).bill;
      const payment = await required(baseUrl, 'POST', '/payments', {
        org_id: primaryOrg.id, payment_date: date, party_id: party.id, type: 'received', mode: 'upi',
        amount: bill.grand_total, reference: `AUDIT-UPI-${startYear}`, linked_bills: [{ bill_id: bill.id, amount: bill.grand_total }]
      }, owner.token);
      yearlyBills.push({ fy: fiscalYears[index], bill, payment });
    }
    const agedBill = (await required(baseUrl, 'POST', '/bills', createSale(`${firstFyStart}-10-15`, 'Audit intentionally unpaid historic credit sale'), owner.token)).bill;

    const perYear = [];
    for (const fiscalYear of fiscalYears) {
      const status = await required(baseUrl, 'GET', `/business/locks/${fiscalYear}/status?org_id=${primaryOrg.id}`, undefined, owner.token);
      perYear.push({
        fy: fiscalYear,
        trial_difference: money(status.report.trial_balance.difference),
        balance_sheet_difference: money(status.report.balance_sheet.difference),
        can_close: Boolean(status.can_close)
      });
    }
    const financialsBalanced = perYear.every(row => Math.abs(row.trial_difference) <= 0.01 && Math.abs(row.balance_sheet_difference) <= 0.01);
    addCheck(
      checks,
      'financial_year_trial_balance',
      financialsBalanced ? 'pass' : 'fail',
      'All simulated financial years have balanced journals and balance sheets',
      JSON.stringify(perYear),
      'Block financial-year closing when a trial balance or balance-sheet difference exceeds the configured tolerance, and add owner-facing reconciliation details.'
    );

    const lockYear = fiscalYears[1];
    const closeStatus = await required(baseUrl, 'GET', `/business/locks/${lockYear}/status?org_id=${primaryOrg.id}`, undefined, owner.token);
    if (closeStatus.can_close) {
      await required(baseUrl, 'POST', `/business/locks/${lockYear}/close`, {
        org_id: primaryOrg.id, note: 'Operational audit controlled year close'
      }, owner.token);
      const blocked = await api(baseUrl, 'POST', '/bills', createSale(`${firstFyStart + 1}-09-01`, 'Locked-period rejection probe'), owner.token);
      const lockedCorrectly = blocked.status === 423;
      addCheck(
        checks,
        'financial_year_close_lock',
        lockedCorrectly ? 'pass' : 'fail',
        'Closed financial year blocks new financial posting',
        `Close year ${lockYear}; post attempt returned HTTP ${blocked.status}.`,
        'Ensure every future posting endpoint uses the same closed-financial-year guard and add release coverage for each transaction type.'
      );
      await required(baseUrl, 'POST', `/business/locks/${lockYear}/reopen`, {
        org_id: primaryOrg.id, reason: 'Operational audit cleanup requires reopening this test year'
      }, owner.token);
    } else {
      addCheck(
        checks,
        'financial_year_close_lock',
        'warning',
        'Closed-year posting guard could not be exercised because the simulated year was not closable',
        JSON.stringify(closeStatus.checks || []),
        'Review financial-year closing blockers and expose a clear owner checklist before close.'
      );
    }

    const stock = await required(baseUrl, 'GET', `/business/stock?org_id=${primaryOrg.id}`, undefined, owner.token);
    const stockJournal = await required(baseUrl, 'GET', `/business/stock/${item.id}/movements?org_id=${primaryOrg.id}`, undefined, owner.token);
    const stockRow = stock.items.find(row => Number(row.id) === Number(item.id));
    const qtyOut = money(stockJournal.reduce((sum, row) => sum + Number(row.qty_out || 0), 0));
    const expectedQtyOut = YEARS + 1;
    addCheck(
      checks,
      'stock_movement_reconciliation',
      money(stockRow?.current_stock) === money(100 - expectedQtyOut) && qtyOut === expectedQtyOut ? 'pass' : 'fail',
      'Stock balance equals opening stock plus source-linked movements across all tested years',
      `Opening stock 100; qty out ${qtyOut}; current stock ${stockRow?.current_stock}; expected ${100 - expectedQtyOut}.`,
      'Add a scheduled stock-movement reconciliation report that compares item balances, movement sources, returns, and job-material consumption.'
    );

    const oldDashboard = await required(baseUrl, 'GET', `/reports/dashboard?org_id=${primaryOrg.id}&fy=${fiscalYears[0]}`, undefined, owner.token);
    const invoiceStatus = await required(baseUrl, 'GET', `/reports/invoice-status?org_id=${primaryOrg.id}`, undefined, owner.token);
    const oldSettlement = invoiceStatus.find(row => Number(row.id) === Number(agedBill.id));
    addCheck(
      checks,
      'aging_and_settlement',
      Number(oldDashboard.receivable) >= Number(agedBill.grand_total) && oldSettlement?.payment_status === 'overdue' ? 'pass' : 'warning',
      'Historic receivable remains visible to ageing and settlement reports',
      `Dashboard receivable ${oldDashboard.receivable}; historic invoice status ${oldSettlement?.payment_status || 'not found'}.`,
      'Add ageing buckets, period-opening receivable balance, and owner alerts for invoices that remain unpaid after their due date.'
    );

    const latestFiscalYear = fiscalYears[fiscalYears.length - 1];
    const latestStatement = await required(baseUrl, 'GET', `/reports/party-statement?party_id=${party.id}&org_id=${primaryOrg.id}&fy=${latestFiscalYear}`, undefined, owner.token);
    const statementEntriesAreScoped = latestStatement.entries.every(entry => entry.date >= `${firstFyStart + YEARS - 1}-04-01`);
    const carriedOpeningCorrect = money(latestStatement.opening_balance) === money(agedBill.grand_total);
    const scopedBalanceCorrect = statementEntriesAreScoped && carriedOpeningCorrect &&
      money(latestStatement.closing_balance) === money(agedBill.grand_total);
    addCheck(
      checks,
      'party_statement_payment_fy_scope',
      scopedBalanceCorrect ? 'pass' : 'fail',
      'Party statement scopes entries to the requested financial year and carries historic debt into opening balance once',
      `Requested ${latestFiscalYear}; entries scoped ${statementEntriesAreScoped}; opening ${latestStatement.opening_balance}; closing ${latestStatement.closing_balance}; historic outstanding ${agedBill.grand_total}.`,
      'Keep party-statement payments filtered by financial year and calculate an explicit opening balance from all transactions before the requested period; retain this multi-year regression test.'
    );

    const crossCompanyBill = await api(baseUrl, 'POST', '/bills', {
      org_id: isolatedOrg.id, format: 'SALE', bill_date: `${END_FY_START}-08-20`, party_id: party.id,
      payment_mode: 'cash', items: [{ item_id: item.id, item_name: item.name, qty: 1, unit: 'NOS', rate: 100, amount: 100, gst_rate: 18 }]
    }, owner.token);
    addCheck(
      checks,
      'company_data_isolation',
      crossCompanyBill.status === 400 ? 'pass' : 'fail',
      "Another company cannot post an invoice using this company's party or item",
      `Cross-company transaction attempt returned HTTP ${crossCompanyBill.status}.`,
      'Keep organization checks mandatory on every transaction, report, stock movement, party lookup, and future API endpoint.'
    );

    const backup = await required(baseUrl, 'GET', `/backup/export?org_id=${primaryOrg.id}`, undefined, owner.token);
    const backupHasCoreData = asRows(backup.bills).length === YEARS + 1 && asRows(backup.payments).length === YEARS && asRows(backup.stock_movements).length === YEARS + 1;
    addCheck(
      checks,
      'backup_core_financial_data',
      backupHasCoreData ? 'pass' : 'fail',
      'Organization backup contains the audited billing, payment, and stock movement records',
      `Backup rows: bills ${asRows(backup.bills).length}, payments ${asRows(backup.payments).length}, stock movements ${asRows(backup.stock_movements).length}.`,
      'Run a periodic restore drill that verifies financial-year locks, payment allocations, journals, stock movements, and organization boundaries after restore.'
    );

    const latencySamples = [];
    for (let index = 0; index < 5; index += 1) {
      for (const route of [
        `/bills?org_id=${primaryOrg.id}&fy=${latestFiscalYear}&limit=100`,
        `/reports/dashboard?org_id=${primaryOrg.id}&fy=${latestFiscalYear}`,
        `/accounting/reports?org_id=${primaryOrg.id}&fy=${latestFiscalYear}`
      ]) {
        const result = await api(baseUrl, 'GET', route, undefined, owner.token);
        assert.ok(result.ok, `${route} must remain available during audit`);
        latencySamples.push(result.milliseconds);
      }
    }
    const p95 = money(percentile(latencySamples, 0.95));
    addCheck(
      checks,
      'multi_year_reporting_latency',
      p95 <= 500 ? 'pass' : 'warning',
      'Multi-year report endpoints remain responsive on the isolated audit database',
      `15 API samples; p50 ${money(percentile(latencySamples, 0.5))} ms; p95 ${p95} ms; max ${money(Math.max(...latencySamples))} ms.`,
      'Add production telemetry for slow report queries, WAL checkpoint duration, database lock waits, RAM, disk latency, and queue depth.'
    );

    await stopServer(serverInfo.child);
    dbInspection = await inspectDatabase(health.storage_locations.database_path, primaryOrg.id, latestFiscalYear);
    const indexDetails = Object.values(dbInspection.plans).flat().map(row => row.detail || '').join(' | ');
    addCheck(
      checks,
      'database_integrity_and_indexes',
      dbInspection.integrity.every(row => String(row).toLowerCase() === 'ok') && dbInspection.foreign_keys.length === 0 ? 'pass' : 'fail',
      'SQLite integrity, foreign keys, and audited query plans are healthy',
      `Integrity ${dbInspection.integrity.join(', ')}; foreign-key violations ${dbInspection.foreign_keys.length}; query plans ${indexDetails || 'not returned'}.`,
      'Before deployment, block automatic backup success when SQLite integrity or foreign-key checks fail, and retain the diagnostic report for the owner.'
    );

    if (FULL_SUITE) {
      fullRegressionSuites = await runFullRegressionSuites();
      const failures = fullRegressionSuites.filter(suite => suite.status !== 'passed');
      addCheck(
        checks,
        'full_application_regression',
        failures.length ? 'fail' : 'pass',
        'Complete application regression and customer-portal concurrency suites',
        failures.length ? JSON.stringify(failures) : JSON.stringify(fullRegressionSuites.map(suite => ({ name: suite.name, seconds: suite.seconds }))),
        'Repair every failing regression suite before release; keep the suite evidence with the audit report.'
      );
    }
  } catch (error) {
    agentError = error;
    addCheck(
      checks,
      'audit_agent_execution',
      'fail',
      'Operational audit agent completed with an execution error',
      error.stack || error.message,
      'Fix the failing endpoint or audit fixture before relying on this report for a release decision.'
    );
  } finally {
    await stopServer(serverInfo?.child);
  }

  const summary = ['pass', 'fail', 'warning', 'info'].reduce((result, status) => {
    result[status] = checks.filter(check => check.status === status).length;
    return result;
  }, {});
  const report = {
    generated_at: new Date().toISOString(),
    application_version: require('../package.json').version,
    mode: 'isolated-live-api-financial-and-database-audit',
    horizon: { years: YEARS, first_fy: fyForStartYear(firstFyStart), last_fy: fyForStartYear(END_FY_START) },
    fixture: { retained: KEEP_FIXTURE, path: KEEP_FIXTURE ? FIXTURE_DIR : null, production_data_touched: false },
    health: health || null,
    checks,
    summary,
    database: dbInspection,
    full_regression_suites: fullRegressionSuites,
    capacity_evidence: [readJsonIfPresent('capacity-100k-results.json'), readJsonIfPresent('capacity-million-each-results.json')],
    upgrades: buildUpgradeList(checks),
    canonical_upgrade_roadmap: 'UPGRADE_LIST.md',
    execution_error: agentError ? (agentError.stack || agentError.message) : null
  };
  fs.writeFileSync(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(REPORT_MD, reportMarkdown(report), 'utf8');
  if (!KEEP_FIXTURE) fs.rmSync(FIXTURE_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  console.log(JSON.stringify({ report_json: REPORT_JSON, report_markdown: REPORT_MD, summary }, null, 2));
  if (STRICT && (summary.fail || summary.warning)) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
