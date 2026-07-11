// The date-like `{name:Type}` variable control (#169): the FIRST consumer of
// the accessible combobox primitive (combobox.js, #174 §1) — #171 (recents)
// and #172 (enum values) are expected to reuse it, so the wiring here is kept
// cleanly separable: this module owns only "what a relative-time field looks
// like and does" (presets, live preview, ARIA ids); combobox.js owns "how a
// type-to-filter dropdown behaves" (nothing here reimplements keyboard nav).
//
// The field stays a plain free-text `<input class="var-input">` — never
// read-only — so an absolute timestamp keeps working exactly as before
// (#169 rule 6); picking a preset just inserts its expression text. The
// caller (app.js's renderVarStrip / dashboard.js's buildFilterBar) keeps
// 100% of its existing persistence/validation logic (oninput → persist +
// applyFieldState + setRunBtn/debounced-commit; onblur/Enter → harden) — it
// just also calls this object's `onFocus`/`onInput`/`onKeyDown`/`onBlur`/
// `onCompositionStart`/`onCompositionEnd` as the FIRST line of its own
// handlers of the same name, exactly the way it already calls
// `applyFieldState` as a plain shared helper (var-field.js). Composing this
// way — rather than this module attaching its own listeners — avoids two
// independent 'keydown' listeners racing over the same Enter keystroke (see
// combobox.js's header comment).

import { h } from './dom.js';
import { createCombobox } from './combobox.js';
import { resolveVarValues } from '../core/relative-time.js';

/** v1 preset list (#169 spec) — plain combobox option data. */
export const RELATIVE_TIME_PRESETS = [
  { value: '-15m', label: '-15m — last 15 minutes' },
  { value: '-1h', label: '-1h — last hour' },
  { value: '-6h', label: '-6h — last 6 hours' },
  { value: '-1d', label: '-1d — last day' },
  { value: '-7d', label: '-7d — last 7 days' },
  { value: '-1M', label: '-1M — last month' },
  { value: 'now/d', label: 'now/d — start of today' },
  { value: '-1d/d', label: '-1d/d — start of yesterday' },
  { value: 'now', label: 'now — this instant' },
];

/** Type-to-filter (#174 §1): a blank query shows every preset; otherwise a
 * case-insensitive substring match against either the expression or its
 * label — matching "1" surfaces every preset built from a `1`, matching
 * "day" surfaces both `-1d` (via its label) and `-1d/d`. Pure. */
export function filterPresets(text) {
  const q = String(text || '').trim().toLowerCase();
  if (!q) return RELATIVE_TIME_PRESETS;
  return RELATIVE_TIME_PRESETS.filter((p) => p.value.toLowerCase().includes(q) || p.label.toLowerCase().includes(q));
}

// A name-derived, HTML-id-safe suffix: variable names are scanner-restricted
// to identifier-shaped tokens in practice, but sanitize defensively so a
// stray character never produces an invalid id.
const idSafe = (name) => String(name).replace(/[^\w-]/g, '_');

/**
 * @param {{
 *   document?: Document, name: string, type: string, value: string,
 *   baseTitle: string, wallNow: () => number,
 *   onValueInput: () => void, // caller's existing oninput body (persist, validate, repaint)
 *   onCommit: () => void,     // caller's existing blur/Enter body (harden, repaint)
 * }} opts
 * @returns {{el: HTMLElement, input: HTMLInputElement, onFocus: Function,
 *            onInput: Function, onKeyDown: (e: KeyboardEvent) => boolean,
 *            onBlur: Function, onCompositionStart: Function, onCompositionEnd: Function}}
 */
export function buildRelativeTimeField({ document: doc, name, type, value, baseTitle, wallNow, onValueInput, onCommit }) {
  const d = doc || document;
  const suffix = idSafe(name);
  const listId = 'var-combo-list-' + suffix;
  const liveId = 'var-combo-live-' + suffix;

  const input = h('input', {
    type: 'text', class: 'var-input', value: value || '', placeholder: type,
    title: baseTitle, 'aria-label': name,
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId,
  });
  const listEl = h('ul', { class: 'var-combo-list', id: listId, role: 'listbox', hidden: true });
  const liveEl = h('div', { class: 'sr-only', id: liveId, 'aria-live': 'polite' });
  const previewEl = h('div', { class: 'var-combo-preview' });

  function updatePreview() {
    if (input.value.trim() === '') {
      previewEl.textContent = '';
      previewEl.classList.remove('is-error');
      return;
    }
    // The one-field UI preview is the batch helper's degenerate case (a
    // single-name/value pair) — it's the entry point the spec calls "the UI
    // layers call", kept as one call so a future multi-field preview (e.g. a
    // paired from/to range) needs no new plumbing.
    const r = resolveVarValues([{ name, type }], { [name]: input.value }, wallNow())[name];
    if (!r.ok) {
      previewEl.textContent = r.error;
      previewEl.classList.add('is-error');
    } else if (r.matched) {
      previewEl.textContent = `${input.value} → ${r.value} (your time)`;
      previewEl.classList.remove('is-error');
    } else {
      previewEl.textContent = '';
      previewEl.classList.remove('is-error');
    }
  }

  const combo = createCombobox({
    input, listEl, liveEl, document: d,
    getOptions: (text) => filterPresets(text),
    // Picking a preset is a deliberate, complete action — simulate "typed the
    // full expression, then committed it" rather than the debounced/lenient
    // typing path, so it takes effect immediately (workbench: re-validates
    // and re-enables Run right away; dashboard: bypasses the 500ms debounce).
    onCommit: () => { updatePreview(); onValueInput(); onCommit(); },
  });

  updatePreview();

  return {
    el: h('div', { class: 'var-combo' }, input, listEl, liveEl, previewEl),
    input,
    onFocus: () => combo.onFocus(),
    onInput: () => { combo.onInput(); updatePreview(); },
    onKeyDown: (e) => combo.onKeyDown(e),
    onBlur: () => combo.onBlur(),
    onCompositionStart: () => combo.onCompositionStart(),
    onCompositionEnd: () => { combo.onCompositionEnd(); updatePreview(); },
  };
}
