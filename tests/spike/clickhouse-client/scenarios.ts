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
  // ── Added for the "deterministic-complete" sub-task — remaining plan §18
  // rows marked deterministic, plus §19/§21/§22/§23's deterministic-only gates.
  { id: 'table-streaming', description: 'Table format (default) streams identical normalized meta/row/progress on both adapters', fixture: 'ordinary-query', invariantRefs: ['Exact values survive normalization', 'First rows remain progressive'] },
  { id: 'totals-extremes', description: 'totals/extremes/rows_before_limit_at_least lines are tolerated as a silent no-op on both adapters; rows/progress unaffected, no error', fixture: 'totals-extremes', invariantRefs: ['Exact values survive normalization'] },
  { id: 'cancel-before-request', description: 'pre-aborted signal: zero fetch side effect on either adapter', fixture: 'ordinary-query', invariantRefs: ['No production cutover'] },
  { id: 'cancel-awaiting-headers', description: 'abort while headers are still pending: cancellation without an offline/auth mutation on either adapter', fixture: 'slow-headers', invariantRefs: ['Abort, timeout, offline, and HTTP errors remain distinct'] },
  { id: 'cancel-during-rows', description: 'abort shortly after the first row: no row published after cancellation on either adapter', fixture: 'delayed-headers-scheduled-rows', invariantRefs: ['First rows remain progressive'] },
  { id: 'timeout-distinct-from-abort', description: "the official client's own connection-level request_timeout produces a distinct Error('Timeout error.'), never an AbortError, unlike a caller-driven abort_signal", fixture: 'slow-headers', invariantRefs: ['Abort, timeout, offline, and HTTP errors remain distinct'] },
  { id: 'offline-vs-http-error', description: 'a network-level connection refusal is classified distinctly (onTransportOffline / non-ClickHouseError) from an HTTP ClickHouse query error', fixture: 'pre-header-rejection', invariantRefs: ['Abort, timeout, offline, and HTTP errors remain distinct'] },
  { id: 'settings-serialization', description: 'ClickHouse HTTP settings are observed server-side as exact bare query-string keys/values on both adapters', fixture: 'ordinary-query', invariantRefs: ['Sessions remain explicit'] },
  { id: 'role-serialization', description: 'a ClickHouse role is observed server-side as an exact "role" query-string value on both adapters', fixture: 'ordinary-query', invariantRefs: ['Sessions remain explicit'] },
  { id: 'session-param-serialization', description: 'session_id is present with the exact value when requested and absent when session-less, observed identically on both adapters', fixture: 'ordinary-query', invariantRefs: ['Sessions remain explicit'] },
  { id: 'query-id-exists-before-execution', description: 'the caller-allocated query_id is present on the wire before the response is ever read, on both adapters', fixture: 'controlled-headers-and-summary', invariantRefs: ['Query ID exists before execution'] },
  { id: 'url-parameters-arrays-and-large-integers', description: 'a native query parameter holding an array of large-integer strings, and a scalar large-integer string, serialize to the exact same independently-computed wire value on both adapters', fixture: 'ordinary-query', invariantRefs: ['Exact values survive normalization'] },
  { id: 'forced-multipart', description: "use_multipart_params sends query_params as a multipart/form-data body with the correct field names/values on the official client's query()", fixture: 'kpi-progress', invariantRefs: ['No production cutover'] },
  { id: 'automatic-multipart', description: 'use_multipart_params_auto promotes an oversized query_params payload to multipart automatically', fixture: 'kpi-progress', invariantRefs: ['No production cutover'] },
  { id: 'explicit-format-no-duplication', description: 'a SQL text that already carries a trailing FORMAT clause is sent with exactly one FORMAT occurrence by the official adapter', fixture: 'raw-tsv-fixed', invariantRefs: ['Raw export remains byte-exact'] },
  { id: 'raw-tsv-exact', description: 'a fixed TSV body is byte-identical on both adapters', fixture: 'raw-tsv-fixed', invariantRefs: ['Raw export remains byte-exact'] },
  { id: 'raw-csv-exact', description: 'a fixed CSV body is byte-identical on both adapters', fixture: 'raw-csv-fixed', invariantRefs: ['Raw export remains byte-exact'] },
  { id: 'raw-json-exact', description: 'a fixed raw-JSON body is byte-identical on both adapters', fixture: 'raw-json-fixed', invariantRefs: ['Raw export remains byte-exact'] },
  { id: 'no-output-command', description: "an INSERT/DDL-shaped empty-body response is drained/discarded without hanging, by both the current raw path and the official client's command()", fixture: 'no-output', invariantRefs: ['No production cutover'] },
  { id: 'bearer-auth-exact-header', description: 'a Bearer credential produces the exact "Bearer <token>" Authorization header on both adapters', fixture: 'ordinary-query', invariantRefs: ['Request auth is authoritative'] },
  { id: 'jwt-as-basic-exact-composition', description: 'a JWT-as-Basic-password credential produces the exact independently-computed "Basic <base64>" Authorization header on both adapters', fixture: 'ordinary-query', invariantRefs: ['Request auth is authoritative'] },
  { id: 'refresh-then-retry', description: 'a 401-then-success fixture drives exactly one refresh and one replay to a successful outcome, on both adapters', fixture: '401-then-success', invariantRefs: ['Refresh retry remains bounded'] },
  { id: 'post-confirmation-401', description: 'a post-confirmation 401 remains a query outcome (no sign-out) on the current adapter; the official adapter classifies it as ClickHouseError code 516', fixture: 'repeated-401', invariantRefs: ['Post-confirmation 401/403 remain query outcomes'] },
  { id: 'stale-before-request', description: 'an already-stale epoch prevents any fetch side effect on either adapter', fixture: 'ordinary-query', invariantRefs: ['No stale credential reaches fetch'] },
  { id: 'stale-during-refresh', description: 'the epoch turns while a refresh is in flight: the replacement credential is never read or replayed, on either adapter', fixture: '401-then-success', invariantRefs: ['Stale work cannot mutate replacement lifecycle'] },
  { id: 'stale-response', description: 'the epoch turns while a response is in flight: no connected/lifecycle side effect fires for it, on either adapter', fixture: 'ordinary-query', invariantRefs: ['Stale work cannot mutate replacement lifecycle'] },
  { id: 'read-reset-retries-once', description: "a read retries exactly once after a mid-stream connection reset and then succeeds — hand-driven against the shim with an explicit format:'Table' so the reset fires mid-STREAM (the shim's exec()-based Table/bridge branch), not the discard-only command() branch executeScript would force via its own format:'JSONCompact' for a row-returning statement (that branch never streams a partial row before completing, so it can't reproduce a mid-stream reset at all — the SESSION_IS_LOCKED case above IS routed through executeScript/serviceFor() because a pre-header rejection happens identically on every format branch, so which branch executeScript picks doesn't matter there)", fixture: 'read-reset-then-success', invariantRefs: ['Retry safety remains unchanged'] },
  { id: 'ambiguous-insert-reset-no-retry', description: 'a non-row-returning (INSERT-shaped) statement never retries after a mid-stream connection reset; the ambiguous-write message is preserved, on the official adapter', fixture: 'post-header-connection-reset', invariantRefs: ['Retry safety remains unchanged'] },
  { id: 'ambiguous-ddl-reset-no-retry', description: 'a non-row-returning (DDL-shaped) statement never retries after a mid-stream connection reset; the ambiguous-write message is preserved, on the official adapter', fixture: 'post-header-connection-reset', invariantRefs: ['Retry safety remains unchanged'] },
];
