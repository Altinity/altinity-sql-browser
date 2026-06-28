import { describe, it, expect } from 'vitest';
import dagre from '@dagrejs/dagre';
import { parseDot } from '../../src/core/dot.js';
import { dagreLayout, nodeWidth } from '../../src/core/dot-layout.js';

// dagre is pure (no DOM), so the tests drive it directly — the same library the
// app injects at runtime via the app.Dagre seam.
const lay = (dot) => dagreLayout(dagre, parseDot(dot));

describe('nodeWidth', () => {
  it('floors at the minimum and grows with the label', () => {
    expect(nodeWidth('')).toBe(64);
    expect(nodeWidth('a very long processor label here')).toBeGreaterThan(64);
  });
});

describe('dagreLayout', () => {
  it('returns an empty layout for no nodes', () => {
    expect(dagreLayout(dagre, { nodes: [], edges: [] })).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });

  it('tolerates missing nodes/edges keys', () => {
    expect(dagreLayout(dagre, {})).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
    const g = dagreLayout(dagre, { nodes: [{ id: 'solo', label: 'Solo' }] }); // no edges key
    expect(g.nodes).toHaveLength(1);
    expect(g.edges).toEqual([]);
    // x/y are the box TOP-LEFT (dagre reports centres → we subtract w/2, h/2):
    // a corner sits at the margin, well left/above the centre.
    expect(g.nodes[0].x).toBeLessThan(g.nodes[0].w / 2);
    expect(g.nodes[0].y).toBeLessThan(g.nodes[0].h / 2);
  });

  it('lays a chain out top→bottom with top-left node coords and routed edges', () => {
    const g = lay('digraph { a [label="A"]; b [label="B"]; c [label="C"]; a -> b; b -> c; }');
    const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(by.a.y).toBeLessThan(by.b.y);
    expect(by.b.y).toBeLessThan(by.c.y);
    expect(by.a.w).toBeGreaterThanOrEqual(64);
    expect(g.width).toBeGreaterThan(0);
    expect(g.height).toBeGreaterThan(0);
    expect(g.edges).toHaveLength(2);
    expect(g.edges[0].points.length).toBeGreaterThanOrEqual(2); // a polyline
    const p0 = g.edges[0].points[0];
    expect(Number.isFinite(p0.x) && Number.isFinite(p0.y)).toBe(true); // {x,y} pairs
  });

  it('puts parallel processors of one stage on the same rank (same y)', () => {
    const g = lay('digraph { a[label="a"]; b[label="b"]; c[label="c"]; t[label="t"]; a->t; b->t; c->t; }');
    const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(by.a.y).toBe(by.b.y);
    expect(by.b.y).toBe(by.c.y);
    expect(by.t.y).toBeGreaterThan(by.a.y);
  });

  it('honors an explicit node w/h, else falls back to label width + fixed height', () => {
    const g = dagreLayout(dagre, {
      nodes: [{ id: 'card', label: 'x', w: 240, h: 120, external: true }, { id: 'plain', label: 'plain' }],
      edges: [{ from: 'card', to: 'plain' }],
    });
    const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(by.card.w).toBe(240); // explicit size honored
    expect(by.card.h).toBe(120);
    expect(by.card.external).toBe(true); // external rides through the layout
    expect(by.plain.w).toBe(nodeWidth('plain')); // no w → label-based width
    expect(by.plain.h).toBe(30); // no h → NODE_H
  });

  it('drops self-loops and edges to undeclared nodes before layout', () => {
    const g = dagreLayout(dagre, {
      nodes: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }],
      edges: [{ from: 'a', to: 'a' }, { from: 'a', to: 'ghost' }, { from: 'a', to: 'b' }],
    });
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toEqual([{ from: 'a', to: 'b', points: expect.any(Array) }]);
  });

  describe('isolatedLast (schema views)', () => {
    it('packs edge-less nodes into a grid below the connected lineage', () => {
      const g = dagreLayout(dagre, {
        nodes: [
          { id: 'a', label: 'A' }, { id: 'b', label: 'B' },        // a → b lineage
          { id: 's1', label: 'S1' }, { id: 's2', label: 'S2' }, { id: 's3', label: 'S3' }, // singles
        ],
        edges: [{ from: 'a', to: 'b' }],
      }, { isolatedLast: true });
      const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
      expect(g.nodes).toHaveLength(5);            // every node kept
      expect(g.edges).toHaveLength(1);            // lineage edge preserved
      const lineageBottom = Math.max(by.a.y + by.a.h, by.b.y + by.b.h);
      for (const id of ['s1', 's2', 's3']) expect(by[id].y).toBeGreaterThanOrEqual(lineageBottom); // all below
      expect(by.a.y).toBeLessThan(by.b.y);        // lineage still laid out top→bottom
    });

    it('grids all nodes from the top when none are connected (no lineage)', () => {
      const g = dagreLayout(dagre, {
        nodes: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }, { id: 'z', label: 'Z' }],
        edges: [],
      }, { isolatedLast: true });
      expect(g.nodes).toHaveLength(3);
      expect(g.edges).toEqual([]);
      expect(g.width).toBeGreaterThan(0);
      expect(g.height).toBeGreaterThan(0);
      expect(Math.min(...g.nodes.map((n) => n.y))).toBeLessThanOrEqual(12); // top row at the margin
    });
  });
});
