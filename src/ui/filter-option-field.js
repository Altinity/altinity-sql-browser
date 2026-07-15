import { createCombobox, idSafe } from './combobox.js';
import { h } from './dom.js';
import { Icon } from './icons.js';

export function buildFilterOptionField({
  document: doc, name, options = [], value = '', active = false,
  inactiveLabel = 'All', preview = false, onValueChange = () => {}, onCommit = () => {},
}) {
  const selected = () => options.find((option) => option.value === value);
  const input = h('input', {
    id: `filter-option-${idSafe(name)}`,
    class: 'filter-option-input', role: 'combobox', 'aria-autocomplete': 'list',
    'aria-expanded': 'false', autocomplete: 'off', placeholder: inactiveLabel,
  });
  const listEl = h('ul', { class: 'combo-list filter-option-list', role: 'listbox', hidden: '' });
  const liveEl = h('span', { class: 'sr-only', 'aria-live': 'polite' });
  const display = () => active ? (selected()?.label ?? value) : '';
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
    input, listEl, liveEl, document: doc,
    getOptions: (text) => {
      const q = String(text || '').toLowerCase();
      return options.filter((option) => !q
        || option.label.toLowerCase().includes(q) || option.value.toLowerCase().includes(q));
    },
    onCommit: commitOption,
  });
  const strictCommit = () => {
    const typed = input.value;
    const option = options.find((item) => item.label === typed || item.value === typed);
    if (option) commitOption(option);
    else input.value = committedText;
  };
  input.addEventListener('focus', () => combo.onFocus());
  input.addEventListener('input', () => combo.onInput());
  input.addEventListener('keydown', (event) => {
    if (combo.onKeyDown(event)) return;
    if (event.key === 'Enter') strictCommit();
  });
  input.addEventListener('blur', () => { combo.onBlur(); strictCommit(); });
  input.addEventListener('compositionstart', () => combo.onCompositionStart());
  input.addEventListener('compositionend', () => combo.onCompositionEnd());
  if (preview) input.setAttribute('data-preview-local', 'true');
  const clear = h('button', {
    class: 'filter-option-clear', type: 'button', title: inactiveLabel,
    'aria-label': `Clear ${name}`,
    onclick: () => {
      value = '';
      active = false;
      input.value = '';
      committedText = '';
      onValueChange(value, false);
      onCommit(value, false);
    },
  }, Icon.close());
  return { el: h('div', { class: 'filter-option-control' }, input, clear, listEl, liveEl), input, destroy: combo.close };
}
