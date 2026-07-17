import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal } from '@preact/signals-core';
import {
  createWorkbenchSession,
} from '../../src/ui/workbench/workbench-session.js';
import type {
  WorkbenchSessionDeps, WorkbenchStateSlice, WorkbenchHooks, WorkbenchShellEffects,
} from '../../src/ui/workbench/workbench-session.js';
import { newTabObj } from '../../src/state.js';
import type { QueryTab } from '../../src/state.js';
import type {
  QueryExecutionService, ExecuteReadRequest, ScriptExecutionRequest, ScriptExecutionResult,
} from '../../src/application/query-execution-service.js';
import type { StreamResult } from '../../src/core/stream.js';
import type { PreparedSource, PreparedStatement, BoundParamSnapshot } from '../../src/core/param-pipeline.js';

// ── Small deferred helper (mirrors the pattern query-execution-service.test.ts
// uses for scripting async runQuery behaviors, adapted to a single promise a
// test can resolve/reject on its own schedule). ────────────────────────────

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Flush every pending microtask (the `await ensureConfig()` / `await
 * getToken()` chain each real call makes before touching `running`) via a
 * macrotask boundary — simpler and more robust than counting `await
 * Promise.resolve()` calls by hand. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function preparedStatement(over: Partial<PreparedStatement> = {}): PreparedStatement {
  return { sql: 'SELECT 1', args: {}, boundParams: [], ...over };
}

function preparedSource(over: Partial<PreparedSource> = {}): PreparedSource {
  return {
    id: 'tab', statements: [preparedStatement()], missing: [], invalid: [], errors: [], runnable: true, ...over,
  };
}

function boundParam(name: string): BoundParamSnapshot {
  return {
    name, declaredType: 'String', rawValue: 'x', resolvedValue: 'x', serializedValue: "'x'",
  };
}

// ── Fakes ────────────────────────────────────────────────────────────────────

function makeExec(): {
  exec: Pick<QueryExecutionService, 'executeRead' | 'executeScript' | 'kill'>;
  executeRead: ReturnType<typeof vi.fn>;
  executeScript: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
} {
  const executeRead = vi.fn(async (result: StreamResult, _req: ExecuteReadRequest) => result);
  const executeScript = vi.fn(async (_req: ScriptExecutionRequest): Promise<ScriptExecutionResult> => ({ entries: [], aborted: false }));
  const kill = vi.fn(async () => {});
  return { exec: { executeRead, executeScript, kill }, executeRead, executeScript, kill };
}

function makeState(over: Partial<WorkbenchStateSlice> = {}): WorkbenchStateSlice {
  return {
    running: signal(false),
    resultView: signal('table'),
    resultSort: { col: null, dir: 'asc' },
    forceExplain: false,
    resultRowLimit: 500,
    serverVersion: null,
    sidePanel: signal('saved'),
    isMobile: signal(false),
    mobileView: signal('editor'),
    hasSelection: signal(false),
    activeTabId: signal('t1'),
    savedQueries: [],
    history: [],
    ...over,
  };
}

function makeHooks(over: Partial<WorkbenchHooks> = {}): WorkbenchHooks {
  return {
    renderResults: vi.fn(),
    renderSavedHistory: vi.fn(),
    cancelSchemaGraph: vi.fn(),
    loadSchema: vi.fn(),
    recordHistory: vi.fn(),
    recordBoundParams: vi.fn(),
    prepareTabSource: vi.fn(() => preparedSource()),
    varGateBlocked: vi.fn(() => false),
    execStatementSql: vi.fn((stmt: string) => stmt),
    sessionParamsFor: vi.fn(() => ({})),
    getSelectionText: vi.fn(() => ''),
    tickElapsed: vi.fn(),
    saveJSON: vi.fn(),
    onAuthFailed: vi.fn(),
    ...over,
  };
}

interface Harness {
  deps: WorkbenchSessionDeps;
  state: WorkbenchStateSlice;
  hooks: WorkbenchHooks;
  tab: QueryTab;
  execFakes: ReturnType<typeof makeExec>;
  nowSeq: { value: number };
}

function makeHarness(opts: {
  state?: Partial<WorkbenchStateSlice>;
  hooks?: Partial<WorkbenchHooks>;
  tab?: Partial<QueryTab>;
  getToken?: () => Promise<string | null>;
} = {}): Harness {
  const state = makeState(opts.state);
  const hooks = makeHooks(opts.hooks);
  const tab: QueryTab = { ...newTabObj('t1'), ...opts.tab };
  const execFakes = makeExec();
  const nowSeq = { value: 0 };
  const deps: WorkbenchSessionDeps = {
    exec: execFakes.exec,
    ensureConfig: vi.fn(async () => undefined),
    getToken: opts.getToken || vi.fn(async () => 'tok'),
    now: () => { nowSeq.value += 10; return nowSeq.value; },
    wallNow: () => 1_700_000_000_000,
    uid: (() => { let n = 0; return (prefix: string) => `${prefix}-${++n}`; })(),
    state,
    activeTab: () => tab,
    hooks,
  };
  return { deps, state, hooks, tab, execFakes, nowSeq };
}

// ── run() ────────────────────────────────────────────────────────────────────

describe('createWorkbenchSession: run()', () => {
  it('guards while already running: no exec call, no side effects', async () => {
    const h = makeHarness({ state: { running: signal(true) } });
    const session = createWorkbenchSession(h.deps);
    await session.run();
    expect(h.execFakes.executeRead).not.toHaveBeenCalled();
    expect(h.hooks.cancelSchemaGraph).not.toHaveBeenCalled();
  });

  it('does nothing for blank/whitespace-only SQL', async () => {
    const h = makeHarness({ tab: { sqlDraft: '   ' } });
    const session = createWorkbenchSession(h.deps);
    await session.run();
    expect(h.execFakes.executeRead).not.toHaveBeenCalled();
  });

  it('Filter role: a statically invalid Filter SQL sets an error result and never executes', async () => {
    const h = makeHarness({ tab: { sqlDraft: 'SELECT 1; SELECT 2;', specParsed: { name: 'f', favorite: false, dashboard: { role: 'filter' } } } });
    const session = createWorkbenchSession(h.deps);
    await session.run();
    expect(h.execFakes.executeRead).not.toHaveBeenCalled();
    expect((h.tab.result as { error: string } | null)?.error).toMatch(/exactly one statement/);
    expect(h.tab.filterPreview).toEqual({ status: 'error', error: expect.stringContaining('exactly one statement') });
    expect(h.state.resultView.value).toBe('filter');
    expect(h.hooks.renderResults).toHaveBeenCalled();
  });

  it('Filter role: a valid Filter SQL runs to a successful preview', async () => {
    const h = makeHarness({ tab: { sqlDraft: 'SELECT 1 AS x', specParsed: { name: 'f', favorite: false, dashboard: { role: 'filter' } } } });
    h.execFakes.executeRead.mockImplementation(async (result: StreamResult) => {
      Object.assign(result, { columns: [{ name: 'x', type: 'UInt8' }], rows: [[1]] });
      return result;
    });
    const session = createWorkbenchSession(h.deps);
    await session.run();
    expect(h.execFakes.executeRead).toHaveBeenCalledTimes(1);
    const req = h.execFakes.executeRead.mock.calls[0][1] as ExecuteReadRequest;
    expect(req.format).toBe('Filter');
    expect(req.rowLimit).toBe(2);
    expect(h.tab.filterPreview).toMatchObject({ status: 'success' });
    expect(h.state.running.value).toBe(false);
  });

  it('Filter role: a failed Filter execution records the error preview', async () => {
    const h = makeHarness({ tab: { sqlDraft: 'SELECT 1', specParsed: { name: 'f', favorite: false, dashboard: { role: 'filter' } } } });
    h.execFakes.executeRead.mockImplementation(async (result: StreamResult) => {
      result.error = 'boom';
      return result;
    });
    const session = createWorkbenchSession(h.deps);
    await session.run();
    expect(h.tab.filterPreview).toEqual({ status: 'error', error: 'boom' });
  });

  it('blocks (no exec call) when the var gate is blocked', async () => {
    const h = makeHarness({ hooks: { varGateBlocked: vi.fn(() => true) } });
    const session = createWorkbenchSession(h.deps);
    await session.run();
    expect(h.execFakes.executeRead).not.toHaveBeenCalled();
    expect(h.deps.ensureConfig).not.toHaveBeenCalled();
  });

  it('auth failure (getToken → null): no exec call, no cancelSchemaGraph, fires onAuthFailed', async () => {
    const h = makeHarness({ getToken: async () => null, tab: { sqlDraft: 'SELECT 1' } });
    const session = createWorkbenchSession(h.deps);
    await session.run();
    expect(h.execFakes.executeRead).not.toHaveBeenCalled();
    expect(h.hooks.cancelSchemaGraph).not.toHaveBeenCalled();
    expect(h.hooks.onAuthFailed).toHaveBeenCalledTimes(1);
  });

  it('KPI panel: an explicit FORMAT clash sets an owned error result and never executes', async () => {
    const h = makeHarness({
      tab: { sqlDraft: 'SELECT 1 FORMAT JSON', specParsed: { name: 'k', favorite: false, panel: { cfg: { type: 'kpi' } } } },
    });
    const session = createWorkbenchSession(h.deps);
    await session.run();
    expect(h.execFakes.executeRead).not.toHaveBeenCalled();
    expect((h.tab.result as { error: string } | null)?.error).toMatch(/KPI panel owns the result format/);
    expect(h.state.resultView.value).toBe('panel');
  });

  it('KPI panel: a clean run executes as format KPI, rowLimit 2, and captures result.source', async () => {
    const h = makeHarness({
      tab: { sqlDraft: 'SELECT 1 AS x', name: 'My KPI', specParsed: { name: 'k', favorite: false, panel: { cfg: { type: 'kpi' } } } },
    });
    h.execFakes.executeRead.mockImplementation(async (result: StreamResult) => {
      Object.assign(result, { columns: [{ name: 'x', type: 'UInt8' }], rows: [[1]] });
      return result;
    });
    const session = createWorkbenchSession(h.deps);
    await session.run();
    const req = h.execFakes.executeRead.mock.calls[0][1] as ExecuteReadRequest;
    expect(req.format).toBe('KPI');
    expect(req.rowLimit).toBe(2);
    const result = h.tab.result as { source?: { title: string } } | null;
    expect(result?.source?.title).toBe('My KPI');
    expect(h.hooks.recordHistory).toHaveBeenCalledWith(h.tab, undefined);
  });

  it('an explicit FORMAT clause runs raw, honoring the authored format', async () => {
    const h = makeHarness({ tab: { sqlDraft: 'SELECT 1 FORMAT JSON' } });
    const session = createWorkbenchSession(h.deps);
    await session.run();
    const req = h.execFakes.executeRead.mock.calls[0][1] as ExecuteReadRequest;
    expect(req.format).toBe('JSON');
  });

  it('plain Table run: successful row-returning result captures result.source and records history', async () => {
    const h = makeHarness({ tab: { sqlDraft: 'SELECT 1 AS x' } });
    h.execFakes.executeRead.mockImplementation(async (result: StreamResult, req: ExecuteReadRequest) => {
      req.onChunk?.(); // exercise the per-chunk repaint hook (a real streamed run pulses this)
      Object.assign(result, { columns: [{ name: 'x', type: 'UInt8' }], rows: [[1]] });
      return result;
    });
    const session = createWorkbenchSession(h.deps);
    await session.run({ sql: 'SELECT 1 AS x' });
    const result = h.tab.result as { source?: unknown; error: string | null; cancelled: boolean } | null;
    expect(result?.source).toBeTruthy();
    expect(h.hooks.recordHistory).toHaveBeenCalledWith(h.tab, 'SELECT 1 AS x');
    expect(h.hooks.recordBoundParams).toHaveBeenCalled();
    expect(h.hooks.loadSchema).not.toHaveBeenCalled();
    expect(h.hooks.renderResults).toHaveBeenCalled(); // the onChunk pulse (+ the results/mobile-badge shell effects, if attached)
  });

  it('a schema-mutating statement refreshes the schema tree on success', async () => {
    const h = makeHarness({ tab: { sqlDraft: 'CREATE TABLE t (x Int32) ENGINE=Memory' } });
    const session = createWorkbenchSession(h.deps);
    await session.run();
    expect(h.hooks.loadSchema).toHaveBeenCalled();
    // 0 rows → no eligible result.source snapshot.
    expect((h.tab.result as { source?: unknown } | null)?.source).toBeUndefined();
  });

  it('a failed run never records history/boundParams/schema-reload', async () => {
    const h = makeHarness({ tab: { sqlDraft: 'SELECT 1' } });
    h.execFakes.executeRead.mockImplementation(async (result: StreamResult) => {
      result.error = 'nope';
      return result;
    });
    const session = createWorkbenchSession(h.deps);
    await session.run();
    expect(h.hooks.recordHistory).not.toHaveBeenCalled();
    expect(h.hooks.recordBoundParams).not.toHaveBeenCalled();
    expect(h.hooks.loadSchema).not.toHaveBeenCalled();
  });

  it('typed EXPLAIN with no matching rich view runs verbatim under the Explain tab', async () => {
    const h = makeHarness({ tab: { sqlDraft: 'EXPLAIN SELECT 1' } });
    const session = createWorkbenchSession(h.deps);
    await session.run();
    const req = h.execFakes.executeRead.mock.calls[0][1] as ExecuteReadRequest;
    expect(req.sql).toBe('EXPLAIN SELECT 1');
    expect(req.format).toBe('TabSeparatedRaw');
    expect((h.tab.result as { explainView?: string } | null)?.explainView).toBe('explain');
  });

  it('typed EXPLAIN ESTIMATE auto-selects the rich Estimate view', async () => {
    const h = makeHarness({ tab: { sqlDraft: 'EXPLAIN ESTIMATE SELECT 1' } });
    const session = createWorkbenchSession(h.deps);
    await session.run();
    const req = h.execFakes.executeRead.mock.calls[0][1] as ExecuteReadRequest;
    expect(req.sql).toBe('EXPLAIN ESTIMATE SELECT 1');
    expect(req.format).toBe('Table');
    expect(req.rowLimit).toBe(0);
    expect((h.tab.result as { explainView?: string } | null)?.explainView).toBe('estimate');
  });

  it('the Explain button forces a plain query into the verbatim Explain view', async () => {
    const h = makeHarness({ tab: { sqlDraft: 'SELECT 1' } });
    const session = createWorkbenchSession(h.deps);
    await session.run({ explain: true });
    expect(h.state.forceExplain).toBe(true);
    const req = h.execFakes.executeRead.mock.calls[0][1] as ExecuteReadRequest;
    expect(req.sql).toBe('EXPLAIN SELECT 1');
    expect(req.format).toBe('TabSeparatedRaw');
  });

  it('an explicit explainView option wins over auto-detection and preserves forceExplain', async () => {
    const h = makeHarness({ state: { forceExplain: true }, tab: { sqlDraft: 'SELECT 1' } });
    const session = createWorkbenchSession(h.deps);
    await session.run({ explainView: 'pipeline' });
    expect(h.state.forceExplain).toBe(true); // preserved, not reset (opts.explainView was given)
    const req = h.execFakes.executeRead.mock.calls[0][1] as ExecuteReadRequest;
    expect(req.sql).toBe('EXPLAIN PIPELINE graph = 1 SELECT 1');
    expect((h.tab.result as { explainView?: string } | null)?.explainView).toBe('pipeline');
  });

  it('a normal Run clears a stale forceExplain flag', async () => {
    const h = makeHarness({ state: { forceExplain: true }, tab: { sqlDraft: 'SELECT 1' } });
    const session = createWorkbenchSession(h.deps);
    await session.run();
    expect(h.state.forceExplain).toBe(false);
  });

  it("opts.view='chart' restores the legacy alias as 'panel'", async () => {
    const h = makeHarness({ tab: { sqlDraft: 'SELECT 1' } });
    const session = createWorkbenchSession(h.deps);
    await session.run({ view: 'chart' });
    expect(h.state.resultView.value).toBe('panel');
  });

  it("an unrecognized opts.view leaves resultView unchanged", async () => {
    const h = makeHarness({ state: { resultView: signal('json') }, tab: { sqlDraft: 'SELECT 1' } });
    const session = createWorkbenchSession(h.deps);
    await session.run({ view: 'bogus' });
    expect(h.state.resultView.value).toBe('json');
  });

  it('sets bookkeeping (elapsedMs) BEFORE flipping `running` true (batch ordering)', async () => {
    const h = makeHarness({ tab: { sqlDraft: 'SELECT 1' } });
    const session = createWorkbenchSession(h.deps);
    let elapsedAtFlip: number | null = null;
    let sawTrue = false;
    const { effect } = await import('@preact/signals-core');
    const dispose = effect(() => {
      if (h.state.running.value && !sawTrue) {
        sawTrue = true;
        elapsedAtFlip = session.elapsedMs();
      }
    });
    await session.run();
    dispose();
    expect(sawTrue).toBe(true);
    expect(elapsedAtFlip).not.toBeNull();
    expect(elapsedAtFlip).toBeGreaterThan(0);
  });

  it('records elapsed_ns BEFORE flipping `running` false (finally teardown order)', async () => {
    const h = makeHarness({ tab: { sqlDraft: 'SELECT 1' } });
    const session = createWorkbenchSession(h.deps);
    let elapsedNsAtFalse: number | null = null;
    let transitions = 0;
    const { effect } = await import('@preact/signals-core');
    const dispose = effect(() => {
      const running = h.state.running.value;
      transitions += 1;
      if (transitions > 1 && !running) {
        elapsedNsAtFalse = (h.tab.result as { progress: { elapsed_ns: number } } | null)?.progress.elapsed_ns ?? null;
      }
    });
    await session.run();
    dispose();
    expect(elapsedNsAtFalse).not.toBeNull();
    expect(elapsedNsAtFalse).toBeGreaterThan(0);
  });
});

// ── runScript() ──────────────────────────────────────────────────────────────

describe('createWorkbenchSession: runScript()', () => {
  it('guards while already running', async () => {
    const h = makeHarness({ state: { running: signal(true) } });
    const session = createWorkbenchSession(h.deps);
    await session.runScript(['SELECT 1'], 'SELECT 1');
    expect(h.execFakes.executeScript).not.toHaveBeenCalled();
  });

  it('blocks (no exec call) when the var gate is blocked', async () => {
    const h = makeHarness({ hooks: { varGateBlocked: vi.fn(() => true) } });
    const session = createWorkbenchSession(h.deps);
    await session.runScript(['SELECT 1'], 'SELECT 1'); // eslint-disable-line
    expect(h.execFakes.executeScript).not.toHaveBeenCalled();
  });

  it('auth failure (getToken → null): no exec call, fires onAuthFailed', async () => {
    const h = makeHarness({ getToken: async () => null });
    const session = createWorkbenchSession(h.deps);
    await session.runScript(['SELECT 1'], 'SELECT 1');
    expect(h.execFakes.executeScript).not.toHaveBeenCalled();
    expect(h.hooks.onAuthFailed).toHaveBeenCalledTimes(1);
  });

  it('flips `running` true eagerly, before the transport resolves', async () => {
    const h = makeHarness();
    const gate = deferred<ScriptExecutionResult>();
    h.execFakes.executeScript.mockImplementation(() => gate.promise);
    const session = createWorkbenchSession(h.deps);
    const p = session.runScript(['SELECT 1'], 'SELECT 1');
    await flush();
    expect(h.state.running.value).toBe(true);
    gate.resolve({ entries: [], aborted: false });
    await p;
    expect(h.state.running.value).toBe(false);
  });

  it('publishes a live query_id via onStatementStart; cancel() targets it', async () => {
    const h = makeHarness();
    const gate = deferred<ScriptExecutionResult>();
    let capturedSignal: AbortSignal | undefined;
    h.execFakes.executeScript.mockImplementation((req: ScriptExecutionRequest) => {
      capturedSignal = req.signal;
      req.onStatementStart(0, { queryId: 'q-live', attempt: 1 });
      return gate.promise;
    });
    const session = createWorkbenchSession(h.deps);
    const p = session.runScript(['SELECT 1'], 'SELECT 1');
    await flush();
    session.cancel();
    expect(h.execFakes.kill).toHaveBeenCalledWith('q-live');
    expect(capturedSignal?.aborted).toBe(true);
    gate.resolve({ entries: [], aborted: true });
    await p;
  });

  it('pushes entries + repaints + records boundParams via onStatementResult', async () => {
    const h = makeHarness({
      hooks: { prepareTabSource: vi.fn(() => preparedSource({ statements: [preparedStatement({ boundParams: [boundParam('p')] })] })) },
    });
    h.execFakes.executeScript.mockImplementation(async (req: ScriptExecutionRequest) => {
      req.onStatementStart(0, { queryId: 'q-1', attempt: 1 });
      req.onStatementResult(0, { sql: 'SELECT 1', status: 'rows', columns: [], rows: [], truncated: false, preview: '', ms: 1 });
      return { entries: [{ sql: 'SELECT 1', status: 'rows', columns: [], rows: [], truncated: false, preview: '', ms: 1 }], aborted: false };
    });
    const session = createWorkbenchSession(h.deps);
    await session.runScript(['SELECT 1'], 'SELECT 1');
    expect(h.hooks.renderResults).toHaveBeenCalled();
    expect(h.hooks.recordBoundParams).toHaveBeenCalledWith([boundParam('p')]);
  });

  it('an error entry never records boundParams for that statement, and blocks history', async () => {
    const h = makeHarness();
    h.execFakes.executeScript.mockImplementation(async (req: ScriptExecutionRequest) => {
      req.onStatementResult(0, { sql: 'SELECT 1', status: 'error', error: 'boom', ms: 1 });
      return { entries: [{ sql: 'SELECT 1', status: 'error', error: 'boom', ms: 1 }], aborted: false };
    });
    const session = createWorkbenchSession(h.deps);
    await session.runScript(['SELECT 1'], 'SELECT 1');
    expect(h.hooks.recordBoundParams).not.toHaveBeenCalled();
    expect(h.state.history).toEqual([]);
    expect(h.hooks.renderSavedHistory).not.toHaveBeenCalled();
  });

  it('a clean run records one script history entry, and repaints History when open', async () => {
    const h = makeHarness({ state: { sidePanel: signal('history') } });
    h.execFakes.executeScript.mockImplementation(async (req: ScriptExecutionRequest) => {
      const entry = { sql: 'SELECT 1', status: 'rows' as const, columns: [], rows: [], truncated: false, preview: '', ms: 5 };
      req.onStatementResult(0, entry);
      return { entries: [entry], aborted: false };
    });
    const session = createWorkbenchSession(h.deps);
    await session.runScript(['SELECT 1'], 'SELECT 1; SELECT 1;');
    expect(h.state.history).toHaveLength(1);
    expect(h.state.history[0].sql).toBe('SELECT 1; SELECT 1;');
    expect(h.hooks.renderSavedHistory).toHaveBeenCalled();
    expect(h.hooks.saveJSON).toHaveBeenCalled();
  });

  it('a clean run does not repaint History when a different side panel is open', async () => {
    const h = makeHarness({ state: { sidePanel: signal('saved') } });
    h.execFakes.executeScript.mockImplementation(async (req: ScriptExecutionRequest) => {
      const entry = { sql: 'SELECT 1', status: 'ok' as const, ms: 5 };
      req.onStatementResult(0, entry);
      return { entries: [entry], aborted: false };
    });
    const session = createWorkbenchSession(h.deps);
    await session.runScript(['SELECT 1'], 'SELECT 1;');
    expect(h.state.history).toHaveLength(1);
    expect(h.hooks.renderSavedHistory).not.toHaveBeenCalled();
  });

  it('sets `cancelled` on the script result when aborted', async () => {
    const h = makeHarness();
    h.execFakes.executeScript.mockImplementation(async () => ({ entries: [], aborted: true }));
    const session = createWorkbenchSession(h.deps);
    await session.runScript(['SELECT 1'], 'SELECT 1');
    expect((h.tab.result as { cancelled?: boolean } | null)?.cancelled).toBe(true);
    expect(h.state.history).toEqual([]); // aborted → no history, mirrors run()
  });

  it('reloads the schema after a schema-mutating statement even if a later one fails', async () => {
    const h = makeHarness({
      hooks: {
        prepareTabSource: vi.fn(() => preparedSource({
          statements: [
            preparedStatement({ sql: 'CREATE TABLE t (x Int32) ENGINE=Memory' }),
            preparedStatement({ sql: 'SELECT bogus' }),
          ],
        })),
      },
    });
    h.execFakes.executeScript.mockImplementation(async (req: ScriptExecutionRequest) => {
      const okEntry = { sql: 'CREATE TABLE t (x Int32) ENGINE=Memory', status: 'ok' as const, ms: 1 };
      const errEntry = { sql: 'SELECT bogus', status: 'error' as const, error: 'boom', ms: 1 };
      req.onStatementResult(0, okEntry);
      req.onStatementResult(1, errEntry);
      return { entries: [okEntry, errEntry], aborted: false };
    });
    const session = createWorkbenchSession(h.deps);
    await session.runScript(['CREATE TABLE t (x Int32) ENGINE=Memory', 'SELECT bogus'], 'CREATE TABLE t (x Int32) ENGINE=Memory; SELECT bogus;');
    expect(h.hooks.loadSchema).toHaveBeenCalled();
  });

  it('sends the per-statement wire SQL + merged session/args params to the transport', async () => {
    const h = makeHarness({
      hooks: {
        sessionParamsFor: vi.fn(() => ({ session_id: 'sess-1' })),
        prepareTabSource: vi.fn(() => preparedSource({
          statements: [preparedStatement({ sql: 'SELECT 1 /* exec */', args: { param_p: '1' } })],
        })),
      },
    });
    const session = createWorkbenchSession(h.deps);
    await session.runScript(['SELECT 1'], 'SELECT 1');
    const req = h.execFakes.executeScript.mock.calls[0][0] as ScriptExecutionRequest;
    expect(req.statements[0].execSql).toBe('SELECT 1 /* exec */');
    expect(req.statements[0].params).toEqual({ session_id: 'sess-1', param_p: '1' });
  });
});

// ── runEntry() ───────────────────────────────────────────────────────────────

describe('createWorkbenchSession: runEntry()', () => {
  it('does nothing outside SQL editor mode', async () => {
    const h = makeHarness({ tab: { editorMode: 'spec' } });
    const session = createWorkbenchSession(h.deps);
    await session.runEntry();
    expect(h.execFakes.executeRead).not.toHaveBeenCalled();
    expect(h.execFakes.executeScript).not.toHaveBeenCalled();
  });

  it('does nothing while already running', async () => {
    const h = makeHarness({ state: { running: signal(true) } });
    const session = createWorkbenchSession(h.deps);
    await session.runEntry();
    expect(h.execFakes.executeRead).not.toHaveBeenCalled();
  });

  it('does nothing for empty/comments-only input', async () => {
    const h = makeHarness({ tab: { sqlDraft: '-- just a comment' } });
    const session = createWorkbenchSession(h.deps);
    await session.runEntry();
    expect(h.execFakes.executeRead).not.toHaveBeenCalled();
  });

  it('runs the selection when one is present, overriding the tab draft', async () => {
    const h = makeHarness({
      tab: { sqlDraft: 'SELECT 1' },
      hooks: { getSelectionText: vi.fn(() => 'SELECT 2') },
    });
    const session = createWorkbenchSession(h.deps);
    await session.runEntry();
    const req = h.execFakes.executeRead.mock.calls[0][1] as ExecuteReadRequest;
    expect(req.sql).toBe('SELECT 2');
  });

  it('a multi-statement input runs as a script', async () => {
    const h = makeHarness({
      tab: { sqlDraft: 'SELECT 1; SELECT 2;' },
      hooks: {
        prepareTabSource: vi.fn(() => preparedSource({
          statements: [preparedStatement({ sql: 'SELECT 1' }), preparedStatement({ sql: 'SELECT 2' })],
        })),
      },
    });
    const session = createWorkbenchSession(h.deps);
    await session.runEntry();
    expect(h.execFakes.executeScript).toHaveBeenCalledTimes(1);
    expect(h.execFakes.executeRead).not.toHaveBeenCalled();
  });

  it('a Filter-role tab always runs (never scripts), even with multiple statements', async () => {
    const h = makeHarness({
      tab: { sqlDraft: 'SELECT 1; SELECT 2;', specParsed: { name: 'f', favorite: false, dashboard: { role: 'filter' } } },
    });
    const session = createWorkbenchSession(h.deps);
    await session.runEntry();
    expect(h.execFakes.executeScript).not.toHaveBeenCalled();
    expect(h.state.resultView.value).toBe('filter'); // the static multi-statement Filter error path
  });

  it('on mobile, jumps the bottom nav to Results', async () => {
    const h = makeHarness({ state: { isMobile: signal(true) }, tab: { sqlDraft: 'SELECT 1' } });
    const session = createWorkbenchSession(h.deps);
    await session.runEntry();
    expect(h.state.mobileView.value).toBe('results');
  });
});

// ── cancel() ─────────────────────────────────────────────────────────────────

describe('createWorkbenchSession: cancel()', () => {
  it('is a no-op while idle', () => {
    const h = makeHarness();
    const session = createWorkbenchSession(h.deps);
    session.cancel();
    expect(h.execFakes.kill).not.toHaveBeenCalled();
  });

  it('aborts the in-flight signal and kills the live query_id while running', async () => {
    const h = makeHarness({ tab: { sqlDraft: 'SELECT 1' } });
    const gate = deferred<StreamResult>();
    h.execFakes.executeRead.mockImplementation((result: StreamResult, req: ExecuteReadRequest) => {
      void req;
      return gate.promise;
    });
    const session = createWorkbenchSession(h.deps);
    const p = session.run();
    await flush();
    expect(h.state.running.value).toBe(true);
    const req = h.execFakes.executeRead.mock.calls[0][1] as ExecuteReadRequest;
    session.cancel();
    expect(req.signal?.aborted).toBe(true);
    expect(h.execFakes.kill).toHaveBeenCalledWith('q-1');
    gate.resolve({ ...req } as unknown as StreamResult);
    await p;
  });
});

// ── elapsedMs() ──────────────────────────────────────────────────────────────

describe('createWorkbenchSession: elapsedMs()', () => {
  it('is 0 while idle', () => {
    const h = makeHarness();
    const session = createWorkbenchSession(h.deps);
    expect(session.elapsedMs()).toBe(0);
  });

  it('reflects now() - t0 while running', async () => {
    const h = makeHarness({ tab: { sqlDraft: 'SELECT 1' } });
    const gate = deferred<StreamResult>();
    h.execFakes.executeRead.mockImplementation(() => gate.promise);
    const session = createWorkbenchSession(h.deps);
    const p = session.run();
    await flush();
    expect(session.elapsedMs()).toBeGreaterThan(0);
    gate.resolve({} as StreamResult);
    await p;
    expect(session.elapsedMs()).toBe(0);
  });
});

// ── attachShell() ────────────────────────────────────────────────────────────

describe('createWorkbenchSession: attachShell()', () => {
  function makeEffects(): WorkbenchShellEffects & { renderResults: ReturnType<typeof vi.fn>; setRunBtn: ReturnType<typeof vi.fn>; setMobileBadge: ReturnType<typeof vi.fn> } {
    return { renderResults: vi.fn(), setRunBtn: vi.fn(), setMobileBadge: vi.fn() };
  }

  it('fires all 3 effects once on attach', () => {
    const h = makeHarness();
    const session = createWorkbenchSession(h.deps);
    const fx = makeEffects();
    session.attachShell(fx);
    expect(fx.renderResults).toHaveBeenCalledTimes(1);
    expect(fx.setRunBtn).toHaveBeenCalledTimes(1);
    expect(fx.setMobileBadge).toHaveBeenCalledTimes(1);
  });

  it('the results + mobile-badge effects react to activeTabId/resultView/running', () => {
    const h = makeHarness();
    const session = createWorkbenchSession(h.deps);
    const fx = makeEffects();
    session.attachShell(fx);
    h.state.activeTabId.value = 't2';
    expect(fx.renderResults).toHaveBeenCalledTimes(2);
    expect(fx.setMobileBadge).toHaveBeenCalledTimes(2);
    expect(fx.setRunBtn).toHaveBeenCalledTimes(1); // unaffected by activeTabId
  });

  it('the Run-button effect reacts to hasSelection', () => {
    const h = makeHarness();
    const session = createWorkbenchSession(h.deps);
    const fx = makeEffects();
    session.attachShell(fx);
    h.state.hasSelection.value = true;
    expect(fx.setRunBtn).toHaveBeenCalledTimes(2);
    expect(fx.renderResults).toHaveBeenCalledTimes(1); // unaffected by hasSelection
  });

  it('re-attaching disposes the previous effect set (no double-fire)', () => {
    const h = makeHarness();
    const session = createWorkbenchSession(h.deps);
    const first = makeEffects();
    const second = makeEffects();
    session.attachShell(first);
    session.attachShell(second);
    h.state.activeTabId.value = 't2';
    expect(first.renderResults).toHaveBeenCalledTimes(1); // only the initial attach fire
    expect(second.renderResults).toHaveBeenCalledTimes(2); // initial + the signal write
  });

  it('destroy() disposes the attached effects (no fire after)', () => {
    const h = makeHarness();
    const session = createWorkbenchSession(h.deps);
    const fx = makeEffects();
    session.attachShell(fx);
    session.destroy();
    h.state.activeTabId.value = 't2';
    h.state.hasSelection.value = true;
    expect(fx.renderResults).toHaveBeenCalledTimes(1);
    expect(fx.setRunBtn).toHaveBeenCalledTimes(1);
    expect(fx.setMobileBadge).toHaveBeenCalledTimes(1);
  });
});

// ── destroy() ────────────────────────────────────────────────────────────────

describe('createWorkbenchSession: destroy()', () => {
  it('is a safe no-op while idle', () => {
    const h = makeHarness();
    const session = createWorkbenchSession(h.deps);
    expect(() => session.destroy()).not.toThrow();
    expect(h.execFakes.kill).not.toHaveBeenCalled();
  });

  it('mid-flight: clears the ticker, aborts, and kills the live query', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const h = makeHarness({ tab: { sqlDraft: 'SELECT 1' } });
    const gate = deferred<StreamResult>();
    h.execFakes.executeRead.mockImplementation(() => gate.promise);
    const session = createWorkbenchSession(h.deps);
    const p = session.run();
    await flush();
    const req = h.execFakes.executeRead.mock.calls[0][1] as ExecuteReadRequest;
    const callsBefore = clearSpy.mock.calls.length;
    session.destroy();
    expect(clearSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(req.signal?.aborted).toBe(true);
    expect(h.execFakes.kill).toHaveBeenCalledWith('q-1');
    gate.resolve({} as StreamResult);
    await p;
    clearSpy.mockRestore();
  });
});
