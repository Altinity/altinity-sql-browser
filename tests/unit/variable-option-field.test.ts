// #447 phase 2: the option-backed Dashboard variable field — a STRICT
// single-select over the options one variable's option SQL returned.
//
// The policy differences from the free-text fields are the whole point of the
// module, so each one is asserted: it never auto-selects, it reverts non-matching
// text instead of keeping it, it can be cleared back to UNSET, and it can take a
// fresh option list in place without losing the committed value.

import { describe, it, expect, vi } from 'vitest';
import {
  OPTION_DROPDOWN_CAP, UNSET_OPTION_LABEL, buildVariableOptionField,
} from '../../src/ui/variable-option-field.js';
import type { VariableOptionFieldOpts } from '../../src/ui/variable-option-field.js';

const OPTIONS = [
  { value: 'de', label: 'Germany' },
  { value: 'fr', label: 'France' },
  { value: 'es', label: 'Spain' },
];

function build(over: Partial<VariableOptionFieldOpts> = {}) {
  const onCommit = vi.fn();
  const field = buildVariableOptionField({
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

describe('buildVariableOptionField', () => {
  it('wears the shared combobox clothes rather than its own listbox', () => {
    const { field, input } = build();
    expect(field.el.classList.contains('var-combo')).toBe(true);
    expect(field.el.classList.contains('variable-select')).toBe(true);
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

  it('setUnavailable refuses input, offers nothing, and states why — while staying REACHABLE', () => {
    const { field, input } = build();
    field.setUnavailable('Variable options could not be loaded: boom');
    // read-only, NOT disabled: a disabled input is not focusable, so its `title` —
    // the only place the reason is written — would be unreachable by keyboard and
    // screen reader, and disabling a focused field drops focus to <body>.
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(false);
    expect(input.getAttribute('aria-disabled')).toBe('true');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.classList.contains('is-error')).toBe(true);
    expect(input.title).toBe('Variable options could not be loaded: boom');
    focus(input);
    expect(optionTexts(field.el)).toHaveLength(0);
  });

  it('keeps the clear button live while unavailable', () => {
    // A user whose option batch failed must still be able to un-apply a selection
    // that is currently filtering their panels.
    const { field, onCommit } = build({ value: 'de', active: true });
    field.setUnavailable('boom');
    const clear = clearBtn(field.el);
    expect(clear.disabled).toBe(false);
    clear.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onCommit).toHaveBeenCalledWith('', false);
  });

  it('setUnavailable(null) restores the control and its base title', () => {
    const { field, input } = build({ title: 'country: String' });
    field.setUnavailable('boom');
    field.setUnavailable(null);
    expect(input.readOnly).toBe(false);
    expect(input.classList.contains('is-error')).toBe(false);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(input.getAttribute('aria-disabled')).toBe('false');
    expect(input.title).toBe('country: String');
  });

  it('dispose closes the list of an unavailable field too', () => {
    const { field } = build();
    field.setUnavailable('boom');
    field.dispose();
    expect(listOf(field.el).hidden).toBe(true);
  });

  it('never selects a BLANK-labelled option just because the box is empty', () => {
    // A NULL or '' label column is preserved by the reader, so this option exists.
    // Matching it on empty text would apply a predicate on nothing but a focus and
    // a click elsewhere.
    const { input, onCommit } = build({ options: [{ value: '7', label: '' }, ...OPTIONS] });
    focus(input);
    blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  it('does not re-commit an unchanged selection on blur', () => {
    // `wireComboInput` fires its commit on EVERY blur, so without a change check a
    // focus/blur cycle on a committed select re-runs every panel that binds it.
    const { input, onCommit } = build({ value: 'de', active: true });
    focus(input);
    blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('Germany');
  });

  it('does not fire a clear on an already-unset field', () => {
    const { field, onCommit } = build();
    clearBtn(field.el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('caps the rendered dropdown, filtering BEFORE capping', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ value: `v${i}`, label: `L${i}` }));
    const { field, input } = build({ options: many });
    focus(input);
    expect(optionTexts(field.el)).toHaveLength(OPTION_DROPDOWN_CAP);
    // An option past the cap is still reachable by typing — which is why the
    // filter runs first.
    type(input, 'L249');
    expect(optionTexts(field.el).join('|')).toContain('L249');
  });

  it('setOptions does not discard in-progress typing', () => {
    // The whole reason options arrive through setOptions instead of a bar rebuild
    // is that a batch lands asynchronously and must not throw away what the user
    // is typing — including in the field the options belong to.
    const { field, input } = build({ options: [] });
    focus(input);
    type(input, 'Ger');
    field.setOptions(OPTIONS);
    expect(input.value).toBe('Ger');
  });

  it('falls back to the ambient document and the name as the title', () => {
    const field = buildVariableOptionField({ name: 'plain' });
    expect(field.input.title).toBe('plain');
    expect(field.el.querySelector('.var-input')).toBe(field.input);
  });

  it('is usable with no onCommit wired at all', () => {
    // The default is a real no-op, so a caller that only wants to display a
    // selection does not have to supply a callback to avoid a crash.
    const field = buildVariableOptionField({ document, name: 'country', options: OPTIONS, value: 'de', active: true });
    document.body.replaceChildren(field.el);
    expect(() => clearBtn(field.el).dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow();
    expect(field.input.value).toBe('');
  });

  it('builds element ids that survive a name needing escaping', () => {
    const field = buildVariableOptionField({ document, name: 'a b/c' });
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
