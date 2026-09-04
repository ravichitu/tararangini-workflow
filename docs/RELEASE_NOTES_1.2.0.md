# Tarangini Workflow Suite 1.2.0

## Bootstrap update release

This version introduces the verified web-update foundation. Install it manually on the Main System and client computers. Future signed releases can then be discovered from the Tarangini GitHub update feed.

## Included

- Verified web update checks at application startup and every six hours.
- Owner-visible web update status, deliberate download, and restart-to-install controls.
- No silent installer execution or automatic app replacement.
- Client install block while offline work is pending or conflicted.
- GitHub Actions verification and protected release workflow.
- Private source repository/public installer-feed separation.
- Runtime upload hardening: only JPG, PNG, WebP, and GIF content matching its declared type reaches the image metadata parser.
- Dependency audit remediation, including removal of the vulnerable image-size package.

## Important release condition

The locally built 1.2.0 bootstrap installer is not yet Authenticode signed. It must be installed manually and must not be uploaded to the public update feed. Configure the protected code-signing and update-feed GitHub secrets before publishing the first automatic update release, `v1.2.1` or later.
