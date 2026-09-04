# Security Policy

## Data that must never enter Git

Do not commit databases, backups, attachments, API keys, JWT secrets, encryption keys, PFX/P12 certificates, passwords, customer exports, screenshots with real data, or installers.

The repository `.gitignore` blocks common runtime paths and secret files. Before every release, run the repository safety scan documented in `docs/GITHUB_SOURCE_AND_UPDATES.md`.

## Reporting

If a credential, database, or customer file is discovered in Git history, immediately stop release publishing, rotate the affected credential, remove public access if possible, and create a sanitized replacement repository. Do not attempt to repair the issue by only adding a new `.gitignore` rule.
