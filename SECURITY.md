# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report privately through GitHub: **Security → Report a vulnerability** on this repository (private vulnerability reporting). Include what you found, how to reproduce it and the impact you expect.

We aim to acknowledge reports within 5 working days. The project is maintained by a solo developer, so please allow reasonable time for a fix before public disclosure.

## Scope

In scope: this repository's code, database migrations and Row Level Security policies, and the default deployment configuration.

Especially valuable: anything that lets one organization read or write another organization's data, bypasses role restrictions, exposes secrets or tokens to the browser, or tampers with the audit log.

## Known gaps

- Uploaded files are not scanned for malware. Uploads are limited to a fixed list of document and image types and 25 MB, are stored in a private bucket, and are only served as downloads through links that expire after a minute, but a harmful document can still be attached and downloaded. The app says so next to every file list.
- No release has been through an external penetration test.

## Supported versions

There are no releases yet. Until the first release only the `main` branch is supported.
