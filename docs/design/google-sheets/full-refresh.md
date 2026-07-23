# Full refresh

Full refresh replaces all managed rows while preserving the previous committed dataset until publication succeeds.

## Procedure

1. Resolve and authorize the binding.
2. Obtain Google authorization and verify spreadsheet edit access.
3. Validate spreadsheet, managed sheet IDs, metadata, query hash, parameters, limits, and schema policy.
4. Execute the pinned query against ClickHouse.
5. Stream converted rows into a hidden staging worksheet in byte-bounded chunks.
6. Verify row, column, cell, and byte counts.
7. Publish with one structural `spreadsheets.batchUpdate` that clears the managed range, copies staged cells into the stable managed sheet, clears stale trailing cells, applies formats and metadata, updates `_ASB_STATE`, and deletes staging.
8. Record refresh history and update the control worksheet.

## Publication invariant

The user observes either:

```text
old complete dataset
or
new complete dataset
```

Never expose a partially refreshed live managed sheet.

## Append reset

When the binding supports append mode, a successful full refresh captures and stores a compatible per-partition commit checkpoint. Append mode resumes only after this checkpoint is committed with the full result.

## Failure behavior

Before publication, every failure leaves the previous managed data and checkpoint unchanged. Orphan staging worksheets are discovered and removed on the next refresh. An ambiguous publication response is resolved by reading the committed generation and refresh ID before retrying.

Full refresh is never triggered silently as a fallback from append mode. The user must approve the potentially expensive replacement operation.
