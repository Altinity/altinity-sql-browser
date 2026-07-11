import { describe, it, expect, vi } from 'vitest';
import { createCombobox } from '../../src/ui/combobox.js';

function makeParts(inputProps = {}) {
  const input = document.createElement('input');
  for (const [k, v] of Object.entries(inputProps)) input.setAttribute(k, v);
  const listEl = document.createElement('ul');
  const liveEl = document.createElement('div');
  document.body.append(input, listEl, liveEl);
  return { input, listEl, liveEl };
}

const PRESETS = [
  { value: '-1h', label: 'Last hour' },
  { value: '-1d', label: 'Last day' },
  { value: 'now', label: 'Now' },
];
const GROUPED = [
  { value: '-1h', label: 'Last hour', group: 'presets' },
  { value: '-1d', label: 'Last day', group: 'presets' },
  { value: 'x', label: 'Recent x', group: 'recents' },
];

function build(options = PRESETS, inputProps) {
  const { input, listEl, liveEl } = makeParts(inputProps);
  const onCommit = vi.fn();
  const getOptions = vi.fn((text) => options.filter((o) => !text || o.value.includes(text) || o.label.includes(text)));
  const combo = createCombobox({ input, listEl, liveEl, getOptions, onCommit });
  return { input, listEl, liveEl, combo, onCommit, getOptions };
}

const key = (k) => ({ key: k, preventDefault: vi.fn() });

describe('createCombobox — open/close + ARIA', () => {
  it('onFocus opens the list, populates options, sets aria-expanded', () => {
    const { input, listEl, combo } = build();
    expect(combo.isOpen()).toBe(false);
    combo.onFocus();
    expect(combo.isOpen()).toBe(true);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(listEl.hidden).toBe(false);
    expect(listEl.querySelectorAll('[role="option"]')).toHaveLength(3);
  });
  it('onBlur closes the list', () => {
    const { input, combo } = build();
    combo.onFocus();
    combo.onBlur();
    expect(combo.isOpen()).toBe(false);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  });
  it('onBlur while already closed is a no-op', () => {
    const { combo } = build();
    combo.onBlur();
    expect(combo.isOpen()).toBe(false);
  });
  it('the live region announces the option count, or "No matches"', () => {
    const { input, liveEl, combo } = build();
    combo.onFocus();
    expect(liveEl.textContent).toBe('3 options');
    input.value = 'zzz-no-match';
    combo.onInput();
    expect(liveEl.textContent).toBe('No matches');
  });
  it('a single option is announced in the singular', () => {
    const { input, liveEl, combo } = build([{ value: 'now', label: 'Now' }]);
    combo.onFocus();
    input.value = 'now';
    combo.onInput();
    expect(liveEl.textContent).toBe('1 option');
  });
  it('option ids derive from the input id when set, else fall back to a random suffix', () => {
    const withId = build(PRESETS, { id: 'var-from' });
    withId.combo.onFocus();
    expect(withId.listEl.querySelector('[role="option"]').id).toMatch(/^var-from-opt-0$/);
    const withoutId = build(PRESETS);
    withoutId.combo.onFocus();
    expect(withoutId.listEl.querySelector('[role="option"]').id).toMatch(/^varcombo-opt-0-/);
  });
  it('group headers render once per contiguous run, ungrouped options get none', () => {
    const { listEl, combo } = build(GROUPED);
    combo.onFocus();
    const groups = [...listEl.querySelectorAll('.combo-group')].map((g) => g.textContent);
    expect(groups).toEqual(['presets', 'recents']);
    const noGroup = build(PRESETS);
    noGroup.combo.onFocus();
    expect(noGroup.listEl.querySelectorAll('.combo-group')).toHaveLength(0);
  });
  it('a run dropping back to no group after a named one still gets a (blank) separator', () => {
    const mixed = [
      { value: 'a', label: 'A', group: 'top' },
      { value: 'b', label: 'B' }, // ungrouped, right after a named group
    ];
    const { listEl, combo } = build(mixed);
    combo.onFocus();
    const groups = [...listEl.querySelectorAll('.combo-group')].map((g) => g.textContent);
    expect(groups).toEqual(['top', '']);
  });
  it('a getOptions that returns a falsy value (not an array) is tolerated as "no options"', () => {
    const { input, listEl, liveEl } = makeParts();
    const c = createCombobox({ input, listEl, liveEl, getOptions: () => undefined, onCommit: vi.fn() });
    c.onFocus();
    expect(listEl.querySelectorAll('[role="option"]')).toHaveLength(0);
    input.value = 'x';
    c.onInput(); // exercises the same fallback inside refresh()
    expect(listEl.querySelectorAll('[role="option"]')).toHaveLength(0);
  });
});

describe('createCombobox — typing filters, IME-safe', () => {
  it('onInput while open re-filters and resets the active option', () => {
    const { input, listEl, combo } = build();
    combo.onFocus();
    combo.onKeyDown(key('ArrowDown')); // activeIndex -> 0
    input.value = '-1';
    combo.onInput();
    expect(listEl.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(input.hasAttribute('aria-activedescendant')).toBe(false); // reset to -1
  });
  it('onInput while closed opens the list', () => {
    const { input, combo } = build();
    input.value = '-1';
    combo.onInput();
    expect(combo.isOpen()).toBe(true);
  });
  it('composition: keystrokes during IME composition never filter or navigate', () => {
    const { input, listEl, combo } = build();
    combo.onFocus();
    combo.onCompositionStart();
    input.value = 'zzz-no-match';
    combo.onInput(); // suppressed — composing
    expect(listEl.querySelectorAll('[role="option"]')).toHaveLength(3);
    expect(combo.onKeyDown(key('ArrowDown'))).toBe(false); // suppressed — composing
    combo.onCompositionEnd(); // filtering applies now
    expect(listEl.querySelectorAll('[role="option"]')).toHaveLength(0);
  });
  it('compositionend while closed opens the list', () => {
    const { combo } = build();
    combo.onCompositionStart();
    combo.onCompositionEnd();
    expect(combo.isOpen()).toBe(true);
  });
});

describe('createCombobox — keyboard nav', () => {
  it('ArrowDown/ArrowUp open the list when closed', () => {
    const a = build();
    expect(a.combo.onKeyDown(key('ArrowDown'))).toBe(true);
    expect(a.combo.isOpen()).toBe(true);
    const b = build();
    expect(b.combo.onKeyDown(key('ArrowUp'))).toBe(true);
    expect(b.combo.isOpen()).toBe(true);
  });
  it('ArrowDown moves the active option forward and clamps at the last', () => {
    const { input, combo } = build();
    combo.onFocus();
    combo.onKeyDown(key('ArrowDown'));
    expect(input.getAttribute('aria-activedescendant')).toContain('opt-0');
    combo.onKeyDown(key('ArrowDown'));
    expect(input.getAttribute('aria-activedescendant')).toContain('opt-1');
    combo.onKeyDown(key('ArrowDown'));
    combo.onKeyDown(key('ArrowDown')); // clamp — stays at the last (index 2)
    expect(input.getAttribute('aria-activedescendant')).toContain('opt-2');
  });
  it('ArrowUp moves the active option back and clamps at 0', () => {
    const { input, combo } = build();
    combo.onFocus();
    combo.onKeyDown(key('ArrowDown'));
    combo.onKeyDown(key('ArrowDown')); // index 1
    combo.onKeyDown(key('ArrowUp'));
    expect(input.getAttribute('aria-activedescendant')).toContain('opt-0');
    combo.onKeyDown(key('ArrowUp')); // clamp — stays at 0
    expect(input.getAttribute('aria-activedescendant')).toContain('opt-0');
  });
  it('Home/End jump to the first/last option while open', () => {
    const { input, combo } = build();
    combo.onFocus();
    combo.onKeyDown(key('End'));
    expect(input.getAttribute('aria-activedescendant')).toContain('opt-2');
    combo.onKeyDown(key('Home'));
    expect(input.getAttribute('aria-activedescendant')).toContain('opt-0');
  });
  it('Home/End are no-ops while closed', () => {
    const { combo } = build();
    expect(combo.onKeyDown(key('Home'))).toBe(false);
    expect(combo.onKeyDown(key('End'))).toBe(false);
  });
  it('Home/End are no-ops when open with no options', () => {
    const { input, combo } = build();
    combo.onFocus();
    input.value = 'zzz-no-match';
    combo.onInput();
    expect(combo.onKeyDown(key('Home'))).toBe(false);
    expect(combo.onKeyDown(key('End'))).toBe(false);
  });
  it('Enter with no active option is NOT consumed — falls through to the caller, but closes the list', () => {
    const { combo } = build();
    combo.onFocus();
    const e = key('Enter');
    expect(combo.onKeyDown(e)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(combo.isOpen()).toBe(false);
  });
  it('Enter with an active option commits it, is consumed, and closes the list', () => {
    const { input, combo, onCommit } = build();
    combo.onFocus();
    combo.onKeyDown(key('ArrowDown'));
    const e = key('Enter');
    expect(combo.onKeyDown(e)).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(input.value).toBe('-1h');
    expect(onCommit).toHaveBeenCalledWith(PRESETS[0]);
    expect(combo.isOpen()).toBe(false);
  });
  it('commit while the input is already focused does not re-dispatch a focus event (regression: re-opening the just-closed list)', () => {
    const { input, combo } = build();
    input.focus();
    combo.onFocus();
    combo.onKeyDown(key('ArrowDown'));
    const focusSpy = vi.fn();
    input.addEventListener('focus', focusSpy);
    combo.onKeyDown(key('Enter'));
    expect(focusSpy).not.toHaveBeenCalled();
    expect(combo.isOpen()).toBe(false); // stays closed — no reopen from a spurious refocus
  });
  it('commit while focus is elsewhere DOES refocus the input (option mousedown, e.g.)', () => {
    const { input, listEl, combo } = build();
    combo.onFocus();
    input.blur();
    expect(document.activeElement).not.toBe(input);
    const opt = listEl.querySelectorAll('[role="option"]')[0];
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(input);
  });
  it('Escape closes the (already-unmodified) list and is consumed only while open', () => {
    const { combo } = build();
    expect(combo.onKeyDown(key('Escape'))).toBe(false); // closed already — nothing to do
    combo.onFocus();
    const e = key('Escape');
    expect(combo.onKeyDown(e)).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(combo.isOpen()).toBe(false);
  });
  it('an unrelated key is not consumed', () => {
    const { combo } = build();
    combo.onFocus();
    expect(combo.onKeyDown(key('a'))).toBe(false);
  });
  it('any key during IME composition is never consumed', () => {
    const { combo } = build();
    combo.onFocus();
    combo.onCompositionStart();
    expect(combo.onKeyDown(key('Enter'))).toBe(false);
  });
});

describe('createCombobox — pointer selection', () => {
  it('option mousedown commits before any blur (preventDefault keeps focus on the input)', () => {
    const { input, listEl, combo, onCommit } = build();
    combo.onFocus();
    const opt = listEl.querySelectorAll('[role="option"]')[1];
    const evt = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const prevented = !opt.dispatchEvent(evt);
    expect(prevented).toBe(true); // preventDefault() was called
    expect(input.value).toBe('-1d');
    expect(onCommit).toHaveBeenCalledWith(PRESETS[1]);
    expect(combo.isOpen()).toBe(false);
  });
});

describe('createCombobox — close()', () => {
  it('is an alias callers can use directly (e.g. on outside interaction)', () => {
    const { combo } = build();
    combo.onFocus();
    combo.close();
    expect(combo.isOpen()).toBe(false);
  });
});
