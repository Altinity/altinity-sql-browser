# Google Sheets integration design catalog

Status: **Proposed**

This catalog is the source of truth for the Google Sheets integration in Altinity SQL Browser. GitHub issues define executable implementation slices and link back to these documents.

## Product boundary

The integration connects a saved ClickHouse query to a Google spreadsheet without adding an application backend.

```text
Google Sheet hyperlink
        ↓
ClickHouse-hosted SQL Browser SPA
        ↓
ClickHouse query execution
        ↓
Google Sheets API
```

SQL Browser owns query execution, typed parameters, schema validation, refresh orchestration, managed worksheet contents, and synchronization checkpoints. Google Sheets owns formulas, native pivots, charts, comments, sharing, and presentation sheets.

## Supported project scope

- One-time snapshot export.
- Create or attach a linked spreadsheet.
- Manual deep-link refresh.
- Failure-safe full refresh through staging.
- Large-result streaming and quota management.
- Append-only refresh for eligible ClickHouse 26.8+ MergeTree-family sources using `_block_number` and `_block_offset`.
- Refresh history, repair, and unlink workflows.

## Explicit non-goals

- Scheduled or background refresh.
- Refresh while SQL Browser is closed.
- `SELECT ... STREAM` integration.
- Updates or deletes in append mode.
- Google Docs integration.
- Apps Script or a dedicated application backend.
- Service-account impersonation.
- Strict distributed locking between spreadsheet collaborators.

## Documents

- [Product scope](product-scope.md)
- [Architecture and data flow](architecture.md)
- [Resource model](resource-model.md)
- [Authentication and authorization](authentication.md)
- [Spreadsheet layout](spreadsheet-layout.md)
- [Snapshot export](snapshot-export.md)
- [Full refresh](full-refresh.md)
- [Append refresh](append-refresh.md)
- [Large results and quotas](large-results.md)
- [Failure recovery](failure-recovery.md)
- [Sharing and security](sharing-security.md)
- [Deployment configuration](configuration.md)
- [Testing strategy](testing.md)
- [Architecture decisions](decisions.md)

## Interactive companion diagrams

- [Architecture](diagrams/architecture.html)
- [Refresh flow](diagrams/refresh-flow.html)
- [Append checkpoint](diagrams/append-checkpoint.html)

The Markdown documents and Mermaid diagrams are canonical. HTML diagrams are explanatory companions and must be updated in the same pull request when their corresponding design changes.

## Implementation tracking

The umbrella GitHub issue owns project sequencing. Child issues should contain only their implementation slice, acceptance criteria, dependencies, tests, and links to the relevant catalog sections. They must not duplicate the complete architecture.

## Change-management rule

Design precedence is:

```text
repository design catalog
        ↓
implementation issue
        ↓
pull request
```

A pull request that changes an agreed behavior must update the corresponding design document and, where appropriate, the decision log.
