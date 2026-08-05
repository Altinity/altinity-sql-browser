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
function dashApp(
  renderFn: RenderDashboardFn,
  opts: { workspace: StoredWorkspaceV5; responder?: ExecResponder; wallNow?: () => number },
) {
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
    // #589 pass 2 finding 2: the `refreshTimeRangeLabels` sole-authority proof
    // needs the wave wall clock to genuinely advance across two refreshes —
    // `makeApp`'s own default (`wallNow: () => 0`) is fixed, so a fixture
    // that cares passes a real counter through here.
    ...(opts.wallNow ? { wallNow: opts.wallNow } : {}),
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
// creates — `engineSwitched`/`rebuildStructure` both true on a publish whose
// structural signature does NOT actually change — by stubbing only
// `planStructuralRebuild`'s OUTPUT (never its real grid/flow switching logic,
// which is already proved directly against the pure function in
// `dashboard-repaint-plan.test.ts`, "forces rebuildStructure on a switch even
// when ... byte-match a stale remembered one"). `planStructuralRebuild` is
// the function `ui/dashboard.ts`'s effect actually calls in production since
// #589 pass 2's interleaving fix (finding 1) — the batched
// `dashboardRepaintPlan` is no longer on the production call path, so
// stubbing IT would no longer reach the real effect at all. Every line of
// `ui/dashboard.ts` itself — including the exact commit statement under test
// — runs for real and unmocked. A second mock arms exactly one throw inside
// the REAL reconciler's per-tile loop (a KPI tile's content is recomputed by
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
        planStructuralRebuild: (memo: never, view: never, gridInvalidationRev: never) => {
          const out = real.planStructuralRebuild(memo, view, gridInvalidationRev);
          if (!forceSwitch) return out;
          return { ...out, engineSwitched: true, rebuildStructure: true };
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

// #589 ChatGPT review finding 1(a): the extracted effect used to call the
// planner FIRST and only commit `memo.mobile = mobileNow` after it returned
// — so a throw anywhere inside the planner (e.g. the persist-bag computation
// over a pathological variable value) left `memo.mobile` stale, unlike the
// pre-extraction code, where `lastMobile = mobileNow` was the literal first
// statement of the effect body, in BOTH branches, before any throw-prone
// computation ran. The fix commits `memo.mobile` unconditionally BEFORE
// calling `planRepublishFlow` (passing it `{ mobile: priorMobile }` for its
// own comparison).
//
// `memo` itself is private to `ui/dashboard.ts` — there's no accessor to read
// it from outside. But `planRepublishFlow` (the granular function
// `ui/dashboard.ts`'s effect actually calls first, per #589 pass 2's
// interleaving fix — finding 1) is a real module-level export, mockable
// exactly like every other sabotage test in this file, and its FIRST
// ARGUMENT on any given call is `{ mobile: <whatever memo.mobile was worth
// AT THAT MOMENT> }` — a snapshot of live state, taken for free by any mock
// wrapper. (A first attempt tried to observe this indirectly, through
// whether a LATER publish's `republishFlow` fires again — that turned out
// not to work: the viewer session's `buildState` reads the live
// `isMobile()` breakpoint fresh on EVERY publish for EVERY reason, so
// `view.layout.mobile` self-heals the moment any later session action runs,
// independently of `memo.mobile` entirely, and masks the very divergence
// this test needs. Capturing the ARGUMENT sidesteps that: it reads
// `memo.mobile` directly, before the planner does anything with it, so the
// self-heal is irrelevant.)
//
// So: arm `planRepublishFlow` to throw exactly once, on the publish where
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
        planRepublishFlow: (memo: never, view: never, mobileNow: never) => {
          capturedMobiles.push((memo as { mobile: boolean }).mobile);
          if (armThrow) { armThrow = false; throw new Error('injected planner fault'); }
          return real.planRepublishFlow(memo, view, mobileNow);
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
        planBarRebuild: (memo: never, view: never) => {
          const out = real.planBarRebuild(memo, view);
          calls += 1;
          // Leave the FIRST publish alone (it must genuinely build the bar —
          // there is nothing to prove "suppressed" against otherwise); force
          // every publish after that to never rebuild.
          if (calls === 1) return out;
          return { ...out, rebuildBar: false };
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
        planBarRebuild: (memo: never, view: never) => {
          const out = real.planBarRebuild(memo, view);
          return { ...out, rebuildBar: true };
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
// #589 pass 2: each block below mocks the GRANULAR `plan*` function that
// `ui/dashboard.ts`'s effect actually calls for that flag now (finding 1's
// interleaving fix moved production off the batched `dashboardRepaintPlan`
// entirely) — mocking the batched function would no longer reach the real
// effect at all.
describe('dashboard-repaint-plan wiring — persistVars is the effect\'s sole authority for the save seam', () => {
  it('a stubbed persistVars:false suppresses the save despite a genuinely committed value change', async () => {
    vi.resetModules();
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      return {
        ...real,
        planPersist: (memo: never, view: never) => {
          const out = real.planPersist(memo, view);
          return { ...out, persistVars: false };
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
        planPersist: (memo: never, view: never) => {
          const out = real.planPersist(memo, view);
          calls += 1;
          if (calls === 1) return out; // the first publish must genuinely settle
          return { ...out, persistVars: true };
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
        planStructuralRebuild: (memo: never, view: never, gridInvalidationRev: never) => {
          const out = real.planStructuralRebuild(memo, view, gridInvalidationRev);
          calls += 1;
          if (calls === 1) return out; // the first publish must genuinely build the grid
          return { ...out, rebuildStructure: false };
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
        planStructuralRebuild: (memo: never, view: never, gridInvalidationRev: never) => {
          const out = real.planStructuralRebuild(memo, view, gridInvalidationRev);
          return { ...out, rebuildStructure: true };
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
        planOptionsPush: (memo: never, view: never, rebuildBar: never) => {
          const out = real.planOptionsPush(memo, view, rebuildBar);
          return { ...out, pushOptions: false };
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
        planOptionsPush: (memo: never, view: never, rebuildBar: never) => {
          const out = real.planOptionsPush(memo, view, rebuildBar);
          calls += 1;
          if (calls === 1) return out; // the first publish must genuinely settle
          return { ...out, pushOptions: true };
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

// #589 pass 2 (ChatGPT review finding 1) — THE regression proof for this
// round. Pre-fix, `ui/dashboard.ts` called ONE batched `dashboardRepaintPlan`
// that computes bar/options/label/persist/structural ALL before returning —
// so a throw inside its persist computation (which calls
// `dashboardPersistBag`'s `valueString`/`String()` over every variable's
// `unknown` value, a real throw surface for a pathological value) propagated
// out of the WHOLE call before `ui/dashboard.ts` ever got to apply the bar
// rebuild it had already, separately, decided on. The fix splits that batch
// into six granular `plan*` functions (`dashboard-repaint-plan.ts`) that
// `ui/dashboard.ts`'s effect now calls and applies ONE AT A TIME, in
// production order — bar, then options, then labels, then persist, then
// structural — matching the pre-extraction interleaving exactly.
//
// This test poisons ONLY the persist decision — mocking `planPersist` to
// throw on exactly the one publish under test, standing in for a real
// pathological variable value reaching `dashboardPersistBag` (already proven
// directly at the pure-function level in `dashboard-repaint-plan.test.ts`,
// "the persist bag is never computed on the republishFlow branch" — a
// related but distinct proof) — on a publish that ALSO genuinely commits a
// new variable value, which triggers `rebuildBar`, an EARLIER decision in
// production order. If the interleaving fix holds, the bar rebuild's real
// DOM effect (a fresh `.var-field input` node, per `rebuildVariableBar`) is
// already in place despite the persist decision throwing immediately after.
describe('dashboard-repaint-plan wiring — compute/apply interleaving: a throw computing a LATER decision never undoes an EARLIER one already applied (finding 1, #589 pass 2)', () => {
  it('the bar rebuild triggered by a committed value change has already run before the SAME publish\'s persist-decision computation throws', async () => {
    vi.resetModules();
    let armThrow = false;
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      return {
        ...real,
        planPersist: (memo: never, view: never) => {
          if (armThrow) { armThrow = false; throw new Error('injected persist-decision fault'); }
          return real.planPersist(memo, view);
        },
      };
    });
    try {
      const { renderDashboard: mockedRender } = await import('../../src/ui/dashboard.js');
      const { app, render } = dashApp(mockedRender, { workspace: flowWorkspace() });
      await render();
      const before = variableInput(app);

      // `session.applyVariable` is async, so the synchronous throw deep
      // inside the signal-triggered effect surfaces as this commit's promise
      // REJECTING (mirrors the existing fault-injection test at the top of
      // this file) — captured explicitly so the throw is provably real
      // without failing the run on an "unhandled rejection".
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown, promise: Promise<unknown>): void => {
        rejections.push(reason);
        promise.catch(() => {});
      };
      process.prependListener('unhandledRejection', onRejection);
      armThrow = true;
      try {
        before.value = '9';
        before.dispatchEvent(new Event('input', { bubbles: true }));
        before.dispatchEvent(new Event('blur', { bubbles: true }));
        await flush(); await flush();
      } finally {
        process.off('unhandledRejection', onRejection);
      }
      expect(rejections).toHaveLength(1); // the injected fault genuinely fired
      expect(armThrow).toBe(false); // ...exactly once

      const saveJSON = app.saveJSON as ReturnType<typeof vi.fn>;
      // The persist decision never got a chance to apply — it threw before
      // `ui/dashboard.ts` could even read a `persistVars` flag for it.
      expect(saveJSON).not.toHaveBeenCalled();
      // ...but the bar rebuild — computed AND APPLIED before the persist
      // decision was even computed, per production order — already ran for
      // this SAME publish, despite the throw immediately after it. Its DOM
      // proof: the control was genuinely rebuilt (a fresh node), not the
      // SAME node merely echoing the user's own uncommitted keystroke.
      expect(variableInput(app)).not.toBe(before);
    } finally {
      vi.doUnmock('../../src/dashboard/application/dashboard-repaint-plan.js');
      vi.resetModules();
    }
  });
});

// #589 pass 2 (ChatGPT review finding 2) — the "false" direction completing
// the two-directional `engineSwitched` proof. The "engine-switch throw-path
// sig reset" describe block above forces `engineSwitched`/`rebuildStructure`
// TRUE when reality says false (combined with a throw, for a different
// purpose) — that already stands as this proof's "true" direction. This test
// is the "false" direction: force `engineSwitched:false` specifically on the
// publish where reality genuinely needs it — the very FIRST publish, which
// always reports `engineSwitched: true` per `seedRepaintMemo`'s
// `engineRendered: null` seed (there is no real grid<->flow round trip
// drivable through this harness's DOM surface at all — see that describe
// block's own long comment on why).
//
// `engineSwitched`'s only observable side effect that ISN'T already
// `rebuildStructure`'s own job is the eager `memo.engineRendered =
// sview.layout.engine` commit (`ui/dashboard.ts`, beside `plan.engineSwitched`
// — now the granular `planStructuralRebuild`'s `engineSwitched` result).
// Suppressing it on the very first publish leaves `memo.engineRendered`
// stuck at its seeded `null` forever: `rebuildStructure`, `structuralSig`,
// and the reconciler are all left REAL/unmocked for the rest of this test —
// so the divergence this test observes is caused ONLY by the missing commit,
// nothing else.
describe('dashboard-repaint-plan wiring — engineSwitched\'s own commit is the effect\'s sole authority for engineRendered (finding 2 addendum, #589 pass 2)', () => {
  it('a stubbed engineSwitched:false on the very first publish leaves engineRendered uncommitted, so a later unrelated publish keeps re-detecting a "switch" and redundantly rebuilds the chrome', async () => {
    vi.resetModules();
    // Mounting a Dashboard runs more than one publish before it settles (the
    // initial synchronous publish, then at least one more once the tile
    // wave's async `executeRead` resolves) — every one of them must be
    // sabotaged, or a LATER publish still inside `render()`'s mount would
    // commit `memo.engineRendered` for real and defeat the whole test before
    // the tile-search step ever runs. `allowReal` is flipped by the TEST
    // itself, only once mount has fully settled.
    let allowReal = false;
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      return {
        ...real,
        planStructuralRebuild: (memo: never, view: never, gridInvalidationRev: never) => {
          const out = real.planStructuralRebuild(memo, view, gridInvalidationRev);
          if (allowReal) return out;
          return { ...out, engineSwitched: false };
        },
      };
    });
    try {
      const { renderDashboard: mockedRender } = await import('../../src/ui/dashboard.js');
      const { app, render } = dashApp(mockedRender, { workspace: gridWorkspace() });
      await render(); // mount: every publish sabotaged, but rebuildStructure stayed real (true) — mounts fine
      allowReal = true; // mount settled — every publish AFTER this point sees the REAL engineSwitched
      const grid = qs<HTMLElement>(app.root, '.dash-grid');
      expect(grid.classList.contains('dash-gg-grid')).toBe(true); // real chrome present despite the suppressed commit

      const replaceChildren = vi.spyOn(grid, 'replaceChildren');
      replaceChildren.mockClear();
      // A later, unrelated, purely synchronous publish (tile search) —
      // nothing about the grid model changed. With `engineSwitched` genuinely
      // committed on mount, `memo.engineRendered` would now read
      // 'grafana-grid', this publish's REAL (unmocked from here on)
      // `engineSwitched` would be false, and nothing would rebuild. Because
      // the mount publish's commit was suppressed, `memo.engineRendered` is
      // STILL `null` — the real, unmocked `planStructuralRebuild` computes
      // `engineSwitched = 'grafana-grid' !== null` as true YET AGAIN,
      // forcing a redundant rebuild that has nothing to do with
      // `rebuildStructure`'s own (separately, already-proven) sabotage.
      const search = qs<HTMLInputElement>(app.root, '.dash-tile-search');
      search.value = 'q';
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(replaceChildren).toHaveBeenCalled(); // the suppressed commit, not reality, is why this fired again
    } finally {
      vi.doUnmock('../../src/dashboard/application/dashboard-repaint-plan.js');
      vi.resetModules();
    }
  });
});

// #589 pass 2 (ChatGPT review finding 2) — the two-directional sole-authority
// proof for `republishFlow`, using the same mock-sabotage technique as the
// other six blocks above. `republishFlow`'s own distinguishing side effect is
// the session resync (`syncSessionDocument` → `session.syncDocument`) — wrap
// the REAL `createDashboardViewerSession` so the returned session's
// `syncDocument` is independently spy-able (the same technique as
// `pushOptions`'s `mockVariableBarOptionsSpy` above, applied to a different
// seam).
describe('dashboard-repaint-plan wiring — republishFlow is the effect\'s sole authority for the session resync', () => {
  function mockSessionSyncDocumentSpy(): { spy: () => ReturnType<typeof vi.fn> | undefined } {
    let spy: ReturnType<typeof vi.fn> | undefined;
    vi.doMock('../../src/dashboard/application/dashboard-viewer-session.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-viewer-session.js')>();
      return {
        ...real,
        createDashboardViewerSession: (...args: Parameters<typeof real.createDashboardViewerSession>) => {
          const session = real.createDashboardViewerSession(...args);
          const syncDocument = vi.fn(session.syncDocument);
          spy = syncDocument;
          return { ...session, syncDocument };
        },
      };
    });
    return { spy: () => spy };
  }

  it('a stubbed republishFlow:false suppresses the session resync despite a genuine mobile-breakpoint flip', async () => {
    vi.resetModules();
    const { spy } = mockSessionSyncDocumentSpy();
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      let calls = 0;
      return {
        ...real,
        planRepublishFlow: (memo: never, view: never, mobileNow: never) => {
          const out = real.planRepublishFlow(memo, view, mobileNow);
          calls += 1;
          if (calls === 1) return out; // the first publish must genuinely settle
          return { republishFlow: false };
        },
      };
    });
    try {
      const { renderDashboard: mockedRender } = await import('../../src/ui/dashboard.js');
      const { app, render } = dashApp(mockedRender, { workspace: flowWorkspace() });
      await render(); // settles: flow engine, mobile initially false
      spy()!.mockClear();
      // A genuine republishFlow-eligible publish: flow engine, mobileNow
      // flips, and the flow model itself hasn't caught up yet (same trigger
      // as the "finding 1a" describe block above).
      app.state.isMobile.value = true;
      expect(spy()).not.toHaveBeenCalled(); // suppressed — the stub, not the genuine flip, decided
    } finally {
      vi.doUnmock('../../src/dashboard/application/dashboard-viewer-session.js');
      vi.doUnmock('../../src/dashboard/application/dashboard-repaint-plan.js');
      vi.resetModules();
    }
  });

  it('a stubbed republishFlow:true forces a session resync even though the mobile breakpoint never moved', async () => {
    vi.resetModules();
    const { spy } = mockSessionSyncDocumentSpy();
    // `allowForce` is flipped by the TEST itself only once mount has fully
    // settled (mounting runs more than one publish — the initial synchronous
    // one, then at least one more once the tile wave's async `executeRead`
    // resolves — forcing `true` during any of those would be indistinguishable
    // noise). `forced` then ensures the force fires EXACTLY once after that:
    // `syncSessionDocument`'s own resync republishes the session, re-running
    // this same effect, and forcing `true` again on THAT recursive run (with
    // `mobileNow` still unchanged) would force it forever, looping.
    let allowForce = false;
    let forced = false;
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      return {
        ...real,
        planRepublishFlow: (memo: never, view: never, mobileNow: never) => {
          const out = real.planRepublishFlow(memo, view, mobileNow);
          if (!allowForce || forced) return out;
          forced = true;
          return { republishFlow: true };
        },
      };
    });
    try {
      const { renderDashboard: mockedRender } = await import('../../src/ui/dashboard.js');
      const { app, render } = dashApp(mockedRender, { workspace: flowWorkspace() });
      await render();
      allowForce = true; // mount settled — the NEXT publish is the one under test
      spy()!.mockClear();
      // A publish triggered by tile search alone — the mobile breakpoint
      // never moved.
      const search = qs<HTMLInputElement>(app.root, '.dash-tile-search');
      search.value = 'q';
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(spy()).toHaveBeenCalledTimes(1); // resynced anyway — the stub, not reality, drove it
    } finally {
      vi.doUnmock('../../src/dashboard/application/dashboard-viewer-session.js');
      vi.doUnmock('../../src/dashboard/application/dashboard-repaint-plan.js');
      vi.resetModules();
    }
  });
});

// #589 pass 2 (ChatGPT review finding 2) — the two-directional sole-authority
// proof for `refreshTimeRangeLabels`, completing the set alongside
// `rebuildBar`/`persistVars`/`rebuildStructure`/`pushOptions` above and
// `republishFlow`/`engineSwitched` just above this block.
describe('dashboard-repaint-plan wiring — refreshTimeRangeLabels is the effect\'s sole authority for the in-place label refresh', () => {
  /** Wraps the REAL `buildVariableBar` so the wrapped bar's
   *  `refreshTimeRangeLabels` is independently spy-able — same technique as
   *  `pushOptions`'s `mockVariableBarOptionsSpy` above, against a different
   *  method on the same handle. */
  function mockVariableBarRefreshLabelsSpy(): { spy: () => ReturnType<typeof vi.fn> | undefined } {
    let spy: ReturnType<typeof vi.fn> | undefined;
    vi.doMock('../../src/ui/variable-bar.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/ui/variable-bar.js')>();
      return {
        ...real,
        buildVariableBar: (...args: Parameters<typeof real.buildVariableBar>) => {
          const handle = real.buildVariableBar(...args);
          const refreshTimeRangeLabels = vi.fn(handle.refreshTimeRangeLabels);
          spy = refreshTimeRangeLabels;
          return { ...handle, refreshTimeRangeLabels };
        },
      };
    });
    return { spy: () => spy };
  }

  it('a stubbed refreshTimeRangeLabels:false suppresses the label refresh despite the wave clock genuinely advancing', async () => {
    vi.resetModules();
    const { spy } = mockVariableBarRefreshLabelsSpy();
    let wallNowMs = 0;
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      let calls = 0;
      return {
        ...real,
        planLabelRefresh: (memo: never, view: never, rebuildBar: never) => {
          const out = real.planLabelRefresh(memo, view, rebuildBar);
          calls += 1;
          if (calls === 1) return out; // the first publish must genuinely settle
          return { ...out, refreshTimeRangeLabels: false };
        },
      };
    });
    try {
      const { renderDashboard: mockedRender } = await import('../../src/ui/dashboard.js');
      const { app, render } = dashApp(mockedRender, { workspace: flowWorkspace(), wallNow: () => wallNowMs });
      await render();
      spy()!.mockClear();
      // A genuine wave-clock advance with no committed-variable change: a
      // plain refresh (no rebuildBar) whose wall clock has moved.
      wallNowMs = 1000;
      await (qs<HTMLButtonElement>(app.root, '.dash-refresh').onclick as (() => Promise<void>) | null)?.();
      expect(spy()).not.toHaveBeenCalled(); // suppressed — the stub, not the real wave-clock advance, decided
    } finally {
      vi.doUnmock('../../src/ui/variable-bar.js');
      vi.doUnmock('../../src/dashboard/application/dashboard-repaint-plan.js');
      vi.resetModules();
    }
  });

  it('a stubbed refreshTimeRangeLabels:true forces the label refresh even though the wave clock has not moved', async () => {
    vi.resetModules();
    const { spy } = mockVariableBarRefreshLabelsSpy();
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      return {
        ...real,
        planLabelRefresh: (memo: never, view: never, rebuildBar: never) => {
          const out = real.planLabelRefresh(memo, view, rebuildBar);
          return { ...out, refreshTimeRangeLabels: true };
        },
      };
    });
    try {
      const { renderDashboard: mockedRender } = await import('../../src/ui/dashboard.js');
      const { app, render } = dashApp(mockedRender, { workspace: flowWorkspace() });
      await render();
      spy()!.mockClear();
      // A publish triggered by tile search alone — the wave clock is
      // untouched (fake-app's default `wallNow` is a fixed `() => 0`).
      const search = qs<HTMLInputElement>(app.root, '.dash-tile-search');
      search.value = 'q';
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(spy()).toHaveBeenCalled(); // refreshed anyway — the stub, not reality, drove it
    } finally {
      vi.doUnmock('../../src/ui/variable-bar.js');
      vi.doUnmock('../../src/dashboard/application/dashboard-repaint-plan.js');
      vi.resetModules();
    }
  });
});

// #589 pass 3 (ChatGPT review finding B): the "compute/apply interleaving"
// proof above (~line 856) only covers ONE stage boundary — a bar rebuild
// already applied survives a SAME-publish `planPersist` throw. It says
// nothing about the two stages that sit BETWEEN bar and persist in
// production order (`ui/dashboard.ts`'s effect: bar, then options, then
// labels, then persist, then structural) — `planOptionsPush` and
// `planLabelRefresh`. A regression that re-batched or reordered JUST those
// two middle stages relative to persist would leave the existing test green.
//
// `planOptionsPush`/`planLabelRefresh` are BOTH gated `!rebuildBar` (see
// their own doc comments in `dashboard-repaint-plan.ts`) — a committed
// value/active change (the existing test's trigger, which always sets
// `rebuildBar: true`) can therefore never make either of them fire on the
// SAME publish. So this gap can't be closed by strengthening that same
// test's trigger; it needs a publish where `rebuildBar` is false and
// `pushOptions`/`refreshTimeRangeLabels` are genuinely live instead —
// `session.refresh()` never touches committed variable state, so every
// publish it produces has `rebuildBar: false` by construction.
//
// Each test below tags every publish with a monotonic generation number —
// bumped by a wrapped `planBarRebuild`, the ONE decision `ui/dashboard.ts`
// calls first in EVERY publish, before options/label/persist, so its call
// count is a reliable per-publish boundary marker independent of any
// reordering AMONG options/label/persist (the exact regression class this
// proof targets). The spy-wrapped `setVariableOptions`/
// `refreshTimeRangeLabels` record the generation they were REALLY called in;
// the mocked `planPersist` throws only once armed, and only when the
// recorded generation matches the CURRENT generation at the moment persist
// itself is called. This is deliberately NOT the same as recomputing the
// decision from `memo` at persist-call time — after a CORRECT (bar, options,
// labels, persist) sequence, `ui/dashboard.ts` has already committed
// `memo.optionsSig`/`memo.labelWaveNowMs` for this publish before ever
// calling `planPersist`, so a recompute against the live `memo` at that point
// always reads "unchanged" and could never observe the real mismatch — it
// would need to compare against the PRE-publish memo, which is exactly what
// generation-tagging the REAL side-effect call sidesteps: it needs no
// `memo` at all, so the comparison is correct regardless of what
// `ui/dashboard.ts` has already committed by the time persist runs.
// Generation-tagging also survives the fact that ONE user click produces
// SEVERAL real publishes internally (`session.refresh()` calls `publish()`
// repeatedly — once eagerly, then again per tile-lifecycle transition, then
// once more once the option batch lands) — a same-publish proof that instead
// tracked only "was it EVER applied before this throw" would be fooled by a
// regression that reorders persist ahead of options/labels WITHIN one
// publish, because the side effect would still (correctly) apply on a LATER
// publish before persist ever throws on it — passing for the wrong reason.
// Generation-tagging closes that gap: a reordered publish never matches its
// OWN generation, so the throw would never fire and `expect(threw).toBe(true)`
// would fail outright — this was confirmed by sabotage-verification (see the
// #589 pass 3 PR description) before finalizing this technique.
describe('dashboard-repaint-plan wiring — compute/apply interleaving: options-push and label-refresh each survive a same-publish persist throw (finding B, #589 pass 3)', () => {
  const userWorkspace = () => wsWith({
    queries: [q('q1', 'SELECT 1 WHERE u IN {user:Array(String)}')],
    tiles: [{ id: 't1', queryId: 'q1' }],
    variableConfigs: { user: { sql: 'SELECT a, b FROM users' } },
  });

  it('pushOptions has already applied its real side effect before a same-publish persist throw', async () => {
    vi.resetModules();
    let publishGen = 0;
    let optionsSpy: ReturnType<typeof vi.fn> | undefined;
    let pushedAtGen = -1;
    vi.doMock('../../src/ui/variable-bar.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/ui/variable-bar.js')>();
      return {
        ...real,
        buildVariableBar: (...args: Parameters<typeof real.buildVariableBar>) => {
          const handle = real.buildVariableBar(...args);
          const setVariableOptions = vi.fn((...cbArgs: Parameters<typeof handle.setVariableOptions>) => {
            pushedAtGen = publishGen;
            return handle.setVariableOptions(...cbArgs);
          });
          optionsSpy = setVariableOptions;
          return { ...handle, setVariableOptions };
        },
      };
    });
    let armed = false;
    let thrown = false;
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      return {
        ...real,
        planBarRebuild: (memo: never, view: never) => {
          publishGen += 1;
          return real.planBarRebuild(memo, view);
        },
        planPersist: (memo: never, view: never) => {
          if (armed && !thrown && pushedAtGen === publishGen) {
            thrown = true;
            throw new Error('injected persist-decision fault');
          }
          return real.planPersist(memo, view);
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
      await render(); // mount settles — every publish from here on carries rebuildBar:false (no committed-value change ever happens in this test)
      armed = true;
      optionsSpy!.mockClear();
      // A genuinely NEW option batch (`optionsSig` differs) — no variable
      // value/active change, so `rebuildBar` stays false and `pushOptions`
      // goes live on the publish that lands it.
      optionRows = [['user', 'ada', 'Ada'], ['user', 'bo', 'Bo'], ['user', 'cy', 'Cy']];
      let threw = false;
      try {
        await (qs<HTMLButtonElement>(app.root, '.dash-refresh').onclick as (() => Promise<void>) | null)?.();
      } catch {
        threw = true;
      }
      expect(threw).toBe(true); // sanity: the injected fault genuinely fired
      expect(thrown).toBe(true); // ...on the exact publish where pushOptions applied for real

      const saveJSON = app.saveJSON as ReturnType<typeof vi.fn>;
      // The persist decision never got a chance to apply.
      expect(saveJSON).not.toHaveBeenCalled();
      // ...but the option push — computed AND APPLIED before the persist
      // decision was even computed, per production order (bar, then
      // options, then labels, then persist) — already ran for real on this
      // SAME publish, despite the throw immediately after it.
      expect(optionsSpy).toHaveBeenCalled();
    } finally {
      vi.doUnmock('../../src/ui/variable-bar.js');
      vi.doUnmock('../../src/dashboard/application/dashboard-repaint-plan.js');
      vi.resetModules();
    }
  });

  it('refreshTimeRangeLabels has already applied its real side effect before a same-publish persist throw', async () => {
    vi.resetModules();
    let publishGen = 0;
    let labelSpy: ReturnType<typeof vi.fn> | undefined;
    let refreshedAtGen = -1;
    vi.doMock('../../src/ui/variable-bar.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/ui/variable-bar.js')>();
      return {
        ...real,
        buildVariableBar: (...args: Parameters<typeof real.buildVariableBar>) => {
          const handle = real.buildVariableBar(...args);
          const refreshTimeRangeLabels = vi.fn((...cbArgs: Parameters<typeof handle.refreshTimeRangeLabels>) => {
            refreshedAtGen = publishGen;
            return handle.refreshTimeRangeLabels(...cbArgs);
          });
          labelSpy = refreshTimeRangeLabels;
          return { ...handle, refreshTimeRangeLabels };
        },
      };
    });
    let armed = false;
    let thrown = false;
    vi.doMock('../../src/dashboard/application/dashboard-repaint-plan.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/dashboard/application/dashboard-repaint-plan.js')>();
      return {
        ...real,
        // Same generation-tagging technique as the pushOptions test above.
        planBarRebuild: (memo: never, view: never) => {
          publishGen += 1;
          return real.planBarRebuild(memo, view);
        },
        planPersist: (memo: never, view: never) => {
          if (armed && !thrown && refreshedAtGen === publishGen) {
            thrown = true;
            throw new Error('injected persist-decision fault');
          }
          return real.planPersist(memo, view);
        },
      };
    });
    let wallNowMs = 0;
    try {
      const { renderDashboard: mockedRender } = await import('../../src/ui/dashboard.js');
      const { app, render } = dashApp(mockedRender, { workspace: flowWorkspace(), wallNow: () => wallNowMs });
      await render(); // mount settles
      armed = true;
      labelSpy!.mockClear();
      // The wave clock genuinely advances — no committed-value change, so
      // `rebuildBar` stays false and `refreshTimeRangeLabels` goes live.
      wallNowMs = 1000;
      let threw = false;
      try {
        await (qs<HTMLButtonElement>(app.root, '.dash-refresh').onclick as (() => Promise<void>) | null)?.();
      } catch {
        threw = true;
      }
      expect(threw).toBe(true); // sanity: the injected fault genuinely fired
      expect(thrown).toBe(true); // ...on the exact publish where refreshTimeRangeLabels applied for real

      const saveJSON = app.saveJSON as ReturnType<typeof vi.fn>;
      // The persist decision never got a chance to apply.
      expect(saveJSON).not.toHaveBeenCalled();
      // ...but the label refresh — computed AND APPLIED before the persist
      // decision was even computed — already ran for real on this SAME
      // publish, with the genuinely advanced wave-clock value.
      expect(labelSpy).toHaveBeenCalledWith(1000);
    } finally {
      vi.doUnmock('../../src/ui/variable-bar.js');
      vi.doUnmock('../../src/dashboard/application/dashboard-repaint-plan.js');
      vi.resetModules();
    }
  });
});
