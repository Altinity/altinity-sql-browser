import { describe, expect, it, vi } from 'vitest';
import { createClickArbiter, DBLCLICK_MS } from '../../src/core/tree-click-arbiter.js';

/** A manual clock, so nothing here depends on real timers or on the DOM. */
const clock = (delayMs?: number) => {
  let next = 1;
  const timers = new Map<number, () => void>();
  const arbiter = createClickArbiter({
    setTimeout: (fn) => { const handle = next++; timers.set(handle, fn); return handle; },
    clearTimeout: (handle) => { timers.delete(handle); },
    ...(delayMs === undefined ? {} : { delayMs }),
  });
  return {
    arbiter,
    /** Fire every scheduled callback, as the double-click window closing would. */
    tick: () => { const due = [...timers.values()]; timers.clear(); due.forEach((fn) => fn()); },
    pending: () => timers.size,
  };
};

describe('createClickArbiter', () => {
  it('defers a single action until the double-click window closes', () => {
    const single = vi.fn();
    const { arbiter, tick, pending } = clock();
    arbiter.press('row', { single });
    // THE point of arbitration: a panel row must not open its query on the first
    // click, or a double-click would flash the Query surface on its way through.
    expect(single).not.toHaveBeenCalled();
    expect(pending()).toBe(1);
    tick();
    expect(single).toHaveBeenCalledOnce();
  });

  it('a second press on the same row cancels the single and runs the double once', () => {
    const single = vi.fn(); const double = vi.fn();
    const { arbiter, tick, pending } = clock();
    arbiter.press('row', { single, double });
    arbiter.press('row', { single, double });
    expect(double).toHaveBeenCalledOnce();
    expect(single).not.toHaveBeenCalled();
    // Nothing is left armed, so the window cannot fire the single afterwards.
    expect(pending()).toBe(0);
    tick();
    expect(single).not.toHaveBeenCalled();
    expect(double).toHaveBeenCalledOnce();
  });

  it('opens the window for a row that has NO single action, so its double still fires', () => {
    // A source-less transitional filter: query-open is disabled, but double-click
    // and Shift-click keep working (#426's transitional data rules).
    const double = vi.fn();
    const { arbiter, tick } = clock();
    arbiter.press('filter', { single: null, double });
    tick(); // the window closes with nothing to run
    expect(double).not.toHaveBeenCalled();
    arbiter.press('filter', { single: null, double });
    arbiter.press('filter', { single: null, double });
    expect(double).toHaveBeenCalledOnce();
  });

  it('runs an immediate (Shift) action now, cancelling a pending single', () => {
    const single = vi.fn(); const immediate = vi.fn();
    const { arbiter, tick, pending } = clock();
    arbiter.press('row', { single });
    arbiter.press('row', { single, immediate });
    expect(immediate).toHaveBeenCalledOnce();
    expect(pending()).toBe(0);
    tick();
    expect(single).not.toHaveBeenCalled();
  });

  it('an immediate action with no pending press still runs', () => {
    const immediate = vi.fn();
    const { arbiter } = clock();
    arbiter.press('row', { immediate });
    expect(immediate).toHaveBeenCalledOnce();
  });

  it('a press on a DIFFERENT row abandons the first row\'s single without running it', () => {
    const first = vi.fn(); const second = vi.fn(); const double = vi.fn();
    const { arbiter, tick } = clock();
    arbiter.press('a', { single: first, double });
    arbiter.press('b', { single: second, double });
    // Not a repeat, so no double — and row a's deferred action is dropped, never
    // delivered late against a row the user has moved off.
    expect(double).not.toHaveBeenCalled();
    tick();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('cancel() drops a pending single (tree disposal, workspace or role change)', () => {
    const single = vi.fn();
    const { arbiter, tick, pending } = clock();
    arbiter.press('row', { single });
    arbiter.cancel();
    expect(pending()).toBe(0);
    tick();
    expect(single).not.toHaveBeenCalled();
  });

  it('cancel() with nothing pending is a no-op, and is idempotent', () => {
    const { arbiter, pending } = clock();
    arbiter.cancel();
    arbiter.cancel();
    expect(pending()).toBe(0);
  });

  it('cancelFor drops ONLY the named row\'s pending single', () => {
    const single = vi.fn();
    const { arbiter, tick } = clock();
    arbiter.press('a', { single });
    // #426: a row's action-menu button must cancel its own row's pending click and
    // "cancel no unrelated row operation".
    arbiter.cancelFor('b');
    tick();
    expect(single).toHaveBeenCalledOnce();
  });

  it('cancelFor drops the pending single when it IS the named row', () => {
    const single = vi.fn();
    const { arbiter, tick, pending } = clock();
    arbiter.press('a', { single });
    arbiter.cancelFor('a');
    expect(pending()).toBe(0);
    tick();
    expect(single).not.toHaveBeenCalled();
  });

  it('cancelFor with nothing pending is a no-op', () => {
    const { arbiter, pending } = clock();
    arbiter.cancelFor('a');
    expect(pending()).toBe(0);
  });

  it('a press after the window has closed is a fresh press, not a repeat', () => {
    const single = vi.fn(); const double = vi.fn();
    const { arbiter, tick } = clock();
    arbiter.press('row', { single, double });
    tick();
    expect(single).toHaveBeenCalledOnce();
    arbiter.press('row', { single, double });
    expect(double).not.toHaveBeenCalled();
    tick();
    expect(single).toHaveBeenCalledTimes(2);
  });

  it('schedules on the shared double-click window by default', () => {
    const delays: number[] = [];
    const arbiter = createClickArbiter({
      setTimeout: (_fn, ms) => { delays.push(ms); return 1; },
      clearTimeout: () => {},
    });
    arbiter.press('row', { single: () => {} });
    expect(delays).toEqual([DBLCLICK_MS]);
    expect(DBLCLICK_MS).toBe(300);
  });

  it('honours an overridden window', () => {
    const delays: number[] = [];
    const arbiter = createClickArbiter({
      setTimeout: (_fn, ms) => { delays.push(ms); return 1; },
      clearTimeout: () => {},
      delayMs: 40,
    });
    arbiter.press('row', { single: () => {} });
    expect(delays).toEqual([40]);
  });
});
