import { describe, it, expect, vi, afterEach } from 'vitest';
import { openConfirmMenu } from '../../src/ui/confirm-menu.js';
import type { ConfirmMenuOptions } from '../../src/ui/confirm-menu.js';

afterEach(() => document.body.replaceChildren());

const trigger = (): HTMLButtonElement => {
  const btn = document.createElement('button');
  document.body.appendChild(btn);
  return btn;
};

const click = (el: Element): boolean => el.dispatchEvent(new Event('click', { bubbles: true }));
const escape = (): boolean =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const flush = (): Promise<void> => new Promise((r) => setTimeout(r));

const open = (over: Partial<ConfirmMenuOptions> = {}): { onConfirm: ReturnType<typeof vi.fn>; btn: HTMLButtonElement } => {
  const onConfirm = vi.fn();
  const btn = over.trigger as HTMLButtonElement ?? trigger();
  openConfirmMenu({
    document,
    trigger: btn,
    question: 'Remove panel “Revenue” from “Sales”? This also deletes its dedicated query copy.',
    confirmLabel: 'Remove tile',
    menuClass: 'demo-confirm',
    goClass: 'demo-confirm-go',
    cancelClass: 'demo-confirm-cancel',
    onConfirm,
    ...over,
  });
  return { onConfirm, btn };
};

const menu = (): HTMLElement => document.querySelector<HTMLElement>('.demo-confirm')!;
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.demo-confirm .fm-item')];
const overlay = (): HTMLElement => document.querySelector<HTMLElement>('.fm-overlay')!;

describe('openConfirmMenu — the shared destructive shape', () => {
  it('renders the question as the section, then the go row, then Cancel', () => {
    open();
    expect(menu().querySelector('.fm-section')!.textContent)
      .toBe('Remove panel “Revenue” from “Sales”? This also deletes its dedicated query copy.');
    expect(rows().map((row) => row.querySelector('.fm-label')!.textContent))
      .toEqual(['Remove tile', 'Cancel']);
  });

  it('puts each caller-supplied class where that caller\'s CSS expects it', () => {
    // The classes are the reason converting the tree and the tab strip onto this
    // primitive changed no test and no stylesheet.
    open();
    expect(menu().classList.contains('demo-confirm')).toBe(true);
    expect(rows()[0].classList.contains('demo-confirm-go')).toBe(true);
    expect(rows()[1].classList.contains('demo-confirm-cancel')).toBe(true);
  });

  it('carries the caller\'s accessible name, and omits the attribute when none is given', () => {
    open({ ariaLabel: 'Confirm removal' });
    expect(menu().getAttribute('aria-label')).toBe('Confirm removal');
    document.body.replaceChildren();
    open();
    expect(menu().hasAttribute('aria-label')).toBe(false);
  });

  // #501, and the whole reason this is a primitive: the order and the initial
  // focus are DIFFERENT questions, and a fourth hand-written caller would get the
  // order right and this wrong, invisibly.
  it('leaves initial focus on Cancel even though the destructive row reads first', async () => {
    open();
    await flush();
    expect(document.activeElement).toBe(rows()[1]);
    expect(document.activeElement!.textContent).toContain('Cancel');
  });
});

describe('openConfirmMenu — acting and dismissing', () => {
  it('runs onConfirm from the go row, exactly once, after the menu is torn down', () => {
    const { onConfirm } = open();
    const seen: boolean[] = [];
    // `menu.ts` closes before invoking a row, which is what lets a caller open a
    // SECOND menu on the same trigger from inside `onConfirm`.
    onConfirm.mockImplementation(() => seen.push(document.querySelector('.demo-confirm') === null));
    click(rows()[0]);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([true]);
  });

  it('never runs onConfirm from Cancel, from Escape, or from an outside click', () => {
    for (const dismiss of [
      () => click(rows()[1]),
      () => escape(),
      () => click(overlay()),
    ]) {
      const { onConfirm } = open();
      dismiss();
      expect(onConfirm).not.toHaveBeenCalled();
      expect(document.querySelector('.demo-confirm')).toBeNull();
      document.body.replaceChildren();
    }
  });
});

describe('openConfirmMenu — returnFocusTo is a resolver, not an element', () => {
  it('resolves it on Cancel and on an outside click', () => {
    for (const dismiss of [() => click(rows()[1]), () => click(overlay())]) {
      const landing = trigger();
      const returnFocusTo = vi.fn(() => landing);
      open({ returnFocusTo });
      // Not consulted while the confirmation is open — only on the way out.
      expect(returnFocusTo).not.toHaveBeenCalled();
      dismiss();
      expect(returnFocusTo).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(landing);
      document.body.replaceChildren();
    }
  });

  it('honours a landing element that did not exist when the menu opened', () => {
    // The contract a captured element cannot keep: a confirmation is body-mounted
    // and can sit open across an unrelated repaint, so the control that opened it
    // may be gone by the time focus has to go back somewhere.
    const btn = trigger();
    let landing: HTMLButtonElement | null = null;
    open({ trigger: btn, returnFocusTo: () => landing });
    btn.remove();
    landing = trigger();
    click(rows()[1]);
    expect(document.activeElement).toBe(landing);
  });

  it('leaves focus exactly where it was when the resolver answers null', () => {
    const btn = trigger();
    btn.focus();
    const returnFocusTo = vi.fn(() => null);
    open({ trigger: btn, returnFocusTo });
    click(rows()[1]);
    expect(returnFocusTo).toHaveBeenCalledTimes(1);
    // Falsifiable: any `.focus()` call at all would move this off the trigger.
    expect(document.activeElement).toBe(btn);
  });

  it('is optional — a caller with nowhere to send focus omits it', () => {
    open();
    expect(() => click(rows()[1])).not.toThrow();
  });

  it('restores on the destructive path too, before onConfirm moves focus itself', () => {
    // Deliberate: `onClose` fires inside `close()`, which runs BEFORE the row's
    // handler, so suppressing this would mean reading a flag the row cannot have
    // set yet. The confirming caller owns focus from `onConfirm` onwards.
    const landing = trigger();
    const final = trigger();
    const order: string[] = [];
    openConfirmMenu({
      document,
      trigger: trigger(),
      question: 'Remove?',
      confirmLabel: 'Remove tile',
      menuClass: 'demo-confirm',
      goClass: 'demo-confirm-go',
      cancelClass: 'demo-confirm-cancel',
      returnFocusTo: () => { order.push('restore'); return landing; },
      onConfirm: () => { order.push('confirm'); final.focus(); },
    });
    click(rows()[0]);
    expect(order).toEqual(['restore', 'confirm']);
    expect(document.activeElement).toBe(final);
  });
});

describe('openConfirmMenu — keyboard ownership', () => {
  it('claims the keyboard on open and releases it on close', () => {
    const onKeyboardOwnerChange = vi.fn();
    open({ onKeyboardOwnerChange });
    expect(onKeyboardOwnerChange).toHaveBeenCalledWith({ kind: 'menu' });
    click(rows()[1]);
    expect(onKeyboardOwnerChange).toHaveBeenLastCalledWith(null);
  });
});

describe('openConfirmMenu — the handle', () => {
  it('returns the mounted popup and closes it on demand', () => {
    const btn = trigger();
    const handle = openConfirmMenu({
      document, trigger: btn, question: 'Remove?', confirmLabel: 'Remove tile',
      menuClass: 'demo-confirm', goClass: 'demo-confirm-go', cancelClass: 'demo-confirm-cancel',
      onConfirm: () => {},
    });
    expect(handle.el).toBe(menu());
    handle.close();
    expect(document.querySelector('.demo-confirm')).toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });
});
