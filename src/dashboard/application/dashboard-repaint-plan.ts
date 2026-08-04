// Pure repaint arbitration for the live Dashboard surface (#589 wave 1 of the
// #593 decomposition). Extracted verbatim out of `ui/dashboard.ts`'s
// `renderDashboard` `effect()` callback — this module decides WHICH repaint
// actions a publish needs (rebuild the variable bar, push fresh options,
// refresh time-range labels, persist committed variables, rebuild the active
// engine's structure), it never touches the DOM or `@preact/signals-core`
// itself. `dashboard.ts` still owns every side effect (DOM mutation,
// persistence, session republish); it just asks this module what to do and
// commits the returned signatures field-by-field, interleaved with those side
// effects in the exact sequence the pre-extraction code used — see the
// "staged commits" note in `dashboard.ts` beside the `effect()` call. Zero
// functional change is the explicit contract for this wave (#589 non-goal).
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
   *  `{m,c,p,rows}` or grafana-grid's `{c,style,tiles}`) — never both; the
   *  inactive engine's own remembered signature is left untouched (a later
   *  switch back to it is already forced by `engineSwitched`, so nothing
   *  needs to clear it defensively). */
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

/** Decides what one Dashboard publish must do, given the remembered state of
 *  the previous publish (`memo`) and this publish's fresh view. Pure: no DOM,
 *  no signals, no side effects — `dashboard.ts` is the sole authority for
 *  acting on the returned `plan`, and the sole owner of committing `sigs`
 *  onto its real `RepaintMemo`. */
export function dashboardRepaintPlan(
  memo: Readonly<RepaintMemo>,
  input: { view: DashboardViewState; mobileNow: boolean; gridInvalidationRev: number },
): { plan: RepaintPlan; sigs: RepaintSigs } {
  const { view, mobileNow, gridInvalidationRev } = input;

  // A breakpoint flip after the last publish needs a fresh flow model —
  // republish through the session (recomputes it with the new mobile flag).
  // grafana-grid has no `mobile` concept of its own (its responsive behavior
  // is the containerWidth-driven effective-columns clamp), so this can only
  // ever fire while flow is the active engine.
  const republishFlow = view.layout.engine === 'flow'
    && mobileNow !== memo.mobile
    && mobileNow !== view.layout.mobile;

  if (republishFlow) {
    // Nothing else about this publish is decided — the pre-extraction code
    // returned immediately after the republish, touching no other `let`. The
    // `sigs` below intentionally echo `memo` unchanged (never a freshly
    // computed value) so a caller mistake that consumed them anyway would be
    // a harmless no-op rather than a silent behavior change.
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
        persistBag: dashboardPersistBag(view.variableStates),
        persistSig: memo.persistSig,
        // `republishFlow` can only be true while `view.layout.engine ===
        // 'flow'` (see the guard above) — always the flow slot here, never
        // the grid one.
        structuralSig: memo.layoutSig,
      },
    };
  }

  // Rebuild the shared variable bar only on a STRUCTURAL change (activation or
  // committed value) — not on a bare status flip, not on tile progress ticks,
  // and (#447 phase 2) NOT when an option list arrives. `status` and
  // `optionsRev` are both deliberately EXCLUDED from this signature: they are
  // updated in the existing DOM in place, never by a rebuild. That preserves
  // the invariant that an unchanged republish never disturbs in-progress
  // typing.
  const barSig = JSON.stringify(view.variableStates.map((f) => [f.id, f.active, sigValue(f.value)]));
  const rebuildBar = barSig !== memo.barSig;

  // #447 phase 2: a SEPARATE signature from `barSig` — option content, the
  // option-backed statuses and the batch verdict never participate in
  // `barSig`, so a change to any of them is detected here instead and applied
  // to the EXISTING bar in place (no rebuild, so in-progress typing elsewhere
  // survives an asynchronously-arriving batch). Excluding `optionsRev` from
  // `barSig` matters more than excluding `status`: a rebuild is triggered by a
  // user COMMIT, which is inherently typing-ending; the option batch instead
  // lands ASYNCHRONOUSLY and can complete while the user is mid-keystroke in
  // an unrelated field, so rebuilding on it would discard that input and
  // silently cancel any open popover. Only pushed when the bar SURVIVED this
  // publish — a rebuild above has just taken the newest options along with it.
  const optionsSig = JSON.stringify(view.variableStates.map((f) =>
    [f.configured, f.optionsRev, f.status, f.optionsError, f.optionsTruncated]));
  const pushOptions = !rebuildBar && optionsSig !== memo.optionsSig;

  // #335: per-wave time-range label refresh. A rebuild (`barSig` change)
  // already rebuilds every time-range control against this wave's `now`; only
  // a NON-rebuild publish whose wave `now` advanced needs the closed labels
  // re-resolved in place — a committed relative range (`-1d` → `now`) moves
  // per wave without any bar rebuild.
  const labelWaveNowMs = view.waveWallNowMs;
  const refreshTimeRangeLabels = !rebuildBar && labelWaveNowMs != null && labelWaveNowMs !== memo.labelWaveNowMs;

  // #303: persist committed variable value/active into the isolated
  // per-dashboard store — isolated from the Workbench's asb:varValues/
  // asb:filterActive keys. A SEPARATE signature from `barSig`: that one also
  // flips when curated options arrive (no committed value/active change),
  // which would otherwise trigger a redundant write.
  const persistBag = dashboardPersistBag(view.variableStates);
  const persistSig = variableBagSignature(persistBag);
  const persistVars = persistSig !== memo.persistSig;

  // #291: the ENGINE this publish renders. A switch forces the ACTIVE
  // engine's own structural rebuild regardless of whether its remembered
  // signature happens to byte-match (a coincidental match must never silently
  // skip cleaning up the OTHER engine's leftover chrome — `dash-gg-grid`/
  // `dash-gg-tile`/height classes on a flow switch, or `is-report` on a grid
  // switch). The inactive engine's own signature is left exactly as it was:
  // a later switch back to it re-triggers `engineSwitched`, which alone is
  // enough to force that engine's rebuild too, so nothing needs to clear it
  // defensively here.
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

  return {
    plan: {
      republishFlow: false, rebuildBar, pushOptions, refreshTimeRangeLabels,
      persistVars, engineSwitched, rebuildStructure,
    },
    sigs: { barSig, optionsSig, labelWaveNowMs, persistBag, persistSig, structuralSig },
  };
}
