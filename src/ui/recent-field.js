// The plain (non-date-like) `{name:Type}` variable control's recents dropdown
// (#171 — "everything else: recents only"). Like relative-time-field.js (the
// first combobox.js consumer), the field stays a plain free-text
// `<input class="var-input">` — never read-only; picking a recent just
// inserts its text.
//
// `getRecents(text)` must be a LIVE callback (called fresh on every open/
// keystroke), not a snapshot array: the var-strip/filter-bar rebuild their
// input DOM only when the detected `{name:Type}` *set* changes (a signature
// guard), so a value recorded by a run that completes without changing that
// set would otherwise never reach an already-built field. Callers pass
// `core/recent-values.js`'s `recentOptions(state.varRecent, name, type, text)`
// (type-filtered per #170's validator, then text-filtered) — see app.js's
// `renderVarStrip` / dashboard.js's `buildFilterBar`.

import { h } from './dom.js';
import { createCombobox, idSafe } from './combobox.js';
import { attachComboFooter } from './combo-footer.js';

/**
 * @param {{
 *   document?: Document, name: string, type: string, value: string,
 *   baseTitle: string, getRecents: (text: string) => string[],
 *   onClearRecent?: () => void,
 *   onValueInput: () => void, // caller's existing oninput body
 *   onCommit: () => void,     // caller's existing blur/Enter body
 * }} opts
 * @returns {{el: HTMLElement, input: HTMLInputElement, onFocus: Function,
 *            onInput: Function, onKeyDown: (e: KeyboardEvent) => boolean,
 *            onBlur: Function, onCompositionStart: Function, onCompositionEnd: Function}}
 */
export function buildRecentField({ document: doc, name, type, value, baseTitle, getRecents, onClearRecent, onValueInput, onCommit }) {
  const d = doc || document;
  const suffix = idSafe(name);
  const listId = 'var-recent-list-' + suffix;
  const liveId = 'var-recent-live-' + suffix;

  const input = h('input', {
    type: 'text', class: 'var-input', value: value || '', placeholder: type,
    title: baseTitle, 'aria-label': name,
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId,
  });
  const listEl = h('ul', { class: 'var-combo-list', id: listId, role: 'listbox', hidden: true });
  const liveEl = h('div', { class: 'sr-only', id: liveId, 'aria-live': 'polite' });

  // `footer` is assigned right after (needs `combo` first); declared as a
  // `let` + closure up front so `createCombobox`'s `onClose` can reach it —
  // the combobox's own close path (mousedown-commit included, see
  // combobox.js's closeList()) hides the footer immediately instead of
  // waiting for the next focus/input/keydown/blur event (phase-7 user
  // feedback: the footer used to linger on screen after an option pick).
  let footer = null;
  const syncFooter = () => { if (footer) footer.sync(); };

  const combo = createCombobox({
    input, listEl, liveEl, document: d,
    getOptions: (text) => getRecents(text).map((v) => ({ value: v, label: v })),
    // A recent pick is a deliberate, complete action (mirrors
    // relative-time-field.js's preset pick) — commit immediately rather than
    // waiting for the caller's own blur/Enter/debounce path.
    onCommit: () => { onValueInput(); onCommit(); },
    onClose: syncFooter,
  });

  footer = attachComboFooter({
    input, listEl, combo,
    hasRecents: () => getRecents('').length > 0,
    // Review F4: after clearing, rebuild the OPEN list too — the footer hides
    // itself, but the already-rendered Recent options would otherwise stay
    // visible (and clickable) until the next keystroke.
    onClear: () => { if (onClearRecent) onClearRecent(); combo.refresh(); },
  });

  return {
    el: h('div', { class: 'var-combo' }, input, listEl, liveEl, footer.el),
    input,
    onFocus: () => { combo.onFocus(); footer.sync(); },
    onInput: () => { combo.onInput(); footer.sync(); },
    onKeyDown: (e) => { const consumed = combo.onKeyDown(e); footer.sync(); return consumed; },
    onBlur: () => { combo.onBlur(); footer.sync(); },
    onCompositionStart: () => combo.onCompositionStart(),
    onCompositionEnd: () => { combo.onCompositionEnd(); footer.sync(); },
  };
}
