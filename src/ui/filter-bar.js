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
import { recentOptions } from '../core/recent-values.js';
import { applyFieldState } from './var-field.js';
import { buildRelativeTimeField } from './relative-time-field.js';
import { buildRecentField } from './recent-field.js';
import { buildEnumField } from './enum-field.js';
import { wireComboInput } from './combobox.js';
import { buildFilterOptionField } from './filter-option-field.js';

// Idle time after the last keystroke in a filter field before it triggers a
// re-run (#149 D3) — longer than the FROM-scope column-load debounce
// (codemirror-adapter.js) since this fires a real query, not a metadata fetch.
// Enter/blur bypass this entirely for a fast explicit-commit path.
export const FILTER_DEBOUNCE_MS = 500;

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
 */
export function buildFilterBar(app, params, onCommit, getField, options = {}) {
  const document = options.document || app.document;
  const attrs = { class: 'dash-filters' };
  if (options.ariaLabel) { attrs.role = 'group'; attrs['aria-label'] = options.ariaLabel; }
  if (!params.length) return h('div', { ...attrs, style: { display: 'none' } });
  return h('div', attrs, ...params.map((p) => {
    let timer = null;
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
    const curated = options.curatedFields?.[p.name];
    if (curated) {
      const field = buildFilterOptionField({
        document, name: p.name, options: curated.options,
        value: app.state.varValues[p.name] ?? '', active: !!app.state.filterActive[p.name],
        inactiveLabel: p.optional ? 'All' : 'Not set',
        onValueChange: (value, active) => {
          app.state.varValues[p.name] = value;
          app.state.filterActive[p.name] = active;
          app.saveVarValues();
          app.saveFilterActive();
        },
        onCommit: () => onCommit(p.name),
      });
      field.input.title = baseTitle;
      if (conflictNote) field.input.classList.add('is-conflict');
      // Same shared invalid-field affordance the plain-text branch gets below
      // (#170/var-field.js) — a curated field's committed value can still be
      // invalid against the prepared batch (e.g. a type conflict across
      // favorites), and without this it silently showed none of the
      // is-invalid class/tooltip/aria-invalid a plain filter field would.
      applyFieldState(field.input, getField(p.name, 'execute'), baseTitle);
      return h('label', { class: 'var-field is-curated' + (p.optional ? ' is-optional' : '') },
        h('span', { class: 'var-name' }, p.name), field.el);
    }
    const commitNow = () => {
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
    let combo = null;
    let input;
    const onValueInput = () => {
      app.state.varValues[p.name] = input.value;
      // Text controls sync activation with the value (#165): an activation
      // flip re-runs affected tiles exactly like a value change (same
      // debounce + generation guard downstream).
      app.state.filterActive[p.name] = input.value !== '';
      app.saveVarValues();
      app.saveFilterActive();
      applyFieldState(input, getField(p.name, 'input'), baseTitle, combo && combo.previewEl);
      clearTimeout(timer);
      timer = setTimeout(commitNow, FILTER_DEBOUNCE_MS);
    };
    const onCommitHard = () => {
      applyFieldState(input, getField(p.name, 'execute'), baseTitle, combo && combo.previewEl);
      commitNow();
    };
    // #171: live-filtered recents for this field (type + typed text), read
    // fresh on every open/keystroke (never a snapshot — see recent-field.js's
    // header comment). (#160's curated-param opt-out hook: nothing to check
    // yet — no curated param exists before #160 lands.)
    const getRecents = (text) => recentOptions(app.state.varRecent, p.name, p.type, text);
    const onClearRecent = () => app.clearVarRecent(p.name);
    // A preset/recent pick is a deliberate, complete action (like Enter) —
    // run immediately, bypassing the debounce `onValueInput` just armed,
    // rather than waiting out FILTER_DEBOUNCE_MS for an explicit choice.
    const onPick = () => {
      applyFieldState(input, getField(p.name, 'execute'), baseTitle, combo && combo.previewEl);
      clearTimeout(timer);
      timer = null;
      onCommit(p.name);
    };
    const fieldOpts = {
      document, name: p.name, type: p.type, value: app.state.varValues[p.name] || '',
      baseTitle, onValueInput, onCommit: onPick, getRecents, onClearRecent,
    };
    if (ctl.kind === 'enum') combo = buildEnumField({ ...fieldOpts, values: ctl.enumOptions });
    else if (ctl.kind === 'date') combo = buildRelativeTimeField({ ...fieldOpts, wallNow: app.wallNow });
    else combo = buildRecentField(fieldOpts);
    input = combo.input;
    // The shared listener block (review F8): the combobox hooks first, then
    // D3's own persist-on-type / Enter-blur hard-commit bodies.
    wireComboInput(combo, { onValueInput, onCommit: onCommitHard });
    if (conflictNote) input.classList.add('is-conflict');
    applyFieldState(input, getField(p.name, 'execute'), baseTitle, combo && combo.previewEl);
    return h('label', { class: 'var-field' + (p.optional ? ' is-optional' : '') },
      h('span', { class: 'var-name' }, p.name), combo.el);
  }));
}
