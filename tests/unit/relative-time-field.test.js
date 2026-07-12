import { describe, it, expect, vi } from 'vitest';
import { buildRelativeTimeField, filterPresets, RELATIVE_TIME_PRESETS } from '../../src/ui/relative-time-field.js';

const NOW = new Date(2026, 6, 11, 9, 23, 45, 0).getTime(); // 2026-07-11 09:23:45 local

function build(overrides = {}) {
  const onValueInput = vi.fn();
  const onCommit = vi.fn();
  const field = buildRelativeTimeField({
    name: 'from', type: 'DateTime', value: '', baseTitle: 'from: DateTime',
    wallNow: () => NOW, onValueInput, onCommit, ...overrides,
  });
  document.body.appendChild(field.el);
  return { field, onValueInput, onCommit };
}

describe('RELATIVE_TIME_PRESETS / filterPresets', () => {
  it('exports the v1 preset set from the spec', () => {
    expect(RELATIVE_TIME_PRESETS.map((p) => p.value)).toEqual([
      '-15m', '-1h', '-6h', '-1d', '-7d', '-1M', 'now/d', '-1d/d', 'now',
    ]);
  });
  it('an empty query returns every preset', () => {
    expect(filterPresets('')).toBe(RELATIVE_TIME_PRESETS);
    expect(filterPresets('   ')).toBe(RELATIVE_TIME_PRESETS);
    expect(filterPresets(undefined)).toBe(RELATIVE_TIME_PRESETS);
  });
  it('filters case-insensitively by value substring', () => {
    expect(filterPresets('-1').map((p) => p.value)).toEqual(['-15m', '-1h', '-1d', '-1M', '-1d/d']);
    expect(filterPresets('NOW').map((p) => p.value)).toEqual(['now/d', 'now']);
  });
  it('filters by label substring too', () => {
    expect(filterPresets('yesterday')).toEqual([{ value: '-1d/d', label: '-1d/d — start of yesterday' }]);
  });
  it('no match returns an empty list', () => {
    expect(filterPresets('zzz-nope')).toEqual([]);
  });
});

describe('buildRelativeTimeField — DOM shape', () => {
  it('builds an accessible combobox input with the expected ARIA wiring', () => {
    const { field } = build();
    const { input } = field;
    expect(input.classList.contains('var-input')).toBe(true);
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-controls')).toBeTruthy();
    expect(input.placeholder).toBe('DateTime');
    expect(input.title).toBe('from: DateTime');
    expect(input.getAttribute('aria-label')).toBe('from');
    expect(field.el.classList.contains('var-combo')).toBe(true);
    expect(field.el.querySelector('[role="listbox"]')).not.toBeNull();
    expect(field.el.querySelector('[aria-live="polite"]')).not.toBeNull();
  });
  it('prefills the input with the stored value', () => {
    const { field } = build({ value: '-1h' });
    expect(field.input.value).toBe('-1h');
  });
  it('sanitizes the variable name into a safe id suffix for the listbox/live-region ids', () => {
    const { field } = build({ name: 'weird name!' });
    expect(field.input.getAttribute('aria-controls')).toMatch(/^var-combo-list-weird_name_$/);
  });
});

describe('buildRelativeTimeField — live preview', () => {
  it('empty value: no preview', () => {
    const { field } = build({ value: '' });
    const preview = field.el.querySelector('.var-combo-preview');
    expect(preview.textContent).toBe('');
  });
  // Review finding #1: the preview must read as a human-readable local
  // calendar instant ("2026-07-11 08:23:45"), never the wire value the field
  // actually transports (epoch seconds for DateTime/DateTime64).
  it('a matched relative expression shows "expr → resolved calendar instant (your time)"', () => {
    const { field } = build({ value: '-1h' });
    const preview = field.el.querySelector('.var-combo-preview');
    expect(preview.textContent).toBe('-1h → 2026-07-11 08:23:45 (your time)');
    expect(preview.textContent).not.toMatch(/\d{9,}/); // never the raw epoch-seconds wire value
    expect(preview.classList.contains('is-error')).toBe(false);
  });
  it('an absolute (unmatched) value shows no preview', () => {
    const { field } = build({ value: '2026-07-11 09:00:00' });
    const preview = field.el.querySelector('.var-combo-preview');
    expect(preview.textContent).toBe('');
  });
  it('a near-miss expression already stored (committed on initial paint) shows the structured error and an error class', () => {
    const { field } = build({ value: 'now/q' });
    const preview = field.el.querySelector('.var-combo-preview');
    expect(preview.textContent).toMatch(/Not a valid relative time expression/);
    expect(preview.classList.contains('is-error')).toBe(true);
  });
  it('the preview updates live as onInput is called (typing)', () => {
    const { field } = build({ value: '' });
    const preview = field.el.querySelector('.var-combo-preview');
    field.input.value = 'now';
    field.onInput();
    expect(preview.textContent).toBe('now → 2026-07-11 09:23:45 (your time)');
  });
  it('correcting an error value back to valid clears the error class', () => {
    const { field } = build({ value: 'now/q' });
    const preview = field.el.querySelector('.var-combo-preview');
    expect(preview.classList.contains('is-error')).toBe(true);
    field.input.value = 'now';
    field.onInput();
    expect(preview.classList.contains('is-error')).toBe(false);
  });

  // Review finding #2: a near-miss (starts like `now`/±digit, doesn't fully
  // parse — an ordinary keystroke on the way to a valid expression) must stay
  // NEUTRAL while the field is still being typed into, exactly like #170's
  // incomplete→invalid timing model for the pipeline's own validation — only
  // hardening into a visible error once the value is committed (blur/Enter/
  // preset pick).
  it('typing a near-miss prefix (onInput) never shows an error — neutral, not blocking', () => {
    const { field } = build({ value: '' });
    const preview = field.el.querySelector('.var-combo-preview');
    for (const prefix of ['-1', 'now-', 'now-1', 'now/']) {
      field.input.value = prefix;
      field.onInput();
      expect(preview.classList.contains('is-error')).toBe(false);
      expect(preview.textContent).toBe('');
    }
  });
  it('blurring a near-miss value hardens the preview into a visible error', () => {
    const { field } = build({ value: '' });
    const preview = field.el.querySelector('.var-combo-preview');
    field.input.value = '-5x';
    field.onInput();
    expect(preview.classList.contains('is-error')).toBe(false); // still neutral while typing
    field.onBlur();
    expect(preview.classList.contains('is-error')).toBe(true);
    expect(preview.textContent).toMatch(/Not a valid relative time expression/);
  });
  it('composing (IME) a near-miss stays neutral; only compositionEnd finalizes it (still typing, not committed)', () => {
    const { field } = build({ value: '' });
    const preview = field.el.querySelector('.var-combo-preview');
    field.onCompositionStart();
    field.input.value = 'now-1x';
    field.onCompositionEnd();
    expect(preview.classList.contains('is-error')).toBe(false);
    expect(preview.textContent).toBe('');
  });
  it('an Enter that the combobox does not consume (no active option) hardens the preview, like blur', () => {
    const { field } = build({ value: '' });
    const preview = field.el.querySelector('.var-combo-preview');
    field.input.value = '-5x';
    field.onInput();
    const e = { key: 'Enter', preventDefault: () => {} };
    const consumed = field.onKeyDown(e);
    expect(consumed).toBe(false);
    expect(preview.classList.contains('is-error')).toBe(true);
  });
});

describe('buildRelativeTimeField — combobox delegation', () => {
  it('onFocus opens the preset list', () => {
    const { field } = build();
    field.onFocus();
    expect(field.input.getAttribute('aria-expanded')).toBe('true');
    expect(field.el.querySelectorAll('[role="option"]')).toHaveLength(RELATIVE_TIME_PRESETS.length);
  });
  it('onBlur closes it', () => {
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
  it('composition start/end delegate and refresh the preview on end', () => {
    const { field } = build({ value: '' });
    const preview = field.el.querySelector('.var-combo-preview');
    field.onFocus();
    field.onCompositionStart();
    field.input.value = 'now';
    field.onInput(); // suppressed while composing — no filtering
    expect(field.el.querySelectorAll('[role="option"]')).toHaveLength(RELATIVE_TIME_PRESETS.length);
    field.onCompositionEnd();
    expect(preview.textContent).toBe('now → 2026-07-11 09:23:45 (your time)');
  });
  it('picking a preset (option mousedown) inserts the expression, updates preview, and fires onValueInput then onCommit', () => {
    const { field, onValueInput, onCommit } = build({ value: '' });
    field.onFocus();
    const opt = field.el.querySelector('[role="option"]'); // first preset: -15m
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(field.input.value).toBe('-15m');
    expect(onValueInput).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const preview = field.el.querySelector('.var-combo-preview');
    expect(preview.textContent).toContain('-15m →');
  });
});

// #171: composing the recents dropdown into this same combobox — presets
// stay exactly as above (previous describe block) when `getRecents` is
// omitted; these cover the combined-list behavior when it's supplied.
describe('buildRelativeTimeField — #171 recents composition', () => {
  it('without getRecents, no footer node exists at all', () => {
    const { field } = build();
    expect(field.el.querySelector('.var-combo-footer')).toBeNull();
  });
  it('with getRecents, the list groups Recent first, then Presets (user decision, phase-7 feedback)', () => {
    const { field } = build({ getRecents: () => ['-3h'] });
    field.onFocus();
    const groups = [...field.el.querySelectorAll('.combo-group')].map((g) => g.textContent);
    expect(groups).toEqual(['Recent', 'Presets']);
    const opts = [...field.el.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(opts[0]).toBe('-3h');
    expect(opts).toHaveLength(RELATIVE_TIME_PRESETS.length + 1);
  });
  it('recents are live-filtered by the typed text, same as presets', () => {
    const getRecents = vi.fn((text) => (text === 'now' ? ['now-custom'] : []));
    const { field } = build({ getRecents });
    field.onFocus();
    field.input.value = 'now';
    field.onInput();
    expect(getRecents).toHaveBeenCalledWith('now');
    const opts = [...field.el.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(opts).toContain('now-custom');
  });
  it('picking a recent commits exactly like a preset (updates value, preview, fires callbacks)', () => {
    const { field, onValueInput, onCommit } = build({ value: '', getRecents: () => ['-3h'] });
    field.onFocus();
    const opts = field.el.querySelectorAll('[role="option"]');
    const recentOpt = opts[0]; // Recent renders first now
    recentOpt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(field.input.value).toBe('-3h');
    expect(onValueInput).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
  it('the footer is hidden until opened, shown when open with recents, hidden again on blur', () => {
    const { field } = build({ getRecents: () => ['-3h'] });
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
    let recents = ['-3h'];
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
    const { field } = build({ getRecents: () => ['-3h'] });
    field.onFocus();
    const btn = field.el.querySelector('button.var-combo-clear');
    expect(() => btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))).not.toThrow();
  });
  it('a recorded expression that IS a preset appears only under Recent (review F5, inverted for the recents-first order)', () => {
    const { field } = build({ getRecents: () => ['-1h', '-3h'] });
    field.onFocus();
    const opts = [...field.el.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(opts.filter((t) => t === '-1h')).toHaveLength(1); // the Recent row only, not also under Presets
    expect(opts[0]).toBe('-1h');
    expect(opts[1]).toBe('-3h');
    expect(opts).toHaveLength(RELATIVE_TIME_PRESETS.length + 1);
  });
  it('Clear removes the recents from the OPEN list too, keeping the presets (review F4)', () => {
    let recents = ['-3h', '-9h'];
    const onClearRecent = vi.fn(() => { recents = []; });
    const { field } = build({ getRecents: () => recents, onClearRecent });
    field.onFocus();
    expect(field.el.querySelectorAll('[role="option"]')).toHaveLength(RELATIVE_TIME_PRESETS.length + 2);
    const btn = field.el.querySelector('button.var-combo-clear');
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(field.el.querySelectorAll('[role="option"]')).toHaveLength(RELATIVE_TIME_PRESETS.length);
    expect([...field.el.querySelectorAll('.combo-group')].map((g) => g.textContent)).toEqual(['Presets']);
  });
  it('ArrowDown/keyboard nav also re-syncs the footer', () => {
    const { field } = build({ getRecents: () => ['-3h'] });
    const footer = field.el.querySelector('.var-combo-footer');
    field.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} });
    expect(footer.hidden).toBe(false);
  });
  it('composition end re-syncs the footer too', () => {
    const { field } = build({ getRecents: () => ['-3h'] });
    const footer = field.el.querySelector('.var-combo-footer');
    field.onFocus();
    field.onCompositionStart();
    field.onCompositionEnd();
    expect(footer.hidden).toBe(false);
  });
  // Phase-7 user feedback: picking an option via mousedown closes the list
  // without firing any of the field's own focus/input/keydown/blur handlers
  // (the input never blurs — see combobox.js's commit()), so the footer used
  // to linger on screen until the next keypress. combobox.js's `onClose` hook
  // fixes this at the shared combo-footer wiring, not per field module.
  it('the footer hides immediately after picking an option via mousedown (no lingering "Clear recent" box)', () => {
    const { field } = build({ getRecents: () => ['-3h'] });
    field.onFocus();
    const footer = field.el.querySelector('.var-combo-footer');
    expect(footer.hidden).toBe(false);
    const opt = field.el.querySelectorAll('[role="option"]')[0];
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(field.input.getAttribute('aria-expanded')).toBe('false'); // value committed, list closed
    expect(footer.hidden).toBe(true); // and the footer hid with it, immediately
  });
});
