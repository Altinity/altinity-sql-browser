// Phase 0 / issue #585, plan §17 "Precision corpus" — runs the FULL
// `PRECISION_CORPUS` (expected-values.ts) through both adapters against a
// REAL ClickHouse server. Requires `ASB_SPIKE_CH_URL` (set by
// `clickhouse-containers.mjs`'s `up` command, or by a future
// `run-matrix.mjs`) to point at a reachable, already-bootstrapped server —
// this file never boots or tears down a container itself, and skips
// CLEANLY (an empty, green `describe.skip`) when the variable is unset, so
// `npm run test:client-spike` stays green with no server running (plan §8's
// hard requirement: the spike vitest `include` has no separate live-only
// glob, so an env-gated skip is the only way to keep the default run
// offline-safe).
//
// Credentials: the non-secret `BASIC_USER_A` fixture (auth-fixtures.ts) —
// the SAME literal username/password `clickhouse-containers.mjs` bootstraps
// into every row it boots (cross-referenced there).

import { describe, it, expect, beforeAll } from 'vitest';
import { PRECISION_CORPUS } from './expected-values.js';
import { runPrecisionCase, type PrecisionCaseResult } from './precision-corpus.js';
import { createOfficialConnection, type OfficialConnection } from './official-adapter.js';
import { BASIC_USER_A } from './auth-fixtures.js';

// The repo carries no `@types/node` (ADR-0002: dev-time-only strict TS over
// browser-shipped source, CLAUDE.md hard rule 1/4) and this sub-task's file
// scope does not include `tests/types/**` (the repo's own precedent location
// for a Node ambient-global `.d.ts`, e.g. `node-crypto.d.ts`) — so `process`
// is read through an untyped `globalThis` cast rather than adding a new
// ambient declaration file outside that scope.
function envVar(name: string): string | undefined {
  return (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

const CH_URL = envVar('ASB_SPIKE_CH_URL');

// NOTE on history: this file's first-ever real run (2026-08-05, against
// clickhouse/clickhouse-server 26.6.2.160) found that 11 of the corpus's
// container/JSON/NULL-typed cases disagreed with `expected-values.ts`'s
// literals even though `currentValue === officialValue` on every one of
// them (both adapters observing the identical wire bytes) — proving the
// literals themselves were authored from an incorrect assumption about
// `JSONStringsEachRowWithProgress`'s container serialization (documented in
// full in `expected-values.ts`'s header comment and each corrected case's
// own `because` field), not an adapter defect or a parity gap. Those 11
// literals are now corrected there (issue #585 Phase 0 evidence review,
// 2026-08-06), so this file asserts a single, unqualified full-corpus match
// with no exclusion list.

describe.skipIf(!CH_URL)('live precision corpus against a real ClickHouse server (plan §17)', () => {
  let conn: OfficialConnection;
  let results: PrecisionCaseResult[];

  beforeAll(async () => {
    // ONE official client for the whole corpus run (plan's "one official
    // client per connection config" invariant) — `runPrecisionCase`'s
    // optional `officialConn` parameter (added for this call site) reuses
    // it across every one of the ~40 cases instead of constructing a fresh
    // client per case.
    conn = createOfficialConnection(CH_URL!, fetch);
    results = [];
    for (const kase of PRECISION_CORPUS) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design: precision cases must not race each other's query_id/session-less state, and this corpus is small enough that sequential execution is fast.
      results.push(await runPrecisionCase(kase, CH_URL!, BASIC_USER_A, fetch, conn));
    }
  }, 120_000);

  it('exercises every corpus case exactly once — none silently dropped (plan §17 point 8)', () => {
    expect(results.map((r) => r.id).sort()).toEqual(PRECISION_CORPUS.map((k) => k.id).sort());
  });

  it('constructs exactly one official client for the whole corpus run', () => {
    expect(conn.constructorCalls).toBe(1);
  });

  it('every non-capability-gated case matches the independent expectation on BOTH adapters, and both adapters agree with each other', () => {
    const hardFailures = results.filter((r) => !r.skippedReason
      && (!r.currentMatchesExpected || !r.officialMatchesExpected || !r.currentMatchesOfficial));
    if (hardFailures.length) {
      // Not silently swallowed into a boolean — the exact case id, expected
      // literal, and each adapter's actual value land in the failure output.
      // eslint-disable-next-line no-console
      console.error('live precision corpus failures:', JSON.stringify(hardFailures, null, 2));
    }
    expect(hardFailures).toEqual([]);
  });

  it('every capability-gated omission is recorded, never a case that was simply expected to match and silently didn\'t (plan §17 point 8)', () => {
    const skipped = results.filter((r) => r.skippedReason);
    for (const r of skipped) {
      expect(r.capabilityGated, `case "${r.id}" skipped ("${r.skippedReason}") but is not marked capabilityGated in expected-values.ts`).toBe(true);
    }
  });
});
