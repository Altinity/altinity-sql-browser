// #276 Phase 3a WorkbenchSession — route-scoped owner of the workbench
// running operation and its cancellation state (issue rule 5). Owns
// run/runScript/runEntry/cancel orchestration; the run bookkeeping fields
// (runT0/runQueryId/runTick) and the in-flight AbortController are PRIVATE
// session state (formerly the RunState cast + AppState.abortController).
// Coordinates — but does not own — the shared AppState signals (running/
// resultView/...): the session is the sole production writer of `running`.
// DOM/render stays in the shell via injected hooks. Lives under ui/workbench
// (the issue's target layout); must not import ui/dashboard/** (check:arch
// enforces this) nor app.js/app.types.js.
//
// This session IS the live implementation: `createApp` constructs it
// (`app.workbench`), the actions registry delegates run/cancel/explain/
// row-limit re-runs to it, and `renderApp` wires the three run-coupled
// reactive effects through `attachShell` (idempotent — a re-render disposes
// the previous set first). `destroy()` has no production caller yet (the
// page is single-route today; Phase 5's route shells will invoke it) — its
// teardown behavior is proven by the unit tests per the issue's acceptance
// criteria.

import { effect, batch } from '@preact/signals-core';
import type { Signal } from '@preact/signals-core';
import { savedForTab, tabPanel, recordScriptHistory, variableDoc } from '../../state.js';
import type { QueryTab, HistoryEntry, SaveJSON, AppState } from '../../state.js';
import type { SavedQueryV2 } from '../../generated/json-schema.types.js';
import type { ResultSort } from '../../core/sort.js';
import { splitStatements } from '../../core/sql-split.js';
import { mergedSourceArgs } from '../../core/param-pipeline.js';
import type { PreparedSource, BoundParamSnapshot } from '../../core/param-pipeline.js';
import { supportsExplainPretty, detectSqlFormat, isSchemaMutatingSql } from '../../core/format.js';
import { EXPLAIN_VIEWS, parseExplain, detectExplainView, buildExplainQuery } from '../../core/explain.js';
import { isKpiPanel, panelExecution } from '../../core/panel-execution.js';
import { newResult } from '../../core/stream.js';
import { buildResultSource } from '../../core/query-source.js';
import {
  VARIABLE_OPTION_BYTE_CAP, VARIABLE_OPTION_CAP,
  compileOptionProbe, optionSqlDiagnostics, validateOptionColumns,
} from '../../core/variable-options.js';
import type { QueryResult, ScriptResult, ScriptEntry } from '../results.js';
import type { QueryExecutionService } from '../../application/query-execution-service.js';

// ── The state slice run()/runScript()/runEntry()/cancel() touch ────────────
// Pick-shaped, structurally satisfied by the real `AppState` (state.ts) — a
// production caller passes `app.state` directly, no adapter needed. Two
// members (`savedQueries`/`history`) are also read/written by the pure
// `savedForTab`/`recordScriptHistory` helpers below, whose own signatures are
// narrowed (state.ts) to exactly the `Pick<AppState, ...>` this slice already
// satisfies — no bridge cast needed to call them with `state` directly.

/** Result views a saved query can remember — DERIVED from state.ts's own
 *  `resultView` signal type (type-only, no runtime import) so the two can
 *  never drift; same pattern as saved-history.ts's ResultView. */
export type WorkbenchResultView = AppState['resultView']['value'];

export interface WorkbenchStateSlice {
  running: Signal<boolean>;
  resultView: Signal<WorkbenchResultView>;
  /** Reassigned wholesale (`state.resultSort = {...}`) at the start of every
   *  run/runScript wave — a plain settable property, not a signal. */
  resultSort: ResultSort;
  /** Reassigned by the Explain button / a normal Run — plain, not a signal. */
  forceExplain: boolean;
  resultRowLimit: number;
  serverVersion: string | null;
  /** Read by runScript's clean-run history branch ('history' ⇒ repaint). */
  sidePanel: Signal<string>;
  isMobile: Signal<boolean>;
  mobileView: Signal<'tables' | 'editor' | 'results'>;
  /** Read by the Run-button effect (Run ↔ "Run selection" label). */
  hasSelection: Signal<boolean>;
  /** Read by the results-repaint + mobile-badge effects (attachShell) — NOT
   *  read by run()/runScript()/runEntry()/cancel() themselves, which address
   *  the active tab via `deps.activeTab()` instead. */
  activeTabId: Signal<string>;
  /** Read by `savedForTab` (state.ts, narrowed to `Pick<AppState,
   *  'savedQueries'>`) to resolve a run's `result.source.title`/`.description`. */
  savedQueries: SavedQueryV2[];
  /** Read/written by `recordScriptHistory` (state.ts, narrowed to
   *  `Pick<AppState, 'history'>`) on a clean script run. */
  history: HistoryEntry[];
}

// ── Injected DOM/render hooks (used INSIDE run()/runScript()/runEntry()) ───

export interface WorkbenchHooks {
  /** Per-chunk (run) + per-statement (runScript) results-pane repaint. */
  renderResults(): void;
  /** runScript's clean-run history repaint when `sidePanel === 'history'`. */
  renderSavedHistory(): void;
  cancelSchemaGraph(): void;
  /** Fire-and-forget schema reload after schema-mutating SQL succeeds. */
  loadSchema(): void;
  /** Records a successful single-statement run in history (and, per the real
   *  app.ts wrapper this replaces, repaints History when it's the open side
   *  panel — that repaint is this hook's own responsibility, unlike
   *  `renderSavedHistory` above which the session calls itself for the
   *  script-history path). */
  recordHistory(tab: QueryTab, sql?: string): void;
  recordBoundParams(bp: readonly BoundParamSnapshot[]): void;
  /** The #173 pipeline's single-source prepare, always in 'execute' mode (the
   *  only mode run()/runScript() ever use) — Phase 4 moves this into a
   *  WorkbenchParameterSession; injected until then. */
  prepareTabSource(sql: string, waveMs: number): PreparedSource;
  /** True (and already toasted, shell-owned) when the active tab's
   *  {name:Type} variables block execution. */
  varGateBlocked(waveMs: number): boolean;
  /** One statement's execution-view wire text (#165: inactive optional
   *  blocks stripped). Only run() (single-statement path) uses this —
   *  runScript gets its per-statement wire text from its own prepared batch. */
  execStatementSql(stmt: string): string;
  sessionParamsFor(tab: QueryTab, sqls: string[]): Record<string, string>;
  /** The SQL editor's current selection text (runEntry's selection-run
   *  override). */
  getSelectionText(): string;
  /** DOM readout write stays in the shell; the session's own 100ms interval
   *  calls this while a run is in flight. */
  tickElapsed(): void;
  /** `recordScriptHistory`'s persistence arg — core/storage.js's `saveJSON`
   *  shape (state.ts's own `SaveJSON` alias). */
  saveJSON: SaveJSON;
  /** Fired when `deps.getToken()` resolves null (signed out / unrefreshable)
   *  in run()/runScript() — restores the ported code's original
   *  `chCtx.onSignedOut(); return;` behavior without the session itself
   *  knowing about `chCtx`/`ConnectionSession`. The shell wires this to its
   *  ConnectionSession sign-out flow (e.g. `() => chCtx.onSignedOut()`); the
   *  session stays ignorant of `chCtx`. */
  onAuthFailed(): void;
}

// ── Construction deps ────────────────────────────────────────────────────────

export interface WorkbenchSessionDeps {
  exec: Pick<QueryExecutionService, 'executeRead' | 'executeScript' | 'kill'>;
  ensureConfig(): Promise<unknown>;
  /** Resolves the live bearer/basic credential, or null when signed out /
   *  unrefreshable — run()/runScript() call `hooks.onAuthFailed()` and return
   *  in that case (byte-equivalent to the ported app.ts's
   *  `chCtx.onSignedOut(); return;`), keeping the session itself ignorant of
   *  `chCtx`/`ConnectionSession`. */
  getToken(): Promise<string | null>;
  /** Perf clock — elapsedMs()/the run's own t0, matches app.ts's `now`. */
  now(): number;
  /** Wall clock — one snapshot per run/script wave (the #173 F6 invariant),
   *  matches app.ts's `wallNow`. */
  wallNow(): number;
  uid(prefix: string): string;
  state: WorkbenchStateSlice;
  activeTab(): QueryTab;
  hooks: WorkbenchHooks;
}

// ── attachShell: the 3 run-coupled effects, verbatim from renderApp ─────────

export interface WorkbenchShellEffects {
  /** The results-repaint effect's body (app.ts renderApp ~2542-2547):
   *  `renderResults(app)`. */
  renderResults(): void;
  /** The Run-button effect's body (app.ts renderApp ~2550): `app.setRunBtn(running)`. */
  setRunBtn(running: boolean): void;
  /** The mobile-badge effect's body (app.ts renderApp ~2615-2621) — the shell
   *  closure reads its own dom/badge element and `running`/the active tab's
   *  result to compute the text. */
  setMobileBadge(): void;
}

// ── run()'s own options bag (app.ts ~120-125, moved here verbatim) ──────────

/** `run()`'s own options bag — an explicit selection override (`sql`), the
 *  Explain button / EXPLAIN-view-switch flags, and a saved-query's remembered
 *  result view. Every real call site (`runEntry`, `explainQuery`,
 *  `setExplainView`, the saved-query open path) passes a subset of exactly
 *  these fields. */
export interface RunOpts {
  sql?: string;
  explain?: boolean;
  explainView?: string;
  view?: string;
}

/** The transport `run()` executes under for a KPI-owned panel — the shared
 *  read of `core/panel-execution.js`'s `PanelExecutionResult`, narrowed to
 *  exactly the fields `run()` itself reads. */
interface KpiExecutionTransport {
  format?: string;
  rowLimit?: number;
  params: Record<string, string | number>;
  error: string | null;
}

export interface WorkbenchSession {
  run(opts?: RunOpts): Promise<void>;
  runScript(statements: string[], originalInput: string): Promise<void>;
  runEntry(opts?: RunOpts): void | Promise<void>;
  cancel(): void;
  elapsedMs(): number;
  attachShell(effects: WorkbenchShellEffects): void;
  destroy(): void;
}

export function createWorkbenchSession(deps: WorkbenchSessionDeps): WorkbenchSession {
  const { state, hooks } = deps;

  // `run()`/`runScript()`'s own bookkeeping — a live query's wall-clock start
  // (`runT0`), its ClickHouse `query_id` (`runQueryId`, for Cancel's KILL
  // QUERY), and the live-elapsed-ms ticker's interval handle (`runTick`); plus
  // the in-flight `AbortController` (formerly `app.state.abortController`).
  // All PRIVATE to this session — see the module doc above.
  let runT0: number | null = null;
  let runQueryId: string | null = null;
  let runTick: ReturnType<typeof setInterval> | null = null;
  let abortController: AbortController | null = null;

  // attachShell's registered effect disposers (preact-signals-core's `effect()`
  // returns a dispose function) — re-attaching (renderApp can re-run) disposes
  // the previous set first, so the shell never double-fires.
  let shellDisposers: Array<() => void> = [];

  function disposeShellEffects(): void {
    for (const dispose of shellDisposers) dispose();
    shellDisposers = [];
  }

  // Milliseconds since the running query started (0 when idle).
  function elapsedMs(): number {
    return runT0 != null ? deps.now() - runT0 : 0;
  }

  async function run(opts?: RunOpts): Promise<void> {
    if (state.running.value) return; // already running — cancel via cancel()/Esc
    const tab = deps.activeTab();
    // `opts.sql` overrides the source SQL (a single selected statement); otherwise
    // the whole tab runs, byte-for-byte as before (FORMAT / EXPLAIN detection,
    // trailing `;`, history).
    const srcSql = opts && opts.sql != null ? opts.sql : tab.sqlDraft;
    // #465: a `dashboard-variable` tab's Run is validated and executed as a
    // variable option query — dispatched BEFORE the blank-SQL bail below,
    // because blank/whitespace-only option SQL must still report its own
    // diagnostic rather than silently no-op like an ordinary tab.
    if (variableDoc(tab) !== null) { await runVariableSql(tab, srcSql); return; }
    if (!srcSql.trim()) return;
    const waveMs = deps.wallNow(); // one wall clock for this run wave: gate + args see the same instant
    if (hooks.varGateBlocked(waveMs)) return;
    // One prepared source for the whole run wave (#173), captured NOW —
    // synchronously with the gate check above, BEFORE the auth awaits below
    // (review F6 invariant, shared with runScript/exportDirect/exportScript):
    // gate and args see the same varValues snapshot; a value edited while a
    // token refresh is in flight applies to the NEXT run, and can never reach
    // the server as a never-gate-checked binding. Reused on success for the
    // recent-value recording (#171), so it reads exactly the boundParams that
    // were sent.
    const src = hooks.prepareTabSource(srcSql, waveMs);
    await deps.ensureConfig();
    if (!(await deps.getToken())) { hooks.onAuthFailed(); return; }

    hooks.cancelSchemaGraph(); // a Run/Explain takes over the result — don't leave a lineage fetch running

    // EXPLAIN-view bookkeeping: the Explain button (opts.explain) forces any query
    // into EXPLAIN-view mode; a normal Run clears that; switching an EXPLAIN tab
    // (opts.explainView) preserves it.
    if (opts && opts.explain) state.forceExplain = true;
    else if (!(opts && opts.explainView != null)) state.forceExplain = false;

    // Every downstream decision + the request itself operate on the statement's
    // execution view (#165): inactive optional blocks removed, markers
    // stripped — byte-identical to srcSql for SQL without blocks. History still
    // records the template (srcSql / tab.sqlDraft).
    const execSql = hooks.execStatementSql(srcSql);

    const kpiExecution: KpiExecutionTransport = panelExecution(tabPanel(tab), execSql, {
      format: 'Table', rowLimit: state.resultRowLimit, params: {},
    });
    if (kpiExecution.error) {
      const kpiErrorResult: QueryResult = newResult('KPI', 2);
      kpiErrorResult.error = kpiExecution.error;
      Object.assign(tab, { result: kpiErrorResult });
      state.resultView.value = 'panel';
      hooks.renderResults();
      return;
    }

    // An explicit FORMAT clause runs raw and shows ClickHouse's response verbatim
    // (single raw tab). Otherwise an EXPLAIN (typed, or forced by the button) gets
    // the five EXPLAIN views; everything else streams structured (Table).
    const panelIsKpi = isKpiPanel(tabPanel(tab));
    const explicitFmt = panelIsKpi ? null : detectSqlFormat(execSql);
    const parsed = explicitFmt ? null : parseExplain(execSql);
    const explainMode = !explicitFmt && (parsed != null || state.forceExplain);
    let runSql = execSql;
    let fmt: string;
    let explainView: string | null = null;
    if (explainMode) {
      // View precedence: an explicit tab click wins; otherwise a *typed* EXPLAIN
      // is honored exactly (canonical match → its rich view, else the verbatim
      // Explain view); the button-forced path falls through to Explain. We never
      // inherit a stale view from a previous run/tab — typing a plain EXPLAIN must
      // show the plan, not whatever view was last open.
      explainView = (opts && opts.explainView)
        || (parsed && detectExplainView(parsed))
        || 'explain';
      fmt = (EXPLAIN_VIEWS.find((v) => v.id === explainView) || EXPLAIN_VIEWS[0]).chFormat;
      const inner = parsed ? parsed.inner : execSql;
      const explainOpts = { pretty: supportsExplainPretty(state.serverVersion) };
      runSql = explainView === 'explain' && parsed
        ? execSql
        : buildExplainQuery(inner, explainView, explainOpts);
    } else {
      fmt = panelIsKpi ? kpiExecution.format! : explicitFmt || 'Table';
    }

    // Cap a normal result query (Table or explicit-FORMAT SELECT) at the global
    // row limit; EXPLAIN/PIPELINE/ESTIMATE are exempt (small output, and a cap
    // would truncate a plan oddly). The streaming guard reads it off the result;
    // runQuery adds the server-side max_result_rows for the Table path.
    const rowLimit = explainMode ? 0 : panelIsKpi ? kpiExecution.rowLimit! : state.resultRowLimit;
    const t0 = deps.now();
    const result: QueryResult = newResult(fmt, rowLimit);
    Object.assign(tab, { result });
    if (explainView) result.explainView = explainView;
    state.resultSort = { col: null, dir: 'asc' };
    runT0 = t0;
    runQueryId = deps.uid('q');
    abortController = new AbortController();
    runTick = setInterval(hooks.tickElapsed, 100);
    // Keep the current Table/JSON/Panel tab across re-runs (#34); a saved-query
    // open passes its remembered view in opts.view to restore that instead
    // (a stray legacy 'chart' value maps to 'panel' — #166).
    const view = opts && opts.view === 'chart' ? 'panel' : opts && opts.view;
    // Flip the run signals last, in one batch: the results + Run-button effects
    // fire on this write and read runT0/elapsed, so the bookkeeping above must
    // already be set. (The old explicit setRunBtn(true)/renderResults are now
    // those effects' job.)
    batch(() => {
      state.resultView.value = view != null && ['table', 'json', 'panel'].includes(view)
        ? (view as WorkbenchResultView) : state.resultView.value;
      state.running.value = true;
    });

    try {
      await deps.exec.executeRead(result, {
        sql: runSql,
        format: fmt,
        rowLimit,
        queryId: runQueryId,
        signal: abortController.signal,
        // Native ClickHouse query parameters (#134/#173): pass prepared values
        // as param_<name> so the server substitutes them (only row-returning
        // statements bind — a CREATE VIEW / DDL source stays verbatim).
        params: { ...hooks.sessionParamsFor(tab, [srcSql]), ...mergedSourceArgs(src), ...kpiExecution.params },
        onChunk: () => hooks.renderResults(),
      });
    } finally {
      clearInterval(runTick as ReturnType<typeof setInterval>);
      runTick = null;
      abortController = null;
      runQueryId = null;
      runT0 = null;
      result.progress.elapsed_ns = (deps.now() - t0) * 1e6;
      // #185: capture the source that produced a normal, row-returning
      // structured result (fmt 'Table', so raw FORMAT / EXPLAIN are excluded;
      // empty results stay ineligible), so the Data Pane's Expand can open an
      // interactive, independently re-runnable detached view. The authored
      // template (srcSql — optional-block markers intact) and the run-time
      // title/description are snapshotted here, never re-derived from the
      // editor/Library at expand time (which may have changed). This MUST run
      // BEFORE the running flip below: that flip fires the results effect that
      // renders the toolbar + its Expand affordance, which gates on
      // `result.source` — set it after and the button never appears until the
      // next paint.
      if (!result.error && !result.cancelled && (fmt === 'Table' || fmt === 'KPI') && result.rows.length > 0) {
        result.source = buildResultSource({
          srcSql,
          tabId: tab.id,
          rowLimit,
          tabName: tab.name,
          savedEntry: savedForTab(state, tab),
        });
      }
      // Flip running off last: the results + Run-button effects fire here and
      // render the final stats, so elapsed_ns must already be recorded. (Old
      // explicit setRunBtn(false)/renderResults are now those effects' job.)
      state.running.value = false;
      if (!result.error && !result.cancelled) {
        // Spec completion is intentionally stable during a run and survives a
        // later failed/cancelled run. Snapshot only completed structured
        // results; never expose partially streamed metadata to the editor.
        // #447 dropped the third arm, `fmt === 'Filter'`: the Filter wire format
        // was only ever produced by the removed Filter-role run path, so `run()`
        // can no longer reach it.
        tab.lastSuccessfulResultColumns = (fmt === 'Table' || fmt === 'KPI')
          ? result.columns.map((column) => ({ ...column }))
          : [];
        hooks.recordHistory(tab, opts && opts.sql);
        // #171: this statement succeeded — record its bound params (exactly
        // what was actually sent; an omitted-optional-block param never
        // reached `src.statements[*].boundParams` in the first place).
        hooks.recordBoundParams(src.statements.flatMap((s) => s.boundParams) as BoundParamSnapshot[]);
        if (isSchemaMutatingSql(runSql)) hooks.loadSchema(); // not awaited — fire and forget
      }
    }
  }

  // #465 — Run's `dashboard-variable`-tab path: validate `sql` as a Dashboard
  // variable option query and execute it through the same bounded single-branch
  // probe (`compileOptionProbe`) the option batch's own branches use, rather
  // than running it raw. A typed FORMAT clause, a `{name:Type}` parameter, or
  // a KPI panel can never reach here — `optionSqlDiagnostics` rejects the first
  // two locally, and a variable document never carries a panel — so none of
  // `run()`'s machinery for those applies. The EXPLAIN button/view-switch
  // (`opts.explain`/`opts.explainView`) are irrelevant here for a different
  // reason: `run()` dispatches to this function unconditionally for a variable
  // tab, before either is ever read, so app.ts's `explainQuery`/
  // `setExplainView` refuse to call `workbench.run()` at all for one (guarded
  // by `explainVariableBlocked`) rather than have their intent silently
  // dropped here. Duplicating just the bookkeeping this path DOES need
  // (running/cancellation/elapsed, via the session's shared private run state)
  // keeps it auditable on its own rather than threading a second mode through
  // every branch of `run()` above.
  //
  // A shape-INVALID response is never treated as a successful run: no History
  // entry, no detached-result `source`. A genuinely valid one gets both —
  // #465 requires the validation, not the removal of a variable tab's
  // existing successful-run affordances (History predates the #457 document
  // split entirely; it is not a saved-query concept). Bound-param recording
  // and `lastSuccessfulResultColumns` are the two `run()`-success fields this
  // path does NOT mirror: option SQL can never carry a `{name:Type}` param
  // (`optionSqlDiagnostics` rejects one locally) and a variable tab has no
  // Spec for dynamic-source completion to read `lastSuccessfulResultColumns`
  // from, so both would be silent no-ops here.
  async function runVariableSql(tab: QueryTab, sql: string): Promise<void> {
    // Every locally-detectable problem — blank, comment-only, non-SELECT,
    // multi-statement (so a multi-statement input NEVER reaches runScript()),
    // FORMAT/INTO OUTFILE, a `{name:Type}` parameter, an optional block, an
    // unterminated span, the reserved branch-tag column — is reported here,
    // before authentication or a request is ever sent. This is the COMPLETE
    // parameter policy for option SQL (#465 review): `hooks.varGateBlocked`
    // is deliberately never consulted here — it gates on `tab.sqlDraft`
    // wholesale (the ordinary {name:Type} query-variable policy), which would
    // both wrongly re-flag a `{name:Type}` this diagnostic already rejects
    // and could block a validated `sql` (a selection) over an unfilled
    // variable elsewhere in the same tab's untouched draft text.
    const diagnostics = optionSqlDiagnostics(sql);
    if (diagnostics.length) {
      const result: QueryResult = newResult('Table', 0);
      result.error = diagnostics.map((d) => d.message).join('\n');
      Object.assign(tab, { result });
      hooks.renderResults();
      return;
    }
    await deps.ensureConfig();
    if (!(await deps.getToken())) { hooks.onAuthFailed(); return; }

    hooks.cancelSchemaGraph();
    state.forceExplain = false;

    // The SAME bounded, read-only transport the option batch itself runs under
    // (dashboard-viewer-session.ts's `runOptionBatch`) — `state.resultRowLimit`
    // (the user's ordinary display cap) is the WRONG bound here: it can cut the
    // client off before the probe's own per-branch limit, hiding a
    // `max_result_bytes` failure the full batch would hit later, and without
    // `max_result_bytes`/`readonly` at all, an unbounded response is exactly
    // what "cannot pass SQL the batch would reject" is supposed to rule out.
    const rowLimit = VARIABLE_OPTION_CAP + 1;
    const t0 = deps.now();
    const result: QueryResult = newResult('Table', rowLimit);
    Object.assign(tab, { result });
    state.resultSort = { col: null, dir: 'asc' };
    runT0 = t0;
    runQueryId = deps.uid('q');
    abortController = new AbortController();
    runTick = setInterval(hooks.tickElapsed, 100);
    state.running.value = true;

    try {
      await deps.exec.executeRead(result, {
        sql: compileOptionProbe(sql),
        format: 'Table',
        rowLimit,
        queryId: runQueryId,
        signal: abortController.signal,
        params: { readonly: 2, max_result_bytes: VARIABLE_OPTION_BYTE_CAP },
        onChunk: () => hooks.renderResults(),
      });
      // Only the probe's own transport succeeding makes its response metadata
      // meaningful — a transport error or a cancellation already has its own
      // story and must not be overwritten by a shape verdict about a response
      // that never fully arrived.
      if (!result.error && !result.cancelled) {
        const shape = validateOptionColumns(result.columns);
        if (shape) result.error = shape.message;
      }
    } finally {
      clearInterval(runTick as ReturnType<typeof setInterval>);
      runTick = null;
      abortController = null;
      runQueryId = null;
      runT0 = null;
      result.progress.elapsed_ns = (deps.now() - t0) * 1e6;
      // #185, same ordering `run()` uses and for the same reason: this MUST
      // run before the `running` flip below, which fires the results effect
      // that renders the Expand affordance gated on `result.source`.
      if (!result.error && !result.cancelled && result.rows.length > 0) {
        result.source = buildResultSource({
          srcSql: sql, tabId: tab.id, rowLimit, tabName: tab.name, savedEntry: savedForTab(state, tab),
        });
      }
      state.running.value = false;
      if (!result.error && !result.cancelled) hooks.recordHistory(tab, sql);
    }
  }

  // Run a `;`-separated script sequentially: one ClickHouse request per statement
  // (CH's HTTP interface runs exactly one statement per request), stopping on the
  // first failure. Row-returning statements (SELECT/WITH/SHOW/…) are fetched as
  // JSONCompact capped at 100 rows; everything else runs for effect and reports
  // OK. The result is a per-statement summary grid (tab.result.script). The whole
  // script is recorded as one history entry on a clean run. `originalInput` is the
  // exact text that was split (the selection or the whole editor).
  async function runScript(statements: string[], originalInput: string): Promise<void> {
    if (state.running.value) return;
    const waveMs = deps.wallNow(); // one wall clock for the whole script wave
    if (hooks.varGateBlocked(waveMs)) return; // block a script run with unfilled variables
    // One prepared batch for the whole script (#173): `statements` came from
    // splitStatements(originalInput), so the batch's statements align by index.
    // Captured NOW — synchronously with the gate check above, BEFORE the auth
    // awaits (review F6 invariant, shared with run/exportDirect/exportScript):
    // gate and args see the same varValues snapshot; edits during the auth
    // await apply to the next run.
    const paramSrc = hooks.prepareTabSource(originalInput, waveMs);
    await deps.ensureConfig();
    if (!(await deps.getToken())) { hooks.onAuthFailed(); return; }

    hooks.cancelSchemaGraph(); // a script run takes over the result — don't leave a lineage fetch running
    state.forceExplain = false;
    const tab = deps.activeTab();
    const t0 = deps.now();
    const entries: ScriptEntry[] = [];
    const scriptResult: ScriptResult = { script: entries };
    Object.assign(tab, { result: scriptResult });
    state.resultSort = { col: null, dir: 'asc' };
    runT0 = t0;
    abortController = new AbortController();
    runTick = setInterval(hooks.tickElapsed, 100);
    let aborted = false;
    // Attach a session only if the script needs one (TEMPORARY / SET) or the tab
    // already has one — same params for every statement, computed once.
    const sp = hooks.sessionParamsFor(tab, statements);
    state.running.value = true; // the results effect paints the (empty) grid
    try {
      // Transport/retry loop (one ClickHouse request per statement, the
      // SESSION_IS_LOCKED / transient-network retry, stop-on-first-failure)
      // lives in application/query-execution-service.ts (#276 Phase 1) —
      // this loop owns only orchestration: per-statement wire text (#165's
      // execution view), the live query_id (for Cancel), pushing entries +
      // repainting, and per-statement boundParams recording.
      const res = await deps.exec.executeScript({
        statements: statements.map((stmt, i) => ({
          sql: stmt,
          // The wire text is the pipeline's per-statement execution view (#165):
          // inactive optional blocks removed for row-returning statements,
          // verbatim (byte-identical) for everything else and for block-free SQL.
          // The result grid keeps showing the authored `stmt`.
          execSql: paramSrc.statements[i].sql,
          // Per-statement prepared args (#134/#173): the pipeline binds only
          // row-returning statements, so a DDL / CREATE VIEW statement in the
          // script is sent with its {name:Type} placeholders intact.
          params: { ...sp, ...paramSrc.statements[i].args },
        })),
        signal: abortController.signal,
        // Fresh query_id per attempt, published before the request so Cancel
        // issues KILL QUERY against the statement that's actually running.
        onStatementStart: (_i, { queryId }) => { runQueryId = queryId; },
        onStatementResult: (i, entry) => {
          entries.push(entry);
          // #171: THIS statement succeeded — record its own boundParams (per
          // statement, not per script: statement 1 of a later-failing script
          // still records; an error entry stops the script and never records).
          if (entry.status !== 'error') hooks.recordBoundParams([...paramSrc.statements[i].boundParams]);
          hooks.renderResults();
        },
      });
      aborted = res.aborted;
    } finally {
      clearInterval(runTick as ReturnType<typeof setInterval>);
      runTick = null;
      abortController = null;
      runQueryId = null;
      runT0 = null;
      scriptResult.elapsedMs = deps.now() - t0;
      if (aborted) scriptResult.cancelled = true;
      state.running.value = false;
      // A statement that actually ran (status !== 'error') and was schema-mutating
      // refreshes the tree even if a later statement in the script failed — it
      // already took effect server-side.
      if (entries.some((e) => e.status !== 'error' && isSchemaMutatingSql(e.sql))) hooks.loadSchema();
      // One history entry for the whole script — but only on a clean run (mirrors
      // run(): no history for an aborted or failed script).
      if (!aborted && !entries.some((e) => e.status === 'error')) {
        recordScriptHistory(state, originalInput, scriptResult.elapsedMs!, hooks.saveJSON);
        if (state.sidePanel.value === 'history') hooks.renderSavedHistory();
      }
    }
  }

  // The Run button / ⌘+Enter entry point. A non-empty (non-whitespace) editor
  // selection runs just that text; otherwise the whole tab. The chosen text is
  // split: one statement keeps today's rich Table/Chart/EXPLAIN path (run());
  // more than one runs sequentially as a script (runScript).
  function runEntry(opts?: RunOpts): void | Promise<void> {
    const tab = deps.activeTab();
    if (tab.editorMode !== 'sql') return;
    if (state.running.value) return;
    const sel = hooks.getSelectionText();
    const hasSel = sel.trim() !== '';
    const input = hasSel ? sel : tab.sqlDraft;
    // #465: a `dashboard-variable` tab is validated and executed as a variable
    // option query, dispatched straight to `run()` — NEVER through the
    // statement-count split below. A multi-statement variable SQL must fail
    // with `optionSqlDiagnostics`' own statement-count diagnostic, not be
    // silently routed to runScript() as an ordinary script.
    if (variableDoc(tab) !== null) {
      if (state.isMobile.value) state.mobileView.value = 'results';
      return run(hasSel ? { ...opts, sql: input } : opts);
    }
    const statements = splitStatements(input);
    if (!statements.length) return; // nothing runnable (empty / comments-only)
    // The unfilled-variable gate (#134) lives in run()/runScript() — the shared
    // execution choke points — so Explain, row-limit re-runs, and Export are
    // gated too, not just this path.
    // Mobile (#126): a run jumps the bottom-nav to the Results panel so the data
    // the user just asked for is what they see next.
    if (state.isMobile.value) state.mobileView.value = 'results';
    // >1 statement → script grid (a remembered single-result view doesn't apply).
    if (statements.length > 1) return runScript(statements, input);
    // 1 statement → today's rich path. Forward opts (e.g. a saved query's
    // remembered view / Explain); a selection adds the sql override.
    return run(hasSel ? { ...opts, sql: input } : opts);
  }

  // Stop an in-flight query: abort the stream and KILL QUERY on the server.
  function cancel(): void {
    if (!state.running.value) return;
    if (abortController) abortController.abort();
    deps.exec.kill(runQueryId); // fire-and-forget, same as before
  }

  function attachShell(shellEffects: WorkbenchShellEffects): void {
    disposeShellEffects(); // idempotent re-attach: renderApp can re-run
    shellDisposers = [
      // Reactive repaint of the results pane: re-runs on a tab switch, a Table/
      // JSON/Chart view change, or a run-state flip.
      effect(() => {
        state.activeTabId.value;
        state.resultView.value;
        state.running.value;
        shellEffects.renderResults();
      }),
      // The Run button reflects the run state (label + disabled) and the
      // selection (Run ↔ Run selection).
      effect(() => {
        state.hasSelection.value;
        shellEffects.setRunBtn(state.running.value);
      }),
      // The Results nav badge: ● while a query streams, else the row count.
      effect(() => {
        state.running.value;
        state.activeTabId.value;
        state.resultView.value;
        shellEffects.setMobileBadge();
      }),
    ];
  }

  function destroy(): void {
    disposeShellEffects();
    if (runTick != null) {
      clearInterval(runTick);
      runTick = null;
    }
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    if (runQueryId != null) {
      deps.exec.kill(runQueryId);
      runQueryId = null;
    }
    runT0 = null;
  }

  return { run, runScript, runEntry, cancel, elapsedMs, attachShell, destroy };
}
