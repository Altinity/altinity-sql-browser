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

// ── shared fixtures/selectors for the sole-authority sabotage tests below ──
// (finding 2, #589 ChatGPT review) — one flow-engine, one grafana-grid-engine
// workspace, each with exactly one scalar variable, and the DOM selectors the
// sabotage tests read the effect's real side effects through.
const flowWorkspace = () => wsWith({
  queries: [q('q1', 'SELECT k, v FROM a WHERE n = {n:UInt8}')],
  tiles: [{ id: 't1', queryId: 'q1' }],
});
const gridWorkspace = () => wsWith({
  queries: [q('q1', 'SELECT k, v FROM a WHERE n = {n:UInt8}'), q('q2', 'SELECT k, v FROM b')],
  tiles: [{ id: 't1', queryId: 'q1' }, { id: 't2', queryId: 'q2' }],
  layout: { type: 'grafana-grid', version: 1, items: {} },
});
const variableInput = (app: TestApp): HTMLInputElement => qs<HTMLInputElement>(app.root, '.dash-variable-host .var-field input');
/** Mirrors `dashboard.test.ts`'s own `pickLayout` (not exported from there) —
 *  drives the real File-style Dashboard-style menu to a `change-layout`
 *  command, so a "genuine structural change" in these tests goes through the
 *  same DOM path a user would. */
function pickDashboardLayout(root: ParentNode | null, label: 'Grid' | 'Full' | 'Report' | '2 columns' | '3 columns'): void {
  const trigger = qs<HTMLButtonElement>(root, '.dash-style-btn');
  trigger.click();
  const row = qsa<HTMLButtonElement>(document.body, '.dash-style-menu .fm-item')
    .find((item) => item.querySelector('.fm-label')?.textContent === label);
  if (!row) throw new Error(`Missing Dashboard style option: ${label}`);
  row.click();
}

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

// #589 finding 2 regression: on an engine switch, `ui/dashboard.ts` must
// reset BOTH `memo.layoutSig`/`memo.gridSig` to `''` — not just commit
// `memo.engineRendered` — at the exact point it consumes
// `plan.engineSwitched`, mirroring the pre-extraction
// `git show origin/main:src/ui/dashboard.ts` (~line 2925), which did this
// unconditionally, ALL THREE in one statement, before the reconciler ran.
// Without that reset, a throw inside the reconciler's own tile loop — before
// it reaches its own `memo.gridSig = structuralSig` commit — leaves
// `engineRendered` eagerly advanced but the structural sig untouched; if the
// NEXT publish's freshly-computed structural sig happens to coincide with
// that untouched value (exactly what happens on a switch back to an
// unchanged layout), the coincidence masks the still-owed rebuild — the
// #291 bug class the original defensive reset existed to prevent.
//
// A genuine grid → flow → grid round trip can't be driven through the real
// `renderDashboard` DOM surface: the File-style layout menu (the only wired
// `change-layout` trigger) offers exclusively grafana-grid-shaped options —
// 'Grid'/'Full'/'Report'/'2 columns'/'3 columns' (#321 dropped the flow
// entries from the menu) — and no exposed app/command-port surface accepts
// an arbitrary `DashboardCommand`, so a test cannot dispatch
// `{ type: 'flow', ... }` directly even though `dashboard-commands.ts` still
// fully supports it. The only other route to a flow-typed document,
// `app.onWorkspaceExternallyChanged`, rebuilds the whole route
// (`session.destroy(); app.renderDashboard()`), which reseeds `memo` from
// scratch — destroying the very state this bug is about.
//
// So this proof manufactures the SAME precondition a real engine switch
// creates — `plan.engineSwitched`/`plan.rebuildStructure` both true on a
// publish whose structural signature does NOT actually change — by stubbing
// only `dashboardRepaintPlan`'s OUTPUT (never its real grid/flow switching
// logic, which is already proved directly against the pure function in
// `dashboard-repaint-plan.test.ts`, "forces rebuildStructure on a switch even
// when ... byte-match a stale remembered one"). Every line of `ui/dashboard.ts`
// itself — including the exact commit statement under test — runs for real
// and unmocked. A second mock arms exactly one throw inside the REAL
// reconciler's per-tile loop (a KPI tile's content is recomputed by
// `kpiContent`/`resolvePanel` on every publish, unlike a plain tile's
// `paintPanel`, which skips repainting on an unchanged `rows` reference — so
// a KPI tile is the only reliable way to force that call on a publish whose
// data has not changed), landing the throw BEFORE the reconciler's own sig
// commit, exactly reproducing the ordering a genuine engine-switch throw
// would hit.
describe('dashboard-repaint-plan wiring — engine-switch throw-path sig reset (finding 2, #589)', () => {
  it('a throw on a forced engine-switch publish still leaves the grid chrome rebuild owed on the next publish, and the next publish performs it', async () => {
    vi.resetModules();
    let forceSwitch = false;
    let armThrow = false;
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      return {
        ...real,
        dashboardRepaintPlan: (memo: never, input: never) => {
          const out = real.dashboardRepaintPlan(memo, input);
          if (!forceSwitch) return out;
          return { ...out, plan: { ...out.plan, engineSwitched: true, rebuildStructure: true } };
        },
      };
    });
    vi.doMock('../../src/core/panel-cfg.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/core/panel-cfg.js')>();
      return {
        ...real,
        resolvePanel: (...args: Parameters<typeof real.resolvePanel>) => {
          if (!armThrow) return real.resolvePanel(...args);
          armThrow = false;
          throw new Error('injected reconciliation fault');
        },
      };
    });
    try {
      const { renderDashboard: mockedRender } = await import('../../src/ui/dashboard.js');
      const { app, render } = dashApp(mockedRender, {
        workspace: wsWith({
          queries: [q('k1', 'SELECT 1 AS value', { panel: { cfg: { type: 'kpi' } } })],
          tiles: [{ id: 't1', queryId: 'k1' }],
          layout: { type: 'grafana-grid', version: 1, items: {} },
        }),
      });
      await render();
      const grid = qs<HTMLElement>(app.root, '.dash-grid');
      expect(grid.classList.contains('dash-gg-grid')).toBe(true); // settled: real grid chrome present

      const replaceChildren = vi.spyOn(grid, 'replaceChildren');
      replaceChildren.mockClear();

      // The critical publish: `dashboardRepaintPlan` is stubbed to report an
      // engine switch (forcing `ui/dashboard.ts`'s real commit line to run)
      // on a publish whose real structural signature has not changed, and
      // the reconciler's per-tile loop is armed to throw before it reaches
      // its own sig commit — triggered via the tile search box, a purely
      // synchronous, layout-independent action (mirrors the existing
      // fault-injection test above), so the throw propagates synchronously
      // out of this dispatch rather than surfacing as a promise rejection.
      forceSwitch = true;
      armThrow = true;
      const search = qs<HTMLInputElement>(app.root, '.dash-tile-search');
      search.value = 'k';
      let threw = false;
      try {
        search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      } catch {
        threw = true;
      }
      expect(threw).toBe(true); // sanity: the injected fault genuinely fired
      expect(armThrow).toBe(false); // ...and fired exactly once
      forceSwitch = false; // later publishes report the plan's REAL decision
      // The reconciler never reached its chrome-rebuild block.
      expect(replaceChildren).not.toHaveBeenCalled();

      // A later, unrelated, purely synchronous publish (clearing the search)
      // still owes the rebuild the throwing publish never performed — prove
      // it actually happens now.
      search.value = '';
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(replaceChildren).toHaveBeenCalledTimes(1);
      expect(grid.classList.contains('dash-gg-grid')).toBe(true); // chrome genuinely rebuilt, not just coincidentally already correct
    } finally {
      vi.doUnmock('../../src/dashboard/application/dashboard-repaint-plan.js');
      vi.doUnmock('../../src/core/panel-cfg.js');
      vi.resetModules();
    }
  });
});

// #589 ChatGPT review finding 1(a): the extracted effect used to call
// `dashboardRepaintPlan` FIRST and only commit `memo.mobile = mobileNow`
// after it returned — so a throw anywhere inside the planner (e.g. the
// persist-bag computation over a pathological variable value) left
// `memo.mobile` stale, unlike the pre-extraction code, where `lastMobile =
// mobileNow` was the literal first statement of the effect body, in BOTH
// branches, before any throw-prone computation ran. The fix commits
// `memo.mobile` unconditionally BEFORE calling the planner (passing it a
// shallow copy carrying the PRIOR mobile value for its own `republishFlow`
// comparison).
//
// `memo` itself is private to `ui/dashboard.ts` — there's no accessor to read
// it from outside. But `dashboardRepaintPlan` is a real module-level export,
// mockable exactly like every other sabotage test in this file, and its
// FIRST ARGUMENT on any given call is whatever `memo.mobile` was worth AT
// THAT MOMENT — a snapshot of live state, taken for free by any mock wrapper.
// (A first attempt tried to observe this indirectly, through whether a LATER
// publish's `republishFlow` fires again — that turned out not to work: the
// viewer session's `buildState` reads the live `isMobile()` breakpoint fresh
// on EVERY publish for EVERY reason, so `view.layout.mobile` self-heals the
// moment any later session action runs, independently of `memo.mobile`
// entirely, and masks the very divergence this test needs. Capturing the
// ARGUMENT sidesteps that: it reads `memo.mobile` directly, before the
// planner does anything with it, so the self-heal is irrelevant.)
//
// So: arm `dashboardRepaintPlan` to throw exactly once, on the publish where
// the mobile breakpoint flips (simulating a throw inside the real planner's
// heavier computation, without needing to poison a real variable value
// through the whole DOM/session stack — that poisoned-value proof is done
// directly against the pure function in `dashboard-repaint-plan.test.ts`).
// Then force a SECOND, unrelated, purely synchronous publish (tile search) —
// `mobileNow` unchanged — through the REAL (unmocked) planner, and inspect
// what `memo.mobile` was worth when THAT call was made:
//   - Fixed:  already `true` — committed before the throw, so the throw
//     never got a chance to leave it stale.
//   - Buggy:  still `false` — the throwing publish never reached either of
//     dashboard.ts's `memo.mobile = mobileNow` assignments (both live AFTER
//     the planner call), so the flip was lost.
describe('dashboard-repaint-plan wiring — memo.mobile commits before the planner call, even if the planner throws (finding 1a, #589 ChatGPT review)', () => {
  it('a throw inside the planner on a mobile-breakpoint-flip publish still leaves the flip accounted for — a later, unrelated publish sees it already committed', async () => {
    vi.resetModules();
    let armThrow = false;
    const capturedMobiles: boolean[] = [];
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      return {
        ...real,
        dashboardRepaintPlan: (memo: never, input: never) => {
          capturedMobiles.push((memo as { mobile: boolean }).mobile);
          if (armThrow) { armThrow = false; throw new Error('injected planner fault'); }
          return real.dashboardRepaintPlan(memo, input);
        },
      };
    });
    try {
      const { renderDashboard: mockedRender } = await import('../../src/ui/dashboard.js');
      const { app, render } = dashApp(mockedRender, { workspace: flowWorkspace() });
      await render(); // settles: flow engine, mobile initially false
      capturedMobiles.length = 0;

      // Flip the mobile breakpoint — a genuine republishFlow-eligible publish
      // (flow engine, mobileNow !== the committed mobile, and the flow model
      // itself hasn't caught up) — with the planner armed to throw on it.
      armThrow = true;
      let threw = false;
      try {
        app.state.isMobile.value = true;
      } catch {
        threw = true;
      }
      expect(threw).toBe(true); // sanity: the injected fault genuinely fired
      expect(armThrow).toBe(false); // ...exactly once
      // Both the buggy and fixed ordering read the SAME (pre-flip) value on
      // THIS call — the divergence is only in what happens to the live
      // `memo.mobile` AFTER this throwing call, not what this call was
      // handed. Not the differentiator; a sanity check that the mock is
      // wired to the right call.
      expect(capturedMobiles).toEqual([false]);

      // A later, UNRELATED, purely synchronous publish — tile search — with
      // mobileNow unchanged (still `true`) and the REAL (unmocked) planner.
      const search = qs<HTMLInputElement>(app.root, '.dash-tile-search');
      search.value = 'q';
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      // THE differentiator: what `memo.mobile` was worth when this second,
      // real call was made.
      expect(capturedMobiles).toEqual([false, true]);
    } finally {
      vi.doUnmock('../../src/dashboard/application/dashboard-repaint-plan.js');
      vi.resetModules();
    }
  });
});

describe('dashboard-repaint-plan wiring — the effect consumes the plan, not a recomputed decision', () => {
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

// #589 ChatGPT review finding 2: the `rebuildBar` sabotage proof above is a
// real "sole authority" proof, but it only covers ONE of the plan's seven
// flags — the PR's claim of "sole decision authority" was only actually
// proven for that one. The three blocks below extend the SAME two-directional
// mock-sabotage technique (force the flag true when reality says false, and
// false when reality says true; the DOM/side effect must follow the stub, not
// reality, in both directions) to `persistVars`, `rebuildStructure`, and
// `pushOptions` — the three most behaviorally significant flags beyond
// `rebuildBar`.
describe('dashboard-repaint-plan wiring — persistVars is the effect\'s sole authority for the save seam', () => {
  it('a stubbed persistVars:false suppresses the save despite a genuinely committed value change', async () => {
    vi.resetModules();
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      return {
        ...real,
        dashboardRepaintPlan: (memo: never, input: never) => {
          const out = real.dashboardRepaintPlan(memo, input);
          return { ...out, plan: { ...out.plan, persistVars: false } };
        },
      };
    });
    try {
      const { renderDashboard: mockedRender } = await import('../../src/ui/dashboard.js');
      const { app, render } = dashApp(mockedRender, { workspace: flowWorkspace() });
      await render();
      const saveJSON = app.saveJSON as ReturnType<typeof vi.fn>;
      const callsBefore = saveJSON.mock.calls.length;
      const input = variableInput(app);
      input.value = '9';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      await flush(); await flush();
      // The value genuinely committed (nothing else is stubbed), yet the save
      // seam never fired — the stub, not the real committed-value change,
      // decided.
      expect(saveJSON.mock.calls.length).toBe(callsBefore);
    } finally {
      vi.doUnmock('../../src/dashboard/application/dashboard-repaint-plan.js');
      vi.resetModules();
    }
  });

  it('a stubbed persistVars:true forces the save even though nothing about the committed variables changed', async () => {
    vi.resetModules();
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      let calls = 0;
      return {
        ...real,
        dashboardRepaintPlan: (memo: never, input: never) => {
          const out = real.dashboardRepaintPlan(memo, input);
          calls += 1;
          if (calls === 1) return out; // the first publish must genuinely settle
          return { ...out, plan: { ...out.plan, persistVars: true } };
        },
      };
    });
    try {
      const { renderDashboard: mockedRender } = await import('../../src/ui/dashboard.js');
      const { app, render } = dashApp(mockedRender, { workspace: flowWorkspace() });
      await render();
      const saveJSON = app.saveJSON as ReturnType<typeof vi.fn>;
      const callsBefore = saveJSON.mock.calls.length;
      // A publish triggered by tile search alone — no variable value/active changed.
      const search = qs<HTMLInputElement>(app.root, '.dash-tile-search');
      search.value = 'q';
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(saveJSON.mock.calls.length).toBeGreaterThan(callsBefore); // fired anyway — the stub, not reality, drove it
      expect(saveJSON).toHaveBeenCalledWith(KEYS.dashFilters, expect.anything());
    } finally {
      vi.doUnmock('../../src/dashboard/application/dashboard-repaint-plan.js');
      vi.resetModules();
    }
  });
});

describe('dashboard-repaint-plan wiring — rebuildStructure is the effect\'s sole authority for the grid/flow chrome rebuild', () => {
  it('a stubbed rebuildStructure:false suppresses the chrome rebuild despite a genuine style change', async () => {
    vi.resetModules();
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      let calls = 0;
      return {
        ...real,
        dashboardRepaintPlan: (memo: never, input: never) => {
          const out = real.dashboardRepaintPlan(memo, input);
          calls += 1;
          if (calls === 1) return out; // the first publish must genuinely build the grid
          return { ...out, plan: { ...out.plan, rebuildStructure: false } };
        },
      };
    });
    try {
      const { renderDashboard: mockedRender } = await import('../../src/ui/dashboard.js');
      const { app, render } = dashApp(mockedRender, { workspace: gridWorkspace() });
      await render();
      const grid = qs<HTMLElement>(app.root, '.dash-grid');
      const replaceChildren = vi.spyOn(grid, 'replaceChildren');
      replaceChildren.mockClear();
      // A genuine structural change: grid -> full is a real style/columns
      // change (`structuralSig` differs), the same engine throughout.
      pickDashboardLayout(app.root, 'Full');
      await flush();
      expect(replaceChildren).not.toHaveBeenCalled(); // suppressed — the stub, not the real change, decided
    } finally {
      vi.doUnmock('../../src/dashboard/application/dashboard-repaint-plan.js');
      vi.resetModules();
    }
  });

  it('a stubbed rebuildStructure:true forces the chrome rebuild even though nothing structural changed', async () => {
    vi.resetModules();
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      return {
        ...real,
        dashboardRepaintPlan: (memo: never, input: never) => {
          const out = real.dashboardRepaintPlan(memo, input);
          return { ...out, plan: { ...out.plan, rebuildStructure: true } };
        },
      };
    });
    try {
      const { renderDashboard: mockedRender } = await import('../../src/ui/dashboard.js');
      const { app, render } = dashApp(mockedRender, { workspace: gridWorkspace() });
      await render();
      const grid = qs<HTMLElement>(app.root, '.dash-grid');
      const replaceChildren = vi.spyOn(grid, 'replaceChildren');
      replaceChildren.mockClear();
      // A publish triggered by tile search alone — nothing about the grid
      // model changed.
      const search = qs<HTMLInputElement>(app.root, '.dash-tile-search');
      search.value = 'q';
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(replaceChildren).toHaveBeenCalled(); // rebuilt anyway — the stub, not reality, drove it
    } finally {
      vi.doUnmock('../../src/dashboard/application/dashboard-repaint-plan.js');
      vi.resetModules();
    }
  });
});

describe('dashboard-repaint-plan wiring — pushOptions is the effect\'s sole authority for the in-place option push', () => {
  const userWorkspace = () => wsWith({
    queries: [q('q1', 'SELECT 1 WHERE u IN {user:Array(String)}')],
    tiles: [{ id: 't1', queryId: 'q1' }],
    variableConfigs: { user: { sql: 'SELECT a, b FROM users' } },
  });
  /** Wraps the REAL `buildVariableBar` so the wrapped bar's `setVariableOptions`
   *  is independently spy-able — the effect's only observable action for this
   *  flag is a call through the bar handle in place (no DOM node it replaces,
   *  unlike `rebuildBar`'s full rebuild), so this is the direct analogue of
   *  spying on `grid.replaceChildren` above. */
  function mockVariableBarOptionsSpy(): { spy: () => ReturnType<typeof vi.fn> | undefined } {
    let spy: ReturnType<typeof vi.fn> | undefined;
    vi.doMock('../../src/ui/variable-bar.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/ui/variable-bar.js')>();
      return {
        ...real,
        buildVariableBar: (...args: Parameters<typeof real.buildVariableBar>) => {
          const handle = real.buildVariableBar(...args);
          const setVariableOptions = vi.fn(handle.setVariableOptions);
          spy = setVariableOptions;
          return { ...handle, setVariableOptions };
        },
      };
    });
    return { spy: () => spy };
  }

  it('a stubbed pushOptions:false suppresses the option push despite a genuinely landed batch', async () => {
    vi.resetModules();
    const { spy } = mockVariableBarOptionsSpy();
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      return {
        ...real,
        dashboardRepaintPlan: (memo: never, input: never) => {
          const out = real.dashboardRepaintPlan(memo, input);
          return { ...out, plan: { ...out.plan, pushOptions: false } };
        },
      };
    });
    let optionRows = [['user', 'ada', 'Ada'], ['user', 'bo', 'Bo']];
    try {
      const { renderDashboard: mockedRender } = await import('../../src/ui/dashboard.js');
      const { app, render } = dashApp(mockedRender, {
        responder: (sql) => (sql.includes('__variable_name')
          ? {
            columns: [{ name: '__variable_name', type: 'String' }, { name: 'v', type: 'String' }, { name: 'l', type: 'String' }],
            rows: optionRows,
          }
          : { columns: [{ name: 'n', type: 'UInt8' }], rows: [[1]] }),
        workspace: userWorkspace(),
      });
      await render();
      spy()!.mockClear();
      // A genuinely NEW option batch: refresh reruns the option SQL and this
      // time it returns a third row (`optionsSig` differs; the committed
      // value/active bag doesn't, so `rebuildBar` stays false and this is
      // isolated to `pushOptions`).
      optionRows = [['user', 'ada', 'Ada'], ['user', 'bo', 'Bo'], ['user', 'cy', 'Cy']];
      await (qs<HTMLButtonElement>(app.root, '.dash-refresh').onclick as (() => Promise<void>) | null)?.();
      expect(spy()).not.toHaveBeenCalled(); // suppressed — the stub, not the real landed batch, decided
    } finally {
      vi.doUnmock('../../src/ui/variable-bar.js');
      vi.doUnmock('../../src/dashboard/application/dashboard-repaint-plan.js');
      vi.resetModules();
    }
  });

  it('a stubbed pushOptions:true forces the option push even though nothing about the options changed', async () => {
    vi.resetModules();
    const { spy } = mockVariableBarOptionsSpy();
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      let calls = 0;
      return {
        ...real,
        dashboardRepaintPlan: (memo: never, input: never) => {
          const out = real.dashboardRepaintPlan(memo, input);
          calls += 1;
          if (calls === 1) return out; // the first publish must genuinely settle
          return { ...out, plan: { ...out.plan, pushOptions: true } };
        },
      };
    });
    try {
      const { renderDashboard: mockedRender } = await import('../../src/ui/dashboard.js');
      const { app, render } = dashApp(mockedRender, {
        responder: (sql) => (sql.includes('__variable_name')
          ? {
            columns: [{ name: '__variable_name', type: 'String' }, { name: 'v', type: 'String' }, { name: 'l', type: 'String' }],
            rows: [['user', 'ada', 'Ada'], ['user', 'bo', 'Bo']],
          }
          : { columns: [{ name: 'n', type: 'UInt8' }], rows: [[1]] }),
        workspace: userWorkspace(),
      });
      await render();
      spy()!.mockClear();
      // A publish triggered by tile search alone — nothing about the option
      // batch changed.
      const search = qs<HTMLInputElement>(app.root, '.dash-tile-search');
      search.value = 'q';
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(spy()).toHaveBeenCalled(); // pushed anyway — the stub, not reality, drove it
    } finally {
      vi.doUnmock('../../src/ui/variable-bar.js');
      vi.doUnmock('../../src/dashboard/application/dashboard-repaint-plan.js');
      vi.resetModules();
    }
  });
});

// #589 ChatGPT review finding 3: this test used to assert the persisted
// payload with `expect.objectContaining(...)` over a ONE-variable fixture —
// a partial matcher that cannot catch an extra field, an omitted field, or
// any other payload-shape drift, because it only checks the keys it lists.
// The fixture below carries three variables with genuinely different value
// shapes (a scalar, a real array, and one left inactive at its default) and
// the assertion is a full `toEqual` against the COMPLETE expected object —
// exact, not partial.
describe('dashboard-repaint-plan wiring — the persisted payload is the COMPLETE bag, exactly, not a partial match', () => {
  it('persists a scalar, an array, and an untouched-inactive variable exactly — no extra/missing/joined fields', async () => {
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
        queries: [q('q1', 'SELECT 1 WHERE u IN {user:Array(String)} AND n = {n:UInt8} AND m = {m:UInt8}')],
        tiles: [{ id: 't1', queryId: 'q1' }],
        variableConfigs: { user: { sql: 'SELECT a, b FROM users' } },
      }),
    });
    await render();

    // Commit the array-valued multiselect ('user').
    const trigger = qs<HTMLButtonElement>(app.root, '.ms-trigger');
    trigger.click();
    const boxes = [...document.querySelectorAll<HTMLInputElement>('.ms-option input[type="checkbox"]')];
    expect(boxes.length).toBeGreaterThan(0);
    for (const cb of boxes) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
    (document.querySelector('.ms-btn-primary') as HTMLButtonElement).click();
    await flush();

    // Commit the scalar variable ('n') through its plain text field, found by
    // its `.var-name` label — several `.var-field` controls are on screen now
    // (`user`, `n`, `m`), unlike the single-variable fixtures elsewhere in
    // this file.
    const nField = qsa<HTMLElement>(app.root, '.var-field')
      .find((label) => label.querySelector('.var-name')?.textContent === 'n')!;
    const nInput = qs<HTMLInputElement>(nField, 'input');
    nInput.value = '7';
    nInput.dispatchEvent(new Event('input', { bubbles: true }));
    nInput.dispatchEvent(new Event('blur', { bubbles: true }));
    await flush(); await flush();

    // 'm' is deliberately left untouched: its persisted entry must still be
    // present, inactive, at its default empty value — an omission here is
    // exactly the kind of drift a partial matcher would miss.
    const saveJSON = app.saveJSON as ReturnType<typeof vi.fn>;
    const payload = saveJSON.mock.calls.filter((c) => c[0] === KEYS.dashFilters).at(-1)!;
    expect(payload[1]).toEqual({
      d: {
        user: { value: ['ada', 'bo'], active: true },
        n: { value: '7', active: true },
        m: { value: '', active: false },
      },
    });
  });
});
