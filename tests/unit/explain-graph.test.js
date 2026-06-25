import { describe, it, expect } from 'vitest';
import { renderExplainGraph } from '../../src/ui/explain-graph.js';

const DOT = `digraph
{
  rankdir="LR";
  n1 [label="NumbersRange"];
  n2 [label="Filter"];
  n3 [label="Aggregating"];
  n1 -> n2;
  n2 -> n3;
}`;

describe('renderExplainGraph', () => {
  it('draws an SVG with one rect+label per node and a path per edge', () => {
    const el = renderExplainGraph({ rawText: DOT });
    expect(el.className).toBe('explain-graph-view');
    const svg = el.querySelector('svg.explain-graph');
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('viewBox')).toMatch(/^0 0 \d+(\.\d+)? \d+(\.\d+)?$/);
    expect(svg.querySelectorAll('rect.eg-node')).toHaveLength(3);
    expect(svg.querySelectorAll('text.eg-label')).toHaveLength(3);
    expect(svg.querySelectorAll('path.eg-edge')).toHaveLength(2);
    // a reusable arrowhead marker is defined and referenced
    expect(svg.querySelector('marker#eg-arrow')).not.toBeNull();
    expect(svg.querySelector('path.eg-edge').getAttribute('marker-end')).toBe('url(#eg-arrow)');
    expect([...svg.querySelectorAll('text.eg-label')].map((t) => t.textContent))
      .toEqual(['NumbersRange', 'Filter', 'Aggregating']);
  });
  it('shows a placeholder when the DOT has no nodes', () => {
    const el = renderExplainGraph({ rawText: 'digraph {}' });
    expect(el.className).toBe('placeholder');
    expect(el.textContent).toMatch(/No pipeline graph/);
  });
  it('tolerates a null rawText', () => {
    const el = renderExplainGraph({ rawText: null });
    expect(el.className).toBe('placeholder');
  });
});
