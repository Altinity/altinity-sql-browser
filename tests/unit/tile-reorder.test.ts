import { describe, it, expect } from 'vitest';
import {
  TILE_MOVE_THRESHOLD_PX, movedPastThreshold, hitTestTile,
  OVERLAP_COMMIT_RATIO, resolveOverlapInsertIndex, flipDelta,
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
  // Three same-size 90×100 home slots side by side (area 9000, so a 2/3 commit
  // threshold is exactly 6000 — integer, no float-boundary fragility). Overlap
  // is measured against the TARGET slot's area, not the dragged tile's.
  const slots: TileRect[] = [
    { tileId: 'a', left: 0, top: 0, right: 90, bottom: 100 },
    { tileId: 'b', left: 90, top: 0, right: 180, bottom: 100 },
    { tileId: 'c', left: 180, top: 0, right: 270, bottom: 100 },
  ];

  it('no candidates → null', () => {
    expect(resolveOverlapInsertIndex({ left: 0, top: 0, right: 90, bottom: 100 }, [])).toBeNull();
  });
  it('fully covering a slot → that slot id', () => {
    expect(resolveOverlapInsertIndex({ left: 90, top: 0, right: 180, bottom: 100 }, slots)).toBe('b');
  });
  it('covering exactly 2/3 of the TARGET slot area (inclusive) commits', () => {
    // Cover slot b by 60px of its 90px width → 6000 of its 9000 area = 2/3.
    const dragged = { left: 120, top: 0, right: 210, bottom: 100 };
    expect(resolveOverlapInsertIndex(dragged, slots, OVERLAP_COMMIT_RATIO)).toBe('b');
  });
  it('just under 2/3 of the target → null (snap back)', () => {
    // Shift 1px: b coverage 59px (5900 < 6000), c 31px (3100), a none.
    const dragged = { left: 121, top: 0, right: 211, bottom: 100 };
    expect(resolveOverlapInsertIndex(dragged, slots, OVERLAP_COMMIT_RATIO)).toBeNull();
  });
  it('measures the TARGET slot, not the dragged tile: a small tile inside a big slot does NOT commit', () => {
    // A 30×30 tile fully inside slot b covers only 900/9000 = 10% of the slot —
    // under a "2/3 of the dragged tile" rule this would (wrongly) commit at 100%.
    const small = { left: 120, top: 30, right: 150, bottom: 60 };
    expect(resolveOverlapInsertIndex(small, slots, OVERLAP_COMMIT_RATIO)).toBeNull();
  });
  it('a large tile commits once it blankets ≥2/3 of the (smaller) target slot', () => {
    // A tall/wide tile fully covering slot b's area → 9000/9000 = 100% ≥ 2/3.
    const big = { left: 85, top: -20, right: 185, bottom: 120 };
    expect(resolveOverlapInsertIndex(big, slots, OVERLAP_COMMIT_RATIO)).toBe('b');
  });
  it('straddling two slots: first in array order that clears the threshold wins', () => {
    // Cover slot a by 60px (6000 ≥ 2/3) and slot b by 0 → a wins.
    const dragged = { left: -30, top: 0, right: 60, bottom: 100 };
    expect(resolveOverlapInsertIndex(dragged, slots, OVERLAP_COMMIT_RATIO)).toBe('a');
  });
  it('both slots clear the threshold → first in array order', () => {
    // Wide tile fully covering a AND b (each 100%) → first (a) wins.
    const wide = { left: 0, top: 0, right: 180, bottom: 100 };
    expect(resolveOverlapInsertIndex(wide, slots)).toBe('a');
  });
  it('a zero-area candidate slot is skipped (never a spurious 0≥0 match)', () => {
    const withDegenerate: TileRect[] = [
      { tileId: 'z', left: 50, top: 50, right: 50, bottom: 50 }, // zero area
      ...slots,
    ];
    // Dragged sits over z's point but z is skipped; nothing else overlaps → null.
    expect(resolveOverlapInsertIndex({ left: 40, top: 40, right: 60, bottom: 60 }, withDegenerate)).toBeNull();
  });
  it('zero-area dragged rect → null (covers nothing)', () => {
    expect(resolveOverlapInsertIndex({ left: 0, top: 0, right: 0, bottom: 0 }, slots)).toBeNull();
  });
  it('no overlap with anything → null', () => {
    expect(resolveOverlapInsertIndex({ left: 500, top: 500, right: 600, bottom: 600 }, slots)).toBeNull();
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
