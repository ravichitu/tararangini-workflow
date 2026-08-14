# DSC Integration v1.1

Status: Included as readiness/status integration. Third-party PDF signing tools are not part of this workflow.

## What v1.1 Includes

1. USB DSC token readiness check from Tarangini settings.
2. HyperPKI provider/certificate detection using local Windows tools.
3. Invoice DSC status fields:
   - `not_required`
   - `pending`
   - `signed_in_app`
4. Signed timestamp/user metadata fields for future in-app signing.
5. Backup, restore, invoice conversion and data-shift preservation of DSC status metadata.
6. Password/PIN safety rule: Tarangini must never store the DSC password/PIN.

## What v1.1 Does Not Include

1. No dependency on a third-party PDF signing application.
2. No automatic cryptographic PDF signing yet.
3. No DSC password/PIN capture inside Tarangini.

## What Is Required For Full In-App Signing

1. HyperPKI SDK, command-line signer, or provider bridge that can sign PDFs.
2. Secure token password/PIN prompt handled by HyperPKI/provider.
3. Server-side invoice PDF generation with a fixed signature rectangle.
4. Signed PDF output path and SHA-256 recording.
5. Certificate subject/thumbprint/serial audit logging.

## Renewal Rule

The DSC certificate/key normally changes during renewal, approximately every three years. Old invoices must keep the old certificate details. New invoices should use the newly activated certificate after renewal.
