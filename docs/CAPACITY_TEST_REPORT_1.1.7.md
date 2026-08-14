# Tarangini Workflow Suite Capacity Test Report

Date: 2026-07-16  
Build under test: Workflow Suite 1.1.6 source with offline-job cache revision 1.1.7  
Scope: Billing database volume and customer-portal upload concurrency

## Executive Result

The application passed the available local capacity tests, but these are not a replacement for a production pilot on the proposed server hardware.

- 10,000,000 synthetic transaction/journal rows: inserted successfully and database integrity passed.
- 300 simultaneous customer-portal uploads: 300/300 succeeded.
- The upload test used 64 KB PNG payloads per customer, 19.2 MB total. It proves concurrent request and attachment pipeline behavior, not 300 customers uploading hundreds of multi-megabyte photos.
- No installer was changed by this capacity test. Test databases and attachment directories were isolated and removed after each run.

## Billing Volume Test

The benchmark created 1,000,000 rows each in bills, payments, purchases, expenses, notes, purchase orders, bank rows, and journals, plus 2,000,000 journal lines.

| Measurement | Result |
|---|---:|
| Total rows | 10,000,000 |
| Database size | 1,974.45 MB |
| Total generation time | 357.83 seconds |
| Integrity check | Passed |
| Node RSS during generator | 135.31 MB |
| Exact invoice search | 0.13 ms |
| Invoice text search | 150.51 ms |
| Monthly sales report | 10,343.24 ms |
| Party-balance aggregation | 9,518.22 ms |
| Payment summary | 1,432.14 ms |
| Trial-balance input | 2,444.51 ms |

Interpretation: exact indexed lookups remain fast, while broad financial reports become slow at 1 crore rows. Production should use date/company indexes, paginated reports, cached summaries, and financial-year archival before the database reaches this size.

## Customer Portal Upload Test

The test used the `public` deployment profile: filesystem attachment storage, asynchronous attachment analysis, 20 MB customer upload limit, 75 MB request limit, and a 300-customer target.

| Measurement | Result |
|---|---:|
| Concurrent upload requests | 300 |
| Successful | 300 |
| Failed | 0 |
| Payload per upload | 64 KB |
| Total payload | 19.2 MB |
| Total elapsed time | 3.01 seconds |
| p50 latency | 1.75 seconds |
| p95 latency | 2.63 seconds |
| Maximum latency | 2.67 seconds |
| Process RSS increase | 88.16 MB |

The application deduplicated identical test bytes, so the measured attachment directory size is not a valid estimate for unique customer photos. Unique files consume approximately their original size plus filesystem and temporary-processing overhead.

## Hardware Recommendation

### Minimum controlled store deployment

- CPU: 6 modern physical cores, 3.0 GHz or better
- RAM: 16 GB
- Storage: 1 TB NVMe SSD for live database, logs, and active attachments
- Backup: separate 2 TB SSD/HDD, not the application disk
- Network: wired 1 Gbps LAN; stable internet upload for remote/public access
- OS: supported Windows 10/11 or a supported server Linux distribution; do not use the frozen Windows 7 installer

### Recommended for 10 clients and up to 300 portal customers/day

- CPU: 8 to 12 physical cores
- RAM: 32 GB
- Storage: 2 TB enterprise NVMe for live data and active attachments
- Backup: separate 4 TB disk or NAS with daily backup plus off-device copy
- Network: 1 Gbps wired LAN and at least 100 Mbps reliable internet upload for public portal use
- Run the Main System as a dedicated Windows service/server, not as an operator desktop

### Heavy photo day scenario

If 300 customers each upload 100 photos of 5 MB:

- Raw upload volume is about 150 GB for one day.
- Reserve at least 250 GB temporary/live working space for encoding, analysis, retries, and filesystem overhead.
- For one month of retention, plan at least 5 TB usable attachment storage before backups and growth.
- RAM should be 32 GB minimum; 64 GB is safer if many PDF/image analyses run concurrently.
- Use filesystem/object storage for attachments, not inline database storage, and keep the SQLite database on its own NVMe volume.

## Capacity Limitations

This report does not certify 300 simultaneous 5 MB uploads, 300 simultaneous PDF analyses, or 10 clients writing invoices continuously for a full day. It also does not certify internet-scale availability, failover, or recovery time. Those require a staged pilot with the actual hardware, unique files, HTTPS reverse proxy, backup restore drill, and monitoring.

Recommended next production gate: run a 24-hour pilot with 10 clients, unique 1-5 MB images/PDFs, normal billing transactions, and measured CPU, RAM, disk latency, database lock time, upload latency, queue depth, and backup duration.
