import { describe, it, expect, vi } from 'vitest';
import { buildRecentField } from '../../src/ui/recent-field.js';

function build(overrides = {}) {
  const onValueInput = vi.fn();
  const onCommit = vi.fn();
  const onClearRecent = vi.fn();
  const getRecents = overrides.getRecents
    || ((text) => ['b', 'a'].filter((v) => !text || v.includes(text)));
  const field = buildRecentField({
    name: 'tenant', type: 'String', value: '', baseTitle: 'tenant: String',
    onValueInput, onCommit, onClearRecent, ...overrides, getRecents,
  });
  document.body.appendChild(field.el);
  return { field, onValueInput, onCommit, onClearRecent, getRecents };
}

describe('buildRecentField — DOM shape', () => {
  it('builds an accessible combobox input with the expected ARIA wiring', () => {
    const { field } = build();
    const { input } = field;
    expect(input.classList.contains('var-input')).toBe(true);
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-controls')).toBeTruthy();
    expect(input.placeholder).toBe('String');
    expect(input.title).toBe('tenant: String');
    expect(input.getAttribute('aria-label')).toBe('tenant');
    expect(field.el.classList.contains('var-combo')).toBe(true);
    expect(field.el.querySelector('[role="listbox"]')).not.toBeNull();
    expect(field.el.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(field.el.querySelector('.var-combo-footer')).not.toBeNull();
  });
  it('prefills the input with the stored value', () => {
    const { field } = build({ value: 'acme' });
    expect(field.input.value).toBe('acme');
  });
  it('sanitizes the variable name into a safe id suffix for the listbox/live-region ids', () => {
    const { field } = build({ name: 'weird name!' });
    expect(field.input.getAttribute('aria-controls')).toMatch(/^var-recent-list-weird_name_$/);
  });
});

describe('buildRecentField — combobox delegation', () => {
  it('onFocus opens the recents list, newest-first as returned by getRecents', () => {
    const { field } = build();
    field.onFocus();
    expect(field.input.getAttribute('aria-expanded')).toBe('true');
    const opts = [...field.el.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(opts).toEqual(['b', 'a']);
  });
  it('onBlur closes it', () => {
    const { field } = build();
    field.onFocus();
    field.onBlur();
    expect(field.input.getAttribute('aria-expanded')).toBe('false');
  });
  it('onInput re-filters live via getRecents(text) (type-to-filter)', () => {
    const getRecents = vi.fn((text) => (text ? ['a'] : ['b', 'a']));
    const { field } = build({ getRecents });
    field.onFocus();
    field.input.value = 'a';
    field.onInput();
    expect(getRecents).toHaveBeenCalledWith('a');
    const opts = [...field.el.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(opts).toEqual(['a']);
  });
  it('onKeyDown delegates to the combobox (Arrow opens + navigates)', () => {
    const { field } = build();
    const e = { key: 'ArrowDown', preventDefault: vi.fn() };
    expect(field.onKeyDown(e)).toBe(true);
    expect(field.input.getAttribute('aria-expanded')).toBe('true');
  });
  it('composition start/end delegate through to the combobox', () => {
    const { field } = build();
    field.onFocus();
    field.onCompositionStart();
    field.input.value = 'zzz-no-match';
    field.onInput(); // suppressed while composing
    expect(field.el.querySelectorAll('[role="option"]')).toHaveLength(2);
    field.onCompositionEnd();
    expect(field.el.querySelectorAll('[role="option"]')).toHaveLength(0);
  });
  it('clicking a recent (option mousedown) inserts it, leaves the field editable, and fires onValueInput + onCommit', () => {
    const { field, onValueInput, onCommit } = build();
    field.onFocus();
    const opt = field.el.querySelector('[role="option"]'); // first: 'b'
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(field.input.value).toBe('b');
    expect(field.input.readOnly).toBe(false);
    expect(onValueInput).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});

describe('buildRecentField — Clear recent footer', () => {
  it('is hidden until the field is opened', () => {
    const { field } = build();
    const footer = field.el.querySelector('.var-combo-footer');
    expect(footer.hidden).toBe(true);
  });
  it('shows once opened (recents exist) and hides again on blur', () => {
    const { field } = build();
    const footer = field.el.querySelector('.var-combo-footer');
    field.onFocus();
    expect(footer.hidden).toBe(false);
    field.onBlur();
    expect(footer.hidden).toBe(true);
  });
  it('stays hidden when opened with no recents at all', () => {
    const { field } = build({ getRecents: () => [] });
    const footer = field.el.querySelector('.var-combo-footer');
    field.onFocus();
    expect(footer.hidden).toBe(true);
  });
  it('clicking Clear calls onClearRecent, refreshes the list, and re-hides once empty', () => {
    let recents = ['b', 'a'];
    const onClearRecent = vi.fn(() => { recents = []; });
    const { field } = build({ getRecents: () => recents, onClearRecent });
    field.onFocus();
    const footer = field.el.querySelector('.var-combo-footer');
    expect(footer.hidden).toBe(false);
    const btn = footer.querySelector('button.var-combo-clear');
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(onClearRecent).toHaveBeenCalledTimes(1);
    expect(footer.hidden).toBe(true);
  });
  it('omitting onClearRecent is tolerated (no-op on click)', () => {
    const { field } = build({ onClearRecent: undefined });
    field.onFocus();
    const btn = field.el.querySelector('button.var-combo-clear');
    expect(() => btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))).not.toThrow();
  });
  // Phase-7 user feedback: picking an option via mousedown closes the list
  // without firing any of the field's own focus/input/keydown/blur handlers,
  // so the footer used to linger on screen until the next keypress.
  // combobox.js's `onClose` hook fixes this once, shared across every field.
  it('hides immediately after picking an option via mousedown (no lingering "Clear recent" box)', () => {
    const { field } = build();
    field.onFocus();
    const footer = field.el.querySelector('.var-combo-footer');
    expect(footer.hidden).toBe(false);
    const opt = field.el.querySelectorAll('[role="option"]')[0]; // 'b'
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(field.input.getAttribute('aria-expanded')).toBe('false');
    expect(footer.hidden).toBe(true);
  });
  it('Clear also empties the OPEN listbox and updates the aria-live count (review F4: no stale, clickable options)', () => {
    let recents = ['c', 'b', 'a'];
    const onClearRecent = vi.fn(() => { recents = []; });
    const { field } = build({ getRecents: () => recents, onClearRecent });
    field.onFocus();
    expect(field.el.querySelectorAll('[role="option"]')).toHaveLength(3);
    const btn = field.el.querySelector('button.var-combo-clear');
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(field.el.querySelectorAll('[role="option"]')).toHaveLength(0); // gone from the visible list too
    expect(field.el.querySelector('[aria-live="polite"]').textContent).toBe('No matches');
    expect(field.input.getAttribute('aria-expanded')).toBe('true'); // list stayed open, just empty
  });
});
