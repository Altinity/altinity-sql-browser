// #276 Phase 1's QueryExecutionService — the shared request/stream/normalize
// core (now `app.exec.executeRead`, formerly a private helper of the same name
// inline in app.ts) plus the multiquery script transport loop (formerly inline
// in app.ts's `runScript`'s per-statement retry/classify logic), extracted so
// it is constructible without App/AppState/DOM. Architectural rules (issue
// #276): no imports from `src/ui/**` or `src/editor/**` (a pretest check
// enforces this); every side effect is injected as a narrow dependency bag
// (`QueryExecutionDeps`), never imported directly, so the whole service is
// testable with plain stubs, exactly like `src/net/ch-client.ts`'s own `ChCtx`
// seam. Cancellation stays caller-owned: the caller holds its own
// `AbortController` and publishes the live `query_id` via `onStatementStart`
// (synchronously, before each attempt) so its own Cancel button can target
// it; `kill()` here is a stateless, one-shot best-effort `KILL QUERY` —
// deliberately NOT a `cancel(operationId)` registry (see the issue #276
// discussion on why the service itself never tracks in-flight operations).
//
// Issue #630 Phase 7 — this service no longer depends on generic `runQuery`/
// mutable-context `killQuery`, and no longer takes a `ctx()` auth-context
// provider at all: it is injected exactly THREE narrow authenticated
// primitives instead — `runProgress` (streaming Table/KPI reads),
// `runText` (whole-body TSV/explicit-format reads, plus every script
// statement — both effect and row-returning), and `cancel` (owner-scoped
// best-effort KILL QUERY, delegating to app.ts's `cancelOwnedQuery`, #630
// Phase 7 §9.2-9.4). This service now OWNS the SQL Browser format/settings
// mapping (Table/KPI/TSV/explicit-raw — §6.1-6.4) and the ordinary positive
// row-cap policy (§2.5: applies to every one of those four branches, never
// only Table/KPI) that used to live inside `net/ch-client.ts`'s `runQuery`;
// it never imports the package's transport/protocol surface directly (Rule
// D) — `runProgress`/`runText`/`cancel` are the only side effects, and their
// request/callback shapes below are this service's OWN narrow types, not a
// re-export of any package or `net/ch-client.ts` name, so this file carries
// zero coupling to `@altinity/clickhouse-http`'s exports. A package
// `ClickHouseError` thrown by the injected primitives is never imported or
// special-cased here: it is a plain `Error` subclass whose `.message` is
// already the safe, parsed exception text, so the EXISTING generic
// `String((e instanceof Error && e.message) || e)` fallback below classifies
// it correctly with no name check — no package error TYPE ever leaks into
// this service's own result contracts (§6.5).

import { applyStreamLine } from '../core/stream.js';
import type { StreamResult } from '../core/stream.js';
import { isRowReturning } from '../core/sql-split.js';
import { parseSelectResult, firstRowPreview, SELECT_ROW_CAP } from '../core/script-result.js';
import type { ScriptEntry } from '../core/script-result.js';

// ── Injected dependency seam ─────────────────────────────────────────────────

/** One authenticated ClickHouse HTTP request, exactly as this service builds
 *  it — this service's OWN shape (never a re-export of a `net/**`/package
 *  type): opaque SQL text, the exact wire format name, HTTP query-string
 *  settings/params, and the caller's own `AbortSignal`. */
export interface QueryExecutionRequest {
  sql: string;
  defaultFormat: string;
  settings?: Record<string, string | number>;
  params?: Record<string, string | number>;
  signal?: AbortSignal;
}

/** Callbacks `runProgress` drives while streaming — `onLine`'s parameter is
 *  intentionally the generic shape `applyStreamLine` already accepts
 *  (`Record<string, unknown>`), not a named `StreamLine` type, so this file
 *  never needs to reference the package's own progress-stream wire type. */
export interface QueryProgressCallbacks {
  onLine?: (line: Record<string, unknown>) => void;
  onChunk?: () => void;
}

/** Every side effect this service needs, injected as a narrow bag — production
 *  wires thin closures over `authenticatedProgress`/`authenticatedText`
 *  (`net/authenticated-clickhouse-request.ts`) and app.ts's own
 *  `cancelOwnedQuery`; tests inject plain stubs. */
export interface QueryExecutionDeps {
  /** Runs one authenticated request in progress-streaming mode (Table/KPI):
   *  drives `request`'s body through `callbacks` until the stream settles.
   *  Throws on a non-2xx response, an aborted signal, or a network failure —
   *  never returns a generic `{error}` shape (package consumers throw now,
   *  §6.5). */
  runProgress(request: QueryExecutionRequest, callbacks: QueryProgressCallbacks): Promise<void>;
  /** Runs one authenticated request in whole-body text mode (TSV/explicit
   *  format, and every script statement — effect or row-returning alike),
   *  resolving with the complete response text. Throws under the same
   *  conditions as `runProgress`. */
  runText(request: QueryExecutionRequest): Promise<string>;
  /** Best-effort owner-scoped `KILL QUERY` — delegates to app.ts's
   *  `cancelOwnedQuery(ownerEpoch, queryId)` (#630 Phase 7 §9.2/9.4): a
   *  replacement (non-owner) epoch never reaches a live connection's frozen
   *  kill. */
  cancel(ownerEpoch: number | null | undefined, queryId: string | null | undefined): Promise<void>;
  /** Perf clock for per-statement elapsed ms. Deliberately NOT the wall clock
   *  (`wallNow`) the #173 parameter pipeline uses for epoch-relative values —
   *  that F6 invariant (one wall-clock snapshot per run wave, resolved before
   *  any auth await) lives entirely caller-side; this service never resolves
   *  a wave clock of its own. */
  now: () => number;
  /** Mints a query_id, prefixed `prefix` — matches app.ts's `uid('q')`. */
  uid: (prefix: string) => string;
  /** Delay (ms) before the one same-session retry. */
  retryMs: number;
  /** Injected timer — `sleep(retryMs)` before a retry attempt. */
  sleep: (ms: number) => Promise<void>;
}

// ── executeRead ──────────────────────────────────────────────────────────────

/** `executeRead`'s request — an already-prepared read: the wire SQL, output
 *  format (default 'Table'), client-side row cap (default 0 = uncapped),
 *  native ClickHouse query parameters, the caller's own `AbortSignal` /
 *  query_id, and a per-chunk repaint hook. */
export interface ExecuteReadRequest {
  sql: string;
  format?: string;
  rowLimit?: number;
  params?: Record<string, string | number>;
  signal?: AbortSignal;
  queryId?: string;
  /** Epoch fence owned by the caller. When it turns false, this service must
   * neither acquire a newer live auth context nor publish more stream data. */
  isCurrent?: () => boolean;
  /** Per-read repaint hook — called with no arguments on each streamed chunk
   *  (the workbench repaints its pane; a tile/detached view repaints its own
   *  surface). Absent entirely when the caller passes none — no wrapper
   *  closure is created in that case. */
  onChunk?: () => void;
}

// ── executeScript ────────────────────────────────────────────────────────────

/** One statement of a script run, as the caller hands it to `executeScript`.
 *  `sql` is the authored statement — the grid display text AND what
 *  `isRowReturning` classifies; `execSql` is the wire text actually sent
 *  (the #165 execution view: inactive optional blocks stripped, byte-
 *  identical to `sql` for SQL without blocks); `params` is the caller-merged
 *  session_id + bound native-parameter args for this one statement — the
 *  service adds the row-returning-only over-fetch cap on top, never a
 *  session_id or bound arg. */
export interface ScriptStatement {
  sql: string;
  execSql: string;
  params: Record<string, string | number>;
}

/** `executeScript`'s request: the statements to run in order, the caller's
 *  own `AbortSignal` (shared by every attempt), and two callbacks that let
 *  the caller own orchestration (tab/result mutation, the running signal,
 *  history, renders, boundParams recording, schema reload) while the service
 *  owns transport/retry/classify. `onStatementStart` fires synchronously
 *  BEFORE each attempt (fresh query_id per attempt, including the retry) so
 *  the caller can publish it for Cancel's `KILL QUERY`; `onStatementResult`
 *  fires once per pushed entry, after it's pushed. */
export interface ScriptExecutionRequest {
  statements: ScriptStatement[];
  signal?: AbortSignal;
  /** Prevents a stale script (especially its delayed retry) from drifting
   * into a replacement authenticated context. */
  isCurrent?: () => boolean;
  onStatementStart: (index: number, info: { queryId: string; attempt: 1 | 2 }) => void;
  onStatementResult: (index: number, entry: ScriptEntry) => void;
}

/** `executeScript`'s result: the entries produced (one per statement that
 *  actually ran to completion or failure — an aborted statement gets none),
 *  and whether the script was cancelled mid-run. */
export interface ScriptExecutionResult {
  entries: ScriptEntry[];
  aborted: boolean;
}

/** `attemptStatement`'s outcome — the successful raw text body (unused for a
 *  non-row-returning statement), plus the two classified failures the retry
 *  logic branches on. This service's own local shape (never a `net/**`/
 *  package result type — §6.5). */
export interface AttemptResult {
  error?: string;
  raw?: string;
  aborted?: boolean;
  transient?: boolean;
}

// ClickHouse's transient "session is busy / locked by a concurrent client"
// (SESSION_IS_LOCKED, code 373) — retryable once the prior request releases it.
const SESSION_BUSY = /SESSION_IS_LOCKED|session .* is locked|locked by a concurrent/i;

/** The service surface `app.exec` will hold. */
export interface QueryExecutionService {
  executeRead(result: StreamResult, request: ExecuteReadRequest): Promise<StreamResult>;
  executeScript(request: ScriptExecutionRequest): Promise<ScriptExecutionResult>;
  /** Best-effort owner-scoped `KILL QUERY` (#630 Phase 7 §9.4) — `ownerEpoch`
   *  is the operation's authenticated-execution-scope epoch, captured by the
   *  caller at registration/start time, never re-read at cancel time. */
  kill(ownerEpoch: number | null | undefined, queryId: string | null | undefined): Promise<void>;
}

/** Build a `QueryExecutionService` bound to `deps`. Trivial constructor — no
 *  validation, no defaulting; the caller supplies every field of `deps`
 *  exactly as it wants it used. */
export function createQueryExecutionService(deps: QueryExecutionDeps): QueryExecutionService {
  // Run one script statement, classifying the outcome for the retry logic: a
  // Cancel → { aborted }; a connection-level fetch failure → { error:'Network
  // error', transient } (retryable); any other throw (including the package's
  // ClickHouseError, whose `.message` is already the safe parsed text) →
  // { error: e.message }. Otherwise the successful raw text body ({ raw }).
  async function attemptStatement(
    request: QueryExecutionRequest,
    isCurrent: () => boolean,
  ): Promise<AttemptResult> {
    if (!isCurrent()) return { aborted: true };
    try {
      const raw = await deps.runText(request);
      return { raw };
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return { aborted: true };
      return { error: e instanceof TypeError ? 'Network error' : String((e instanceof Error && e.message) || e), transient: e instanceof TypeError };
    }
  }

  // Execute one already-prepared read request into a caller-owned `result`,
  // with NO tab/global-state side effects. This is the request+stream+normalize
  // core that the workbench run(), the dashboard tiles, and the detached Data
  // view (#185) all perform identically: fold streamed lines into `result` via
  // applyStreamLine, capture a raw (explicit-FORMAT/EXPLAIN) body, and classify
  // an abort/network/other failure onto the result — never throwing. The caller
  // owns token freshness (resolved before this call), the AbortController /
  // query_id, parameter preparation, session_id, and any recent-value recording.
  // `onChunk` is the per-read repaint hook (the workbench repaints its pane; a
  // tile/detached view repaints its own surface). Returns the mutated `result`.
  //
  // Format/settings mapping (#630 Phase 7 §6.1-6.4, moved here from
  // `net/ch-client.ts`'s `runQuery`): Table/KPI stream the progress-bearing
  // JSON wire formats with no `wait_end_of_query`; TSV and an explicit/raw
  // caller format read the whole body as text with `wait_end_of_query=1`.
  // Every branch gets `add_http_cors_header=1`, and — independently of which
  // branch it is (§2.5) — a positive `rowLimit` adds the SAME
  // `max_result_rows`/`result_overflow_mode` cap to `settings`. Only a caller
  // that deliberately passes 0 (EXPLAIN/PIPELINE/ESTIMATE) stays uncapped.
  async function executeRead(
    result: StreamResult,
    {
      sql, format = 'Table', rowLimit = 0, params, signal, queryId, isCurrent = () => true, onChunk,
    }: ExecuteReadRequest,
  ): Promise<StreamResult> {
    if (!isCurrent()) return result;
    const isStreaming = format === 'Table' || format === 'KPI';
    const defaultFormat = isStreaming
      ? (format === 'KPI' ? 'JSONEachRowWithProgress' : 'JSONStringsEachRowWithProgress')
      : format === 'TSV' ? 'TabSeparatedWithNamesAndTypes' : format;
    const cap: Record<string, string | number> = rowLimit > 0
      ? { max_result_rows: rowLimit, result_overflow_mode: 'break' }
      : {};
    const request: QueryExecutionRequest = {
      sql,
      defaultFormat,
      settings: {
        ...(isStreaming ? {} : { wait_end_of_query: 1 }),
        ...cap,
        add_http_cors_header: 1,
      },
      params: { ...(queryId ? { query_id: queryId } : {}), ...(params || {}) },
      signal,
    };
    try {
      if (isStreaming) {
        await deps.runProgress(request, {
          onLine: (json) => { if (isCurrent()) applyStreamLine(json, result); },
          onChunk: onChunk
            ? () => { if (isCurrent()) onChunk(); }
            : undefined,
        });
      } else {
        const raw = await deps.runText(request);
        if (!isCurrent()) return result;
        result.rawText = raw;
        result.progress.bytes = raw.length;
      }
    } catch (e) {
      if (!isCurrent()) return result;
      // Cancel = abort: keep whatever streamed in, flag it partial (no error).
      if (e instanceof Error && e.name === 'AbortError') result.cancelled = true;
      else if (e instanceof TypeError) result.error = 'Network error';
      else result.error = String((e instanceof Error && e.message) || e);
    }
    return result;
  }

  // Run a `;`-separated script's transport loop sequentially: one ClickHouse
  // request per statement (CH's HTTP interface runs exactly one statement per
  // request), stopping on the first failure. Row-returning statements
  // (SELECT/WITH/SHOW/…) are fetched as JSONCompact capped at
  // SELECT_ROW_CAP; everything else runs for effect and reports OK.
  //
  // Script over-fetch cap placement (#630 Phase 7 §8): the row-returning cap
  // lives in `params`, spread AFTER `stmt.params`, so it always wins a
  // collision with a caller-supplied `max_result_rows`/`result_overflow_mode`
  // — and it is NEVER also placed in `settings` (§2.3): `settings` here only
  // ever carries `wait_end_of_query`/`add_http_cors_header`, the same for
  // every script statement regardless of row-returning-ness.
  async function executeScript(req: ScriptExecutionRequest): Promise<ScriptExecutionResult> {
    const {
      statements, signal, onStatementStart, onStatementResult,
      isCurrent = () => true,
    } = req;
    const entries: ScriptEntry[] = [];
    let aborted = false;
    for (let i = 0; i < statements.length; i++) {
      if (!isCurrent()) { aborted = true; break; }
      const stmt = statements[i];
      const rowReturning = isRowReturning(stmt.sql);
      // Over-fetch SELECTs by one past the display cap so a truncated result is
      // detectable (at exactly the cap it isn't).
      const defaultFormat = rowReturning ? 'JSONCompact' : 'TabSeparatedWithNamesAndTypes';
      const settings = { wait_end_of_query: 1, add_http_cors_header: 1 };
      const buildRequest = (queryId: string): QueryExecutionRequest => {
        const baseParams = { query_id: queryId, ...stmt.params };
        const params = rowReturning
          ? { ...baseParams, max_result_rows: SELECT_ROW_CAP + 1, result_overflow_mode: 'break' }
          : baseParams;
        return { sql: stmt.execSql, defaultFormat, settings, params, signal };
      };
      const s0 = deps.now(); // this statement's own wall-clock (grid Time column)
      // Fresh query_id per attempt, published before the request so Cancel
      // issues KILL QUERY against the statement that's actually running.
      let queryId = deps.uid('q');
      if (!isCurrent()) { aborted = true; break; }
      onStatementStart(i, { queryId, attempt: 1 });
      let out = await attemptStatement(buildRequest(queryId), isCurrent);
      if (!isCurrent()) { aborted = true; break; }
      // Retry ONLY when it's safe. SESSION_IS_LOCKED means the statement was
      // rejected before running → safe to retry (any statement). A connection
      // reset (fetch TypeError → "Network error") leaves it UNKNOWN whether the
      // statement ran, so only retry read-only statements — re-running an
      // INSERT/DDL could double-apply it. (A mid-retry Cancel aborts the retry.)
      const locked = out.error != null && SESSION_BUSY.test(out.error);
      if (!out.aborted && (locked || (out.transient && rowReturning))) {
        await deps.sleep(deps.retryMs);
        if (!isCurrent()) { aborted = true; break; }
        queryId = deps.uid('q');
        onStatementStart(i, { queryId, attempt: 2 });
        out = await attemptStatement(buildRequest(queryId), isCurrent);
        if (!isCurrent()) { aborted = true; break; }
      }
      if (out.aborted) { aborted = true; break; }
      // A connection reset on a non-idempotent statement: don't silently retry —
      // tell the user it may have run so they can decide whether to re-run.
      if (out.transient && !rowReturning) out.error = 'Network error — the statement may have executed; re-run it manually if needed.';
      const ms = deps.now() - s0;
      let entry: ScriptEntry;
      if (out.error != null) {
        entry = { sql: stmt.sql, status: 'error', error: out.error, ms };
        entries.push(entry);
        if (isCurrent()) onStatementResult(i, entry);
        break; // stop-on-first-failure: skip the remaining statements
      }
      if (rowReturning) {
        const sel = parseSelectResult(out.raw, SELECT_ROW_CAP);
        entry = {
          sql: stmt.sql, status: 'rows', columns: sel.columns, rows: sel.rows, truncated: sel.truncated, preview: firstRowPreview(sel.rows), ms,
        };
      } else {
        entry = { sql: stmt.sql, status: 'ok', ms };
      }
      entries.push(entry);
      if (isCurrent()) onStatementResult(i, entry);
    }
    return { entries, aborted };
  }

  // Stop an in-flight query: best-effort owner-scoped KILL QUERY for
  // `queryId` (mirrors app.ts's cancel(), minus the AbortController.abort()
  // the caller performs itself — cancellation stays caller-owned; see the
  // module doc above). `ownerEpoch` fences a replacement-epoch caller from
  // reaching a live connection's frozen kill (#630 Phase 7 §9.2/9.4).
  function kill(ownerEpoch: number | null | undefined, queryId: string | null | undefined): Promise<void> {
    return deps.cancel(ownerEpoch, queryId);
  }

  return { executeRead, executeScript, kill };
}
