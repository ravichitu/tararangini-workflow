# Tarangini Release Test Report

- Generated: 2026-08-06T20:04:52.963Z
- Version: 1.1.23
- Mode: full-suite-plus-concurrency-smoke

## Concurrency Smoke

- Status: **passed**
- Requests: 200
- Successful: 200
- p50: 138.32 ms; p95: 182.33 ms; max: 185.19 ms
- Scope: Health-endpoint smoke only; not a full customer upload or invoice-write benchmark.

## Suite Results

- security: **passed** (10.9 s)
- security-hardening: **passed** (12.1 s)
- operator-log: **passed** (7.7 s)
- backup: **passed** (9.6 s)
- deployment: **passed** (7.7 s)
- attachments: **passed** (7.2 s)
- tax-inclusive: **passed** (6.1 s)
- device-identity: **passed** (2.7 s)
- new-features: **passed** (5.9 s)
- advanced-upgrades: **passed** (4.9 s)
- user-admin: **passed** (9.3 s)
- jobs: **passed** (9.5 s)
- offline-sync: **passed** (13.6 s)
- v2.3: **passed** (5.4 s)
- responsive-web: **passed** (22.8 s)
- responsive-ui: **passed** (94.4 s)

## Capacity Interpretation

Treat 200 as the configured target for customer sessions only after deployment uses HTTPS, sufficient RAM/SSD, controlled upload sizing, and a dedicated Main System. This smoke test does not certify 200 simultaneous heavy uploads or writes.

Record-volume evidence is included in the JSON report. It demonstrates database scale and query behavior, not the number of people who can simultaneously upload files or post transactions.
