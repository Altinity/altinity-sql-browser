// #487 phase 3 — the desktop left navigation's controller seam. The pure mode
// machine lives in `core/left-nav-layout.ts`; this module is the thin async/
// stateful glue that reads `AppState`'s scattered fields into one
// `LeftNavigationLayout`, drives the reducers, and writes the result back —
// plus the one persistence gap phase 3 exists to close (see
// `selectSectionInExistingPane` below).
//
// Typed against a narrow structural interface, not `App`/`AppState` from
// `src/ui/`: `src/application/**` must never import `src/ui/**` or
// `src/editor/**` (build/check-boundaries.mjs), and a real `App` satisfies the
// shape below directly — the same convention `library-assignment-service.ts`
// and `app-preferences.ts` use.

import { batch } from '@preact/signals-core';
import type { Signal } from '@preact/signals-core';
import {
  resolveRailActivation, resolveRailOpen, sidePanelKeyFor,
} from '../core/left-nav-layout.js';
import type {
  LeftNavigationLayout, LeftNavigationMode, LeftNavigationSection, SidePanelKey,
} from '../core/left-nav-layout.js';

/** The `AppState` fields the left navigation reads and writes, named exactly as
 *  `state.ts` names them. Some are signals (repainted/observed reactively),
 *  some are plain numbers (written like any other splitter width, persisted
 *  only on a later resize-session commit) — that split matches `state.ts`
 *  exactly and matters for every write below. */
export interface LeftNavStateSlice {
  sidebarPx: number;
  leftNavDrawerPx: number;
  readonly leftNavMode: Signal<LeftNavigationMode>;
  readonly leftNavSection: Signal<LeftNavigationSection | null>;
  readonly upperRole: Signal<'databases' | 'dashboards'>;
  readonly sidePanel: Signal<SidePanelKey>;
}

/** The one persistence call this module makes — `app.prefs.save`'s real
 *  signature (`AppPreferences.save`) takes any `PreferenceKey`; this module
 *  only ever names `'sidePanel'`, so the seam is narrowed to that one key
 *  rather than importing the full `PreferenceKey` union from
 *  `application/app-preferences.ts`. */
export interface LeftNavApp {
  readonly state: LeftNavStateSlice;
  readonly prefs: { save(name: 'sidePanel', value: SidePanelKey): void };
  /**
   * #487 phase-3 review, major issue 2 — called BEFORE either function below
   * runs its own batched write. An active pointer resize session
   * (`ui/left-nav-separator.ts`) keeps its own uncommitted layout snapshot
   * independent of `state`; without this, a semantic command that runs while
   * a drag is still live (Escape closing a drawer, a rail click, a
   * programmatic reveal) writes `state` correctly, but the drag's eventual
   * `mouseup`/`blur` commit still fires from its OWN stale snapshot and can
   * silently overwrite (or resurrect) exactly what this command just did.
   * `app-shell.ts` wires this to cancel the active session (no commit) and
   * repaint from the now-current committed layout, so there is nothing left
   * to fight this write once it runs. This is the ONE choke point every
   * caller of `openFocusedSection`/`toggleFocusedSection` gets it through —
   * optional, so a caller with no separator session to preempt (a test, or a
   * call before the shell has mounted one) simply omits it and gets a no-op.
   */
  preemptActiveResize?(): void;
}

/**
 * Project the scattered `AppState` fields this module reads into one
 * `LeftNavigationLayout` — the shape every reducer in `core/left-nav-layout.ts`
 * takes and returns. Exported: later phase-3 steps (the resize separator, the
 * app-shell repaint effect) need the same projection.
 */
export function readLeftNavigationLayout(state: LeftNavStateSlice): LeftNavigationLayout {
  return {
    mode: state.leftNavMode.value,
    wideWidthPx: state.sidebarPx,
    drawerWidthPx: state.leftNavDrawerPx,
    focusedSection: state.leftNavSection.value,
  };
}

/**
 * Drive the pane that ALREADY shows this section when there is no drawer to
 * open for it — the wide sidebar's upper role switch, or its lower
 * library/history tab. Not exported: it is only ever the one-signal half of
 * `openFocusedSection`/`toggleFocusedSection`'s single batched write, never a
 * standalone operation (see those functions' own comments for why they must
 * not each get their own `batch()`).
 *
 * The lower-section branch is the fix phase 3 exists to make: today only the
 * wide sidebar's own tab click (`ui/saved-history.ts`'s `switchTo`) persists
 * `sidePanel`, so a rail/drawer selection of the same section left the
 * signal's NEW value unpersisted — a reload would silently revert to
 * whichever pane was last chosen through the wide tabs. Persisting BEFORE
 * writing the signal mirrors `switchTo` exactly. Per-section filters
 * (`state.lowerNavigationFilters`, phase 3 step 3) are already implemented
 * elsewhere and this module still correctly never touches them.
 *
 * Both branches are guarded to a no-op when the target value is already
 * current: `openFocusedSection`'s documented caller is #428's bounded
 * drag-hover, which can re-assert the SAME section repeatedly on every hover
 * notification, and `sidePanel`'s write has a real synchronous side effect
 * (`app.prefs.save`) that must not fire on every one of those.
 */
function selectSectionInExistingPane(app: LeftNavApp, section: LeftNavigationSection): void {
  if (section === 'databases' || section === 'dashboards') {
    // Session-only, like `switchTo`'s counterpart for the upper pane: `upperRole`
    // is never persisted (state.ts), so there is nothing to save here.
    if (app.state.upperRole.value !== section) app.state.upperRole.value = section;
    return;
  }
  const panel = sidePanelKeyFor(section);
  if (app.state.sidePanel.value !== panel) {
    app.prefs.save('sidePanel', panel);
    app.state.sidePanel.value = panel;
  }
}

/**
 * Write a resolved `LeftNavigationLayout` back onto the scattered signals/
 * fields it was read from. Not exported, for the same reason as
 * `selectSectionInExistingPane`: it is only ever the other half of one batched
 * write.
 *
 * Every caller only ever hands this the result of `resolveRailOpen` /
 * `resolveRailActivation`, and neither reducer changes `mode` or either width
 * in practice (rail-only reducers) — so writing all four fields
 * unconditionally is harmless, and simpler than special-casing which changed.
 * It does NOT call `prefs.save` for `leftNavMode`/`leftNavDrawerPx`: that
 * persistence belongs to a later step's resize-session commit, not to opening
 * a section.
 */
function writeLeftNavigationLayout(state: LeftNavStateSlice, layout: LeftNavigationLayout): void {
  state.leftNavMode.value = layout.mode;
  state.sidebarPx = layout.wideWidthPx;
  state.leftNavDrawerPx = layout.drawerWidthPx;
  state.leftNavSection.value = layout.focusedSection;
}

/**
 * Open a section IDEMPOTENTLY (`core/left-nav-layout.ts`'s `resolveRailOpen`) —
 * the deterministic seam #487 asks the left navigation to expose for #428's
 * bounded drag-hover, and the one a plain rail-icon click also uses.
 *
 * In rail mode this opens (or keeps open) the focused drawer; in wide mode
 * `resolveRailOpen` returns the layout unchanged (both panes already show, so
 * `selectSectionInExistingPane` is the only effect), and for a lower section it
 * ALSO drives the existing wide-mode pane switch, so calling this while wide
 * still selects the right lower tab. Both halves are wrapped in exactly ONE
 * `batch()` call: composing two independently-`batch()`-wrapped functions is
 * NOT one atomic transition, since Preact signals' `batch()` flushes on each
 * top-level call's own exit — two separate calls would let an effect observe
 * an intermediate, mismatched combination (e.g. `sidePanel` updated but
 * `leftNavSection` still stale) on the frame between them.
 */
export function openFocusedSection(app: LeftNavApp, section: LeftNavigationSection): void {
  app.preemptActiveResize?.();
  batch(() => {
    selectSectionInExistingPane(app, section);
    writeLeftNavigationLayout(app.state, resolveRailOpen(readLeftNavigationLayout(app.state), section));
  });
}

/**
 * Toggle a section (`core/left-nav-layout.ts`'s `resolveRailActivation`) —
 * the same shape as `openFocusedSection`, but a second activation of the SAME
 * already-open section closes the drawer instead of re-asserting it open.
 * Same single-`batch()` requirement and rationale as `openFocusedSection`.
 */
export function toggleFocusedSection(app: LeftNavApp, section: LeftNavigationSection): void {
  app.preemptActiveResize?.();
  batch(() => {
    selectSectionInExistingPane(app, section);
    writeLeftNavigationLayout(
      app.state, resolveRailActivation(readLeftNavigationLayout(app.state), section),
    );
  });
}
