# Sharing and security

## Sharing model

Anyone with access to the spreadsheet may see exported data according to Google sharing rules. Refreshing requires both:

- permission to resolve and execute the binding in ClickHouse;
- permission to edit the destination spreadsheet in Google.

Spreadsheet sharing never grants ClickHouse access, and ClickHouse access never grants spreadsheet access.

## Security boundary

ClickHouse remains the authoritative data-access boundary. Binding rows and refresh-history rows are protected through ClickHouse grants and row policies. SQL Browser does not implement application-managed ACLs or impersonation.

## Managed metadata

Developer metadata and hidden worksheets identify resources and store synchronization state, but are untrusted and non-secret. Validate binding ID, spreadsheet ID, numeric sheet IDs, table UUID, query and schema hashes, generations, row counts, and cursor values before use.

## Formula and content safety

Write data through RAW value input. Strings beginning with `=`, `+`, `-`, or `@` remain data rather than formulas. Enforce per-cell length and total-byte limits, and normalize unsupported values deterministically.

## URL and logging safety

Refresh URLs contain only opaque binding IDs. Do not include SQL, parameters, spreadsheet IDs, tokens, or credentials in fragments, query strings, analytics, console logs, or error reports.

Spreadsheet IDs may be considered sensitive operational metadata and should be redacted from routine telemetry.

## Content Security Policy

Google Identity and Picker resources are loaded only when the integration is invoked. Deployment documentation must list required script, frame, connect, and popup allowances without weakening unrelated CSP protections.

## Unlinking

Unlink disables future refresh while preserving exported data by default. Removing managed worksheets is a separate explicit action. SQL Browser does not delete the entire Google spreadsheet in V1.
