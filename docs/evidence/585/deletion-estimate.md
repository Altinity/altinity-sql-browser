# Future production deletion estimate (plan §28)

Estimate only — actual deletion is Phase 4, per plan §4/§28. Computed mechanically
from `src/net/ch-client.ts`'s own top-level symbol boundaries (see `run-matrix.mjs`'s
`CH_CLIENT_CLASSIFICATION` data table) so the figures stay tied to the real file rather
than a hand-typed guess; an unclassified symbol makes `run-matrix.mjs` throw instead of
silently under/over-counting.

## `src/net/ch-client.ts` buckets (physical LOC per top-level symbol range)

| Bucket | Physical LOC |
|---|---|
| `delete-after-cutover` | 240 |
| `rewrite-narrow-adapter` | 89 |
| `retain-temporary-bridge` | 27 |
| `unrelated-product-operation` | 626 |

## Other named responsibilities

| Responsibility | Final owner / bucket | Physical LOC |
|---|---|---|
| `tests/spike/clickhouse-client/official-adapter.ts` production-shaped core (`OfficialConnection`/`createOfficialConnection`/`officialAuthFor`/`runOfficial`; spike-test-only harness excluded) | estimated official adapter | 248 |
| `tests/spike/clickhouse-client/progress-bridge.ts` | accepted narrow bridge | 40 (34 transformed executable) |
| `tests/spike/clickhouse-client/guarded-fetch.ts` | accepted narrow guard | 55 (58 transformed executable) |
| `src/core/stream.ts` (whole file) | retain as SQL Browser policy — normalized meta/row/progress/error representation, unaffected by transport choice | 222 |
| `src/application/query-execution-service.ts` (whole file) | retain as SQL Browser policy — retry safety, unaffected by transport choice | 291 |

## Formula (plan §28)

```text
current generic executable LOC eligible for deletion
  = 240   (ch-client.ts "delete-after-cutover" bucket)
- estimated official adapter executable LOC
  = 248   (official-adapter.ts production-shaped core)
- accepted narrow bridge/guard executable LOC
  = 95   (progress-bridge.ts + guarded-fetch.ts, physical)
= estimated net executable LOC deletion
  = -103
```

Net deletion is NOT positive — an Accepted ADR requires positive net deletion (plan §30 "Mark Accepted only if ... future net deletion is positive").

**Caveat on this specific measurement**: the `delete-after-cutover` bucket above is computed
at WHOLE-FUNCTION granularity (a function is classified in full, never split). `authedFetch`
(89 physical lines) is classified entirely as `rewrite-narrow-adapter` because it currently
interleaves generic fetch/response mechanics with the narrow credential-epoch guard — a finer,
sub-function split (out of scope for this mechanical pass) would likely move a meaningful
fraction of those lines into `delete-after-cutover` instead, which would make the net figure
less negative or positive. Reported as computed, not adjusted, so the ADR sees the real
mechanical result and can decide whether a finer split is warranted before relying on it.

Buckets NOT counted toward deletion (retained, rewritten, or unrelated — each with exactly
one final owner, per plan §28 "no permanent dual generic transport"):

- `rewrite-narrow-adapter` — credential-epoch fencing folds into the official adapter's own request construction (this spike's `guarded-fetch.ts` is the working precedent).
- `retain-temporary-bridge` — `KILL QUERY` + the frozen cancellation lease.
- `unrelated-product-operation` — schema/lineage/reference-data/doc-browsing SQL: never generic transport.
- `retain-as-sql-browser-policy` — `src/core/stream.ts` (normalized outcome) and `src/application/query-execution-service.ts` (retry safety): both already isolated from ch-client.ts and untouched by transport choice.
