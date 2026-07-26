// The shared `{name:Type}` variable bar: one field per parameter, driving the
// same `state.varValues`/`state.filterActive` machinery the SQL Browser
// workbench uses. Extracted from the dashboard (#149 D3) when the detached Data
// view (#185) became its second consumer (CLAUDE.md rule 5) — both the
// dashboard's global variables and the detached view's per-query variable row
// build the identical field controls with the identical debounce/commit semantics;
// only the row's owner (which surface, which document realm) and what a commit
// re-runs differ, and those are injected. The field controls themselves are the
// shared leaf builders (enum/relative-time/recent + the combobox primitive).
//
// #447 deleted the CURATED branch. A Dashboard filter used to be able to draw
// its options from a saved "Filter"-role query, which this bar rendered as
// either a strict single-select combobox (`variable-option-field.ts`) or a
// multiselect dialog (`multi-select-field.ts`), with a per-field source status
// affordance. A Dashboard's variables are now inferred from `{name:Type}`
// placeholders in panel-owned queries, so the per-field SOURCE STATUS machine
// and everything that fed it are gone for good.
//
// The two option-backed CONTROLS came back, now driven by a variable's own
// Dashboard-local option SQL rather than by a Filter-role query: a scalar
// variable gets the strict single-select, and an `Array(scalar T)` variable
// gets the searchable multiselect (restored from #189). Which one — or neither
// — is one decision, `fieldControlKind`'s: it classifies the TYPE, and this
// module pairs that verdict with whether option SQL was actually configured,
// because only the bar can see the spec.

import { h } from './dom.js';
import { fieldControlKind } from '../core/param-pipeline.js';
import type { FieldControl, PreparedFieldState, ValidationMode } from '../core/param-pipeline.js';
import { recentOptions } from '../core/recent-values.js';
import type { RecentMap } from '../core/recent-values.js';
import { applyFieldState, applyFieldWidth } from './var-field.js';
import {
  buildRelativeTimeField as _buildRelativeTimeField,
} from './relative-time-field.js';
import { buildRecentField as _buildRecentField } from './recent-field.js';
import { buildEnumField } from './enum-field.js';
import { wireComboInput } from './combobox.js';
import type { ComboField } from './combobox.js';
import { buildTimeRangeField } from './time-range-field.js';
import { buildVariableOptionField } from './variable-option-field.js';
import { buildMultiSelectField } from './multi-select-field.js';
import { Icon } from './icons.js';
import type { KeyboardOwner } from './app.types.js';
import type { VariableOption } from '../core/variable-options.types.js';
import type { DashboardTimeRangeGroup, TimeRangeRecent } from '../core/time-range.js';
import type { WorkbenchParameterSession } from '../application/workbench-parameter-session.js';

/** The narrow slice of the real `app` controller this module reads — not the
 *  full ~50-member `App` contract (app.types.ts). A real `App` satisfies this
 *  directly, and so does tests/helpers/fake-app.js's long-standing minimal
 *  `makeApp()` fixture — no cast needed on either side (same convention
 *  shortcuts.ts established for its own narrow `ShortcutsApp` contract). */
export interface VariableBarApp {
  document: Document;
  state: {
    varValues: Record<string, string>;
    filterActive: Record<string, boolean>;
    varRecent: RecentMap;
  };
  /** #276 Phase 5: no flat `App.saveVarValues`/`saveFilterActive`/
   *  `clearVarRecent` delegates — this module reads `app.params.*` directly. */
  params: Pick<WorkbenchParameterSession, 'saveVarValues' | 'saveFilterActive' | 'clearVarRecent'>;
  wallNow(): number;
}

/** `buildVariableBar`'s options bag. */
export interface BuildVariableBarOptions {
  document?: Document;
  ariaLabel?: string;
  /** #335: one entry per resolved `DashboardTimeRangeGroup` — the shell
   *  (`dashboard.ts`) assembles these from `session.timeRangeGroups` +
   *  the viewer view's fields + its `waveWallNowMs`, and this bar renders one
   *  compound `buildTimeRangeField` control per entry in a "Time" section AHEAD
   *  of the per-param fields (the pair's own two individual fields are then
   *  SUPPRESSED from the per-param loop — the compound control represents them).
   *  Left undefined/empty by a caller with no groups (every workbench/detached
   *  caller, or a dashboard whose variables form no date-like pair): the bar
   *  then renders byte-identical DOM to the pre-#335 no-time-range path. */
  timeRange?: Array<{
    group: DashboardTimeRangeGroup;
    fromValue: string;
    toValue: string;
    active: boolean;
    waveNowMs: number | null;
    recents: () => readonly TimeRangeRecent[];
  }>;
  /** #335: fires when a time-range control commits both bounds (its Apply, or
   *  an immediate recents pick) — the caller (`dashboard.ts`) routes it to
   *  `session.applyVariables` over the group's from/to variable names. Only
   *  reached when `timeRange` built at least one control. */
  onApplyTimeRange?(group: DashboardTimeRangeGroup, from: string, to: string): void;
  onKeyboardOwnerChange?: (owner: KeyboardOwner | null) => void;
  /** #447 phase 2: the Dashboard VARIABLE spec per parameter name, keyed by that
   *  name. Entirely OPT-IN: a caller that omits it (the detached Data view, and
   *  any Dashboard whose variables are all direct input) gets byte-identical DOM
   *  to the pre-#447-phase-2 bar, because every field then takes the plain
   *  branch exactly as before.
   *
   *  A parameter present here with `options` is rendered as the strict
   *  single-select over those options instead of a free-text field; one with
   *  `unsupportedType` renders a diagnostic in place of a control. A parameter
   *  ABSENT from the map is a plain direct-input field. */
  variables?: Record<string, VariableFieldSpec>;
  /** #447 phase 2: fires when an option-backed select commits — a pick, or the
   *  inline × clearing back to UNSET. Separate from `onCommit` because a select
   *  commits a value AND an activation together, with no debounce (a pick is a
   *  complete, deliberate action), where `onCommit` only names the parameter and
   *  lets the caller read the shared draft bag. */
  onCommitVariable?(name: string, value: string, active: boolean): void;
  /** Fires when a MULTI-select Apply commits. Separate from `onCommitVariable`
   *  because the value is a real `string[]`: `VariableBarApp.state.varValues` is
   *  deliberately still `Record<string, string>` (the Workbench var-strip owns
   *  and persists that same bag), so an array never round-trips through it. */
  onCommitVariableSelection?(name: string, values: string[], active: boolean): void;
}

/** One variable's fresh option rows, pushed into an already-built select by
 *  `VariableBarHandle.setVariableOptions` when a refresh's batch lands. */
export interface VariableOptionsUpdate {
  options: readonly VariableOption[];
  error: string | null;
  /** The server cut this variable's branch off at the cap, so `options` is a
   *  PREFIX. Only a multi-select reads it — to keep committed values the list
   *  does not contain, rather than canonicalizing them away. */
  incomplete?: boolean;
}

/** #447 phase 2: how ONE Dashboard variable's control differs from a plain
 *  direct-input field. */
export interface VariableFieldSpec {
  /** The options its Dashboard-local option SQL returned, or `null` when the
   *  variable is direct input (no option SQL configured). An EMPTY array is
   *  meaningfully different from `null`: the variable IS option-backed, and its
   *  query legitimately returned no rows. */
  options: readonly VariableOption[] | null;
  /** Non-null when the option batch failed: the select renders unavailable. */
  optionsError?: string | null;
  /** The committed SELECTION for a variable rendered as a multi-select
   *  (`Array(scalar T)` with options). Empty means unset. Carried here rather
   *  than in `app.state.varValues` on purpose — see
   *  `onCommitVariableSelection`. Ignored by every other control branch. */
  selection?: readonly string[];
  /** The option batch has not answered for this variable yet (its published
   *  status is still `loading`). A multi-select renders inert until it has, so a
   *  no-change Apply against a not-yet-arrived list cannot clear a restored
   *  selection. Ignored by every other control branch — the single-select
   *  commits one value the user just picked from what IS shown, so an empty
   *  list simply offers nothing to pick. */
  loading?: boolean;
  /** `options` is a PREFIX — the server cut this variable's branch off at the
   *  cap. A multi-select then preserves committed values the list does not
   *  contain instead of canonicalizing them away, matching the session's own
   *  refusal to reconcile against an incomplete list. Ignored by every other
   *  control branch. */
  optionsIncomplete?: boolean;
}

/** #335 handle-map unification: the ONE contract every retained field control
 *  in the bar is addressed through — a single `Map<string, FieldHandle>` keyed
 *  by an OPAQUE string: a parameter name for a per-param field,
 *  `group:${group.key}` for a time-range control (a ClickHouse parameter name
 *  can never contain `:`, so the two key-spaces never collide).
 *  `buildTimeRangeField` already returns this shape directly. `el` is present
 *  only for controls that participate in the popover focus-restore dance
 *  (today: the time-range control). `refreshLabel` is carried only by
 *  time-range handles (folded by `refreshTimeRangeLabels`). */
interface FieldHandle {
  el?: HTMLElement;
  /** #447 phase 2: carried only by an option-backed select. Replaces its offered
   *  options IN PLACE, so a refresh's option batch landing mid-session never
   *  rebuilds the bar — which would blow away in-progress typing in every other
   *  field and silently cancel any open popover. */
  setOptions?(next: readonly VariableOption[], error: string | null, incomplete?: boolean): void;
  /** Present on the popover-bearing controls (today: time-range); every fold
   *  over the map that needs one uses optional chaining so a handle without
   *  them is simply skipped. */
  isOpen?(): boolean;
  focusTrigger?(): void;
  dispose?(): void;
  refreshLabel?(nowMs: number): void;
}

// A combobox-based field controller's DOM wiring surface, PLUS the `el`
// wrapper and (relative-time fields only) the live preview element
// `applyFieldState`'s `descEl` points at — the shape every one of
// `buildEnumField`/`buildRelativeTimeField`/`buildRecentField` returns.
interface VariableBarComboField extends ComboField {
  el: HTMLElement;
  previewEl?: HTMLElement;
}

// `relative-time-field.js`/`recent-field.js` are unconverted — typed wrappers
// over the exact signatures this module relies on (verified against the
// wrapped function bodies), same convention `param-type.ts` uses for
// `clickhouse-type.js`. Both return the same `VariableBarComboField` shape
// `enum-field.ts`'s own (already-typed) `EnumField` documents.
const buildRelativeTimeField = _buildRelativeTimeField as (opts: {
  document?: Document; name: string; type: string; value: string; baseTitle: string; wallNow: () => number;
  getRecents?: (text: string) => string[]; onClearRecent?: () => void;
  onValueInput: () => void; onCommit: () => void;
}) => VariableBarComboField;

const buildRecentField = _buildRecentField as (opts: {
  document?: Document; name: string; type: string; value: string; baseTitle: string;
  getRecents: (text: string) => string[]; onClearRecent?: () => void;
  onValueInput: () => void; onCommit: () => void;
}) => VariableBarComboField;

// #188's clear-all button and "N active" count affordances (#286) were both
// removed from the Dashboard toolbar — clear-all by #294, the count by a
// 2026-07-18 owner override reversing #294's own retained-count acceptance
// criterion. Neither has a remaining UI consumer.

// Idle time after the last keystroke in a variable field before it triggers a
// re-run (#149 D3) — longer than the FROM-scope column-load debounce
// (codemirror-adapter.js) since this fires a real query, not a metadata fetch.
// Enter/blur bypass this entirely for a fast explicit-commit path.
export const VARIABLE_DEBOUNCE_MS = 500;

/** `buildVariableBar`'s return value (#276 Phase 3b variable-bar dispose seam):
 *  `el` is the bar's root node; `dispose()` clears every field's pending
 *  debounce timer. A caller that rebuilds the bar (a variable-value merge
 *  repaint) must dispose the previous bar first — and dispose on its own
 *  teardown — so an in-flight debounce never fires against a detached field
 *  (the orphan-timer gap a bare `replaceChildren` rebuild used to leave). */
export interface VariableBarHandle {
  el: HTMLElement;
  /** Separately mountable compound time-range region. */
  timeEl: HTMLElement;
  /** Separately mountable ordinary-variable region. */
  ordinaryEl: HTMLElement;
  dispose(): void;
  /** #447 phase 2: push fresh option rows into whichever option-backed selects
   *  THIS bar instance already built, without rebuilding anything. A key this bar
   *  built no select for is silently ignored.
   *
   *  This is the reason an options batch does not participate in the bar's
   *  rebuild signature. A rebuild is triggered by a user COMMIT, which is
   *  inherently typing-ending; an options batch lands asynchronously and could
   *  arrive while the user is mid-keystroke in an unrelated field, so rebuilding
   *  on it would discard that input and silently cancel any open popover. */
  setVariableOptions(states: Record<string, VariableOptionsUpdate>): void;
  /** #189, #189-F2b, GENERALIZED (#335): the opaque KEY of a popover-bearing
   *  control built by THIS bar instance that currently has its popover open,
   *  or `null` when none does (including a bar that built no such control at
   *  all — the empty-`params` bar too). The key is `group:${group.key}` for a
   *  time-range control.
   *  The caller (`dashboard.ts`) reads this BEFORE disposing an outgoing bar
   *  (a rebuild always disposes the old bar outright) to decide whether a
   *  refresh announcement is owed — disposing a control while its popover is
   *  open silently Cancels it (no commit, see time-range-field.ts), so without
   *  an announcement the user's open popover would simply vanish — and to move
   *  focus to that same key's trigger on the freshly-built bar
   *  (`focusFieldTrigger` below) rather than leaving focus stranded at
   *  `<body>`. */
  openPopoverKey(): string | null;
  /** Maintainer merge-gate fix (#189), GENERALIZED (#335): the opaque KEY of a
   *  field control built by THIS bar instance whose own root (`FieldHandle.el`
   *  — a time-range control's trigger) currently HOLDS FOCUS, popover open or
   *  not — or `null` when none does. Distinct from `openPopoverKey` above: an
   *  ordinary Apply closes its own popover BEFORE calling its commit callback
   *  (time-range-field.ts, the shared `openAnchoredDialog` contract), so by the
   *  time a synchronous commit-triggered rebuild reaches this bar,
   *  `openPopoverKey()` already reads `null` even though focus still sits on
   *  that field's (about-to-be-detached) trigger — this is the only remaining
   *  signal for which control's fresh trigger a rebuild should refocus. The
   *  caller (`dashboard.ts`) reads BOTH before disposing the outgoing bar and
   *  restores focus for whichever is non-null (`openPopoverKey() ??
   *  focusedFieldKey()`), so a plain field mid-typing (focus outside every
   *  popover-bearing control) is never disturbed. */
  focusedFieldKey(): string | null;
  /** #189-F2b, GENERALIZED (#335): focuses the keyed control's trigger (a
   *  time-range control's trigger) — a no-op when this bar built no such
   *  control for that key. Used by `dashboard.ts` right after building a FRESH
   *  bar, for whichever key `openPopoverKey()` (or, absent that,
   *  `focusedFieldKey()`) reported on the OUTGOING bar just before disposing
   *  it. */
  focusFieldTrigger(key: string): void;
  /** #425 — the field ROOT this bar built for `key`, for navigation that has to
   *  scroll to and highlight a control rather than just focus it. `key` is a
   *  parameter name or a `group:${key}` time-range key; a parameter OWNED by a
   *  time-range group resolves to that group's compound control, since no
   *  standalone field exists for it. `null` when this bar built nothing for the
   *  key. */
  fieldElement(key: string): HTMLElement | null;
  /** #335: re-resolve every time-range control's closed-trigger label + aria
   *  against a new wall-clock snapshot (per execution wave, no timers) — a
   *  relative range (`-1d` → `now`) re-displays its absolute bounds without a
   *  bar rebuild. A no-op when this bar built no time-range control. */
  refreshTimeRangeLabels(nowMs: number): void;
}

/**
 * Build a variable bar: one field per `{name:Type}` parameter in `params` (the
 * shape from `fieldControls(analysis)`), sharing `app.state.varValues` /
 * `app.state.filterActive` / `app.state.varRecent` with every other surface.
 * Hidden entirely (no row, no spacing) when `params` is empty — same convention
 * as the workbench's var-strip. Typing debounces before calling `onCommit(name)`;
 * Enter or blur fires immediately, clearing any pending debounce so a value
 * never applies twice. `getField(name, mode)` reads the field's current
 * #170-validated state ('input' while typing — neutral on a plausible prefix;
 * 'execute' on blur/Enter — hardens it) for the shared invalid-field affordance
 * (var-field.js).
 *
 * `options.document` is the realm nodes are built into (default `app.document`;
 * the detached Data view passes its child-tab document so the comboboxes anchor
 * in the right realm — #185). `options.ariaLabel`, when set, names the bar as a
 * labeled group for assistive tech (the detached view labels it "Query variables").
 *
 * Returns `{ el, dispose }` (#276 Phase 3b) rather than the bare root node —
 * see `VariableBarHandle`.
 */
export function buildVariableBar(
  app: VariableBarApp,
  params: FieldControl[],
  onCommit: (name: string) => void,
  getField: (name: string, mode: ValidationMode) => PreparedFieldState,
  options: BuildVariableBarOptions = {},
): VariableBarHandle {
  const document = options.document || app.document;
  const attrs: Record<string, unknown> = { class: 'dash-variables' };
  if (options.ariaLabel) { attrs.role = 'group'; attrs['aria-label'] = options.ariaLabel; }
  if (!params.length) {
    const timeEl = h('div', { class: 'dash-variable-time', style: { display: 'none' } });
    const ordinaryEl = h('div', { class: 'dash-variable-ordinary', style: { display: 'none' } });
    return {
      el: h('div', { ...attrs, style: { display: 'none' } }, timeEl, ordinaryEl),
      timeEl, ordinaryEl,
      dispose: () => {}, setVariableOptions: () => {},
      openPopoverKey: () => null, focusedFieldKey: () => null,
      focusFieldTrigger: () => {}, fieldElement: () => null,
      refreshTimeRangeLabels: () => {},
    };
  }
  const timerClears: Array<() => void> = [];
  // #335 handle-map unification: ONE map (see `FieldHandle`) keyed by the
  // opaque control key — a parameter name for a per-param field,
  // `group:${group.key}` for a time-range control.
  // `dispose`/`openPopoverKey`/`focusedFieldKey`/
  // `focusFieldTrigger`/`refreshTimeRangeLabels` all fold over this one map.
  const handles = new Map<string, FieldHandle>();
  // #425: the DOM counterpart of the `handles` key, stamped on every field's own
  // root so navigation can FIND a field it was asked to focus. `handles` alone
  // isn't enough: a plain field has no handle entry at all, yet it is still a
  // Dashboard variable a caller navigates to. Applied at the one composition
  // point below rather than in each build branch.
  const stampFieldKey = (el: HTMLElement, key: string): HTMLElement => {
    el.dataset.fieldKey = key;
    return el;
  };
  // #335: the time-range group entries, and the set of parameter names those
  // groups OWN — those params are represented by the compound control and so
  // are suppressed from the per-param loop below.
  const timeRange = options.timeRange ?? [];
  const suppressed = new Set<string>();
  for (const tr of timeRange) { suppressed.add(tr.group.fromParameter); suppressed.add(tr.group.toParameter); }

  // #447 phase 2: the opt-in Dashboard-variable specs. Absent for every
  // non-Dashboard caller, in which case `specOf` always answers `undefined` and
  // every field takes the plain branch below, unchanged.
  const variables = options.variables;
  const specOf = (name: string): VariableFieldSpec | undefined =>
    (variables ? variables[name] : undefined);

  /** The marker shown beside a variable the Dashboard cannot infer a control for.
   *
   *  Two reasons reach it, and they say different things:
   *   - a CONTAINER with no flat element list (`Tuple`/`Map`/`Nested`, or a
   *     nested `Array(Array(T))` the serializer rejects outright) can never have
   *     a control inferred, whatever the author does;
   *   - an `Array(scalar T)` with no option SQL has no LIST to pick from yet.
   *     Its type is perfectly controllable — configuring option SQL turns it
   *     into the multiselect — so saying "container type" would be misleading
   *     advice. It names the fix instead.
   *
   *  Either way it ADORNS the plain field rather than replacing it. Removing the
   *  input outright would make an existing Dashboard strictly less capable — a
   *  container-typed variable already rendered a free-text field, and
   *  `param-serialize.ts` binds an array literal typed into it perfectly well, so
   *  taking it away would leave those panels permanently `unfilled` with no way to
   *  fill them. The marker says the Dashboard cannot infer a control; it does not
   *  claim the value is unusable. */
  const unsupportedMarker = (p: FieldControl, type: string, listable = false): HTMLElement =>
    h('span', {
      class: 'var-unsupported',
      role: 'img',
      'aria-label': listable
        ? `${p.name} has no option list: add option SQL to pick from a list, or type a literal value`
        : `${p.name} has no inferred control: ${type} is a container type — type a literal value`,
      title: listable
        ? `A Dashboard has no option list for ${type}. Add option SQL to this variable to pick `
          + 'values from a list, or type a literal value directly.'
        : `A Dashboard cannot infer a control for ${type}, which is a container type. `
          + 'Type a literal value directly.',
    }, Icon.eyeOff(), type);

  /** The searchable multiselect over one `Array(scalar T)` variable's batched
   *  option rows (#189, restored). Its committed value is a real `string[]`, so
   *  — unlike every other branch here — it never touches `app.state.varValues`:
   *  that bag is `Record<string, string>` and is shared with the Workbench's own
   *  variables strip. The selection arrives on the spec and leaves on
   *  `onCommitVariableSelection`. */
  const buildMultiField = (p: FieldControl, spec: VariableFieldSpec): HTMLElement => {
    const field = buildMultiSelectField({
      document,
      name: p.name,
      options: spec.options ?? [],
      selected: spec.selection ?? [],
      active: !!app.state.filterActive[p.name],
      loading: !!spec.loading,
      incomplete: !!spec.optionsIncomplete,
      title: p.name + ': ' + p.type,
      // Apply is a complete, deliberate action, so it bypasses the keystroke
      // debounce entirely — same reasoning as the single-select's own commit.
      // Activation travels with the value: a non-empty selection is active, and
      // Clear-then-Apply returns the variable to unset.
      onApply: (values, active) => {
        app.state.filterActive[p.name] = active;
        options.onCommitVariableSelection?.(p.name, values, active);
      },
      onKeyboardOwnerChange: options.onKeyboardOwnerChange,
    });
    if (spec.optionsError != null) field.setUnavailable(spec.optionsError);
    handles.set(p.name, {
      el: field.el,
      setOptions: (next, error, incomplete) => {
        field.setOptions(next, incomplete);
        field.setUnavailable(error);
      },
      isOpen: field.isOpen,
      focusTrigger: field.focusTrigger,
      dispose: field.dispose,
    });
    return h('label', { class: 'var-field' },
      h('span', { class: 'var-name' }, p.name), field.el);
  };

  /** The strict single-select over one variable's batched option rows. */
  const buildOptionField = (p: FieldControl, spec: VariableFieldSpec): HTMLElement => {
    const field = buildVariableOptionField({
      document,
      name: p.name,
      options: spec.options ?? [],
      value: app.state.varValues[p.name] || '',
      active: !!app.state.filterActive[p.name],
      title: p.name + ': ' + p.type,
      onCommit: (value, active) => {
        // A select commits value AND activation together — a pick (or the × that
        // clears back to unset) is a complete, deliberate action, so it bypasses
        // the keystroke debounce entirely. The shared draft bag is kept in step so
        // every other reader (the invalid-field affordance, a sibling rebuild)
        // still sees one source of truth.
        app.state.varValues[p.name] = value;
        app.state.filterActive[p.name] = active;
        options.onCommitVariable?.(p.name, value, active);
      },
    });
    if (spec.optionsError != null) field.setUnavailable(spec.optionsError);
    handles.set(p.name, {
      el: field.el,
      setOptions: (next, error) => {
        field.setOptions(next);
        field.setUnavailable(error);
      },
      dispose: field.dispose,
    });
    return h('label', { class: 'var-field' },
      h('span', { class: 'var-name' }, p.name), field.el);
  };

  const buildParamField = (p: FieldControl): HTMLElement => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    timerClears.push(() => { if (timer != null) clearTimeout(timer); timer = null; });
    // #173 acceptance (review F1): a type-conflicted param (declared with
    // disagreeing types across favorites) degrades to the plain text control
    // (fieldControlKind below) and says so visibly — a warning style distinct
    // from is-invalid (the VALUE isn't wrong; the declarations disagree) plus
    // a tooltip listing them.
    const conflictNote = p.conflict
      ? 'Conflicting type declarations: ' + p.conflict.join(' vs ') : null;
    const baseTitle = p.name + ': ' + p.type
      + (p.optional ? ' — optional: blank leaves its filter block out' : '')
      + (conflictNote ? ' — ' + conflictNote : '');
    const commitNow = (): void => {
      if (timer == null) return;
      clearTimeout(timer);
      timer = null;
      onCommit(p.name);
    };
    // The shared control-kind priority (fieldControlKind, review F8): #172
    // enum members (v1 only here — the declaration travels with the tile SQL;
    // v2 schema-cache inference is workbench-only) > #169 date-like preset
    // combobox + live preview > plain text with recents.
    // The field stays free-text in every case; D3's debounce/Enter/blur
    // commit semantics are unchanged either way.
    // #447 phase 2: a Dashboard variable binds ONE scalar per name, so that
    // surface opts into the scalar-controls policy (Bool gains true/false
    // suggestions). Every other caller passes nothing and keeps the exact
    // enum > date > text dispatch it had before.
    const ctl = fieldControlKind(p, null, { scalarControls: !!variables });
    let combo: VariableBarComboField | null = null;
    let input: HTMLInputElement;
    const onValueInput = (): void => {
      app.state.varValues[p.name] = input.value;
      // Text controls sync activation with the value (#165): an activation
      // flip re-runs affected tiles exactly like a value change (same
      // debounce + generation guard downstream).
      app.state.filterActive[p.name] = input.value !== '';
      app.params.saveVarValues();
      app.params.saveFilterActive();
      applyFieldState(input, getField(p.name, 'input'), baseTitle, combo?.previewEl);
      // `!`: DOM's clearTimeout is a documented no-op on `null`/`undefined` —
      // the original .js called it unconditionally (`timer` starts `null`).
      clearTimeout(timer!);
      timer = setTimeout(commitNow, VARIABLE_DEBOUNCE_MS);
    };
    const onCommitHard = (): void => {
      applyFieldState(input, getField(p.name, 'execute'), baseTitle, combo?.previewEl);
      commitNow();
    };
    // #171: live-filtered recents for this field (type + typed text), read
    // fresh on every open/keystroke (never a snapshot — see recent-field.js's
    // header comment).
    const getRecents = (text: string): string[] => recentOptions(app.state.varRecent, p.name, p.type, text);
    const onClearRecent = (): void => app.params.clearVarRecent(p.name);
    // A preset/recent pick is a deliberate, complete action (like Enter) —
    // run immediately, bypassing the debounce `onValueInput` just armed,
    // rather than waiting out VARIABLE_DEBOUNCE_MS for an explicit choice.
    const onPick = (): void => {
      applyFieldState(input, getField(p.name, 'execute'), baseTitle, combo?.previewEl);
      if (timer != null) clearTimeout(timer);
      timer = null;
      onCommit(p.name);
    };
    const fieldOpts = {
      document, name: p.name, type: p.type, value: app.state.varValues[p.name] || '',
      baseTitle, onValueInput, onCommit: onPick, getRecents, onClearRecent,
    };
    if (ctl.kind === 'enum') combo = buildEnumField({ ...fieldOpts, values: ctl.enumOptions! });
    else if (ctl.kind === 'date') combo = buildRelativeTimeField({ ...fieldOpts, wallNow: app.wallNow });
    else combo = buildRecentField(fieldOpts);
    input = combo.input;
    // #345: a stable, type-appropriate width — set once per field build
    // (never on keystroke), keyed off the declared type so Date/DateTime
    // (same combobox control, different widths) don't collapse to one band.
    applyFieldWidth(input, p.type, ctl.kind === 'enum');
    // The shared listener block (review F8): the combobox hooks first, then
    // D3's own persist-on-type / Enter-blur hard-commit bodies.
    wireComboInput(combo, { onValueInput, onCommit: onCommitHard });
    if (conflictNote) input.classList.add('is-conflict');
    applyFieldState(input, getField(p.name, 'execute'), baseTitle, combo?.previewEl);
    return h('label', { class: 'var-field' + (p.optional ? ' is-optional' : '') },
      h('span', { class: 'var-name' }, p.name), combo.el);
  };

  // #335: the "Time" section — a `.flabel` heading + one compound time-range
  // control per group + a separator — rendered AHEAD of the per-param fields.
  // Each control's handle is registered under `group:${group.key}` so it
  // participates in the unified map's dispose/focus/refresh folds. Its
  // Apply (and immediate recents pick) route through `onApplyTimeRange`.
  const timeSection: (HTMLElement | null)[] = [];
  if (timeRange.length) {
    timeSection.push(h('span', { class: 'flabel' }, 'Time'));
    for (const tr of timeRange) {
      const trField = buildTimeRangeField({
        document, group: tr.group,
        fromValue: tr.fromValue, toValue: tr.toValue, active: tr.active,
        waveNowMs: tr.waveNowMs, wallNow: app.wallNow, getRecents: tr.recents,
        onApply: (from, to) => options.onApplyTimeRange?.(tr.group, from, to),
        onKeyboardOwnerChange: options.onKeyboardOwnerChange,
      });
      handles.set(`group:${tr.group.key}`, trField);
      timeSection.push(stampFieldKey(trField.el, `group:${tr.group.key}`));
    }
    timeSection.push(h('span', { class: 'trf-sep', 'aria-hidden': 'true' }));
  }

  // The per-param fields (every param NOT owned by a time-range group).
  // #447 phase 2 adds two variable-only branches ahead of the plain one; with no
  // `variables` map every param still reaches `buildParamField` unchanged.
  const buildField = (p: FieldControl): HTMLElement => {
    // The type verdict comes from the SAME shared decision `buildParamField`
    // consults, rather than being passed in by the caller — one decision point, so
    // the control a Dashboard renders and the policy that classified its type can
    // never disagree. `multiSelectElementType`, which produces `'multi'` here, is
    // also the predicate `core/variable-options.js` filters the option batch on,
    // so a type that gets a select can never be one whose option SQL was skipped.
    const kind = fieldControlKind(p, null, { scalarControls: !!variables }).kind;
    // A container with no flat element list: no control is inferable at all.
    if (kind === 'unsupported') {
      const field = buildParamField(p);
      field.appendChild(unsupportedMarker(p, p.type));
      return field;
    }
    const spec = specOf(p.name);
    if (kind === 'multi') {
      // The type CAN be multi-selected; whether there is anything to select from
      // is the spec's answer, which only this layer can see.
      if (spec && spec.options !== null) return buildMultiField(p, spec);
      const field = buildParamField(p);
      field.appendChild(unsupportedMarker(p, p.type, true));
      return field;
    }
    if (spec && spec.options !== null) return buildOptionField(p, spec);
    return buildParamField(p);
  };
  const perParamFields = params.filter((p) => !suppressed.has(p.name))
    .map((p) => stampFieldKey(buildField(p), p.name));

  // Compose: Time section, then a "Variables" section label (only when BOTH a
  // Time section rendered AND at least one non-group field remains), then the
  // per-param fields. With no time-range groups `timeSection` is empty and no
  // "Variables" label renders, so the child list is byte-identical to the
  // pre-#335 `...params.map(...)` output.
  const timeEl = h('div', {
    class: 'dash-variable-time',
    style: timeRange.length ? undefined : { display: 'none' },
  }, ...timeSection);
  const ordinaryEl = h('div', {
    class: 'dash-variable-ordinary',
    style: perParamFields.length ? undefined : { display: 'none' },
  }, timeRange.length && perParamFields.length ? h('span', { class: 'flabel' }, 'Variables') : null,
  ...perParamFields);
  const el = h('div', attrs, timeEl, ordinaryEl);
  return {
    el, timeEl, ordinaryEl,
    dispose: () => {
      timerClears.forEach((clear) => clear());
      // Disposing a control WHILE its popover is open is that control's own
      // Cancel (no commit callback, see time-range-field.ts) — a bar rebuild/
      // teardown always tears every open popover down this way. A plain field
      // registers no handle and so has nothing to dispose beyond its timer.
      for (const handle of handles.values()) handle.dispose?.();
    },
    // #447 phase 2: fold over the same unified map — only option-backed selects
    // carry `setOptions`, so every other handle is skipped.
    setVariableOptions: (states) => {
      for (const [key, handle] of handles) {
        const s = states[key];
        if (s) handle.setOptions?.(s.options, s.error, s.incomplete);
      }
    },
    // #189-F2b, GENERALIZED (#335): read by the caller BEFORE disposing this
    // bar (a rebuild), to decide whether an outgoing popover's forced Cancel
    // deserves a refresh announcement AND which control's fresh trigger should
    // receive focus — see `dashboard.ts`'s `rebuildVariableBar`.
    openPopoverKey: () => {
      for (const [key, handle] of handles) if (handle.isOpen?.()) return key;
      return null;
    },
    // `.el` is each popover-bearing control's own root (a time-range control's
    // trigger wrapper), so `.contains(activeElement)` catches focus on it
    // regardless of popover state.
    focusedFieldKey: () => {
      const active = document.activeElement;
      if (!active) return null;
      for (const [key, handle] of handles) if (handle.el && handle.el.contains(active)) return key;
      return null;
    },
    focusFieldTrigger: (key) => { handles.get(key)?.focusTrigger?.(); },
    // #425: resolve by the stamped DOM key. A parameter a time-range group OWNS
    // has no standalone field (it is suppressed from the per-param loop), so it
    // resolves to that group's compound control — otherwise navigating to a
    // from/to variable would wrongly report "no such variable".
    fieldElement: (key) => {
      const owning = timeRange.find((tr) =>
        tr.group.fromParameter === key || tr.group.toParameter === key);
      const stamped = owning ? `group:${owning.group.key}` : key;
      // Searched from `timeEl`/`ordinaryEl`, NOT from `el`: the caller mounts
      // those two regions separately (dashboard.ts splits the compound time
      // controls into the primary toolbar and the ordinary fields into the variable
      // row), which re-parents them out of `el` and leaves it empty.
      // Matched by dataset read rather than an attribute selector: a parameter
      // name is user data and would need escaping to be selector-safe.
      for (const region of [timeEl, ordinaryEl]) {
        for (const node of region.querySelectorAll<HTMLElement>('[data-field-key]')) {
          if (node.dataset.fieldKey === stamped) return node;
        }
      }
      return null;
    },
    // #335: fold `refreshLabel` over the map — only time-range handles carry
    // it; every other handle skips (optional chaining), so this is a no-op for
    // a bar with no time-range controls.
    refreshTimeRangeLabels: (nowMs) => {
      for (const handle of handles.values()) handle.refreshLabel?.(nowMs);
    },
  };
}
