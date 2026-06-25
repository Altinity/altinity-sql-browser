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
  it('de-duplicates node ids, skips DOT keywords, and drops edges to undeclared ids', () => {
    const g = parseDot('node [label="default"]; n1 [label="A"]; n1 [label="A again"]; n1 -> n2;');
    // `node` keyword skipped; n1 only once; n2 never declared → no phantom node…
    expect(g.nodes).toEqual([{ id: 'n1', label: 'A' }]);
    expect(g.edges).toEqual([]); // …and its edge is dropped
  });
  it('skips edges whose endpoints are not declared nodes', () => {
    const g = parseDot('digraph { n1 [label="A"]; node -> n1; }');
    expect(g.edges).toEqual([]);
  });
  it('ignores -> and ids that appear inside label strings (no phantom nodes/edges)', () => {
    const g = parseDot('digraph { n0 [label="Join a -> b"]; n1 [label="Scan"]; n0 -> n1; }');
    expect(g.nodes.map((n) => n.id)).toEqual(['n0', 'n1']); // no phantom a / b
    expect(g.edges).toEqual([{ from: 'n0', to: 'n1' }]);
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
  it('lays a chain out top→bottom in increasing layers', () => {
    const g = layoutGraph(parseDot('digraph { a [label="A"]; b [label="B"]; c [label="C"]; a -> b; b -> c; }'));
    const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(by.a.y).toBeLessThan(by.b.y);
    expect(by.b.y).toBeLessThan(by.c.y);
    expect(g.width).toBeGreaterThan(0);
    expect(g.height).toBeGreaterThan(0);
    expect(g.edges).toHaveLength(2);
    // each edge is a 2-point polyline from a bottom-centre to a top-centre
    expect(g.edges[0].points).toHaveLength(2);
    expect(g.edges[0].points[0]).toEqual({ x: by.a.x + by.a.w / 2, y: by.a.y + by.a.h });
    expect(g.edges[0].points[1]).toEqual({ x: by.b.x + by.b.w / 2, y: by.b.y });
  });
  it('uses the longest path for layering (diamond stacks vertically)', () => {
    // a->b->d and a->d : d must sit a row below b, not beside a.
    const g = layoutGraph(parseDot('digraph { a[label="a"]; b[label="b"]; d[label="d"]; a->b; b->d; a->d; }'));
    const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(by.d.y).toBeGreaterThan(by.b.y);
  });
  it('spreads parallel processors of one stage horizontally on the same row', () => {
    const g = layoutGraph(parseDot('digraph { a[label="a"]; b[label="b"]; c[label="c"]; t[label="target"]; a->t; b->t; c->t; }'));
    const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(by.a.y).toBe(by.b.y); // same stage → same row
    expect(by.b.y).toBe(by.c.y);
    expect(new Set([by.a.x, by.b.x, by.c.x]).size).toBe(3); // side-by-side, distinct columns
    expect(by.t.y).toBeGreaterThan(by.a.y); // target below the parallel sources
  });
  it('filters edges with an unknown endpoint and self-loops', () => {
    const g = layoutGraph({ nodes: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }], edges: [{ from: 'a', to: 'ghost' }, { from: 'a', to: 'a' }, { from: 'a', to: 'b' }] });
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toHaveLength(1); // only a->b survives
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
