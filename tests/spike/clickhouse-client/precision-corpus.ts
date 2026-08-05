// Phase 0 / issue #585, plan §17 — runs each `PrecisionCase` (expected-values.ts)
// through BOTH adapters against a REAL ClickHouse server (no fixture can
// safely claim to reproduce a real server's exact numeric/decimal/date
// serialization — this corpus needs live infrastructure, unlike the
// fault-server-driven deterministic scenarios in `parity.test.ts`). Requires
// `ASB_SPIKE_CH_URL` to point at a reachable server (set by
// `clickhouse-containers.mjs` / `run-matrix.mjs`); callers must check for
// that env var themselves (this module has no side effect at import time).

import { runCurrent } from './current-adapter.js';
import { createOfficialConnection, runOfficial, type OfficialConnection } from './official-adapter.js';
import type { SpikeCredential } from './types.js';
import type { PrecisionCase } from './expected-values.js';

export interface PrecisionCaseResult {
  id: string;
  category: string;
  chType: string;
  expected: string | null;
  currentValue: unknown;
  officialValue: unknown;
  currentMatchesExpected: boolean;
  officialMatchesExpected: boolean;
  currentMatchesOfficial: boolean;
  capabilityGated: boolean;
  skippedReason?: string;
}

/** Run one precision case's `SELECT <select>` through both adapters as a
 * one-row Table query, returning the single `v` field each side produced
 * (or `null` for JSON null) alongside the independent expectation. A
 * capability-gated case whose query fails outright (e.g. `JSON` type absent
 * on an older server) is recorded with `skippedReason`, never silently
 * dropped or force-passed.
 *
 * `officialConn` (optional): reuse ONE pre-built `OfficialConnection` across
 * every case in a corpus run instead of constructing a fresh client per
 * case — matches the "one official client per connection config" invariant
 * (plan §7/§11) for the whole-corpus caller (`live-precision.test.ts`),
 * which passes the SAME connection for all ~40 cases. Omitted, this
 * constructs one itself (kept as the default so this function still works
 * standalone / from a REPL, matching its pre-existing signature). */
export async function runPrecisionCase(
  kase: PrecisionCase,
  baseUrl: string,
  credential: SpikeCredential,
  realFetch: typeof fetch,
  officialConn?: OfficialConnection,
): Promise<PrecisionCaseResult> {
  const sql = `SELECT ${kase.select}`;
  const base: Omit<PrecisionCaseResult, 'currentValue' | 'officialValue' | 'currentMatchesExpected' | 'officialMatchesExpected' | 'currentMatchesOfficial'> = {
    id: kase.id, category: kase.category, chType: kase.chType, expected: kase.expected, capabilityGated: !!kase.capabilityGated,
  };

  let currentValue: unknown = undefined;
  let officialValue: unknown = undefined;
  let skippedReason: string | undefined;

  try {
    const { outcome } = await runCurrent({
      sql, format: 'Table', credential, origin: 'same-origin', consume: 'rows', queryId: `precision-current-${kase.id}`,
    }, baseUrl, realFetch);
    if (outcome.error) {
      if (kase.capabilityGated) skippedReason = `current adapter: ${outcome.error}`;
      else throw new Error(outcome.error);
    } else {
      currentValue = outcome.rows[0]?.[0] ?? null;
    }
  } catch (e) {
    if (kase.capabilityGated) skippedReason = `current adapter threw: ${e instanceof Error ? e.message : String(e)}`;
    else throw e;
  }

  try {
    const conn = officialConn || createOfficialConnection(baseUrl, realFetch);
    const { outcome } = await runOfficial(conn, {
      sql, format: 'Table', credential, origin: 'same-origin', consume: 'rows', queryId: `precision-official-${kase.id}`,
    });
    if (outcome.error) {
      if (kase.capabilityGated) skippedReason = skippedReason || `official adapter: ${outcome.error}`;
      else throw new Error(outcome.error);
    } else {
      officialValue = outcome.rows[0]?.[0] ?? null;
    }
  } catch (e) {
    if (kase.capabilityGated) skippedReason = skippedReason || `official adapter threw: ${e instanceof Error ? e.message : String(e)}`;
    else throw e;
  }

  return {
    ...base,
    currentValue,
    officialValue,
    currentMatchesExpected: !skippedReason && currentValue === kase.expected,
    officialMatchesExpected: !skippedReason && officialValue === kase.expected,
    currentMatchesOfficial: !skippedReason && currentValue === officialValue,
    skippedReason,
  };
}
