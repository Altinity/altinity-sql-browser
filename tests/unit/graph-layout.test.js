import { describe, it, expect } from 'vitest';
import {
  nodeCenter, straightEdgePoints, incidentEdges, dragDeltaToSvg, applyPositions, recordPosition, createMoveHistory,
} from '../../src/core/graph-layout.js';

describe('nodeCenter', () => {
  it('is the centre of the top-left box', () => {
    expect(nodeCenter({ x: 10, y: 20, w: 40, h: 60 })).toEqual({ x: 30, y: 50 });
  });
});

describe('straightEdgePoints', () => {
  // Two 10×10 boxes; centres are clipped to the box borders along the line.
  it('clips a horizontal edge to the right/left borders', () => {
    const from = { x: 0, y: 0, w: 10, h: 10 }; // centre (5,5)
    const to = { x: 100, y: 0, w: 10, h: 10 }; // centre (105,5)
    expect(straightEdgePoints(from, to)).toEqual([{ x: 10, y: 5 }, { x: 100, y: 5 }]);
  });
  it('clips a vertical edge to the bottom/top borders (dx === 0 branch)', () => {
    const from = { x: 0, y: 0, w: 10, h: 10 }; // centre (5,5)
    const to = { x: 0, y: 100, w: 10, h: 10 }; // centre (5,105)
    expect(straightEdgePoints(from, to)).toEqual([{ x: 5, y: 10 }, { x: 5, y: 100 }]);
  });
  it('clips a diagonal edge by the nearer axis', () => {
    const from = { x: 0, y: 0, w: 10, h: 10 }; // centre (5,5)
    const to = { x: 100, y: 100, w: 10, h: 10 }; // centre (105,105)
    // dx=dy=100 → s = min(5/100, 5/100) = 0.05 → corner (10,10) and (100,100)
    expect(straightEdgePoints(from, to)).toEqual([{ x: 10, y: 10 }, { x: 100, y: 100 }]);
  });
  it('returns the centre for coincident boxes (degenerate, both deltas zero)', () => {
    const box = { x: 0, y: 0, w: 10, h: 10 }; // centre (5,5)
    expect(straightEdgePoints(box, box)).toEqual([{ x: 5, y: 5 }, { x: 5, y: 5 }]);
  });
});

describe('incidentEdges', () => {
  const edges = [
    { from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' },
  ];
  it('returns the indices of edges touching the node (as source or target)', () => {
    expect(incidentEdges(edges, 'b')).toEqual([0, 1]); // a→b and b→c
    expect(incidentEdges(edges, 'a')).toEqual([0]);
    expect(incidentEdges(edges, 'z')).toEqual([]); // none
  });
});

describe('dragDeltaToSvg', () => {
  it('scales pixel deltas by the viewBox-to-container ratio', () => {
    expect(dragDeltaToSvg(40, 20, { x: 0, y: 0, w: 800, h: 400 }, { width: 400, height: 200 }))
      .toEqual({ dx: 80, dy: 40 });
  });
  it('guards a zero-sized container (avoids divide-by-zero)', () => {
    expect(dragDeltaToSvg(10, 10, { x: 0, y: 0, w: 100, h: 100 }, { width: 0, height: 0 }))
      .toEqual({ dx: 1000, dy: 1000 });
  });
});

describe('applyPositions', () => {
  it('overlays saved coordinates in place, leaving unsaved nodes alone', () => {
    const nodes = [{ id: 'a', x: 1, y: 1 }, { id: 'b', x: 2, y: 2 }];
    applyPositions(nodes, { a: { x: 9, y: 8 } });
    expect(nodes).toEqual([{ id: 'a', x: 9, y: 8 }, { id: 'b', x: 2, y: 2 }]);
  });
  it('is a no-op when there are no positions', () => {
    const nodes = [{ id: 'a', x: 1, y: 1 }];
    expect(applyPositions(nodes, null)).toBe(nodes);
    expect(nodes[0]).toEqual({ id: 'a', x: 1, y: 1 });
  });
});

describe('recordPosition', () => {
  it('writes the position into the map and returns it', () => {
    const map = {};
    expect(recordPosition(map, 'a', 3, 4)).toBe(map);
    expect(map).toEqual({ a: { x: 3, y: 4 } });
  });
});

describe('createMoveHistory', () => {
  const op = (id, fx, tx) => ({ id, from: { x: fx, y: 0 }, to: { x: tx, y: 0 } });
  it('undo pops in LIFO order and redo replays them; both return null when empty', () => {
    const h = createMoveHistory();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
    expect(h.undo()).toBeNull(); // nothing recorded yet
    h.record(op('a', 0, 1));
    h.record(op('b', 0, 2));
    expect(h.canUndo()).toBe(true);
    expect(h.undo().id).toBe('b');
    expect(h.undo().id).toBe('a');
    expect(h.undo()).toBeNull(); // past exhausted
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(true);
    expect(h.redo().id).toBe('a');
    expect(h.redo().id).toBe('b');
    expect(h.redo()).toBeNull(); // future exhausted
    expect(h.canRedo()).toBe(false);
  });
  it('a new record clears the redo branch', () => {
    const h = createMoveHistory();
    h.record(op('a', 0, 1));
    h.undo();
    h.record(op('b', 0, 2)); // diverges → redo of "a" is gone
    expect(h.redo()).toBeNull();
    expect(h.undo().id).toBe('b');
  });
});
