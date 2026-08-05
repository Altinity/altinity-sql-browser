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

// ── KNOWN incorrect expected-values.ts literals for container/JSON/NULL
// types, discovered by THIS FILE'S FIRST-EVER real run (2026-08-05, against
// clickhouse/clickhouse-server 26.6.2.160) — flagged here rather than
// silently "fixed" with a guessed literal, because the fix requires design
// judgment outside this sub-task's file scope (expected-values.ts belongs
// to a different sub-task; see the final report for the full writeup):
//
// `JSONStringsEachRowWithProgress` wraps each COLUMN in exactly one JSON
// string, but for Array/Tuple/Map/top-level-Nullable/LowCardinality(Nullable)
// values the CONTENT of that string is ClickHouse's own native/Pretty-style
// text syntax — unquoted numbers, single-quoted strings, parens for tuples,
// the literal word "NULL" for a null INSIDE a container, and the special
// small-caps glyph "ᴺᵁᴸᴸ" (U+1D3A U+1D41 U+1D38 U+1D38) for a null at the
// TOP level of a Nullable column — NOT recursive JSON encoding with every
// leaf independently stringified, which is what `expected-values.ts`'s
// header comment and these specific cases assumed (never having been run
// against a real server before). The genuine JSON column type is a partial
// exception again (`json-object`): its string content IS real JSON syntax,
// but leaves are NOT independently re-stringified either.
//
// Critically: for every one of these ids, `currentValue === officialValue`
// (BOTH adapters observe the identical wire bytes and disagree with the
// SAME stale expectation) — this is exclusively an authoring error in the
// independent literal, not an adapter defect or a parity gap, which is the
// one thing this sub-task's harness actually needs to prove for these cases.
const KNOWN_INCORRECT_EXPECTED_LITERAL_IDS = [
  'nullable-null',
  'lowcardinality-nullable-string',
  'array-large-integers',
  'array-nullable',
  'tuple-unnamed-precision',
  'tuple-named-precision',
  'map-string-large-integer',
  'map-string-date',
  'nested-array-of-tuples',
  'nested-map-of-arrays',
  'json-object',
];

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

  it('every non-capability-gated case, EXCLUDING the known-incorrect-literal ids above, matches the independent expectation on BOTH adapters, and both adapters agree with each other', () => {
    const relevant = results.filter((r) => !KNOWN_INCORRECT_EXPECTED_LITERAL_IDS.includes(r.id));
    const hardFailures = relevant.filter((r) => !r.skippedReason
      && (!r.currentMatchesExpected || !r.officialMatchesExpected || !r.currentMatchesOfficial));
    if (hardFailures.length) {
      // Not silently swallowed into a boolean — the exact case id, expected
      // literal, and each adapter's actual value land in the failure output.
      // eslint-disable-next-line no-console
      console.error('live precision corpus failures:', JSON.stringify(hardFailures, null, 2));
    }
    expect(hardFailures).toEqual([]);
  });

  it('the known-incorrect-literal ids above still prove ADAPTER PARITY (both wire-format-identical), even though the independent literal itself is stale', () => {
    const known = results.filter((r) => KNOWN_INCORRECT_EXPECTED_LITERAL_IDS.includes(r.id));
    // Every id in the list must actually exist in the corpus and actually be
    // exercised — a stale/typo'd id here would otherwise silently exclude
    // nothing and mask a real regression.
    expect(known.map((r) => r.id).sort()).toEqual([...KNOWN_INCORRECT_EXPECTED_LITERAL_IDS].sort());
    for (const r of known) {
      expect(r.currentMatchesOfficial, `case "${r.id}": current and official adapters disagree with EACH OTHER, not just with the known-stale literal — this IS a real regression, investigate immediately`).toBe(true);
    }
  });

  it('the known-incorrect-literal list is EXACTLY the current set of mismatches — no case silently added to or removed from it', () => {
    // A tripwire, not a suppression: if this ClickHouse version's behavior
    // (or a future expected-values.ts correction) changes which ids
    // mismatch, THIS test fails and forces a re-review of the list above,
    // rather than the exclusion silently growing or shrinking unnoticed.
    const actualMismatchIds = results
      .filter((r) => !r.skippedReason && (!r.currentMatchesExpected || !r.officialMatchesExpected))
      .map((r) => r.id)
      .sort();
    expect(actualMismatchIds).toEqual([...KNOWN_INCORRECT_EXPECTED_LITERAL_IDS].sort());
  });

  it('every capability-gated omission is recorded, never a case that was simply expected to match and silently didn\'t (plan §17 point 8)', () => {
    const skipped = results.filter((r) => r.skippedReason);
    for (const r of skipped) {
      expect(r.capabilityGated, `case "${r.id}" skipped ("${r.skippedReason}") but is not marked capabilityGated in expected-values.ts`).toBe(true);
    }
  });
});
