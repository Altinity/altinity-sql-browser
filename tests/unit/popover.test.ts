import { describe, it, expect, vi, afterEach } from 'vitest';
import { openAnchoredDialog } from '../../src/ui/popover.js';
import type { AnchoredDialogOptions } from '../../src/ui/popover.js';
import { h } from '../../src/ui/dom.js';

afterEach(() => document.body.replaceChildren());

const key = (target: EventTarget, k: string, shiftKey = false): boolean =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true }));

// A trigger already mounted in the body, plus a content element carrying a
// couple of focusable rows (input + button) — the primitive's Tab trap keys
// off `input, button`.
function setup(overrides: Partial<AnchoredDialogOptions> = {}): {
  trigger: HTMLButtonElement;
  content: HTMLElement;
  input: HTMLInputElement;
  button: HTMLButtonElement;
  open: () => ReturnType<typeof openAnchoredDialog>;
  onClose: ReturnType<typeof vi.fn>;
} {
  const trigger = h('button', { type: 'button', 'aria-expanded': 'false' }) as HTMLButtonElement;
  document.body.appendChild(trigger);
  const input = h('input', { type: 'text', class: 'pv-input' }) as HTMLInputElement;
  const button = h('button', { type: 'button', class: 'pv-button' }) as HTMLButtonElement;
  const content = h('div', { style: { display: 'contents' } }, input, button);
  const onClose = vi.fn();
  const open = (): ReturnType<typeof openAnchoredDialog> =>
    openAnchoredDialog({
      document,
      trigger,
      ariaLabel: 'Test dialog',
      content,
      dialogClassName: 'pv-popover',
      onClose,
      ...overrides,
    });
  return { trigger, content, input, button, open, onClose };
}

const dialogEl = (): HTMLElement | null => document.body.querySelector('.pv-popover');
const overlayEl = (cls = '.ms-overlay'): HTMLElement | null => document.body.querySelector(cls);

describe('openAnchoredDialog — mount + ARIA', () => {
  it('mounts an overlay and a dialog with role/aria-modal/aria-label, and appends the content', () => {
    const { content, open } = setup();
    const handle = open();
    const dialog = dialogEl()!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Test dialog');
    expect(dialog.contains(content)).toBe(true);
    expect(overlayEl()).not.toBeNull(); // default overlay class
    expect(handle.dialog).toBe(dialog);
    expect(handle.isOpen()).toBe(true);
  });

  it('honors a custom overlayClassName', () => {
    const { open } = setup({ overlayClassName: 'trf-overlay' });
    open();
    expect(overlayEl('.ms-overlay')).toBeNull();
    expect(overlayEl('.trf-overlay')).not.toBeNull();
  });

  it('sets aria-expanded true on open and false on close', () => {
    const { trigger, open } = setup();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    const handle = open();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    handle.close();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('openAnchoredDialog — placement', () => {
  it('positions the dialog under the trigger rect via fixedAnchor (fixed, min-floored in a zero-rect realm)', () => {
    const { open } = setup();
    open();
    const dialog = dialogEl()!;
    expect(dialog.style.position).toBe('fixed');
    // happy-dom rects are all-zero → fixedAnchor floors to top=6 (default gap),
    // left=8 (default min).
    expect(dialog.style.top).toBe('6px');
    expect(dialog.style.left).toBe('8px');
  });

  it('minWidthFromTrigger true sets a min-width from the trigger rect; false/omit leaves it unset', () => {
    const withMin = setup({ minWidthFromTrigger: true });
    withMin.open();
    expect(dialogEl()!.style.minWidth).toBe('0px'); // trigger rect width is 0 in happy-dom
    document.body.replaceChildren();

    const without = setup();
    without.open();
    expect(dialogEl()!.style.minWidth).toBe('');
  });

  it('overlay is fixed and covers the viewport', () => {
    const { open } = setup();
    open();
    const overlay = overlayEl()!;
    expect(overlay.style.position).toBe('fixed');
    expect(overlay.style.inset).toBe('0');
  });

  it('clampToViewport left-aligns via the fixedAnchor clamp path (reads defaultView width)', () => {
    const { open } = setup({ clampToViewport: true });
    open();
    const dialog = dialogEl()!;
    // Clamp path always yields a left inset (never a right one).
    expect(dialog.style.left).not.toBe('');
    expect(dialog.style.right).toBe('');
  });

  it('clampToViewport tolerates a realm without a defaultView (viewport width reads 0)', () => {
    const doc = document.implementation.createHTMLDocument('');
    const trigger = doc.createElement('button');
    doc.body.appendChild(trigger);
    const content = doc.createElement('div');
    const handle = openAnchoredDialog({
      document: doc, trigger, ariaLabel: 'x', content,
      dialogClassName: 'pv-popover', clampToViewport: true,
    });
    const dialog = doc.querySelector('.pv-popover') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.style.left).not.toBe('');
    handle.close();
  });
});

describe('openAnchoredDialog — dismissal paths', () => {
  it('Escape closes and returns focus to the trigger; onClose fires', () => {
    const { trigger, open, onClose } = setup();
    const handle = open();
    key(dialogEl()!, 'Escape');
    expect(handle.isOpen()).toBe(false);
    expect(dialogEl()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a non-Escape key does not close', () => {
    const { open } = setup();
    const handle = open();
    key(dialogEl()!, 'a');
    expect(handle.isOpen()).toBe(true);
  });

  it('a backdrop mousedown+click closes; onClose fires', () => {
    const { open, onClose } = setup();
    const handle = open();
    const overlay = overlayEl()!;
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(handle.isOpen()).toBe(false);
    expect(dialogEl()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close() is idempotent — a second call neither throws nor re-fires onClose', () => {
    const { open, onClose } = setup();
    const handle = open();
    handle.close();
    expect(() => handle.close()).not.toThrow();
    expect(handle.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close({ skipFocus: true }) tears down but leaves the trigger unfocused', () => {
    const { trigger, open } = setup();
    const handle = open();
    // Move focus off the trigger first so a skipped focus-return is observable.
    const input = document.querySelector('.pv-input') as HTMLInputElement;
    input.focus();
    handle.close({ skipFocus: true });
    expect(dialogEl()).toBeNull();
    expect(document.activeElement).not.toBe(trigger);
  });
});

describe('openAnchoredDialog — Tab focus trap', () => {
  const tab = (target: EventTarget, shiftKey = false): boolean => key(target, 'Tab', shiftKey);

  it('Tab from the last focusable wraps to the first', () => {
    const { open, input, button } = setup();
    open();
    button.focus(); // last focusable
    tab(dialogEl()!);
    expect(document.activeElement).toBe(input); // first
  });

  it('Shift+Tab from the first focusable wraps to the last', () => {
    const { open, input, button } = setup();
    open();
    input.focus(); // first focusable
    tab(dialogEl()!, true);
    expect(document.activeElement).toBe(button); // last
  });

  it('recomputes the focusable set on every press: disabling the last row moves the wrap target', () => {
    // Three rows; disable the last so the trap must recompute rather than reuse
    // a cached list.
    const trigger = h('button', {}) as HTMLButtonElement;
    document.body.appendChild(trigger);
    const a = h('input', { class: 'r-a' }) as HTMLInputElement;
    const b = h('button', { class: 'r-b' }) as HTMLButtonElement;
    const c = h('button', { class: 'r-c' }) as HTMLButtonElement;
    const content = h('div', { style: { display: 'contents' } }, a, b, c);
    openAnchoredDialog({ document, trigger, ariaLabel: 'x', content, dialogClassName: 'pv-popover' });
    c.disabled = true; // now the last focusable is b
    b.focus();
    tab(dialogEl()!); // from the (new) last → wraps to first (a)
    expect(document.activeElement).toBe(a);
  });

  it('a hidden row is excluded from the trap', () => {
    const trigger = h('button', {}) as HTMLButtonElement;
    document.body.appendChild(trigger);
    const a = h('input', { class: 'r-a' }) as HTMLInputElement;
    const wrap = h('div', { hidden: true }, h('button', { class: 'r-b' }));
    const c = h('button', { class: 'r-c' }) as HTMLButtonElement;
    const content = h('div', { style: { display: 'contents' } }, a, wrap, c);
    openAnchoredDialog({ document, trigger, ariaLabel: 'x', content, dialogClassName: 'pv-popover' });
    c.focus(); // last visible focusable
    tab(dialogEl()!);
    expect(document.activeElement).toBe(a);
  });

  it('Tab from a middle element does not trap (browser default order applies)', () => {
    const trigger = h('button', {}) as HTMLButtonElement;
    document.body.appendChild(trigger);
    const a = h('input', { class: 'r-a' }) as HTMLInputElement;
    const b = h('input', { class: 'r-b' }) as HTMLInputElement;
    const c = h('button', { class: 'r-c' }) as HTMLButtonElement;
    const content = h('div', { style: { display: 'contents' } }, a, b, c);
    openAnchoredDialog({ document, trigger, ariaLabel: 'x', content, dialogClassName: 'pv-popover' });
    b.focus(); // middle
    const forward = tab(dialogEl()!);
    const backward = tab(dialogEl()!, true);
    expect(forward).toBe(true); // not preventDefault-ed
    expect(backward).toBe(true);
  });

  it('a non-Tab key inside the dialog is ignored by the trap', () => {
    const { open, button } = setup();
    open();
    button.focus();
    const handled = key(dialogEl()!, 'ArrowDown');
    expect(handled).toBe(true); // not preventDefault-ed
    expect(document.activeElement).toBe(button); // focus unchanged
  });

  it('Tab with no focusable content is a no-op (empty-set guard)', () => {
    const trigger = h('button', {}) as HTMLButtonElement;
    document.body.appendChild(trigger);
    const content = h('div', {}, h('span', {}, 'no focusables here'));
    openAnchoredDialog({ document, trigger, ariaLabel: 'x', content, dialogClassName: 'pv-popover' });
    const handled = tab(dialogEl()!);
    expect(handled).toBe(true); // untrapped — browser handles it
  });
});

describe('openAnchoredDialog — initialFocus', () => {
  it('focuses the element the callback returns', () => {
    const { open, input } = setup({ initialFocus: (dialog) => dialog.querySelector('.pv-input') });
    open();
    expect(document.activeElement).toBe(input);
  });

  it('omitting initialFocus (or returning null) leaves focus where it was', () => {
    const { trigger, open } = setup({ initialFocus: () => null });
    trigger.focus();
    open();
    expect(document.activeElement).toBe(trigger);
  });
});
