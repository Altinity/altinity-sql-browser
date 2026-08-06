# Critical-question evidence (plan §27)

## Can the client request or expose JSONStringsEachRowWithProgress safely?

> No — rejected by the installed 1.23.1 public type surface (compile-time @ts-expect-error probe, format-type-probe.ts); a narrow exec()-based bridge is used instead.

Evidence: tests/spike/clickhouse-client/format-type-probe.ts (compile-time @ts-expect-error proof); tsc --noEmit result recorded in results.json.typeCheck

## If not, how many bridge lines are required?

> 40 physical / 34 transformed executable lines (progress-bridge.ts) + 55 physical / 58 transformed executable (guarded-fetch.ts)

Evidence: docs/evidence/585/bridge-loc.json

## Does exec() expose raw bytes without text decoding?

> Yes — proven by the invalid-UTF-8 SHA-256 digest-equality scenario.

Evidence: tests/spike/clickhouse-client/parity.test.ts "raw export: invalid-UTF-8 bytes hash identically"

## Can mid-stream exception behavior be preserved?

> Yes on the deterministic fault-server fixture; see results.json.matrixRows for the real-server corroboration per row.

Evidence: tests/spike/clickhouse-client/parity.test.ts in-band exception test; live-parity.test.ts real-server exception test

## Can per-request auth work without mutation or reconstruction?

> Evidence recorded per the alternating-credentials/constructor-count test in parity.test.ts.

Evidence: tests/spike/clickhouse-client/parity.test.ts "alternating Basic user A / user B / invalid / valid"

## Can epoch fencing occur immediately before fetch?

> Evidence recorded per the deliberate epoch-flip race test in parity.test.ts (guarded-fetch.ts).

Evidence: tests/spike/clickhouse-client/parity.test.ts credential-epoch fencing block; tests/spike/clickhouse-client/guarded-fetch.ts

## How are abort, timeout, and ClickHouse errors distinguished?

> Evidence recorded per the four-way taxonomy tests (cancel/timeout/offline/HTTP-error).

Evidence: tests/spike/clickhouse-client/parity.test.ts cancellation + timeout/offline blocks

## Are code and message retained for current policy?

> Evidence recorded per the 401/403/SESSION_IS_LOCKED/reset error-taxonomy tests.

Evidence: tests/spike/clickhouse-client/parity.test.ts retry-safety block

## Does the client support the proposed minimum?

> Proposed minimum ClickHouse 26.3.16.10001.altinitystable — see docs/evidence/585/support-minimum-analysis.md and results.json.matrixRows for the executed oldest-row corroboration.

Evidence: docs/evidence/585/support-minimum-analysis.md; results.json.matrixRows

## What production code would be deleted?

> Estimated net executable LOC deletion: -103 (240 eligible - 248 adapter - 95 bridge/guard).

Evidence: docs/evidence/585/deletion-estimate.md
