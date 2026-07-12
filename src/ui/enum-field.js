// The enum-valued `{name:Type}` variable control (#172) — a dropdown of
// either the declared Enum8/Enum16 members (v1: workbench var-strip AND
// dashboard filter bar, since the declaration travels with the tile SQL) or
// the schema-cache-inferred members (v2: workbench only — a plain
// `{s:String}` compared to a cached Enum column). This is the THIRD consumer
// of the shared combobox primitive (combobox.js, #174 §1), after #169's date
// presets and #171's recents.
//
// Like those two, the field stays a plain free-text `<input>` — never
// read-only: typing (including a non-member value) always still works. This
// module never decides whether a non-member is blocked — that's entirely
// #170's declared-type validation (param-validate.js), reached through the
// same shared pipeline both callers already run: v1 wires a real Enum-typed
// declaration (so a non-member is blocking), v2 wires a String declaration
// whose comparison column merely happens to be a cached Enum (so a
// non-member still executes) — identical UI, different declared type
// upstream. Composition-wise, the enum values are the primary group ("Values"
// when recents are wired, matching relative-time-field.js's own paired-
// labeling rule — see `buildOptions` below); recents (#171), when wired,
// follow after a "Recent" group header.
//
// (#160 opt-out hook: a curated param will skip both enum values and recents
// entirely once #160 lands — nothing to check yet, no curated param exists
// before #160.)
//
// Large enums (Enum16 allows thousands of members): type-to-filter searches
// the COMPLETE member list first, then caps the rendered matches at
// ENUM_DROPDOWN_CAP with a "type to narrow" hint (`filterEnumValues`,
// filter-then-cap) — capping first would make a member past the cap
// unreachable by typing.

import { h } from './dom.js';
import { createCombobox, idSafe } from './combobox.js';
import { attachComboFooter } from './combo-footer.js';

/** The most dropdown rows rendered for one keystroke's matches — large
 *  enums stay navigable by typing rather than scrolling (#172 spec). */
export const ENUM_DROPDOWN_CAP = 200;

/**
 * Type-to-filter (#174 §1) over the COMPLETE `values` list: a blank query
 * shows every member (capped); otherwise a case-insensitive substring match
 * against the member name. Filters the full list first, then caps — capping
 * first would make a member past the cap unreachable by typing further. Pure.
 * @param {string[]} values
 * @param {string} text
 * @returns {{options: string[], total: number, truncated: boolean}}
 */
export function filterEnumValues(values, text) {
  const q = String(text || '').trim().toLowerCase();
  const matches = q ? values.filter((v) => v.toLowerCase().includes(q)) : values;
  return {
    options: matches.slice(0, ENUM_DROPDOWN_CAP),
    total: matches.length,
    truncated: matches.length > ENUM_DROPDOWN_CAP,
  };
}

/**
 * @param {{
 *   document?: Document, name: string, type: string, value: string,
 *   baseTitle: string, values: string[],
 *   getRecents?: (text: string) => string[], // #171: live, already type+text-filtered
 *   onClearRecent?: () => void,
 *   onValueInput: () => void, // caller's existing oninput body
 *   onCommit: () => void,     // caller's existing blur/Enter body
 * }} opts
 * @returns {{el: HTMLElement, input: HTMLInputElement, onFocus: Function,
 *            onInput: Function, onKeyDown: (e: KeyboardEvent) => boolean,
 *            onBlur: Function, onCompositionStart: Function, onCompositionEnd: Function}}
 */
export function buildEnumField({
  document: doc, name, type, value, baseTitle, values, getRecents, onClearRecent, onValueInput, onCommit,
}) {
  const d = doc || document;
  const suffix = idSafe(name);
  const listId = 'var-enum-list-' + suffix;
  const liveId = 'var-enum-live-' + suffix;
  const hintId = 'var-enum-hint-' + suffix;

  const input = h('input', {
    type: 'text', class: 'var-input', value: value || '', placeholder: type,
    title: baseTitle, 'aria-label': name,
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId,
  });
  const listEl = h('ul', { class: 'var-combo-list', id: listId, role: 'listbox', hidden: true });
  const liveEl = h('div', { class: 'sr-only', id: liveId, 'aria-live': 'polite' });
  const hintEl = h('div', { class: 'var-combo-hint', id: hintId });

  function buildOptions(text) {
    const { options, total, truncated } = filterEnumValues(values, text);
    hintEl.textContent = truncated ? `Showing ${options.length} of ${total} — type to narrow` : '';
    const enumOpts = options.map((v) => ({ value: v, label: v }));
    // Exactly relative-time-field.js's own rule: without recents this stays
    // the bare, ungrouped list it always was (no header at all); only once a
    // SECOND group (Recent) exists does the primary group get its own
    // "Values" header too — both groups labeled, or neither.
    if (!getRecents) return enumOpts;
    // Review F5: a recorded value that IS a rendered member must not appear
    // twice (once under Values, again under Recent) — the member row already
    // says everything the recent would.
    const shown = new Set(options);
    const recents = getRecents(text).filter((v) => !shown.has(v))
      .map((v) => ({ value: v, label: v, group: 'Recent' }));
    return enumOpts.map((o) => ({ ...o, group: 'Values' })).concat(recents);
  }

  // `footer` is assigned below (needs `combo` first); declared as a `let` +
  // closure up front so `createCombobox`'s `onClose` can reach it — the
  // combobox's own close path (mousedown-commit included, see combobox.js's
  // closeList()) hides the footer immediately instead of waiting for the
  // next focus/input/keydown/blur event (phase-7 user feedback: the footer
  // used to linger on screen after an option pick).
  let footer = null;
  const syncFooter = () => { if (footer) footer.sync(); };

  const combo = createCombobox({
    input, listEl, liveEl, document: d,
    getOptions: (text) => buildOptions(text),
    // Picking a value is a deliberate, complete action — commit immediately
    // (mirrors relative-time-field.js's preset pick / recent-field.js's
    // recent pick), rather than waiting on the caller's own debounce.
    onCommit: () => { onValueInput(); onCommit(); },
    onClose: syncFooter,
  });

  footer = getRecents
    ? attachComboFooter({
      input, listEl, combo,
      hasRecents: () => getRecents('').length > 0,
      // Review F4: after clearing, rebuild the OPEN list too — the footer
      // hides itself, but the already-rendered Recent options would otherwise
      // stay visible (and clickable) until the next keystroke.
      onClear: () => { if (onClearRecent) onClearRecent(); combo.refresh(); },
    })
    : null;

  return {
    el: h('div', { class: 'var-combo' }, input, listEl, liveEl, hintEl, footer ? footer.el : null),
    input,
    onFocus: () => { combo.onFocus(); syncFooter(); },
    onInput: () => { combo.onInput(); syncFooter(); },
    onKeyDown: (e) => { const consumed = combo.onKeyDown(e); syncFooter(); return consumed; },
    onBlur: () => { combo.onBlur(); hintEl.textContent = ''; syncFooter(); },
    onCompositionStart: () => combo.onCompositionStart(),
    onCompositionEnd: () => { combo.onCompositionEnd(); syncFooter(); },
  };
}
