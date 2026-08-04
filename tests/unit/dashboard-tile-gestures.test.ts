import { describe, expect, it, vi } from 'vitest';
import { createTileGestureController } from '../../src/ui/dashboard-tile-gestures.js';
import type { GridPlacement, TileGestureDeps } from '../../src/ui/dashboard-tile-gestures.js';
import { snapGridHeight, snapGridSpan, GRID_GAP_PX, gridHeightUnitsToPx } from '../../src/dashboard/layouts/grafana-grid-layout.js';
import type { DashboardStyle } from '../../src/dashboard/application/dashboard-viewer-session.js';

// ── DOM fixtures ─────────────────────────────────────────────────────────────

/** A `.dash-gg-tile`-classed card with a stubbed, mutable
 *  `getBoundingClientRect` — real containment/overlap math (tile-reorder.ts)
 *  reads it, and happy-dom always returns an all-zero rect otherwise. Card `i`
 *  occupies a distinct box: x:[i*200, i*200+150], y:[0,50] — mirrors
 *  dashboard.test.ts's own `stubTileRects` convention. */
function makeCard(i: number): HTMLElement {
  const card = document.createElement('div');
  card.className = 'dash-gg-tile';
  const rect = {
    left: i * 200, right: i * 200 + 150, top: 0, bottom: 50, width: 150, height: 50, x: i * 200, y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  card.getBoundingClientRect = () => rect;
  const head = document.createElement('div');
  head.className = 'dash-tile-head';
  const grip = document.createElement('div');
  grip.className = 'dash-gg-grip';
  head.appendChild(grip);
  card.appendChild(head);
  return card;
}
const tileCenter = (i: number): { x: number; y: number } => ({ x: i * 200 + 75, y: 25 });

function makeHandle(): HTMLElement {
  return document.createElement('button');
}

interface DepsOverride extends Partial<TileGestureDeps> {
  placements?: Record<string, GridPlacement>;
}

/** A stub `TileGestureDeps` wired over two real (unattached) cards — enough
 *  DOM for the pure containment/overlap math to resolve against. Every getter
 *  can be overridden per test; `runCommand` is always a fresh spy so a test
 *  can assert on it directly. */
function makeDeps(over: DepsOverride = {}): {
  deps: TileGestureDeps; grid: HTMLElement; cards: HTMLElement[]; runCommand: ReturnType<typeof vi.fn>;
  invalidateGridStructure: ReturnType<typeof vi.fn>;
} {
  const grid = document.createElement('div');
  const cards = [makeCard(0), makeCard(1)];
  cards.forEach((c) => grid.appendChild(c));
  const runCommand = vi.fn();
  const invalidateGridStructure = vi.fn();
  const placements = over.placements ?? {};
  const { placements: _drop, ...rest } = over;
  const deps: TileGestureDeps = {
    document,
    grid,
    runCommand,
    activeEngine: () => 'grafana-grid',
    currentStyle: () => 'grid' as DashboardStyle,
    gridColumns: () => 12,
    gridPlacement: (tileId) => placements[tileId],
    measuredGridWidth: () => 1200,
    tileOrder: () => ['t0', 't1'],
    renderedSurface: (tileId) => cards[tileId === 't0' ? 0 : 1],
    scrollHost: () => null,
    invalidateGridStructure,
    ...rest,
  };
  return { deps, grid, cards, runCommand, invalidateGridStructure };
}

function down(target: EventTarget, over: Partial<PointerEventInit> = {}): PointerEvent {
  const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ...over });
  target.dispatchEvent(event);
  return event;
}

const move = (over: Partial<PointerEventInit> = {}): void => {
  window.dispatchEvent(new PointerEvent('pointermove', over));
};
const up = (over: Partial<PointerEventInit> = {}): void => {
  window.dispatchEvent(new PointerEvent('pointerup', over));
};

/** A `.dash-page`-shaped scroll host with mutable scroll metrics — mirrors
 *  dashboard.test.ts's own `stubScrollHost` convention (#338). */
function makeScrollHost(opts: { top?: number; bottom?: number; scrollHeight?: number; clientHeight?: number } = {}): HTMLElement {
  const page = document.createElement('div');
  const top = opts.top ?? 0;
  const bottom = opts.bottom ?? 400;
  page.getBoundingClientRect = () => ({
    top, bottom, left: 0, right: 800, width: 800, height: bottom - top, x: 0, y: top, toJSON: () => ({}),
  }) as DOMRect;
  Object.defineProperty(page, 'scrollHeight', { value: opts.scrollHeight ?? 2000, configurable: true });
  Object.defineProperty(page, 'clientHeight', { value: opts.clientHeight ?? (bottom - top), configurable: true });
  let st = 0;
  Object.defineProperty(page, 'scrollTop', { get: () => st, set: (v: number) => { st = v; }, configurable: true });
  return page;
}

/** Installs a manually-drained fake rAF pair on `window`, mirroring
 *  dashboard.test.ts's own `fakeRaf` helper. */
function fakeRaf(): { flush(): void; restore(): void } {
  let queue: { id: number; cb: FrameRequestCallback }[] = [];
  let nextId = 1;
  const realRaf = window.requestAnimationFrame;
  const realCaf = window.cancelAnimationFrame;
  window.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number): void => {
    queue = queue.filter((q) => q.id !== id);
  }) as typeof window.cancelAnimationFrame;
  return {
    flush(): void { const run = queue; queue = []; for (const q of run) q.cb(0); },
    restore(): void { window.requestAnimationFrame = realRaf; window.cancelAnimationFrame = realCaf; },
  };
}

// ── wireTileDrag ─────────────────────────────────────────────────────────────

describe('createTileGestureController — wireTileDrag', () => {
  it('a completed drag past the threshold commits exactly one move-tile with the LATEST tileOrder index', () => {
    const { deps, cards, runCommand } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.wireTileDrag('t0', cards[0]);
    const grip = cards[0].querySelector('.dash-gg-grip')!;
    const from = tileCenter(0);
    const d = down(grip, { clientX: from.x, clientY: from.y });
    expect(d.defaultPrevented).toBe(true);
    move({ clientX: from.x + 10, clientY: from.y }); // crosses the threshold
    expect(cards[0].classList.contains('dash-floating')).toBe(true);
    // Land over tile 1's home slot.
    const land = cards[1].getBoundingClientRect();
    cards[0].getBoundingClientRect = () => ({ ...land, toJSON: () => ({}) }) as DOMRect;
    const to = tileCenter(1);
    move({ clientX: to.x, clientY: to.y });
    up({ clientX: to.x, clientY: to.y });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith({ type: 'move-tile', tileId: 't0', toIndex: 1 });
    expect(cards[0].classList.contains('dash-floating')).toBe(false); // restored
  });

  it('a move BELOW the threshold never commits and never floats the card', () => {
    const { deps, cards, runCommand } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.wireTileDrag('t0', cards[0]);
    const grip = cards[0].querySelector('.dash-gg-grip')!;
    const from = tileCenter(0);
    down(grip, { clientX: from.x, clientY: from.y });
    move({ clientX: from.x + 2, clientY: from.y }); // 2px < the 4px threshold
    up({ clientX: from.x + 2, clientY: from.y });
    expect(cards[0].classList.contains('dash-floating')).toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('a non-primary button press is ignored (no preventDefault, no arm)', () => {
    const { deps, cards } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.wireTileDrag('t0', cards[0]);
    const grip = cards[0].querySelector('.dash-gg-grip')!;
    const d = down(grip, { button: 1 });
    expect(d.defaultPrevented).toBe(false);
  });

  it('a press on nested interactive chrome (resize handle, open, widen, menu) never arms the drag', () => {
    const { deps, cards } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.wireTileDrag('t0', cards[0]);
    for (const cls of ['dash-gg-resize', 'dash-tile-open', 'dash-tile-widen', 'dash-tile-menu']) {
      const chrome = document.createElement('button');
      chrome.className = cls;
      cards[0].appendChild(chrome);
      const d = down(chrome, { metaKey: true }); // even WITH the reorder modifier
      expect(d.defaultPrevented).toBe(false);
      chrome.remove();
    }
  });

  it('a plain body press (no grip, no modifier) does not arm; ⌘/Ctrl on the body does', () => {
    const { deps, cards } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.wireTileDrag('t0', cards[0]);
    const plain = down(cards[0], {});
    expect(plain.defaultPrevented).toBe(false);
    const modified = down(cards[0], { metaKey: true });
    expect(modified.defaultPrevented).toBe(true);
    up(); // release the armed gesture so it doesn't leak into other tests
  });

  it('getModifierState is consulted when metaKey/ctrlKey read false (WebKit workaround)', () => {
    const { deps, cards } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.wireTileDrag('t0', cards[0]);
    const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
    Object.defineProperty(event, 'getModifierState', { value: (key: string) => key === 'Meta', configurable: true });
    cards[0].dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    up();
  });

  it('a second pointerdown while a drag is armed is ignored; the first drag is unaffected', () => {
    const { deps, cards, runCommand } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.wireTileDrag('t0', cards[0]);
    controller.wireTileDrag('t1', cards[1]);
    const from = tileCenter(0);
    down(cards[0], { metaKey: true, clientX: from.x, clientY: from.y });
    move({ clientX: from.x + 10, clientY: from.y });
    const d2 = down(cards[1], { metaKey: true });
    expect(d2.defaultPrevented).toBe(false);
    const land = cards[1].getBoundingClientRect();
    cards[0].getBoundingClientRect = () => ({ ...land, toJSON: () => ({}) }) as DOMRect;
    const to = tileCenter(1);
    move({ clientX: to.x, clientY: to.y });
    up({ clientX: to.x, clientY: to.y });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('Escape mid-drag cancels: restores styles, removes listeners, releases capture only if held, dispatches nothing, and invalidates grid structure exactly once', () => {
    const { deps, cards, runCommand, invalidateGridStructure } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.wireTileDrag('t0', cards[0]);
    const release = vi.fn();
    cards[0].setPointerCapture = vi.fn();
    cards[0].hasPointerCapture = () => true;
    cards[0].releasePointerCapture = release;
    const from = tileCenter(0);
    down(cards[0], { metaKey: true, pointerId: 5, clientX: from.x, clientY: from.y });
    move({ clientX: from.x + 10, clientY: from.y });
    expect(cards[0].classList.contains('dash-floating')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(cards[0].classList.contains('dash-floating')).toBe(false);
    expect(cards[0].style.position).toBe('');
    expect(release).toHaveBeenCalledWith(5);
    expect(invalidateGridStructure).toHaveBeenCalledTimes(1);
    expect(runCommand).not.toHaveBeenCalled();
    // The (now-removed) window listeners are gone: a further pointerup is a no-op.
    up({ clientX: from.x, clientY: from.y });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('release does not call releasePointerCapture when capture was never held', () => {
    const { deps, cards, runCommand } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.wireTileDrag('t0', cards[0]);
    const release = vi.fn();
    cards[0].setPointerCapture = vi.fn();
    cards[0].hasPointerCapture = () => false; // never actually captured
    cards[0].releasePointerCapture = release;
    const from = tileCenter(0);
    down(cards[0], { metaKey: true, clientX: from.x, clientY: from.y });
    move({ clientX: from.x + 10, clientY: from.y });
    up({ clientX: from.x, clientY: from.y });
    expect(release).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled(); // released back over its own home slot — snap back
  });

  it('pointercancel and window blur both cancel without dispatching a command', () => {
    for (const trigger of ['pointercancel', 'blur'] as const) {
      const { deps, cards, runCommand } = makeDeps();
      const controller = createTileGestureController(deps);
      controller.wireTileDrag('t0', cards[0]);
      const from = tileCenter(0);
      down(cards[0], { metaKey: true, clientX: from.x, clientY: from.y });
      move({ clientX: from.x + 10, clientY: from.y });
      window.dispatchEvent(new Event(trigger));
      expect(cards[0].classList.contains('dash-floating')).toBe(false);
      expect(runCommand).not.toHaveBeenCalled();
    }
  });

  it('lostpointercapture cancels the gesture the same way', () => {
    const { deps, cards, runCommand } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.wireTileDrag('t0', cards[0]);
    const from = tileCenter(0);
    down(cards[0], { metaKey: true, clientX: from.x, clientY: from.y });
    move({ clientX: from.x + 10, clientY: from.y });
    cards[0].dispatchEvent(new PointerEvent('lostpointercapture'));
    expect(cards[0].classList.contains('dash-floating')).toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('a KPI-member surface (display:contents) is forced to a real box while dragging, then restored', () => {
    const { deps, cards } = makeDeps();
    const original = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
      const style = original(el);
      return el === cards[0]
        ? new Proxy(style, { get: (t, k) => (k === 'display' ? 'contents' : Reflect.get(t, k)) })
        : style;
    });
    cards[0].classList.add('dash-kpi-member');
    const controller = createTileGestureController(deps);
    controller.wireTileDrag('t0', cards[0]);
    const from = tileCenter(0);
    down(cards[0], { metaKey: true, clientX: from.x, clientY: from.y });
    move({ clientX: from.x + 10, clientY: from.y });
    expect(cards[0].style.display).toBe('flex'); // kpi-member → flex, not block
    up({ clientX: from.x, clientY: from.y });
    expect(cards[0].style.display).toBe(''); // restored
    spy.mockRestore();
  });

  it('a plain (non-kpi-member) card forced out of contents display restores to block', () => {
    const { deps, cards } = makeDeps();
    const original = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
      const style = original(el);
      return el === cards[0]
        ? new Proxy(style, { get: (t, k) => (k === 'display' ? 'contents' : Reflect.get(t, k)) })
        : style;
    });
    const controller = createTileGestureController(deps);
    controller.wireTileDrag('t0', cards[0]);
    const from = tileCenter(0);
    down(cards[0], { metaKey: true, clientX: from.x, clientY: from.y });
    move({ clientX: from.x + 10, clientY: from.y });
    expect(cards[0].style.display).toBe('block');
    up({ clientX: from.x, clientY: from.y });
    spy.mockRestore();
  });

  it('the flow (point-hit-test) path applies/removes .dash-drop-target and snaps back on release outside every tile', () => {
    const { deps, cards, runCommand } = makeDeps({ activeEngine: () => 'flow' });
    const controller = createTileGestureController(deps);
    controller.wireTileDrag('t0', cards[0]);
    const from = tileCenter(0);
    down(cards[0], { metaKey: true, clientX: from.x, clientY: from.y });
    move({ clientX: from.x + 10, clientY: from.y }); // over its own home — no drop target
    expect(cards[1].classList.contains('dash-drop-target')).toBe(false);
    const t1 = tileCenter(1);
    move({ clientX: t1.x, clientY: t1.y });
    expect(cards[1].classList.contains('dash-drop-target')).toBe(true);
    move({ clientX: -500, clientY: -500 }); // outside every stubbed rect
    expect(cards[1].classList.contains('dash-drop-target')).toBe(false);
    up({ clientX: -500, clientY: -500 });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('getter-timing: tileOrder() is read fresh at commit — a document change mid-gesture is reflected in the dispatched index, not a gesture-start snapshot', () => {
    let order = ['t0', 't1'];
    const { deps, cards, runCommand } = makeDeps({ tileOrder: () => order });
    const controller = createTileGestureController(deps);
    controller.wireTileDrag('t0', cards[0]);
    const from = tileCenter(0);
    down(cards[0], { metaKey: true, clientX: from.x, clientY: from.y });
    move({ clientX: from.x + 10, clientY: from.y });
    // Mid-gesture, a concurrent commit reorders the live document (t2 inserted).
    order = ['t2', 't0', 't1'];
    const land = cards[1].getBoundingClientRect();
    cards[0].getBoundingClientRect = () => ({ ...land, toJSON: () => ({}) }) as DOMRect;
    const to = tileCenter(1);
    move({ clientX: to.x, clientY: to.y });
    up({ clientX: to.x, clientY: to.y });
    // t1's index in the LATEST order (['t2','t0','t1']) is 2, not the
    // gesture-start order's 1.
    expect(runCommand).toHaveBeenCalledWith({ type: 'move-tile', tileId: 't0', toIndex: 2 });
  });

  it('getter-timing: activeEngine() is read fresh at POINTERDOWN (not memoized at controller construction), and stays frozen for the rest of that one gesture while renderedSurface() keeps reading live', () => {
    // engine is 'grafana-grid' at CONSTRUCTION time, then flipped to 'flow'
    // BEFORE the gesture starts. A controller that memoized `activeEngine()`
    // at construction (rather than reading it fresh at pointerdown) would
    // freeze on 'grafana-grid' and never see this pre-gesture flip at all.
    let engine: 'flow' | 'grafana-grid' = 'grafana-grid';
    const engineCalls: string[] = [];
    const surfaceCalls: string[] = [];
    const { deps, cards, grid } = makeDeps({
      activeEngine: () => { engineCalls.push(engine); return engine; },
      renderedSurface: (id) => { surfaceCalls.push(engine); return cards[id === 't0' ? 0 : 1]; },
    });
    const controller = createTileGestureController(deps);
    engine = 'flow'; // flip BEFORE the gesture starts
    controller.wireTileDrag('t0', cards[0]);
    const from = tileCenter(0);
    down(cards[0], { metaKey: true, clientX: from.x, clientY: from.y });
    move({ clientX: from.x + 10, clientY: from.y }); // beginMove: reads renderedSurface for both tiles
    const engineCallsAfterBegin = engineCalls.length;
    expect(engineCallsAfterBegin).toBe(1); // activeEngine read exactly once, at pointerdown
    // liveReflow reflects the POINTERDOWN-time engine ('flow'), not whatever
    // was active at controller construction ('grafana-grid') — proven by the
    // hit-test path being armed (no placeholder — that's grid-only).
    expect(grid.querySelectorAll('.dash-tile-placeholder').length).toBe(0);
    expect(cards[1].classList.contains('dash-drop-target')).toBe(false); // over its own home only so far
    // Flip the live engine mid-gesture (e.g. an unrelated change-layout commit).
    engine = 'grafana-grid';
    const t1 = tileCenter(1);
    move({ clientX: t1.x, clientY: t1.y });
    // activeEngine was NOT read again…
    expect(engineCalls.length).toBe(engineCallsAfterBegin);
    // …the gesture is STILL on the hit-test/`setDrop` path despite the live
    // engine now answering 'grafana-grid' (liveReflow stayed frozen at
    // 'flow' semantics, from pointerdown) — `.dash-drop-target` is applied,
    // which the grid reflow path would never do.
    expect(cards[1].classList.contains('dash-drop-target')).toBe(true);
    // …and the renderedSurface call `setDrop` just made saw the NEW live
    // value, not the gesture-start one — the two disagree (module doc comment).
    expect(surfaceCalls[surfaceCalls.length - 1]).toBe('grafana-grid');
    up({ clientX: t1.x, clientY: t1.y });
  });

  it('dispose() mid-drag cancels without dispatching a command', () => {
    const { deps, cards, runCommand } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.wireTileDrag('t0', cards[0]);
    const from = tileCenter(0);
    down(cards[0], { metaKey: true, clientX: from.x, clientY: from.y });
    move({ clientX: from.x + 10, clientY: from.y });
    expect(cards[0].classList.contains('dash-floating')).toBe(true);
    controller.dispose();
    expect(cards[0].classList.contains('dash-floating')).toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('a click synthesized on the origin card after a same-tile release is swallowed exactly once', () => {
    const { deps, cards } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.wireTileDrag('t0', cards[0]);
    const from = tileCenter(0);
    down(cards[0], { metaKey: true, clientX: from.x, clientY: from.y });
    move({ clientX: tileCenter(1).x, clientY: tileCenter(1).y });
    up({ clientX: from.x, clientY: from.y }); // release back over its own home rect
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    cards[0].dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true); // swallowed
    const click2 = new MouseEvent('click', { bubbles: true, cancelable: true });
    cards[0].dispatchEvent(click2);
    expect(click2.defaultPrevented).toBe(false); // only once
  });

  it('the click-suppress arming self-disarms on a zero-delay timer even when no click ever follows (#471)', async () => {
    const { deps, cards } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.wireTileDrag('t0', cards[0]);
    const from = tileCenter(0);
    down(cards[0], { metaKey: true, clientX: from.x, clientY: from.y });
    move({ clientX: tileCenter(1).x, clientY: tileCenter(1).y });
    up({ clientX: from.x, clientY: from.y }); // release back over its own home rect — arms the suppress
    // No click follows synchronously — let the scheduled zero-delay disarm
    // timer run (a keyboard activation with no pointerdown could otherwise be
    // eaten by an arming that never expires on its own).
    await new Promise((resolve) => setTimeout(resolve, 0));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    cards[0].dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false); // already disarmed — nothing to swallow
  });

  it('with a scroll host: edge auto-scroll runs, and currentRects() folds in the scroll delta it applies (#338)', () => {
    const raf = fakeRaf();
    try {
      const page = makeScrollHost({ top: 0, bottom: 400, scrollHeight: 2000, clientHeight: 400 });
      const topbar = document.createElement('div');
      topbar.className = 'dash-topbar';
      page.appendChild(topbar);
      const { deps, cards } = makeDeps({ scrollHost: () => page });
      const controller = createTileGestureController(deps);
      controller.wireTileDrag('t0', cards[0]);
      const from = tileCenter(0);
      down(cards[0], { metaKey: true, clientX: from.x, clientY: from.y });
      // Cross the threshold right at the bottom edge zone — beginMove wires the
      // auto-scroll target/scheduler over the real scroll host.
      move({ clientX: from.x + 10, clientY: 395 });
      expect(cards[0].classList.contains('dash-floating')).toBe(true);
      raf.flush(); // runs one auto-scroll frame: scrollBy applies a real delta
      expect(page.scrollTop).toBeGreaterThan(0);
      // `currentRects()` (read via the next resolveFromPointer) folds the
      // applied scroll delta into the captured home rects — covered by the
      // `onScrollFrame` callback re-resolving against the scrolled position;
      // exercising it here is enough for it to run without throwing.
      raf.flush();
      // Now near the TOP edge (scrollTop already > 0) — exercises canScrollUp().
      move({ clientX: from.x + 10, clientY: 5 });
      raf.flush();
      up({ clientX: from.x + 10, clientY: 5 });
    } finally {
      raf.restore();
    }
  });
});

// ── wireGridResize ───────────────────────────────────────────────────────────

describe('createTileGestureController — wireGridResize', () => {
  const placement = (over: Partial<GridPlacement> = {}): GridPlacement => ({
    span: 4, heightUnits: 1, colStart: 0, persistedSpan: 4, ...over,
  });

  it('a no-op while flow (not grid) is active', () => {
    const { deps, cards, runCommand } = makeDeps({ activeEngine: () => 'flow' });
    const controller = createTileGestureController(deps);
    const handle = makeHandle();
    cards[0].appendChild(handle);
    const d = down(handle, {});
    expect(d.defaultPrevented).toBe(false);
    controller.wireGridResize('t0', handle, cards[0]);
    const d2 = down(handle, {});
    expect(d2.defaultPrevented).toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('a non-primary button press is ignored', () => {
    const { deps, cards } = makeDeps();
    const controller = createTileGestureController(deps);
    const handle = makeHandle();
    cards[0].appendChild(handle);
    controller.wireGridResize('t0', handle, cards[0]);
    const d = down(handle, { button: 2 });
    expect(d.defaultPrevented).toBe(false);
  });

  it.each(['columns-2', 'columns-3'] as const)('refuses to start while style is %s', (style) => {
    const { deps, cards, runCommand } = makeDeps({ currentStyle: () => style });
    const controller = createTileGestureController(deps);
    const handle = makeHandle();
    cards[0].appendChild(handle);
    controller.wireGridResize('t0', handle, cards[0]);
    down(handle, {});
    expect(cards[0].classList.contains('dash-gg-resizing')).toBe(false);
    up();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('snaps span/height live (grid style) using the real snap-math, and commits exactly one update-placement on pointerup', () => {
    const { deps, cards, runCommand } = makeDeps({
      placements: { t0: placement() },
      gridColumns: () => 12,
      measuredGridWidth: () => 1200,
    });
    const controller = createTileGestureController(deps);
    const handle = makeHandle();
    cards[0].appendChild(handle);
    controller.wireGridResize('t0', handle, cards[0]);
    down(handle, { clientX: 0, clientY: 0 });
    expect(cards[0].classList.contains('dash-gg-resizing')).toBe(true);
    expect(cards[0].style.gridColumn).toBe('1 / span 4');
    const colWidthPx = (1200 - GRID_GAP_PX * 11) / 12;
    const expectedSpan = snapGridSpan(600, colWidthPx, GRID_GAP_PX, 12);
    const expectedHeight = snapGridHeight(280);
    move({ clientX: 600, clientY: 280 });
    expect(cards[0].style.gridColumn).toBe(`1 / span ${expectedSpan}`);
    expect(cards[0].style.height).toBe(`${gridHeightUnitsToPx(expectedHeight)}px`);
    expect(runCommand).not.toHaveBeenCalled();
    up();
    expect(cards[0].classList.contains('dash-gg-resizing')).toBe(false);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith({
      type: 'update-placement', tileId: 't0', style: 'grid', placement: { span: expectedSpan, height: expectedHeight },
    });
  });

  it('a fixed-width style (full/report) ignores horizontal movement and dispatches a height-only placement', () => {
    const { deps, cards, runCommand } = makeDeps({
      currentStyle: () => 'full', placements: { t0: placement() },
    });
    const controller = createTileGestureController(deps);
    const handle = makeHandle();
    cards[0].appendChild(handle);
    controller.wireGridResize('t0', handle, cards[0]);
    down(handle, { clientX: 0, clientY: 0 });
    expect(cards[0].style.gridColumn).toBe(''); // never pinned for a fixed-width style
    const expectedHeight = snapGridHeight(280);
    move({ clientX: 100000, clientY: 280 }); // huge horizontal delta — ignored
    expect(cards[0].style.gridColumn).toBe('');
    up();
    expect(runCommand).toHaveBeenCalledWith({
      type: 'update-placement', tileId: 't0', style: 'full', placement: { height: expectedHeight },
    });
  });

  it('clamps the live span to the columns remaining at the pinned colStart', () => {
    const { deps, cards, runCommand } = makeDeps({
      placements: { t0: placement({ colStart: 4, span: 6, persistedSpan: 6 }) },
      gridColumns: () => 12,
    });
    const controller = createTileGestureController(deps);
    const handle = makeHandle();
    cards[0].appendChild(handle);
    controller.wireGridResize('t0', handle, cards[0]);
    down(handle, { clientX: 0, clientY: 0 });
    expect(cards[0].style.gridColumn).toBe('5 / span 6');
    move({ clientX: 100000, clientY: 0 }); // would demand span 12 — clamped to 12-4=8
    expect(cards[0].style.gridColumn).toBe('5 / span 8');
    up();
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ placement: expect.objectContaining({ span: 8 }) }));
  });

  it('falls back to a full-width default placement when none is recorded yet', () => {
    const { deps, cards } = makeDeps({ gridColumns: () => 12 }); // no placements entry for t0
    const controller = createTileGestureController(deps);
    const handle = makeHandle();
    cards[0].appendChild(handle);
    controller.wireGridResize('t0', handle, cards[0]);
    down(handle, { clientX: 0, clientY: 0 });
    expect(cards[0].style.gridColumn).toBe('1 / span 12');
    up();
  });

  it.each(['pointercancel', 'blur', 'Escape', 'lostpointercapture'] as const)(
    'a resize cancelled by %s restores the saved inline styles and never commits',
    (reason) => {
      const { deps, cards, runCommand } = makeDeps({ placements: { t0: placement() } });
      const controller = createTileGestureController(deps);
      const handle = makeHandle();
      cards[0].appendChild(handle);
      cards[0].style.gridColumn = 'span 3'; // pre-existing inline style to restore
      cards[0].style.height = '77px';
      const release = vi.fn();
      handle.setPointerCapture = vi.fn();
      handle.hasPointerCapture = () => true;
      handle.releasePointerCapture = release;
      controller.wireGridResize('t0', handle, cards[0]);
      down(handle, { pointerId: 9, clientX: 0, clientY: 0 });
      move({ pointerId: 9, clientX: 600, clientY: 280 });
      expect(cards[0].classList.contains('dash-gg-resizing')).toBe(true);
      if (reason === 'pointercancel') window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 9 }));
      else if (reason === 'blur') window.dispatchEvent(new Event('blur'));
      else if (reason === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      else handle.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 9 }));
      expect(cards[0].classList.contains('dash-gg-resizing')).toBe(false);
      expect(cards[0].style.gridColumn).toBe('span 3');
      expect(cards[0].style.height).toBe('77px');
      expect(release).toHaveBeenCalledWith(9);
      up({ pointerId: 9 });
      expect(runCommand).not.toHaveBeenCalled();
    },
  );

  it('does not call releasePointerCapture when capture was never held', () => {
    const { deps, cards } = makeDeps({ placements: { t0: placement() } });
    const controller = createTileGestureController(deps);
    const handle = makeHandle();
    cards[0].appendChild(handle);
    const release = vi.fn();
    handle.hasPointerCapture = () => false;
    handle.releasePointerCapture = release;
    controller.wireGridResize('t0', handle, cards[0]);
    down(handle, { clientX: 0, clientY: 0 });
    up();
    expect(release).not.toHaveBeenCalled();
  });

  it('getter-timing: currentStyle() is read again fresh at commit — a style change mid-resize lands in the dispatched command, not the gesture-start style', () => {
    let style: DashboardStyle = 'grid';
    const { deps, cards, runCommand } = makeDeps({
      currentStyle: () => style, placements: { t0: placement() },
    });
    const controller = createTileGestureController(deps);
    const handle = makeHandle();
    cards[0].appendChild(handle);
    controller.wireGridResize('t0', handle, cards[0]);
    down(handle, { clientX: 0, clientY: 0 }); // gesture starts under 'grid'
    move({ clientX: 600, clientY: 280 });
    style = 'report'; // flips before commit
    up();
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ style: 'report' }));
  });

  it('dispose() mid-resize cancels without dispatching a command', () => {
    const { deps, cards, runCommand } = makeDeps({ placements: { t0: placement() } });
    const controller = createTileGestureController(deps);
    const handle = makeHandle();
    cards[0].appendChild(handle);
    controller.wireGridResize('t0', handle, cards[0]);
    down(handle, { clientX: 0, clientY: 0 });
    expect(cards[0].classList.contains('dash-gg-resizing')).toBe(true);
    controller.dispose();
    expect(cards[0].classList.contains('dash-gg-resizing')).toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
  });

  // ── keyboard resize ──
  describe('keyboard', () => {
    it('a no-op while flow is active', () => {
      const { deps, cards, runCommand } = makeDeps({ activeEngine: () => 'flow', placements: { t0: placement() } });
      const controller = createTileGestureController(deps);
      const handle = makeHandle();
      controller.wireGridResize('t0', handle, cards[0]);
      const key = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
      handle.dispatchEvent(key);
      expect(key.defaultPrevented).toBe(false);
      expect(runCommand).not.toHaveBeenCalled();
    });

    it('ArrowRight/ArrowLeft dispatch an update-placement-shaped command and no-op at bounds', () => {
      const { deps, cards, runCommand } = makeDeps({
        placements: { t0: placement({ persistedSpan: 12 }) },
      });
      const controller = createTileGestureController(deps);
      const handle = makeHandle();
      controller.wireGridResize('t0', handle, cards[0]);
      const atMax = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
      handle.dispatchEvent(atMax);
      // A recognized arrow key always calls preventDefault, even at bounds —
      // only the COMMAND dispatch is skipped when nothing would change.
      expect(atMax.defaultPrevented).toBe(true);
      expect(runCommand).not.toHaveBeenCalled();
      const left = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
      handle.dispatchEvent(left);
      expect(left.defaultPrevented).toBe(true);
      expect(runCommand).toHaveBeenCalledWith({
        type: 'update-placement', tileId: 't0', style: 'grid', placement: { span: 11, height: 1 },
      });
    });

    it('ArrowUp/ArrowDown adjust height and no-op at bounds', () => {
      const { deps, cards, runCommand } = makeDeps({
        placements: { t0: placement({ heightUnits: 1 }) },
      });
      const controller = createTileGestureController(deps);
      const handle = makeHandle();
      controller.wireGridResize('t0', handle, cards[0]);
      const atMin = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
      handle.dispatchEvent(atMin);
      // Already at the height-unit minimum — preventDefault still fires, but
      // no command (nothing actually changes).
      expect(atMin.defaultPrevented).toBe(true);
      expect(runCommand).not.toHaveBeenCalled();
      const down2 = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
      handle.dispatchEvent(down2);
      expect(down2.defaultPrevented).toBe(true);
      expect(runCommand).toHaveBeenCalledWith({
        type: 'update-placement', tileId: 't0', style: 'grid', placement: { span: 4, height: 2 },
      });
    });

    it('a fixed-width style ignores ArrowLeft/ArrowRight and dispatches height-only', () => {
      const { deps, cards, runCommand } = makeDeps({
        currentStyle: () => 'report', placements: { t0: placement() },
      });
      const controller = createTileGestureController(deps);
      const handle = makeHandle();
      controller.wireGridResize('t0', handle, cards[0]);
      const right = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
      handle.dispatchEvent(right);
      expect(right.defaultPrevented).toBe(false);
      expect(runCommand).not.toHaveBeenCalled();
      const downKey = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
      handle.dispatchEvent(downKey);
      expect(runCommand).toHaveBeenCalledWith({
        type: 'update-placement', tileId: 't0', style: 'report', placement: { height: 2 },
      });
    });

    it('a key other than the four arrows is a no-op', () => {
      const { deps, cards, runCommand } = makeDeps({ placements: { t0: placement() } });
      const controller = createTileGestureController(deps);
      const handle = makeHandle();
      controller.wireGridResize('t0', handle, cards[0]);
      const key = new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true });
      handle.dispatchEvent(key);
      expect(key.defaultPrevented).toBe(false);
      expect(runCommand).not.toHaveBeenCalled();
    });

    it.each(['columns-2', 'columns-3'] as const)('refuses while style is %s', (style) => {
      const { deps, cards, runCommand } = makeDeps({ currentStyle: () => style, placements: { t0: placement() } });
      const controller = createTileGestureController(deps);
      const handle = makeHandle();
      controller.wireGridResize('t0', handle, cards[0]);
      const key = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
      handle.dispatchEvent(key);
      expect(key.defaultPrevented).toBe(false);
      expect(runCommand).not.toHaveBeenCalled();
    });
  });
});

// ── installModifierCue ───────────────────────────────────────────────────────

describe('createTileGestureController — installModifierCue', () => {
  it('toggles .modkey on keydown/keyup of the reorder modifier', () => {
    const { deps, grid } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.installModifierCue();
    window.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true }));
    expect(grid.classList.contains('modkey')).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keyup', {}));
    expect(grid.classList.contains('modkey')).toBe(false);
  });

  it('a Meta/Control KEY (not just the modifier flag) also arms the cue', () => {
    const { deps, grid } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.installModifierCue();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control' }));
    expect(grid.classList.contains('modkey')).toBe(true);
  });

  it('a keyup that still holds ctrlKey keeps the cue armed', () => {
    const { deps, grid } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.installModifierCue();
    window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { ctrlKey: true }));
    expect(grid.classList.contains('modkey')).toBe(true);
  });

  it('window blur clears the cue (the documented WebKit-safe reset)', () => {
    const { deps, grid } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.installModifierCue();
    window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true }));
    expect(grid.classList.contains('modkey')).toBe(true);
    window.dispatchEvent(new Event('blur'));
    expect(grid.classList.contains('modkey')).toBe(false);
  });

  it('a keydown with no modifier at all is a no-op', () => {
    const { deps, grid } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.installModifierCue();
    window.dispatchEvent(new KeyboardEvent('keydown', {}));
    expect(grid.classList.contains('modkey')).toBe(false);
  });

  it('is a no-op when the document has no defaultView', () => {
    const { deps, grid } = makeDeps({ document: { defaultView: null } as unknown as Document });
    const controller = createTileGestureController(deps);
    expect(() => controller.installModifierCue()).not.toThrow();
    window.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true }));
    expect(grid.classList.contains('modkey')).toBe(false);
  });

  it('the held-modifier state installModifierCue tracks feeds wireTileDrag\'s body-drag shortcut', () => {
    const { deps, cards } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.installModifierCue();
    controller.wireTileDrag('t0', cards[0]);
    window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true }));
    // WebKit can leave `ctrlKey` false on the pointer event itself — the
    // tracked held-state is what actually arms the body-drag shortcut here.
    const d = down(cards[0], {});
    expect(d.defaultPrevented).toBe(true);
    up();
  });
});

// ── dispose ordering / omissions ─────────────────────────────────────────────

describe('createTileGestureController — dispose', () => {
  it('removes the modifier-cue listeners and cancels an active gesture, in that order, and is a safe no-op when nothing is installed', () => {
    const { deps, grid, cards, runCommand } = makeDeps();
    const controller = createTileGestureController(deps);
    expect(() => controller.dispose()).not.toThrow(); // nothing installed yet
    controller.installModifierCue();
    controller.wireTileDrag('t0', cards[0]);
    window.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true }));
    expect(grid.classList.contains('modkey')).toBe(true);
    const from = tileCenter(0);
    down(cards[0], { metaKey: true, clientX: from.x, clientY: from.y });
    move({ clientX: from.x + 10, clientY: from.y });
    controller.dispose();
    // dispose() removes the LISTENERS, same as pre-extraction
    // `disposeDashboardSurface` — it never explicitly strips a lingering
    // `.modkey` class itself (the real app discards the whole grid node on
    // the next render instead); a stale class here is the honest mirror of
    // that, not a bug this test should paper over.
    expect(grid.classList.contains('modkey')).toBe(true);
    expect(cards[0].classList.contains('dash-floating')).toBe(false); // gesture cancelled
    expect(runCommand).not.toHaveBeenCalled();
    // A window blur no longer even CLEARS the stale class (the blur listener
    // itself is gone) — proving the listeners are really removed, not idle.
    window.dispatchEvent(new Event('blur'));
    expect(grid.classList.contains('modkey')).toBe(true);
  });

  it('does not remove the permanent per-card pointerdown listener wireTileDrag installed at build time', () => {
    const { deps, cards } = makeDeps();
    const controller = createTileGestureController(deps);
    controller.wireTileDrag('t0', cards[0]);
    controller.dispose();
    // The card's own pointerdown listener is untouched by dispose() — a fresh
    // press still arms a gesture afterward (no listener registry removed it).
    const from = tileCenter(0);
    const d = down(cards[0], { metaKey: true, clientX: from.x, clientY: from.y });
    expect(d.defaultPrevented).toBe(true);
    up({ clientX: from.x, clientY: from.y });
  });
});
