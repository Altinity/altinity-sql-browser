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
  // Three same-size 100×100 home slots side by side (no overlap between them).
  const slots: TileRect[] = [
    { tileId: 'a', left: 0, top: 0, right: 100, bottom: 100 },
    { tileId: 'b', left: 100, top: 0, right: 200, bottom: 100 },
    { tileId: 'c', left: 200, top: 0, right: 300, bottom: 100 },
  ];

  it('no candidates → null', () => {
    expect(resolveOverlapInsertIndex({ left: 0, top: 0, right: 100, bottom: 100 }, [])).toBeNull();
  });
  it('100% overlap of a slot → that slot id', () => {
    expect(resolveOverlapInsertIndex({ left: 100, top: 0, right: 200, bottom: 100 }, slots)).toBe('b');
  });
  it('exactly 2/3 area overlap (inclusive) commits', () => {
    // Dragged 90×100 (area 9000, need = 6000) overlapping slot b by exactly 60px width.
    const dragged = { left: 140, top: 0, right: 230, bottom: 100 };
    expect(resolveOverlapInsertIndex(dragged, slots, OVERLAP_COMMIT_RATIO)).toBe('b');
  });
  it('just under 2/3 area overlap → null (snap back)', () => {
    // Same dragged shifted 1px: b overlap 59px (5900 < 6000), c overlap 31px, a none.
    const dragged = { left: 141, top: 0, right: 231, bottom: 100 };
    expect(resolveOverlapInsertIndex(dragged, slots, OVERLAP_COMMIT_RATIO)).toBeNull();
  });
  it('straddling two slots: first in array order that clears the threshold wins', () => {
    // Dragged 90 wide overlapping a by 60 (≥2/3) and b by 0 → a wins.
    const dragged = { left: -30, top: 0, right: 60, bottom: 100 };
    expect(resolveOverlapInsertIndex(dragged, slots, OVERLAP_COMMIT_RATIO)).toBe('a');
  });
  it('both slots clear the threshold (large dragged tile) → first in array order', () => {
    // A wide dragged rect fully covering a AND b; ratio measured vs dragged area.
    const wide = { left: 0, top: 0, right: 200, bottom: 100 }; // area 20000; covers a fully (10000 = 50%)
    // With ratio 0.5, a is the first to reach it.
    expect(resolveOverlapInsertIndex(wide, slots, 0.5)).toBe('a');
  });
  it('zero-area dragged rect → null (never divide by zero / never commit)', () => {
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
