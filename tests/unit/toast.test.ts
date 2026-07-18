import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flashToast } from '../../src/ui/toast.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

// vi.fn(() => id) alone infers a 0-arg mock (from the implementation's own
// arity), so `.mock.calls[0][0]` — the scheduled hide callback flashToast
// passed in — would be a type error (an empty-tuple index). Pin the mock to
// the real injected-seam shape (see toast.ts's ToastOptions.setTimeout) so
// its recorded calls carry that shape instead.
const fakeSetTimeout = (id: number) => vi.fn<(handler: () => void, ms: number) => number>(() => id);

describe('flashToast', () => {
  it('creates a toast, shows it, and schedules hide', () => {
    const setTimeout = fakeSetTimeout(7);
    const el = flashToast('hello', { document, setTimeout, duration: 500 });
    expect(el.textContent).toBe('hello');
    expect(el.classList.contains('show')).toBe(true);
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 500);
    // run the scheduled hide
    setTimeout.mock.calls[0][0]();
    expect(el.classList.contains('show')).toBe(false);
  });
  it('reuses the existing toast element and clears the prior timer', () => {
    const clearTimeout = vi.fn();
    const setTimeout = fakeSetTimeout(1);
    const a = flashToast('one', { document, setTimeout, clearTimeout });
    const b = flashToast('two', { document, setTimeout, clearTimeout });
    expect(a).toBe(b);
    expect(b.textContent).toBe('two');
    expect(clearTimeout).toHaveBeenCalledWith(1);
    expect(document.querySelectorAll('.share-toast')).toHaveLength(1);
  });
  it('defaults document/timers (smoke)', () => {
    const el = flashToast('x');
    expect(el.classList.contains('show')).toBe(true);
  });
  it('clicking a visible toast dismisses it immediately and clears the pending timer', () => {
    const setTimeout = fakeSetTimeout(42);
    const clearTimeout = vi.fn();
    const el = flashToast('hi', { document, setTimeout, clearTimeout, duration: 999 });
    expect(el.classList.contains('show')).toBe(true);
    el.click();
    expect(el.classList.contains('show')).toBe(false);
    expect(clearTimeout).toHaveBeenCalledWith(42);
  });
  it('a stale auto-dismiss timer firing after a manual dismiss is a harmless no-op', () => {
    const setTimeout = fakeSetTimeout(5);
    const clearTimeout = vi.fn();
    const el = flashToast('hi', { document, setTimeout, clearTimeout, duration: 999 });
    el.click();
    expect(() => setTimeout.mock.calls[0][0]()).not.toThrow();
    expect(el.classList.contains('show')).toBe(false);
  });
  it('clicking after the auto-dismiss already fired clears no stale timer', () => {
    const setTimeout = fakeSetTimeout(9);
    const clearTimeout = vi.fn();
    const el = flashToast('hi', { document, setTimeout, clearTimeout, duration: 100 });
    setTimeout.mock.calls[0][0](); // auto-hide fires first
    clearTimeout.mockClear();
    el.click();
    expect(clearTimeout).not.toHaveBeenCalled();
  });
  it('a toast in a different document (e.g. a detached tab) tracks its own timer, independent of one in the main document', () => {
    const otherDoc = document.implementation.createHTMLDocument('');
    const mainClear = vi.fn();
    const otherClear = vi.fn();
    const mainEl = flashToast('main', { document, setTimeout: fakeSetTimeout(1), clearTimeout: mainClear, duration: 500 });
    const otherEl = flashToast('other', { document: otherDoc, setTimeout: fakeSetTimeout(2), clearTimeout: otherClear, duration: 500 });
    expect(mainEl).not.toBe(otherEl);
    // Flashing the other document's toast again must not touch the main toast's timer.
    flashToast('other again', { document: otherDoc, setTimeout: fakeSetTimeout(3), clearTimeout: otherClear, duration: 500 });
    expect(mainClear).not.toHaveBeenCalled();
    expect(otherClear).toHaveBeenCalledWith(2);
    expect(mainEl.classList.contains('show')).toBe(true);
  });

  describe('action button (#300)', () => {
    it('renders a button with the given label and does not schedule an auto-dismiss timer', () => {
      const setTimeout = fakeSetTimeout(1);
      const onClick = vi.fn();
      const el = flashToast('corrupt workspace', {
        document, setTimeout, action: { label: 'Reset workspace', onClick },
      });
      const button = el.querySelector('button.share-toast-action') as HTMLButtonElement | null;
      expect(button).not.toBeNull();
      expect(button!.textContent).toBe('Reset workspace');
      expect(el.textContent).toContain('corrupt workspace');
      expect(setTimeout).not.toHaveBeenCalled();
    });

    it('clicking the action button runs onClick, dismisses the toast, and does not also fire the body dismiss handler', () => {
      const clearTimeout = vi.fn();
      const onClick = vi.fn();
      const el = flashToast('corrupt workspace', {
        document, clearTimeout, action: { label: 'Reset workspace', onClick },
      });
      const button = el.querySelector('button.share-toast-action') as HTMLButtonElement;
      button.click();
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(el.classList.contains('show')).toBe(false);
      // No pending timer was ever set for an actionable toast, so a body
      // click-to-dismiss never has anything to clear.
      expect(clearTimeout).not.toHaveBeenCalled();
    });

    it('a later text-only flashToast on the same reused element clears the previous action button', () => {
      const el = flashToast('corrupt workspace', {
        document, action: { label: 'Reset workspace', onClick: vi.fn() },
      });
      expect(el.querySelector('button.share-toast-action')).not.toBeNull();
      const el2 = flashToast('plain message', { document, setTimeout: fakeSetTimeout(3) });
      expect(el2).toBe(el);
      expect(el2.querySelector('button.share-toast-action')).toBeNull();
      expect(el2.textContent).toBe('plain message');
    });

    it('clicking the toast body (not the button) still dismisses an actionable toast without invoking onClick', () => {
      const onClick = vi.fn();
      const el = flashToast('corrupt workspace', {
        document, action: { label: 'Reset workspace', onClick },
      });
      el.click();
      expect(onClick).not.toHaveBeenCalled();
      expect(el.classList.contains('show')).toBe(false);
    });
  });
});
