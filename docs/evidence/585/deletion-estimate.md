# Future production deletion estimate (plan §28)

Estimate only — actual deletion is Phase 4, per plan §4/§28. Computed mechanically
from `src/net/ch-client.ts`'s and `src/net/clickhouse-http-transport.ts`'s own top-level
symbol boundaries (see `run-matrix.mjs`'s `CH_CLIENT_CLASSIFICATION`/
`HTTP_TRANSPORT_CLASSIFICATION` data tables) so the figures stay tied to the real files
rather than a hand-typed guess; an unclassified symbol, or a classification-table entry
that no longer matches anything, makes `run-matrix.mjs` throw instead of silently under/
over-counting in either direction.

## `src/net/ch-client.ts` buckets (physical LOC per top-level symbol range)

| Bucket | Physical LOC |
|---|---|
| `delete-after-cutover` | 73 |
| `rewrite-narrow-adapter` | 67 |
| `unrelated-product-operation` | 386 |
| `retain-temporary-bridge` | 21 |

## `src/net/clickhouse-http-transport.ts` buckets (physical LOC per top-level symbol range)

Issue #585 Phase 1 (PR #621) moved `chUrl` (+ the progress-line stream-read loop and the
transport factory) out of `ch-client.ts` into this file — classified here on its own so it
stays tied to the real file, then combined with `ch-client.ts`'s own `delete-after-cutover`
bucket below for the net-deletion formula.

| Bucket | Physical LOC |
|---|---|
| `delete-after-cutover` | 58 |

## Other named responsibilities

| Responsibility | Final owner / bucket | Physical LOC |
|---|---|---|
| `tests/spike/clickhouse-client/official-adapter.ts` production-shaped core (`OfficialConnection`/`createOfficialConnection`/`officialAuthFor`/`runOfficial`; spike-test-only harness excluded) | estimated official adapter | 190 |
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

Issue #585 Phase 1 (PR #621) split the current generic-transport surface across TWO files —
`ch-client.ts`'s own `delete-after-cutover` bucket plus `clickhouse-http-transport.ts`'s
(where `chUrl` now lives); the formula's first term is their SUM, not `ch-client.ts` alone.

```text
current generic physical LOC eligible for deletion
  = 131   (ch-client.ts "delete-after-cutover" bucket + clickhouse-http-transport.ts "delete-after-cutover" bucket)
- estimated official adapter physical LOC
  = 190   (official-adapter.ts production-shaped core)
- accepted narrow bridge/guard physical LOC
  = 95   (progress-bridge.ts + guarded-fetch.ts)
= estimated net physical LOC deletion
  = -154
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
