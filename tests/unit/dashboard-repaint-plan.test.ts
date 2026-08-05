// #589 wave 1: pure repaint arbitration extracted from `ui/dashboard.ts`'s
// `renderDashboard` effect. No DOM, no signals — a plain input/output test of
// `dashboardRepaintPlan`/`seedRepaintMemo`/`dashboardPersistBag`/`valueString`.

import { describe, expect, it } from 'vitest';
import {
  dashboardRepaintPlan, seedRepaintMemo, dashboardPersistBag, valueString,
} from '../../src/dashboard/application/dashboard-repaint-plan.js';
import type { RepaintMemo, RepaintSigs } from '../../src/dashboard/application/dashboard-repaint-plan.js';
import type { DashboardViewState, ViewerVariableState } from '../../src/dashboard/application/dashboard-viewer-session.js';
import type { GrafanaGridTileRender } from '../../src/dashboard/layouts/grafana-grid-layout.js';
import type { FlowTileRender } from '../../src/dashboard/layouts/flow-layout.js';

function variable(over: Partial<ViewerVariableState> = {}): ViewerVariableState {
  return {
    id: 'v1', parameter: 'v1', label: 'v1', active: false, value: '',
    status: 'idle', configured: false, optionsError: null, options: null,
    optionsRev: 0, optionsTruncated: false,
    ...over,
  };
}

function baseView(over: Partial<DashboardViewState> = {}): DashboardViewState {
  return {
    tiles: [], totalTileCount: 0, visibleTileCount: 0, tileSearch: '',
    resettableVariableIds: [], variableStates: [], variables: [],
    layout: { engine: 'flow', preset: 'report', columns: 2, mobile: false, rows: [], order: [] },
    style: 'grid', activeVariableCount: 0, running: false, updatedAt: null,
    lastSuccessWallMs: null, lastRefreshOutcome: null, diagnostics: [], optionDiagnostics: [],
    timeRangeDiagnostics: [], waveWallNowMs: null,
    ...over,
  };
}

function gridTile(over: Partial<GrafanaGridTileRender> = {}): GrafanaGridTileRender {
  return { tileId: 't1', index: 0, span: 6, persistedSpan: 6, heightUnits: 2, isKpi: false, row: 0, colStart: 0, ...over };
}

function flowTile(over: Partial<FlowTileRender> = {}): FlowTileRender {
  return { tileId: 't1', index: 0, span: 1, height: 'medium', isKpi: false, ...over };
}

function gridView(tiles: GrafanaGridTileRender[] = [gridTile()], gridOver: { columns?: number; style?: 'grid' | 'full' | 'report' } = {}): DashboardViewState {
  return baseView({
    layout: {
      engine: 'grafana-grid',
      grid: { engine: 'grafana-grid', columns: 12, style: 'grid', tiles, ...gridOver },
      renderMode: 'tiles',
    },
  });
}

/** Test-only "apply everything a fully-successful publish would" helper — the
 *  PRODUCTION effect never batches like this (see `dashboard.ts`'s staged
 *  commits beside the `effect()` call); this exists only to chain several
 *  `dashboardRepaintPlan` calls together the way a settled multi-publish
 *  sequence would, so a later test can assert "does not re-trigger". */
function settle(memo: RepaintMemo, view: DashboardViewState, mobileNow: boolean, gridInvalidationRev: number): RepaintMemo {
  const { plan, sigs } = dashboardRepaintPlan(memo, { view, mobileNow, gridInvalidationRev });
  const next: RepaintMemo = { ...memo, mobile: mobileNow };
  if (plan.republishFlow) return next;
  if (plan.rebuildBar) next.barSig = sigs.barSig;
  next.optionsSig = sigs.optionsSig;
  next.labelWaveNowMs = sigs.labelWaveNowMs;
  if (plan.persistVars) next.persistSig = sigs.persistSig;
  if (plan.engineSwitched) next.engineRendered = view.layout.engine;
  if (plan.rebuildStructure) {
    if (view.layout.engine === 'grafana-grid') {
      next.gridSig = sigs.structuralSig;
      next.consumedGridInvalidationRev = gridInvalidationRev;
    } else {
      next.layoutSig = sigs.structuralSig;
    }
  }
  return next;
}

describe('valueString', () => {
  it('passes a string through, coerces nullish to empty, and stringifies everything else', () => {
    expect(valueString('x')).toBe('x');
    expect(valueString(null)).toBe('');
    expect(valueString(undefined)).toBe('');
    expect(valueString(42)).toBe('42');
    expect(valueString(true)).toBe('true');
  });
});

describe('dashboardPersistBag', () => {
  it('coerces a scalar string value verbatim, keyed by variable id', () => {
    expect(dashboardPersistBag([variable({ id: 'n', value: '7', active: true })]))
      .toEqual({ n: { value: '7', active: true } });
  });

  it('coerces null/undefined to an empty string', () => {
    expect(dashboardPersistBag([variable({ id: 'n', value: null })])).toEqual({ n: { value: '', active: false } });
    expect(dashboardPersistBag([variable({ id: 'n', value: undefined })])).toEqual({ n: { value: '', active: false } });
  });

  it('stringifies a numeric value', () => {
    expect(dashboardPersistBag([variable({ id: 'n', value: 5 })])).toEqual({ n: { value: '5', active: false } });
  });

  it('preserves an array value as a real array, each element through valueString individually — never a joined string', () => {
    const bag = dashboardPersistBag([variable({ id: 'n', value: ['a', 'b', 1, null] })]);
    expect(bag).toEqual({ n: { value: ['a', 'b', '1', ''], active: false } });
    expect(Array.isArray(bag.n.value)).toBe(true);
  });
});

describe('seedRepaintMemo', () => {
  it('seeds structural/bar/options signatures empty, engine null, and mobile/label/persist from the real initial view', () => {
    const view = baseView({
      variableStates: [variable({ id: 'n', value: '42', active: true })],
      waveWallNowMs: 1000,
    });
    const memo = seedRepaintMemo({ mobileNow: true, view });
    expect(memo).toEqual({
      mobile: true,
      engineRendered: null,
      layoutSig: '',
      gridSig: '',
      barSig: '',
      optionsSig: '',
      labelWaveNowMs: 1000,
      persistSig: JSON.stringify([['n', '42', true]]),
      consumedGridInvalidationRev: 0,
    });
  });

  it('never writes on the very first publish that merely echoes the seeded state (persistSig matches immediately)', () => {
    const view = baseView({ variableStates: [variable({ id: 'n', value: '42', active: false })] });
    const memo = seedRepaintMemo({ mobileNow: false, view });
    const { plan } = dashboardRepaintPlan(memo, { view, mobileNow: false, gridInvalidationRev: 0 });
    expect(plan.persistVars).toBe(false);
  });
});

describe('dashboardRepaintPlan — first publish (unchanged initial view)', () => {
  it('rebuilds the bar and the active engine structure, but pushes/refreshes/persists nothing', () => {
    const view = baseView({
      variableStates: [variable({ id: 'n', value: '', active: false })],
      waveWallNowMs: 500,
    });
    const memo = seedRepaintMemo({ mobileNow: false, view });
    const { plan, sigs } = dashboardRepaintPlan(memo, { view, mobileNow: false, gridInvalidationRev: 0 });
    expect(plan).toEqual({
      republishFlow: false,
      rebuildBar: true,
      pushOptions: false,
      refreshTimeRangeLabels: false,
      persistVars: false,
      engineSwitched: true,
      rebuildStructure: true,
    });
    // sigs still advance so the caller has fresh values to commit.
    expect(sigs.labelWaveNowMs).toBe(500);
    expect(sigs.optionsSig).toBe(JSON.stringify([['n', false, 0, 'idle', null, false]]));
  });
});

describe('dashboardRepaintPlan — republishFlow (mobile breakpoint flip)', () => {
  it('fires only when the flow engine is active, the flip is NEW, and the layout has not caught up', () => {
    const view = baseView({ layout: { engine: 'flow', preset: 'report', columns: 2, mobile: false, rows: [], order: [] } });
    const memo = seedRepaintMemo({ mobileNow: false, view });
    const { plan } = dashboardRepaintPlan(memo, { view, mobileNow: true, gridInvalidationRev: 0 });
    expect(plan.republishFlow).toBe(true);
  });

  it('does not fire once the flow model itself already reports the new mobile flag', () => {
    const view = baseView({ layout: { engine: 'flow', preset: 'report', columns: 1, mobile: true, rows: [], order: [] } });
    const memo = seedRepaintMemo({ mobileNow: false, view });
    const { plan } = dashboardRepaintPlan(memo, { view, mobileNow: true, gridInvalidationRev: 0 });
    expect(plan.republishFlow).toBe(false);
  });

  it('never fires for the grafana-grid engine (it has no mobile concept of its own)', () => {
    const view = gridView();
    const memo = seedRepaintMemo({ mobileNow: false, view });
    const { plan } = dashboardRepaintPlan(memo, { view, mobileNow: true, gridInvalidationRev: 0 });
    expect(plan.republishFlow).toBe(false);
  });

  it('when it fires, every other flag is false and every sig echoes the memo unchanged — nothing else is decided', () => {
    const view = baseView({
      variableStates: [variable({ id: 'n', value: '9', active: true })],
      waveWallNowMs: 42,
      layout: { engine: 'flow', preset: 'report', columns: 2, mobile: false, rows: [], order: [] },
    });
    const memo: RepaintMemo = {
      mobile: false, engineRendered: 'flow', layoutSig: 'stale-layout-sig', gridSig: 'stale-grid-sig',
      barSig: 'stale-bar-sig', optionsSig: 'stale-options-sig', labelWaveNowMs: 7, persistSig: 'stale-persist-sig',
      consumedGridInvalidationRev: 0,
    };
    const { plan, sigs } = dashboardRepaintPlan(memo, { view, mobileNow: true, gridInvalidationRev: 0 });
    expect(plan).toEqual({
      republishFlow: true, rebuildBar: false, pushOptions: false, refreshTimeRangeLabels: false,
      persistVars: false, engineSwitched: false, rebuildStructure: false,
    });
    expect(sigs.barSig).toBe(memo.barSig);
    expect(sigs.optionsSig).toBe(memo.optionsSig);
    expect(sigs.labelWaveNowMs).toBe(memo.labelWaveNowMs);
    expect(sigs.persistSig).toBe(memo.persistSig);
    expect(sigs.structuralSig).toBe(memo.layoutSig); // flow active → the flow slot, untouched
  });

  it('never computes the real persist bag on this branch — `sigs.persistBag` is the cheap placeholder, not `dashboardPersistBag(view.variableStates)`', () => {
    const view = baseView({
      variableStates: [variable({ id: 'n', value: '9', active: true })],
      layout: { engine: 'flow', preset: 'report', columns: 2, mobile: false, rows: [], order: [] },
    });
    const memo = seedRepaintMemo({ mobileNow: false, view: baseView() });
    const { sigs } = dashboardRepaintPlan(memo, { view, mobileNow: true, gridInvalidationRev: 0 });
    expect(sigs.persistBag).toEqual({});
  });
});

// #589 ChatGPT review finding 1(b): `sigs` on the `republishFlow` branch is
// entirely discarded by the caller (`dashboard.ts` returns immediately after
// `republishFlow` without ever reading `sigs.persistBag` — the only consumer
// is the `plan.persistVars` block, and `persistVars` is always `false` here),
// so computing the real persist bag on this branch was pure waste plus
// unnecessary throw exposure: `dashboardPersistBag` calls `String()` on every
// variable's `unknown` value, which can throw for a pathological value. These
// two tests are a matched pair over the SAME poisoned value: the first proves
// the poisoned value is never reached when `republishFlow` is true (a real
// proof, not vacuous, only because the second test proves that exact value
// WOULD throw if the persist bag were computed for real on a publish that
// actually needs it).
describe('dashboardRepaintPlan — the persist bag is never computed on the republishFlow branch (finding 1b, #589 ChatGPT review)', () => {
  const poisoned = { toString(): string { throw new Error('boom'); } };

  it('does not throw when republishFlow is true, even though the variable value would throw if stringified', () => {
    const view = baseView({
      variableStates: [variable({ id: 'n', value: poisoned, active: true })],
      layout: { engine: 'flow', preset: 'report', columns: 2, mobile: false, rows: [], order: [] },
    });
    const memo = seedRepaintMemo({ mobileNow: false, view: baseView() }); // seeded against an unrelated, unpoisoned view
    expect(() => dashboardRepaintPlan(memo, { view, mobileNow: true, gridInvalidationRev: 0 })).not.toThrow();
  });

  it('DOES throw on the exact same poisoned value once republishFlow is false — proving the assertion above is a real proof', () => {
    const view = baseView({
      variableStates: [variable({ id: 'n', value: poisoned, active: true })],
      // grafana-grid can never take the republishFlow branch (it has no
      // `mobile` concept of its own — see the guard in dashboardRepaintPlan),
      // so this publish reaches the unconditional `dashboardPersistBag` call
      // below regardless of the mobile inputs.
      layout: {
        engine: 'grafana-grid',
        grid: { engine: 'grafana-grid', columns: 12, style: 'grid', tiles: [] },
        renderMode: 'tiles',
      },
    });
    const memo = seedRepaintMemo({ mobileNow: false, view: baseView() });
    expect(() => dashboardRepaintPlan(memo, { view, mobileNow: true, gridInvalidationRev: 0 })).toThrow('boom');
  });
});

describe('dashboardRepaintPlan — rebuildBar', () => {
  const settledMemo = (view: DashboardViewState): RepaintMemo => settle(seedRepaintMemo({ mobileNow: false, view }), view, false, 0);

  it('flips true when a committed value changes', () => {
    const v1 = baseView({ variableStates: [variable({ id: 'n', value: '1', active: true })] });
    const memo = settledMemo(v1);
    const v2 = baseView({ variableStates: [variable({ id: 'n', value: '2', active: true })] });
    expect(dashboardRepaintPlan(memo, { view: v2, mobileNow: false, gridInvalidationRev: 0 }).plan.rebuildBar).toBe(true);
  });

  it('flips true when activation changes with the value unchanged', () => {
    const v1 = baseView({ variableStates: [variable({ id: 'n', value: '1', active: false })] });
    const memo = settledMemo(v1);
    const v2 = baseView({ variableStates: [variable({ id: 'n', value: '1', active: true })] });
    expect(dashboardRepaintPlan(memo, { view: v2, mobileNow: false, gridInvalidationRev: 0 }).plan.rebuildBar).toBe(true);
  });

  it('stays false for an identical republish', () => {
    const v1 = baseView({ variableStates: [variable({ id: 'n', value: '1', active: true })] });
    const memo = settledMemo(v1);
    expect(dashboardRepaintPlan(memo, { view: v1, mobileNow: false, gridInvalidationRev: 0 }).plan.rebuildBar).toBe(false);
  });

  it('distinguishes a real array value from its comma-joined scalar string (#189)', () => {
    const arrayView = baseView({ variableStates: [variable({ id: 'n', value: ['a', 'b'], active: true })] });
    const joinedView = baseView({ variableStates: [variable({ id: 'n', value: 'a,b', active: true })] });
    const memoAfterArray = settledMemo(arrayView);
    // Switching from the settled array value to the byte-different joined
    // string must be seen as a real bar-rebuilding change.
    expect(dashboardRepaintPlan(memoAfterArray, { view: joinedView, mobileNow: false, gridInvalidationRev: 0 }).plan.rebuildBar).toBe(true);
    const memoAfterJoined = settledMemo(joinedView);
    expect(dashboardRepaintPlan(memoAfterJoined, { view: arrayView, mobileNow: false, gridInvalidationRev: 0 }).plan.rebuildBar).toBe(true);
  });
});

describe('dashboardRepaintPlan — an optionsRev-only change never rebuilds the bar (rebuilding would eat in-progress typing) — it pushes options in place', () => {
  it('optionsRev-only', () => {
    const v1 = baseView({ variableStates: [variable({ id: 'n', configured: true, optionsRev: 1, value: '1', active: true })] });
    const memo = settle(seedRepaintMemo({ mobileNow: false, view: v1 }), v1, false, 0);
    const v2 = baseView({ variableStates: [variable({ id: 'n', configured: true, optionsRev: 2, value: '1', active: true })] });
    const { plan } = dashboardRepaintPlan(memo, { view: v2, mobileNow: false, gridInvalidationRev: 0 });
    expect(plan.rebuildBar).toBe(false);
    expect(plan.pushOptions).toBe(true);
  });

  it('status-only', () => {
    const v1 = baseView({ variableStates: [variable({ id: 'n', configured: true, status: 'loading', value: '1', active: true })] });
    const memo = settle(seedRepaintMemo({ mobileNow: false, view: v1 }), v1, false, 0);
    const v2 = baseView({ variableStates: [variable({ id: 'n', configured: true, status: 'ready', value: '1', active: true })] });
    const { plan } = dashboardRepaintPlan(memo, { view: v2, mobileNow: false, gridInvalidationRev: 0 });
    expect(plan.rebuildBar).toBe(false);
    expect(plan.pushOptions).toBe(true);
  });
});

describe('dashboardRepaintPlan — pushOptions / refreshTimeRangeLabels advance unconditionally', () => {
  it('optionsSig and labelWaveNowMs advance even on a publish where their flag is false, so a later identical publish does not re-trigger', () => {
    const v1 = baseView({
      variableStates: [variable({ id: 'n', configured: true, optionsRev: 1, value: '1', active: true })],
      waveWallNowMs: 100,
    });
    const memo0 = seedRepaintMemo({ mobileNow: false, view: v1 });
    // First publish differs enough to force a bar rebuild (value moved),
    // AND carries a fresh optionsRev/waveWallNowMs — rebuildBar being true
    // means pushOptions/refreshTimeRangeLabels are both false on THIS
    // publish, but their sigs must still advance.
    const first = dashboardRepaintPlan(memo0, { view: v1, mobileNow: false, gridInvalidationRev: 0 });
    expect(first.plan.rebuildBar).toBe(true);
    expect(first.plan.pushOptions).toBe(false);
    expect(first.plan.refreshTimeRangeLabels).toBe(false);
    const memo1 = settle(memo0, v1, false, 0);
    expect(memo1.optionsSig).toBe(first.sigs.optionsSig);
    expect(memo1.labelWaveNowMs).toBe(100);
    // A second, byte-identical publish must not re-trigger either action.
    const second = dashboardRepaintPlan(memo1, { view: v1, mobileNow: false, gridInvalidationRev: 0 });
    expect(second.plan.pushOptions).toBe(false);
    expect(second.plan.refreshTimeRangeLabels).toBe(false);
  });
});

describe('dashboardRepaintPlan — refreshTimeRangeLabels', () => {
  it('fires only on a non-rebuild publish whose wave now genuinely advanced', () => {
    const v1 = baseView({ variableStates: [variable({ id: 'n', value: '1', active: true })], waveWallNowMs: 100 });
    const memo = settle(seedRepaintMemo({ mobileNow: false, view: v1 }), v1, false, 0);
    const v2 = baseView({ variableStates: [variable({ id: 'n', value: '1', active: true })], waveWallNowMs: 200 });
    const { plan } = dashboardRepaintPlan(memo, { view: v2, mobileNow: false, gridInvalidationRev: 0 });
    expect(plan.rebuildBar).toBe(false);
    expect(plan.refreshTimeRangeLabels).toBe(true);
  });

  it('never fires while waveWallNowMs is null', () => {
    const v1 = baseView({ variableStates: [variable({ id: 'n', value: '1', active: true })], waveWallNowMs: null });
    const memo = settle(seedRepaintMemo({ mobileNow: false, view: v1 }), v1, false, 0);
    const { plan } = dashboardRepaintPlan(memo, { view: v1, mobileNow: false, gridInvalidationRev: 0 });
    expect(plan.refreshTimeRangeLabels).toBe(false);
  });

  it('does not fire on a publish that also rebuilds the bar', () => {
    const v1 = baseView({ variableStates: [variable({ id: 'n', value: '1', active: true })], waveWallNowMs: 100 });
    const memo = settle(seedRepaintMemo({ mobileNow: false, view: v1 }), v1, false, 0);
    const v2 = baseView({ variableStates: [variable({ id: 'n', value: '2', active: true })], waveWallNowMs: 200 });
    const { plan } = dashboardRepaintPlan(memo, { view: v2, mobileNow: false, gridInvalidationRev: 0 });
    expect(plan.rebuildBar).toBe(true);
    expect(plan.refreshTimeRangeLabels).toBe(false);
  });
});

describe('dashboardRepaintPlan — persistVars', () => {
  it('never writes on a publish that carries no committed-variable change', () => {
    const v1 = baseView({
      variableStates: [variable({ id: 'n', value: '1', active: true })],
      layout: { engine: 'flow', preset: 'report', columns: 2, mobile: false, rows: [], order: [] },
    });
    const memo = settle(seedRepaintMemo({ mobileNow: false, view: v1 }), v1, false, 0);
    // A structural republish (preset switch) with the same variable value.
    const v2 = baseView({
      variableStates: [variable({ id: 'n', value: '1', active: true })],
      layout: { engine: 'flow', preset: 'columns-2', columns: 2, mobile: false, rows: [], order: [] },
    });
    const { plan } = dashboardRepaintPlan(memo, { view: v2, mobileNow: false, gridInvalidationRev: 0 });
    expect(plan.persistVars).toBe(false);
  });

  it('writes when the committed value/active bag changes', () => {
    const v1 = baseView({ variableStates: [variable({ id: 'n', value: '1', active: true })] });
    const memo = settle(seedRepaintMemo({ mobileNow: false, view: v1 }), v1, false, 0);
    const v2 = baseView({ variableStates: [variable({ id: 'n', value: '2', active: true })] });
    const { plan, sigs } = dashboardRepaintPlan(memo, { view: v2, mobileNow: false, gridInvalidationRev: 0 });
    expect(plan.persistVars).toBe(true);
    expect(sigs.persistBag).toEqual({ n: { value: '2', active: true } });
  });

  it('an unchanged optionsRev-only republish does not write either (proves the dedicated persist signature, not the bar signature, gates the write)', () => {
    const v1 = baseView({ variableStates: [variable({ id: 'n', configured: true, optionsRev: 1, value: '1', active: true })] });
    const memo = settle(seedRepaintMemo({ mobileNow: false, view: v1 }), v1, false, 0);
    const v2 = baseView({ variableStates: [variable({ id: 'n', configured: true, optionsRev: 2, value: '1', active: true })] });
    const { plan } = dashboardRepaintPlan(memo, { view: v2, mobileNow: false, gridInvalidationRev: 0 });
    expect(plan.persistVars).toBe(false);
  });
});

describe('dashboardRepaintPlan — engine switch and structural rebuild', () => {
  it('forces rebuildStructure on a switch even when the new engine\'s structural signature happens to byte-match a stale remembered one', () => {
    const gv = gridView([gridTile({ tileId: 't1', span: 6, heightUnits: 2 })], { columns: 12, style: 'grid' });
    const staleGridSig = JSON.stringify({
      c: 12, style: 'grid',
      tiles: [['t1', 6, 2, undefined]],
    });
    const memo: RepaintMemo = {
      mobile: false, engineRendered: 'flow', layoutSig: '', gridSig: staleGridSig,
      barSig: '', optionsSig: '', labelWaveNowMs: null, persistSig: JSON.stringify([]),
      consumedGridInvalidationRev: 0,
    };
    const { plan } = dashboardRepaintPlan(memo, { view: gv, mobileNow: false, gridInvalidationRev: 0 });
    expect(plan.engineSwitched).toBe(true);
    expect(plan.rebuildStructure).toBe(true);
  });

  it('does not force a rebuild on a same-engine republish with a byte-identical structural signature', () => {
    const gv = gridView([gridTile({ tileId: 't1', span: 6, heightUnits: 2 })], { columns: 12, style: 'grid' });
    const memo = settle(seedRepaintMemo({ mobileNow: false, view: gv }), gv, false, 0);
    expect(memo.engineRendered).toBe('grafana-grid');
    const { plan } = dashboardRepaintPlan(memo, { view: gv, mobileNow: false, gridInvalidationRev: 0 });
    expect(plan.engineSwitched).toBe(false);
    expect(plan.rebuildStructure).toBe(false);
  });

  it('rebuilds the flow structure on a row reorder', () => {
    const v1 = baseView({ layout: { engine: 'flow', preset: 'report', columns: 2, mobile: false, order: [], rows: [{ kind: 'tiles', columns: 2, tiles: [flowTile({ tileId: 't1', span: 1 }), flowTile({ tileId: 't2', span: 1 })] }] } });
    const memo = settle(seedRepaintMemo({ mobileNow: false, view: v1 }), v1, false, 0);
    const v2 = baseView({ layout: { engine: 'flow', preset: 'report', columns: 2, mobile: false, order: [], rows: [{ kind: 'tiles', columns: 2, tiles: [flowTile({ tileId: 't2', span: 1 }), flowTile({ tileId: 't1', span: 1 })] }] } });
    const { plan } = dashboardRepaintPlan(memo, { view: v2, mobileNow: false, gridInvalidationRev: 0 });
    expect(plan.rebuildStructure).toBe(true);
  });
});

describe('dashboardRepaintPlan — grid structure invalidation revision', () => {
  it('forces rebuildStructure while the revision is unconsumed, even with an identical grid structural signature', () => {
    const gv = gridView([gridTile({ tileId: 't1', span: 6, heightUnits: 2 })]);
    const memo = settle(seedRepaintMemo({ mobileNow: false, view: gv }), gv, false, 0);
    // A drag cancel bumped the revision — same view, same structural sig.
    const { plan } = dashboardRepaintPlan(memo, { view: gv, mobileNow: false, gridInvalidationRev: 1 });
    expect(plan.rebuildStructure).toBe(true);
  });

  it('does not force a rebuild again once the revision has been consumed', () => {
    const gv = gridView([gridTile({ tileId: 't1', span: 6, heightUnits: 2 })]);
    let memo = settle(seedRepaintMemo({ mobileNow: false, view: gv }), gv, false, 0);
    memo = settle(memo, gv, false, 1); // consumes rev 1
    expect(memo.consumedGridInvalidationRev).toBe(1);
    const { plan } = dashboardRepaintPlan(memo, { view: gv, mobileNow: false, gridInvalidationRev: 1 });
    expect(plan.rebuildStructure).toBe(false);
  });

  it('is irrelevant to the flow engine (never forces a rebuild there)', () => {
    const v1 = baseView();
    const memo = settle(seedRepaintMemo({ mobileNow: false, view: v1 }), v1, false, 0);
    const { plan } = dashboardRepaintPlan(memo, { view: v1, mobileNow: false, gridInvalidationRev: 99 });
    expect(plan.rebuildStructure).toBe(false);
  });
});

describe('dashboardRepaintPlan — structuralSig targets only the active engine', () => {
  it('reads/computes the grid engine\'s own recipe when grid is active, never the flow slot', () => {
    const gv = gridView([gridTile({ tileId: 't1', span: 6, heightUnits: 2 })]);
    const memo: RepaintMemo = {
      ...seedRepaintMemo({ mobileNow: false, view: gv }),
      engineRendered: 'grafana-grid', layoutSig: 'stale-flow-sig', gridSig: 'stale-grid-sig',
    };
    const { sigs } = dashboardRepaintPlan(memo, { view: gv, mobileNow: false, gridInvalidationRev: 0 });
    expect(sigs.structuralSig).not.toBe('stale-flow-sig');
    expect(sigs.structuralSig).toBe(JSON.stringify({
      c: 12, style: 'grid', tiles: [['t1', 6, 2, undefined]],
    }));
  });

  it('computes the flow engine\'s own {m,c,p,rows} recipe when flow is active, never the grid slot', () => {
    const fv = baseView({ layout: { engine: 'flow', preset: 'report', columns: 2, mobile: false, order: [], rows: [{ kind: 'tiles', columns: 2, tiles: [flowTile({ tileId: 't1', span: 1 })] }] } });
    const memo: RepaintMemo = {
      ...seedRepaintMemo({ mobileNow: false, view: fv }),
      engineRendered: 'flow', layoutSig: 'stale-flow-sig', gridSig: 'stale-grid-sig',
    };
    const { sigs } = dashboardRepaintPlan(memo, { view: fv, mobileNow: false, gridInvalidationRev: 0 });
    expect(sigs.structuralSig).not.toBe('stale-grid-sig');
    expect(sigs.structuralSig).toBe(JSON.stringify({
      m: false, c: 2, p: 'report', rows: [{ k: 'tiles', t: [['t1', 1]] }],
    }));
  });
});
