import { describe, it, expect, afterEach } from 'vitest';
import { renderExplainGraph, openPipelineFullscreen } from '../../src/ui/explain-graph.js';

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

describe('openPipelineFullscreen', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  // happy-dom has no layout, so stub the canvas rect the pan/zoom math reads.
  const stubRect = (canvas) => {
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 });
  };
  const vbOf = (overlay) => overlay.querySelector('svg.explain-graph').getAttribute('viewBox').split(' ').map(Number);

  it('mounts a fullscreen overlay with the graph and an initial fitted viewBox', () => {
    const overlay = openPipelineFullscreen({ document }, DOT);
    expect(document.body.contains(overlay)).toBe(true);
    expect(overlay.className).toBe('graph-overlay');
    const svg = overlay.querySelector('svg.explain-graph');
    expect(svg.getAttribute('width')).toBe('100%');
    expect(svg.querySelectorAll('rect.eg-node')).toHaveLength(3);
    expect(overlay.querySelector('.graph-overlay-zoom')).not.toBeNull();
    expect(vbOf(overlay)[2]).toBeGreaterThan(0); // a real fitted width
  });

  it('wheel zooms in (smaller viewBox) and out (larger) around the cursor', () => {
    const overlay = openPipelineFullscreen({ document }, DOT);
    const canvas = overlay.querySelector('.graph-overlay-canvas');
    stubRect(canvas);
    const w0 = vbOf(overlay)[2];
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, clientX: 200, clientY: 100, bubbles: true, cancelable: true }));
    const w1 = vbOf(overlay)[2];
    expect(w1).toBeLessThan(w0); // zoomed in
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, clientX: 200, clientY: 100, bubbles: true, cancelable: true }));
    expect(vbOf(overlay)[2]).toBeGreaterThan(w1); // zoomed back out
  });

  it('drag pans the viewBox; a stray mousemove without a drag is a no-op', () => {
    const overlay = openPipelineFullscreen({ document }, DOT);
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
    const overlay = openPipelineFullscreen({ document }, DOT);
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
    let overlay = openPipelineFullscreen({ document }, DOT);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); // ignored
    expect(document.body.contains(overlay)).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.body.contains(overlay)).toBe(false);
    // panel click does NOT close; ✕ does
    overlay = openPipelineFullscreen({ document }, DOT);
    overlay.querySelector('.graph-overlay-panel').dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.body.contains(overlay)).toBe(true);
    overlay.querySelector('.graph-overlay-close').dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.body.contains(overlay)).toBe(false);
    // backdrop click closes; app-less call uses the global document
    overlay = openPipelineFullscreen(null, DOT);
    overlay.dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.body.contains(overlay)).toBe(false);
  });

  it('shows a placeholder (no canvas svg / zoom controls) for an empty graph', () => {
    const overlay = openPipelineFullscreen({ document }, 'digraph {}');
    expect(overlay.querySelector('svg.explain-graph')).toBeNull();
    expect(overlay.querySelector('.graph-overlay-zoom')).toBeNull();
    expect(overlay.textContent).toMatch(/No pipeline graph/);
    overlay.querySelector('.graph-overlay-close').dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.body.contains(overlay)).toBe(false);
  });
});
