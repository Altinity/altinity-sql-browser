// The searchable multiselect control for an option-backed Dashboard variable
// whose declared type is `Array(scalar T)` — a full ARIA `dialog` popover
// (search + tri-state "select visible" + a native-labeled checklist +
// Clear/Cancel/Apply) rather than forcing the single-select combobox primitive
// (combobox.ts) into multiselect semantics it was never built for.
//
// Restored from #189/PR #364, which #447 phase 1 deleted with the curated filter
// model. What came back is the CONTROL; what did not is everything that belonged
// to curated filters — a `label` separate from the name (a variable has only its
// exact name), `required` (every inferred variable is optional-by-blank, so the
// inactive trigger always reads `Not set`), the Filter-source status machine
// (`idle`/`loading`/`waiting`/`waitingFor`/`stale` — option SQL cannot reference
// a variable, so nothing ever waits on an upstream control), and the error-mode
// plain-text fallback with its `onFallbackCommit`. The one failure this model has
// is the BATCH-level one, which arrives through `setUnavailable` exactly as it
// does on the single-select sibling.
//
// Two existing primitives are borrowed rather than reinvented:
//  - `popover.ts`'s `openAnchoredDialog` (#335 — itself extracted FROM this
//    control's own `openPopover`) owns the generic dialog chrome: a fresh
//    overlay + panel mounted on open and torn down completely on close, the
//    ARIA `dialog`/`aria-modal`/`aria-expanded` lifecycle, Escape and backdrop
//    close, the Tab focus trap, `fixedAnchor` placement, and focus return;
//  - `variable-option-field.ts`'s `setUnavailable` is the model for the
//    batch-failure affordance (`aria-disabled` + `aria-invalid` + the reason in
//    `title`, never `disabled`).
//
// State ownership: the committed `selected`/`active` are frozen at construction
// — a caller wanting a later committed-value change reflected rebuilds the
// field, the same convention `buildVariableBar` uses everywhere else. `options`
// and the unavailable reason mutate in place (`setOptions`/`setUnavailable`),
// because the option batch lands asynchronously and a rebuild would discard an
// unrelated sibling's in-progress typing.
//
// The OPEN popover owns its own draft `Set<string>` (copied from `selected` at
// open time) plus all its DOM and listeners, local to `openPopover()` — none of
// it survives the matching `close()`, so repeated opens leak nothing.

import { h } from './dom.js';
import { openAnchoredDialog } from './popover.js';
import { idSafe } from './combobox.js';
import { canonicalizeSelection, sameSelection } from '../core/variable-selection.js';
import type { VariableOption } from '../core/variable-options.types.js';
import type { KeyboardOwner } from './app.types.js';

/** `buildMultiSelectField`'s options bag. */
export interface MultiSelectFieldOpts {
  /** Injected document realm — defaults to the ambient global. */
  document?: Document;
  /** The variable's exact name: its id-safe DOM ids, its accessible names, and
   *  its visible label are all built from this. A Dashboard variable has no
   *  label separate from its name (#447). */
  name: string;
  /** The batched option rows. May be empty — zero rows is a legal result. */
  options: readonly VariableOption[];
  /** Committed selection. May contain values absent from `options` (a dormant
   *  value a refresh dropped); never mutated by this module. */
  selected: readonly string[];
  active: boolean;
  /** The option batch has not answered for this variable yet. The control is
   *  rendered but MUST NOT be operable: `options` is still empty, so an Apply
   *  would canonicalize a restored selection against nothing and commit a clear.
   *  Cleared by the first `setOptions`. */
  loading?: boolean;
  /** `options` is a PREFIX — the server cut this variable's branch off at the
   *  cap. A committed value missing from it may be perfectly valid and simply
   *  live past the end, so Apply preserves such values instead of canonicalizing
   *  them away. See `applyBtn`'s handler. */
  incomplete?: boolean;
  /** The trigger's resting `title` — `name: Type`, from the bar. */
  title?: string;
  onApply(next: string[], active: boolean): void;
  onKeyboardOwnerChange?: (owner: KeyboardOwner | null) => void;
}

/** `buildMultiSelectField`'s return value. */
export interface MultiSelectFieldHandle {
  el: HTMLElement;
  /** Swap the option list in place when a refresh's batch lands, and say whether
   *  that list is a PREFIX (the server cut the branch off at the cap). An OPEN
   *  popover is closed as a Cancel first — its draft was built against the
   *  previous generation and must never be applied against this one. */
  setOptions(next: readonly VariableOption[], incomplete?: boolean): void;
  /** The batch-level failure affordance: `null` clears it. */
  setUnavailable(reason: string | null): void;
  /** Whether the popover is currently open — a caller reads this to decide
   *  whether an options refresh needs to announce that it cancelled a draft. */
  isOpen(): boolean;
  /** Focuses the trigger — used by a caller that just rebuilt the bar a
   *  still-open popover was force-closed out from under, to land focus on the
   *  fresh field rather than `<body>`. */
  focusTrigger(): void;
  /** Removes this control's listeners and closes the popover if open (a
   *  dispose-while-open is a Cancel: no `onApply`). */
  dispose(): void;
}

export function buildMultiSelectField(opts: MultiSelectFieldOpts): MultiSelectFieldHandle {
  const d = opts.document || document;
  const { name, selected, active } = opts;
  const baseTitle = opts.title ?? name;
  const suffix = idSafe(name);

  let options: readonly VariableOption[] = opts.options;
  let unavailable: string | null = null;
  let loading = !!opts.loading;
  let incomplete = !!opts.incomplete;
  // The currently-open popover's own close() — non-null iff the popover is open
  // (`isOpen()` reads this directly rather than tracking a second flag).
  let closeCurrent: ((closeOpts?: { skipFocus?: boolean }) => void) | null = null;

  const trigger = h('button', {
    type: 'button', id: 'ms-trigger-' + suffix, class: 'ms-trigger var-input',
    'aria-haspopup': 'dialog', 'aria-expanded': 'false',
  }) as HTMLButtonElement;
  // Same wrapper convention as `buildVariableOptionField`'s `.var-combo`: the
  // grid-column:2 sizing anchor and the status "wrapper" are one node.
  const control = h('div', { class: 'ms-field' }, trigger);

  /** `Not set` when nothing is committed; the single option's LABEL when exactly
   *  one is (a value with no matching option still shows raw, so a dormant
   *  selection never reads as blank); `N selected` beyond that. */
  const triggerText = (): string => {
    // While the batch is in flight the committed selection cannot be labelled
    // (the labels live in the answer), and the control is not operable, so it
    // says what it is doing rather than showing a count it cannot act on.
    if (loading) return 'Loading options…';
    if (!active || selected.length === 0) return 'Not set';
    if (selected.length === 1) {
      const opt = options.find((o) => o.value === selected[0]);
      return opt ? opt.label : selected[0];
    }
    return `${selected.length} selected`;
  };

  /** Whether the trigger refuses to open — and WHY, for `title`. Loading and a
   *  batch failure are both "you cannot pick right now"; only the reason differs,
   *  so they share the one inert state rather than growing a status machine. */
  const inertReason = (): string | null =>
    (unavailable ?? (loading ? 'Loading this variable’s options…' : null));

  const render = (): void => {
    const reason = inertReason();
    trigger.textContent = triggerText();
    trigger.title = reason ?? baseTitle;
    trigger.setAttribute('aria-label', `${name} variable, ${selected.length} selected`);
    control.classList.toggle('is-error', unavailable !== null);
    trigger.classList.toggle('is-error', unavailable !== null);
    trigger.classList.toggle('is-loading', loading && unavailable === null);
    if (unavailable === null) trigger.removeAttribute('aria-invalid');
    else trigger.setAttribute('aria-invalid', 'true');
    // `aria-disabled`, never `disabled`: a disabled button is not focusable, so
    // the reason in `title` becomes unreachable by keyboard and screen reader,
    // and disabling a focused control drops focus to `<body>`. `onTriggerClick`
    // is the real gate.
    trigger.setAttribute('aria-disabled', reason === null ? 'false' : 'true');
    trigger.setAttribute('aria-busy', String(loading));
  };

  const onTriggerClick = (): void => { if (inertReason() === null) openPopover(); };
  trigger.addEventListener('click', onTriggerClick);

  // Mount a fresh popover. The generic dialog chrome lives in
  // `openAnchoredDialog`; this builds only the multiselect content + draft and
  // wires the Apply/close ordering on top of it.
  function openPopover(): void {
    if (closeCurrent) return; // already open — never stack a second popover
    const draft = new Set(selected);
    let searchText = '';

    const liveEl = h('div', { class: 'sr-only ms-live', 'aria-live': 'polite' });
    const searchInput = h('input', {
      type: 'text', class: 'ms-search', placeholder: `Search ${name} options`,
      'aria-label': `Search ${name} options`,
    }) as HTMLInputElement;
    const selectAllCb = h('input', { type: 'checkbox', class: 'ms-select-all-cb' }) as HTMLInputElement;
    const selectAllRow = h('label', { class: 'ms-select-all' }, selectAllCb, h('span', {}, 'Select visible'));

    const rows = options.map((opt) => {
      const cb = h('input', { type: 'checkbox', checked: draft.has(opt.value) }) as HTMLInputElement;
      cb.addEventListener('change', () => {
        if (cb.checked) draft.add(opt.value); else draft.delete(opt.value);
        syncSelectAll();
      });
      const li = h('label', { class: 'ms-option' }, cb, h('span', { class: 'ms-option-label' }, opt.label));
      return { opt, li, cb };
    });
    const listEl = h('div', { class: 'ms-options' }, ...rows.map((r) => r.li));

    // Tri-state "select visible": unchecked when no visible row is in the draft,
    // checked when every visible row is, indeterminate when some are — and the
    // accessible label always names the ACTION a click performs next. Native
    // indeterminate→click sets `checked = true`, so setting `.checked` to
    // `allSelected` here (not `selected > 0`) is what makes a later click
    // reliably SELECT — never re-clear — a mixed selection.
    function syncSelectAll(): void {
      const visibleRows = rows.filter((r) => !r.li.hidden);
      const total = visibleRows.length;
      const picked = visibleRows.filter((r) => draft.has(r.opt.value)).length;
      const allSelected = total > 0 && picked === total;
      const noneSelected = picked === 0;
      selectAllCb.checked = allSelected;
      selectAllCb.indeterminate = !allSelected && !noneSelected;
      selectAllCb.setAttribute('aria-label',
        allSelected ? `Clear all ${total} visible options` : `Select all ${total} visible options`);
    }
    // Local case-insensitive substring filter over label AND value — hidden
    // (filtered-out) rows are never touched by select-visible below.
    function applyVariable(): void {
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
    searchInput.addEventListener('input', () => { searchText = searchInput.value; applyVariable(); });
    selectAllCb.addEventListener('change', () => {
      const checked = selectAllCb.checked;
      for (const row of rows) {
        if (row.li.hidden) continue; // hidden values are never touched
        row.cb.checked = checked;
        if (checked) draft.add(row.opt.value); else draft.delete(row.opt.value);
      }
      syncSelectAll();
    });

    const clearBtn = h('button', { type: 'button', class: 'ms-btn ms-btn-clear' }, 'Clear') as HTMLButtonElement;
    const cancelBtn = h('button', { type: 'button', class: 'ms-btn' }, 'Cancel') as HTMLButtonElement;
    const applyBtn = h('button', { type: 'button', class: 'ms-btn ms-btn-primary' }, 'Apply') as HTMLButtonElement;
    // Clear empties the WHOLE draft, not just the visible subset.
    clearBtn.addEventListener('click', () => {
      draft.clear();
      for (const row of rows) row.cb.checked = false;
      syncSelectAll();
    });
    cancelBtn.addEventListener('click', () => handle.close());
    /**
     * The values a set of selections COMMITS to.
     *
     * Whatever the option list offers is canonicalized by option order — that is
     * the list the user is looking at and manipulating.
     *
     * When the list is a PREFIX (`incomplete`), values it does not contain are
     * KEPT, appended in their committed order. Such a value is invisible: there
     * is no row for it, so the user cannot have deselected it, and — because the
     * list is known to be cut off — it may be perfectly valid rather than stale.
     * Dropping it would silently delete a filter the user never touched, which is
     * exactly what the session refuses to do when it declines to reconcile
     * against a truncated list. Both ends have to agree or the preservation is
     * undone here.
     *
     * Clear still removes them: it empties the whole draft, off-list values
     * included, which is the explicit "remove everything" action.
     *
     * With a COMPLETE list this is plain canonicalization — an off-list value has
     * genuinely gone away, and the session has already reconciled it out.
     */
    const commitOf = (values: readonly string[]): string[] => {
      const visible = canonicalizeSelection(values, options);
      if (!incomplete) return visible;
      const offered = new Set(options.map((o) => o.value));
      const seen = new Set(visible);
      const kept: string[] = [];
      for (const v of values) {
        if (!offered.has(v) && !seen.has(v)) { seen.add(v); kept.push(v); }
      }
      return [...visible, ...kept];
    };

    applyBtn.addEventListener('click', () => {
      const canonical = commitOf([...draft]);
      const prevCanonical = commitOf(selected);
      const activeNext = canonical.length > 0;
      // A no-op Apply (same canonical selection AND same active flag) closes
      // silently — `onApply` fires exactly once otherwise.
      const changed = !(sameSelection(canonical, prevCanonical) && activeNext === active);
      // Close BEFORE calling `onApply` — the shared `openAnchoredDialog`
      // contract (#335, originally this control's own merge-gate finding for
      // #189). `onApply` routes into `session.applyVariable`, which mutates state
      // and `publish()`es SYNCHRONOUSLY; a subscriber (`dashboard.ts`'s
      // `rebuildVariableBar`) can run inside this very call stack, and it must
      // observe this popover as ALREADY closed — never mistake an ordinary
      // commit for a force-cancelled outgoing popover, which is what used to
      // fire a false "options were refreshed" announcement.
      handle.close();
      if (changed) opts.onApply(canonical, activeNext);
    });
    const footer = h('div', { class: 'ms-footer' }, clearBtn, cancelBtn, applyBtn);

    // A `display:contents` wrapper: `openAnchoredDialog` appends ONE content
    // element, but `.ms-popover` is a flex column whose direct children carry
    // the layout — the contents wrapper generates no box, so they participate in
    // the dialog's flex context exactly as if they were direct children.
    const content = h('div', { style: { display: 'contents' } },
      searchInput, liveEl, selectAllRow, listEl, footer);

    const handle = openAnchoredDialog({
      document: d,
      trigger,
      ariaLabel: `${name} options`,
      content,
      dialogClassName: 'ms-popover',
      overlayClassName: 'popover-overlay',
      minWidthFromTrigger: true,
      initialFocus: () => searchInput, // focus moves into the dialog on open
      onClose: () => { closeCurrent = null; },
      onKeyboardOwnerChange: opts.onKeyboardOwnerChange,
    });
    closeCurrent = (closeOpts) => handle.close(closeOpts);

    applyVariable(); // seeds the live-region count and the select-visible tri-state
  }

  render();

  return {
    el: control,
    isOpen: () => closeCurrent !== null,
    setOptions: (next, nextIncomplete = false) => {
      options = next;
      incomplete = nextIncomplete;
      // The batch has answered for this variable, so the control becomes
      // operable — this is the ONLY thing that clears `loading`, which is what
      // guarantees an Apply can never canonicalize against a list that simply
      // had not arrived.
      loading = false;
      // A draft built against the PREVIOUS generation can never be applied
      // against this one, so an open popover is cancelled outright. `skipFocus`
      // is deliberately NOT passed: the trigger survives an options swap (unlike
      // the deleted error-mode input swap), so focus belongs back on it.
      closeCurrent?.();
      // Re-render the committed selection's LABEL: the same value may now carry
      // a different label. Never re-commits — a refresh is not a user choice.
      render();
    },
    setUnavailable: (reason) => {
      unavailable = reason;
      // A batch failure also ends the wait: there will be no options for this
      // wave, and leaving `loading` set would keep claiming one is coming.
      if (reason !== null) { loading = false; closeCurrent?.(); }
      render();
    },
    focusTrigger: () => trigger.focus(),
    dispose: () => {
      closeCurrent?.(); // dispose-while-open is a Cancel: no writes
      trigger.removeEventListener('click', onTriggerClick);
    },
  };
}
