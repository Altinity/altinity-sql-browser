import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildMultiSelectField } from '../../src/ui/multi-select-field.js';
import type { MultiSelectFieldOpts, MultiSelectOption } from '../../src/ui/multi-select-field.js';

afterEach(() => document.body.replaceChildren());

const click = (el: Element): boolean => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (target: EventTarget, k: string): boolean =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const type = (input: HTMLInputElement, text: string): void => {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const setChecked = (cb: HTMLInputElement, val: boolean): void => {
  cb.checked = val;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
};

const OPTIONS: MultiSelectOption[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
  { value: 'c', label: 'Charlie' },
];

function baseOpts(overrides: Partial<MultiSelectFieldOpts> = {}): MultiSelectFieldOpts {
  return {
    name: 'carrier',
    label: 'Carrier',
    value: [],
    active: false,
    options: OPTIONS,
    onApply: vi.fn(),
    onFallbackCommit: vi.fn(),
    ...overrides,
  };
}

const triggerEl = (el: HTMLElement): HTMLButtonElement => el.querySelector('.ms-trigger') as HTMLButtonElement;
const errorInputEl = (el: HTMLElement): HTMLInputElement | null => el.querySelector('input.is-error');
const popover = (): HTMLElement | null => document.body.querySelector('.ms-popover');
const cancelBtn = (): HTMLElement => document.body.querySelector('.ms-btn:not(.ms-btn-clear):not(.ms-btn-primary)')!;
const applyBtn = (): HTMLElement => document.body.querySelector('.ms-btn-primary')!;
const clearBtn = (): HTMLElement => document.body.querySelector('.ms-btn-clear')!;
const searchInput = (): HTMLInputElement => document.body.querySelector('.ms-search') as HTMLInputElement;
const selectAllCb = (): HTMLInputElement => document.body.querySelector('.ms-select-all-cb') as HTMLInputElement;
const optionCbs = (): HTMLInputElement[] =>
  [...document.body.querySelectorAll('.ms-option input[type="checkbox"]')] as HTMLInputElement[];
const optionRows = (): HTMLElement[] => [...document.body.querySelectorAll('.ms-option')] as HTMLElement[];
const liveText = (): string | null => document.body.querySelector('.ms-live')!.textContent;

describe('buildMultiSelectField — trigger text + disabled/class states', () => {
  it('inactive optional shows "All"; inactive required shows "Not set"', () => {
    const h1 = buildMultiSelectField(baseOpts());
    expect(triggerEl(h1.el).textContent).toBe('All');
    const h2 = buildMultiSelectField(baseOpts({ required: true }));
    expect(triggerEl(h2.el).textContent).toBe('Not set');
  });

  it('active but empty selection still reads as the inactive text', () => {
    const handle = buildMultiSelectField(baseOpts({ active: true, value: [] }));
    expect(triggerEl(handle.el).textContent).toBe('All');
  });

  it('exactly one selected value shows its option label', () => {
    const handle = buildMultiSelectField(baseOpts({ value: ['b'], active: true }));
    expect(triggerEl(handle.el).textContent).toBe('Bravo');
  });

  it('exactly one selected value absent from options falls back to the raw value', () => {
    const handle = buildMultiSelectField(baseOpts({ value: ['zz'], active: true }));
    expect(triggerEl(handle.el).textContent).toBe('zz');
  });

  it('an empty-string option value renders its label, not the fallback raw text', () => {
    const handle = buildMultiSelectField(baseOpts({
      value: [''], active: true, options: [{ value: '', label: '(blank)' }, ...OPTIONS],
    }));
    expect(triggerEl(handle.el).textContent).toBe('(blank)');
  });

  it('more than one selected value shows "N selected"', () => {
    const handle = buildMultiSelectField(baseOpts({ value: ['a', 'b', 'c'], active: true }));
    expect(triggerEl(handle.el).textContent).toBe('3 selected');
  });

  it('status idle reads as loading and disables the trigger', () => {
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true, status: { status: 'idle' } }));
    const t = triggerEl(handle.el);
    expect(t.textContent).toBe('Loading options…');
    expect(t.disabled).toBe(true);
    expect(t.classList.contains('is-stale')).toBe(true);
  });

  it('status loading reads as loading and disables the trigger', () => {
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true, status: { status: 'loading' } }));
    expect(triggerEl(handle.el).textContent).toBe('Loading options…');
    expect(triggerEl(handle.el).disabled).toBe(true);
  });

  it('a bare stale:true flag (status ready) also reads as loading and disables the trigger', () => {
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true, status: { stale: true } }));
    const t = triggerEl(handle.el);
    expect(t.textContent).toBe('Loading options…');
    expect(t.disabled).toBe(true);
  });

  it('status waiting shows the waiting note and disables the trigger', () => {
    const handle = buildMultiSelectField(baseOpts({
      value: ['a'], active: true, status: { status: 'waiting', waitingFor: ['x', 'y'] },
    }));
    const t = triggerEl(handle.el);
    expect(t.textContent).toBe('Waiting for: x, y');
    expect(t.disabled).toBe(true);
    expect(t.classList.contains('is-waiting')).toBe(true);
    expect(handle.el.classList.contains('is-waiting')).toBe(true);
  });

  it('waiting with no waitingFor list still renders (empty join)', () => {
    const handle = buildMultiSelectField(baseOpts({ status: { status: 'waiting' } }));
    expect(triggerEl(handle.el).textContent).toBe('Waiting for: ');
  });

  it('a ready status with no stale flag is enabled with no status class', () => {
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true }));
    const t = triggerEl(handle.el);
    expect(t.disabled).toBe(false);
    expect(t.classList.contains('is-stale')).toBe(false);
    expect(t.classList.contains('is-waiting')).toBe(false);
    expect(handle.el.classList.contains('is-stale')).toBe(false);
  });

  it('a clicked-but-disabled trigger does not open the popover', () => {
    const handle = buildMultiSelectField(baseOpts({ status: { status: 'loading' } }));
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    expect(popover()).toBeNull();
    expect(handle.isOpen()).toBe(false);
  });

  it('repeating an unchanged status does not rebuild the control', () => {
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true }));
    const before = triggerEl(handle.el);
    handle.updateStatus({});
    expect(triggerEl(handle.el)).toBe(before); // same node, no replaceChildren
  });
});

describe('buildMultiSelectField — accessibility', () => {
  it('aria-haspopup is dialog and aria-expanded toggles open/close', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    const t = triggerEl(handle.el);
    expect(t.getAttribute('aria-haspopup')).toBe('dialog');
    expect(t.getAttribute('aria-expanded')).toBe('false');
    click(t);
    expect(t.getAttribute('aria-expanded')).toBe('true');
    click(cancelBtn());
    expect(t.getAttribute('aria-expanded')).toBe('false');
  });

  it('trigger aria-label names the filter and the selected count', () => {
    const handle = buildMultiSelectField(baseOpts({ value: ['a', 'b', 'c'], active: true }));
    expect(triggerEl(handle.el).getAttribute('aria-label')).toBe('Carrier filter, 3 selected');
  });

  it('the dialog is named for the filter', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    expect(popover()!.getAttribute('role')).toBe('dialog');
    expect(popover()!.getAttribute('aria-label')).toBe('Carrier options');
  });

  it('the search input is labeled for the filter', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    expect(searchInput().getAttribute('aria-label')).toBe('Search Carrier options');
  });

  it('the live region announces the filtered option count on search', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    expect(liveText()).toBe('3 of 3 options');
    type(searchInput(), 'al');
    expect(liveText()).toBe('1 of 3 options');
  });

  it('select-visible label names the scope and the action it will perform next', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    expect(selectAllCb().getAttribute('aria-label')).toBe('Select all 3 visible options');
    setChecked(selectAllCb(), true);
    expect(selectAllCb().getAttribute('aria-label')).toBe('Clear all 3 visible options');
  });

  it('focus moves into the dialog (the search input) on open', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    expect(document.activeElement).toBe(searchInput());
  });
});

describe('buildMultiSelectField — draft isolation across every dismissal path', () => {
  const dismissals: Array<[string, () => void]> = [
    ['Cancel', () => click(cancelBtn())],
    ['Escape', () => key(popover()!, 'Escape')],
    ['outside click', () => {
      const overlay = document.body.querySelector('.ms-overlay')!;
      overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }],
  ];

  for (const [name, dismiss] of dismissals) {
    it(`${name} discards the draft: no onApply, committed value untouched, focus returns to the trigger`, () => {
      const onApply = vi.fn();
      const value = ['a'];
      const handle = buildMultiSelectField(baseOpts({ value, active: true, onApply }));
      document.body.appendChild(handle.el);
      const t = triggerEl(handle.el);
      click(t);
      setChecked(optionCbs()[1], true); // mutate the draft only (select Bravo too)
      dismiss();
      expect(onApply).not.toHaveBeenCalled();
      expect(value).toEqual(['a']); // opts.value never mutated
      expect(handle.isOpen()).toBe(false);
      expect(popover()).toBeNull();
      expect(document.activeElement).toBe(t);
    });
  }

  it('a non-Escape key inside the dialog does not dismiss it', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    key(popover()!, 'a');
    expect(handle.isOpen()).toBe(true);
  });

  it('clicking the trigger while already open does not stack a second popover', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    const t = triggerEl(handle.el);
    click(t);
    click(t);
    expect(document.body.querySelectorAll('.ms-popover').length).toBe(1);
  });

  it('dispose while open is a Cancel: no callbacks, popover removed, click listener detached', () => {
    const onApply = vi.fn();
    const value = ['a'];
    const handle = buildMultiSelectField(baseOpts({ value, active: true, onApply }));
    document.body.appendChild(handle.el);
    const t = triggerEl(handle.el);
    click(t);
    setChecked(optionCbs()[1], true);
    handle.dispose();
    expect(onApply).not.toHaveBeenCalled();
    expect(value).toEqual(['a']);
    expect(handle.isOpen()).toBe(false);
    expect(popover()).toBeNull();
    click(t); // listener removed — this must do nothing
    expect(popover()).toBeNull();
  });

  it('dispose while already closed is a no-op that does not throw, and still detaches the trigger listener', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    const t = triggerEl(handle.el);
    expect(() => handle.dispose()).not.toThrow();
    click(t);
    expect(popover()).toBeNull();
  });
});

describe('buildMultiSelectField — Apply semantics', () => {
  it('Apply with no changes closes silently, without calling onApply', () => {
    const onApply = vi.fn();
    const handle = buildMultiSelectField(baseOpts({ value: ['a', 'b'], active: true, onApply }));
    document.body.appendChild(handle.el);
    const t = triggerEl(handle.el);
    click(t);
    click(applyBtn());
    expect(onApply).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(false);
    expect(document.activeElement).toBe(t);
  });

  it('duplicate values in the committed selection do not defeat the no-op Apply check', () => {
    const onApply = vi.fn();
    const handle = buildMultiSelectField(baseOpts({ value: ['a', 'a', 'b'], active: true, onApply }));
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    click(applyBtn());
    expect(onApply).not.toHaveBeenCalled();
  });

  it('Apply commits the canonicalized draft (ordered by option order) when it differs from committed', () => {
    const onApply = vi.fn();
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true, onApply }));
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    setChecked(optionCbs()[1], true); // add Bravo
    click(applyBtn());
    expect(onApply).toHaveBeenCalledWith(['a', 'b'], true);
  });

  it('Clear then Apply commits ([], false) even though the draft started non-empty', () => {
    const onApply = vi.fn();
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true, onApply }));
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    click(clearBtn());
    click(applyBtn());
    expect(onApply).toHaveBeenCalledWith([], false);
  });

  it('unchecking a previously-selected row removes it from the committed draft', () => {
    const onApply = vi.fn();
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true, onApply }));
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    expect(optionCbs()[0].checked).toBe(true); // seeded from the committed value
    setChecked(optionCbs()[0], false);
    click(applyBtn());
    expect(onApply).toHaveBeenCalledWith([], false);
  });

  it('a dormant committed value (absent from options) is dropped by Apply, counting as a change with no edits', () => {
    const onApply = vi.fn();
    const handle = buildMultiSelectField(baseOpts({ value: ['dormant'], active: true, onApply }));
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    click(applyBtn()); // no edits at all — the active flag alone flips
    expect(onApply).toHaveBeenCalledWith([], false);
  });

  it('an already-empty, inactive field is a true no-op on Apply', () => {
    const onApply = vi.fn();
    const handle = buildMultiSelectField(baseOpts({ value: [], active: false, onApply }));
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    click(applyBtn());
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe('buildMultiSelectField — search filtering + select-visible tri-state', () => {
  it('filters case-insensitively over label AND value', () => {
    const handle = buildMultiSelectField(baseOpts({
      options: [{ value: 'a', label: 'Alpha' }, { value: 'zz', label: 'Nothing' }, { value: 'b', label: 'Bravo' }],
    }));
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    type(searchInput(), 'ZZ'); // matches "Nothing" by VALUE, not label
    const visible = optionRows().filter((r) => !r.hidden).map((r) => r.querySelector('.ms-option-label')!.textContent);
    expect(visible).toEqual(['Nothing']);
  });

  it('select-visible activates from unchecked, and clears from fully-checked', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    expect(selectAllCb().indeterminate).toBe(false);
    setChecked(selectAllCb(), true);
    expect(optionCbs().every((cb) => cb.checked)).toBe(true);
    setChecked(selectAllCb(), false);
    expect(optionCbs().every((cb) => !cb.checked)).toBe(true);
  });

  it('a partial selection renders the select-visible checkbox indeterminate', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    setChecked(optionCbs()[0], true);
    expect(selectAllCb().checked).toBe(false);
    expect(selectAllCb().indeterminate).toBe(true);
  });

  it('a value hidden by search is untouched by select-visible or Clear', () => {
    const onApply = vi.fn();
    const handle = buildMultiSelectField(baseOpts({ onApply }));
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    // Select Bravo + Charlie, then narrow the search to only Alpha.
    setChecked(optionCbs()[1], true);
    setChecked(optionCbs()[2], true);
    type(searchInput(), 'al');
    expect(selectAllCb().getAttribute('aria-label')).toBe('Select all 1 visible options');
    setChecked(selectAllCb(), true); // selects only the visible row (Alpha)
    type(searchInput(), ''); // reveal everything again
    expect(optionCbs().every((cb) => cb.checked)).toBe(true); // a, b, c all still selected
    click(applyBtn());
    expect(onApply).toHaveBeenCalledWith(['a', 'b', 'c'], true);
  });
});

describe('buildMultiSelectField — error-mode fallback (#360 policy)', () => {
  it('constructing directly with an error status renders the enabled fallback input showing the committed value', () => {
    const handle = buildMultiSelectField(baseOpts({ value: ['a', 'b'], active: true, status: { status: 'source-error' } }));
    document.body.appendChild(handle.el);
    const input = errorInputEl(handle.el)!;
    expect(input).not.toBeNull();
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('a, b');
    expect(triggerEl(handle.el)).toBeNull();
  });

  it('missing-helper also renders the fallback input', () => {
    const handle = buildMultiSelectField(baseOpts({ status: { status: 'missing-helper' } }));
    document.body.appendChild(handle.el);
    expect(errorInputEl(handle.el)).not.toBeNull();
  });

  it('Enter commits the fallback value regardless of whether it was edited', () => {
    const onFallbackCommit = vi.fn();
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true, status: { status: 'helper-error' }, onFallbackCommit }));
    document.body.appendChild(handle.el);
    key(errorInputEl(handle.el)!, 'Enter');
    expect(onFallbackCommit).toHaveBeenCalledWith('a', true);
  });

  it('a non-Enter key in the fallback input does not commit', () => {
    const onFallbackCommit = vi.fn();
    const handle = buildMultiSelectField(baseOpts({ status: { status: 'source-error' }, onFallbackCommit }));
    document.body.appendChild(handle.el);
    key(errorInputEl(handle.el)!, 'a');
    expect(onFallbackCommit).not.toHaveBeenCalled();
  });

  it('blur with no edit does not commit; blur after an edit does', () => {
    const onFallbackCommit = vi.fn();
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true, status: { status: 'source-error' }, onFallbackCommit }));
    document.body.appendChild(handle.el);
    const input = errorInputEl(handle.el)!;
    input.dispatchEvent(new Event('blur'));
    expect(onFallbackCommit).not.toHaveBeenCalled();
    type(input, 'x, y');
    input.dispatchEvent(new Event('blur'));
    expect(onFallbackCommit).toHaveBeenCalledWith('x, y', true);
  });

  it('an Enter commit resets the edited flag so an immediate blur does not double-commit', () => {
    const onFallbackCommit = vi.fn();
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true, status: { status: 'source-error' }, onFallbackCommit }));
    document.body.appendChild(handle.el);
    const input = errorInputEl(handle.el)!;
    type(input, 'x');
    key(input, 'Enter');
    input.dispatchEvent(new Event('blur'));
    expect(onFallbackCommit).toHaveBeenCalledTimes(1);
  });

  it('a blank fallback commit reports active:false', () => {
    const onFallbackCommit = vi.fn();
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true, status: { status: 'source-error' }, onFallbackCommit }));
    document.body.appendChild(handle.el);
    const input = errorInputEl(handle.el)!;
    type(input, '   ');
    key(input, 'Enter');
    expect(onFallbackCommit).toHaveBeenCalledWith('   ', false);
  });

  it('a second error status while already erroring does not overwrite an in-progress edit', () => {
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true, status: { status: 'source-error' } }));
    document.body.appendChild(handle.el);
    const input = errorInputEl(handle.el)!;
    type(input, 'typed, text');
    handle.updateStatus({ status: 'helper-error' });
    expect(errorInputEl(handle.el)!.value).toBe('typed, text');
  });

  it('recovering from error swaps back to the trigger', () => {
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true, status: { status: 'source-error' } }));
    document.body.appendChild(handle.el);
    handle.updateStatus({ status: 'ready' });
    expect(errorInputEl(handle.el)).toBeNull();
    expect(triggerEl(handle.el)).not.toBeNull();
  });

  it('an error status arriving while the popover is open cancels it, with no onApply', () => {
    const onApply = vi.fn();
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true, onApply }));
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    expect(handle.isOpen()).toBe(true);
    handle.updateStatus({ status: 'source-error' });
    expect(handle.isOpen()).toBe(false);
    expect(onApply).not.toHaveBeenCalled();
    expect(popover()).toBeNull();
  });
});

describe('buildMultiSelectField — isOpen()', () => {
  it('reflects the popover open/closed lifecycle', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    expect(handle.isOpen()).toBe(false);
    click(triggerEl(handle.el));
    expect(handle.isOpen()).toBe(true);
    click(cancelBtn());
    expect(handle.isOpen()).toBe(false);
  });
});
