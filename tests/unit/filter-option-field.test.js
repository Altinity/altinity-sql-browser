import { describe, expect, it, vi } from 'vitest';
import { buildFilterOptionField } from '../../src/ui/filter-option-field.js';

const options = [
  { value: '', label: '(empty)' },
  { value: 'ATL', label: 'Atlanta' },
  { value: 'JFK', label: 'New York' },
];

describe('strict Filter option field', () => {
  it('searches labels, commits exact values, and keeps inactive distinct from empty', () => {
    const onValueChange = vi.fn();
    const onCommit = vi.fn();
    const field = buildFilterOptionField({ document, name: 'origin', options, inactiveLabel: 'All', onValueChange, onCommit });
    document.body.appendChild(field.el);
    // Wears the shared var-combo clothes (regression: it used to hand-roll its
    // own unstyled listbox classes) — same wrapper/input/list every combobox
    // field uses, so it renders identically next to a plain filter field.
    expect(field.el.classList.contains('var-combo')).toBe(true);
    expect(field.input.classList.contains('var-input')).toBe(true);
    expect(field.el.querySelector('ul.var-combo-list')).toBeTruthy();
    expect(field.input.value).toBe('');
    expect(field.input.placeholder).toBe('All');
    field.input.dispatchEvent(new Event('focus'));
    field.input.value = 'new';
    field.input.dispatchEvent(new Event('input'));
    const optionEls = field.el.querySelectorAll('[role="option"]');
    expect(optionEls).toHaveLength(1);
    expect(optionEls[0].textContent).toBe('New York');
    optionEls[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onValueChange).toHaveBeenLastCalledWith('JFK', true);
    expect(onCommit).toHaveBeenLastCalledWith('JFK', true);
    expect(field.input.value).toBe('New York');
    const clearBtn = field.el.querySelector('.var-combo-clear-inline');
    expect(clearBtn.getAttribute('aria-label')).toBe('Clear origin');
    clearBtn.click();
    expect(onValueChange).toHaveBeenLastCalledWith('', false);
    expect(onCommit).toHaveBeenLastCalledWith('', false);
    field.destroy();
    field.el.remove();
  });
  it('rejects arbitrary text and supports an active empty-string option', () => {
    const onCommit = vi.fn();
    const field = buildFilterOptionField({ document, name: 'x', options, value: '', active: true, onCommit });
    document.body.appendChild(field.el);
    expect(field.input.value).toBe('(empty)');
    field.input.value = 'arbitrary';
    field.input.dispatchEvent(new Event('blur'));
    expect(field.input.value).toBe('(empty)');
    expect(onCommit).not.toHaveBeenCalled();
    field.el.remove();
  });
  it('prevents its own mousedown from stealing focus off the input (#174 §1 mousedown-before-blur pattern, same as an option commit)', () => {
    const onValueChange = vi.fn();
    const onCommit = vi.fn();
    const field = buildFilterOptionField({ document, name: 'x', options, value: 'ATL', active: true, onValueChange, onCommit });
    document.body.appendChild(field.el);
    const clearBtn = field.el.querySelector('.var-combo-clear-inline');
    const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    // dispatchEvent returns false when a listener called preventDefault (cancelable event).
    expect(clearBtn.dispatchEvent(mousedown)).toBe(false);
    clearBtn.click();
    // Exactly one commit for the clear — a real pointer click that blurred the
    // input FIRST would otherwise re-commit the still-showing "Atlanta" value
    // via strictCommit() before this click handler even ran.
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('', false);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('', false);
    field.el.remove();
  });
  it('matches by option value (not just label) and commits with default callbacks', () => {
    // No onValueChange/onCommit passed — the defaults must be safe to call.
    const field = buildFilterOptionField({ document, name: 'x', options });
    document.body.appendChild(field.el);
    field.input.dispatchEvent(new Event('focus'));
    field.input.value = 'atl'; // matches the ATL *value*, not the "Atlanta" label
    field.input.dispatchEvent(new Event('input'));
    const optionEls = field.el.querySelectorAll('[role="option"]');
    expect(optionEls).toHaveLength(1);
    expect(optionEls[0].textContent).toBe('Atlanta');
    expect(() => optionEls[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))).not.toThrow();
    expect(field.input.value).toBe('Atlanta');
    field.el.remove();
  });
  it('shows a raw active value when it matches no known option label', () => {
    const field = buildFilterOptionField({ document, name: 'x', options, value: 'ZZZ', active: true });
    expect(field.input.value).toBe('ZZZ');
    field.el.remove();
  });
  it('commits an exact label with Enter', () => {
    const onCommit = vi.fn();
    const field = buildFilterOptionField({ document, name: 'x', options, onCommit });
    document.body.appendChild(field.el);
    field.input.value = 'Atlanta';
    field.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCommit).toHaveBeenCalledWith('ATL', true);
    expect(field.input.value).toBe('Atlanta');
    field.el.remove();
  });
});
