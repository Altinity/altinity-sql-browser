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
// list into ONE combined dropdown: a "Recent" group of recorded expressions
// FIRST (a relative expression like `-1h` is recorded as typed and
// re-resolves on reuse, same as picking a preset), then the "Presets" group
// (user decision, phase-7 feedback: recents-first — a repeat query is more
// likely to want its own recent expression than to rediscover it in the
// static preset list). Omitting `getRecents` keeps this exactly the
// presets-only dropdown it always was — combobox.js itself is untouched
// either way. (#160's curated `filter:` params, when they land, opt a field
// out of both presets and recents entirely — nothing to check yet, since no
// curated param exists before #160.)
//
// Dedup direction follows the group order: a recorded expression that's ALSO
// a preset (`-1h`) surfaces once, under whichever group renders it FIRST —
// i.e. Recent, not Presets (inverted from the enum/plain-recents fields,
// which stay Values/plain-first and so dedup the other way — see #172's
// enum-field.js and #171's recent-field.js).

import { h } from './dom.js';
import { createCombobox, idSafe } from './combobox.js';
import { attachComboFooter } from './combo-footer.js';
import { formatPreview } from '../core/relative-time.js';
import type { ComboKeyEvent, ComboOption } from './combobox.js';
import type { ComboFooter } from './combo-footer.js';

/** One preset option, plus the group label composition adds once recents
 *  are wired (see `buildOptions`). */
export interface RelativeTimePreset {
  value: string;
  label: string;
}

/** v1 preset list (#169 spec) — plain combobox option data. Kept EXACTLY as
 *  it was before #335 — bit-identical entries/order/labels — this field's
 *  own preset dropdown is untouched by the time-range control's arrival. */
export const RELATIVE_TIME_PRESETS: RelativeTimePreset[] = [
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

/**
 * #335 time-range popover's per-field "constants" column — one plain-
 * language relative-time token per row, distinct from (and a superset in
 * spirit of, though not literally overlapping with) `RELATIVE_TIME_PRESETS`
 * above, which stays exactly as it was. Order here is the pinned design
 * order: `now` first, then ascending offsets grouped by unit (minutes,
 * hours, days, the one month entry, then the 90-day outlier the design
 * places last). Consumed by the time-range field UI (a later wave); this
 * module only owns the data + the shared filter helper below.
 */
export const TIME_RANGE_CONSTANTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'now', label: 'now — current time' },
  { value: '-5m', label: '-5m — 5 minutes ago' },
  { value: '-15m', label: '-15m — 15 minutes ago' },
  { value: '-30m', label: '-30m — 30 minutes ago' },
  { value: '-1h', label: '-1h — 1 hour ago' },
  { value: '-3h', label: '-3h — 3 hours ago' },
  { value: '-6h', label: '-6h — 6 hours ago' },
  { value: '-12h', label: '-12h — 12 hours ago' },
  { value: '-1d', label: '-1d — 1 day ago' },
  { value: '-2d', label: '-2d — 2 days ago' },
  { value: '-7d', label: '-7d — 7 days ago' },
  { value: '-30d', label: '-30d — 30 days ago' },
  { value: '-1M', label: '-1M — 1 month ago' },
  { value: '-90d', label: '-90d — 90 days ago' },
];

/**
 * Type-to-filter (#174 §1, generalized for #335): a blank query returns
 * `list` itself (never a copy — callers/tests rely on referential identity
 * when nothing was typed); otherwise a case-insensitive substring match
 * against either a row's `value` or its `label`. Pure, and usable over any
 * `{value, label}`-shaped list — `filterPresets` below is now a one-line
 * wrapper over `RELATIVE_TIME_PRESETS`, behavior unchanged.
 */
export function filterTokenList<T extends { value: string; label: string }>(
  list: readonly T[],
  text: string | undefined,
): readonly T[] {
  const q = String(text || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((item) => item.value.toLowerCase().includes(q) || item.label.toLowerCase().includes(q));
}

/** Type-to-filter (#174 §1): a blank query shows every preset; otherwise a
 * case-insensitive substring match against either the expression or its
 * label — matching "1" surfaces every preset built from a `1`, matching
 * "day" surfaces both `-1d` (via its label) and `-1d/d`. Pure. */
export function filterPresets(text: string | undefined): RelativeTimePreset[] {
  return filterTokenList(RELATIVE_TIME_PRESETS, text) as RelativeTimePreset[];
}

/** `buildRelativeTimeField`'s options bag. */
export interface BuildRelativeTimeFieldOpts {
  document?: Document;
  name: string;
  type: string;
  value: string;
  baseTitle: string;
  wallNow: () => number;
  /** #171: live, already type+text-filtered. */
  getRecents?: (text: string) => string[];
  onClearRecent?: () => void;
  /** caller's existing oninput body (persist, validate, repaint). */
  onValueInput: () => void;
  /** caller's existing blur/Enter body (harden, repaint). */
  onCommit: () => void;
}

/** What `buildRelativeTimeField` returns — the field controller its caller
 *  (the workbench var-strip / dashboard filter bar) delegates its own DOM
 *  listeners to. `previewEl` is the extra field `applyFieldState` (var-
 *  field.js) points `aria-describedby` at. */
export interface RelativeTimeField {
  el: HTMLElement;
  input: HTMLInputElement;
  previewEl: HTMLElement;
  onFocus: () => void;
  onInput: () => void;
  onKeyDown: (e: ComboKeyEvent) => boolean;
  onBlur: () => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
}

export function buildRelativeTimeField({
  document: doc, name, type, value, baseTitle, wallNow, getRecents, onClearRecent, onValueInput, onCommit,
}: BuildRelativeTimeFieldOpts): RelativeTimeField {
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
  function updatePreview(committed: boolean): void {
    if (input.value.trim() === '') {
      previewEl.textContent = '';
      previewEl.classList.remove('is-error');
      return;
    }
    // Review finding #1: render the RESOLVED INSTANT as a human-readable
    // UTC ("server time") calendar string (`formatPreview`), never the wire
    // value the pipeline actually sends (epoch seconds for DateTime/
    // DateTime64) — presentation only, the bound value is unaffected.
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
      // The expression is already visible in the input. Keep only the
      // server-time instant that will be used when the query runs.
      previewEl.textContent = r.display;
      previewEl.classList.remove('is-error');
    } else {
      previewEl.textContent = '';
      previewEl.classList.remove('is-error');
    }
  }

  // #171: with `getRecents`, one combined list — a "Recent" group of
  // recorded expressions FIRST, then the "Presets" group, live-filtered by
  // both the field's current declared type and the typed text (see
  // recentOptions in core/recent-values.js). Without `getRecents`, this is
  // unchanged: bare, ungrouped presets.
  function buildOptions(text: string): ComboOption[] {
    const presets = filterPresets(text);
    if (!getRecents) return presets;
    const recentValues = getRecents(text);
    // Review F5, inverted for the recents-first order (phase-7 feedback): a
    // recorded expression that IS a rendered preset (`-1h` after one run)
    // must not appear twice — it now surfaces under Recent (the FIRST group
    // it appears in), so it's the preset row that's filtered out, not the
    // recent one.
    const shown = new Set(recentValues);
    const recents = recentValues.map((v) => ({ value: v, label: v, group: 'Recent' }));
    const presetsMinusRecents = presets.filter((p) => !shown.has(p.value))
      .map((p) => ({ ...p, group: 'Presets' }));
    return recents.concat(presetsMinusRecents);
  }

  // `footer` is assigned below (it needs `combo` to exist first), but
  // `createCombobox`'s `onClose` needs to reach it too — a `let` + a
  // `syncFooter` closure declared up front (rather than after `footer`
  // exists, as before) lets the combobox's own close path (mousedown-commit
  // included, see combobox.js's closeList()) hide the footer immediately
  // instead of waiting for the next focus/input/keydown/blur event (phase-7
  // user feedback: the footer used to linger on screen after an option pick).
  let footer: ComboFooter | null = null;
  const syncFooter = (): void => { if (footer) footer.sync(); };

  const combo = createCombobox({
    input, listEl, liveEl, document: d,
    getOptions: (text) => buildOptions(text),
    // Picking a preset OR a recent is a deliberate, complete action —
    // simulate "typed the full expression, then committed it" rather than
    // the debounced/lenient typing path, so it takes effect immediately
    // (workbench: re-validates and re-enables Run right away; dashboard:
    // bypasses the 500ms debounce).
    onCommit: () => { updatePreview(true); onValueInput(); onCommit(); },
    onClose: syncFooter,
  });

  // The initial paint reflects an already-stored value (a tab switch, a
  // restored dashboard filter, …) — never "mid-typing" — so it's committed.
  updatePreview(true);

  // See combo-footer.js's header comment for why this is a separate element
  // rather than combobox.js growing a footer concept. Absent entirely (no
  // DOM node) when the caller hasn't wired recents at all.
  footer = getRecents
    ? attachComboFooter({
      listEl, combo,
      hasRecents: () => getRecents('').length > 0,
      // Review F4: after clearing, rebuild the OPEN list too — the footer
      // hides itself, but the already-rendered Recent options would otherwise
      // stay visible (and clickable) until the next keystroke.
      onClear: () => { if (onClearRecent) onClearRecent(); combo.refresh(); },
    })
    : null;

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
