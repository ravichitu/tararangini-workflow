const crypto = require('crypto');

const { all, run } = require('../db/db');
const { ATTACHMENT_RETENTION_DAYS } = require('../config/deployment-profile');
const { deleteStoredAttachmentBytes } = require('./attachment-storage');

let timer = null;

function retentionModifier() {
  return `+${ATTACHMENT_RETENTION_DAYS} days`;
}

function scheduleJobAttachmentCleanup(jobId) {
  const deleteAfterSql = ATTACHMENT_RETENTION_DAYS === 0
    ? "datetime('now')"
    : "datetime('now', ?)";
  const params = ATTACHMENT_RETENTION_DAYS === 0
    ? [jobId]
    : [retentionModifier(), jobId];
  run(
    `UPDATE job_attachments
     SET retention_policy='AUTO_DELETE',
         retention_delete_after=COALESCE(retention_delete_after, ${deleteAfterSql})
     WHERE job_id=?
       AND retention_state='ACTIVE'
       AND COALESCE(retention_policy,'AUTO_DELETE')!='ARCHIVE'`,
    params
  );
}

function purgeExpiredAttachments({ actorUserId = null, reason = 'RETENTION_EXPIRED' } = {}) {
  const expired = all(
    `SELECT a.*,j.org_id
     FROM job_attachments a
     JOIN job_orders j ON j.id=a.job_id
     WHERE a.retention_state='ACTIVE'
       AND COALESCE(a.retention_policy,'AUTO_DELETE')!='ARCHIVE'
       AND a.retention_delete_after IS NOT NULL
       AND a.retention_delete_after<=datetime('now')
     ORDER BY a.retention_delete_after,a.id`
  );
  let deleted = 0;
  const errors = [];
  for (const attachment of expired) {
    try {
      deleteStoredAttachmentBytes(attachment);
      run(
        `UPDATE job_attachments
         SET storage_path=NULL,
             content_base64=NULL,
             retention_state='DELETED',
             physical_deleted_at=datetime('now'),
             physical_deleted_by=?,
             physical_delete_reason=?
         WHERE id=?`,
        [actorUserId, reason, attachment.id]
      );
      run(
        `INSERT INTO job_audit_events
         (job_id,org_id,entity_type,entity_id,action,actor_user_id,actor_role,reason,old_data,new_data,operation_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          attachment.job_id,
          attachment.org_id,
          'ATTACHMENT',
          attachment.id,
          'PHYSICAL_DELETE',
          actorUserId,
          actorUserId ? 'OWNER' : 'SYSTEM',
          reason,
          JSON.stringify({
            file_name: attachment.file_name,
            storage_path: attachment.storage_path ? '[removed]' : null,
            content_base64: attachment.content_base64 ? '[removed]' : null
          }),
          JSON.stringify({
            file_name: attachment.file_name,
            retention_state: 'DELETED',
            metadata_retained: true
          }),
          crypto.randomUUID()
        ]
      );
      deleted += 1;
    } catch (error) {
      errors.push({ id: attachment.id, file_name: attachment.file_name, error: error.message });
    }
  }
  return { scanned: expired.length, deleted, errors };
}

function startAttachmentRetentionWorker() {
  clearInterval(timer);
  const runOnce = () => {
    try { purgeExpiredAttachments(); } catch (_) {}
  };
  runOnce();
  timer = setInterval(runOnce, 60 * 60 * 1000);
}

module.exports = {
  scheduleJobAttachmentCleanup,
  purgeExpiredAttachments,
  startAttachmentRetentionWorker
};
