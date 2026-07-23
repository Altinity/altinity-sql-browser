# Spreadsheet layout

A linked spreadsheet contains three application-managed worksheets and any number of user-owned worksheets.

```text
SQL Browser             visible control/status worksheet
_Data · <name>          visible managed data worksheet
_ASB_STATE              hidden synchronization state
Analysis / Pivots / ... user-owned worksheets
```

Temporary refresh worksheets use names such as `_ASB_STAGING_<refresh-id>` and remain hidden.

## Control worksheet

Display source name, binding name, refresh mode, last successful refresh, row and column counts, current status, source revision, and actions:

- Refresh data
- Open source query
- Run full refresh
- View refresh history
- Unlink

The Refresh data action is an ordinary hyperlink to the ClickHouse-hosted SPA with an opaque binding ID in the fragment.

## Managed data worksheet

SQL Browser owns the complete used range. It writes values with RAW input semantics, freezes the header, applies stable type-oriented formats, and may create a basic filter.

Users should not sort, truncate, or edit the managed data worksheet. Analysis requiring sorting or formulas belongs in a separate worksheet.

The numeric `sheetId` and developer metadata are authoritative. Names are presentation only and may be changed by users.

## State worksheet

`_ASB_STATE` stores the committed row count, generation, schema and query hashes, last refresh ID, and append checkpoints. It is hidden and protected where possible, but all content is treated as untrusted input and validated before use.

## Copies and moves

Moving a spreadsheet does not break the binding because the spreadsheet ID remains stable. Copying creates a new spreadsheet ID and does not automatically clone the binding. A copied file with stale metadata must offer relink, metadata removal, or cancel.

## Preservation rule

Refresh operations must preserve stable managed sheet IDs. Never publish by deleting the old managed sheet and renaming staging, because formulas, charts, and pivots may reference the original sheet identity.
