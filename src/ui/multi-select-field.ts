// #189: a dedicated multiselect Dashboard Filter control — a full ARIA
// `dialog` popover (search + tri-state "select visible" + a native-labeled
// checklist + Clear/Cancel/Apply) rather than forcing the single-select
// combobox primitive (combobox.ts) into multiselect semantics it was never
// built for. This module borrows conventions from TWO existing primitives
// rather than inventing new ones:
//  - `popover.ts`'s `openAnchoredDialog` (#335) owns the generic dialog
//    chrome — mount a fresh overlay + panel on open, tear both down completely
//    on close (never a hidden-but-resident node), Escape/backdrop close and
//    refocus the trigger, the ARIA `dialog`/`aria-modal`/`aria-expanded`
//    lifecycle, the Tab focus trap, and `fixedAnchor` placement under the
//    trigger. This module keeps only the multiselect-specific content, draft,
//    busy affordance, and Apply/close ordering.
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

import { h } from './dom.js';
import { openAnchoredDialog } from './popover.js';
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
   *  DORMANT value an options refresh dropped); never mutated by this module.
   *  A plain `string` is #189's error-mode RAW FALLBACK COMMIT awaiting
   *  reconciliation (`onFallbackCommit`'s own value, round-tripped back in by
   *  a caller that has nowhere else to put it — the scalar draft bag this
   *  filter's committed value otherwise lives in cannot hold an array either
   *  way) — every array-shaped operation below (`Array.isArray(value) ?
   *  value : []`) treats it as "no selection", while the trigger/error-input
   *  text paths show it verbatim so the just-typed text never appears to
   *  vanish. The next successful options merge that resolves this filter's
   *  contract republishes a real array (or the same raw string, unchanged,
   *  if the merge still can't resolve it) — this module never reconciles it
   *  itself. */
  value: readonly string[] | string;
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
  /** Focuses this control's own current interactive element (the trigger, or
   *  the error-mode fallback input when erroring) — #189 F2b: a caller
   *  (`filter-bar.ts`'s `focusMultiSelectTrigger`) that just rebuilt the bar
   *  a still-open popover was force-closed out from under uses this to move
   *  focus onto the corresponding field of the FRESH bar (never left at
   *  `<body>`). A no-op-safe call before `applyStatus()` has ever run is not
   *  a case this module produces (the constructor calls it before returning). */
  focusTrigger(): void;
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
  // #189 F2a: takes an options bag so `applyStatus`'s forced error-close can
  // ask it to SKIP focusing the doomed trigger (about to be replaced by the
  // fallback input) — every other dismissal path (Cancel/Escape/outside-
  // click/dispose) still gets the default trigger-refocus.
  let closeCurrent: ((closeOpts?: { skipFocus?: boolean }) => void) | null = null;
  // #189 F6: the OPEN popover's own noninteractive-while-loading surface —
  // non-null iff the popover is open (set/cleared in lockstep with
  // `closeCurrent`), read by `applyStatus` below so a STATUS-ONLY publish
  // (no rebuild — the draft can't change without one) can disable/re-enable
  // the checklist body in place without disturbing the open draft.
  let openPopoverBusy: ((busy: boolean) => void) | null = null;

  const inactiveText = (): string => (required ? 'Not set' : 'All');

  const triggerText = (): string => {
    const { isWaiting, isStale } = classifyStatus(status);
    if (isWaiting) return `Waiting for: ${(status.waitingFor ?? []).join(', ')}`;
    if (isStale) return 'Loading options…';
    if (!active || value.length === 0) return inactiveText();
    // #189 F1: a raw string is the error-mode fallback commit — shown
    // verbatim (never joined/counted) rather than collapsed to "1 selected"
    // or an option-label lookup that would never match it.
    if (typeof value === 'string') return value;
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
  // #189 F5: `errorEdited` tracks an IN-PROGRESS, uncommitted edit of THIS
  // error-mode session only — reset to false (never carried over) every time
  // the control (re)enters error mode (see `applyStatus`'s `!wasError`
  // branch), and the listeners below are only ATTACHED while erroring
  // (`attachErrorListeners`/`detachErrorListeners`, also driven by
  // `applyStatus`) rather than for the control's whole lifetime. Detaching on
  // the way OUT of error mode — before `applyStatus` swaps `errorInput` back
  // out of the DOM — means the browser-native `blur` a real browser fires
  // when a FOCUSED element is removed from the document can never reach
  // `onErrorBlur` and force a commit of an edit the user never actually
  // committed (happy-dom does not reproduce that native blur-on-removal
  // behavior, so this specific ordering is only actually exercised by a real
  // browser — the unit suite instead verifies the listener is gone).
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
  const attachErrorListeners = (): void => {
    errorInput.addEventListener('input', onErrorInput);
    errorInput.addEventListener('keydown', onErrorKeyDown);
    errorInput.addEventListener('blur', onErrorBlur);
  };
  const detachErrorListeners = (): void => {
    errorInput.removeEventListener('input', onErrorInput);
    errorInput.removeEventListener('keydown', onErrorKeyDown);
    errorInput.removeEventListener('blur', onErrorBlur);
  };

  // Applies the CURRENT `status` to the already-built DOM (constructor AND
  // `updateStatus` share this — never a rebuild, see the module header).
  const applyStatus = (): void => {
    const { isWaiting, isError, isStale } = classifyStatus(status);
    // A status change into error mid-open cancels the popover outright (its
    // anchor, the trigger, is about to be replaced by the fallback input) —
    // a Cancel: no onApply call. #189 F2a: `skipFocus` — the trigger is
    // about to be DETACHED by the `replaceChildren` swap below, so focusing
    // it here would just be immediately lost to `<body>`; focus moves to the
    // freshly-swapped-in `errorInput` after the swap instead (below).
    const forcedClosePopover = isError && !!closeCurrent;
    if (forcedClosePopover) closeCurrent!({ skipFocus: true });

    // #189 F6: a STATUS-ONLY publish while the popover is open (no rebuild —
    // the open draft's own options can't change without one) still needs to
    // communicate a waiting/loading/idle/stale transition: make the
    // checklist body noninteractive (Cancel + Escape stay usable) rather
    // than silently doing nothing while stale data sits underneath an
    // unchanged, seemingly-live control. Never reached for the forced-close
    // error case above (`openPopoverBusy` is already null by the time this
    // runs, closed via `closeCurrent` a few lines up).
    openPopoverBusy?.(isWaiting || isStale);

    control.classList.remove('is-waiting', 'is-error', 'is-stale');
    if (isWaiting) control.classList.add('is-waiting');
    else if (isError) control.classList.add('is-error');
    else if (isStale) control.classList.add('is-stale');

    if (isError) {
      // Only INITIALIZE the fallback text on the transition into error mode
      // — a later `updateStatus` call that's still an error status (e.g.
      // 'source-error' → 'helper-error') must never stomp an in-progress
      // edit (#360's "don't discard a committed value" policy applies just
      // as much to the user's own not-yet-committed typing). #189 F1: seeds
      // from the raw string verbatim when `value` is already one (a prior
      // fallback commit awaiting reconciliation); otherwise the array joined
      // for display, unchanged. #189 F5: a FRESH entry into error mode is
      // always a fresh seed — never edited yet — and only NOW does the
      // fallback input's own listeners attach (see the module header on
      // `errorEdited` above for why this must not just linger for the
      // control's whole lifetime).
      if (!wasError) {
        errorEdited = false;
        errorInput.value = typeof value === 'string' ? value : value.join(', ');
        attachErrorListeners();
      }
    } else {
      // #189 F5: leaving error mode (recovery) — detach BEFORE the
      // `replaceChildren` swap below removes `errorInput` from the DOM, so a
      // real browser's native blur-on-removal can never reach `onErrorBlur`
      // and force-commit whatever was left uncommitted.
      if (wasError) detachErrorListeners();
      trigger.classList.remove('is-waiting', 'is-stale');
      if (isWaiting) trigger.classList.add('is-waiting');
      else if (isStale) trigger.classList.add('is-stale');
      trigger.disabled = isWaiting || isStale;
      const text = triggerText();
      trigger.textContent = text;
      trigger.title = text;
    }
    // #189 F1: a raw-string committed value has no real "selected count" —
    // reported as 1 when non-empty (matches its own single-item trigger
    // text), 0 when blank/inactive; the trigger itself is hidden while
    // erroring, so this is cosmetic even then.
    const selectedCount = Array.isArray(value) ? value.length : (value !== '' ? 1 : 0);
    trigger.setAttribute('aria-label', `${label} filter, ${selectedCount} selected`);
    wasError = isError;

    const wanted = isError ? errorInput : trigger;
    if (control.firstChild !== wanted) control.replaceChildren(wanted);
    // #189 F2a: focus lands on the control now standing in for the popover
    // this call just force-closed — never left to fall through to `<body>`.
    if (forcedClosePopover) errorInput.focus();
  };

  const onTriggerClick = (): void => { if (!trigger.disabled) openPopover(); };
  trigger.addEventListener('click', onTriggerClick);

  // Mount a fresh popover. The generic dialog chrome (overlay/backdrop,
  // ARIA dialog + aria-expanded lifecycle, Escape, Tab trap, placement, focus
  // return) lives in `openAnchoredDialog` (#335); this function builds only
  // the multiselect content + draft and wires the busy affordance and the
  // Apply/close ordering on top of it.
  function openPopover(): void {
    if (closeCurrent) return; // already open — never stack a second popover
    // #189 F1: a raw-string committed value (the error-mode fallback commit,
    // never actually reachable here since the trigger — the only way to
    // reach `openPopover` — is swapped out for `errorInput` while erroring)
    // seeds an EMPTY draft rather than throwing on `new Set('a string')`.
    const draft = new Set(Array.isArray(value) ? value : []);
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
    cancelBtn.addEventListener('click', () => handle.close());
    applyBtn.addEventListener('click', () => {
      const canonical = canonicalizeSelection([...draft], options);
      // #189 F1: a raw-string committed value (the error-mode fallback commit)
      // has no prior ARRAY selection to compare against — treated as empty,
      // same as `draft`'s own seed above, so Apply from that state is never
      // spuriously treated as a no-op against text that was never a selection.
      const prevCanonical = canonicalizeSelection(Array.isArray(value) ? value : [], options);
      const activeNext = canonical.length > 0;
      // A no-op Apply (same canonical selection AND same active flag) closes
      // silently — `onApply` fires exactly once otherwise.
      const changed = !(sameSelection(canonical, prevCanonical) && activeNext === active);
      // Close BEFORE calling `onApply` (maintainer merge-gate finding, #189;
      // now the shared `openAnchoredDialog` contract, #335): `onApply`
      // typically routes straight into `session.applyFilter`, which mutates
      // state and `publish()`es SYNCHRONOUSLY before its first `await` — a
      // caller subscribed to that publish (`dashboard.ts`'s `rebuildFilterBar`)
      // can run inside this very call stack, before `applyBtn`'s own click
      // handler ever returns. Closing first means that synchronous rebuild
      // always observes this popover as already-closed (`isOpen()` false,
      // `closeCurrent` cleared) — never mistakes an ordinary Apply's own commit
      // for an outgoing bar's popover getting force-cancelled out from under
      // the user, which is what used to trigger a false "Filter options were
      // refreshed" announcement. `handle.close()` (default, non-`skipFocus`)
      // refocuses the trigger; the rebuild that `onApply` may synchronously
      // trigger replaces the whole bar out from under that focus — restoring it
      // onto the FRESH trigger is `rebuildFilterBar`'s own job (`dashboard.ts`),
      // not this module's.
      handle.close();
      if (changed) opts.onApply(canonical, activeNext);
    });
    const footer = h('div', { class: 'ms-footer' }, clearBtn, cancelBtn, applyBtn);

    // A `display:contents` wrapper: `openAnchoredDialog` appends ONE content
    // element into the dialog, but `.ms-popover` is a flex column whose direct
    // children (search/live/select-all/options/footer) carry the layout — the
    // contents wrapper generates no box, so those children participate in the
    // dialog's flex context exactly as they did when they were direct children.
    const content = h('div', { style: { display: 'contents' } },
      searchInput, liveEl, selectAllRow, listEl, footer);

    // #189 F6: while OPEN, a status-only publish that goes
    // waiting/loading/idle/stale makes the checklist body noninteractive
    // (Cancel + Escape stay usable — dismissing is always safe) and
    // announces it through the SAME live region `applyFilter` otherwise
    // reports the visible/total count through; `ready` restores both the
    // controls and the normal count text. The draft itself is never
    // touched — its values can't change without a rebuild, which only
    // happens closed. This affordance stays in the multiselect (it operates
    // on this module's own content) rather than in the shared primitive.
    let busy = false;
    function setBusy(next: boolean): void {
      if (busy === next) return;
      busy = next;
      handle.dialog.setAttribute('aria-busy', String(busy));
      searchInput.disabled = busy;
      selectAllCb.disabled = busy;
      for (const row of rows) row.cb.disabled = busy;
      clearBtn.disabled = busy;
      applyBtn.disabled = busy;
      if (busy) liveEl.textContent = 'Loading options…';
      else applyFilter(); // restores the normal "N of M options" live text
    }

    // The generic dialog chrome (#335): overlay + backdrop-close, the ARIA
    // dialog/aria-modal/aria-expanded lifecycle, document-capture Escape, the
    // Tab focus trap (recomputed per press, dialog-scoped), placement under the
    // trigger, and teardown + focus return. `minWidthFromTrigger: true` floors
    // the popover width at the trigger's width; `clampToViewport` is left off
    // to preserve the pre-#335 left-align-under-trigger behavior. `onClose`
    // clears this module's open-state refs on every dismissal path — the same
    // bookkeeping the old inline `close()` did (`isOpen()` reads `closeCurrent`).
    const handle = openAnchoredDialog({
      document: d,
      trigger,
      ariaLabel: `${label} options`,
      content,
      dialogClassName: 'ms-popover',
      overlayClassName: 'ms-overlay',
      minWidthFromTrigger: true,
      initialFocus: () => searchInput, // focus moves into the dialog on open
      onClose: () => { closeCurrent = null; openPopoverBusy = null; },
    });
    // #189 F2a: `skipFocus` flows through to the primitive so `applyStatus`'s
    // forced error-close can skip refocusing a trigger that's about to be
    // detached (focus moves to the fallback input over there instead).
    closeCurrent = (closeOpts) => handle.close(closeOpts);
    openPopoverBusy = setBusy;

    applyFilter(); // seeds the live-region count and the select-visible tri-state
  }

  applyStatus();

  return {
    el: control,
    isOpen: () => closeCurrent !== null,
    updateStatus: (s) => { status = s; applyStatus(); },
    // #189 F2b: focuses whichever of trigger/errorInput is the control's
    // CURRENT interactive element (mirrors `applyStatus`'s own `wanted`
    // choice) — used by a caller that just rebuilt the bar this field's
    // popover had open on the OLD instance, to land focus on the
    // corresponding field of the fresh one instead of `<body>`.
    focusTrigger: () => { (wasError ? errorInput : trigger).focus(); },
    dispose: () => {
      closeCurrent?.(); // dispose-while-open is a Cancel: no writes
      trigger.removeEventListener('click', onTriggerClick);
      detachErrorListeners(); // idempotent — a no-op if never attached / already detached
    },
  };
}
