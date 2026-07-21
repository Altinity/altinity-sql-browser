// #189: a dedicated multiselect Dashboard Filter control — a full ARIA
// `dialog` popover (search + tri-state "select visible" + a native-labeled
// checklist + Clear/Cancel/Apply) rather than forcing the single-select
// combobox primitive (combobox.ts) into multiselect semantics it was never
// built for. This module borrows conventions from TWO existing primitives
// rather than inventing new ones:
//  - `menu.ts`'s `openMenu` is the model for the popover lifecycle: mount a
//    fresh overlay + panel on open, tear both down completely on close
//    (never a hidden-but-resident node), Escape closes and refocuses the
//    trigger, and `fixedAnchor` places the panel under the trigger.
//  - `filter-bar.ts`'s `applyFieldStatus` is the model for the status
//    vocabulary (idle/loading/ready/waiting/source-error/helper-error/
//    missing-helper, `stale`/`waitingFor`) and its is-waiting/is-error/
//    is-stale class precedence.
// The error-mode plain-text fallback follows the same policy #360 already
// established for the single-select curated field: a helper-query failure
// must never discard (or overwrite, mid-failure) a committed value, and the
// stale options must never be presented as authoritative.
//
// State ownership: the COMMITTED `value`/`active`/`options` are frozen at
// construction — a caller that wants a later committed-value/options change
// reflected calls `buildMultiSelectField` again (the same convention
// `buildFilterBar` uses for its own curated fields: a value/options change
// rebuilds the field, only a STATUS-only change patches in place). Only
// `status` mutates in place via `updateStatus`, because a status flip must
// never disturb an in-progress edit — on this field (an open popover's
// draft, or an in-progress error-mode edit) or any sibling field in a shared
// bar.
//
// The OPEN popover owns its own draft `Set<string>` (a copy of `value` taken
// at open time) plus its own search/select-visible/option-row DOM and
// listeners, all local to `openPopover()` — none of it survives past the
// matching `close()`, so there is nothing to leak across repeated opens.

import { h, fixedAnchor, attachBackdropClose } from './dom.js';
import { idSafe } from './combobox.js';
import { canonicalizeSelection, sameSelection } from '../core/filter-selection.js';

/** One selectable option — value/label only (no grouping; #189 doesn't need it). */
export interface MultiSelectOption {
  value: string;
  label: string;
}

/** The same status vocabulary `filter-bar.ts`'s `CuratedFieldStatus` carries
 *  (#360): `status` ∈ idle|loading|ready|waiting|source-error|helper-error|
 *  missing-helper; `stale`/`waitingFor` are the same affordance fields. */
export interface MultiSelectFieldStatus {
  status?: string;
  stale?: boolean;
  waitingFor?: string[];
}

/** `buildMultiSelectField`'s options bag. */
export interface MultiSelectFieldOpts {
  /** Parameter name — used only for id-safe DOM ids (see `idSafe`), never
   *  shown to the user (that's `label`'s job). */
  name: string;
  /** Filter display label, used in every accessible name this control builds. */
  label: string;
  /** Inactive trigger text: 'Not set' when required, 'All' when optional. */
  required?: boolean;
  /** Committed selection — may contain values absent from `options` (a
   *  DORMANT value an options refresh dropped); never mutated by this module. */
  value: readonly string[];
  active: boolean;
  options: MultiSelectOption[];
  status?: MultiSelectFieldStatus;
  /** Injected document realm — defaults to the ambient global. */
  document?: Document;
  onApply(next: string[], active: boolean): void;
  /** Error-mode plain-input commit (Enter, or blur after an edit). */
  onFallbackCommit(raw: string, active: boolean): void;
}

/** `buildMultiSelectField`'s return value. */
export interface MultiSelectFieldHandle {
  el: HTMLElement;
  /** In-place status affordance update — never rebuilds the control, so an
   *  open popover's in-progress draft (or an in-progress error-mode edit) is
   *  never disturbed by a sibling status change. */
  updateStatus(s: MultiSelectFieldStatus): void;
  /** Whether the popover is currently open — an integration caller uses this
   *  to decide whether a status change needs to announce a refresh-cancel. */
  isOpen(): boolean;
  /** Removes this control's own listeners and closes the popover if open (a
   *  dispose-while-open is a Cancel: no `onApply`/`onFallbackCommit` call). */
  dispose(): void;
}

// The same isWaiting/isError/isStale precedence `filter-bar.ts`'s
// `applyFieldStatus` uses — 'idle' (never yet run) and 'loading' (mid-flight)
// both read as "pending", same as a superseded `stale: true` read.
function classifyStatus(s: MultiSelectFieldStatus): { isWaiting: boolean; isError: boolean; isStale: boolean } {
  const status = s.status ?? 'ready';
  const isWaiting = status === 'waiting';
  const isError = status === 'source-error' || status === 'helper-error' || status === 'missing-helper';
  const isStale = !isWaiting && !isError && (status === 'loading' || status === 'idle' || !!s.stale);
  return { isWaiting, isError, isStale };
}

export function buildMultiSelectField(opts: MultiSelectFieldOpts): MultiSelectFieldHandle {
  const d = opts.document || document;
  const { label, value, active, options } = opts;
  const required = !!opts.required;
  const suffix = idSafe(opts.name);

  let status: MultiSelectFieldStatus = opts.status || {};
  // Starts false regardless of the initial `status` so the FIRST
  // `applyStatus()` call below always treats an initial error status as an
  // "entering error" transition (seeding the fallback text from `value`) —
  // never as an already-erroring no-op.
  let wasError = false;
  // The currently-open popover's own close() — non-null iff the popover is
  // open (isOpen() reads this directly rather than tracking a second flag).
  let closeCurrent: (() => void) | null = null;

  const inactiveText = (): string => (required ? 'Not set' : 'All');

  const triggerText = (): string => {
    const { isWaiting, isStale } = classifyStatus(status);
    if (isWaiting) return `Waiting for: ${(status.waitingFor ?? []).join(', ')}`;
    if (isStale) return 'Loading options…';
    if (!active || value.length === 0) return inactiveText();
    if (value.length === 1) {
      const opt = options.find((o) => o.value === value[0]);
      return opt ? opt.label : value[0];
    }
    return `${value.length} selected`;
  };

  // The control's root — hosts whichever of trigger/errorInput is current,
  // swapped in place (never rebuilt) by applyStatus() below. This IS `el`
  // (returned as-is, same convention `buildFilterOptionField`'s `.var-combo`
  // wrapper uses: the grid-column:2 sizing anchor and the status-class
  // "wrapper" are the same node, not a second nesting level).
  const control = h('div', { class: 'ms-field' });
  const trigger = h('button', {
    type: 'button', id: 'ms-trigger-' + suffix, class: 'ms-trigger var-input',
    'aria-haspopup': 'dialog', 'aria-expanded': 'false',
  });
  const errorInput = h('input', {
    type: 'text', id: 'ms-error-' + suffix, class: 'var-input is-error', 'aria-label': label,
  });
  let errorEdited = false;

  const commitFallback = (): void => {
    opts.onFallbackCommit(errorInput.value, errorInput.value.trim() !== '');
    errorEdited = false;
  };
  const onErrorInput = (): void => { errorEdited = true; };
  const onErrorKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    commitFallback();
  };
  const onErrorBlur = (): void => { if (errorEdited) commitFallback(); };
  errorInput.addEventListener('input', onErrorInput);
  errorInput.addEventListener('keydown', onErrorKeyDown);
  errorInput.addEventListener('blur', onErrorBlur);

  // Applies the CURRENT `status` to the already-built DOM (constructor AND
  // `updateStatus` share this — never a rebuild, see the module header).
  const applyStatus = (): void => {
    const { isWaiting, isError, isStale } = classifyStatus(status);
    // A status change into error mid-open cancels the popover outright (its
    // anchor, the trigger, is about to be replaced by the fallback input) —
    // a Cancel: no onApply call.
    if (isError && closeCurrent) closeCurrent();

    control.classList.remove('is-waiting', 'is-error', 'is-stale');
    if (isWaiting) control.classList.add('is-waiting');
    else if (isError) control.classList.add('is-error');
    else if (isStale) control.classList.add('is-stale');

    if (isError) {
      // Only INITIALIZE the fallback text on the transition into error mode
      // — a later `updateStatus` call that's still an error status (e.g.
      // 'source-error' → 'helper-error') must never stomp an in-progress
      // edit (#360's "don't discard a committed value" policy applies just
      // as much to the user's own not-yet-committed typing).
      if (!wasError) errorInput.value = value.join(', ');
    } else {
      trigger.classList.remove('is-waiting', 'is-stale');
      if (isWaiting) trigger.classList.add('is-waiting');
      else if (isStale) trigger.classList.add('is-stale');
      trigger.disabled = isWaiting || isStale;
      const text = triggerText();
      trigger.textContent = text;
      trigger.title = text;
    }
    trigger.setAttribute('aria-label', `${label} filter, ${value.length} selected`);
    wasError = isError;

    const wanted = isError ? errorInput : trigger;
    if (control.firstChild !== wanted) control.replaceChildren(wanted);
  };

  const onTriggerClick = (): void => { if (!trigger.disabled) openPopover(); };
  trigger.addEventListener('click', onTriggerClick);

  // Mount a fresh popover (menu.ts's own lifecycle convention: build on
  // open, tear down completely on close — never a hidden-but-resident node).
  function openPopover(): void {
    if (closeCurrent) return; // already open — never stack a second popover
    const draft = new Set(value);
    let searchText = '';

    const liveEl = h('div', { class: 'sr-only ms-live', 'aria-live': 'polite' });
    const searchInput = h('input', {
      type: 'text', class: 'ms-search', placeholder: `Search ${label} options`,
      'aria-label': `Search ${label} options`,
    });
    const selectAllCb = h('input', { type: 'checkbox', class: 'ms-select-all-cb' });
    const selectAllRow = h('label', { class: 'ms-select-all' }, selectAllCb, h('span', {}, 'Select visible'));

    const rows = options.map((opt) => {
      const cb = h('input', { type: 'checkbox', checked: draft.has(opt.value) });
      cb.addEventListener('change', () => {
        if (cb.checked) draft.add(opt.value); else draft.delete(opt.value);
        syncSelectAll();
      });
      const li = h('label', { class: 'ms-option' }, cb, h('span', { class: 'ms-option-label' }, opt.label));
      return { opt, li, cb };
    });
    const listEl = h('div', { class: 'ms-options' }, ...rows.map((r) => r.li));

    // Tri-state "select visible": unchecked when no visible row is in the
    // draft, checked when every visible row is, indeterminate when some are
    // — the accessible label always names the ACTION a click performs next
    // (native indeterminate→click sets checked=true, so setting `.checked`
    // to `allSelected` here, not `selected > 0`, is what makes a later click
    // reliably select — never re-clear — a mixed selection).
    function syncSelectAll(): void {
      const visibleRows = rows.filter((r) => !r.li.hidden);
      const total = visibleRows.length;
      const selected = visibleRows.filter((r) => draft.has(r.opt.value)).length;
      const allSelected = total > 0 && selected === total;
      const noneSelected = selected === 0;
      selectAllCb.checked = allSelected;
      selectAllCb.indeterminate = !allSelected && !noneSelected;
      selectAllCb.setAttribute('aria-label',
        allSelected ? `Clear all ${total} visible options` : `Select all ${total} visible options`);
    }
    // Local case-insensitive substring filter over label+value — hidden
    // (filtered-out) rows are never touched by select-visible/Clear below.
    function applyFilter(): void {
      const q = searchText.trim().toLowerCase();
      let visible = 0;
      for (const row of rows) {
        const match = !q || row.opt.label.toLowerCase().includes(q) || row.opt.value.toLowerCase().includes(q);
        row.li.hidden = !match;
        if (match) visible++;
      }
      liveEl.textContent = `${visible} of ${rows.length} options`;
      syncSelectAll();
    }
    searchInput.addEventListener('input', () => { searchText = searchInput.value; applyFilter(); });
    selectAllCb.addEventListener('change', () => {
      const checked = selectAllCb.checked;
      for (const row of rows) {
        if (row.li.hidden) continue; // hidden values are never touched
        row.cb.checked = checked;
        if (checked) draft.add(row.opt.value); else draft.delete(row.opt.value);
      }
      syncSelectAll();
    });

    const clearBtn = h('button', { type: 'button', class: 'ms-btn ms-btn-clear' }, 'Clear');
    const cancelBtn = h('button', { type: 'button', class: 'ms-btn' }, 'Cancel');
    const applyBtn = h('button', { type: 'button', class: 'ms-btn ms-btn-primary' }, 'Apply');
    // Clear empties the WHOLE draft, not just the visible subset.
    clearBtn.addEventListener('click', () => {
      draft.clear();
      for (const row of rows) row.cb.checked = false;
      syncSelectAll();
    });
    cancelBtn.addEventListener('click', () => close());
    applyBtn.addEventListener('click', () => {
      const canonical = canonicalizeSelection([...draft], options);
      const prevCanonical = canonicalizeSelection(value, options);
      const activeNext = canonical.length > 0;
      // A no-op Apply (same canonical selection AND same active flag) closes
      // silently — `onApply` fires exactly once otherwise.
      if (!(sameSelection(canonical, prevCanonical) && activeNext === active)) {
        opts.onApply(canonical, activeNext);
      }
      close();
    });
    const footer = h('div', { class: 'ms-footer' }, clearBtn, cancelBtn, applyBtn);

    const dialog = h('div', {
      class: 'ms-popover', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${label} options`,
    }, searchInput, liveEl, selectAllRow, listEl, footer);
    const overlay = h('div', { class: 'ms-overlay' });

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };

    // EVERY dismissal path (Apply, Cancel, Escape, outside-click, dispose)
    // funnels through here — the one place that tears the popover down and
    // returns focus to the trigger. Idempotent by construction (every step
    // is a harmless no-op on an already-detached/already-null target), so no
    // separate re-entrancy guard is needed even if a caller somehow reached
    // it twice for the same open session.
    function close(): void {
      d.removeEventListener('keydown', onKeyDown, true);
      detachBackdrop();
      overlay.remove();
      dialog.remove();
      trigger.setAttribute('aria-expanded', 'false');
      closeCurrent = null;
      trigger.focus();
    }
    closeCurrent = close;

    trigger.setAttribute('aria-expanded', 'true');
    d.body.appendChild(overlay);
    d.body.appendChild(dialog);
    const detachBackdrop = attachBackdropClose(overlay, close);
    d.addEventListener('keydown', onKeyDown, true);

    const rect = trigger.getBoundingClientRect();
    const pos = fixedAnchor(rect) as { top: number; left: number };
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    dialog.style.position = 'fixed';
    dialog.style.top = pos.top + 'px';
    dialog.style.left = pos.left + 'px';
    dialog.style.minWidth = rect.width + 'px';

    applyFilter(); // seeds the live-region count and the select-visible tri-state
    searchInput.focus(); // focus moves into the dialog on open
  }

  applyStatus();

  return {
    el: control,
    isOpen: () => closeCurrent !== null,
    updateStatus: (s) => { status = s; applyStatus(); },
    dispose: () => {
      closeCurrent?.(); // dispose-while-open is a Cancel: no writes
      trigger.removeEventListener('click', onTriggerClick);
      errorInput.removeEventListener('input', onErrorInput);
      errorInput.removeEventListener('keydown', onErrorKeyDown);
      errorInput.removeEventListener('blur', onErrorBlur);
    },
  };
}
