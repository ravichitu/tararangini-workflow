const express = require('express');
const path = require('path');
const { get, all, run } = require('../db/db');
const { authMiddleware, requireOrgAccess } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const LOG_ROLES = new Set(['owner', 'counter', 'operator', 'senior_operator', 'engineer']);

function cleanText(value, limit = 1000) {
  return String(value || '').trim().slice(0, limit);
}

function validDate(value) {
  const date = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return !Number.isNaN(new Date(`${date}T00:00:00+05:30`).getTime());
}

function indiaDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function dayRange(workDate) {
  const start = new Date(`${workDate}T00:00:00+05:30`);
  const end = new Date(start.getTime() + 86400000);
  const sqlDate = value => value.toISOString().slice(0, 19).replace('T', ' ');
  return { start: sqlDate(start), end: sqlDate(end) };
}

function userCanAccessOrg(user, orgId) {
  if (user.org_access === 'all') return true;
  try {
    return JSON.parse(user.org_access || '[]').map(Number).includes(Number(orgId));
  } catch (_) {
    return false;
  }
}

function userForLog(req, res, orgId, requestedUserId) {
  if (!LOG_ROLES.has(req.user.role)) {
    res.status(403).json({ error: 'Daily operator log access is not available for this role' });
    return null;
  }
  const targetId = req.user.role === 'owner' && requestedUserId
    ? Number(requestedUserId)
    : Number(req.user.id);
  const user = get('SELECT id,name,username,role,active,org_access FROM users WHERE id=? AND active=1', [targetId]);
  if (!user || !LOG_ROLES.has(user.role)) {
    res.status(404).json({ error: 'Operator not found' });
    return null;
  }
  if (!userCanAccessOrg(user, orgId)) {
    res.status(404).json({ error: 'Operator not found for this company' });
    return null;
  }
  if (req.user.role !== 'owner' && Number(user.id) !== Number(req.user.id)) {
    res.status(403).json({ error: 'Operators can access only their own daily log' });
    return null;
  }
  if (!requireOrgAccess(req, res, orgId)) return null;
  return user;
}

function ensureLog(orgId, userId, workDate) {
  run(
    `INSERT OR IGNORE INTO operator_daily_logs (org_id,user_id,work_date)
     VALUES (?,?,?)`,
    [orgId, userId, workDate]
  );
  return get(
    'SELECT * FROM operator_daily_logs WHERE org_id=? AND user_id=? AND work_date=?',
    [orgId, userId, workDate]
  );
}

function parseNames(value) {
  let names = value;
  if (typeof value === 'string') {
    try { names = JSON.parse(value); } catch (_) { names = value.split(','); }
  }
  if (!Array.isArray(names)) return [];
  return [...new Set(names.map(name => path.basename(cleanText(name, 180))).filter(Boolean))].slice(0, 30);
}

function durationMinutes(startedAt, completedAt, supplied) {
  if (startedAt && completedAt) {
    const start = new Date(startedAt).getTime();
    const end = new Date(completedAt).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return Math.min(1440, Math.round((end - start) / 60000));
    }
  }
  return Math.max(0, Math.min(1440, Number(supplied || 0) || 0));
}

function autoActivity(orgId, userId, workDate) {
  const range = dayRange(workDate);
  const between = [range.start, range.end];
  const events = [];
  const push = event => events.push({ auto_generated: true, pending_work: '', file_names: [], ...event });

  all(
    `SELECT r.*,j.job_token,j.current_status
     FROM job_work_reports r JOIN job_orders j ON j.id=r.job_id
     WHERE j.org_id=? AND r.employee_id=? AND r.created_at>=? AND r.created_at<?`,
    [orgId, userId, ...between]
  ).forEach(row => push({
    source: 'work_report', source_id: row.id, event_time: row.created_at,
    job_id: row.job_id, job_token: row.job_token, entry_type: 'JOB_WORK',
    title: `${row.report_type || 'Progress'} report`, work_done: row.report_text,
    pending_work: Number(row.progress_percent || 0) < 100 ? `Progress ${Number(row.progress_percent || 0)}% | ${row.current_status}` : '',
    started_at: row.started_at, completed_at: row.completed_at,
    duration_minutes: durationMinutes(row.started_at, row.completed_at, 0)
  }));

  all(
    `SELECT e.*,j.job_token FROM job_status_events e JOIN job_orders j ON j.id=e.job_id
     WHERE j.org_id=? AND e.actor_user_id=? AND e.occurred_at>=? AND e.occurred_at<?`,
    [orgId, userId, ...between]
  ).forEach(row => push({
    source: 'status_event', source_id: row.id, event_time: row.occurred_at,
    job_id: row.job_id, job_token: row.job_token, entry_type: 'JOB_STATUS', title: 'Job status updated',
    work_done: `${row.from_status || 'NEW'} -> ${row.to_status}${row.reason ? ` | ${row.reason}` : ''}`
  }));

  all(
    `SELECT a.*,j.job_token FROM job_assignments a JOIN job_orders j ON j.id=a.job_id
     WHERE j.org_id=? AND a.employee_id=?
       AND COALESCE(a.accepted_at,a.declined_at,a.assigned_at)>=?
       AND COALESCE(a.accepted_at,a.declined_at,a.assigned_at)<?`,
    [orgId, userId, ...between]
  ).forEach(row => push({
    source: 'assignment', source_id: row.id,
    event_time: row.accepted_at || row.declined_at || row.assigned_at,
    job_id: row.job_id, job_token: row.job_token, entry_type: 'ASSIGNMENT', title: `Assignment ${row.status}`,
    work_done: [row.handoff_reason, row.instructions, row.decline_reason].filter(Boolean).join(' | ') || row.handoff_type
  }));

  all(
    `SELECT m.*,j.job_token FROM job_material_consumptions m JOIN job_orders j ON j.id=m.job_id
     WHERE j.org_id=? AND m.consumed_by=? AND m.created_at>=? AND m.created_at<?`,
    [orgId, userId, ...between]
  ).forEach(row => push({
    source: 'material', source_id: row.id, event_time: row.created_at,
    job_id: row.job_id, job_token: row.job_token, entry_type: 'MATERIAL', title: 'Material consumed',
    work_done: `${row.quantity} ${row.unit} ${row.item_name_snapshot}${row.notes ? ` | ${row.notes}` : ''}`
  }));

  all(
    `SELECT a.*,j.job_token FROM job_additions a JOIN job_orders j ON j.id=a.job_id
     WHERE j.org_id=? AND a.proposed_by=? AND a.created_at>=? AND a.created_at<?`,
    [orgId, userId, ...between]
  ).forEach(row => push({
    source: 'addition', source_id: row.id, event_time: row.created_at,
    job_id: row.job_id, job_token: row.job_token, entry_type: 'ADDITIONAL_WORK', title: 'Additional work proposed',
    work_done: `${row.customer_description || row.internal_reason || 'Additional work'}${row.internal_reason ? ` | ${row.internal_reason}` : ''}`,
    pending_work: row.state && !['APPROVED', 'REJECTED'].includes(row.state) ? row.state : ''
  }));

  all(
    `SELECT a.*,j.job_token FROM job_attachments a JOIN job_orders j ON j.id=a.job_id
     WHERE j.org_id=? AND a.created_by=? AND a.created_at>=? AND a.created_at<?`,
    [orgId, userId, ...between]
  ).forEach(row => push({
    source: 'attachment', source_id: row.id, event_time: row.created_at,
    job_id: row.job_id, job_token: row.job_token, entry_type: 'FILE', title: 'File recorded',
    work_done: `${row.purpose || 'File'}: ${row.file_name}`, file_names: [row.file_name]
  }));

  all(
    `SELECT id,bill_number,format,party_snapshot,grand_total,created_at FROM bills
     WHERE org_id=? AND created_by=? AND deleted=0 AND created_at>=? AND created_at<?`,
    [orgId, userId, ...between]
  ).forEach(row => {
    let party = '';
    try { party = JSON.parse(row.party_snapshot || '{}').name || ''; } catch (_) {}
    push({
      source: 'bill', source_id: row.id, event_time: row.created_at,
      entry_type: 'BILL_CREATED', title: `${row.format} created`,
      work_done: `${row.bill_number}${party ? ` | ${party}` : ''} | ${Number(row.grand_total || 0).toFixed(2)}`
    });
  });

  all(
    `SELECT id,record_id,new_data,timestamp FROM audit_log
     WHERE org_id=? AND user_id=? AND table_name='bills' AND action IN ('EDIT','EMERGENCY_EDIT')
       AND timestamp>=? AND timestamp<?`,
    [orgId, userId, ...between]
  ).forEach(row => {
    let data = {};
    try { data = JSON.parse(row.new_data || '{}'); } catch (_) {}
    const bill = get('SELECT bill_number FROM bills WHERE id=?', [row.record_id]);
    push({
      source: 'bill_edit', source_id: row.id, event_time: row.timestamp,
      entry_type: 'BILL_EDITED', title: 'Bill edited',
      work_done: `${bill?.bill_number || `Bill ${row.record_id}`} | Reason: ${data.reason || 'Not recorded'}`
    });
  });

  return events.sort((a, b) => String(a.event_time).localeCompare(String(b.event_time)));
}

function projectLog(log, user, manualEntries, automaticEvents) {
  const entries = manualEntries.map(row => ({
    ...row,
    auto_generated: false,
    file_names: parseNames(row.file_names_json)
  }));
  const allEntries = [...automaticEvents, ...entries]
    .sort((a, b) => String(a.event_time || a.created_at).localeCompare(String(b.event_time || b.created_at)));
  return {
    log,
    user: { id: user.id, name: user.name, username: user.username, role: user.role },
    entries: allEntries,
    totals: {
      event_count: allEntries.length,
      manual_count: entries.length,
      file_count: allEntries.reduce((count, row) => count + (row.file_names || []).length, 0),
      duration_minutes: allEntries.reduce((sum, row) => sum + Number(row.duration_minutes || 0), 0),
      pending_count: allEntries.filter(row => cleanText(row.pending_work)).length,
      jobs_touched: new Set(allEntries.map(row => row.job_id).filter(Boolean)).size
    }
  };
}

router.get('/users', (req, res) => {
  const orgId = Number(req.query.org_id || 0);
  if (!orgId || !requireOrgAccess(req, res, orgId)) return;
  if (req.user.role !== 'owner') return res.json([{ id: req.user.id, name: req.user.name, username: req.user.username, role: req.user.role }]);
  const staff = all(
    `SELECT id,name,username,role,org_access FROM users
     WHERE active=1 AND role IN ('counter','operator','senior_operator','engineer') ORDER BY name`
  ).filter(user => userCanAccessOrg(user, orgId)).map(({ org_access, ...user }) => user);
  res.json([
    { id: req.user.id, name: `${req.user.name} (My Owner Log)`, username: req.user.username, role: req.user.role },
    ...staff
  ]);
});

router.get('/summary', (req, res) => {
  const orgId = Number(req.query.org_id || 0);
  const workDate = String(req.query.date || indiaDate());
  if (!orgId || !validDate(workDate) || !requireOrgAccess(req, res, orgId)) return;
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  const users = all(
    `SELECT id,name,username,role,org_access FROM users
     WHERE active=1 AND role IN ('counter','operator','senior_operator','engineer') ORDER BY name`
  ).filter(user => userCanAccessOrg(user, orgId));
  res.json(users.map(user => {
    const log = get('SELECT * FROM operator_daily_logs WHERE org_id=? AND user_id=? AND work_date=?', [orgId, user.id, workDate]);
    const automaticEvents = autoActivity(orgId, user.id, workDate);
    const manualCount = log ? get('SELECT COUNT(*) count FROM operator_log_entries WHERE daily_log_id=?', [log.id])?.count || 0 : 0;
    return { ...user, log_id: log?.id || null, status: log?.status || 'NOT_STARTED', submitted_at: log?.submitted_at || null,
      review_status: log?.review_status || 'PENDING', event_count: automaticEvents.length + Number(manualCount) };
  }));
});

router.get('/', (req, res) => {
  const orgId = Number(req.query.org_id || 0);
  const workDate = String(req.query.date || indiaDate());
  if (!orgId || !validDate(workDate)) return res.status(400).json({ error: 'Valid company and work date are required' });
  const user = userForLog(req, res, orgId, req.query.user_id);
  if (!user) return;
  const log = ensureLog(orgId, user.id, workDate);
  const manualEntries = all('SELECT * FROM operator_log_entries WHERE daily_log_id=? ORDER BY created_at,id', [log.id]);
  res.json(projectLog(log, user, manualEntries, autoActivity(orgId, user.id, workDate)));
});

router.post('/entries', (req, res) => {
  const orgId = Number(req.body.org_id || 0);
  const workDate = String(req.body.work_date || indiaDate());
  if (!orgId || !validDate(workDate)) return res.status(400).json({ error: 'Valid company and work date are required' });
  const user = userForLog(req, res, orgId, req.body.user_id);
  if (!user) return;
  if (req.user.role === 'owner' && Number(user.id) !== Number(req.user.id)) {
    return res.status(403).json({ error: 'Owners may review operator logs but cannot enter work on an operator behalf' });
  }
  const log = ensureLog(orgId, user.id, workDate);
  if (!['DRAFT', 'RETURNED', 'REOPENED'].includes(log.status)) {
    return res.status(423).json({ error: 'Submitted daily logs are locked until the owner reopens them' });
  }
  const entryType = cleanText(req.body.entry_type || 'MISCELLANEOUS', 30).toUpperCase();
  const title = cleanText(req.body.title, 160);
  const workDone = cleanText(req.body.work_done, 2000);
  if (!title || !workDone) return res.status(400).json({ error: 'Work title and work done are required' });
  const files = parseNames(req.body.file_names);
  const startedAt = req.body.started_at || null;
  const completedAt = req.body.completed_at || null;
  const minutes = durationMinutes(startedAt, completedAt, req.body.duration_minutes);
  const result = run(
    `INSERT INTO operator_log_entries
     (daily_log_id,org_id,user_id,work_date,entry_type,title,work_done,pending_work,linked_job_id,
      started_at,completed_at,duration_minutes,file_names_json,notes,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [log.id, orgId, user.id, workDate, entryType, title, workDone, cleanText(req.body.pending_work, 1500),
      Number(req.body.linked_job_id || 0) || null, startedAt, completedAt, minutes, JSON.stringify(files),
      cleanText(req.body.notes, 1000), req.user.id]
  );
  run('UPDATE operator_daily_logs SET updated_at=datetime(\'now\') WHERE id=?', [log.id]);
  run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
    [req.user.id, orgId, 'OPERATOR_LOG_ENTRY', 'operator_log_entries', result.lastInsertRowid,
      JSON.stringify({ entry_type: entryType, title, work_date: workDate, file_names: files }), req.ip]);
  res.json({ success: true, id: result.lastInsertRowid });
});

router.post('/submit', (req, res) => {
  const orgId = Number(req.body.org_id || 0);
  const workDate = String(req.body.work_date || indiaDate());
  if (!orgId || !validDate(workDate)) return res.status(400).json({ error: 'Valid company and work date are required' });
  const user = userForLog(req, res, orgId, null);
  if (!user) return;
  const log = ensureLog(orgId, user.id, workDate);
  if (!['DRAFT', 'RETURNED', 'REOPENED'].includes(log.status)) {
    return res.status(409).json({ error: 'This daily report has already been submitted' });
  }
  const summary = cleanText(req.body.daily_summary, 2000);
  if (summary.length < 5) return res.status(400).json({ error: 'Daily summary of at least 5 characters is required' });
  const eventCount = autoActivity(orgId, user.id, workDate).length +
    Number(get('SELECT COUNT(*) count FROM operator_log_entries WHERE daily_log_id=?', [log.id])?.count || 0);
  if (!eventCount) return res.status(400).json({ error: 'Record at least one work activity before submitting' });
  run(
    `UPDATE operator_daily_logs SET status='SUBMITTED',daily_summary=?,pending_summary=?,submitted_at=datetime('now'),
     review_status='PENDING',updated_at=datetime('now') WHERE id=?`,
    [summary, cleanText(req.body.pending_summary, 2000), log.id]
  );
  run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
    [req.user.id, orgId, 'OPERATOR_LOG_SUBMIT', 'operator_daily_logs', log.id,
      JSON.stringify({ work_date: workDate, event_count: eventCount }), req.ip]);
  res.json({ success: true, id: log.id, status: 'SUBMITTED' });
});

router.post('/:id/review', (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  const log = get('SELECT * FROM operator_daily_logs WHERE id=?', [req.params.id]);
  if (!log) return res.status(404).json({ error: 'Daily report not found' });
  if (!requireOrgAccess(req, res, log.org_id)) return;
  const decision = cleanText(req.body.decision, 20).toUpperCase();
  const note = cleanText(req.body.note, 1000);
  if (!['REVIEWED', 'RETURNED', 'REOPENED'].includes(decision)) return res.status(400).json({ error: 'Invalid review decision' });
  if (decision !== 'REVIEWED' && note.length < 5) return res.status(400).json({ error: 'A reason of at least 5 characters is required' });
  const status = decision === 'REVIEWED' ? 'SUBMITTED' : decision;
  run(
    `UPDATE operator_daily_logs SET status=?,review_status=?,reviewed_by=?,reviewed_at=datetime('now'),review_note=?,
     reopened_by=?,reopened_at=?,reopen_reason=?,updated_at=datetime('now') WHERE id=?`,
    [status, decision, req.user.id, note, decision === 'REOPENED' ? req.user.id : log.reopened_by,
      decision === 'REOPENED' ? new Date().toISOString() : log.reopened_at,
      decision === 'REOPENED' ? note : log.reopen_reason, log.id]
  );
  run('INSERT INTO audit_log (user_id,org_id,action,table_name,record_id,new_data,ip_address) VALUES (?,?,?,?,?,?,?)',
    [req.user.id, log.org_id, `OPERATOR_LOG_${decision}`, 'operator_daily_logs', log.id, JSON.stringify({ note }), req.ip]);
  res.json({ success: true, status, review_status: decision });
});

module.exports = router;
