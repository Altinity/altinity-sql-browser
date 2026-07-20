import { describe, it, expect } from 'vitest';
import { TILE_MOVE_THRESHOLD_PX, movedPastThreshold, hitTestTile, type TileRect } from '../../src/core/tile-reorder.js';

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
