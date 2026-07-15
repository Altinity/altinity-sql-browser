// The curated Dashboard Filter field (#160): a strict single-select over a
// Filter favorite's option bundle. It is the FOURTH consumer of the shared
// combobox primitive (combobox.js, #174 §1) after #169 presets, #171 recents,
// and #172 enums — so it wears the SAME clothes they do: a `.var-combo`
// wrapper, a `.var-input` free-text `<input>`, and the styled `position:fixed`
// `.var-combo-list` popover, wired through the shared `wireComboInput` helper.
// It does NOT hand-roll its own listbox classes or its own listener block
// (an earlier draft did, and rendered as an unstyled inline bulleted list).
//
// It differs from those three only in policy, not in looks: it is STRICT
// (blur/Enter revert to the last committed option instead of keeping arbitrary
// text — a curated source enumerates every legal value), and it carries an
// explicit inactive state ("All"/"Not set") with a clear button, since a
// dashboard filter's default is "no predicate" rather than empty text. Picking
// an option activates it; the × clears back to inactive.

import { createCombobox, idSafe, wireComboInput } from './combobox.js';
import { h } from './dom.js';
import { Icon } from './icons.js';

/**
 * @param {{
 *   document?: Document, name: string, options?: {value: string, label: string}[],
 *   value?: string, active?: boolean, inactiveLabel?: string, preview?: boolean,
 *   onValueChange?: (value: string, active: boolean) => void,
 *   onCommit?: (value: string, active: boolean) => void,
 * }} opts
 * @returns {{el: HTMLElement, input: HTMLInputElement, destroy: () => void}}
 */
export function buildFilterOptionField({
  document: doc, name, options = [], value = '', active = false,
  inactiveLabel = 'All', preview = false, onValueChange = () => {}, onCommit = () => {},
}) {
  const d = doc || document;
  const suffix = idSafe(name);
  const listId = 'filter-option-list-' + suffix;
  const liveId = 'filter-option-live-' + suffix;
  const selected = () => options.find((option) => option.value === value);
  const input = h('input', {
    type: 'text', id: 'filter-option-' + suffix, class: 'var-input', 'aria-label': name,
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId,
    autocomplete: 'off', placeholder: inactiveLabel,
  });
  const listEl = h('ul', { class: 'var-combo-list', id: listId, role: 'listbox', hidden: true });
  const liveEl = h('div', { class: 'sr-only', id: liveId, 'aria-live': 'polite' });
  const display = () => (active ? (selected()?.label ?? value) : '');
  input.value = display();
  let committedText = input.value;

  const commitOption = (option) => {
    value = option.value;
    active = true;
    input.value = option.label;
    committedText = option.label;
    onValueChange(value, true);
    onCommit(value, true);
  };

  const combo = createCombobox({
    input, listEl, liveEl, document: d,
    getOptions: (text) => {
      const q = String(text || '').toLowerCase();
      return options.filter((option) => !q
        || option.label.toLowerCase().includes(q) || option.value.toLowerCase().includes(q));
    },
    onCommit: commitOption,
  });

  // Strict commit (blur/Enter with no active dropdown option): only an exact
  // label/value match commits; anything else reverts to the last committed
  // text — a curated field never holds free text.
  const strictCommit = () => {
    const typed = input.value;
    const option = options.find((item) => item.label === typed || item.value === typed);
    if (option) commitOption(option);
    else input.value = committedText;
  };

  // Reuse the shared focus/input/keydown/blur/composition wiring (combobox.js)
  // — the same helper enum/recent/relative-time fields use. `onValueInput` is a
  // no-op (selection, not keystrokes, commits a strict field); the combobox's
  // own onCommit handles an option pick, and this onCommit handles the
  // blur/Enter strict path.
  wireComboInput({ input, ...combo }, { onValueInput: () => {}, onCommit: strictCommit });
  if (preview) input.setAttribute('data-preview-local', 'true');

  // The inline clear (×) resets to the inactive "All" state. Omitted in the
  // read-only drawer preview (`preview`), where the field is a demonstration in
  // a grid cell, not a live dashboard filter — the user asked for no × there.
  const clear = preview ? null : h('button', {
    class: 'var-combo-clear-inline', type: 'button', title: inactiveLabel,
    'aria-label': `Clear ${name}`,
    // Commit BEFORE blur (#174 §1, same as an option's own mousedown-commit in
    // combobox.js): without this, a real pointer click blurs the input FIRST,
    // and the blur handler's strictCommit() re-commits whatever text is still
    // showing before this handler even runs — double-committing the clear.
    onmousedown: (e) => e.preventDefault(),
    onclick: () => {
      value = '';
      active = false;
      input.value = '';
      committedText = '';
      onValueChange(value, false);
      onCommit(value, false);
    },
  }, Icon.close());

  return {
    el: h('div', { class: 'var-combo filter-select' }, input, clear, listEl, liveEl),
    input,
    destroy: combo.close,
  };
}
