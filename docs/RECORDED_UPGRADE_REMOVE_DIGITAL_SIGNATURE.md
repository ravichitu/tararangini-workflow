# Recorded Upgrade: Remove Digital Signature Features

Status: Recorded only. No functional implementation or installer build is included.

## Requested Change

Remove active Digital Signature / DSC functionality from all user-facing invoice, party, settings, preview, and customer-approval flows. The owner will define a replacement architecture with a senior advisor before implementation.

## Scope To Remove Later

- Invoice and quotation controls for USB DSC requirement, DSC note, signing status, and sign/record actions.
- DSC token status checks and signing bridge references in Settings and invoice preview.
- Party-level `Digital signature required` controls and DSC indicators.
- Digital-signature approval method for customer additional-work acceptance.
- Digital-signature wording in user manuals, help text, upgrade notes, and transaction control documentation.
- New transaction creation or editing must not create new digital-signature values.

## Data-Safety Boundary

- Do not delete existing database columns or historical values during removal.
- Do not remove digital-signature fields from backup import/export until a separate migration policy is approved.
- Existing historical records must remain readable, but the removed feature must not be offered for new use.
- No DSC installer, bridge, token, password, certificate, or signing workflow should be required after the approved removal implementation.

## Replacement Architecture Gate

Before implementation, confirm the replacement for:

- Invoice authorization and sign-off
- Customer additional-work consent
- Audit evidence and legal/operational approval
- Existing signed-invoice history and reporting

After approval, implement the replacement in a separate tested phase and run the complete regression suite before building an installer.
