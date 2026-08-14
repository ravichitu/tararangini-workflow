const { get } = require('../db/db');

const CREDIT_SALE_FORMATS = ['SALE', 'PP'];

function creditPolicyForParty(orgId, partyId) {
  if (!partyId) return null;
  return get(
    `SELECT org_id,party_id,credit_limit,credit_days,on_hold,hold_reason,updated_at
     FROM party_credit_policies WHERE org_id=? AND party_id=?`,
    [Number(orgId), Number(partyId)]
  ) || null;
}

function partyCreditExposure(orgId, partyId, excludeBillId = null) {
  if (!partyId) return 0;
  const clauses = [
    'b.org_id=?',
    `b.format IN (${CREDIT_SALE_FORMATS.map(() => '?').join(',')})`,
    "b.payment_mode='credit'",
    'b.deleted=0',
    "b.status='saved'",
    'b.party_id=?'
  ];
  const params = [Number(orgId), ...CREDIT_SALE_FORMATS, Number(partyId)];
  if (excludeBillId) {
    clauses.push('b.id<>?');
    params.push(Number(excludeBillId));
  }
  const row = get(
    `SELECT COALESCE(SUM(b.grand_total-COALESCE(pa.paid,0)),0) outstanding
     FROM bills b
     LEFT JOIN (
       SELECT bill_id,SUM(amount) paid FROM payment_allocations GROUP BY bill_id
     ) pa ON pa.bill_id=b.id
     WHERE ${clauses.join(' AND ')}`,
    params
  );
  return Number(row?.outstanding || 0);
}

function creditPosition(orgId, partyId, excludeBillId = null) {
  const policy = creditPolicyForParty(orgId, partyId) || {
    org_id: Number(orgId), party_id: Number(partyId), credit_limit: 0,
    credit_days: 0, on_hold: 0, hold_reason: ''
  };
  return {
    ...policy,
    credit_limit: Number(policy.credit_limit || 0),
    credit_days: Number(policy.credit_days || 0),
    on_hold: Number(policy.on_hold || 0),
    outstanding: partyCreditExposure(orgId, partyId, excludeBillId)
  };
}

function enforceCreditPolicy({ orgId, partyId, format, paymentMode, grandTotal, excludeBillId = null }) {
  if (!partyId || !CREDIT_SALE_FORMATS.includes(String(format || '').toUpperCase()) || paymentMode !== 'credit') {
    return null;
  }
  const position = creditPosition(orgId, partyId, excludeBillId);
  if (position.on_hold) {
    const error = new Error(position.hold_reason || 'This party is on credit hold. Collect payment or remove the hold before creating a credit sale.');
    error.statusCode = 423;
    error.code = 'PARTY_CREDIT_HOLD';
    error.position = position;
    throw error;
  }
  const proposedExposure = Number(position.outstanding || 0) + Number(grandTotal || 0);
  if (position.credit_limit > 0 && proposedExposure > position.credit_limit + 0.01) {
    const error = new Error(`Credit limit exceeded. Current outstanding is ${position.outstanding.toFixed(2)} and the configured limit is ${position.credit_limit.toFixed(2)}.`);
    error.statusCode = 423;
    error.code = 'CREDIT_LIMIT_EXCEEDED';
    error.position = { ...position, proposed_exposure: proposedExposure };
    throw error;
  }
  return { ...position, proposed_exposure: proposedExposure };
}

module.exports = {
  CREDIT_SALE_FORMATS,
  creditPolicyForParty,
  partyCreditExposure,
  creditPosition,
  enforceCreditPolicy
};
