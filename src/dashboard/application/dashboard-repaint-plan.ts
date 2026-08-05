// Pure repaint arbitration for the live Dashboard surface (#589 wave 1 of the
// #593 decomposition). Extracted verbatim out of `ui/dashboard.ts`'s
// `renderDashboard` `effect()` callback — this module decides WHICH repaint
// actions a publish needs (rebuild the variable bar, push fresh options,
// refresh time-range labels, persist committed variables, rebuild the active
// engine's structure), it never touches the DOM or `@preact/signals-core`
// itself. `dashboard.ts` still owns every side effect (DOM mutation,
// persistence, session republish). Zero functional change is the explicit
// contract for this wave (#589 non-goal).
//
// #589 pass 2 (ChatGPT review finding 1): the six `plan*` functions below —
// `planRepublishFlow`, `planBarRebuild`, `planOptionsPush`, `planLabelRefresh`,
// `planPersist`, `planStructuralRebuild` — are the REAL production entry
// points. `dashboard.ts`'s effect calls each of them individually, in this
// exact order, APPLYING every decision's side effect immediately after
// computing it and before moving on to the next decision — matching the
// pre-extraction code's interleaving of computation and application exactly.
// This matters because a later decision's computation can throw (e.g.
// `planPersist`'s `dashboardPersistBag`/`valueString`/`String()` over a
// pathological variable value): if computation and application were batched
// into one call that returns only once everything has been computed (as
// `dashboardRepaintPlan` below does), a throw computing a LATER decision
// would prevent an EARLIER decision's side effect from EVER running, even
// though the pre-extraction code — and every one of these individual
// `plan*` calls — would already have applied it. See
// `tests/unit/dashboard-repaint-integration.test.ts`'s
// "compute/apply interleaving" describe block for the regression proof.
//
// `dashboardRepaintPlan` itself remains exported as a thin composition of
// the six `plan*` functions, called in the same order, assembled into the
// full `{ plan, sigs }` shape — kept as a convenience/back-compat surface for
// direct unit testing (see `dashboard-repaint-plan.test.ts` and #589's AC2,
// "computed by a pure, directly-unit-tested `dashboardRepaintPlan`
// function") and for anything that genuinely wants the full decision for a
// given input in one call. Production code in `dashboard.ts` must NOT call
// it — only the granular functions, for the reason above.
//
// No DOM/signals import here on purpose: `build/check-boundaries.mjs` and
// `tests/unit/dashboard-boundaries.test.js` both forbid `src/dashboard/application`
// from reaching into `src/ui`, `src/editor`, or `src/application`.

import type { DashboardViewState, ViewerVariableState } from './dashboard-viewer-session.js';
import type { DashboardVariableBag } from '../model/dashboard-variable-store.js';
import { variableBagSignature } from '../model/dashboard-variable-store.js';

/** Everything a publish needs to remember from the PREVIOUS publish in order
 *  to decide what this one must do. `dashboard.ts` owns exactly one mutable
 *  object of this shape (seeded by `seedRepaintMemo`) and commits each field
 *  individually, at the point in its effect where the pre-extraction code
 *  committed its own private `let` — never all at once (that would erase the
 *  partial-failure semantics a throwing side effect currently relies on). */
export interface RepaintMemo {
  mobile: boolean;
  engineRendered: 'flow' | 'grafana-grid' | null;
  layoutSig: string;
  gridSig: string;
  barSig: string;
  optionsSig: string;
  labelWaveNowMs: number | null;
  persistSig: string;
  consumedGridInvalidationRev: number;
}

/** Which repaint actions this publish's caller must perform. `dashboard.ts`
 *  is the sole consumer — it must branch on these flags rather than
 *  recomputing its own decision from `input`/`sigs`. */
export interface RepaintPlan {
  /** A mobile-breakpoint flip the flow model hasn't caught up with yet: the
   *  caller must republish through the session and return WITHOUT acting on
   *  any other flag below (mirrors the pre-extraction early return). */
  republishFlow: boolean;
  rebuildBar: boolean;
  pushOptions: boolean;
  refreshTimeRangeLabels: boolean;
  persistVars: boolean;
  engineSwitched: boolean;
  rebuildStructure: boolean;
}

/** The freshly computed values for this publish. `dashboard.ts` commits the
 *  ones its side effects actually consumed onto the real `RepaintMemo` —
 *  never in one batch, see the module doc above. */
export interface RepaintSigs {
  barSig: string;
  optionsSig: string;
  labelWaveNowMs: number | null;
  persistBag: DashboardVariableBag;
  persistSig: string;
  /** The ACTIVE engine's structural signature for this publish (flow's
   *  `{m,c,p,rows}` or grafana-grid's `{c,style,tiles}`) — never both. This
   *  module never touches the INACTIVE engine's own remembered signature
   *  (`memo.layoutSig`/`memo.gridSig`, whichever isn't active) — it doesn't
   *  own `memo` mutation at all, only computes what a caller with write
   *  access to `memo` should do with it. `dashboard.ts` is that caller, and
   *  on an `engineSwitched` publish it deliberately resets BOTH structural
   *  sigs to `''` before applying the rebuild (see the commit site beside
   *  its own `planStructuralRebuild` call there) — a throw-safety measure, not something
   *  this module's own computation could substitute for: if a later
   *  reconciler call throws before committing its own sig, the eager reset
   *  is what keeps the NEXT publish's mismatch check honest, independent of
   *  whether this (throwing) publish ever finished. */
  structuralSig: string;
}

/** Moved verbatim from `ui/dashboard.ts` (#189) — every other consumer there
 *  (the time-range apply path, the variable-bar draft seeding, the time-range
 *  option assembly) now imports it from here instead. */
export const valueString = (value: unknown): string =>
  (typeof value === 'string' ? value : value == null ? '' : String(value));

/** #189: an array-safe stand-in for `valueString`, used ONLY by the variable-bar
 *  rebuild signature below — an array JSON-encodes (so a committed
 *  `['a','b']` is distinct from the joined string `"a,b"`, which
 *  `valueString`'s `String()` fallback would otherwise collapse it to);
 *  every other value keeps `valueString`'s own coercion, unchanged. */
const sigValue = (value: unknown): string => (Array.isArray(value) ? JSON.stringify(value) : valueString(value));

/** #303: the committed-variable bag for a published view, built exactly the way
 *  the persist step and the memo seed both need it. A multi-select variable's
 *  committed value is a real `string[]` and is persisted as one —
 *  `dashboard-variable-store.ts` has round-tripped arrays since #189 (`value:
 *  string | string[]`, with an array-aware coerce that drops non-string
 *  elements rather than stringifying them), so a selection survives a reload
 *  without ever becoming the joined `"a,b"` that `valueString`'s `String()`
 *  fallback would produce — each array element is passed through
 *  `valueString` individually and the array shape is preserved. */
export function dashboardPersistBag(states: readonly ViewerVariableState[]): DashboardVariableBag {
  const bag: DashboardVariableBag = {};
  for (const f of states) {
    bag[f.id] = {
      value: Array.isArray(f.value) ? f.value.map(valueString) : valueString(f.value),
      active: f.active,
    };
  }
  return bag;
}

/** Seeds a fresh `RepaintMemo` from the session's initial state, the same way
 *  `dashboard.ts` used to seed its private `let`s. `barSig`/`optionsSig`/
 *  `layoutSig`/`gridSig` seed EMPTY and `engineRendered` seeds `null` — the
 *  very first publish never has a prior engine or signature to compare
 *  against, so it always looks like a real change (rebuilds the bar, rebuilds
 *  whichever engine's structure is active). `labelWaveNowMs` and `persistSig`
 *  are different: they seed from the ACTUAL initial view, not empty —
 *  seeding `persistSig` from an empty bag would make the very first publish's
 *  echo of the seeded variable state look like a real change and WRITE OVER
 *  the user's stored variable defaults on load (#303 review). */
export function seedRepaintMemo(init: { mobileNow: boolean; view: DashboardViewState }): RepaintMemo {
  return {
    mobile: init.mobileNow,
    engineRendered: null,
    layoutSig: '',
    gridSig: '',
    barSig: '',
    optionsSig: '',
    labelWaveNowMs: init.view.waveWallNowMs,
    persistSig: variableBagSignature(dashboardPersistBag(init.view.variableStates)),
    consumedGridInvalidationRev: 0,
  };
}

// ── Granular per-decision functions (#589 pass 2, ChatGPT review finding 1) ─
// Each function below computes EXACTLY ONE decision from `dashboardRepaintPlan`
// — its boolean flag plus whatever freshly-computed value(s) go with it — and
// nothing else. `dashboard.ts`'s effect calls these directly, applying each
// one's side effect before moving on to compute the next, so a throw
// computing a LATER decision can never retroactively undo an EARLIER one's
// already-applied effect. See the module doc above for why this replaced a
// single batched call.

/** A breakpoint flip after the last publish needs a fresh flow model —
 *  the caller must republish through the session (recomputes it with the new
 *  mobile flag) and return WITHOUT deciding anything else about this publish.
 *  grafana-grid has no `mobile` concept of its own (its responsive behavior
 *  is the containerWidth-driven effective-columns clamp), so this can only
 *  ever fire while flow is the active engine. Cheap: no signature computation
 *  needed, since a `true` result means the caller returns before touching
 *  bar/options/label/persist/structural state at all. */
export function planRepublishFlow(
  memo: Readonly<Pick<RepaintMemo, 'mobile'>>,
  view: DashboardViewState,
  mobileNow: boolean,
): { republishFlow: boolean } {
  return {
    republishFlow: view.layout.engine === 'flow'
      && mobileNow !== memo.mobile
      && mobileNow !== view.layout.mobile,
  };
}

/** Rebuild the shared variable bar only on a STRUCTURAL change (activation or
 *  committed value) — not on a bare status flip, not on tile progress ticks,
 *  and (#447 phase 2) NOT when an option list arrives. `status` and
 *  `optionsRev` are both deliberately EXCLUDED from this signature: they are
 *  updated in the existing DOM in place, never by a rebuild. That preserves
 *  the invariant that an unchanged republish never disturbs in-progress
 *  typing. */
export function planBarRebuild(
  memo: Readonly<Pick<RepaintMemo, 'barSig'>>,
  view: DashboardViewState,
): { rebuildBar: boolean; barSig: string } {
  const barSig = JSON.stringify(view.variableStates.map((f) => [f.id, f.active, sigValue(f.value)]));
  return { rebuildBar: barSig !== memo.barSig, barSig };
}

/** #447 phase 2: a SEPARATE signature from `barSig` — option content, the
 *  option-backed statuses and the batch verdict never participate in
 *  `barSig`, so a change to any of them is detected here instead and applied
 *  to the EXISTING bar in place (no rebuild, so in-progress typing elsewhere
 *  survives an asynchronously-arriving batch). Excluding `optionsRev` from
 *  `barSig` matters more than excluding `status`: a rebuild is triggered by a
 *  user COMMIT, which is inherently typing-ending; the option batch instead
 *  lands ASYNCHRONOUSLY and can complete while the user is mid-keystroke in
 *  an unrelated field, so rebuilding on it would discard that input and
 *  silently cancel any open popover. `rebuildBar` (this SAME publish's own,
 *  already-decided value) gates it: only pushed when the bar SURVIVED this
 *  publish — a rebuild has just taken the newest options along with it. */
export function planOptionsPush(
  memo: Readonly<Pick<RepaintMemo, 'optionsSig'>>,
  view: DashboardViewState,
  rebuildBar: boolean,
): { pushOptions: boolean; optionsSig: string } {
  const optionsSig = JSON.stringify(view.variableStates.map((f) =>
    [f.id, f.configured, f.optionsRev, f.status, f.optionsError, f.optionsTruncated]));
  return { pushOptions: !rebuildBar && optionsSig !== memo.optionsSig, optionsSig };
}

/** #335: per-wave time-range label refresh. A rebuild (`barSig` change)
 *  already rebuilds every time-range control against this wave's `now`; only
 *  a NON-rebuild publish whose wave `now` advanced needs the closed labels
 *  re-resolved in place — a committed relative range (`-1d` → `now`) moves
 *  per wave without any bar rebuild. `rebuildBar` (this SAME publish's own,
 *  already-decided value) gates it, same as `planOptionsPush` above. */
export function planLabelRefresh(
  memo: Readonly<Pick<RepaintMemo, 'labelWaveNowMs'>>,
  view: DashboardViewState,
  rebuildBar: boolean,
): { refreshTimeRangeLabels: boolean; labelWaveNowMs: number | null } {
  const labelWaveNowMs = view.waveWallNowMs;
  return {
    refreshTimeRangeLabels: !rebuildBar && labelWaveNowMs != null && labelWaveNowMs !== memo.labelWaveNowMs,
    labelWaveNowMs,
  };
}

/** #303: persist committed variable value/active into the isolated
 *  per-dashboard store — isolated from the Workbench's asb:varValues/
 *  asb:filterActive keys. A SEPARATE signature from `barSig`: that one also
 *  flips when curated options arrive (no committed value/active change),
 *  which would otherwise trigger a redundant write. This is the decision
 *  most likely to throw (`dashboardPersistBag` calls `valueString`/
 *  `String()` over every variable's `unknown` value) — computing it LAST,
 *  after the bar/options/label decisions have already been computed AND
 *  applied by the caller, is exactly what preserves the pre-extraction
 *  partial-failure semantics (#589 pass 2 finding 1). */
export function planPersist(
  memo: Readonly<Pick<RepaintMemo, 'persistSig'>>,
  view: DashboardViewState,
): { persistVars: boolean; persistBag: DashboardVariableBag; persistSig: string } {
  const persistBag = dashboardPersistBag(view.variableStates);
  const persistSig = variableBagSignature(persistBag);
  return { persistVars: persistSig !== memo.persistSig, persistBag, persistSig };
}

/** #291: the ENGINE this publish renders. A switch forces the ACTIVE engine's
 *  own structural rebuild regardless of whether its remembered signature
 *  happens to byte-match (a coincidental match must never silently skip
 *  cleaning up the OTHER engine's leftover chrome — `dash-gg-grid`/
 *  `dash-gg-tile`/height classes on a flow switch, or `is-report` on a grid
 *  switch). This function never touches the INACTIVE engine's own
 *  remembered signature — it doesn't own `memo` mutation, only computes what
 *  the caller should do with it; see the throw-safety note on
 *  `RepaintSigs.structuralSig` above for what the caller (`dashboard.ts`)
 *  does with that on an engine switch. */
export function planStructuralRebuild(
  memo: Readonly<Pick<RepaintMemo, 'engineRendered' | 'layoutSig' | 'gridSig' | 'consumedGridInvalidationRev'>>,
  view: DashboardViewState,
  gridInvalidationRev: number,
): { engineSwitched: boolean; rebuildStructure: boolean; structuralSig: string } {
  const engineSwitched = view.layout.engine !== memo.engineRendered;

  const structuralSig = view.layout.engine === 'grafana-grid'
    ? JSON.stringify({
      c: view.layout.grid.columns,
      style: view.layout.grid.style,
      tiles: view.layout.grid.tiles.map((t) => [t.tileId, t.span, t.heightUnits, t.previewHeightPx]),
    })
    : JSON.stringify({
      m: view.layout.mobile, c: view.layout.columns, p: view.layout.preset,
      rows: view.layout.rows.map((r) => ({ k: r.kind, t: r.tiles.map((t) => [t.tileId, t.span]) })),
    });
  const priorStructuralSig = view.layout.engine === 'grafana-grid' ? memo.gridSig : memo.layoutSig;
  // A cancelled/snapped-back grid drag forces the NEXT publish to rebuild the
  // grid structure even when nothing about the grid model itself changed
  // (the drag's own DOM restore is deterministic and synchronous, but the
  // structure a signature-gated reconcile would otherwise skip needs a real
  // rebuild to clear whatever the drag left behind). Tracked as a revision
  // counter bumped by the drag-restore path in `dashboard.ts`, consumed here
  // — never by any code reasoning about signature values directly.
  const gridInvalidationPending = view.layout.engine === 'grafana-grid'
    && memo.consumedGridInvalidationRev !== gridInvalidationRev;
  const rebuildStructure = engineSwitched || structuralSig !== priorStructuralSig || gridInvalidationPending;

  return { engineSwitched, rebuildStructure, structuralSig };
}

/** Decides what one Dashboard publish must do, given the remembered state of
 *  the previous publish (`memo`) and this publish's fresh view. Pure: no DOM,
 *  no signals, no side effects. A thin composition of the six `plan*`
 *  functions above, called in the same order `dashboard.ts`'s effect calls
 *  them — kept as a direct-unit-test and "give me the full decision" surface
 *  (see the module doc above for why production code must call the granular
 *  functions instead). */
export function dashboardRepaintPlan(
  memo: Readonly<RepaintMemo>,
  input: { view: DashboardViewState; mobileNow: boolean; gridInvalidationRev: number },
): { plan: RepaintPlan; sigs: RepaintSigs } {
  const { view, mobileNow, gridInvalidationRev } = input;

  const { republishFlow } = planRepublishFlow(memo, view, mobileNow);
  if (republishFlow) {
    // Nothing else about this publish is decided — the pre-extraction code
    // returned immediately after the republish, touching no other `let`. The
    // `sigs` below intentionally echo `memo` unchanged (never a freshly
    // computed value) so a caller mistake that consumed them anyway would be
    // a harmless no-op rather than a silent behavior change.
    //
    // #589 ChatGPT review: `sigs` as a WHOLE is discarded by any caller on
    // this branch — in production, `dashboard.ts` doesn't even reach this
    // function any more (finding 1, #589 pass 2): it calls the granular
    // `planRepublishFlow` directly, which returns nothing but the boolean
    // itself, and returns immediately after `republishFlow` without ever
    // computing bar/options/label/persist/structural state at all. This
    // branch exists so `dashboardRepaintPlan`'s own composed shape (its
    // direct-unit-test/back-compat surface) still returns something
    // plausible for that case. Computing the real persist bag here anyway
    // would still call `valueString`/`String()` over every variable's
    // `unknown` value for nothing, and exposes a throw (a pathological
    // variable value) that no caller of THIS branch can ever observe — so a
    // cheap placeholder stands in for it instead of
    // `dashboardPersistBag(view.variableStates)`.
    return {
      plan: {
        republishFlow: true,
        rebuildBar: false,
        pushOptions: false,
        refreshTimeRangeLabels: false,
        persistVars: false,
        engineSwitched: false,
        rebuildStructure: false,
      },
      sigs: {
        barSig: memo.barSig,
        optionsSig: memo.optionsSig,
        labelWaveNowMs: memo.labelWaveNowMs,
        persistBag: {},
        persistSig: memo.persistSig,
        // `republishFlow` can only be true while `view.layout.engine ===
        // 'flow'` (see `planRepublishFlow`'s guard) — always the flow slot
        // here, never the grid one.
        structuralSig: memo.layoutSig,
      },
    };
  }

  const { rebuildBar, barSig } = planBarRebuild(memo, view);
  const { pushOptions, optionsSig } = planOptionsPush(memo, view, rebuildBar);
  const { refreshTimeRangeLabels, labelWaveNowMs } = planLabelRefresh(memo, view, rebuildBar);
  const { persistVars, persistBag, persistSig } = planPersist(memo, view);
  const { engineSwitched, rebuildStructure, structuralSig } = planStructuralRebuild(memo, view, gridInvalidationRev);

  return {
    plan: {
      republishFlow: false, rebuildBar, pushOptions, refreshTimeRangeLabels,
      persistVars, engineSwitched, rebuildStructure,
    },
    sigs: { barSig, optionsSig, labelWaveNowMs, persistBag, persistSig, structuralSig },
  };
}
