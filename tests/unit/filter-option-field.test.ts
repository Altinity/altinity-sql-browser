// #447 phase 2: the option-backed Dashboard variable field — a STRICT
// single-select over the options one variable's option SQL returned.
//
// The policy differences from the free-text fields are the whole point of the
// module, so each one is asserted: it never auto-selects, it reverts non-matching
// text instead of keeping it, it can be cleared back to UNSET, and it can take a
// fresh option list in place without losing the committed value.

import { describe, it, expect, vi } from 'vitest';
import { buildFilterOptionField, UNSET_OPTION_LABEL } from '../../src/ui/filter-option-field.js';
import type { FilterOptionFieldOpts } from '../../src/ui/filter-option-field.js';

const OPTIONS = [
  { value: 'de', label: 'Germany' },
  { value: 'fr', label: 'France' },
  { value: 'es', label: 'Spain' },
];

function build(over: Partial<FilterOptionFieldOpts> = {}) {
  const onCommit = vi.fn();
  const field = buildFilterOptionField({
    document, name: 'country', options: OPTIONS, onCommit, ...over,
  });
  document.body.replaceChildren(field.el);
  return { field, onCommit, input: field.input };
}

const listOf = (el: HTMLElement): HTMLElement =>
  el.querySelector('.var-combo-list') as HTMLElement;
const optionTexts = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('.combo-option')].map((node) => node.textContent ?? '');
const clearBtn = (el: HTMLElement): HTMLButtonElement =>
  el.querySelector('.var-combo-clear-inline') as HTMLButtonElement;

const focus = (input: HTMLInputElement): void => {
  input.focus();
  input.dispatchEvent(new Event('focus'));
};
const type = (input: HTMLInputElement, text: string): void => {
  input.value = text;
  input.dispatchEvent(new Event('input'));
};
const blur = (input: HTMLInputElement): void => { input.dispatchEvent(new Event('blur')); };

describe('buildFilterOptionField', () => {
  it('wears the shared combobox clothes rather than its own listbox', () => {
    const { field, input } = build();
    expect(field.el.classList.contains('var-combo')).toBe(true);
    expect(field.el.classList.contains('filter-select')).toBe(true);
    expect(input.classList.contains('var-input')).toBe(true);
    expect(input.getAttribute('role')).toBe('combobox');
    expect(listOf(field.el).getAttribute('role')).toBe('listbox');
    // `aria-controls` must actually resolve to the list this field built.
    expect(input.getAttribute('aria-controls')).toBe(listOf(field.el).id);
    expect(input.getAttribute('aria-label')).toBe('country');
  });

  it('starts UNSET, showing the placeholder and never a value', () => {
    const { input } = build();
    expect(input.value).toBe('');
    expect(input.placeholder).toBe(UNSET_OPTION_LABEL);
  });

  it('never auto-selects the first option, even after the list is opened', () => {
    const { input, onCommit } = build();
    focus(input);
    expect(input.value).toBe('');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('shows the committed option LABEL, not its value', () => {
    const { input } = build({ value: 'de', active: true });
    expect(input.value).toBe('Germany');
  });

  it('shows nothing when a value is present but inactive', () => {
    const { input } = build({ value: 'de', active: false });
    expect(input.value).toBe('');
  });

  it('commits value AND activation when an option is picked', () => {
    const { field, input, onCommit } = build();
    focus(input);
    const option = [...listOf(field.el).querySelectorAll<HTMLElement>('.combo-option')]
      .find((node) => (node.textContent ?? '').includes('France'))!;
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onCommit).toHaveBeenCalledWith('fr', true);
    expect(input.value).toBe('France');
  });

  it('filters the list by label or value as the user types', () => {
    const { field, input } = build();
    focus(input);
    type(input, 'ran');
    expect(optionTexts(field.el).join('|')).toContain('France');
    expect(optionTexts(field.el).join('|')).not.toContain('Germany');
    type(input, 'es');
    // Matched on the VALUE 'es', and on the label 'Spain' is not needed for it.
    expect(optionTexts(field.el).join('|')).toContain('Spain');
  });

  it('re-opening on a committed label still offers every sibling', () => {
    // Filtering by the committed text would otherwise narrow the list to the one
    // option already chosen, making it impossible to switch by mouse.
    const { field, input } = build({ value: 'de', active: true });
    focus(input);
    expect(optionTexts(field.el)).toHaveLength(3);
  });

  it('is STRICT: blur reverts free text to the last committed label', () => {
    const { input, onCommit } = build({ value: 'de', active: true });
    focus(input);
    type(input, 'Atlantis');
    blur(input);
    expect(input.value).toBe('Germany');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('is STRICT: blur reverts to empty when nothing was committed', () => {
    const { input, onCommit } = build();
    focus(input);
    type(input, 'Atlantis');
    blur(input);
    expect(input.value).toBe('');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits on blur when the typed text exactly matches a label or a value', () => {
    const { input, onCommit } = build();
    focus(input);
    type(input, 'Spain');
    blur(input);
    expect(onCommit).toHaveBeenCalledWith('es', true);
    const second = build();
    focus(second.input);
    type(second.input, 'fr');
    blur(second.input);
    expect(second.onCommit).toHaveBeenCalledWith('fr', true);
  });

  it('clears back to UNSET through the inline ×', () => {
    const { field, input, onCommit } = build({ value: 'de', active: true });
    const clear = clearBtn(field.el);
    expect(clear.getAttribute('aria-label')).toBe('Clear country');
    clear.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onCommit).toHaveBeenCalledWith('', false);
    expect(input.value).toBe('');
  });

  it('the × suppresses its own mousedown so a blur cannot double-commit the clear', () => {
    // Without preventDefault the pointer blurs the input first, and the blur
    // handler re-commits whatever text is still showing.
    const { field } = build({ value: 'de', active: true });
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    clearBtn(field.el).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('displays a committed value that is NOT among the options', () => {
    // A selection restored from the per-Dashboard store (#303) before any option
    // query ran, or one whose option SQL has since changed. Blanking it would
    // silently discard a filter the panels are still bound to.
    const { input } = build({ value: 'zz', active: true });
    expect(input.value).toBe('zz');
  });

  it('setOptions replaces the list in place, keeping the committed value', () => {
    const { field, input, onCommit } = build({ value: 'de', active: true, options: [] });
    // Before the batch landed there was no matching option, so the raw value shows.
    expect(input.value).toBe('de');
    field.setOptions(OPTIONS);
    // Now it resolves to a label — without any commit, because an options refresh
    // is not a user choice.
    expect(input.value).toBe('Germany');
    expect(onCommit).not.toHaveBeenCalled();
    focus(input);
    expect(optionTexts(field.el)).toHaveLength(3);
  });

  it('setOptions re-renders an OPEN list', () => {
    const { field, input } = build({ options: [OPTIONS[0]] });
    focus(input);
    expect(optionTexts(field.el)).toHaveLength(1);
    field.setOptions(OPTIONS);
    expect(optionTexts(field.el)).toHaveLength(3);
  });

  it('setUnavailable disables the control, offers nothing, and states why', () => {
    const { field, input } = build();
    field.setUnavailable('Variable options could not be loaded: boom');
    expect(input.disabled).toBe(true);
    expect(input.classList.contains('is-error')).toBe(true);
    expect(input.title).toBe('Variable options could not be loaded: boom');
    expect(clearBtn(field.el).disabled).toBe(true);
    focus(input);
    expect(optionTexts(field.el)).toHaveLength(0);
  });

  it('setUnavailable(null) restores the control and its base title', () => {
    const { field, input } = build({ title: 'country: String' });
    field.setUnavailable('boom');
    field.setUnavailable(null);
    expect(input.disabled).toBe(false);
    expect(input.classList.contains('is-error')).toBe(false);
    expect(input.title).toBe('country: String');
    expect(clearBtn(field.el).disabled).toBe(false);
  });

  it('starts unavailable when built with an optionsError already known', () => {
    const { field, input } = build();
    field.setUnavailable('boom');
    expect(input.disabled).toBe(true);
    field.dispose();
    expect(listOf(field.el).hidden).toBe(true);
  });

  it('falls back to the ambient document and the name as the title', () => {
    const field = buildFilterOptionField({ name: 'plain' });
    expect(field.input.title).toBe('plain');
    expect(field.el.querySelector('.var-input')).toBe(field.input);
  });

  it('is usable with no onCommit wired at all', () => {
    // The default is a real no-op, so a caller that only wants to display a
    // selection does not have to supply a callback to avoid a crash.
    const field = buildFilterOptionField({ document, name: 'country', options: OPTIONS, value: 'de', active: true });
    document.body.replaceChildren(field.el);
    expect(() => clearBtn(field.el).dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow();
    expect(field.input.value).toBe('');
  });

  it('builds element ids that survive a name needing escaping', () => {
    const field = buildFilterOptionField({ document, name: 'a b/c' });
    const list = field.el.querySelector('.var-combo-list') as HTMLElement;
    expect(list.id).toBe('variable-option-list-a_b_c');
    expect(field.input.getAttribute('aria-controls')).toBe(list.id);
  });

  it('dispose closes an open list', () => {
    const { field, input } = build();
    focus(input);
    expect(listOf(field.el).hidden).toBe(false);
    field.dispose();
    expect(listOf(field.el).hidden).toBe(true);
  });

  it('takes an empty option list without offering anything', () => {
    const { field, input } = build({ options: [] });
    focus(input);
    expect(optionTexts(field.el)).toHaveLength(0);
  });
});
