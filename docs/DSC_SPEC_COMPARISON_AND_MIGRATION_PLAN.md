# DSC Signing Spec Comparison And Migration Plan

Date: 2026-07-17
Status: Comparison and planning only. No DSC code, schema migration, package installation, or installer build was performed.

## Executive Decision

The uploaded `tarangini-dsc-signing-spec.md` is a sound target architecture, but it cannot be merged directly into the current application. The specification assumes a generic `documents` table and a real PKCS#11/PAdES signing pipeline; the current application uses separate transaction tables and currently records an external DSC signing status.

The safe approach is an additive, versioned signature layer. Existing bills, quotations, jobs, challans, organization settings, audit records, backups, and historical DSC fields must remain readable. No destructive removal of the existing DSC columns is approved.

## Current Source Findings

| Area | Current state | Spec target | Decision |
| --- | --- | --- | --- |
| Storage | `bills` contains `digital_signature_required`, note, status, signed time, and signed-by fields. `orgs` and `parties` also contain legacy signature fields. | Generic `documents.current_signature_version` and signature history. | Keep legacy fields for compatibility; add a normalized layer later. |
| Signing | `/api/advanced/dsc/status` detects external certificate/token tooling. Bill action records `signed_in_app` status after confirmation. | Main-process PKCS#11 signing of generated PDF bytes. | Treat current flow as legacy status recording, not cryptographic PAdES signing. |
| PDF | `pdf-lib` is present and is suitable for rendering a visible appearance. | PDF byte-range digest plus CMS/PKCS#7/PAdES embedding. | Add a proven signing library and adapter only after a real-token proof-of-concept. |
| PKCS#11 | `pkcs11js` is not present in `package.json` or the lockfile. | Generic vendor-library bridge with Electron ABI rebuild. | Not implemented. Vendor middleware DLL/path configuration is still required. |
| UI/RBAC | Active bill/settings/party controls and a bill mark-signed endpoint exist. | Renderer sends IPC only; main process owns token operations; server enforces role checks. | Rework behind a feature flag; never rely on hidden buttons for authorization. |
| Documents | No generic `documents` table was found. Bills, quotations and other transactions have separate models/routes. | One generic document identity. | Map existing records through a typed reference, rather than renaming or replacing tables. |
| Customer approvals | Existing customer/staff approval evidence includes a digital-signature option. | Uploaded spec covers document signing, not customer consent replacement. | Keep this separate from USB DSC and follow the previously recorded customer-consent decision. |

## Safe Target Data Model

Do not alter or delete existing transaction columns in the first migration. Add tables similar to the following, using the actual transaction IDs already present:

```sql
CREATE TABLE IF NOT EXISTS signature_documents (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL,
  document_type TEXT NOT NULL,
  document_id INTEGER NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0,
  current_status TEXT NOT NULL DEFAULT 'unsigned',
  source_pdf_sha256 TEXT,
  current_signed_file TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (org_id, document_type, document_id)
);

CREATE TABLE IF NOT EXISTS signature_history (
  id INTEGER PRIMARY KEY,
  signature_document_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL,
  reason TEXT,
  signer_name TEXT,
  signer_dn TEXT,
  certificate_serial TEXT,
  source_pdf_sha256 TEXT,
  signed_file TEXT,
  archived_file TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

The `document_type` values should be explicit, for example `bill`, `quotation`, `delivery_challan`, and `job`. A foreign-key-like application check must verify that `document_id` belongs to the stated organization and type before signing. Existing historical fields remain the compatibility view until migration and reconciliation are complete.

## Signing Flow To Implement Later

1. Generate the final PDF from the saved transaction and calculate its SHA-256 hash.
2. On the Main System only, enumerate configured PKCS#11 libraries and token slots.
3. Ask for the token PIN for this one signing operation; never store the PIN.
4. Build a CMS/PKCS#7 signature over the PDF byte range and embed it as a visible PAdES signature.
5. Store the signed PDF outside SQLite, with its hash, certificate identity, version, and audit row in SQLite.
6. Close/logout/finalize the PKCS#11 session in `finally` blocks, including failures.
7. Show clients current status only. Signature history and revoke reasons remain Owner/Senior Operator/Engineer-only.
8. Revoke by archiving the signed file and adding a history row. Replace by signing a new version. Never overwrite the prior signed artifact.

## Important Implementation Risks

- `pdf-lib` alone does not create a cryptographic PAdES signature.
- A raw `C_Sign` call is not the complete CMS/PAdES implementation. The adapter must create the correct signed attributes, certificate chain, byte ranges, and CMS envelope expected by PDF validators.
- `pkcs11js` does not make every token vendor-independent by itself. Each installation still needs the vendor's middleware and a configured PKCS#11 library path.
- Electron native-module ABI compatibility must be tested in the exact packaged Electron version; `electron-rebuild` is mandatory for a native binding.
- A real-token test must cover missing token, locked PIN, wrong PIN, multiple tokens, removed token, certificate expiry, session failure, and application restart.
- Existing external-signing status must not be presented as proof of a cryptographic signature after the new module is introduced.

## Required Approval Gates Before Coding

1. Confirm whether USB DSC signing is required for bills, quotations, challans, or all three.
2. Confirm the first target token vendor, middleware package, certificate algorithm, and PKCS#11 DLL path.
3. Approve the additive signature tables and filesystem archive policy.
4. Approve whether the existing customer approval method called `DIGITAL_SIGNATURE` is retained, renamed, or replaced; it is a separate consent feature.
5. Provide a test token/certificate or authorize a dummy signer phase before any production token is used.

## Verification Plan

- Unit tests for document identity, version increments, hash mismatch, RBAC, and idempotency.
- Dummy-signer PDF tests that validate the visible block and signature structure.
- Real-token lab tests on the Main System only.
- LAN client tests proving clients cannot access token operations or PIN data.
- Revoke, replace, archive, backup, restore, and multi-company tests.
- Regression tests proving old bills, quotations, backups, and the existing non-DSC transaction flows remain readable.

## Current Recommendation

Approve the uploaded document as the design baseline, but do not delete the current DSC schema or install native token dependencies yet. The next safe implementation phase is a feature-flagged signature abstraction plus dummy-signer tests; real PKCS#11 integration should begin only after the token vendor and middleware are confirmed.
