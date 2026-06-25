import { describe, it, expect, afterEach, vi } from 'vitest';
import dagre from '@dagrejs/dagre';
import { renderExplainGraph, openPipelineFullscreen, renderSchemaGraph, openSchemaFullscreen } from '../../src/ui/explain-graph.js';

const APP = { document, Dagre: dagre }; // app stub carrying the dagre layout seam

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
    const el = renderExplainGraph(APP, { rawText: DOT });
    expect(el.className).toBe('explain-graph-view');
    const svg = el.querySelector('svg.explain-graph');
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('width')).toBe('100%'); // fills the pane; viewBox is the window
    expect(svg.getAttribute('viewBox').split(' ').map(Number).every(Number.isFinite)).toBe(true);
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
    const el = renderExplainGraph(APP, { rawText: 'digraph {}' });
    expect(el.className).toBe('placeholder');
    expect(el.textContent).toMatch(/No pipeline graph/);
  });
  it('tolerates a null rawText', () => {
    const el = renderExplainGraph(APP, { rawText: null });
    expect(el.className).toBe('placeholder');
  });
});

describe('openPipelineFullscreen', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  // happy-dom has no layout, so stub the canvas rect the pan/zoom math reads.
  const stubRect = (canvas) => {
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 });
  };
  const vbOf = (overlay) => overlay.querySelector('svg.explain-graph').getAttribute('viewBox').split(' ').map(Number);
  // happy-dom drops modifier keys AND clientX/clientY from the WheelEvent init
  // dict (it keeps deltaX/deltaY), so force every field the handler reads.
  const fireWheel = (canvas, opts = {}) => {
    const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: opts.deltaX || 0, deltaY: opts.deltaY || 0 });
    Object.defineProperty(e, 'clientX', { value: opts.clientX ?? 200 });
    Object.defineProperty(e, 'clientY', { value: opts.clientY ?? 100 });
    if (opts.ctrlKey) Object.defineProperty(e, 'ctrlKey', { value: true });
    if (opts.metaKey) Object.defineProperty(e, 'metaKey', { value: true });
    canvas.dispatchEvent(e);
  };

  it('mounts a fullscreen overlay with the graph and an initial fitted viewBox', () => {
    const overlay = openPipelineFullscreen(APP, DOT);
    expect(document.body.contains(overlay)).toBe(true);
    expect(overlay.className).toBe('graph-overlay');
    const svg = overlay.querySelector('svg.explain-graph');
    expect(svg.getAttribute('width')).toBe('100%');
    expect(svg.querySelectorAll('rect.eg-node')).toHaveLength(3);
    expect(overlay.querySelector('.graph-overlay-zoom')).not.toBeNull();
    expect(vbOf(overlay)[2]).toBeGreaterThan(0); // a real fitted width
  });

  it('⌘/Ctrl+wheel zooms around the cursor; plain wheel pans', () => {
    const overlay = openPipelineFullscreen(APP, DOT);
    const canvas = overlay.querySelector('.graph-overlay-canvas');
    stubRect(canvas);
    const w0 = vbOf(overlay)[2];
    fireWheel(canvas, { deltaY: -1, ctrlKey: true });
    const w1 = vbOf(overlay)[2];
    expect(w1).toBeLessThan(w0); // Ctrl+wheel up → zoom in
    fireWheel(canvas, { deltaY: 1, metaKey: true });
    expect(vbOf(overlay)[2]).toBeGreaterThan(w1); // ⌘+wheel down → zoom out
    // plain wheel pans: viewBox origin moves, width unchanged (not a zoom)
    const [x0, y0, pw] = vbOf(overlay);
    fireWheel(canvas, { deltaX: 30, deltaY: 40 });
    const [x1, y1, pw2] = vbOf(overlay);
    expect(pw2).toBe(pw);
    expect(x1).not.toBe(x0);
    expect(y1).not.toBe(y0);
  });

  it('double-click fits the graph', () => {
    const overlay = openPipelineFullscreen(APP, DOT);
    const canvas = overlay.querySelector('.graph-overlay-canvas');
    stubRect(canvas);
    const fitW = vbOf(overlay)[2];
    fireWheel(canvas, { deltaY: -1, ctrlKey: true });
    expect(vbOf(overlay)[2]).toBeLessThan(fitW);
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(vbOf(overlay)[2]).toBeCloseTo(fitW);
  });

  it('drag pans the viewBox; a stray mousemove without a drag is a no-op', () => {
    const overlay = openPipelineFullscreen(APP, DOT);
    const canvas = overlay.querySelector('.graph-overlay-canvas');
    stubRect(canvas);
    const [x0] = vbOf(overlay);
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 0, bubbles: true })); // no drag yet
    expect(vbOf(overlay)[0]).toBe(x0);
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100, bubbles: true }));
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: 100, bubbles: true })); // drag left → pan right
    const x1 = vbOf(overlay)[0];
    expect(x1).not.toBe(x0);
    canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 100, bubbles: true })); // after release → no change
    expect(vbOf(overlay)[0]).toBe(x1);
  });

  it('zoom buttons and Fit reframe the graph', () => {
    const overlay = openPipelineFullscreen(APP, DOT);
    const canvas = overlay.querySelector('.graph-overlay-canvas');
    stubRect(canvas);
    const fitW = vbOf(overlay)[2];
    const [zoomOut, zoomIn, fit] = overlay.querySelectorAll('.graph-overlay-zoom .res-act');
    zoomIn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(vbOf(overlay)[2]).toBeLessThan(fitW);
    zoomOut.dispatchEvent(new Event('click', { bubbles: true }));
    fit.dispatchEvent(new Event('click', { bubbles: true }));
    expect(vbOf(overlay)[2]).toBeCloseTo(fitW);
  });

  it('closes on Escape, the ✕ button, and a backdrop click (but not a panel click)', () => {
    // Escape
    let overlay = openPipelineFullscreen(APP, DOT);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); // ignored
    expect(document.body.contains(overlay)).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.body.contains(overlay)).toBe(false);
    // panel click does NOT close; ✕ does
    overlay = openPipelineFullscreen(APP, DOT);
    overlay.querySelector('.graph-overlay-panel').dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.body.contains(overlay)).toBe(true);
    overlay.querySelector('.graph-overlay-close').dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.body.contains(overlay)).toBe(false);
    // backdrop click closes
    overlay = openPipelineFullscreen(APP, DOT);
    overlay.dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.body.contains(overlay)).toBe(false);
  });

  it('shows a placeholder for an empty graph; an app-less call uses the global document', () => {
    const overlay = openPipelineFullscreen(null, 'digraph {}'); // null app → global document seam
    expect(document.body.contains(overlay)).toBe(true);
    expect(overlay.querySelector('svg.explain-graph')).toBeNull();
    expect(overlay.querySelector('.graph-overlay-zoom')).toBeNull();
    expect(overlay.textContent).toMatch(/Nothing to display/);
    overlay.querySelector('.graph-overlay-close').dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.body.contains(overlay)).toBe(false);
  });
});

describe('schema lineage graph', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  const GRAPH = {
    focus: { kind: 'db', db: 'lin' },
    nodes: [
      { id: 'lin.a', label: 'a', kind: 'table' },
      { id: 'lin.mv', label: 'mv', kind: 'mv' },
      { id: 'lin.dst', label: 'dst', kind: 'table' },
    ],
    edges: [
      { from: 'lin.a', to: 'lin.mv', kind: 'feeds' },
      { from: 'lin.mv', to: 'lin.dst', kind: 'writes' },
    ],
  };

  it('draws kind-coloured nodes, relationship-coloured edges, edge labels, and a legend', () => {
    const el = renderSchemaGraph(APP, { schemaGraph: GRAPH });
    expect(el.className).toContain('schema-graph-view');
    expect(el.querySelector('svg.explain-graph')).not.toBeNull();
    expect(el.querySelector('rect.eg-node--mv')).not.toBeNull();
    expect(el.querySelector('rect.eg-node--table')).not.toBeNull();
    expect(el.querySelector('path.eg-edge--writes')).not.toBeNull();
    expect([...el.querySelectorAll('text.eg-edge-label')].map((t) => t.textContent)).toContain('feeds');
    expect(el.querySelector('.schema-graph-legend')).not.toBeNull();
  });

  it('clicking a node expands it via showSchemaGraph', () => {
    const actions = { showSchemaGraph: vi.fn() };
    const el = renderSchemaGraph({ document, Dagre: dagre, actions }, { schemaGraph: GRAPH });
    el.querySelector('rect.eg-node--mv').dispatchEvent(new Event('click', { bubbles: true }));
    expect(actions.showSchemaGraph).toHaveBeenCalledWith({ kind: 'table', db: 'lin', table: 'mv' });
  });

  it('shows a placeholder for an empty graph', () => {
    const el = renderSchemaGraph(APP, { schemaGraph: { focus: {}, nodes: [], edges: [] } });
    expect(el.className).toBe('placeholder');
  });

  it('openSchemaFullscreen mounts an overlay with the legend and closes', () => {
    const overlay = openSchemaFullscreen({ document, Dagre: dagre, actions: { showSchemaGraph: vi.fn() } }, GRAPH);
    expect(document.body.contains(overlay)).toBe(true);
    expect(overlay.querySelector('svg.explain-graph')).not.toBeNull();
    expect(overlay.querySelector('.schema-graph-legend')).not.toBeNull();
    overlay.querySelector('.graph-overlay-close').dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.body.contains(overlay)).toBe(false);
  });
});
