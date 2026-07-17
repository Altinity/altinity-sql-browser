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

import type { ChCtx, RunQueryOptions, RunQueryResult } from '../net/ch-client.js';
import type { runQuery, killQuery } from '../net/ch-client.js';
import { applyStreamLine } from '../core/stream.js';
import type { StreamResult } from '../core/stream.js';
import { isRowReturning } from '../core/sql-split.js';
import { parseSelectResult, firstRowPreview, SELECT_ROW_CAP } from '../core/script-result.js';
import type { ScriptEntry } from '../core/script-result.js';

// ── Injected dependency seam ─────────────────────────────────────────────────

/** Every side effect this service needs, injected as a narrow bag — production
 *  wires the real `net/ch-client.js` functions + browser clock/crypto/timer;
 *  tests inject plain stubs. Mirrors `ch-client.ts`'s own `ChCtx` seam. */
export interface QueryExecutionDeps {
  /** Runs one statement and returns its parsed/streamed outcome. */
  runQuery: typeof runQuery;
  /** Best-effort `KILL QUERY` for a query_id. */
  killQuery: typeof killQuery;
  /** The live ClickHouse auth context — a *provider*, not a value: the caller
   *  may rebuild it (e.g. after a token refresh) between calls, so the
   *  service always reads the current one rather than closing over a stale
   *  snapshot. */
  ctx: () => ChCtx;
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
  /** SQL-string-quoting function `killQuery` needs to build its
   *  `KILL QUERY WHERE query_id = …` literal (matches `core/format.js`'s
   *  `sqlString`). */
  sqlString: (s: unknown) => string;
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

/** `attemptStatement`'s outcome — `ch.runQuery`'s own `RunQueryResult`
 *  (`streamed` unused here), plus the two classified failures the retry
 *  logic branches on. */
export interface AttemptResult extends RunQueryResult {
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
  kill(queryId: string | null | undefined): Promise<void>;
}

/** Build a `QueryExecutionService` bound to `deps`. Trivial constructor — no
 *  validation, no defaulting; the caller supplies every field of `deps`
 *  exactly as it wants it used. */
export function createQueryExecutionService(deps: QueryExecutionDeps): QueryExecutionService {
  // Run one script statement, classifying the outcome for the retry logic: a
  // Cancel → { aborted }; a connection-level fetch failure → { error:'Network
  // error', transient } (retryable); any other throw → { error }. Otherwise the
  // runQuery result itself ({ raw } | { error }).
  async function attemptStatement(stmt: string, opts: RunQueryOptions): Promise<AttemptResult> {
    try {
      return await deps.runQuery(deps.ctx(), stmt, opts);
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
  async function executeRead(
    result: StreamResult,
    {
      sql, format = 'Table', rowLimit = 0, params, signal, queryId, onChunk,
    }: ExecuteReadRequest,
  ): Promise<StreamResult> {
    try {
      const out = await deps.runQuery(deps.ctx(), sql, {
        format,
        resultRowLimit: rowLimit,
        queryId,
        signal,
        params,
        onLine: (json) => applyStreamLine(json, result),
        onChunk,
      });
      if (out.error != null) result.error = out.error;
      else if (out.raw != null) {
        result.rawText = out.raw;
        result.progress.bytes = out.raw.length;
      }
    } catch (e) {
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
  async function executeScript(req: ScriptExecutionRequest): Promise<ScriptExecutionResult> {
    const { statements, signal, onStatementStart, onStatementResult } = req;
    const entries: ScriptEntry[] = [];
    let aborted = false;
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      const rowReturning = isRowReturning(stmt.sql);
      // Over-fetch SELECTs by one past the display cap so a truncated result is
      // detectable (at exactly the cap it isn't).
      const opts: RunQueryOptions = {
        format: rowReturning ? 'JSONCompact' : 'TSV',
        signal,
        params: { ...stmt.params, ...(rowReturning ? { max_result_rows: SELECT_ROW_CAP + 1, result_overflow_mode: 'break' } : {}) },
      };
      const s0 = deps.now(); // this statement's own wall-clock (grid Time column)
      // Fresh query_id per attempt, published before the request so Cancel
      // issues KILL QUERY against the statement that's actually running.
      let queryId = deps.uid('q');
      onStatementStart(i, { queryId, attempt: 1 });
      let out = await attemptStatement(stmt.execSql, { ...opts, queryId });
      // Retry ONLY when it's safe. SESSION_IS_LOCKED means the statement was
      // rejected before running → safe to retry (any statement). A connection
      // reset (fetch TypeError → "Network error") leaves it UNKNOWN whether the
      // statement ran, so only retry read-only statements — re-running an
      // INSERT/DDL could double-apply it. (A mid-retry Cancel aborts the retry.)
      const locked = out.error != null && SESSION_BUSY.test(out.error);
      if (!out.aborted && (locked || (out.transient && rowReturning))) {
        await deps.sleep(deps.retryMs);
        queryId = deps.uid('q');
        onStatementStart(i, { queryId, attempt: 2 });
        out = await attemptStatement(stmt.execSql, { ...opts, queryId });
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
        onStatementResult(i, entry);
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
      onStatementResult(i, entry);
    }
    return { entries, aborted };
  }

  // Stop an in-flight query: best-effort KILL QUERY for `queryId` (mirrors
  // app.ts's cancel(), minus the AbortController.abort() the caller performs
  // itself — cancellation stays caller-owned; see the module doc above).
  function kill(queryId: string | null | undefined): Promise<void> {
    return deps.killQuery(deps.ctx(), queryId, deps.sqlString);
  }

  return { executeRead, executeScript, kill };
}
