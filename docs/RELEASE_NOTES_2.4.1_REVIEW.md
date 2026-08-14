# Tarangini Billing 2.4.1 Review Notes

## Security hardening

- Browser and mobile sessions use an HttpOnly, SameSite=Strict session cookie.
- Web storage no longer retains bearer tokens outside the installed desktop client.
- Cookie-authenticated write requests reject cross-origin origins.
- Optional `TARANGINI_REQUIRE_HTTPS=1` blocks remote plain-HTTP access.
- HTTPS responses include HSTS and strengthened browser security headers.
- Public internet client addresses must use HTTPS.
- Packaged offline clients fail closed when Windows secure storage is unavailable.

## Backup protection

- Scheduled backups are AES-256-GCM encrypted `.tbe` files.
- Owner can download a separate automatic-backup recovery key.
- Owner can restore an encrypted automatic backup with the recovery key.

## Shift operations

- Open shifts support audited cash additions and cash removals.
- A positive amount and reason are required.
- Operators can adjust only their own open shifts; Owner retains oversight.

## Uninstall behavior

- Interactive uninstall asks whether to keep company data and preferences.
- Keeping data is the safe default.
- Permanent removal includes the database, preferences, offline cache, certificates and application-data backups.
