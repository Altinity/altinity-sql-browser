// #335: the compound Dashboard time-range control — a closed trigger showing
// the wave-resolved absolute range, and a two-column popover with token-based
// From/To editors (relative expressions or absolute datetimes), a live
// resolved preview per bound, a contextual per-field constants column, a
// group-scoped "Recently used" list, and an explicit Apply that commits both
// bounds atomically. It is the SECOND consumer of the #364 dialog-popover
// pattern, so it borrows the same primitives multi-select-field.ts does rather
// than reinventing them:
//   - `popover.ts`'s `openAnchoredDialog` (#335) owns ALL the generic dialog
//     chrome (overlay/backdrop, the ARIA dialog/aria-modal/aria-expanded
//     lifecycle, Escape, the Tab focus trap, placement + viewport clamp, and
//     focus return). This module keeps only the time-range-specific content,
//     the staged From/To draft, and the Apply/close ordering on top of it.
//   - `core/time-range.ts`'s `validateTimeRangeDraft` owns ALL parsing/
//     resolution — the control NEVER reimplements the relative/absolute
//     grammar. Every trigger label and every preview line comes from one
//     `validateTimeRangeDraft` call against one shared `nowMs` (the issue's
//     "single preview now" rule: both bounds resolve `now` against the same
//     instant within a validation pass).
//   - `relative-time-field.ts`'s `TIME_RANGE_CONSTANTS` + `filterTokenList`
//     own the per-field constants data and its type-to-filter behavior.
//
// State ownership mirrors multi-select-field.ts: the COMMITTED
// `fromValue`/`toValue`/`active` are frozen at construction — a caller wanting
// a later committed-value change reflected calls `buildTimeRangeField` again
// (the same convention `buildFilterBar` uses). `refreshLabel(nowMs)`
// re-resolves ONLY the closed trigger's label/aria in place (per execution
// wave, no timers, no rebuild). The OPEN popover owns its own staged draft (the
// two inputs' text) plus its right-column state, all local to `openPopover()`,
// none of which survives the matching `close()`.
//
// COMMIT ORDERING (the #364/#189 merge-gate rule, now `openAnchoredDialog`'s
// documented contract): `close()` runs BEFORE any commit callback (`onApply`,
// whether from the Apply button or a recents pick), so a synchronous rebuild
// reacting to that commit always observes this popover as already closed.
//
// FOCUS/RESTING-STATE ADAPTATION vs multi-select-field.ts: the multiselect
// popover focuses its search input on open. This one focuses the From input
// on open (a11y: focus enters the modal) but its RIGHT COLUMN opens on
// "Recently used" — the pinned design's resting state — because the right
// column is contextual on a field being *active*, and the single programmatic
// open-focus is deliberately NOT treated as a user activation (`openingFocus`
// guard). A genuine later focus, typing, or a caret toggle activates a field
// and swaps the right column to that field's constants.

import { h } from './dom.js';
import { idSafe } from './combobox.js';
import { openAnchoredDialog } from './popover.js';
import { validateTimeRangeDraft } from '../core/time-range.js';
import type { DashboardTimeRangeGroup, TimeRangeRecent, TimeRangeBoundDraft } from '../core/time-range.js';
import { TIME_RANGE_CONSTANTS, filterTokenList } from './relative-time-field.js';

/** `buildTimeRangeField`'s options bag. */
export interface TimeRangeFieldOpts {
  /** Injected document realm — defaults to the ambient global. */
  document?: Document;
  /** The resolved group whose From/To parameter types drive validation. */
  group: DashboardTimeRangeGroup;
  /** Committed raw text of each bound ('' when unset). */
  fromValue: string;
  toValue: string;
  /** True only when BOTH bounds are committed + active. */
  active: boolean;
  /** The last execution wave's shared `now` snapshot; null before the first
   *  wave (the constructor then falls back to `wallNow()` for the label). */
  waveNowMs: number | null;
  /** Live wall clock for the popover's preview `now` (captured once at open,
   *  then once per input event — never mid-pass). */
  wallNow: () => number;
  /** Group-scoped recents, shell-owned; read live each time the right column
   *  renders (a pick or a commit elsewhere can change it between opens). */
  getRecents: () => readonly TimeRangeRecent[];
  /** Both the Apply button and a recents pick route here, with TRIMMED text. */
  onApply: (from: string, to: string) => void;
}

/** `buildTimeRangeField`'s return value. */
export interface TimeRangeFieldHandle {
  /** The control's root, a `.var-field.is-time-range` wrapper hosting the
   *  trigger — dropped straight into the bar's "Time" section by the caller. */
  el: HTMLElement;
  /** Present for handle uniformity with the other filter controls. A plain
   *  (non-source-backed) time-range control has no transport status to show,
   *  so this is a documented no-op. */
  updateStatus(s: unknown): void;
  /** Whether the popover is currently open. */
  isOpen(): boolean;
  /** Focus this control's trigger (used by the bar's rebuild focus-restore). */
  focusTrigger(): void;
  /** Close the popover if open (a Cancel: no `onApply`) and detach listeners. */
  dispose(): void;
  /** Re-resolve ONLY the closed trigger's label + accessible name against a
   *  new `nowMs` — no popover state, no rebuild. */
  refreshLabel(nowMs: number): void;
}

export function buildTimeRangeField(opts: TimeRangeFieldOpts): TimeRangeFieldHandle {
  const d = opts.document || document;
  const { group, fromValue, toValue, active } = opts;
  const { fromType, toType } = group;
  const suffix = idSafe(group.key);

  // The currently-open popover's own close() — non-null iff open (isOpen()
  // reads this directly). `skipFocus` rides through to the primitive for
  // parity with multi-select-field.ts (no forced-error close exists here, so
  // it is always the default trigger-refocus in practice).
  let closeCurrent: ((closeOpts?: { skipFocus?: boolean }) => void) | null = null;

  const trigger = h('button', {
    type: 'button', id: 'trf-trigger-' + suffix, class: 'trf-trigger var-input',
    'aria-haspopup': 'dialog', 'aria-expanded': 'false',
  });

  // Re-resolve the closed trigger's label + aria against `nowMs`. Pure read of
  // the frozen committed values; never touches the popover.
  function computeTriggerLabel(nowMs: number): void {
    if (!active) {
      trigger.textContent = 'Not set';
      trigger.classList.remove('is-error');
      trigger.setAttribute('aria-label', 'Time range, not set');
      trigger.title = 'Time range, not set';
      return;
    }
    const res = validateTimeRangeDraft({ fromText: fromValue, toText: toValue, fromType, toType, nowMs });
    const fromDisp = res.from.ok ? res.from.display! : fromValue;
    const toDisp = res.to.ok ? res.to.display! : toValue;
    const text = `${fromDisp} → ${toDisp}`;
    const hasError = !res.from.ok || !res.to.ok;
    trigger.textContent = text;
    trigger.title = text;
    trigger.classList.toggle('is-error', hasError);
    trigger.setAttribute('aria-label', hasError
      ? `Time range from ${fromValue} to ${toValue}, not resolvable`
      : `Time range from ${fromValue} to ${toValue}, resolved ${res.from.display} to ${res.to.display}`);
  }

  const onTriggerClick = (): void => openPopover();
  trigger.addEventListener('click', onTriggerClick);

  // Mount a fresh popover. The generic dialog chrome lives in
  // `openAnchoredDialog`; this builds the staged From/To editors, the
  // contextual right column, and the Apply/close ordering on top of it.
  function openPopover(): void {
    if (closeCurrent) return; // already open — never stack a second popover

    // The single shared preview `now`: captured once at open, refreshed once
    // per input event, and fed to ONE `validateTimeRangeDraft` call so `now`
    // in From and `now` in To always agree within a pass.
    let previewNow = opts.wallNow();
    // Which field's constants the right column shows, or null → recents.
    let activeField: 'from' | 'to' | null = null;
    // The constants type-to-filter text for the active field (typing sets it;
    // a constant fill or an activation change resets it).
    let constFilter = '';
    // The single programmatic open-focus below must NOT count as a user
    // activation (so the right column opens on recents); a genuine later focus
    // does. Flipped false right after the dialog mounts.
    let openingFocus = true;

    const mkInput = (role: 'from' | 'to', seed: string): HTMLInputElement => h('input', {
      type: 'text', class: 'trf-input var-input', value: seed,
      id: `trf-${role}-${suffix}`, 'aria-label': role === 'from' ? 'From' : 'To',
      'aria-describedby': `trf-${role}-preview-${suffix}`,
    });
    const fromInput = mkInput('from', fromValue);
    const toInput = mkInput('to', toValue);
    const fromPreview = h('div', { class: 'trf-preview', id: `trf-from-preview-${suffix}` });
    const toPreview = h('div', { class: 'trf-preview', id: `trf-to-preview-${suffix}` });
    const fromCaret = h('button', {
      type: 'button', class: 'trf-caret', 'aria-pressed': 'false', 'aria-label': 'Show constants for From',
    }, '▾');
    const toCaret = h('button', {
      type: 'button', class: 'trf-caret', 'aria-pressed': 'false', 'aria-label': 'Show constants for To',
    }, '▾');

    const mkRow = (label: string, input: HTMLInputElement, caret: HTMLElement, preview: HTMLElement): HTMLElement =>
      h('div', { class: 'trf-row' },
        h('label', { class: 'trf-field-label', for: input.id }, label),
        h('div', { class: 'trf-input-wrap' }, input, caret),
        preview);
    const left = h('div', { class: 'trf-left' },
      mkRow('From', fromInput, fromCaret, fromPreview),
      mkRow('To', toInput, toCaret, toPreview));

    const rightHeader = h('div', { class: 'trf-right-header' });
    const rightBody = h('div', { class: 'trf-right-body' });
    const right = h('div', { class: 'trf-right' }, rightHeader, rightBody);
    const cols = h('div', { class: 'trf-cols' }, left, right);

    const rangeErrEl = h('div', { class: 'trf-range-error', hidden: true });
    const cancelBtn = h('button', { type: 'button', class: 'trf-btn' }, 'Cancel');
    const applyBtn = h('button', { type: 'button', class: 'trf-btn trf-btn-primary' }, 'Apply');
    const footer = h('div', { class: 'trf-footer' }, cancelBtn, applyBtn);

    const paintPreview = (el: HTMLElement, bd: TimeRangeBoundDraft): void => {
      if (bd.ok) {
        el.textContent = '= ' + bd.display;
        el.classList.remove('is-error');
      } else {
        el.textContent = bd.error;
        el.classList.add('is-error');
      }
    };

    // ONE validation pass drives both preview lines, the range error, and the
    // Apply gate — never two separate `now` readings.
    function revalidate(): void {
      const res = validateTimeRangeDraft({
        fromText: fromInput.value, toText: toInput.value, fromType, toType, nowMs: previewNow,
      });
      paintPreview(fromPreview, res.from);
      paintPreview(toPreview, res.to);
      if (res.rangeError) {
        rangeErrEl.textContent = res.rangeError;
        rangeErrEl.hidden = false;
      } else {
        rangeErrEl.textContent = '';
        rangeErrEl.hidden = true;
      }
      applyBtn.disabled = !res.applyEnabled;
    }

    // Render the contextual right column: recents (no field active) or the
    // active field's filtered constants.
    function renderRight(): void {
      fromCaret.setAttribute('aria-pressed', String(activeField === 'from'));
      toCaret.setAttribute('aria-pressed', String(activeField === 'to'));
      if (activeField === null) {
        rightHeader.textContent = 'Recently used';
        const recents = opts.getRecents();
        if (recents.length === 0) {
          rightBody.replaceChildren(h('div', { class: 'trf-empty' }, 'No recent ranges yet'));
          return;
        }
        rightBody.replaceChildren(...recents.map((r) => {
          const b = h('button', { type: 'button', class: 'trf-recent' }, `${r.from} → ${r.to}`);
          // A recents pick is an immediate apply: close FIRST (commit ordering),
          // then route through the same onApply the Apply button uses.
          b.addEventListener('click', () => { handle.close(); opts.onApply(r.from, r.to); });
          return b;
        }));
        return;
      }
      const input = activeField === 'from' ? fromInput : toInput;
      rightHeader.textContent = activeField === 'from' ? 'From · constants' : 'To · constants';
      const matches = filterTokenList(TIME_RANGE_CONSTANTS, constFilter);
      if (matches.length === 0) {
        rightBody.replaceChildren(
          h('div', { class: 'trf-empty' }, 'No match — absolute datetimes like 2026-07-21 09:00 are accepted'));
        return;
      }
      rightBody.replaceChildren(...matches.map((c) => {
        const b = h('button', { type: 'button', class: 'trf-const' },
          h('span', { class: 'trf-const-token' }, c.value),
          h('span', { class: 'trf-const-label' }, c.label));
        // A constant fill is STAGED: fills the field's input, resets the filter,
        // re-validates, keeps the popover open. No apply.
        b.addEventListener('click', () => {
          input.value = c.value;
          constFilter = '';
          revalidate();
          renderRight();
        });
        return b;
      }));
    }

    const onFieldInput = (field: 'from' | 'to'): void => {
      previewNow = opts.wallNow();
      activeField = field;
      constFilter = (field === 'from' ? fromInput : toInput).value;
      revalidate();
      renderRight();
    };
    const onFieldFocus = (field: 'from' | 'to'): void => {
      if (openingFocus) return; // the single programmatic open-focus is not a user activation
      activeField = field;
      constFilter = '';
      renderRight();
    };
    const onCaret = (field: 'from' | 'to'): void => {
      activeField = activeField === field ? null : field;
      constFilter = '';
      renderRight();
    };
    fromInput.addEventListener('input', () => onFieldInput('from'));
    toInput.addEventListener('input', () => onFieldInput('to'));
    fromInput.addEventListener('focus', () => onFieldFocus('from'));
    toInput.addEventListener('focus', () => onFieldFocus('to'));
    fromCaret.addEventListener('click', () => onCaret('from'));
    toCaret.addEventListener('click', () => onCaret('to'));

    cancelBtn.addEventListener('click', () => handle.close());
    // Apply is only reachable enabled (a real browser never fires click on a
    // disabled button; the disabled attr is the gate — see the multiselect
    // precedent, whose Apply handler is likewise unguarded).
    applyBtn.addEventListener('click', () => {
      const fromT = fromInput.value.trim();
      const toT = toInput.value.trim();
      // An identical (trimmed) draft is a no-op: close, commit NOTHING.
      const identical = fromT === fromValue.trim() && toT === toValue.trim();
      handle.close();
      if (!identical) opts.onApply(fromT, toT);
    });

    // display:contents wrapper — `openAnchoredDialog` appends ONE content
    // element, but `.trf-popover` is the flex column whose direct children
    // (cols/range-error/footer) carry the layout.
    const content = h('div', { style: { display: 'contents' } }, cols, rangeErrEl, footer);

    const handle = openAnchoredDialog({
      document: d,
      trigger,
      ariaLabel: 'Time range',
      content,
      dialogClassName: 'trf-popover',
      clampToViewport: true,
      minWidthFromTrigger: false,
      initialFocus: () => fromInput,
      onClose: () => { closeCurrent = null; },
    });
    closeCurrent = (closeOpts) => handle.close(closeOpts);
    openingFocus = false;

    revalidate();  // seed both preview lines + the Apply gate from the committed seed
    renderRight(); // resting state: recents
  }

  computeTriggerLabel(opts.waveNowMs ?? opts.wallNow());

  return {
    el: h('div', { class: 'var-field is-time-range' }, trigger),
    updateStatus: () => { /* no-op: a plain time-range control has no source status */ },
    isOpen: () => closeCurrent !== null,
    focusTrigger: () => { trigger.focus(); },
    refreshLabel: (nowMs) => computeTriggerLabel(nowMs),
    dispose: () => {
      closeCurrent?.(); // dispose-while-open is a Cancel: no writes
      trigger.removeEventListener('click', onTriggerClick);
    },
  };
}
