// #589 wave 1: integration proofs that the real `renderDashboard` effect
// actually WIRES to `dashboardRepaintPlan` — a genuine consumer of the
// planner's decision, not a parallel recomputation — and that the staged,
// field-by-field memo commit preserves partial-failure semantics when a side
// effect throws. Separate from `dashboard.test.ts` (which statically imports
// the real module graph): the planner-consumption proof below needs
// `vi.doMock` + a dynamic import of a FRESH module graph, which a file that
// also statically imports `ui/dashboard.js` cannot mix in safely.

import { describe, it, expect, vi } from 'vitest';
import { KEYS } from '../../src/state.js';
import { renderDashboard } from '../../src/ui/dashboard.js';
import type { DashboardRenderTarget } from '../../src/ui/dashboard.js';
import { makeApp } from '../helpers/fake-app.js';
import { savedQuery } from '../helpers/saved-query.js';
import type { SavedQueryFixture } from '../helpers/saved-query.js';
import type { App } from '../../src/ui/app.types.js';
import type { Column } from '../../src/core/panel-cfg.js';
import type { StoredWorkspaceV5 } from '../../src/generated/json-schema.types.js';

type TestApp = ReturnType<typeof makeApp>;
type RenderDashboardFn = typeof renderDashboard;

// `process` is a real Node global at runtime (Vitest's environment), but this
// project's tsconfig deliberately does not pull in @types/node's ambient
// globals (a browser-app posture, ADR-0002) — declare only the narrow shape
// this file actually uses.
declare const process: {
  prependListener(event: 'unhandledRejection', listener: (reason: unknown, promise: Promise<unknown>) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown, promise: Promise<unknown>) => void): void;
};

const qs = <T extends Element = HTMLElement>(root: ParentNode | null, selector: string): T =>
  (root as ParentNode).querySelector(selector) as T;
const qsa = <T extends Element = HTMLElement>(root: ParentNode | null, selector: string): T[] =>
  [...(root as ParentNode).querySelectorAll(selector)] as T[];
const rootEl = (app: App): HTMLElement => app.root as HTMLElement;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

type ExecuteReadResult = Parameters<App['exec']['executeRead']>[0];
type ExecuteReadOpts = Parameters<App['exec']['executeRead']>[1];
interface ExecResp { columns?: Column[]; rows?: unknown[][]; error?: string; bytes?: number }
type ExecResponder = (sql: string, params: Record<string, string>) => ExecResp | Promise<ExecResp>;

function makeExec(responder: ExecResponder = () => ({})) {
  const executeRead = vi.fn(async (result: ExecuteReadResult, opts: ExecuteReadOpts = {} as ExecuteReadOpts) => {
    const params = (opts.params ?? {}) as Record<string, string>;
    const resp = (await responder(opts.sql as string, params)) || {};
    result.columns = resp.columns ?? [{ name: 'k', type: 'String' }, { name: 'v', type: 'UInt64' }];
    result.rows = resp.rows ?? [['a', 1], ['b', 2]];
    result.progress = { ...result.progress, bytes: resp.bytes ?? 10, rows: (resp.rows ?? [[]]).length };
    result.error = resp.error ?? null;
    return result;
  });
  return executeRead;
}

const q = (id: string, sql: string, extra: Partial<SavedQueryFixture> = {}) =>
  savedQuery({ id, name: id, sql, ...extra });

interface WsOver {
  tiles?: StoredWorkspaceV5['dashboards'][number]['tiles'];
  layout?: Record<string, unknown>;
  queries?: ReturnType<typeof savedQuery>[];
  variableConfigs?: StoredWorkspaceV5['dashboards'][number]['variableConfigs'];
}
const wsWith = (over: WsOver = {}): StoredWorkspaceV5 => ({
  storageVersion: 5, id: 'w', key: 'workspace', name: 'W',
  queries: over.queries ?? [],
  dashboards: [{
    documentVersion: 2, id: 'd', title: 'My Dash', revision: 1,
    layout: over.layout ?? { type: 'flow', version: 1, preset: 'columns-2', items: {} },
    tiles: over.tiles ?? [],
    ...(over.variableConfigs ? { variableConfigs: over.variableConfigs } : {}),
  }],
} as unknown as StoredWorkspaceV5);

/** A trimmed `dashApp`/`render` pair (mirrors `dashboard.test.ts`'s own, which
 *  is private to that file) — parameterized on the `renderDashboard`
 *  function so the planner-consumption tests can pass a dynamically imported,
 *  freshly-mocked module graph while the fault-injection/array-payload tests
 *  use the real static import above. */
function dashApp(renderFn: RenderDashboardFn, opts: { workspace: StoredWorkspaceV5; responder?: ExecResponder }) {
  const executeRead = makeExec(opts.responder);
  let current: StoredWorkspaceV5 = opts.workspace;
  const commit = vi.fn(async (candidate: StoredWorkspaceV5) => {
    current = candidate;
    return { ok: true as const, workspace: candidate, dashboardRevision: candidate.dashboards[0]?.revision ?? null };
  });
  const app = makeApp({
    exec: { executeRead },
    workspace: {
      commit,
      loadById: async (id: string) => (current.id === id ? { status: 'ok' as const, workspace: current } : { status: 'empty' as const }),
    } as Partial<App['workspace']>,
    currentWorkspace: current,
    workspaceRouteStatus: 'ready',
    sqlRoute: { surface: 'dashboard', workspaceKey: current.key, mode: 'edit' },
  }) as TestApp;
  const headerSlot = document.createElement('div');
  const host = document.createElement('div');
  rootEl(app).replaceChildren(headerSlot, host);
  let surfaceGeneration = 0;
  app.captureSurfaceGeneration = () => surfaceGeneration;
  app.isSurfaceGenerationCurrent = (generation: number) => generation === surfaceGeneration;
  app.applyCommittedWorkspace(current);
  const target: DashboardRenderTarget = {
    host, dashboardId: current.dashboards[0]!.id, mode: 'edit', focus: null, scrollTop: null,
    setHeader: (header) => { headerSlot.replaceChildren(header); },
  };
  const render = (): Promise<void> => renderFn(app as unknown as Parameters<RenderDashboardFn>[0], target);
  return { app, render, commit };
}

// ── grid drag helpers (mirrors dashboard.test.ts's own, trimmed to what the
// fault-injection test needs: a grip-drag that lands back on its own home
// slot — a cancel/snap-back that bumps the grid-structure invalidation
// revision without publishing) ──────────────────────────────────────────────
function stubTileRects(cards: HTMLElement[]): void {
  cards.forEach((card, i) => {
    const rect = { left: i * 200, right: i * 200 + 150, top: 0, bottom: 50, width: 150, height: 50, x: i * 200, y: 0, toJSON: () => ({}) } as DOMRect;
    card.getBoundingClientRect = () => rect;
  });
}
const tileCenter = (i: number): { x: number; y: number } => ({ x: i * 200 + 75, y: 25 });
function gridSnapBackDrag(cards: HTMLElement[], fromIdx: number): void {
  const from = tileCenter(fromIdx);
  const grip = qs(cards[fromIdx], '.dash-gg-grip');
  grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: from.x, clientY: from.y }));
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x + 10, clientY: from.y }));
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: from.x, clientY: from.y })); // lands back on its own home slot
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: from.x, clientY: from.y }));
}

describe('dashboard-repaint-plan wiring — fault injection during a persist+structural-rebuild publish', () => {
  it('a saveJSON throw skips the structural rebuild owed by an unconsumed grid-invalidation revision; a later publish performs it, and saveJSON is called exactly once total', async () => {
    const { app, render } = dashApp(renderDashboard, {
      workspace: wsWith({
        queries: [q('q1', 'SELECT k, v FROM a WHERE n = {n:UInt8}'), q('q2', 'SELECT k, v FROM b')],
        tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
        layout: { type: 'grafana-grid', version: 1, items: {} },
      }),
    });
    await render();
    const grid = qs<HTMLElement>(app.root, '.dash-grid');
    const cards = qsa<HTMLElement>(app.root, '.dash-gg-tile');
    stubTileRects(cards);
    // Cancel/snap-back a grid drag: bumps the grid-structure invalidation
    // revision via a deterministic, synchronous DOM-only restore that never
    // touches `currentDoc` — no publish happens here (dashboard.ts's own
    // comment on `restoreDrag`), so the rebuild stays OWED until the next one.
    gridSnapBackDrag(cards, 0);

    const replaceChildren = vi.spyOn(grid, 'replaceChildren');
    replaceChildren.mockClear();
    const saveJSON = app.saveJSON as ReturnType<typeof vi.fn>;
    saveJSON.mockImplementationOnce(() => { throw new Error('storage blocked'); });

    // `session.applyVariable` is async, so a synchronous throw deep inside the
    // signal-triggered effect surfaces as this call's promise REJECTING, not
    // as a synchronous throw the DOM event dispatch propagates — exactly how
    // the real browser would behave for a fire-and-forget commit handler.
    // Capture it explicitly (and mark it handled) so the throw is provably
    // real without failing the run on an "unhandled rejection".
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown, promise: Promise<unknown>): void => {
      rejections.push(reason);
      promise.catch(() => {});
    };
    process.prependListener('unhandledRejection', onRejection);
    const input = qs<HTMLInputElement>(app.root, '.dash-variable-host .var-field input');
    try {
      input.value = '7';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      await flush(); await flush();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toHaveLength(1);
    // Persistence ran (and threw) — the effect's real ordering commits
    // `memo.persistSig` and calls the save seam BEFORE the structural
    // reconcile, so the throw aborts the rest of that publish outright.
    expect(saveJSON).toHaveBeenCalledTimes(1);
    expect(replaceChildren).not.toHaveBeenCalled();

    // A later publish — triggered by an unrelated, purely synchronous action
    // (`session.setTileSearch`, never async) so it carries no risk of a
    // second throw — still owes the structural rebuild (the invalidation
    // revision was never consumed on the throwing publish) and now performs
    // it. The committed variable value already matches what was persisted
    // right before the throw, so `saveJSON` is not called again.
    const searchInput = qs<HTMLInputElement>(app.root, '.dash-tile-search');
    searchInput.value = 'q';
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(replaceChildren).toHaveBeenCalledTimes(1);
    expect(saveJSON).toHaveBeenCalledTimes(1); // still once total — persistence was not retried
  });
});

describe('dashboard-repaint-plan wiring — the effect consumes the plan, not a recomputed decision', () => {
  const flowWorkspace = () => wsWith({
    queries: [q('q1', 'SELECT k, v FROM a WHERE n = {n:UInt8}')],
    tiles: [{ id: 't1', queryId: 'q1' }],
  });
  const variableInput = (app: TestApp): HTMLInputElement => qs<HTMLInputElement>(app.root, '.dash-variable-host .var-field input');

  it('a stubbed rebuildBar:false suppresses the DOM rebuild despite a genuinely committed value change', async () => {
    vi.resetModules();
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      let calls = 0;
      return {
        ...real,
        dashboardRepaintPlan: (memo: never, input: never) => {
          const out = real.dashboardRepaintPlan(memo, input);
          calls += 1;
          // Leave the FIRST publish alone (it must genuinely build the bar —
          // there is nothing to prove "suppressed" against otherwise); force
          // every publish after that to never rebuild.
          if (calls === 1) return out;
          return { ...out, plan: { ...out.plan, rebuildBar: false } };
        },
      };
    });
    try {
      const { renderDashboard: mockedRender } = await import('../../src/ui/dashboard.js');
      const { app, render } = dashApp(mockedRender, { workspace: flowWorkspace() });
      await render();
      const before = variableInput(app);
      before.value = '9';
      before.dispatchEvent(new Event('input', { bubbles: true }));
      before.dispatchEvent(new Event('blur', { bubbles: true }));
      await flush(); await flush();
      const saveJSON = app.saveJSON as ReturnType<typeof vi.fn>;
      // The value change genuinely reached the session/persist path...
      expect(saveJSON).toHaveBeenCalledWith(KEYS.dashFilters, expect.objectContaining({
        d: expect.objectContaining({ n: { value: '9', active: true } }),
      }));
      // ...yet the bar was never rebuilt: same DOM node, still showing '9'
      // only because the user's own keystroke set it, not because the app
      // rebuilt the control against the new committed state.
      expect(variableInput(app)).toBe(before);
    } finally {
      vi.doUnmock('../../src/dashboard/application/dashboard-repaint-plan.js');
      vi.resetModules();
    }
  });

  it('a stubbed rebuildBar:true forces the DOM rebuild even though nothing about the variable changed', async () => {
    vi.resetModules();
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      return {
        ...real,
        dashboardRepaintPlan: (memo: never, input: never) => {
          const out = real.dashboardRepaintPlan(memo, input);
          return { ...out, plan: { ...out.plan, rebuildBar: true } };
        },
      };
    });
    try {
      const { renderDashboard: mockedRender } = await import('../../src/ui/dashboard.js');
      const { app, render } = dashApp(mockedRender, { workspace: flowWorkspace() });
      await render();
      const before = variableInput(app);
      // A publish triggered by tile search alone — nothing about the
      // variable's committed value/active changed.
      const search = qs<HTMLInputElement>(app.root, '.dash-tile-search');
      search.value = 'q';
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(variableInput(app)).not.toBe(before); // rebuilt anyway — the stub, not reality, drove it
    } finally {
      vi.doUnmock('../../src/dashboard/application/dashboard-repaint-plan.js');
      vi.resetModules();
    }
  });
});

describe('dashboard-repaint-plan wiring — array-valued variable persistence through the real path', () => {
  it('preserves a committed multi-select array value as a real array in the persisted payload, never joined into a string', async () => {
    const { app, render } = dashApp(renderDashboard, {
      responder: (sql) => (sql.includes('__variable_name')
        ? {
          columns: [
            { name: '__variable_name', type: 'String' }, { name: 'v', type: 'String' }, { name: 'l', type: 'String' },
          ],
          rows: [['user', 'ada', 'Ada'], ['user', 'bo', 'Bo']],
        }
        : { columns: [{ name: 'n', type: 'UInt8' }], rows: [[1]] }),
      workspace: wsWith({
        queries: [q('q1', 'SELECT 1 WHERE u IN {user:Array(String)}')],
        tiles: [{ id: 't1', queryId: 'q1' }],
        variableConfigs: { user: { sql: 'SELECT a, b FROM users' } },
      }),
    });
    await render();
    const trigger = qs<HTMLButtonElement>(app.root, '.ms-trigger');
    trigger.click();
    const boxes = [...document.querySelectorAll<HTMLInputElement>('.ms-option input[type="checkbox"]')];
    expect(boxes.length).toBeGreaterThan(0);
    for (const cb of boxes) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
    (document.querySelector('.ms-btn-primary') as HTMLButtonElement).click();
    await flush();
    const saveJSON = app.saveJSON as ReturnType<typeof vi.fn>;
    expect(saveJSON).toHaveBeenCalledWith(KEYS.dashFilters, expect.objectContaining({
      d: expect.objectContaining({ user: { value: ['ada', 'bo'], active: true } }),
    }));
    const payload = saveJSON.mock.calls.find((c) => c[0] === KEYS.dashFilters)!;
    expect(Array.isArray((payload[1] as { d: { user: { value: unknown } } }).d.user.value)).toBe(true);
  });
});
