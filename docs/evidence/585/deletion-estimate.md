# Future production deletion estimate (plan §28)

Estimate only — actual deletion is Phase 4, per plan §4/§28. Computed mechanically
from `src/net/ch-client.ts`'s own top-level symbol boundaries (see `run-matrix.mjs`'s
`CH_CLIENT_CLASSIFICATION` data table) so the figures stay tied to the real file rather
than a hand-typed guess; an unclassified symbol makes `run-matrix.mjs` throw instead of
silently under/over-counting.

## `src/net/ch-client.ts` buckets (physical LOC per top-level symbol range)

| Bucket | Physical LOC |
|---|---|
| `delete-after-cutover` | 120 |
| `rewrite-narrow-adapter` | 56 |
| `retain-temporary-bridge` | 20 |
| `unrelated-product-operation` | 364 |

## Other named responsibilities

| Responsibility | Final owner / bucket | Physical LOC |
|---|---|---|
| `tests/spike/clickhouse-client/official-adapter.ts` production-shaped core (`OfficialConnection`/`createOfficialConnection`/`officialAuthFor`/`runOfficial`; spike-test-only harness excluded) | estimated official adapter | 182 |
| `tests/spike/clickhouse-client/progress-bridge.ts` | accepted narrow bridge | 40 (34 transformed executable) |
| `tests/spike/clickhouse-client/guarded-fetch.ts` | accepted narrow guard | 55 (58 transformed executable) |
| `src/core/stream.ts` (whole file) | retain as SQL Browser policy — normalized meta/row/progress/error representation, unaffected by transport choice | 222 |
| `src/application/query-execution-service.ts` (whole file) | retain as SQL Browser policy — retry safety, unaffected by transport choice | 291 |

## Formula (plan §28)

Every term below is the SAME comment/blank-stripped "physical LOC" metric
(`physicalLineCount()` in `run-matrix.mjs`) — a P3 review finding (issue #585 Phase 0)
caught an earlier version of this formula mixing that metric for the bridge/guard terms
with a raw, comment-and-blank-INCLUSIVE line-range count for the ch-client.ts/
official-adapter.ts terms, which inflated those two terms (concentrated in
comment-heavy functions like `runOfficial`) relative to the bridge/guard terms.

```text
current generic physical LOC eligible for deletion
  = 120   (ch-client.ts "delete-after-cutover" bucket)
- estimated official adapter physical LOC
  = 182   (official-adapter.ts production-shaped core)
- accepted narrow bridge/guard physical LOC
  = 95   (progress-bridge.ts + guarded-fetch.ts)
= estimated net physical LOC deletion
  = -157
```

Net deletion is NOT positive — an Accepted ADR requires positive net deletion (plan §30 "Mark Accepted only if ... future net deletion is positive").

**Caveat on this specific measurement**: the `delete-after-cutover` bucket above is computed
at WHOLE-FUNCTION granularity (a function is classified in full, never split). `authedFetch`
(56 physical lines) is classified entirely as `rewrite-narrow-adapter` because it currently
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
