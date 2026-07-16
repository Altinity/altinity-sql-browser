import { describe, it, expect } from 'vitest';
import { parseDot } from '../../src/core/dot.js';

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
