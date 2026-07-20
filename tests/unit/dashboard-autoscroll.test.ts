import { describe, it, expect, vi } from 'vitest';
import {
  AUTO_SCROLL_EDGE_PX, AUTO_SCROLL_MIN_PX_PER_FRAME, AUTO_SCROLL_MAX_PX_PER_FRAME,
  AUTO_SCROLL_REDUCED_MAX_PX_PER_FRAME,
  edgeScrollVelocity, createDragAutoScroll,
  type DragAutoScrollTarget, type FrameScheduler,
} from '../../src/core/dashboard-autoscroll.js';

describe('edgeScrollVelocity', () => {
  const viewport = { visibleTop: 100, visibleBottom: 500 }; // 400px tall

  it('is 0 dead-center', () => {
    expect(edgeScrollVelocity({ pointerY: 300, ...viewport })).toBe(0);
  });
  it('is 0 exactly at the inner edge-zone boundary (top)', () => {
    expect(edgeScrollVelocity({ pointerY: viewport.visibleTop + AUTO_SCROLL_EDGE_PX, ...viewport })).toBe(0);
  });
  it('is 0 exactly at the inner edge-zone boundary (bottom)', () => {
    expect(edgeScrollVelocity({ pointerY: viewport.visibleBottom - AUTO_SCROLL_EDGE_PX, ...viewport })).toBe(0);
  });
  it('scrolls up (negative) inside the top edge zone', () => {
    const v = edgeScrollVelocity({ pointerY: viewport.visibleTop + 40, ...viewport });
    expect(v).toBeLessThan(0);
  });
  it('scrolls down (positive) inside the bottom edge zone', () => {
    const v = edgeScrollVelocity({ pointerY: viewport.visibleBottom - 40, ...viewport });
    expect(v).toBeGreaterThan(0);
  });
  it('accelerates nearer the edge (top)', () => {
    const nearCenter = edgeScrollVelocity({ pointerY: viewport.visibleTop + 79, ...viewport });
    const nearEdge = edgeScrollVelocity({ pointerY: viewport.visibleTop + 1, ...viewport });
    expect(Math.abs(nearEdge)).toBeGreaterThan(Math.abs(nearCenter));
  });
  it('accelerates nearer the edge (bottom)', () => {
    const nearCenter = edgeScrollVelocity({ pointerY: viewport.visibleBottom - 79, ...viewport });
    const nearEdge = edgeScrollVelocity({ pointerY: viewport.visibleBottom - 1, ...viewport });
    expect(nearEdge).toBeGreaterThan(nearCenter);
  });
  it('clamps to -max at/above the top of the viewport', () => {
    expect(edgeScrollVelocity({ pointerY: viewport.visibleTop, ...viewport })).toBe(-AUTO_SCROLL_MAX_PX_PER_FRAME);
    expect(edgeScrollVelocity({ pointerY: viewport.visibleTop - 50, ...viewport })).toBe(-AUTO_SCROLL_MAX_PX_PER_FRAME);
  });
  it('clamps to +max at/below the bottom of the viewport', () => {
    expect(edgeScrollVelocity({ pointerY: viewport.visibleBottom, ...viewport })).toBe(AUTO_SCROLL_MAX_PX_PER_FRAME);
    expect(edgeScrollVelocity({ pointerY: viewport.visibleBottom + 50, ...viewport })).toBe(AUTO_SCROLL_MAX_PX_PER_FRAME);
  });
  it('reducedMotion caps the max speed', () => {
    expect(edgeScrollVelocity({ pointerY: viewport.visibleTop, ...viewport, reducedMotion: true }))
      .toBe(-AUTO_SCROLL_REDUCED_MAX_PX_PER_FRAME);
    expect(edgeScrollVelocity({ pointerY: viewport.visibleBottom, ...viewport, reducedMotion: true }))
      .toBe(AUTO_SCROLL_REDUCED_MAX_PX_PER_FRAME);
  });
  it('reducedMotion never exceeds an explicit maxPx smaller than the reduced cap', () => {
    expect(edgeScrollVelocity({ pointerY: viewport.visibleTop, ...viewport, reducedMotion: true, maxPx: 2 })).toBe(-2);
  });
  it('degenerate viewport (bottom <= top) returns 0', () => {
    expect(edgeScrollVelocity({ pointerY: 50, visibleTop: 100, visibleBottom: 100 })).toBe(0);
    expect(edgeScrollVelocity({ pointerY: 50, visibleTop: 100, visibleBottom: 50 })).toBe(0);
  });
  it('a short viewport with overlapping edge zones resolves the top zone first', () => {
    // 60px viewport, 80px edge zones overlap entirely — the shared midpoint
    // must resolve to the (checked-first) top/up zone, never both/neither.
    const v = edgeScrollVelocity({ pointerY: 130, visibleTop: 100, visibleBottom: 160 });
    expect(v).toBeLessThan(0);
  });
  it('respects custom edgePx/minPx/maxPx', () => {
    const v = edgeScrollVelocity({
      pointerY: viewport.visibleBottom - 5, ...viewport, edgePx: 10, minPx: 1, maxPx: 10,
    });
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(10);
  });
});

// ── createDragAutoScroll ─────────────────────────────────────────────────────

/** A manually-drained fake `FrameScheduler` — `request` queues the callback
 *  instead of scheduling a real animation frame; `flush()` runs every queued
 *  callback once (in FIFO order), mirroring one browser paint tick. */
function fakeScheduler(): FrameScheduler & { flush(): void; pending: number; lastRequested: (() => void) | null } {
  let queue: { id: number; cb: () => void }[] = [];
  let nextId = 1;
  let lastRequested: (() => void) | null = null;
  return {
    request(cb: () => void): number {
      const id = nextId++;
      queue.push({ id, cb });
      lastRequested = cb; // kept even past cancel(), to simulate a real rAF
      // callback that is already in flight (browser-scheduled) when stop()
      // cancels it — the controller's own `running` guard, not the scheduler,
      // must be what blocks the mutation.
      return id;
    },
    cancel(id: number): void {
      queue = queue.filter((q) => q.id !== id);
    },
    flush(): void {
      const run = queue;
      queue = [];
      for (const q of run) q.cb();
    },
    get pending(): number {
      return queue.length;
    },
    get lastRequested(): (() => void) | null {
      return lastRequested;
    },
  };
}

/** A fake scrollable target: a mutable scrollTop model over `[0, maxScroll]`,
 *  clamping `scrollBy` and reporting the actual applied delta, exactly the
 *  contract the DOM adapter (ui/dashboard.ts) implements over a real element. */
function fakeTarget(opts: { visibleTop?: number; visibleBottom?: number; maxScroll?: number; scrollTop?: number } = {}) {
  const visibleTop = opts.visibleTop ?? 100;
  const visibleBottom = opts.visibleBottom ?? 500;
  const maxScroll = opts.maxScroll ?? 1000;
  let scrollTop = opts.scrollTop ?? 0;
  const target: DragAutoScrollTarget = {
    visibleTop: () => visibleTop,
    visibleBottom: () => visibleBottom,
    scrollBy: (dy: number): number => {
      const next = Math.max(0, Math.min(maxScroll, scrollTop + dy));
      const applied = next - scrollTop;
      scrollTop = next;
      return applied;
    },
    canScrollUp: () => scrollTop > 0,
    canScrollDown: () => scrollTop < maxScroll,
  };
  // A plain function, not a getter property — destructuring a getter at call
  // time would snapshot the value once, silently going stale as `scrollBy`
  // mutates the closed-over `scrollTop` afterward.
  return { target, scrollTop: (): number => scrollTop };
}

describe('createDragAutoScroll', () => {
  it('schedules only one pending frame even when setPointerY is called twice in the edge zone', () => {
    const scheduler = fakeScheduler();
    const { target } = fakeTarget({ scrollTop: 500 }); // room to scroll up
    const ctl = createDragAutoScroll(target, scheduler);
    ctl.setPointerY(110); // top edge zone (visibleTop=100)
    expect(scheduler.pending).toBe(1);
    ctl.setPointerY(115); // still edge zone — must NOT schedule a second frame
    expect(scheduler.pending).toBe(1);
    expect(ctl.isRunning()).toBe(true);
  });

  it('a stationary pointer in the edge zone keeps scrolling frame after frame, calling onScrollFrame', () => {
    const scheduler = fakeScheduler();
    const { target, scrollTop } = fakeTarget({ scrollTop: 500 }); // room to scroll up
    const onScrollFrame = vi.fn();
    const ctl = createDragAutoScroll(target, scheduler, { onScrollFrame });
    ctl.setPointerY(110); // top edge zone → scrolls up (negative)
    const before = scrollTop();
    scheduler.flush();
    expect(scrollTop()).toBeLessThan(before);
    expect(onScrollFrame).toHaveBeenCalledTimes(1);
    const afterOne = scrollTop();
    scheduler.flush();
    expect(scrollTop()).toBeLessThan(afterOne);
    expect(onScrollFrame).toHaveBeenCalledTimes(2);
    expect(ctl.isRunning()).toBe(true);
  });

  it('a stationary pointer in the bottom edge zone scrolls down', () => {
    const scheduler = fakeScheduler();
    const { target, scrollTop } = fakeTarget({ scrollTop: 0, maxScroll: 1000 }); // room to scroll down
    const onScrollFrame = vi.fn();
    const ctl = createDragAutoScroll(target, scheduler, { onScrollFrame });
    ctl.setPointerY(490); // bottom edge zone (visibleBottom=500) → scrolls down (positive)
    scheduler.flush();
    expect(scrollTop()).toBeGreaterThan(0);
    expect(onScrollFrame).toHaveBeenCalledTimes(1);
  });

  it('leaving the edge zone lets the next frame apply 0 and the loop idles', () => {
    const scheduler = fakeScheduler();
    const { target } = fakeTarget({ scrollTop: 500 });
    const ctl = createDragAutoScroll(target, scheduler);
    ctl.setPointerY(110);
    expect(ctl.isRunning()).toBe(true);
    ctl.setPointerY(300); // dead center now — the ALREADY-SCHEDULED frame reads this latest y
    scheduler.flush();
    expect(ctl.isRunning()).toBe(false);
    expect(scheduler.pending).toBe(0);
  });

  it('a stopped-then-re-armed controller restarts from a later setPointerY in an edge zone', () => {
    const scheduler = fakeScheduler();
    const { target } = fakeTarget({ scrollTop: 500 });
    const ctl = createDragAutoScroll(target, scheduler);
    ctl.setPointerY(110);
    ctl.setPointerY(300);
    scheduler.flush(); // idles
    expect(ctl.isRunning()).toBe(false);
    ctl.setPointerY(110); // edge zone again
    expect(ctl.isRunning()).toBe(true);
    expect(scheduler.pending).toBe(1);
  });

  it('stop() cancels a pending frame and reports not running', () => {
    const scheduler = fakeScheduler();
    const { target } = fakeTarget({ scrollTop: 500 });
    const ctl = createDragAutoScroll(target, scheduler);
    ctl.setPointerY(110);
    expect(scheduler.pending).toBe(1);
    ctl.stop();
    expect(scheduler.pending).toBe(0);
    expect(ctl.isRunning()).toBe(false);
  });

  it('teardown is idempotent — stop() twice never throws', () => {
    const scheduler = fakeScheduler();
    const { target } = fakeTarget({ scrollTop: 500 });
    const ctl = createDragAutoScroll(target, scheduler);
    ctl.setPointerY(110);
    ctl.stop();
    expect(() => ctl.stop()).not.toThrow();
    expect(ctl.isRunning()).toBe(false);
  });

  it('stop() before a queued frame fires prevents any mutation when the queue is drained anyway', () => {
    const scheduler = fakeScheduler();
    const { target, scrollTop } = fakeTarget({ scrollTop: 500 });
    const onScrollFrame = vi.fn();
    const ctl = createDragAutoScroll(target, scheduler, { onScrollFrame });
    ctl.setPointerY(110);
    ctl.stop();
    // Simulate a frame that was already in flight (browser-scheduled) when
    // stop() was called: invoking the captured callback directly bypasses the
    // scheduler's own queue (already cleared by cancel) — only the
    // controller's internal `running` guard can still block the mutation.
    scheduler.lastRequested?.();
    expect(scrollTop()).toBe(500);
    expect(onScrollFrame).not.toHaveBeenCalled();
  });

  it('at a scroll boundary (canScrollDown false) the loop never starts / applies nothing', () => {
    const scheduler = fakeScheduler();
    const { target, scrollTop } = fakeTarget({ scrollTop: 1000, maxScroll: 1000 }); // already at max
    const onScrollFrame = vi.fn();
    const ctl = createDragAutoScroll(target, scheduler, { onScrollFrame });
    ctl.setPointerY(490); // bottom edge zone (visibleBottom=500) → would scroll down
    expect(ctl.isRunning()).toBe(false);
    expect(scheduler.pending).toBe(0);
    expect(scrollTop()).toBe(1000);
    expect(onScrollFrame).not.toHaveBeenCalled();
  });

  it('respects injected edgePx/minPx/maxPx/reducedMotion options end to end', () => {
    const scheduler = fakeScheduler();
    const { target, scrollTop } = fakeTarget({ scrollTop: 500 });
    const ctl = createDragAutoScroll(target, scheduler, { reducedMotion: true, edgePx: 10, minPx: 1, maxPx: 50 });
    ctl.setPointerY(100); // at the very top edge → -min(50, REDUCED_MAX)
    scheduler.flush();
    expect(scrollTop()).toBe(500 - AUTO_SCROLL_REDUCED_MAX_PX_PER_FRAME);
  });
});
