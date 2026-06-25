import { describe, it, expect } from 'vitest';
import { parseDot, layoutGraph } from '../../src/core/dot.js';

describe('parseDot', () => {
  it('pulls labelled nodes and edges from a digraph, skipping the preamble', () => {
    const dot = `some stray header line
digraph
{
  rankdir="LR";
  n1 [label="NumbersRange"];
  n2 [label="Filter"];
  n1 -> n2;
}`;
    const g = parseDot(dot);
    expect(g.nodes).toEqual([{ id: 'n1', label: 'NumbersRange' }, { id: 'n2', label: 'Filter' }]);
    expect(g.edges).toEqual([{ from: 'n1', to: 'n2' }]);
  });
  it('works without a leading "digraph" token', () => {
    const g = parseDot('a [label="A"]; b [label="B"]; a -> b;');
    expect(g.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(g.edges).toEqual([{ from: 'a', to: 'b' }]);
  });
  it('de-duplicates node ids and skips DOT keywords', () => {
    const g = parseDot('node [label="default"]; n1 [label="A"]; n1 [label="A again"]; n1 -> n2;');
    // `node` keyword skipped; n1 only once; n2 added from the edge.
    expect(g.nodes).toEqual([{ id: 'n1', label: 'A' }, { id: 'n2', label: 'n2' }]);
  });
  it('skips edges whose endpoints are DOT keywords', () => {
    const g = parseDot('digraph { n1 [label="A"]; node -> n1; }');
    expect(g.edges).toEqual([]);
  });
  it('unescapes quotes and collapses \\n in labels', () => {
    const g = parseDot('digraph { n1 [label="line1\\nline2"]; n2 [label="say \\"hi\\""]; }');
    expect(g.nodes[0].label).toBe('line1 line2');
    expect(g.nodes[1].label).toBe('say "hi"');
  });
  it('tolerates empty / nullish input', () => {
    expect(parseDot('')).toEqual({ nodes: [], edges: [] });
    expect(parseDot(null)).toEqual({ nodes: [], edges: [] });
  });
});

describe('layoutGraph', () => {
  it('returns an empty layout for no nodes', () => {
    expect(layoutGraph({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
    expect(layoutGraph({})).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });
  it('lays a chain out left→right in increasing layers', () => {
    const g = layoutGraph(parseDot('digraph { a [label="A"]; b [label="B"]; c [label="C"]; a -> b; b -> c; }'));
    const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(by.a.x).toBeLessThan(by.b.x);
    expect(by.b.x).toBeLessThan(by.c.x);
    expect(g.width).toBeGreaterThan(0);
    expect(g.height).toBeGreaterThan(0);
    expect(g.edges).toHaveLength(2);
    // each edge is a 2-point polyline from a right edge to a left edge
    expect(g.edges[0].points).toHaveLength(2);
    expect(g.edges[0].points[0].x).toBe(by.a.x + by.a.w);
    expect(g.edges[0].points[1].x).toBe(by.b.x);
  });
  it('uses the longest path for layering (diamond)', () => {
    // a->b->d and a->d : d must sit a column past b, not next to a.
    const g = layoutGraph(parseDot('digraph { a[label="a"]; b[label="b"]; d[label="d"]; a->b; b->d; a->d; }'));
    const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(by.d.x).toBeGreaterThan(by.b.x);
  });
  it('stacks a fan-in column and gives the column a uniform width', () => {
    const g = layoutGraph(parseDot('digraph { a[label="a"]; b[label="b"]; c[label="c"]; t[label="target"]; a->t; b->t; c->t; }'));
    const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(by.a.w).toBe(by.b.w); // sources share one column width
    expect(new Set([by.a.y, by.b.y, by.c.y]).size).toBe(3); // stacked, distinct rows
  });
  it('filters edges with an unknown endpoint', () => {
    const g = layoutGraph({ nodes: [{ id: 'a', label: 'a' }], edges: [{ from: 'a', to: 'ghost' }] });
    expect(g.nodes).toHaveLength(1);
    expect(g.edges).toHaveLength(0);
  });
  it('is cycle-safe (no infinite loop) and still positions every node', () => {
    const g = layoutGraph(parseDot('digraph { a[label="a"]; b[label="b"]; a->b; b->a; }'));
    expect(g.nodes).toHaveLength(2);
    for (const n of g.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });
});
