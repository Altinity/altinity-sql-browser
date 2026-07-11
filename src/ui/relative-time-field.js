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
//
// #171: an optional `getRecents(text)` — a LIVE callback, not a snapshot
// array (see recent-field.js's header comment on why) — upgrades the preset
// list into ONE combined dropdown: presets first (group "Presets"), then a
// "Recent" group of recorded expressions (a relative expression like `-1h`
// is recorded as typed and re-resolves on reuse, same as picking a preset).
// Omitting `getRecents` keeps this exactly the presets-only dropdown it
// always was — combobox.js itself is untouched either way. (#160's curated
// `filter:` params, when they land, opt a field out of both presets and
// recents entirely — nothing to check yet, since no curated param exists
// before #160.)

import { h } from './dom.js';
import { createCombobox } from './combobox.js';
import { attachComboFooter } from './combo-footer.js';
import { formatPreview } from '../core/relative-time.js';

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
 *   getRecents?: (text: string) => string[], // #171: live, already type+text-filtered
 *   onClearRecent?: () => void,
 *   onValueInput: () => void, // caller's existing oninput body (persist, validate, repaint)
 *   onCommit: () => void,     // caller's existing blur/Enter body (harden, repaint)
 * }} opts
 * @returns {{el: HTMLElement, input: HTMLInputElement, onFocus: Function,
 *            onInput: Function, onKeyDown: (e: KeyboardEvent) => boolean,
 *            onBlur: Function, onCompositionStart: Function, onCompositionEnd: Function}}
 */
export function buildRelativeTimeField({
  document: doc, name, type, value, baseTitle, wallNow, getRecents, onClearRecent, onValueInput, onCommit,
}) {
  const d = doc || document;
  const suffix = idSafe(name);
  const listId = 'var-combo-list-' + suffix;
  const liveId = 'var-combo-live-' + suffix;
  const previewId = 'var-combo-preview-' + suffix;

  const input = h('input', {
    type: 'text', class: 'var-input', value: value || '', placeholder: type,
    title: baseTitle, 'aria-label': name,
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId,
  });
  const listEl = h('ul', { class: 'var-combo-list', id: listId, role: 'listbox', hidden: true });
  const liveEl = h('div', { class: 'sr-only', id: liveId, 'aria-live': 'polite' });
  // Review finding #4: this is the "real element" `applyFieldState` (var-
  // field.js) points `aria-describedby` at — a stable id, shared by both the
  // workbench var-strip and the dashboard filter bar (both build fields
  // through this one module).
  const previewEl = h('div', { class: 'var-combo-preview', id: previewId });

  // Review finding #2: a near-miss expression (`{error}` from the resolver —
  // starts like `now`/±digit, doesn't fully parse) is neutral while the field
  // is still being typed into (`committed: false`) — the same timing model
  // #170 uses for the pipeline's own incomplete→invalid hardening — and only
  // becomes a visible error once the value is committed (blur, Enter, or a
  // preset pick), matching what `applyFieldState`'s 'execute'-mode repaint
  // does to the input's own is-invalid/aria-invalid state a moment later.
  function updatePreview(committed) {
    if (input.value.trim() === '') {
      previewEl.textContent = '';
      previewEl.classList.remove('is-error');
      return;
    }
    // Review finding #1: render the RESOLVED INSTANT as a human-readable local
    // calendar string (`formatPreview`), never the wire value the pipeline
    // actually sends (epoch seconds for DateTime/DateTime64) — presentation
    // only, the bound value is unaffected.
    const r = formatPreview(input.value, type, wallNow());
    if (!r.ok) {
      if (committed) {
        previewEl.textContent = r.error;
        previewEl.classList.add('is-error');
      } else {
        previewEl.textContent = '';
        previewEl.classList.remove('is-error');
      }
    } else if (r.matched) {
      previewEl.textContent = `${input.value} → ${r.display} (your time)`;
      previewEl.classList.remove('is-error');
    } else {
      previewEl.textContent = '';
      previewEl.classList.remove('is-error');
    }
  }

  // #171: with `getRecents`, one combined list — presets first (tagged so
  // they render under a "Presets" group header), then a "Recent" group of
  // recorded expressions, live-filtered by both the field's current declared
  // type and the typed text (see recentOptions in core/recent-values.js).
  // Without `getRecents`, this is unchanged: bare, ungrouped presets.
  function buildOptions(text) {
    const presets = filterPresets(text);
    if (!getRecents) return presets;
    const recents = getRecents(text).map((v) => ({ value: v, label: v, group: 'Recent' }));
    return presets.map((p) => ({ ...p, group: 'Presets' })).concat(recents);
  }

  const combo = createCombobox({
    input, listEl, liveEl, document: d,
    getOptions: (text) => buildOptions(text),
    // Picking a preset OR a recent is a deliberate, complete action —
    // simulate "typed the full expression, then committed it" rather than
    // the debounced/lenient typing path, so it takes effect immediately
    // (workbench: re-validates and re-enables Run right away; dashboard:
    // bypasses the 500ms debounce).
    onCommit: () => { updatePreview(true); onValueInput(); onCommit(); },
  });

  // The initial paint reflects an already-stored value (a tab switch, a
  // restored dashboard filter, …) — never "mid-typing" — so it's committed.
  updatePreview(true);

  // See combo-footer.js's header comment for why this is a separate element
  // rather than combobox.js growing a footer concept. Absent entirely (no
  // DOM node) when the caller hasn't wired recents at all.
  const footer = getRecents
    ? attachComboFooter({
      input, listEl, combo,
      hasRecents: () => getRecents('').length > 0,
      onClear: () => { if (onClearRecent) onClearRecent(); },
    })
    : null;
  const syncFooter = () => { if (footer) footer.sync(); };

  return {
    el: h('div', { class: 'var-combo' }, input, listEl, liveEl, previewEl, footer ? footer.el : null),
    input,
    previewEl,
    onFocus: () => { combo.onFocus(); syncFooter(); },
    onInput: () => { combo.onInput(); updatePreview(false); syncFooter(); },
    onKeyDown: (e) => {
      const consumed = combo.onKeyDown(e);
      // Enter not consumed by the combobox (no active option) falls through
      // to the caller's own hard-commit logic (app.js/dashboard.js) — harden
      // the preview the same way blur does (#170's commit timing).
      if (!consumed && e.key === 'Enter') updatePreview(true);
      syncFooter();
      return consumed;
    },
    onBlur: () => { combo.onBlur(); updatePreview(true); syncFooter(); },
    onCompositionStart: () => combo.onCompositionStart(),
    onCompositionEnd: () => { combo.onCompositionEnd(); updatePreview(false); syncFooter(); },
  };
}
