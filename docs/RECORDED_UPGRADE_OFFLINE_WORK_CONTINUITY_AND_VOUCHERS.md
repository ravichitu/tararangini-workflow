# Recorded Upgrade: Offline Work Continuity And Vouchers

Date: 2026-07-18
Status: Recorded requirement only. No functional change was made in this step.

## User Requirement

When the Main System is offline, the client currently cannot perform the required work and cannot add vouchers. The requested future behavior is for an authorized client to continue useful operational work while disconnected, then synchronize safely when the Main System returns.

## Required Offline Scope

- Continue job preparation, customer intake, quotations, delivery challans, proformas, operator notes, production updates and daily work logs where the local data is available.
- Show a clear local/offline status and provisional identifier for every queued record.
- Preserve drafts and queued work across application and Windows restart.
- Synchronize once after authenticated reconnection without duplicate records.
- Show failed or conflicted records to the owner instead of silently discarding them.

## Voucher Requirement

Offline Payment Received and Payment Voucher creation is not enabled yet because vouchers immediately affect ledgers, payment allocations, financial-year controls and party balances. The future controlled voucher phase must define:

- Draft voucher versus posted voucher states.
- Device-scoped draft numbering and server-owned official numbering.
- Idempotency and retry behavior after a timeout.
- Excess receipt/advance handling and payment allocation conflicts.
- Financial-year lock behavior.
- Owner review, correction reason and audit trail.
- Duplicate prevention when the same payment is entered on another device.
- Reversal/correction behavior without deleting the original ledger history.
- Backup and restore of queued vouchers and sync metadata.

## Current Safe Decision

The client may continue permitted non-posting operational work offline. Final voucher posting remains Main-System controlled until the controlled offline voucher workflow passes accounting, conflict, recovery and full regression tests. This requirement is added to the upgrade roadmap; no installer build is implied.
