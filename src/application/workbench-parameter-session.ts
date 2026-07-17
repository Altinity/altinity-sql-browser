// #276 Phase 4B1's WorkbenchParameterSession — the `{name:Type}` query-
// variable POLICY extracted from app.ts (issue #276 §7, THINNER CUT per plan
// review): analyze/prepare/gate/execution-view, the #170 hardening bookkeeping,
// the #172 v2 schema-cache enum-suggestion inference, and the #171 recent-
// value + persistence policy over `varValues`/`filterActive`/`varRecent`/
// `varRecentDisabled`. Constructible without App/AppState/DOM, like
// `workbench-session.ts`/`schema-catalog-service.ts` before it.
//
// Deliberately NOT included (plan-review rulings): `renderVarStrip` (the DOM
// view) stays in app.ts wholesale, calling this session's methods directly —
// the full `analyze() -> ParameterViewModel[]` view-model API the issue
// sketches is deferred, not built here. `setRunBtn` (DOM) also stays in
// app.ts. `sessionParams`/`needsSession`/`sessionParamsFor` stay app.ts-local
// (they're `tab.chSession`/transport material — Phase 4C's concern, not this
// session's).
//
// Every state field this session reads/writes (`varValues`/`filterActive`/
// `varRecent`/`varRecentDisabled`) stays a LIVE `AppState` field, never a
// snapshot — the session receives accessor closures (mirrors
// `dashboard-session.ts`'s own `DashboardSessionDeps` convention), and
// `filter-bar.ts`/`dashboard.ts`/`results.ts` keep mutating `app.state.*`
// directly (through the SAME live objects these accessors read), so they
// keep observing this session's own reads without any consumer edit.
//
// `hardenedVars` (#170 review: names whose value hardened to invalid) is
// owned here as a private `Set<string>`, exposed as a plain (never
// reassigned, only mutated in place) property — read directly as
// `app.params.hardenedVars` (#276 Phase 5 deleted the flat `App.hardenedVars`
// alias; `app.test.ts` reads this session's own instance through `app.params`
// now).
//
// `saveVarRecent`'s two faces: `saveVarRecent()` (this session's own, real,
// `saveJSON`-calling implementation — what `app.saveVarRecent`'s one-line
// delegate calls) vs. `deps.hooks.saveVarRecent()` (used ONLY internally, by
// `recordBoundParams`/`clearVarRecent`/`clearAllVarRecent`, to trigger the
// persist). The two are kept distinct on purpose: `deps.hooks.saveVarRecent`
// is wired by app.ts to `() => app.saveVarRecent()` — a property read on the
// mutable `app` object, evaluated fresh on every call — so a caller that
// swaps `app.saveVarRecent` (app.test.ts's `app.saveVarRecent =
// vi.fn(app.saveVarRecent)` mock-substitution case) still observes every
// automatic persist this policy performs, byte-identical to the
// pre-extraction code's own `app.saveVarRecent()` property-style call inside
// `clearVarRecent`/`clearAllVarRecent`/`recordBoundParams`. Routing the real
// implementation through that same hook would recurse (`app.saveVarRecent`
// -> hook -> `app.saveVarRecent` -> ...), so the hook and the real
// implementation are deliberately two different entry points to the same
// effect.

import {
  analyzeParameterizedSources, prepareParameterizedBatch, executionView,
} from '../core/param-pipeline.js';
import type {
  ParameterAnalysis, PreparedSource, PreparedBatch, PreparedFieldState, ValidationMode, FieldControl,
} from '../core/param-pipeline.js';
import { isRowReturning } from '../core/sql-split.js';
import { effectiveFilterActive } from '../state.js';
import type { QueryTab, SaveJSON } from '../state.js';
import { KEYS } from '../state.js';
import type { RecentMap } from '../core/recent-values.js';
import { recordRecent, clearRecent, clearAllRecent } from '../core/recent-values.js';
import { enumValues, parseParamType } from '../core/param-type.js';
import type { ParamComparisonEntry } from '../core/param-comparison.js';
import { resolveComparisonColumnType } from '../core/from-scope.js';
import type { SchemaDb } from '../core/from-scope.js';

// ── Construction deps ────────────────────────────────────────────────────────

export interface WorkbenchParameterSessionHooks {
  /** Fired when `varGateBlocked` finds a blocking condition — the shell's own
   *  toast (app.ts wires this to `flashToast(message, { document: doc })`);
   *  this session never imports `ui/toast.js`. */
  onGateBlocked(message: string): void;
  /** See this module's header comment: routed back through the mutable,
   *  test-visible `app.saveVarRecent` property (app.ts wires this to
   *  `() => app.saveVarRecent()`) rather than calling this session's own
   *  `saveVarRecent()` directly, so every automatic persist
   *  `recordBoundParams`/`clearVarRecent`/`clearAllVarRecent` performs stays
   *  observable through that exact seam. */
  saveVarRecent(): void;
}

/** Live accessors onto `app.state` — read fresh on every call (never a
 *  snapshot), mirroring `dashboard-session.ts`'s own `DashboardSessionDeps`
 *  convention. `varValues`/`filterActive` are mutated IN PLACE by their
 *  consumers (renderVarStrip's `onValueInput`, filter-bar.ts, dashboard.ts) —
 *  no setter needed. `varRecent` is reassigned wholesale (a new `RecentMap`
 *  replaces the old one), hence `setVarRecent`. */
export interface WorkbenchParameterSessionDeps {
  varValues(): Record<string, string>;
  filterActive(): Record<string, boolean>;
  varRecent(): RecentMap;
  setVarRecent(map: RecentMap): void;
  varRecentDisabled(): boolean;
  /** The schema-cache accessor for `inferredEnumOptions`'s #172 v2
   *  suggestion tier — `state.schema.value` cast the same way the
   *  pre-extraction code did (only ever read against the workbench's own
   *  already-loaded schema cache, never a new query). */
  schema(): SchemaDb[] | null;
  activeTab(): QueryTab;
  /** The #173 wave wall clock (epoch ms) — matches app.ts's own `wallNow`. */
  wallNow(): number;
  /** `core/storage.js`'s `saveJSON` seam (state.ts's own `SaveJSON` shape) —
   *  this session's own `saveVarValues`/`saveFilterActive`/`saveVarRecent`/
   *  `saveVarRecentDisabled` call it directly against the KEYS below. */
  saveJSON: SaveJSON;
  hooks: WorkbenchParameterSessionHooks;
}

// ── The session ──────────────────────────────────────────────────────────────

export interface WorkbenchParameterSession {
  /** Names of `{name:Type}` variables whose value has hardened to invalid
   *  (#170 review) — a single `Set` instance, mutated in place (never
   *  reassigned). No flat `App` delegate (#276 Phase 5 deleted it) — other
   *  modules/tests read/mutate this SAME object as `app.params.hardenedVars`. */
  readonly hardenedVars: Set<string>;
  tabAnalysis(sql: string): ParameterAnalysis;
  prepareAnalyzedBatch(analysis: ParameterAnalysis, wallNowMs: number, validationMode?: ValidationMode): PreparedBatch;
  prepareTabBatch(sql: string, wallNowMs: number, validationMode?: ValidationMode): PreparedBatch;
  prepareTabSource(sql: string, wallNowMs: number, validationMode?: ValidationMode): PreparedSource;
  execStatementSql(stmt: string): string;
  varGateBlocked(wallNowMs?: number): boolean;
  hardenVar(name: string, field?: PreparedFieldState): void;
  inputGate(analysis: ParameterAnalysis): { missing: string[]; invalid: string[]; errors: string[] };
  inferredEnumOptions(
    v: FieldControl, sql: string, comparisonColumns: Record<string, ParamComparisonEntry>,
  ): string[] | null;
  recordBoundParams(boundParams: Array<{ name: string; rawValue: unknown }>): void;
  clearVarRecent(name: string): void;
  clearAllVarRecent(): void;
  saveVarValues(): void;
  saveFilterActive(): void;
  saveVarRecent(): void;
  saveVarRecentDisabled(): void;
}

/** Build a `WorkbenchParameterSession` bound to `deps`. Trivial constructor —
 *  no validation, no defaulting; the caller supplies every field exactly as
 *  it wants it used. */
export function createWorkbenchParameterSession(deps: WorkbenchParameterSessionDeps): WorkbenchParameterSession {
  // #170 review: names of `{name:Type}` variables whose value has hardened to
  // invalid (blur/Enter/execute committed a strict verdict of invalid).
  // setRunBtn's gate-less fallback (called from unrelated re-renders —
  // renderVarStrip's tail call on every SQL-editor keystroke, and the
  // hasSelection effect on every cursor/selection move) recomputes in
  // lenient 'input' mode, which reads a still-incomplete prefix (e.g. a
  // lone '-') as merely incomplete, not invalid — without this bookkeeping
  // that recompute would silently re-enable Run while the field itself
  // still paints red. Editing the field's value again (its own `oninput`)
  // clears the name here, returning it to normal lenient behavior.
  const hardenedVars = new Set<string>();

  // The optional-block activation map (#165): explicit filterActive entries
  // win; params without one derive activation from their stored value.
  const activeMap = (): Record<string, boolean> => effectiveFilterActive(deps.varValues(), deps.filterActive());

  // The workbench SQL as the pipeline's single parameterized source (#173).
  function tabAnalysis(sql: string): ParameterAnalysis {
    return analyzeParameterizedSources([
      { id: 'tab', label: 'editor tab', kind: 'tab', sql, bindPolicy: 'row-returning' },
    ]);
  }

  // Analyze + prepare `sql` as the workbench's single parameterized source
  // (#173): one call per SQL string per wave, drawing values from the shared
  // varValues (+ the #165 activation map). Returns the full prepared batch
  // ({fields, sources, diagnostics}) — `fields` is per-`{name:Type}` (#170's
  // validated state, for the var-strip's inline affordance); `sources[0]` is
  // this single source's `{statements, missing, invalid, errors, runnable}`.
  // Args for a request come from a source's statements (or mergedSourceArgs
  // when the SQL ships as one request); each statement's `sql` is its
  // execution view (#165) — byte-identical for SQL without optional blocks.
  function prepareAnalyzedBatch(analysis: ParameterAnalysis, wallNowMs: number, validationMode: ValidationMode = 'execute'): PreparedBatch {
    return prepareParameterizedBatch(analysis, {
      values: deps.varValues(), active: activeMap(), wallNowMs, validationMode,
    });
  }
  function prepareTabBatch(sql: string, wallNowMs: number, validationMode: ValidationMode = 'execute'): PreparedBatch {
    return prepareAnalyzedBatch(tabAnalysis(sql), wallNowMs, validationMode);
  }
  function prepareTabSource(sql: string, wallNowMs: number, validationMode: ValidationMode = 'execute'): PreparedSource {
    return prepareTabBatch(sql, wallNowMs, validationMode).sources[0];
  }

  // The execution text of one statement (#165): only active optional blocks
  // retained, markers stripped — byte-identical for SQL without blocks. Follows
  // the #134 bind gate: a non-row-returning statement passes through verbatim.
  function execStatementSql(stmt: string): string {
    return isRowReturning(stmt) ? executionView(stmt, activeMap()) : stmt;
  }

  // Block execution while any {name:Type} variable in the active tab is unfilled
  // or invalid, or while its value can't serialize (e.g. an array value against
  // a scalar declaration) — toasting why (#134/#173). Gating on the whole
  // tab.sqlDraft — the exact set the variable strip shows — keeps every execution
  // path consistent: the Run button (setRunBtn), the Run/⌘↵ path, Explain, and
  // Export all agree. `wallNowMs` is the caller's wave clock.
  function varGateBlocked(wallNowMs: number = deps.wallNow()): boolean {
    const tab = deps.activeTab();
    const src = tab ? prepareTabSource(tab.sqlDraft, wallNowMs) : null;
    if (!src) return false;
    const blockers = src.missing.concat(src.invalid);
    if (blockers.length) {
      deps.hooks.onGateBlocked('Enter a value for: ' + blockers.join(', '));
      return true;
    }
    if (src.errors.length) {
      deps.hooks.onGateBlocked(src.errors[0]);
      return true;
    }
    return false;
  }

  // Keep `hardenedVars` (#170 review) in sync with a field's just-computed
  // 'execute'-mode verdict: added when it's invalid, cleared otherwise — so a
  // corrected-then-reharded value, or a variable that simply stopped being
  // invalid, doesn't linger in the set. Shared by every place that commits a
  // strict verdict for a field (blur, Enter, and the strip's initial/rebuild
  // paint, which is itself an 'execute'-mode read of the persisted value).
  function hardenVar(name: string, field?: PreparedFieldState): void {
    if (field && field.state === 'invalid') hardenedVars.add(name);
    else hardenedVars.delete(name);
  }

  // The Run button's lenient ('input'-mode) gate for an already-computed
  // analysis. #170 review: a field that hardened to invalid (blur/Enter/
  // execute committed a strict invalid verdict) must keep blocking Run even
  // though this recompute is lenient — 'input' mode reads a still-incomplete
  // prefix like '-' as merely incomplete, not invalid — so `hardenedVars`
  // is folded in. Only names the batch actually declares are considered, so a
  // hardened flag for a variable that dropped out of the tab's SQL (or
  // belongs to a different tab) doesn't block Run forever; the
  // `!src.invalid.includes` filter just avoids listing a name twice. Shared
  // by setRunBtn's own fallback and renderVarStrip's tail (review F9: one
  // analysis per strip repaint feeds both consumers).
  function inputGate(analysis: ParameterAnalysis): { missing: string[]; invalid: string[]; errors: string[] } {
    const gateBatch = prepareAnalyzedBatch(analysis, deps.wallNow(), 'input');
    const src = gateBatch.sources[0];
    const hardened = [...hardenedVars].filter((name) => name in gateBatch.fields && !src.invalid.includes(name));
    return { missing: src.missing, invalid: src.invalid.concat(hardened), errors: src.errors };
  }

  // #172 v2 (schema-cache inference — the SUGGESTION tier): the enum member
  // list a plain `{name:String}` param's compared column implies, or null.
  // The declared type's own Enum members (v1, authoritative and blocking —
  // #170 validates those as a real Enum) are fieldControlKind's business;
  // this helper only ever resolves the workbench's own SQL against the
  // already-loaded schema cache (`paramComparisonColumns` +
  // `resolveComparisonColumnType`), never a new query, and the declared type
  // stays String, so #170 never blocks on a non-member.
  function inferredEnumOptions(
    v: FieldControl, sql: string, comparisonColumns: Record<string, ParamComparisonEntry>,
  ): string[] | null {
    // `.base` is value-transparent (#238): a `LowCardinality(String)` param
    // reaches this suggestion tier too, same as plain `String` — intentional,
    // since LowCardinality is just a storage encoding of String values.
    if (parseParamType(v.type).base !== 'String') return null;
    const cmp = comparisonColumns[v.name];
    if (!cmp) return null;
    const colType = resolveComparisonColumnType(sql, cmp.pos, cmp, deps.schema());
    return colType ? enumValues(colType) : null;
  }

  // --- #171 recent values + persistence -------------------------------------

  function saveVarValues(): void { deps.saveJSON(KEYS.varValues, deps.varValues()); }
  function saveFilterActive(): void { deps.saveJSON(KEYS.filterActive, deps.filterActive()); }
  function saveVarRecent(): void { deps.saveJSON(KEYS.varRecent, deps.varRecent()); }
  function saveVarRecentDisabled(): void { deps.saveJSON(KEYS.varRecentDisabled, deps.varRecentDisabled()); }

  // Record every successful statement's `boundParams` (#173's immutable
  // per-statement snapshots) into the recent-value history — the single hook
  // point every success path (run/runScript's single-statement + per-script-
  // statement paths, and the dashboard's per-tile completion) calls. A no-op
  // while the disable-history preference is on (existing history is left
  // alone, only new recording stops) or when nothing was actually bound.
  // Array-valued `rawValue` (an `Array(...)`-typed param) is skipped — v1
  // recents are a text-value affordance, like #172's (not yet built) enum
  // controls; #160's curated-`filter:`-param opt-out hook has nothing to
  // check yet (no curated param exists before #160 lands).
  function recordBoundParams(boundParams: Array<{ name: string; rawValue: unknown }>): void {
    if (deps.varRecentDisabled() || !boundParams || !boundParams.length) return;
    let map = deps.varRecent();
    for (const p of boundParams) {
      if (typeof p.rawValue !== 'string') continue;
      map = recordRecent(map, p.name, p.rawValue);
    }
    if (map !== deps.varRecent()) {
      deps.setVarRecent(map);
      deps.hooks.saveVarRecent();
    }
  }
  // Per-field "Clear recent" (the dropdown footer) / "Clear all recent
  // values" (the File menu) — both no-op (no re-persist) when there was
  // nothing to clear, mirroring recordRecent's own same-reference no-op.
  function clearVarRecent(name: string): void {
    const next = clearRecent(deps.varRecent(), name);
    if (next !== deps.varRecent()) {
      deps.setVarRecent(next);
      deps.hooks.saveVarRecent();
    }
  }
  function clearAllVarRecent(): void {
    deps.setVarRecent(clearAllRecent());
    deps.hooks.saveVarRecent();
  }

  return {
    hardenedVars,
    tabAnalysis,
    prepareAnalyzedBatch,
    prepareTabBatch,
    prepareTabSource,
    execStatementSql,
    varGateBlocked,
    hardenVar,
    inputGate,
    inferredEnumOptions,
    recordBoundParams,
    clearVarRecent,
    clearAllVarRecent,
    saveVarValues,
    saveFilterActive,
    saveVarRecent,
    saveVarRecentDisabled,
  };
}
