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

> Yes — proven by the alternating-credentials test: each of four requests (Basic user A / user B / an invalid credential / user A again) is observed server-side using ONLY its own supplied credential, and the official client's constructor-call count stays at 1 throughout (official-adapter.ts's `constructorCalls` is a real, mechanically-enforced count backed by every `.client` assignment — never a hardcoded literal — so a future reconstruction would be caught, not silently passed).

Evidence: tests/spike/clickhouse-client/parity.test.ts "alternating Basic user A / user B / invalid / valid"; tests/spike/clickhouse-client/official-adapter.ts constructorCalls

## Can epoch fencing occur immediately before fetch?

> Yes — proven by the deliberate epoch-flip race test at the ACTUAL injected-fetch boundary (guarded-fetch.ts's guardedFetch, wired as the real official client's own fetch): a request whose epoch turns after preparation but before the delegate fetch fires is rejected with zero delegated calls; a current-epoch request delegates exactly once.

Evidence: tests/spike/clickhouse-client/parity.test.ts credential-epoch fencing block; tests/spike/clickhouse-client/guarded-fetch.ts

## How are abort, timeout, and ClickHouse errors distinguished?

> Recorded per the four-way taxonomy tests: cancel/timeout/offline/HTTP-error each produce a distinct, non-overlapping classification on the official adapter (see the cited tests for the exact shape each one receives).

Evidence: tests/spike/clickhouse-client/parity.test.ts cancellation + timeout/offline blocks

## Are code and message retained for current policy?

> Yes — proven by the 401/403/SESSION_IS_LOCKED/reset error-taxonomy tests: ClickHouse code AND message survive intact for HTTP-level errors (401 -> chCode 516, 403 -> chCode 497, both with the server's own message text preserved), and the retry-safety layer's message is preserved for the ambiguous-write/reset cases the same policy already produces today.

Evidence: tests/spike/clickhouse-client/parity.test.ts retry-safety block

## Does the client support the proposed minimum?

> Proposed minimum ClickHouse 26.6.2.160 — see docs/evidence/585/support-minimum-analysis.md and results.json.matrixRows for the executed oldest-row corroboration.

Evidence: docs/evidence/585/support-minimum-analysis.md; results.json.matrixRows

## What production code would be deleted?

> Estimated net executable LOC deletion: -121 (240 eligible - 266 adapter - 95 bridge/guard).

Evidence: docs/evidence/585/deletion-estimate.md
