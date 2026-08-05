// Phase 0 / issue #585, plan §18 "Parity scenario matrix" — the deterministic
// subset backed by `fault-server.mjs` fixtures (no live ClickHouse required).
// Each scenario names its fixture, its independent expectation, and which
// invariant-map row(s) it proves. Live-only rows (sessions, SESSION_IS_LOCKED
// retry against a real server, KILL QUERY, the full precision corpus) live in
// `run-matrix.mjs`'s live-matrix phase instead — they need a real ClickHouse
// process, not a fixture, per plan §5 "Search the repository..." /
// §17 "Expected values must be independent of both adapters" (a fixture
// can't stand in for real server serialization behavior).

export interface DeterministicScenario {
  id: string;
  description: string;
  fixture: string;
  invariantRefs: string[];
}

export const DETERMINISTIC_SCENARIOS: DeterministicScenario[] = [
  { id: 'ordinary-query', description: 'ordinary query returns identical normalized columns/rows on both adapters', fixture: 'ordinary-query', invariantRefs: ['Exact values survive normalization'] },
  { id: 'empty-result', description: 'zero-row result reports empty columns metadata and clean completion', fixture: 'empty-stream', invariantRefs: ['Exact values survive normalization'] },
  { id: 'progressive-first-row', description: 'first row is published well before completion on both adapters (no full-body buffering)', fixture: 'delayed-headers-scheduled-rows', invariantRefs: ['First rows remain progressive'] },
  { id: 'malformed-stream', description: 'a malformed NDJSON line is skipped; a later well-formed row still arrives', fixture: 'malformed-line', invariantRefs: ['Mid-stream errors cannot become success'] },
  { id: 'truncated-stream', description: 'a truncated trailing line never completes and is silently dropped, no crash', fixture: 'truncated-trailing-line', invariantRefs: ['Mid-stream errors cannot become success'] },
  { id: 'server-error-before-headers', description: 'a pre-header rejection surfaces as a query error, not a network/offline error', fixture: 'pre-header-rejection', invariantRefs: ['Post-confirmation 401/403 remain query outcomes'] },
  { id: 'exception-after-headers-inband', description: 'an in-band {"exception"} line preserves partial rows and ends in error, never success', fixture: 'progress-format-mid-stream-exception', invariantRefs: ['Mid-stream errors cannot become success'] },
  { id: 'post-header-connection-reset', description: 'a mid-stream connection reset surfaces as a distinct, non-success failure on both adapters', fixture: 'post-header-connection-reset', invariantRefs: ['Abort, timeout, offline, and HTTP errors remain distinct'] },
  { id: 'repeated-401', description: 'repeated 401 with no successful prior connection ends in a query/auth outcome (not an infinite retry loop)', fixture: 'repeated-401', invariantRefs: ['Post-confirmation 401/403 remain query outcomes'] },
  { id: 'forbidden-403', description: '403 is a query outcome, not a network/offline error', fixture: 'forbidden-403', invariantRefs: ['Post-confirmation 401/403 remain query outcomes'] },
  { id: 'controlled-headers-and-summary', description: 'response headers, query id, and X-ClickHouse-Summary are preserved verbatim', fixture: 'controlled-headers-and-summary', invariantRefs: ['Query ID exists before execution'] },
  { id: 'kpi-progress', description: 'the KPI (JSONEachRowWithProgress) path is publicly supported and streams progressively', fixture: 'kpi-progress', invariantRefs: ['First rows remain progressive'] },
  { id: 'raw-exception-like-text-then-more-data', description: 'exported data containing exception-shaped text mid-stream is preserved verbatim, never truncated', fixture: 'exception-like-text-then-more-data', invariantRefs: ['Raw export remains byte-exact'] },
  { id: 'raw-invalid-utf8', description: 'raw export of invalid-UTF-8 bytes hashes identically on both adapters (no text-decoding)', fixture: 'invalid-utf8-raw', invariantRefs: ['Raw export remains byte-exact'] },
  { id: 'raw-tagged-late-exception', description: 'a tagged late-exception trailer survives raw byte transport unmodified on both adapters', fixture: 'raw-tagged-late-exception', invariantRefs: ['Raw export remains byte-exact'] },
  { id: 'raw-legacy-untagged-exception', description: 'a legacy untagged exception trailer survives raw byte transport unmodified on both adapters', fixture: 'raw-legacy-untagged-exception', invariantRefs: ['Raw export remains byte-exact'] },
];
