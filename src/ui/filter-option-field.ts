// The option-backed Dashboard VARIABLE field (#447 phase 2): a strict
// single-select over the options one variable's Dashboard-local option SQL
// returned in the refresh batch.
//
// Recovered from the curated Filter field of the same name that phase 1 deleted
// with the rest of the provider layer. The control is unchanged in looks and
// policy — what changed is where its options come from: a variable's own option
// SQL on the Dashboard document, rather than a `filter`-role saved query
// discovered by matching an output-column name.
//
// It is a consumer of the shared combobox primitive (combobox.ts), so it wears
// the same clothes the enum/recent/relative-time fields do: a `.var-combo`
// wrapper, a `.var-input` free-text `<input>`, and the styled `position: fixed`
// `.var-combo-list` popover, wired through the shared `wireComboInput`. It does
// NOT hand-roll its own listbox classes or listener block.
//
// It differs from those three only in policy:
//
//   - it is STRICT — blur/Enter revert to the last committed option instead of
//     keeping arbitrary text, because option SQL enumerates every legal value;
//   - it has an explicit UNSET state with a clear (×) button, since a variable
//     starts with no value at all and its panels WAIT until it has one;
//   - it never auto-selects the first option. A Dashboard must not silently
//     apply a predicate the user did not choose (#447 acceptance), so an unset
//     variable stays unset until someone picks.
//
// One deliberate leniency inside the strictness: a value that is NOT among the
// options still displays. A variable's committed value is restored from the
// per-Dashboard store (#303) before any option query has run, and option SQL can
// change under it — showing the raw value is honest, where blanking it would
// silently discard a filter the panels are still bound to.

import { createCombobox, idSafe, wireComboInput } from './combobox.js';
import { h } from './dom.js';
import { Icon } from './icons.js';
import type { ComboOption } from './combobox.js';
import type { VariableOption } from '../core/variable-options.types.js';

/** The label shown when a variable has no value: its panels are waiting, so this
 *  says "nothing chosen", never "everything". */
export const UNSET_OPTION_LABEL = 'Not set';

/** `buildFilterOptionField`'s options bag. */
export interface FilterOptionFieldOpts {
  document?: Document;
  /** The exact variable name — used for the accessible name and element ids. */
  name: string;
  options?: readonly VariableOption[];
  /** The committed value, or `''` when unset. */
  value?: string;
  active?: boolean;
  /** Hover text for the input (the shared `baseTitle` convention). */
  title?: string;
  onCommit?: (value: string, active: boolean) => void;
}

/** What `buildFilterOptionField` returns — the `FieldHandle` shape `filter-bar.ts`
 *  registers, plus the wrapper and its input. */
export interface FilterOptionField {
  el: HTMLElement;
  input: HTMLInputElement;
  /** Replace the offered options WITHOUT rebuilding the field, preserving the
   *  committed value and any open popover. This is what lets an options batch
   *  land mid-session without tearing down the bar (and with it, whatever the
   *  user was typing in some other field). */
  setOptions(next: readonly VariableOption[]): void;
  /** Mark the control unavailable — the batch that would have filled it failed.
   *  The failure itself is reported once for the whole Dashboard, so this only
   *  has to stop the field from pretending it can offer a choice. */
  setUnavailable(reason: string | null): void;
  dispose(): void;
}

export function buildFilterOptionField({
  document: doc, name, options = [], value = '', active = false, title,
  onCommit = () => {},
}: FilterOptionFieldOpts): FilterOptionField {
  const d = doc || document;
  const suffix = idSafe(name);
  const listId = 'variable-option-list-' + suffix;
  const liveId = 'variable-option-live-' + suffix;
  let current: readonly VariableOption[] = options;
  let unavailable: string | null = null;
  const baseTitle = title ?? name;

  const selected = (): VariableOption | undefined =>
    current.find((option) => option.value === value);
  const input = h('input', {
    type: 'text', id: 'variable-option-' + suffix, class: 'var-input', 'aria-label': name,
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId,
    autocomplete: 'off', placeholder: UNSET_OPTION_LABEL, title: baseTitle,
  }) as HTMLInputElement;
  const listEl = h('ul', { class: 'var-combo-list', id: listId, role: 'listbox', hidden: true });
  const liveEl = h('div', { class: 'sr-only', id: liveId, 'aria-live': 'polite' });

  // An active value with no matching option shows the raw value rather than
  // blanking — see the module header.
  const display = (): string => (active ? (selected()?.label ?? value) : '');
  input.value = display();
  let committedText = input.value;

  const commitOption = (option: ComboOption): void => {
    value = option.value;
    active = true;
    input.value = option.label;
    committedText = input.value;
    onCommit(value, true);
  };

  const combo = createCombobox({
    input,
    listEl,
    liveEl,
    document: d,
    getOptions: (text) => {
      if (unavailable !== null) return [];
      const q = String(text || '').toLowerCase();
      // An exact match on the committed text must not filter the list down to
      // one entry — the field shows a committed LABEL, and re-opening the
      // dropdown on it should still offer every sibling.
      if (q === committedText.toLowerCase()) return current.map((option) => ({ ...option }));
      return current
        .filter((option) => !q
          || option.label.toLowerCase().includes(q) || option.value.toLowerCase().includes(q))
        .map((option) => ({ ...option }));
    },
    onCommit: commitOption,
  });

  // Strict commit (blur/Enter with no active dropdown option): only an exact
  // label/value match commits; anything else reverts to the last committed text.
  // A strict field never holds free text.
  const strictCommit = (): void => {
    const typed = input.value;
    const option = current.find((item) => item.label === typed || item.value === typed);
    if (option) commitOption(option);
    else input.value = committedText;
  };

  wireComboInput({ input, ...combo }, { onValueInput: () => {}, onCommit: strictCommit });

  // The inline clear (×) returns the variable to UNSET, which re-suspends every
  // panel that requires it.
  const clear = h('button', {
    class: 'var-combo-clear-inline', type: 'button', title: UNSET_OPTION_LABEL,
    'aria-label': `Clear ${name}`,
    // Commit BEFORE blur (#174 §1, like an option's own mousedown-commit in
    // combobox.ts): without this a real pointer click blurs the input first, and
    // the blur handler's strictCommit() re-commits whatever text is still showing
    // before this handler even runs — double-committing the clear.
    onmousedown: (e: Event) => e.preventDefault(),
    onclick: () => {
      value = '';
      active = false;
      input.value = '';
      committedText = '';
      onCommit('', false);
    },
  }, Icon.close());

  return {
    el: h('div', { class: 'var-combo filter-select' }, input, clear, listEl, liveEl),
    input,
    setOptions: (next) => {
      current = next;
      // Re-render the committed value's LABEL: the same value may now carry a
      // different label, and a value that had no option before may have one now.
      // Never re-commits — an options refresh is not a user choice.
      input.value = display();
      committedText = input.value;
      if (combo.isOpen()) combo.refresh();
    },
    setUnavailable: (reason) => {
      unavailable = reason;
      input.disabled = reason !== null;
      input.classList.toggle('is-error', reason !== null);
      input.title = reason ?? baseTitle;
      clear.disabled = reason !== null;
      if (reason !== null) combo.close();
    },
    dispose: combo.close,
  };
}
