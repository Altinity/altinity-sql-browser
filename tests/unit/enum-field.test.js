import { describe, it, expect, vi } from 'vitest';
import { buildEnumField, filterEnumValues, ENUM_DROPDOWN_CAP } from '../../src/ui/enum-field.js';

const VALUES = ['active', 'deleted', 'banned'];

function build(overrides = {}) {
  const onValueInput = vi.fn();
  const onCommit = vi.fn();
  const field = buildEnumField({
    name: 'status', type: "Enum8('active' = 1, 'deleted' = 2, 'banned' = 3)", value: '',
    baseTitle: 'status: Enum8', values: VALUES,
    onValueInput, onCommit, ...overrides,
  });
  document.body.appendChild(field.el);
  return { field, onValueInput, onCommit };
}

describe('filterEnumValues', () => {
  it('an empty query returns every value, uncapped/untruncated', () => {
    expect(filterEnumValues(VALUES, '')).toEqual({ options: VALUES, total: 3, truncated: false });
    expect(filterEnumValues(VALUES, '   ')).toEqual({ options: VALUES, total: 3, truncated: false });
    expect(filterEnumValues(VALUES, undefined)).toEqual({ options: VALUES, total: 3, truncated: false });
  });
  it('filters case-insensitively by substring', () => {
    expect(filterEnumValues(VALUES, 'ED').options).toEqual(['deleted', 'banned']);
  });
  it('no match returns an empty options list', () => {
    expect(filterEnumValues(VALUES, 'zzz-nope')).toEqual({ options: [], total: 0, truncated: false });
  });
  it('filters the COMPLETE list first, THEN caps the rendered options (filter-then-cap, never cap-then-filter)', () => {
    const many = Array.from({ length: ENUM_DROPDOWN_CAP + 50 }, (_, i) => `m${i}`);
    // Every member matches 'm' — total reflects the full match count, but
    // options is capped; a member past the cap (e.g. the last one) is still
    // reachable by narrowing the query further.
    const all = filterEnumValues(many, 'm');
    expect(all.total).toBe(many.length);
    expect(all.options).toHaveLength(ENUM_DROPDOWN_CAP);
    expect(all.truncated).toBe(true);
    const narrowed = filterEnumValues(many, `m${ENUM_DROPDOWN_CAP + 40}`);
    expect(narrowed.options).toEqual([`m${ENUM_DROPDOWN_CAP + 40}`]);
    expect(narrowed.truncated).toBe(false);
  });
  it('exactly ENUM_DROPDOWN_CAP matches is not truncated', () => {
    const exact = Array.from({ length: ENUM_DROPDOWN_CAP }, (_, i) => `m${i}`);
    expect(filterEnumValues(exact, '').truncated).toBe(false);
    expect(filterEnumValues(exact, '').options).toHaveLength(ENUM_DROPDOWN_CAP);
  });
});

describe('buildEnumField — DOM shape', () => {
  it('builds an accessible combobox input with the expected ARIA wiring', () => {
    const { field } = build();
    const { input } = field;
    expect(input.classList.contains('var-input')).toBe(true);
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-controls')).toBeTruthy();
    expect(input.placeholder).toBe("Enum8('active' = 1, 'deleted' = 2, 'banned' = 3)");
    expect(input.title).toBe('status: Enum8');
    expect(input.getAttribute('aria-label')).toBe('status');
    expect(field.el.classList.contains('var-combo')).toBe(true);
    expect(field.el.querySelector('[role="listbox"]')).not.toBeNull();
    expect(field.el.querySelector('[aria-live="polite"]')).not.toBeNull();
  });
  it('prefills the input with the stored value', () => {
    const { field } = build({ value: 'active' });
    expect(field.input.value).toBe('active');
  });
  it('sanitizes the variable name into a safe id suffix for the listbox id', () => {
    const { field } = build({ name: 'weird name!' });
    expect(field.input.getAttribute('aria-controls')).toMatch(/^var-enum-list-weird_name_$/);
  });
});

describe('buildEnumField — combobox delegation', () => {
  it('onFocus opens the value list, showing every member', () => {
    const { field } = build();
    field.onFocus();
    expect(field.input.getAttribute('aria-expanded')).toBe('true');
    const opts = [...field.el.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(opts).toEqual(VALUES);
  });
  it('onBlur closes it and clears any narrowing hint', () => {
    const { field } = build();
    field.onFocus();
    field.onBlur();
    expect(field.input.getAttribute('aria-expanded')).toBe('false');
  });
  it('onKeyDown delegates to the combobox (Arrow opens + navigates)', () => {
    const { field } = build();
    const e = { key: 'ArrowDown', preventDefault: vi.fn() };
    expect(field.onKeyDown(e)).toBe(true);
    expect(field.input.getAttribute('aria-expanded')).toBe('true');
  });
  it('composition start/end delegate (suppressed mid-composition, refreshed on end)', () => {
    const { field } = build();
    field.onFocus();
    field.onCompositionStart();
    field.input.value = 'ban';
    field.onInput(); // suppressed while composing — no filtering yet
    expect(field.el.querySelectorAll('[role="option"]')).toHaveLength(VALUES.length);
    field.onCompositionEnd();
    const opts = [...field.el.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(opts).toEqual(['banned']);
  });
  it('typing filters the option list live', () => {
    const { field } = build();
    field.onFocus();
    field.input.value = 'de';
    field.onInput();
    const opts = [...field.el.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(opts).toEqual(['deleted']);
  });
  it('picking a value (option mousedown) inserts it and fires onValueInput then onCommit', () => {
    const { field, onValueInput, onCommit } = build();
    field.onFocus();
    const opt = field.el.querySelector('[role="option"]'); // 'active'
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(field.input.value).toBe('active');
    expect(onValueInput).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});

describe('buildEnumField — large-enum "type to narrow" hint', () => {
  const many = Array.from({ length: ENUM_DROPDOWN_CAP + 10 }, (_, i) => `m${i}`);
  it('shows the hint when the current query truncates the list', () => {
    const { field } = build({ values: many, type: 'Enum16(...)' });
    field.onFocus();
    const hint = field.el.querySelector('.var-combo-hint');
    expect(hint.textContent).toMatch(/Showing \d+ of \d+ — type to narrow/);
    expect(field.el.querySelectorAll('[role="option"]')).toHaveLength(ENUM_DROPDOWN_CAP);
  });
  it('no hint once narrowed under the cap', () => {
    const { field } = build({ values: many, type: 'Enum16(...)' });
    field.onFocus();
    field.input.value = `m${ENUM_DROPDOWN_CAP + 5}`;
    field.onInput();
    const hint = field.el.querySelector('.var-combo-hint');
    expect(hint.textContent).toBe('');
  });
  it('the hint clears on blur', () => {
    const { field } = build({ values: many, type: 'Enum16(...)' });
    field.onFocus();
    const hint = field.el.querySelector('.var-combo-hint');
    expect(hint.textContent).not.toBe('');
    field.onBlur();
    expect(hint.textContent).toBe('');
  });
});

// #171 recents composition — enum values are the primary (unlabeled) group,
// recents follow after a "Recent" group header, same pattern as
// relative-time-field.js's presets+recents.
describe('buildEnumField — #171 recents composition', () => {
  it('without getRecents, no footer node exists at all', () => {
    const { field } = build();
    expect(field.el.querySelector('.var-combo-footer')).toBeNull();
  });
  it('with getRecents, enum values render first under a "Values" header, then a Recent group (same paired-labeling rule as relative-time-field.js)', () => {
    const { field } = build({ getRecents: () => ['legacy-status'] });
    field.onFocus();
    const groups = [...field.el.querySelectorAll('.combo-group')].map((g) => g.textContent);
    expect(groups).toEqual(['Values', 'Recent']);
    const opts = [...field.el.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(opts).toEqual([...VALUES, 'legacy-status']);
  });
  it('recents are live-filtered by the typed text, same as enum values', () => {
    const getRecents = vi.fn((text) => (text === 'leg' ? ['legacy-status'] : []));
    const { field } = build({ getRecents });
    field.onFocus();
    field.input.value = 'leg';
    field.onInput();
    expect(getRecents).toHaveBeenCalledWith('leg');
    const opts = [...field.el.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(opts).toEqual(['legacy-status']);
  });
  it('picking a recent commits exactly like an enum value', () => {
    const { field, onValueInput, onCommit } = build({ getRecents: () => ['legacy-status'] });
    field.onFocus();
    const opts = field.el.querySelectorAll('[role="option"]');
    const recentOpt = opts[opts.length - 1];
    recentOpt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(field.input.value).toBe('legacy-status');
    expect(onValueInput).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
  it('the footer is hidden until opened, shown when open with recents, hidden again on blur', () => {
    const { field } = build({ getRecents: () => ['legacy-status'] });
    const footer = field.el.querySelector('.var-combo-footer');
    expect(footer.hidden).toBe(true);
    field.onFocus();
    expect(footer.hidden).toBe(false);
    field.onBlur();
    expect(footer.hidden).toBe(true);
  });
  it('the footer stays hidden when open with no recents at all', () => {
    const { field } = build({ getRecents: () => [] });
    field.onFocus();
    expect(field.el.querySelector('.var-combo-footer').hidden).toBe(true);
  });
  it('clicking Clear calls onClearRecent and re-syncs the footer', () => {
    let recents = ['legacy-status'];
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
    const { field } = build({ getRecents: () => ['legacy-status'] });
    field.onFocus();
    const btn = field.el.querySelector('button.var-combo-clear');
    expect(() => btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))).not.toThrow();
  });
  it('ArrowDown/keyboard nav also re-syncs the footer', () => {
    const { field } = build({ getRecents: () => ['legacy-status'] });
    const footer = field.el.querySelector('.var-combo-footer');
    field.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} });
    expect(footer.hidden).toBe(false);
  });
  it('composition end re-syncs the footer too', () => {
    const { field } = build({ getRecents: () => ['legacy-status'] });
    const footer = field.el.querySelector('.var-combo-footer');
    field.onFocus();
    field.onCompositionStart();
    field.onCompositionEnd();
    expect(footer.hidden).toBe(false);
  });
  it('a recent that duplicates a rendered member appears only under Values (review F5)', () => {
    const { field } = build({ getRecents: () => ['active', 'legacy-status'] });
    field.onFocus();
    const opts = [...field.el.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(opts).toEqual([...VALUES, 'legacy-status']); // 'active' listed once, as a member
  });
  // Phase-7 user feedback: picking an option via mousedown closes the list
  // without firing any of the field's own focus/input/keydown/blur handlers,
  // so the footer used to linger on screen until the next keypress.
  // combobox.js's `onClose` hook fixes this once, shared across every field.
  it('the footer hides immediately after picking an option via mousedown (no lingering "Clear recent" box)', () => {
    const { field } = build({ getRecents: () => ['legacy-status'] });
    field.onFocus();
    const footer = field.el.querySelector('.var-combo-footer');
    expect(footer.hidden).toBe(false);
    const opt = field.el.querySelectorAll('[role="option"]')[0]; // 'active'
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(field.input.getAttribute('aria-expanded')).toBe('false');
    expect(footer.hidden).toBe(true);
  });
  it('Clear removes the recents from the OPEN list too, keeping the members (review F4)', () => {
    let recents = ['legacy-status', 'other-old'];
    const onClearRecent = vi.fn(() => { recents = []; });
    const { field } = build({ getRecents: () => recents, onClearRecent });
    field.onFocus();
    expect(field.el.querySelectorAll('[role="option"]')).toHaveLength(VALUES.length + 2);
    const btn = field.el.querySelector('button.var-combo-clear');
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const opts = [...field.el.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(opts).toEqual(VALUES); // recents gone from the visible list; members intact
    expect(field.el.querySelector('[aria-live="polite"]').textContent).toBe('3 options');
  });
});
