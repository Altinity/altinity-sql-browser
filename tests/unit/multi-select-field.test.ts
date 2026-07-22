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

  // Maintainer merge-gate finding: `onApply` typically routes into
  // `session.applyFilter`, which publishes SYNCHRONOUSLY (before its first
  // `await`) — a subscriber that rebuilds the filter bar on that publish can
  // run inside `onApply` itself. If the popover were still open at that
  // point, the rebuild would read it as an outgoing bar's popover getting
  // force-cancelled and announce a false "Filter options were refreshed". The
  // fix: close BEFORE calling `onApply`, so any synchronous reaction to
  // `onApply` always observes this popover as already closed.
  it('closes the popover (draft already captured) BEFORE invoking onApply, not after', () => {
    const onApply = vi.fn();
    let openWhenCalled: boolean | null = null;
    let ariaExpandedWhenCalled: string | null = null;
    let popoverPresentWhenCalled: boolean | null = null;
    const handle = buildMultiSelectField(baseOpts({
      value: ['a'], active: true,
      onApply: (...args) => {
        openWhenCalled = handle.isOpen();
        ariaExpandedWhenCalled = triggerEl(handle.el).getAttribute('aria-expanded');
        popoverPresentWhenCalled = popover() !== null;
        onApply(...args);
      },
    }));
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    setChecked(optionCbs()[1], true); // add Bravo — a real change, so onApply fires
    click(applyBtn());
    expect(onApply).toHaveBeenCalledWith(['a', 'b'], true); // the commit still happened
    expect(openWhenCalled).toBe(false);
    expect(ariaExpandedWhenCalled).toBe('false');
    expect(popoverPresentWhenCalled).toBe(false);
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

  it('an error status arriving while the popover is open cancels it, with no onApply, and focuses the fallback input not <body> (#189 F2a)', () => {
    const onApply = vi.fn();
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true, onApply }));
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    expect(handle.isOpen()).toBe(true);
    handle.updateStatus({ status: 'source-error' });
    expect(handle.isOpen()).toBe(false);
    expect(onApply).not.toHaveBeenCalled();
    expect(popover()).toBeNull();
    // F2a: the doomed trigger (about to be detached by the swap) is never
    // focused — focus lands on the freshly-swapped-in error input instead.
    expect(document.activeElement).toBe(errorInputEl(handle.el));
  });
});

describe('buildMultiSelectField — raw-string committed value (#189 F1)', () => {
  it('triggerText shows the raw string verbatim when active, never joined/counted', () => {
    const handle = buildMultiSelectField(baseOpts({ value: 'typed raw text', active: true }));
    expect(triggerEl(handle.el).textContent).toBe('typed raw text');
  });

  it('an inactive raw string reads as the inactive text', () => {
    const handle = buildMultiSelectField(baseOpts({ value: '', active: false }));
    expect(triggerEl(handle.el).textContent).toBe('All');
  });

  it('opening the popover from a raw-string committed value seeds an empty draft (Array.isArray guard)', () => {
    const handle = buildMultiSelectField(baseOpts({ value: 'typed raw', active: true }));
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    expect(optionCbs().every((cb) => !cb.checked)).toBe(true);
  });

  it('Apply from a raw-string committed value treats the prior selection as empty for the no-op check', () => {
    const onApply = vi.fn();
    const handle = buildMultiSelectField(baseOpts({ value: 'typed raw', active: true, onApply }));
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    setChecked(optionCbs()[0], true); // check Alpha
    click(applyBtn());
    expect(onApply).toHaveBeenCalledWith(['a'], true);
  });

  it('a raw string entering error mode seeds the error input verbatim (not joined)', () => {
    const handle = buildMultiSelectField(baseOpts({ value: 'typed raw', active: true, status: { status: 'source-error' } }));
    document.body.appendChild(handle.el);
    expect(errorInputEl(handle.el)!.value).toBe('typed raw');
  });
});

describe('buildMultiSelectField — errorEdited reset + listener detach on recovery (#189 F5)', () => {
  it('re-entering error mode reseeds fresh (errorEdited reset), discarding a prior uncommitted edit', () => {
    const onFallbackCommit = vi.fn();
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true, status: { status: 'source-error' }, onFallbackCommit }));
    document.body.appendChild(handle.el);
    type(errorInputEl(handle.el)!, 'stale edit');
    handle.updateStatus({ status: 'ready' }); // leaves error mode, never committing
    handle.updateStatus({ status: 'helper-error' }); // re-enters error mode
    const input = errorInputEl(handle.el)!;
    expect(input.value).toBe('a'); // reseeded from the committed value, not the stale edit
    input.dispatchEvent(new Event('blur')); // no edit since re-entry — must not commit
    expect(onFallbackCommit).not.toHaveBeenCalled();
  });

  it('leaving error mode detaches the fallback listeners so a native blur-on-removal can never force a commit', () => {
    const onFallbackCommit = vi.fn();
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true, status: { status: 'source-error' }, onFallbackCommit }));
    document.body.appendChild(handle.el);
    const input = errorInputEl(handle.el)!;
    type(input, 'typed but never committed');
    handle.updateStatus({ status: 'ready' }); // recovery swaps the trigger back in
    // Simulates the native blur-on-removal a real browser fires when a
    // FOCUSED element is removed from the document (happy-dom does not
    // reproduce this on its own) — must be inert now the listener is gone.
    input.dispatchEvent(new Event('blur'));
    expect(onFallbackCommit).not.toHaveBeenCalled();
  });
});

describe('buildMultiSelectField — Tab focus trap inside the dialog (#189 F3)', () => {
  const tab = (target: EventTarget, shiftKey = false): boolean =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }));

  it('Tab from the LAST focusable element wraps to the first (the search input)', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    applyBtn().focus(); // the last focusable row in the dialog
    tab(popover()!);
    expect(document.activeElement).toBe(searchInput());
  });

  it('Shift+Tab from the FIRST focusable element (search) wraps to the last (Apply)', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    searchInput().focus();
    tab(popover()!, true);
    expect(document.activeElement).toBe(applyBtn());
  });

  it('Tab/Shift-Tab from an element in the middle of the dialog does not trap (default behavior)', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    selectAllCb().focus();
    const forward = tab(popover()!);
    const backward = tab(popover()!, true);
    expect(forward).toBe(true); // not preventDefault-ed — the browser's own Tab order applies
    expect(backward).toBe(true);
  });
});

describe('buildMultiSelectField — loading affordance while the popover is open (#189 F6)', () => {
  it('a status-only waiting/loading/idle/stale update while open disables the checklist body, sets aria-busy, and announces Loading options…, keeping Cancel usable', () => {
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true }));
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    handle.updateStatus({ status: 'loading' });
    expect(popover()!.getAttribute('aria-busy')).toBe('true');
    expect(searchInput().disabled).toBe(true);
    expect(selectAllCb().disabled).toBe(true);
    expect(optionCbs().every((cb) => cb.disabled)).toBe(true);
    expect(clearBtn().hasAttribute('disabled')).toBe(true);
    expect(applyBtn().hasAttribute('disabled')).toBe(true);
    expect(cancelBtn().hasAttribute('disabled')).toBe(false); // Cancel stays usable
    expect(liveText()).toBe('Loading options…');
    // The popover itself is still open — a status-only publish is never a
    // rebuild, so the draft can't have changed.
    expect(handle.isOpen()).toBe(true);
  });

  it('restores the checklist body and the normal live-region count once status returns to ready', () => {
    const handle = buildMultiSelectField(baseOpts({ value: ['a'], active: true }));
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    handle.updateStatus({ status: 'loading' });
    handle.updateStatus({ status: 'ready' });
    expect(popover()!.getAttribute('aria-busy')).toBe('false');
    expect(searchInput().disabled).toBe(false);
    expect(selectAllCb().disabled).toBe(false);
    expect(optionCbs().every((cb) => !cb.disabled)).toBe(true);
    expect(applyBtn().hasAttribute('disabled')).toBe(false);
    expect(liveText()).toBe('3 of 3 options');
  });

  it('a stale:true status update (independent of a named status) also disables the checklist while open', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    handle.updateStatus({ status: 'ready', stale: true });
    expect(popover()!.getAttribute('aria-busy')).toBe('true');
    expect(applyBtn().hasAttribute('disabled')).toBe(true);
  });

  it('a waiting status update while CLOSED never throws and has no visible popover effect', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    expect(() => handle.updateStatus({ status: 'waiting', waitingFor: ['x'] })).not.toThrow();
    expect(popover()).toBeNull();
  });

  it('a second consecutive update that resolves to the SAME busy state is a no-op (idempotent)', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    click(triggerEl(handle.el));
    handle.updateStatus({ status: 'loading' }); // busy: true
    handle.updateStatus({ status: 'idle' }); // still busy: true — no-op branch
    expect(popover()!.getAttribute('aria-busy')).toBe('true');
    expect(applyBtn().hasAttribute('disabled')).toBe(true);
  });
});

describe('buildMultiSelectField — focusTrigger() (#189 F2b)', () => {
  it('focuses the trigger when not erroring', () => {
    const handle = buildMultiSelectField(baseOpts());
    document.body.appendChild(handle.el);
    handle.focusTrigger();
    expect(document.activeElement).toBe(triggerEl(handle.el));
  });

  it('focuses the error-mode fallback input when erroring', () => {
    const handle = buildMultiSelectField(baseOpts({ status: { status: 'source-error' } }));
    document.body.appendChild(handle.el);
    handle.focusTrigger();
    expect(document.activeElement).toBe(errorInputEl(handle.el));
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
