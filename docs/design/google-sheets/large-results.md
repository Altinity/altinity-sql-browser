# Large results and quotas

Large transfers are streamed and chunked. The browser must not retain the complete result in memory or send one giant Google request.

## Limits

Enforce configurable row, cell, serialized-byte, duration, and per-cell length limits. Google spreadsheet capacity is evaluated across the entire workbook, including user worksheets and temporary staging.

Full refresh needs enough capacity for the current managed data and the staged replacement. Append refresh needs capacity for the new rows and temporary delta staging.

No operation silently truncates output.

## Pipeline

```text
ClickHouse response stream
→ incremental result parser
→ canonical type conversion
→ byte-bounded row chunk
→ explicit Google range write
→ release chunk memory
```

Chunk boundaries are based primarily on serialized UTF-8 size, with a row-count ceiling. A reasonable default request target is approximately 1 MB, configurable by deployment.

Use explicit ranges with `values.update` or `values.batchUpdate`, not `values.append`. Explicit ranges make retries idempotent and avoid logical-table inference.

## Type conversion

- Boolean and safely representable numbers remain native values.
- UInt64, wider integers, and precision-sensitive decimals are strings.
- Dates and timestamps follow one documented timezone policy.
- NULL uses the configured blank/null representation.
- Arrays, tuples, maps, and JSON use stable serialization.
- Values are written with RAW semantics to prevent formula interpretation.

## Quota handling

- Limit concurrent writes to one or two.
- Apply truncated exponential backoff to quota and transient failures.
- Leave headroom for verification, formatting, metadata, publication, and cleanup calls.
- Show separate ClickHouse read and Google upload progress.
- Cancellation stops new writes, aborts ClickHouse where possible, preserves committed live data, and cleans staging when possible.

## Capacity failure

When safe staging cannot fit, offer explicit alternatives: reduce rows or columns, aggregate/filter in ClickHouse, export a one-time snapshot to a new spreadsheet, or cancel. Do not degrade a failure-safe refresh into an in-place partial rewrite.
