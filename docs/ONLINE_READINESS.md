# Online Readiness Baseline

This merged Tarangini build is now prepared so the future Android app, website and current desktop/PWA can use the same server foundation.

## What Is Ready Now

- Single API surface for billing, job intake, job workflow and customer portal.
- HTTPS-capable server startup with host validation and restricted admin operations.
- Customer intake retry protection through `X-Idempotency-Key` or `client_request_id`.
- Configurable request-body, upload and rate-limit settings through environment variables.
- Health and diagnostics endpoints now expose the live deployment profile.
- Attachment persistence now supports `inline-db` and `filesystem` modes.
- Attachment analysis now supports `sync` and `async` modes.
- Async attachment analysis is backed by a persistent SQLite queue, startup recovery and owner diagnostics.

## Current Default Baseline

- `TARANGINI_DEPLOYMENT_PROFILE=lan`
- `TARANGINI_TARGET_CONCURRENT_CUSTOMERS=200`
- `TARANGINI_REQUEST_BODY_LIMIT_MB=50`
- `TARANGINI_CUSTOMER_UPLOAD_LIMIT_MB=15`
- `TARANGINI_STAFF_UPLOAD_LIMIT_MB=10`
- `TARANGINI_AUTH_RATE_LIMIT_MAX=10`
- `TARANGINI_CUSTOMER_PORTAL_RATE_LIMIT_MAX=180`
- `TARANGINI_ATTACHMENT_STORAGE_MODE=inline-db`
- `TARANGINI_ATTACHMENT_ANALYSIS_MODE=sync`

## Profile Direction

- `lan`: safest compatibility profile for local/intranet use
- `store`: filesystem-backed attachments and async analysis for shared Wi-Fi customer traffic
- `public`: filesystem-backed attachments, async analysis and higher throughput defaults for secure internet deployment

## Recommended Public-Internet Direction

1. Keep the current API contracts stable for Android app, website and owner/operator dashboards.
2. Use `filesystem` storage or move onward to object storage before high public upload volume.
3. Put the server behind HTTPS with a reverse proxy and controlled origin allowlist.
4. Increase customer portal rate limits only after proxy, TLS and bandwidth are verified.
5. Keep customer retry calls idempotent for submit, approval and payment-linked flows.
6. Keep asynchronous analysis for heavier upload paths; the current local worker uses a durable database queue, and very high public traffic can later move the same queue contract to a separate worker process.

## Why This Matters

- Mobile networks retry requests.
- Customer uploads can be large.
- Shared Wi-Fi or carrier NAT can make per-IP rate limits more sensitive.
- Android app and website launches should not require a full backend rewrite later.
