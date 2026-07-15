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
    const clearBtn = field.el.querySelector('.filter-option-clear');
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
    const clearBtn = field.el.querySelector('.filter-option-clear');
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
