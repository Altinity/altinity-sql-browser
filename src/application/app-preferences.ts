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
// calling `ctx.save(...)`; #276 Phase 5 deleted the flat `App.savePref`
// delegate; app.ts's `setResultRowLimit` sets
// `state.resultRowLimit` first) — so `save(name, value)` is a pure typed
// persist call, no state slice needed. `toggleTheme` is the one exception
// (issue ruling): the state flip AND the persist happen together here: the
// DOM half (the `data-theme` attribute + header icon swap) stays in app.ts's
// own `toggleTheme`, which composes this service's `toggleTheme()` with that
// DOM update. `createState` (state.ts) still owns every key's READ/seed at
// startup — this service is write-only, never called during bootstrap.

import type { SaveStr } from '../state.js';
import { KEYS } from '../state.js';
import type { SidePanelKey } from '../core/side-panels.js';

/**
 * The true-preference subset of state.ts's own `KEYS` map, keyed by the VALUE
 * each preference accepts — every OTHER key there (saved/history/libraryName/
 * varValues/filterActive/varRecent/varRecentDisabled) is a domain record with
 * its own dedicated `save*` method on `App`
 * (`saveJSON`/`saveVarValues`/`saveFilterActive`/…), untouched by this
 * service.
 *
 * #587 AC4: `sidePanel`'s value is `SidePanelKey` (from `core/side-panels.ts`,
 * the registry's own derived persisted-key vocabulary), not `unknown` — so
 * `prefs.save('sidePanel', 'library')` (the registry's OWN id, never a
 * persisted value — see `decodeSidePanelKey`'s downgrade-safety comment) is a
 * COMPILE error, not just a runtime discipline every call site has to
 * maintain by hand.
 */
export interface PreferenceValues {
  theme: string;
  sidebarPx: number;
  editorPct: number;
  sideSplitPct: number;
  sidePanel: SidePanelKey;
  resultRowLimit: number;
  // #586 — the single canonical docked right-inspector width, replacing the
  // former cellDrawerPx/docPanePx pair (see splitters.ts's 'rightInspector'
  // axis and state.ts's compat-read `rightInspectorPx` comment).
  rightInspectorPx: number;
}

/** Kept as a type alias so existing `PreferenceKey`-typed imports/casts
 *  (`app-shell.ts`'s dynamic splitter/drawer call sites) keep compiling
 *  unchanged. */
export type PreferenceKey = keyof PreferenceValues;

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
   *  former `App.savePref` delegate used to expose (#276 Phase 5 deleted it;
   *  saved-history.ts/splitters.ts's callers call `app.prefs.save`
   *  directly now). This IS the service's write API: per-key typed setters
   *  were considered and dropped (review) — every real call site already
   *  holds a validated `{name, value}` pair, so a per-key surface would ship
   *  with zero callers (CLAUDE.md rule 5: no speculative primitives).
   *  Generic over `PreferenceValues` (#587 AC4): `value`'s type follows
   *  `name`, so a mismatched pair (e.g. `save('sidePanel', 'library')`) is a
   *  compile error rather than a runtime-only discipline. */
  save<K extends PreferenceKey>(name: K, value: PreferenceValues[K]): void;
  /** Flips `state.theme` light↔dark AND persists it in one call (issue
   *  ruling — the one preference whose state mutation moves here, not just
   *  its persist half); returns the new value so the DOM-half caller
   *  (app.ts's own `toggleTheme`) doesn't need to re-read `state.theme`. */
  toggleTheme(): string;
}

/** Build an `AppPreferences` bound to `deps`. Trivial constructor — no
 *  validation, no defaulting; the caller supplies every field of `deps`
 *  exactly as it wants it used. */
export function createAppPreferences(deps: AppPreferencesDeps): AppPreferences {
  const { state } = deps;

  function save<K extends PreferenceKey>(name: K, value: PreferenceValues[K]): void {
    deps.saveStr(KEYS[name], String(value));
  }

  function toggleTheme(): string {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    save('theme', state.theme);
    return state.theme;
  }

  return { save, toggleTheme };
}
