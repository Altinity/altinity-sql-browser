import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildTimeRangeField } from '../../src/ui/time-range-field.js';
import type { TimeRangeFieldOpts } from '../../src/ui/time-range-field.js';
import type { DashboardTimeRangeGroup, TimeRangeRecent } from '../../src/core/time-range.js';
import { validateTimeRangeDraft } from '../../src/core/time-range.js';
import { TIME_RANGE_CONSTANTS } from '../../src/ui/relative-time-field.js';
import { parseParamType } from '../../src/core/param-type.js';

afterEach(() => document.body.replaceChildren());

// A fixed wall-clock instant (UTC noon-ish) so resolved previews are stable;
// the test suite runs under TZ=America/New_York (see the memory note) so
// relative calendar offsets resolve in that zone, but every assertion routes
// the expected display through the same `validateTimeRangeDraft` the control
// uses, so no assertion hard-codes a formatted string.
const NOW = Date.UTC(2026, 6, 21, 12, 35, 45);
const DAY = 86400000;

const DT = parseParamType('DateTime');

function grp(overrides: Partial<DashboardTimeRangeGroup> = {}): DashboardTimeRangeGroup {
  return {
    key: 'f1\u0000f2', fromFilterId: 'f1', toFilterId: 'f2',
    fromParameter: 'from', toParameter: 'to',
    fromType: DT, toType: DT,
    ...overrides,
  };
}

function baseOpts(overrides: Partial<TimeRangeFieldOpts> = {}): TimeRangeFieldOpts {
  return {
    group: grp(),
    fromValue: '-1d', toValue: 'now', active: true,
    waveNowMs: NOW,
    wallNow: () => NOW,
    getRecents: () => [],
    onApply: vi.fn(),
    ...overrides,
  };
}

const expectDraft = (fromText: string, toText: string, nowMs = NOW) =>
  validateTimeRangeDraft({ fromText, toText, fromType: DT, toType: DT, nowMs });

const click = (el: Element): boolean =>
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (target: EventTarget, k: string): boolean =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const type = (input: HTMLInputElement, text: string): void => {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const focus = (input: HTMLElement): void => { input.dispatchEvent(new Event('focus')); };

const trigger = (el: HTMLElement): HTMLButtonElement => el.querySelector('.trf-trigger') as HTMLButtonElement;
const popover = (): HTMLElement | null => document.body.querySelector('.trf-popover');
const fromInput = (): HTMLInputElement => document.body.querySelector('input[aria-label="From"]') as HTMLInputElement;
const toInput = (): HTMLInputElement => document.body.querySelector('input[aria-label="To"]') as HTMLInputElement;
const fromCaret = (): HTMLButtonElement =>
  document.body.querySelector('button[aria-label="Show constants for From"]') as HTMLButtonElement;
const toCaret = (): HTMLButtonElement =>
  document.body.querySelector('button[aria-label="Show constants for To"]') as HTMLButtonElement;
const rightHeader = (): HTMLElement => document.body.querySelector('.trf-right-header') as HTMLElement;
const previews = (): HTMLElement[] => [...document.body.querySelectorAll('.trf-preview')] as HTMLElement[];
const constBtns = (): HTMLElement[] => [...document.body.querySelectorAll('.trf-const')] as HTMLElement[];
const recentBtns = (): HTMLElement[] => [...document.body.querySelectorAll('.trf-recent')] as HTMLElement[];
const emptyEl = (): HTMLElement | null => document.body.querySelector('.trf-empty');
const applyBtn = (): HTMLButtonElement => document.body.querySelector('.trf-btn-primary') as HTMLButtonElement;
const cancelBtn = (): HTMLButtonElement =>
  document.body.querySelector('.trf-btn:not(.trf-btn-primary)') as HTMLButtonElement;
const rangeErr = (): HTMLElement => document.body.querySelector('.trf-range-error') as HTMLElement;

const open = (handle: { el: HTMLElement }): void => { click(trigger(handle.el)); };

describe('buildTimeRangeField — closed trigger states', () => {
  it('is a #364 dialog-pattern button', () => {
    const handle = buildTimeRangeField(baseOpts());
    const t = trigger(handle.el);
    expect(handle.el.className).toBe('var-field is-time-range');
    expect(t.getAttribute('aria-haspopup')).toBe('dialog');
    expect(t.getAttribute('aria-expanded')).toBe('false');
    expect(t.classList.contains('var-input')).toBe(true);
  });

  it('active + both bounds resolve: label is the resolved range and aria carries tokens AND resolved range', () => {
    const handle = buildTimeRangeField(baseOpts({ fromValue: '-1d', toValue: 'now', active: true }));
    const t = trigger(handle.el);
    const res = expectDraft('-1d', 'now');
    expect(t.textContent).toBe(`${res.from.display} → ${res.to.display}`);
    expect(t.classList.contains('is-error')).toBe(false);
    expect(t.getAttribute('aria-label')).toBe(
      `Time range from -1d to now, resolved ${res.from.display} to ${res.to.display}`);
  });

  it('inactive → neutral "Not set"', () => {
    const handle = buildTimeRangeField(baseOpts({ active: false }));
    const t = trigger(handle.el);
    expect(t.textContent).toBe('Not set');
    expect(t.getAttribute('aria-label')).toBe('Time range, not set');
    expect(t.classList.contains('is-error')).toBe(false);
  });

  it('active but a committed bound fails to parse → raw text + error class, aria says not resolvable', () => {
    const handle = buildTimeRangeField(baseOpts({ fromValue: '-1x', toValue: 'now', active: true }));
    const t = trigger(handle.el);
    const res = expectDraft('-1x', 'now');
    expect(res.from.ok).toBe(false); // sanity: the near-miss really is unresolvable
    expect(t.textContent).toBe(`-1x → ${res.to.display}`); // raw for the broken bound, resolved for the good one
    expect(t.classList.contains('is-error')).toBe(true);
    expect(t.getAttribute('aria-label')).toBe('Time range from -1x to now, not resolvable');
  });

  it('a failing TO bound also shows raw text for that bound with the error class', () => {
    const handle = buildTimeRangeField(baseOpts({ fromValue: 'now', toValue: '-1x', active: true }));
    const t = trigger(handle.el);
    const res = expectDraft('now', '-1x');
    expect(res.to.ok).toBe(false);
    expect(t.textContent).toBe(`${res.from.display} → -1x`);
    expect(t.classList.contains('is-error')).toBe(true);
  });

  it('waveNowMs null falls back to wallNow() for the initial label', () => {
    const handle = buildTimeRangeField(baseOpts({ waveNowMs: null, wallNow: () => NOW, fromValue: 'now', toValue: 'now' }));
    const res = expectDraft('now', 'now');
    expect(trigger(handle.el).textContent).toBe(`${res.from.display} → ${res.to.display}`);
  });
});

describe('buildTimeRangeField — refreshLabel re-resolves in place', () => {
  it('recomputes the trigger label against a new nowMs without rebuilding', () => {
    const handle = buildTimeRangeField(baseOpts({ fromValue: '-1d', toValue: 'now', active: true }));
    const t = trigger(handle.el);
    const before = t.textContent;
    handle.refreshLabel(NOW + DAY);
    const res = expectDraft('-1d', 'now', NOW + DAY);
    expect(t.textContent).toBe(`${res.from.display} → ${res.to.display}`);
    expect(t.textContent).not.toBe(before); // a day later resolves to a different instant
    expect(trigger(handle.el)).toBe(t); // same node — no rebuild
  });
});

describe('buildTimeRangeField — popover open/close/focus-return', () => {
  it('opens under the trigger with aria-expanded, and Cancel closes + returns focus', () => {
    const handle = buildTimeRangeField(baseOpts());
    document.body.appendChild(handle.el);
    const t = trigger(handle.el);
    open(handle);
    expect(popover()).not.toBeNull();
    expect(t.getAttribute('aria-expanded')).toBe('true');
    expect(handle.isOpen()).toBe(true);
    expect(popover()!.getAttribute('role')).toBe('dialog');
    expect(popover()!.getAttribute('aria-label')).toBe('Time range');
    click(cancelBtn());
    expect(popover()).toBeNull();
    expect(t.getAttribute('aria-expanded')).toBe('false');
    expect(handle.isOpen()).toBe(false);
    expect(document.activeElement).toBe(t);
  });

  it('Escape closes the popover', () => {
    const handle = buildTimeRangeField(baseOpts());
    document.body.appendChild(handle.el);
    open(handle);
    key(popover()!, 'Escape');
    expect(handle.isOpen()).toBe(false);
  });

  it('clicking the trigger while already open does not stack a second popover', () => {
    const handle = buildTimeRangeField(baseOpts());
    document.body.appendChild(handle.el);
    const t = trigger(handle.el);
    click(t);
    click(t);
    expect(document.body.querySelectorAll('.trf-popover').length).toBe(1);
  });

  it('opens with staged inputs seeded from the committed values and both preview lines resolved', () => {
    const handle = buildTimeRangeField(baseOpts({ fromValue: '-1d', toValue: 'now' }));
    document.body.appendChild(handle.el);
    open(handle);
    expect(fromInput().value).toBe('-1d');
    expect(toInput().value).toBe('now');
    const res = expectDraft('-1d', 'now');
    expect(previews()[0].textContent).toBe('= ' + res.from.display);
    expect(previews()[1].textContent).toBe('= ' + res.to.display);
    expect(fromInput().getAttribute('aria-describedby')).toBe(previews()[0].id);
  });
});

describe('buildTimeRangeField — right column: recents (no field active)', () => {
  it('opens showing "Recently used" with one button per recent (raw tokens)', () => {
    const recents: TimeRangeRecent[] = [{ from: '-1d', to: 'now' }, { from: '2026-07-01', to: 'now' }];
    const handle = buildTimeRangeField(baseOpts({ getRecents: () => recents }));
    document.body.appendChild(handle.el);
    open(handle);
    expect(rightHeader().textContent).toBe('Recently used');
    expect(recentBtns().map((b) => b.textContent)).toEqual(['-1d → now', '2026-07-01 → now']);
  });

  it('empty recents → "No recent ranges yet"', () => {
    const handle = buildTimeRangeField(baseOpts({ getRecents: () => [] }));
    document.body.appendChild(handle.el);
    open(handle);
    expect(emptyEl()!.textContent).toBe('No recent ranges yet');
  });

  it('clicking a recent closes the popover FIRST, then applies its raw pair', () => {
    const recents: TimeRangeRecent[] = [{ from: '-2d', to: '-1h' }];
    let openWhenCalled: boolean | null = null;
    const onApply = vi.fn(() => { openWhenCalled = handle.isOpen(); });
    const handle = buildTimeRangeField(baseOpts({ getRecents: () => recents, onApply }));
    document.body.appendChild(handle.el);
    open(handle);
    click(recentBtns()[0]);
    expect(onApply).toHaveBeenCalledWith('-2d', '-1h');
    expect(openWhenCalled).toBe(false); // close ran before onApply
    expect(popover()).toBeNull();
  });
});

describe('buildTimeRangeField — right column: constants (a field active)', () => {
  it('a caret toggles the field constants column on and off (recents when off)', () => {
    const handle = buildTimeRangeField(baseOpts());
    document.body.appendChild(handle.el);
    open(handle);
    expect(rightHeader().textContent).toBe('Recently used'); // resting state despite From being focused on open
    click(fromCaret());
    expect(fromCaret().getAttribute('aria-pressed')).toBe('true');
    expect(rightHeader().textContent).toBe('From · constants');
    expect(constBtns().length).toBe(TIME_RANGE_CONSTANTS.length);
    click(fromCaret()); // toggle off → back to recents
    expect(fromCaret().getAttribute('aria-pressed')).toBe('false');
    expect(rightHeader().textContent).toBe('Recently used');
  });

  it('switches between From and To constants per caret', () => {
    const handle = buildTimeRangeField(baseOpts());
    document.body.appendChild(handle.el);
    open(handle);
    click(fromCaret());
    expect(rightHeader().textContent).toBe('From · constants');
    click(toCaret());
    expect(rightHeader().textContent).toBe('To · constants');
    expect(toCaret().getAttribute('aria-pressed')).toBe('true');
    expect(fromCaret().getAttribute('aria-pressed')).toBe('false');
  });

  it('focusing a field (a genuine, post-open focus) activates its constants column', () => {
    const handle = buildTimeRangeField(baseOpts());
    document.body.appendChild(handle.el);
    open(handle);
    focus(toInput());
    expect(rightHeader().textContent).toBe('To · constants');
    expect(toCaret().getAttribute('aria-pressed')).toBe('true');
  });

  it('typing in a field filters the constants via filterTokenList', () => {
    const handle = buildTimeRangeField(baseOpts());
    document.body.appendChild(handle.el);
    open(handle);
    type(fromInput(), '-1h');
    expect(rightHeader().textContent).toBe('From · constants');
    const tokens = constBtns().map((b) => b.querySelector('.trf-const-token')!.textContent);
    expect(tokens).toEqual(['-1h']);
  });

  it('no matches shows the absolute-datetimes hint', () => {
    const handle = buildTimeRangeField(baseOpts());
    document.body.appendChild(handle.el);
    open(handle);
    type(fromInput(), 'zzzz');
    expect(constBtns().length).toBe(0);
    expect(emptyEl()!.textContent).toContain('absolute datetimes');
  });

  it('clicking a constant fills that field (staged), keeps the popover open, resets the filter, no apply', () => {
    const onApply = vi.fn();
    const handle = buildTimeRangeField(baseOpts({ onApply }));
    document.body.appendChild(handle.el);
    open(handle);
    type(fromInput(), '-1h'); // filter down to one
    click(constBtns()[0]);
    expect(fromInput().value).toBe('-1h');
    expect(onApply).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(true);
    expect(constBtns().length).toBe(TIME_RANGE_CONSTANTS.length); // filter reset after fill
  });

  it('a constant fills the To field when To is active', () => {
    const handle = buildTimeRangeField(baseOpts());
    document.body.appendChild(handle.el);
    open(handle);
    click(toCaret());
    const nowConst = constBtns().find((b) => b.querySelector('.trf-const-token')!.textContent === 'now')!;
    click(nowConst);
    expect(toInput().value).toBe('now');
  });
});

describe('buildTimeRangeField — Apply / Cancel semantics', () => {
  it('staged editing does not commit (onApply only fires on Apply)', () => {
    const onApply = vi.fn();
    const handle = buildTimeRangeField(baseOpts({ onApply }));
    document.body.appendChild(handle.el);
    open(handle);
    type(fromInput(), '-3d');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('Cancel discards the draft: no onApply, popover closed', () => {
    const onApply = vi.fn();
    const handle = buildTimeRangeField(baseOpts({ onApply }));
    document.body.appendChild(handle.el);
    open(handle);
    type(fromInput(), '-3d');
    click(cancelBtn());
    expect(onApply).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(false);
  });

  it('Apply is disabled while a bound is unresolvable', () => {
    const handle = buildTimeRangeField(baseOpts());
    document.body.appendChild(handle.el);
    open(handle);
    type(fromInput(), '-1x'); // near-miss, unresolvable
    expect(applyBtn().disabled).toBe(true);
    expect(previews()[0].classList.contains('is-error')).toBe(true);
  });

  it('Apply is disabled and the range error shows when from > to; equal instants are permitted', () => {
    const handle = buildTimeRangeField(baseOpts({ fromValue: '-1d', toValue: 'now' }));
    document.body.appendChild(handle.el);
    open(handle);
    type(fromInput(), 'now');
    type(toInput(), '-1d'); // now > -1d → from after to
    expect(applyBtn().disabled).toBe(true);
    expect(rangeErr().hidden).toBe(false);
    expect(rangeErr().textContent).toBe(expectDraft('now', '-1d').rangeError);
    type(toInput(), 'now'); // equal instants → permitted
    expect(applyBtn().disabled).toBe(false);
    expect(rangeErr().hidden).toBe(true);
  });

  it('Apply with a draft identical (after trim) to the committed pair closes without onApply', () => {
    const onApply = vi.fn();
    const handle = buildTimeRangeField(baseOpts({ fromValue: '-1d', toValue: 'now', onApply }));
    document.body.appendChild(handle.el);
    open(handle);
    expect(applyBtn().disabled).toBe(false);
    click(applyBtn());
    expect(onApply).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(false);
  });

  it('Apply with unchanged valid values on an INACTIVE pair still commits — activation is the change', () => {
    // clearFilter keeps the typed value and only flips `active` off, so a
    // committed-but-inactive pair seeds the popover with valid text; Apply is
    // the only activation path for a grouped pair and must not no-op here.
    const onApply = vi.fn();
    const handle = buildTimeRangeField(baseOpts({ fromValue: '-1d', toValue: 'now', active: false, onApply }));
    document.body.appendChild(handle.el);
    open(handle);
    expect(applyBtn().disabled).toBe(false);
    click(applyBtn());
    expect(onApply).toHaveBeenCalledWith('-1d', 'now');
    expect(handle.isOpen()).toBe(false);
  });

  it('Apply commits the TRIMMED drafts, closing BEFORE onApply', () => {
    let openWhenCalled: boolean | null = null;
    const onApply = vi.fn(() => { openWhenCalled = handle.isOpen(); });
    const handle = buildTimeRangeField(baseOpts({ fromValue: '-1d', toValue: 'now', onApply }));
    document.body.appendChild(handle.el);
    open(handle);
    type(fromInput(), '  -2d  '); // padded — must be trimmed on commit
    click(applyBtn());
    expect(onApply).toHaveBeenCalledWith('-2d', 'now');
    expect(openWhenCalled).toBe(false);
    expect(popover()).toBeNull();
  });
});

describe('buildTimeRangeField — handle surface', () => {
  it('updateStatus is a no-op that does not throw or change the trigger', () => {
    const handle = buildTimeRangeField(baseOpts());
    const before = trigger(handle.el).textContent;
    expect(() => handle.updateStatus({ status: 'anything' })).not.toThrow();
    expect(trigger(handle.el).textContent).toBe(before);
  });

  it('focusTrigger focuses the trigger button', () => {
    const handle = buildTimeRangeField(baseOpts());
    document.body.appendChild(handle.el);
    handle.focusTrigger();
    expect(document.activeElement).toBe(trigger(handle.el));
  });

  it('isOpen reflects the popover lifecycle', () => {
    const handle = buildTimeRangeField(baseOpts());
    document.body.appendChild(handle.el);
    expect(handle.isOpen()).toBe(false);
    open(handle);
    expect(handle.isOpen()).toBe(true);
    click(cancelBtn());
    expect(handle.isOpen()).toBe(false);
  });

  it('dispose while open is a Cancel: no onApply, popover removed, trigger listener detached', () => {
    const onApply = vi.fn();
    const handle = buildTimeRangeField(baseOpts({ onApply }));
    document.body.appendChild(handle.el);
    const t = trigger(handle.el);
    open(handle);
    type(fromInput(), '-9d');
    handle.dispose();
    expect(onApply).not.toHaveBeenCalled();
    expect(handle.isOpen()).toBe(false);
    expect(popover()).toBeNull();
    click(t); // listener removed — must not reopen
    expect(popover()).toBeNull();
  });

  it('dispose while closed does not throw and still detaches the trigger listener', () => {
    const handle = buildTimeRangeField(baseOpts());
    document.body.appendChild(handle.el);
    const t = trigger(handle.el);
    expect(() => handle.dispose()).not.toThrow();
    click(t);
    expect(popover()).toBeNull();
  });
});

describe('review-round fixes', () => {
  const liveEl = (): HTMLElement =>
    document.body.querySelector('.trf-popover .sr-only[aria-live="polite"]') as HTMLElement;

  it('a constant pick returns focus to the field input (the click detaches the picked button)', () => {
    const handle = buildTimeRangeField(baseOpts());
    open(handle);
    focus(fromInput()); // synthetic activation: show the From constants column
    const btn = constBtns()[0];
    btn.focus();        // real focus — the clicked button truly holds focus
    expect(document.activeElement).toBe(btn);
    click(btn);
    expect(document.activeElement).toBe(fromInput());
  });

  it('announces validation failures politely — per field, range errors deduped, cleared on valid', () => {
    const handle = buildTimeRangeField(baseOpts());
    open(handle);
    expect(liveEl().textContent).toBe(''); // valid committed seed announces nothing

    type(fromInput(), 'banana');
    expect(liveEl().textContent).toBe(`From: ${expectDraft('banana', 'now').from.error}`);

    type(fromInput(), '-1d');
    type(toInput(), 'garbage');
    expect(liveEl().textContent).toBe(`To: ${expectDraft('-1d', 'garbage').to.error}`);

    // Range error (both bounds resolve, from > to) announces the range text…
    type(fromInput(), 'now');
    type(toInput(), '-1d');
    const rangeText = expectDraft('now', '-1d').rangeError as string;
    expect(liveEl().textContent).toBe(rangeText);
    // …and an edit producing the SAME failure text does not rewrite the region
    // (rewriting identical text would re-announce it every keystroke).
    type(toInput(), '-2d');
    expect(liveEl().textContent).toBe(rangeText);

    type(toInput(), 'now');
    expect(liveEl().textContent).toBe('');
  });
});
