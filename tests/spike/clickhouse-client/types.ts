// Phase 0 / issue #585 — the spike's own comparison interface (plan §7
// "Phase 0 architecture"). This is a TEST-OWNED type, not the Phase 1
// production transport contract: nothing under `src/` may import it, and
// `check:arch`-style reasoning (enforced here only by the absence of any
// production import, verified in `tests/unit/client-web-spike-policy.test.js`)
// keeps it that way.

/** One scenario's fully-specified request, independent of which adapter runs
 * it (current production functions vs. the official-client spike adapter). */
export interface SpikeRequest {
  /** Bare SQL text (no FORMAT/settings baked in — adapters append their own,
   *  matching how `ch-client.ts`'s `runQuery`/`chUrl` and the official
   *  client's `query()`/`exec()` each append format independently). */
  sql: string;
  /** Requested SQL Browser format intent — 'Table' | 'KPI' map to streaming
   *  progress formats; anything else is a raw/explicit-FORMAT request,
   *  mirroring `RunQueryOptions.format` in `src/net/ch-client.ts`. */
  format: 'Table' | 'KPI' | string;
  /** ClickHouse HTTP query-string settings (e.g. `max_result_rows`,
   *  `result_overflow_mode`, `wait_end_of_query`). */
  settings?: Record<string, string | number>;
  /** Native ClickHouse query parameters (`param_<name>`). */
  params?: Record<string, string | number>;
  /** Force multipart param encoding instead of URL query-string params. */
  multipart?: boolean;
  role?: string;
  /** Logical ClickHouse session id — omitted means session-less. */
  sessionId?: string;
  /** Caller-supplied query_id, allocated BEFORE execution (plan §7/§18 "query
   *  ID exists before execution"). */
  queryId?: string;
  /** Complete, request-local credential — never a client default. */
  credential: SpikeCredential;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Same-origin (proxied) vs. direct cross-origin endpoint. */
  origin: 'same-origin' | 'cross-origin';
  /** Whether the caller wants normalized rows (`StreamLine`-shaped) or raw
   *  bytes (export/raw-format paths). */
  consume: 'rows' | 'raw';
  /** The credential "epoch" this request was prepared under — races test
   *  whether a later epoch replacement can still affect this request. */
  epoch?: number;
}

export type SpikeCredential =
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'bearer'; token: string }
  | { kind: 'jwt-as-basic'; username: string; jwt: string }
  | { kind: 'invalid' };

/** One captured lifecycle/transport event — the union of everything plan §7
 * asks the harness to record. Adapters emit a `SpikeEvent[]` timeline; the
 * comparison only asserts on the projected `SpikeOutcome` (below), but the
 * raw timeline is kept in evidence for timing/ordering proofs. */
export type SpikeEvent =
  | { kind: 'request-start'; t: number }
  | { kind: 'headers'; t: number; status: number; headers: Record<string, string> }
  | { kind: 'query-id'; t: number; queryId: string }
  | { kind: 'summary'; t: number; summary: unknown }
  | { kind: 'meta'; t: number; columns: { name: string; type: string }[] }
  | { kind: 'row'; t: number; row: unknown[] }
  | { kind: 'progress'; t: number; rows: number; bytes: number; totalRows?: number }
  | { kind: 'exception'; t: number; message: string; inBand: boolean }
  | { kind: 'first-row'; t: number }
  | { kind: 'completed'; t: number }
  | { kind: 'aborted'; t: number }
  | { kind: 'timeout'; t: number }
  | { kind: 'network-rejected'; t: number; message: string }
  | { kind: 'http-error'; t: number; status: number; message: string }
  | { kind: 'auth-lifecycle'; t: number; effect: 'connected' | 'offline' | 'refresh' | 'signed-out'; detail?: string };

/** The normalized, adapter-independent outcome the parity runner actually
 * asserts equality (or independently-expected-value equality) on — plan §7
 * "Normalized outcome". */
export interface SpikeOutcome {
  columns: { name: string; type: string }[];
  /** Row values AS STRINGS wherever the source format quotes them (Table's
   *  JSONStringsEachRowWithProgress) — never coerced through `Number()`, so a
   *  UInt64/Int128/Decimal256 value survives exactly (plan's precision
   *  invariant). KPI rows keep the KPI format's own (also-quoted) shape. */
  rows: unknown[][];
  partialRowCount: number;
  progress: { rows: number; bytes: number; totalRows?: number } | null;
  /** Application-visible error text, or null on success. */
  error: string | null;
  cancelled: boolean;
  chCode: number | null;
  chMessage: string | null;
  httpStatus: number | null;
  queryId: string | null;
  responseHeaders: Record<string, string>;
  summary: unknown;
  rawByteCount: number | null;
  rawSha256: string | null;
  /** Observed auth/lifecycle side effects, in order. */
  authEffects: ('connected' | 'offline' | 'refresh' | 'signed-out')[];
  events: SpikeEvent[];
  firstRowAtMs: number | null;
  completedAtMs: number | null;
}

/** A scenario's independently-declared expected outcome — deliberately a
 * PARTIAL shape: most scenarios only assert a handful of fields (plan §15
 * "Every fixture must have an independently declared expected outcome.
 * Pairwise equality alone is insufficient."). `null` fields present in the
 * partial are still checked; keys omitted from the partial are not asserted. */
export type ExpectedOutcome = Partial<Omit<SpikeOutcome, 'events'>> & {
  /** A human-readable statement of what independently justifies this
   *  expectation (e.g. "ClickHouse docs: SESSION_IS_LOCKED is code 373" or
   *  "server echoes UInt64 max as its exact decimal string") — required so a
   *  reviewer can't mistake "adapters agree" for "adapters are both right". */
  because: string;
};

/** One named scenario in the parity matrix (plan §18). */
export interface Scenario {
  id: string;
  description: string;
  request: Omit<SpikeRequest, 'credential' | 'queryId'> & { credential?: SpikeCredential };
  expected: ExpectedOutcome;
  /** Which adapters/environments this scenario is required to run under —
   *  a subset of the plan §25 browser/server/origin matrix; 'deterministic'
   *  means it only needs the fault server (no live ClickHouse). */
  applicability: ('deterministic' | 'live-clickhouse' | 'browser')[];
}

/** An adapter run's result: the normalized outcome plus how many times the
 * underlying client/fetch was constructed/invoked, for the "one client per
 * connection config" and "no reconstruction after refresh" invariants. */
export interface AdapterRunResult {
  outcome: SpikeOutcome;
  constructorCalls: number;
  fetchCalls: number;
}

/** The comparison result the parity runner produces for one scenario. */
export interface ParityResult {
  scenarioId: string;
  currentOutcome: SpikeOutcome;
  officialOutcome: SpikeOutcome;
  currentMatchesExpected: boolean;
  officialMatchesExpected: boolean;
  currentMatchesOfficial: boolean;
  mismatches: string[];
}
