// Pure math + a small controller for the dashboard tile-drag edge auto-scroll
// (#338, extends the #332 Command/Ctrl grip-drag tile move). No DOM, no
// globals, no Date.now/Math.random — the DOM wrapper (ui/dashboard.ts) injects
// a real element-backed `DragAutoScrollTarget` and a real `requestAnimationFrame`
// `FrameScheduler`; tests drive both with fakes, exactly like tile-reorder.ts's
// split between pure geometry and the DOM gesture wiring.

/** Pointer distance (px) from the visible top/bottom edge inside which the
 *  drag starts auto-scrolling. */
export const AUTO_SCROLL_EDGE_PX = 80;

/** Slowest auto-scroll speed (px/frame), applied just inside an edge zone. */
export const AUTO_SCROLL_MIN_PX_PER_FRAME = 3;

/** Fastest auto-scroll speed (px/frame), applied at/beyond the viewport edge. */
export const AUTO_SCROLL_MAX_PX_PER_FRAME = 24;

/** The bounded top speed used instead of `AUTO_SCROLL_MAX_PX_PER_FRAME` when
 *  the user prefers reduced motion. */
export const AUTO_SCROLL_REDUCED_MAX_PX_PER_FRAME = 8;

export interface EdgeVelocityInput {
  pointerY: number;
  /** The effective top of the visible scroll viewport — already below any
   *  sticky chrome (e.g. the Dashboard topbar). */
  visibleTop: number;
  visibleBottom: number;
  edgePx?: number;
  minPx?: number;
  maxPx?: number;
  /** When true, the effective max speed is capped to
   *  `AUTO_SCROLL_REDUCED_MAX_PX_PER_FRAME` (never exceeds `maxPx` either). */
  reducedMotion?: boolean;
}

/**
 * Signed auto-scroll speed in px/frame for the current pointer Y against the
 * visible viewport: negative scrolls up, positive scrolls down, 0 is the dead
 * center zone. Proportional acceleration inside each edge zone (nearer the
 * edge = faster), clamped to the effective max at/beyond the viewport edge.
 *
 * A degenerate viewport (`visibleBottom <= visibleTop`, e.g. an unmeasured
 * element) returns 0 — never divide by zero, never spuriously scroll. In a
 * short viewport where the top and bottom edge zones overlap, the top zone's
 * condition is checked first, so a pointer in the shared middle scrolls up;
 * this only matters when the viewport is shorter than 2×`edgePx`.
 */
export function edgeScrollVelocity(input: EdgeVelocityInput): number {
  const {
    pointerY, visibleTop, visibleBottom,
    edgePx = AUTO_SCROLL_EDGE_PX,
    minPx = AUTO_SCROLL_MIN_PX_PER_FRAME,
    maxPx = AUTO_SCROLL_MAX_PX_PER_FRAME,
    reducedMotion = false,
  } = input;
  if (visibleBottom <= visibleTop) return 0;
  const effectiveMax = reducedMotion ? Math.min(maxPx, AUTO_SCROLL_REDUCED_MAX_PX_PER_FRAME) : maxPx;

  if (pointerY <= visibleTop) return -effectiveMax;
  if (pointerY < visibleTop + edgePx) {
    const frac = (visibleTop + edgePx - pointerY) / edgePx;
    return -(minPx + (effectiveMax - minPx) * frac);
  }
  if (pointerY >= visibleBottom) return effectiveMax;
  if (pointerY > visibleBottom - edgePx) {
    const frac = (pointerY - (visibleBottom - edgePx)) / edgePx;
    return minPx + (effectiveMax - minPx) * frac;
  }
  return 0;
}

/** The scrollable element the auto-scroll controller drives — injected so the
 *  pure controller never touches the DOM directly. */
export interface DragAutoScrollTarget {
  visibleTop(): number;
  visibleBottom(): number;
  /** Applies a scroll delta (already clamped to the scrollable range by the
   *  caller) and returns the ACTUAL delta applied, after the target's own
   *  boundary clamping. */
  scrollBy(deltaY: number): number;
  canScrollUp(): boolean;
  canScrollDown(): boolean;
}

/** The injected animation-frame seam — real `requestAnimationFrame` in
 *  ui/dashboard.ts, a manually-drained fake queue in tests. */
export interface FrameScheduler {
  request(cb: () => void): number;
  cancel(handle: number): void;
}

export interface DragAutoScrollOptions {
  reducedMotion?: boolean;
  edgePx?: number;
  minPx?: number;
  maxPx?: number;
  /** Called once per frame that actually applies a nonzero scroll, with the
   *  applied delta — the caller uses this to recompute the drag destination
   *  preview against the newly-scrolled positions. */
  onScrollFrame?: (appliedDelta: number) => void;
}

export interface DragAutoScrollController {
  /** Records the latest pointer Y and (re)starts the frame loop when it falls
   *  in a scrollable edge zone and no loop is already running. */
  setPointerY(y: number): void;
  /** Idempotent: cancels any pending frame and stops the loop. Safe to call
   *  any number of times, including after the loop has already gone idle. */
  stop(): void;
  /** True while a frame is scheduled (the drag is actively auto-scrolling). */
  isRunning(): boolean;
}

/**
 * A single-loop auto-scroll controller: at most one frame is ever pending.
 * Each scheduled frame reads the LATEST pointer Y (via `setPointerY`), so a
 * stationary pointer inside an edge zone keeps scrolling every frame, and a
 * pointer that leaves the edge zone (or hits a scroll boundary) lets the loop
 * idle on its own — without tearing the controller down. `stop()` is the only
 * way to force teardown early (drag release/cancel).
 */
export function createDragAutoScroll(
  target: DragAutoScrollTarget,
  scheduler: FrameScheduler,
  opts: DragAutoScrollOptions = {},
): DragAutoScrollController {
  let pointerY = 0;
  let running = false;
  let handle: number | null = null;

  const velocityNow = (): number => edgeScrollVelocity({
    pointerY,
    visibleTop: target.visibleTop(),
    visibleBottom: target.visibleBottom(),
    edgePx: opts.edgePx,
    minPx: opts.minPx,
    maxPx: opts.maxPx,
    reducedMotion: opts.reducedMotion,
  });

  const frame = (): void => {
    // A stop() issued between scheduling and this callback firing must not
    // mutate anything — guard at the very top.
    if (!running) return;
    handle = null;
    const v = velocityNow();
    let applied = 0;
    if (v < 0 && target.canScrollUp()) applied = target.scrollBy(v);
    else if (v > 0 && target.canScrollDown()) applied = target.scrollBy(v);
    if (applied !== 0) {
      opts.onScrollFrame?.(applied);
      handle = scheduler.request(frame);
    } else {
      running = false;
    }
  };

  const start = (): void => {
    running = true;
    handle = scheduler.request(frame);
  };

  return {
    setPointerY(y: number): void {
      pointerY = y;
      if (running) return;
      const v = velocityNow();
      if ((v < 0 && target.canScrollUp()) || (v > 0 && target.canScrollDown())) start();
    },
    stop(): void {
      if (handle != null) scheduler.cancel(handle);
      handle = null;
      running = false;
    },
    isRunning(): boolean {
      return running;
    },
  };
}
