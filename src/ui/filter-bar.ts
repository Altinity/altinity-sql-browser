// The shared `{name:Type}` filter bar: one field per parameter, driving the
// same `state.varValues`/`state.filterActive` machinery the SQL Browser
// workbench uses. Extracted from the dashboard (#149 D3) when the detached Data
// view (#185) became its second consumer (CLAUDE.md rule 5) — both the
// dashboard's global filters and the detached view's per-query filter row build
// the identical field controls with the identical debounce/commit semantics;
// only the row's owner (which surface, which document realm) and what a commit
// re-runs differ, and those are injected. The field controls themselves are the
// shared leaf builders (enum/relative-time/recent + the combobox primitive).

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
import { buildFilterOptionField } from './filter-option-field.js';
import type { FilterFieldOption } from './filter-option-field.js';
import type { WorkbenchParameterSession } from '../application/workbench-parameter-session.js';

/** The narrow slice of the real `app` controller this module reads — not the
 *  full ~50-member `App` contract (app.types.ts). A real `App` satisfies this
 *  directly, and so does tests/helpers/fake-app.js's long-standing minimal
 *  `makeApp()` fixture — no cast needed on either side (same convention
 *  shortcuts.ts established for its own narrow `ShortcutsApp` contract). */
export interface FilterBarApp {
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

/** `buildFilterBar`'s options bag — `curatedFields` stays `unknown`-valued
 *  here (matching `dashboard.ts`'s own pinned wrapper type for this
 *  still-unconverted module): each entry is read through `CuratedFieldConfig`
 *  below, only once its param is confirmed curated. */
export interface BuildFilterBarOptions {
  document?: Document;
  ariaLabel?: string;
  curatedFields?: Record<string, unknown>;
}

/** #360 maintainer-review follow-up: `status`/`stale`/`waitingFor` mirror
 *  `ViewerFilterState`'s own fields (dashboard-viewer-session.ts) — but
 *  WHETHER a filter is curated at all is `dashboard.ts`'s `rebuildFilterBar`
 *  gating on `f.sourceId != null` (topology, set once at construction),
 *  never on this transient status. Status is execution state, not topology:
 *  a source-backed filter starts `status: 'idle'` before its source has even
 *  run, so gating curation on "not idle" used to render it as a bare,
 *  enabled plain-text control on initial load until the source settled.
 *  These three fields are only the AFFORDANCE this already-curated field
 *  shows — all optional so a caller that never supplies them (an older/
 *  simpler fixture) renders exactly like today's plain 'ready' combobox. */
export interface CuratedFieldStatus {
  status?: string;
  stale?: boolean;
  waitingFor?: string[];
}

/** One curated Dashboard Filter field's config (#160) — the shape
 *  `options.curatedFields[name]` carries, structurally read from the
 *  otherwise-`unknown` bag above. */
interface CuratedFieldConfig extends CuratedFieldStatus {
  options: FilterFieldOption[];
}

/** A built curated field's retained handle (#360 follow-up) — kept in
 *  `buildFilterBar`'s `curatedHandles` map so a LATER status-only change can
 *  update this exact field's affordance in place (`applyFieldStatus`, via
 *  the returned `updateStatus`) without rebuilding the whole input — the
 *  rebuild would otherwise blow away in-progress typing on every other field
 *  in the bar and drop this field's own combobox/focus state. `baseTitle`/
 *  `basePlaceholder` are this field's non-status tooltip/placeholder
 *  (`applyFieldStatus` restores them once a status stops overriding either);
 *  `noteEl` is the "Waiting for: …" node, present in the DOM only while
 *  `status === 'waiting'` (created/removed on demand, not just hidden, so a
 *  caller that queries for it — same as the pre-existing per-status build
 *  tests — sees exactly what it saw before this change). */
interface CuratedFieldHandle {
  input: HTMLInputElement;
  label: HTMLElement;
  baseTitle: string;
  basePlaceholder: string;
  noteEl: HTMLElement | null;
}

/**
 * Applies a curated field's status affordance to its already-built DOM
 * (#360 follow-up) — the SAME class/disabled/note logic `buildFilterBar`
 * used to inline once per field build, factored out so both the initial
 * build (a fresh rebuild must show the right affordance immediately) and a
 * later `updateStatus` call (no rebuild) share one recipe. See
 * `CuratedFieldStatus`'s header comment for why status, not topology, drives
 * this; see the module header's `buildFilterBar` doc for the full
 * ready/waiting/error/stale mapping.
 */
function applyFieldStatus(handle: CuratedFieldHandle, s: CuratedFieldStatus): void {
  const status = s.status ?? 'ready';
  const isWaiting = status === 'waiting';
  const isError = status === 'source-error' || status === 'helper-error' || status === 'missing-helper';
  // 'idle' (never yet run) and 'loading' (mid-flight) both read as "pending" —
  // the same is-stale/disabled affordance as a superseded-but-not-yet-stale
  // `stale: true` read, since none of the three is an actionable answer yet.
  const isStale = !isWaiting && !isError && (status === 'loading' || status === 'idle' || !!s.stale);
  const waitingNote = isWaiting ? `Waiting for: ${(s.waitingFor ?? []).join(', ')}` : '';
  const { input, label } = handle;

  input.classList.remove('is-waiting', 'is-error', 'is-stale');
  label.classList.remove('is-waiting', 'is-error', 'is-stale');
  const disabled = isWaiting || isError || isStale;
  input.disabled = disabled;
  if (disabled) input.setAttribute('aria-disabled', 'true');
  else input.removeAttribute('aria-disabled');
  if (isWaiting) { input.classList.add('is-waiting'); label.classList.add('is-waiting'); }
  else if (isError) { input.classList.add('is-error'); label.classList.add('is-error'); }
  else if (isStale) { input.classList.add('is-stale'); label.classList.add('is-stale'); }

  // Title/placeholder: the waiting note takes over both while waiting;
  // otherwise they revert to the field's own non-status text. `is-invalid`
  // (applied once at build time from the validated batch, unrelated to this
  // status) owns the title instead whenever it's set — a status update never
  // steps on the invalid-reason tooltip.
  if (!input.classList.contains('is-invalid')) input.title = isWaiting ? waitingNote : handle.baseTitle;
  input.placeholder = isWaiting ? waitingNote : handle.basePlaceholder;

  if (isWaiting) {
    if (!handle.noteEl) {
      handle.noteEl = h('span', { class: 'var-field-note' }, waitingNote);
      label.appendChild(handle.noteEl);
    } else {
      handle.noteEl.textContent = waitingNote;
    }
  } else if (handle.noteEl) {
    handle.noteEl.remove();
    handle.noteEl = null;
  }
}

// A combobox-based field controller's DOM wiring surface, PLUS the `el`
// wrapper and (relative-time fields only) the live preview element
// `applyFieldState`'s `descEl` points at — the shape every one of
// `buildEnumField`/`buildRelativeTimeField`/`buildRecentField` returns.
interface FilterBarComboField extends ComboField {
  el: HTMLElement;
  previewEl?: HTMLElement;
}

// `relative-time-field.js`/`recent-field.js` are unconverted — typed wrappers
// over the exact signatures this module relies on (verified against the
// wrapped function bodies), same convention `param-type.ts` uses for
// `clickhouse-type.js`. Both return the same `FilterBarComboField` shape
// `enum-field.ts`'s own (already-typed) `EnumField` documents.
const buildRelativeTimeField = _buildRelativeTimeField as (opts: {
  document?: Document; name: string; type: string; value: string; baseTitle: string; wallNow: () => number;
  getRecents?: (text: string) => string[]; onClearRecent?: () => void;
  onValueInput: () => void; onCommit: () => void;
}) => FilterBarComboField;

const buildRecentField = _buildRecentField as (opts: {
  document?: Document; name: string; type: string; value: string; baseTitle: string;
  getRecents: (text: string) => string[]; onClearRecent?: () => void;
  onValueInput: () => void; onCommit: () => void;
}) => FilterBarComboField;

// #188's clear-all button and "N active" count affordances (#286) were both
// removed from the Dashboard toolbar — clear-all by #294, the count by a
// 2026-07-18 owner override reversing #294's own retained-count acceptance
// criterion. Neither has a remaining UI consumer.

// Idle time after the last keystroke in a filter field before it triggers a
// re-run (#149 D3) — longer than the FROM-scope column-load debounce
// (codemirror-adapter.js) since this fires a real query, not a metadata fetch.
// Enter/blur bypass this entirely for a fast explicit-commit path.
export const FILTER_DEBOUNCE_MS = 500;

/** `buildFilterBar`'s return value (#276 Phase 3b filter-bar dispose seam):
 *  `el` is the bar's root node; `dispose()` clears every field's pending
 *  debounce timer. A caller that rebuilds the bar (a filter-value merge
 *  repaint) must dispose the previous bar first — and dispose on its own
 *  teardown — so an in-flight debounce never fires against a detached field
 *  (the orphan-timer gap a bare `replaceChildren` rebuild used to leave).
 *
 *  #360 follow-up: `updateStatus` applies a per-param `CuratedFieldStatus`
 *  update to whichever curated fields this SAME bar instance already built
 *  (`curatedHandles`, keyed by parameter) — a param this bar never curated
 *  (absent from `curatedFields` at build time, or a plain field) is silently
 *  ignored. The caller (`dashboard.ts`'s `rebuildFilterBar`) uses this for a
 *  status-only change (e.g. `loading` → `ready`, no value/active/options
 *  change) instead of tearing down and rebuilding the whole bar — preserving
 *  in-progress typing on every OTHER field, and this field's own combobox/
 *  focus state, neither of which a status flip should ever disturb. */
export interface FilterBarHandle {
  el: HTMLElement;
  dispose(): void;
  updateStatus(states: Record<string, CuratedFieldStatus>): void;
}

/**
 * Build a filter bar: one field per `{name:Type}` parameter in `params` (the
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
 * labeled group for assistive tech (the detached view labels it "Query filters").
 *
 * Returns `{ el, dispose }` (#276 Phase 3b) rather than the bare root node —
 * see `FilterBarHandle`.
 */
export function buildFilterBar(
  app: FilterBarApp,
  params: FieldControl[],
  onCommit: (name: string) => void,
  getField: (name: string, mode: ValidationMode) => PreparedFieldState,
  options: BuildFilterBarOptions = {},
): FilterBarHandle {
  const document = options.document || app.document;
  const attrs: Record<string, unknown> = { class: 'dash-filters' };
  if (options.ariaLabel) { attrs.role = 'group'; attrs['aria-label'] = options.ariaLabel; }
  if (!params.length) {
    return { el: h('div', { ...attrs, style: { display: 'none' } }), dispose: () => {}, updateStatus: () => {} };
  }
  const timerClears: Array<() => void> = [];
  // #360 follow-up: every curated field's retained handle, keyed by
  // parameter — see `CuratedFieldHandle` and `FilterBarHandle.updateStatus`.
  const curatedHandles = new Map<string, CuratedFieldHandle>();
  const el = h('div', attrs, ...params.map((p) => {
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
    const curated = options.curatedFields?.[p.name] as CuratedFieldConfig | undefined;
    if (curated) {
      const field = buildFilterOptionField({
        document, name: p.name, options: curated.options,
        value: app.state.varValues[p.name] ?? '', active: !!app.state.filterActive[p.name],
        inactiveLabel: p.optional ? 'All' : 'Not set',
        onValueChange: (value, active) => {
          app.state.varValues[p.name] = value;
          app.state.filterActive[p.name] = active;
          app.params.saveVarValues();
          app.params.saveFilterActive();
        },
        onCommit: () => onCommit(p.name),
      });
      // #345: a curated field is always the 'enum' width band (short option
      // labels) regardless of the declared param type behind it.
      applyFieldWidth(field.input, p.type, true);
      if (conflictNote) field.input.classList.add('is-conflict');
      // Same shared invalid-field affordance the plain-text branch gets below
      // (#170/var-field.js) — a curated field's committed value can still be
      // invalid against the prepared batch (e.g. a type conflict across
      // favorites), and without this it silently showed none of the
      // is-invalid class/tooltip/aria-invalid a plain filter field would.
      // Uses `baseTitle` (not a status-derived title) as the non-invalid
      // fallback — `applyFieldStatus` below layers the status-derived title
      // back on top when the field isn't currently `is-invalid`.
      applyFieldState(field.input, getField(p.name, 'execute'), baseTitle);
      const label = h('label', { class: 'var-field is-curated' + (p.optional ? ' is-optional' : '') },
        h('span', { class: 'var-name' }, p.name), field.el);
      const handle: CuratedFieldHandle = {
        input: field.input, label, baseTitle, basePlaceholder: field.input.placeholder, noteEl: null,
      };
      // #360 follow-up: apply the CURRENT status immediately at build time
      // (a fresh rebuild shows the right affordance right away) and retain
      // the handle so a LATER status-only change updates this same field in
      // place via `updateStatus`, never a rebuild.
      applyFieldStatus(handle, { status: curated.status, stale: curated.stale, waitingFor: curated.waitingFor });
      curatedHandles.set(p.name, handle);
      return label;
    }
    const commitNow = (): void => {
      if (timer == null) return;
      clearTimeout(timer);
      timer = null;
      onCommit(p.name);
    };
    // The shared control-kind priority (fieldControlKind, review F8): #172
    // enum members (v1 only here — the declaration travels with the tile SQL;
    // v2 schema-cache inference is workbench-only, and #160's curated
    // `filter:` query is the Dashboard's no-declaration alternative) > #169
    // date-like preset combobox + live preview > plain text with recents.
    // The field stays free-text in every case; D3's debounce/Enter/blur
    // commit semantics are unchanged either way.
    const ctl = fieldControlKind(p);
    let combo: FilterBarComboField | null = null;
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
      timer = setTimeout(commitNow, FILTER_DEBOUNCE_MS);
    };
    const onCommitHard = (): void => {
      applyFieldState(input, getField(p.name, 'execute'), baseTitle, combo?.previewEl);
      commitNow();
    };
    // #171: live-filtered recents for this field (type + typed text), read
    // fresh on every open/keystroke (never a snapshot — see recent-field.js's
    // header comment). (#160's curated-param opt-out hook: nothing to check
    // yet — no curated param exists before #160 lands.)
    const getRecents = (text: string): string[] => recentOptions(app.state.varRecent, p.name, p.type, text);
    const onClearRecent = (): void => app.params.clearVarRecent(p.name);
    // A preset/recent pick is a deliberate, complete action (like Enter) —
    // run immediately, bypassing the debounce `onValueInput` just armed,
    // rather than waiting out FILTER_DEBOUNCE_MS for an explicit choice.
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
  }));
  return {
    el,
    dispose: () => timerClears.forEach((clear) => clear()),
    updateStatus: (states) => {
      for (const [name, handle] of curatedHandles) {
        const s = states[name];
        if (s) applyFieldStatus(handle, s);
      }
    },
  };
}
