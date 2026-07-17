// #276 Phase 4D's AppPreferences — the true browser-preference keys (as
// opposed to the domain records — saved queries, history, query variables —
// which keep their own dedicated `save*` methods on `App`, untouched here),
// extracted from app.ts's `savePref`/`toggleTheme` (issue #276 §10).
// Constructible without App/AppState/DOM. No imports from `src/ui/**` or
// `src/editor/**` (a pretest check enforces this).
//
// Narrow scope (plan review): this service owns ONLY the persist half of
// each preference. Every write site except `toggleTheme` already mutates its
// own state field itself (splitters.ts sets `ctx.state.sidebarPx` before
// calling `ctx.save(...)`; dashboard.ts sets `state.dashLayout`/`dashCols`
// before `app.savePref(...)`; app.ts's `setResultRowLimit` sets
// `state.resultRowLimit` first) — so those typed setters below are pure
// persist calls, no state slice needed. `toggleTheme` is the one exception
// (issue ruling): the state flip AND the persist happen together here: the
// DOM half (the `data-theme` attribute + header icon swap) stays in app.ts's
// own `toggleTheme`, which composes this service's `toggleTheme()` with that
// DOM update. `createState` (state.ts) still owns every key's READ/seed at
// startup — this service is write-only, never called during bootstrap.

import type { SaveStr } from '../state.js';
import { KEYS } from '../state.js';

/** The true-preference subset of state.ts's own `KEYS` map — every OTHER key
 *  there (saved/history/libraryName/varValues/filterActive/filterCurated/
 *  varRecent/varRecentDisabled) is a domain record with its own dedicated
 *  `save*` method on `App` (`saveJSON`/`saveVarValues`/`saveFilterActive`/…),
 *  untouched by this service. */
export type PreferenceKey =
  | 'theme' | 'sidebarPx' | 'editorPct' | 'sideSplitPct' | 'cellDrawerPx'
  | 'sidePanel' | 'resultRowLimit' | 'dashLayout' | 'dashCols';

/** The one state field this service reads/writes (`toggleTheme` only) — a
 *  plain settable property, not a signal (matches `AppState.theme`). */
export interface AppPreferencesStateSlice {
  theme: string;
}

export interface AppPreferencesDeps {
  saveStr: SaveStr;
  state: AppPreferencesStateSlice;
}

export interface AppPreferences {
  /** Generic persist-only setter — the exact `(name, value)` shape app.ts's
   *  public `savePref` has always exposed (dashboard.ts/saved-history.ts/
   *  splitters.ts call it through that unchanged delegate). Kept alongside
   *  the typed per-key setters below for callers that already have a
   *  validated `{name, value}` pair (the common case — every real call site
   *  today). */
  save(name: PreferenceKey, value: unknown): void;
  setTheme(theme: string): void;
  /** Flips `state.theme` light↔dark AND persists it in one call (issue
   *  ruling — the one preference whose state mutation moves here, not just
   *  its persist half); returns the new value so the DOM-half caller
   *  (app.ts's own `toggleTheme`) doesn't need to re-read `state.theme`. */
  toggleTheme(): string;
  setSidebarPx(px: number): void;
  setEditorPct(pct: number): void;
  setSideSplitPct(pct: number): void;
  setCellDrawerPx(px: number): void;
  setSidePanel(panel: string): void;
  setResultRowLimit(n: number): void;
  setDashLayout(layout: string): void;
  setDashCols(n: number): void;
}

/** Build an `AppPreferences` bound to `deps`. Trivial constructor — no
 *  validation, no defaulting; the caller supplies every field of `deps`
 *  exactly as it wants it used. */
export function createAppPreferences(deps: AppPreferencesDeps): AppPreferences {
  const { state } = deps;

  function save(name: PreferenceKey, value: unknown): void {
    deps.saveStr(KEYS[name], String(value));
  }

  function setTheme(theme: string): void {
    save('theme', theme);
  }

  function toggleTheme(): string {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    save('theme', state.theme);
    return state.theme;
  }

  const setSidebarPx = (px: number): void => save('sidebarPx', px);
  const setEditorPct = (pct: number): void => save('editorPct', pct);
  const setSideSplitPct = (pct: number): void => save('sideSplitPct', pct);
  const setCellDrawerPx = (px: number): void => save('cellDrawerPx', px);
  const setSidePanel = (panel: string): void => save('sidePanel', panel);
  const setResultRowLimit = (n: number): void => save('resultRowLimit', n);
  const setDashLayout = (layout: string): void => save('dashLayout', layout);
  const setDashCols = (n: number): void => save('dashCols', n);

  return {
    save, setTheme, toggleTheme, setSidebarPx, setEditorPct, setSideSplitPct,
    setCellDrawerPx, setSidePanel, setResultRowLimit, setDashLayout, setDashCols,
  };
}
