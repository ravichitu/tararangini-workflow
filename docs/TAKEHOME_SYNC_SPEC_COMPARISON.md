# Take-Home Sync Specification Comparison

Date: 2026-07-17
Status: Comparison and planning only. No code, schema, installer, or database changes were made.

## Executive Summary

The uploaded take-home specification is useful and addresses the important business need of preparing work away from the store. It is a larger architecture than the current LAN client offline queue.

The current product is a **controlled offline queue and cache**. The uploaded design proposes a **full local replica with bidirectional synchronization**. These must not be described as the same feature.

Recommended decision: approve the uploaded design as a future Priority 1/0 reliability upgrade, but implement it in phases. Keep one Main System as the accounting authority. Do not enable unrestricted offline final invoices, receipts, stock changes, or completed-job financial posting until versioning, whitelist, conflict resolution, numbering, audit, backup, and restore controls are complete.

## Comparison

| Capability | Current source | Take-home specification | Result |
| --- | --- | --- | --- |
| Local data | Encrypted JSON queue/cache through `electron/offline-proxy.js`; cached organizations, users, catalogues and selected records. | Full company SQLite replica including customers, jobs and price lists. | **Missing.** A full replica is not implemented. |
| Offline jobs | Offline job creation, local customer details, provisional job token and later synchronization are supported. | All job updates, production stages, notes, completion and conversion to invoice. | **Partial.** Creation and selected updates exist; full lifecycle replication is not proven. |
| Offline accounting | Current code can queue several document formats, including sale-like formats in the offline proxy and integration tests, but the recorded safety policy says final accounting must remain Main-System controlled. | Draft invoices/purchases/receipts offline; official numbers assigned at sync. | **Needs decision and correction.** The implementation/tests and the approved safety policy must be reconciled before production use. |
| Numbering | Device-scoped provisional numbers and server duplicate checks exist. | Draft/temporary number locally, serialized official number assignment at Main System sync. | **Partial.** Official-number assignment needs a formal transaction/sequence test for concurrent devices. |
| Idempotency | Offline IDs and unique indexes exist for bills/jobs; customer intake has retry keys. | UUID change records in a durable outbox. | **Partial.** Entity coverage and replay receipts need to be expanded. |
| Conflict detection | Some sync conflicts are returned and locked for review. | Every entity has a version and base-version comparison; no automatic merge. | **Missing for full replica.** No universal version bump contract or owner resolution UI exists. |
| Device security | Stable device ID, device code, system name and MAC references exist; cached tokens/data use Windows `safeStorage` in Electron. | Owner-approved whitelist, hardware-bound identity, revocation checked on every sync. | **Partial.** Registration, revocation, and API enforcement are not yet implemented as specified. |
| Sync direction | Queue replay from client to Main System plus selected cache refresh. | Push outbox, then pull all Main System changes since a sync cursor. | **Partial.** Full bidirectional delta pull is not implemented. |
| Local database encryption | Queue/cache protection is encrypted by Electron `safeStorage`; it is not SQLCipher database encryption. | Full local SQLite copy encrypted at rest. | **Missing for full replica.** SQLCipher or an equivalent encrypted replica must be evaluated. |
| Office-only reconnect | Existing Main System discovery and LAN URL recovery are present. | Sync only after physical office LAN reconnect; no internet/VPN exposure. | **Mostly reusable.** Add an explicit LAN trust/registration check. |
| DSC | Existing DSC status/recording remains Main-System-side. | DSC remains Main-System-only and untouched. | **Compatible.** Do not copy token access or PIN data to take-home devices. |
| Backup/recovery | Main backups and local queue recovery are covered by existing plans/tests. | Snapshot restore, outbox recovery, cursor recovery and conflict recovery are required. | **Needs expansion.** Local replica and sync metadata need separate backup/restore tests. |

## Important Safety Findings

### 1. Full replica is a higher-risk data boundary

Taking the entire company database home exposes customer, accounting and job data if the device is lost. A full replica requires encryption at rest, Windows account protection, device revocation, audit logging, secure deletion on revoke, and a tested restore process. A normal JSON queue is not enough for this scope.

### 2. The current offline accounting behavior needs reconciliation

The current offline proxy contains permitted formats including `SALE`, and the integration test exercises an offline sale that later synchronizes. Separately, the recorded operating policy says final invoices, payments, stock posting and completed-job financial changes remain Main-System controlled.

Before enabling take-home accounting, choose one explicit policy:

- **Recommended:** offline invoices/purchases/receipts remain drafts only; Main System posts the official financial transaction after validation.
- **Higher risk:** allow offline financial drafts with strict draft state, no stock/ledger posting, owner review and serialized conversion at sync.
- **Not recommended yet:** unrestricted offline final posting.

### 3. Versioning must cover every write path

The specification is correct that conflict detection fails if even one Main System or client update does not increment a version. A central write service or transaction wrapper should enforce version increments for jobs, parties, items, quotations, invoices, purchases, receipts, payments, stock and job stages.

### 4. Device revocation must be enforced at the API

Hiding a device in the owner dashboard is insufficient. Every snapshot, push, pull, refresh and conflict-resolution request must verify the device ID, registration status, organization scope, user role, and current device credential. Revocation should also invalidate cached offline sessions and trigger a local wipe on the next check-in.

### 5. Official numbering must be server-owned

Temporary numbers can be generated locally, but official invoice, purchase, receipt and job numbers must be allocated in one Main-System transaction. The sync operation must be idempotent: retrying after a timeout must return the same official number and must not consume another number.

## Recommended Additive Architecture

Do not replace the current `bills`, `job_orders`, parties, stock or accounting tables. Add a synchronization layer:

```sql
registered_devices(device_id, org_id, device_name, assigned_user_id, status,
                   credential_hash, registered_at, revoked_at, last_sync_at)

sync_cursors(device_id, org_id, last_pulled_revision, last_pushed_at)

sync_outbox(change_id, device_id, org_id, entity_type, entity_id, operation,
            base_version, payload, created_by, created_at, status, error)

sync_conflicts(id, change_id, entity_type, entity_id, main_snapshot,
               incoming_snapshot, status, resolved_by, resolved_at, reason)

sync_replay(change_id, device_id, result_json, applied_at)
```

Existing business tables should receive a controlled `version` field only after all write paths are audited. Numbered documents should retain local draft identity separately from official number identity. The local replica should use an encrypted database or an encrypted application data volume; this decision must be tested on the supported Windows versions.

## Recommended Phases

1. **Registration and security:** owner approval, device whitelist, revoke, device credential, LAN-only checks, audit logs.
2. **Encrypted snapshot:** full company snapshot with organization scoping, checksum, schema version and restore validation.
3. **Read-only replica:** take-home search and viewing without offline writes; validate performance and privacy.
4. **Safe offline workflow:** job creation, notes, stage updates and customer intake with outbox and version checks.
5. **Draft accounting:** offline invoice/purchase/receipt drafts only; no ledger, stock or payment posting.
6. **Sync engine:** push/pull cursor, idempotent replay, official numbering, retry and owner conflict queue.
7. **Owner resolution:** keep Main, keep incoming, manual merge, audit reason, and safe re-sync.
8. **Production gate:** backup/restore, lost-device revocation, concurrent devices, power loss, corrupted queue, duplicate retry, financial-year boundary and full regression suite.

## Approval Required Before Implementation

- Confirm whether “full local copy” really includes all organizations or only the assigned organization.
- Confirm whether take-home users may create only drafts or may post final invoices/payments after owner review.
- Confirm supported Windows versions and whether SQLCipher/native encryption is acceptable for the installer.
- Confirm whether attachments are copied, metadata-only, or downloaded on demand; attachments can dominate storage and privacy risk.
- Confirm retention and secure-wipe rules when a device is revoked or returned.

## Final Recommendation

The uploaded architecture is valuable and should be added to the upgrade roadmap, but it should not be merged into the current queue as an “already complete” feature. The safest production model is an encrypted, organization-scoped take-home replica that permits jobs and drafts offline, assigns official numbers only on the Main System, and sends every conflict to owner review.
