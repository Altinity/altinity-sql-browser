import { describe, it, expect } from 'vitest';
import {
  TILE_MOVE_THRESHOLD_PX, movedPastThreshold, hitTestTile,
  resolveOverlapInsertIndex, flipDelta,
  type TileRect,
} from '../../src/core/tile-reorder.js';

describe('movedPastThreshold', () => {
  it('below the default threshold is not a move', () => {
    expect(movedPastThreshold(1, 1)).toBe(false);
  });
  it('exactly at the default threshold counts as a move', () => {
    expect(movedPastThreshold(TILE_MOVE_THRESHOLD_PX, 0)).toBe(true);
  });
  it('above the default threshold counts as a move', () => {
    expect(movedPastThreshold(10, 10)).toBe(true);
  });
  it('respects a custom threshold arg', () => {
    expect(movedPastThreshold(5, 0, 10)).toBe(false);
    expect(movedPastThreshold(10, 0, 10)).toBe(true);
  });
});

describe('hitTestTile', () => {
  const rects: TileRect[] = [
    { tileId: 'a', left: 0, top: 0, right: 10, bottom: 10 },
    { tileId: 'b', left: 5, top: 5, right: 15, bottom: 15 },
  ];

  it('finds the tile whose rect contains the point', () => {
    expect(hitTestTile(rects, 2, 2)).toBe('a');
  });
  it('returns null when the point is inside no rect', () => {
    expect(hitTestTile(rects, 100, 100)).toBeNull();
  });
  it('overlapping rects: first containing rect wins', () => {
    expect(hitTestTile(rects, 7, 7)).toBe('a');
  });
  it('empty rect array returns null', () => {
    expect(hitTestTile([], 0, 0)).toBeNull();
  });
  it('boundary point exactly on an edge counts as inside', () => {
    expect(hitTestTile(rects, 10, 10)).toBe('a');
    expect(hitTestTile(rects, 0, 0)).toBe('a');
  });
});

describe('resolveOverlapInsertIndex', () => {
  // Three same-size 90×100 home slots side by side. Destination = whichever
  // candidate's home rect the dragged rect overlaps by the greatest area
  // (max-overlap, #332 redesign — replaces the old "≥2/3 of the target
  // slot's area" threshold that a short tile could never clear).
  const slots: TileRect[] = [
    { tileId: 'a', left: 0, top: 0, right: 90, bottom: 100 },
    { tileId: 'b', left: 90, top: 0, right: 180, bottom: 100 },
    { tileId: 'c', left: 180, top: 0, right: 270, bottom: 100 },
  ];

  it('no candidates → null', () => {
    expect(resolveOverlapInsertIndex({ left: 0, top: 0, right: 90, bottom: 100 }, [])).toBeNull();
  });
  it('overlaps exactly one slot → returns it', () => {
    expect(resolveOverlapInsertIndex({ left: 90, top: 0, right: 180, bottom: 100 }, slots)).toBe('b');
  });
  it('overlaps two slots, more over the 2nd → returns the 2nd', () => {
    // Straddles b (60px, area 6000) and c (30px, area 3000) → b wins.
    const dragged = { left: 120, top: 0, right: 210, bottom: 100 };
    expect(resolveOverlapInsertIndex(dragged, slots)).toBe('b');
  });
  it('equal overlap of two slots → first in canonical order wins', () => {
    // Wide tile fully covering a AND b equally (each 9000) → first (a) wins
    // (strict `>` in the resolver means only a STRICTLY greater overlap
    // displaces the incumbent).
    const wide = { left: 0, top: 0, right: 180, bottom: 100 };
    expect(resolveOverlapInsertIndex(wide, slots)).toBe('a');
  });
  it('overlaps nothing (dropped in empty space) → null', () => {
    expect(resolveOverlapInsertIndex({ left: 500, top: 500, right: 600, bottom: 600 }, slots)).toBeNull();
  });
  it('own-home included: mostly over own home but partly over a neighbor → own id (snap-back)', () => {
    const home: TileRect[] = [
      { tileId: 'self', left: 0, top: 0, right: 90, bottom: 100 }, // 9000
      { tileId: 'neighbor', left: 90, top: 0, right: 180, bottom: 100 },
    ];
    // Dragged sits mostly on 'self' (80×100=8000) and only 10×100=1000 on 'neighbor'.
    const draggedMostlyHome = { left: 0, top: 0, right: 80, bottom: 100 };
    expect(resolveOverlapInsertIndex(draggedMostlyHome, home)).toBe('self');
    // Now dragged more onto the neighbor (30×100=3000 self, 60×100=6000 neighbor) → commits.
    const draggedOverNeighbor = { left: 60, top: 0, right: 150, bottom: 100 };
    expect(resolveOverlapInsertIndex(draggedOverNeighbor, home)).toBe('neighbor');
  });
  it('KPI regression: a short-wide tile over a tall slot resolves by max-overlap, not a 2/3-of-area floor', () => {
    // A 403×120 KPI dragged fully inside the footprint of a 403×296 slot: full
    // width, area 403*120=48360 vs the slot's own 403*296=119288 — under the
    // old "≥2/3 of the TARGET slot's area" rule this is only ~40% and would
    // always snap back. Under max-overlap it's the only (and thus greatest)
    // overlap, so it commits.
    const tallSlot: TileRect[] = [{ tileId: 'tall', left: 0, top: 0, right: 403, bottom: 296 }];
    const kpi = { left: 0, top: 0, right: 403, bottom: 120 };
    expect(resolveOverlapInsertIndex(kpi, tallSlot)).toBe('tall');
  });
  it('a zero/degenerate-area candidate never wins, even fully "contained" by the dragged rect', () => {
    const withDegenerate: TileRect[] = [
      { tileId: 'z', left: 50, top: 50, right: 50, bottom: 50 }, // zero area
      ...slots,
    ];
    // Dragged sits over z's point (zero-area overlap) and also over slot a.
    const dragged = { left: 40, top: 40, right: 60, bottom: 60 };
    expect(resolveOverlapInsertIndex(dragged, withDegenerate)).toBe('a');
    // With no other candidate overlapping at all, the degenerate one still never wins.
    expect(resolveOverlapInsertIndex(dragged, [{ tileId: 'z', left: 50, top: 50, right: 50, bottom: 50 }])).toBeNull();
  });
  it('zero-area dragged rect → null (covers nothing)', () => {
    expect(resolveOverlapInsertIndex({ left: 0, top: 0, right: 0, bottom: 0 }, slots)).toBeNull();
  });
});

describe('flipDelta', () => {
  it('returns first-minus-last offset', () => {
    expect(flipDelta({ left: 10, top: 20, right: 0, bottom: 0 }, { left: 30, top: 25, right: 0, bottom: 0 }))
      .toEqual({ dx: -20, dy: -5 });
  });
  it('zero delta when position is unchanged', () => {
    expect(flipDelta({ left: 5, top: 5, right: 0, bottom: 0 }, { left: 5, top: 5, right: 0, bottom: 0 }))
      .toEqual({ dx: 0, dy: 0 });
  });
});
