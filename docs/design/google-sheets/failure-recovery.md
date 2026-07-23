# Failure recovery

## Refresh states

```text
idle
→ resolving
→ authenticating
→ validating
→ executing
→ uploading
→ publishing
→ recording
→ complete
```

Every refresh has a unique refresh ID, generation, start time, mode, and binding ID.

## Safety rules

- No live data mutation before publication.
- No checkpoint advancement without corresponding live rows.
- Previous committed data remains readable after every pre-publication failure.
- Ambiguous network outcomes are resolved by reading committed generation and refresh ID before retrying.

## Recovery cases

### Browser tab closed

Abort in-flight ClickHouse and Google requests where possible. The live sheet remains unchanged. The next refresh removes orphan staging worksheets and restarts full refresh, or resumes append from the last committed page checkpoint.

### Authentication expired

Preserve the pending refresh intent through the normal ClickHouse redirect. Google authorization is requested again through an explicit user gesture.

### Google permission removed

Stop before execution or publication when possible. Report the active Google account and required edit permission. Do not change state.

### Query or schema failure

Keep the previous dataset. Append incompatibilities require an explicit full refresh; full-refresh query failures remain non-destructive.

### Ambiguous publication

Read `_ASB_STATE`. Matching refresh ID and expected generation means success; the old generation means no commit; an unexpected generation means another refresh intervened. Never blindly repeat an append publication.

### Orphan staging

Staging sheets carry binding and refresh metadata. A later refresh may delete stale staging belonging to the same binding after verifying it is not the live managed sheet.

### Concurrent refresh

Use an advisory lease with owner, started-at, and expiry. Before publication, re-read generation and abort if it changed. The product does not promise strict distributed locking.

### Deleted or copied spreadsheet resources

Offer explicit repair: recreate a managed worksheet, relink a copied spreadsheet, remove stale metadata, reset checkpoint through full refresh, or unlink. Never identify resources by worksheet name alone.

## Diagnostics

Persist a normalized error category, phase, message, ClickHouse query ID when available, Google status code when safe, rows/cells processed, and whether destination state changed. Never record credentials or access tokens.
