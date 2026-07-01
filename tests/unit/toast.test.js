import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flashToast } from '../../src/ui/toast.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('flashToast', () => {
  it('creates a toast, shows it, and schedules hide', () => {
    const setTimeout = vi.fn(() => 7);
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
    const setTimeout = vi.fn(() => 1);
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
    const setTimeout = vi.fn(() => 42);
    const clearTimeout = vi.fn();
    const el = flashToast('hi', { document, setTimeout, clearTimeout, duration: 999 });
    expect(el.classList.contains('show')).toBe(true);
    el.click();
    expect(el.classList.contains('show')).toBe(false);
    expect(clearTimeout).toHaveBeenCalledWith(42);
  });
  it('a stale auto-dismiss timer firing after a manual dismiss is a harmless no-op', () => {
    const setTimeout = vi.fn(() => 5);
    const clearTimeout = vi.fn();
    const el = flashToast('hi', { document, setTimeout, clearTimeout, duration: 999 });
    el.click();
    expect(() => setTimeout.mock.calls[0][0]()).not.toThrow();
    expect(el.classList.contains('show')).toBe(false);
  });
  it('clicking after the auto-dismiss already fired clears no stale timer', () => {
    const setTimeout = vi.fn(() => 9);
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
    const mainEl = flashToast('main', { document, setTimeout: vi.fn(() => 1), clearTimeout: mainClear, duration: 500 });
    const otherEl = flashToast('other', { document: otherDoc, setTimeout: vi.fn(() => 2), clearTimeout: otherClear, duration: 500 });
    expect(mainEl).not.toBe(otherEl);
    // Flashing the other document's toast again must not touch the main toast's timer.
    flashToast('other again', { document: otherDoc, setTimeout: vi.fn(() => 3), clearTimeout: otherClear, duration: 500 });
    expect(mainClear).not.toHaveBeenCalled();
    expect(otherClear).toHaveBeenCalledWith(2);
    expect(mainEl.classList.contains('show')).toBe(true);
  });
});
