# Testing strategy

## Unit tests

Cover canonical codecs and validators for bindings, limits, schema descriptors, checkpoints, refresh generations, table identifiers, version comparisons, capability probes, type conversions, append eligibility, query hashes, and error normalization.

## Google API seam tests

Use an injected fake Google client to cover:

- spreadsheet creation and selection;
- developer metadata lookup;
- exact-range chunk writes;
- staging creation and cleanup;
- atomic publication request construction;
- quota backoff and cancellation;
- ambiguous response reconciliation;
- copied, renamed, moved, and deleted spreadsheet resources;
- permission and account mismatch diagnostics.

## ClickHouse seam tests

Cover:

- binding-table conformance and append-only reads/writes;
- pinned query execution with native typed parameters;
- version and runtime capability probes;
- table UUID and engine validation;
- `_block_number`/`_block_offset` cursor query construction;
- per-partition upper-bound capture;
- schema/query/parameter invalidation;
- full-refresh checkpoint reset.

## Workflow tests

- snapshot export success, cancellation, and partial cleanup;
- full refresh preserves old data until publication;
- large full refresh streams without complete buffering;
- append commits rows and checkpoint together;
- browser close leaves only staging and committed state;
- append resumes from the last committed page;
- concurrent generation change aborts publication;
- ambiguous append publication is not duplicated;
- full refresh is explicit after append invalidation;
- unlink preserves data and disables refresh.

## Browser coverage

Run supported end-to-end workflows in Chromium, Firefox, and WebKit. Include OAuth popup handling, authentication redirects, deep-link restoration, cross-tab behavior, abort controllers, and CSP failures.

## Real Google integration suite

Use a dedicated Google Cloud test project and disposable spreadsheets. Never use personal developer files. Tests must clean up created worksheets/files where permitted and leave unique metadata for diagnosing incomplete cleanup.

## Scale tests

Include generated results near configured row, cell, byte, and per-cell limits. Assert bounded browser memory, byte-based chunking, progress reporting, no silent truncation, and safe rejection when staging capacity cannot fit.
