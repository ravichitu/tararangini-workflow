const { get } = require('../db/db');

function partyForOrg(partyId, orgId, options = {}) {
  const id = Number(partyId);
  const organizationId = Number(orgId);
  if (!id || !organizationId) return null;
  const activeClause = options.includeInactive ? '' : ' AND p.active=1';
  return get(
    `SELECT p.* FROM parties p
     WHERE p.id=?${activeClause}
       AND (p.org_id=? OR p.shared=1 OR EXISTS (
         SELECT 1 FROM party_org_links pol WHERE pol.party_id=p.id AND pol.org_id=?
       ))`,
    [id, organizationId, organizationId]
  );
}

function partyBelongsToOrg(partyId, orgId) {
  return Boolean(partyForOrg(partyId, orgId));
}

module.exports = { partyForOrg, partyBelongsToOrg };
