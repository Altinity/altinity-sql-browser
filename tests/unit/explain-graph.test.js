import { describe, it, expect, afterEach, vi } from 'vitest';
import dagre from '@dagrejs/dagre';
import { renderExplainGraph, openPipelineFullscreen, renderSchemaGraph, openSchemaView, buildRichSchemaSvg } from '../../src/ui/explain-graph.js';

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
    // nodes carry db/name separately, as buildSchemaGraph produces them
    nodes: [
      { id: 'lin.a', label: 'a', kind: 'table', db: 'lin', name: 'a' },
      { id: 'lin.mv', label: 'mv', kind: 'mv', db: 'lin', name: 'mv' },
      { id: 'lin.dst', label: 'dst', kind: 'table', db: 'lin', name: 'dst' },
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

  it('clicking a node runs SHOW CREATE for it (insertCreate) into the editor', () => {
    const actions = { insertCreate: vi.fn() };
    const el = renderSchemaGraph({ document, Dagre: dagre, actions }, { schemaGraph: GRAPH });
    el.querySelector('rect.eg-node--mv').dispatchEvent(new Event('click', { bubbles: true }));
    expect(actions.insertCreate).toHaveBeenCalledWith('lin.mv');
  });

  it('clicking an external (ext:) leaf in the inline graph is a no-op (no SHOW CREATE)', () => {
    const actions = { insertCreate: vi.fn() };
    const g = {
      focus: { kind: 'db', db: 'lin' },
      nodes: [
        { id: 'lin.d', label: 'd', kind: 'dictionary', db: 'lin', name: 'd' },
        { id: 'ext:HTTP', label: 'HTTP', kind: 'external', db: '', name: 'HTTP' },
      ],
      edges: [{ from: 'ext:HTTP', to: 'lin.d', kind: 'dict' }],
    };
    const el = renderSchemaGraph({ document, Dagre: dagre, actions }, { schemaGraph: g });
    el.querySelector('rect.eg-node--external').dispatchEvent(new Event('click', { bubbles: true }));
    expect(actions.insertCreate).not.toHaveBeenCalled();
  });

  it('clicking a node with a non-bare name backtick-quotes the SHOW CREATE target', () => {
    const actions = { insertCreate: vi.fn() };
    const g = { focus: { kind: 'db', db: 'target_all' }, nodes: [{ id: 'target_all.a-b.parquet', label: 'a-b.parquet', kind: 'table', db: 'target_all', name: 'a-b.parquet' }], edges: [] };
    const el = renderSchemaGraph({ document, Dagre: dagre, actions }, { schemaGraph: g });
    el.querySelector('rect.eg-node--table').dispatchEvent(new Event('click', { bubbles: true }));
    expect(actions.insertCreate).toHaveBeenCalledWith('target_all.`a-b.parquet`');
  });

  it('a plain drag does not pan (click selects); ⌘/Ctrl-drag pans', () => {
    const el = renderSchemaGraph({ document, Dagre: dagre, actions: { insertCreate: vi.fn() } }, { schemaGraph: GRAPH });
    const svg = el.querySelector('svg.explain-graph');
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 });
    const vbX = () => svg.getAttribute('viewBox').split(' ').map(Number)[0];
    const x0 = vbX();
    // plain drag → no pan (modifierPan gate blocks the mousedown)
    el.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100, bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 100, bubbles: true }));
    expect(vbX()).toBe(x0);
    // ⌘-drag → pans
    el.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100, metaKey: true, bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 100, bubbles: true }));
    expect(vbX()).not.toBe(x0);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  it('shows a placeholder for an empty graph', () => {
    const el = renderSchemaGraph(APP, { schemaGraph: { focus: {}, nodes: [], edges: [] } });
    expect(el.className).toBe('placeholder');
  });

  it('explains a whole-DB result with no objects to draw', () => {
    // A DB with tables but no links now renders the tables as standalone nodes;
    // the placeholder is only reached when there are genuinely no objects.
    const el = renderSchemaGraph(APP, { schemaGraph: { focus: { kind: 'db', db: 'target_all' }, nodes: [], edges: [] } });
    expect(el.className).toBe('placeholder');
    expect(el.textContent).toMatch(/No objects in target_all/);
  });

  it('explains an empty table-focus result', () => {
    const el = renderSchemaGraph(APP, { schemaGraph: { focus: { kind: 'table', db: 'd', table: 'lonely' }, nodes: [], edges: [] } });
    expect(el.textContent).toMatch(/d\.lonely has no data-flow relationships/);
  });

  // Overlay-fallback mode: openWindow returns null, so openSchemaView falls back
  // to the in-app modal overlay (mounted in the main document).
  const overlayApp = (actions = {}) => ({ document, Dagre: dagre, openWindow: () => null, actions });
  const overlayOf = () => document.querySelector('.graph-overlay');

  it('openSchemaView (overlay fallback) mounts the legend incl. Buffer+Merge, then renders and closes', () => {
    const view = openSchemaView(overlayApp({ openNodeDetail: vi.fn() }));
    const overlay = overlayOf();
    expect(document.body.contains(overlay)).toBe(true);
    expect(overlay.textContent).toMatch(/Loading/); // placeholder before render
    view.render(GRAPH);
    expect(overlay.querySelector('svg.explain-graph')).not.toBeNull();
    const legend = [...overlay.querySelectorAll('.schema-graph-legend .sg-leg')].map((s) => s.textContent);
    expect(legend).toEqual(expect.arrayContaining(['Buffer', 'Merge', 'External']));
    expect(overlay.querySelector('.graph-overlay-note')).toBeNull(); // not truncated
    overlay.querySelector('.graph-overlay-close').dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.body.contains(overlay)).toBe(false);
  });

  it('overlay closes on Escape and on a backdrop click (but not a panel click)', () => {
    openSchemaView(overlayApp({ openNodeDetail: vi.fn() })).render(GRAPH);
    let overlay = overlayOf();
    overlay.querySelector('.graph-overlay-panel').dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.body.contains(overlay)).toBe(true); // panel click stops propagation
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); // ignored
    expect(document.body.contains(overlay)).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.body.contains(overlay)).toBe(false);
    openSchemaView(overlayApp({ openNodeDetail: vi.fn() })).render(GRAPH);
    overlay = overlayOf();
    overlay.dispatchEvent(new Event('click', { bubbles: true })); // backdrop
    expect(document.body.contains(overlay)).toBe(false);
  });

  it('Esc closes the open detail pane first (clearing its card ring), then the overlay', () => {
    openSchemaView(overlayApp({ openNodeDetail: vi.fn() })).render(GRAPH);
    const overlay = overlayOf();
    const panel = overlay.querySelector('.graph-overlay-panel');
    const pane = document.createElement('div'); pane.className = 'schema-detail';
    panel.appendChild(pane);
    // a selected card with a ring, as markSelected would have left it on the canvas
    const card = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    card.setAttribute('class', 'eg-card eg-card--selected');
    card.setAttribute('data-node-id', 'x.y');
    card.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'rect')).setAttribute('class', 'eg-card-ring');
    panel.appendChild(card);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(overlay.querySelector('.schema-detail')).toBeNull();      // pane closed
    expect(overlay.querySelector('.eg-card--selected')).toBeNull();  // selection class cleared
    expect(overlay.querySelector('.eg-card-ring')).toBeNull();       // ring removed
    expect(document.body.contains(overlay)).toBe(true);              // overlay stays
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.body.contains(overlay)).toBe(false); // second Esc closes overlay
  });

  it('falls back to the overlay using the global document when app has none', () => {
    const view = openSchemaView({ Dagre: dagre, openWindow: () => null, actions: { openNodeDetail: vi.fn() } });
    view.render(GRAPH);
    expect(overlayOf()).not.toBeNull(); // app.document undefined → global document
    overlayOf().querySelector('.graph-overlay-close').dispatchEvent(new Event('click', { bubbles: true }));
  });

  it('clicking a node opens the detail pane (openNodeDetail); ⌘-click and ext: leaves do not', () => {
    const actions = { openNodeDetail: vi.fn(), insertCreate: vi.fn() };
    const g = {
      focus: { kind: 'db', db: 'lin' },
      nodes: [
        { id: 'lin.a', label: 'a', kind: 'table', db: 'lin', name: 'a' },
        { id: 'ext:HTTP', label: 'HTTP', kind: 'external', db: '', name: 'HTTP', external: true },
      ],
      edges: [{ from: 'ext:HTTP', to: 'lin.a', kind: 'dict' }],
    };
    openSchemaView(overlayApp(actions)).render(g);
    const overlay = overlayOf();
    const card = [...overlay.querySelectorAll('g.eg-card')].find((c) => c.getAttribute('data-node-id') === 'lin.a');
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(actions.openNodeDetail).toHaveBeenCalledTimes(1);
    card.dispatchEvent(new MouseEvent('click', { metaKey: true, bubbles: true })); // ⌘ reserved for moving
    expect(actions.openNodeDetail).toHaveBeenCalledTimes(1);
    const ext = [...overlay.querySelectorAll('g.eg-card')].find((c) => c.querySelector('rect.eg-node--external'));
    ext.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(actions.openNodeDetail).toHaveBeenCalledTimes(1);
    expect(actions.insertCreate).not.toHaveBeenCalled();
  });

  it('shows a truncation banner when the graph is truncated', () => {
    openSchemaView(overlayApp({ openNodeDetail: vi.fn() })).render({ ...GRAPH, truncated: true });
    const note = overlayOf().querySelector('.graph-overlay-note');
    expect(note).not.toBeNull();
    expect(note.textContent).toMatch(/truncated/i);
  });

  it('renders an empty-graph message when there is nothing to draw', () => {
    openSchemaView(overlayApp({ openNodeDetail: vi.fn() })).render({ focus: { kind: 'db', db: 'lin' }, nodes: [], edges: [] });
    expect(overlayOf().textContent).toMatch(/No objects in lin/);
    expect(overlayOf().querySelector('svg.explain-graph')).toBeNull();
  });

  it('fail() shows the message in the canvas and toasts the main window', () => {
    const view = openSchemaView(overlayApp({ openNodeDetail: vi.fn() }));
    view.fail('Could not load the schema graph');
    expect(overlayOf().textContent).toMatch(/Could not load/);
    expect(document.querySelector('.share-toast')).not.toBeNull();
  });

  it('render()/fail() are no-ops once the view was closed (closed before the lineage loaded)', () => {
    // Pop-up blocked → overlay opens showing Loading…; user closes it (Esc) while
    // the fetch is still pending, THEN render() arrives. It must not mount the graph
    // or attach the (leaking) main-document key handlers.
    const view = openSchemaView(overlayApp({ openNodeDetail: vi.fn() }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); // close before render
    expect(overlayOf()).toBeNull();
    view.render(GRAPH); // late-arriving fetch result
    expect(document.querySelector('g.eg-card')).toBeNull(); // nothing mounted
    view.fail('too late'); // also a no-op (no toast)
    expect(document.querySelector('.share-toast')).toBeNull();
    // the leaked keydown handler is gone: a ⌘Z in the editor is not preventDefaulted
    const ev = new KeyboardEvent('keydown', { key: 'z', metaKey: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('overlay theme toggle drives the app’s own toggleTheme (keeps state/pref/header in sync)', () => {
    const toggleTheme = vi.fn();
    const view = openSchemaView({ document, Dagre: dagre, openWindow: () => null, toggleTheme, actions: { openNodeDetail: vi.fn() } });
    const canvas = overlayOf().querySelector('.graph-overlay-canvas');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 });
    view.render(GRAPH);
    overlayOf().querySelector('button[title="Toggle theme"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(toggleTheme).toHaveBeenCalledTimes(1); // routed through the app, not a stray data-theme flip
  });

  it('clears the latched .modkey cursor when the window loses focus', () => {
    const view = openSchemaView(overlayApp({ openNodeDetail: vi.fn() }));
    const canvas = overlayOf().querySelector('.graph-overlay-canvas');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 });
    view.render(GRAPH);
    document.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true, key: 'Meta' }));
    expect(canvas.classList.contains('modkey')).toBe(true);
    window.dispatchEvent(new Event('blur')); // keyup may never arrive on blur
    expect(canvas.classList.contains('modkey')).toBe(false);
  });

  it('refits on window resize and drops the listener once the overlay is gone', () => {
    const view = openSchemaView(overlayApp({ openNodeDetail: vi.fn() }));
    const canvas = overlayOf().querySelector('.graph-overlay-canvas');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 });
    view.render(GRAPH);
    const svg = canvas.querySelector('svg.explain-graph');
    window.dispatchEvent(new Event('resize')); // connected → refit, no throw
    expect(svg.getAttribute('viewBox')).not.toBeNull();
    overlayOf().querySelector('.graph-overlay-close').dispatchEvent(new Event('click', { bubbles: true }));
    window.dispatchEvent(new Event('resize')); // disconnected → self-removes, no throw
    expect(document.querySelector('.graph-overlay')).toBeNull();
  });
});

describe('openSchemaView — real browser tab', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  const GRAPH = {
    focus: { kind: 'db', db: 'lin' },
    nodes: [
      { id: 'lin.a', label: 'a', kind: 'table', db: 'lin', name: 'a' },
      { id: 'lin.mv', label: 'mv', kind: 'mv', db: 'lin', name: 'mv' },
      { id: 'lin.dst', label: 'dst', kind: 'table', db: 'lin', name: 'dst' },
    ],
    edges: [
      { from: 'lin.a', to: 'lin.mv', kind: 'feeds' },
      { from: 'lin.mv', to: 'lin.dst', kind: 'writes' },
    ],
  };
  // A same-origin child window backed by a detached document (what a real
  // about:blank tab exposes to the opener), with capturable pagehide/close.
  const makeWin = (over = {}) => {
    const childDoc = document.implementation.createHTMLDocument('');
    const ls = {};
    return {
      document: childDoc, closed: false,
      close: over.close || vi.fn(),
      focus: vi.fn(),
      addEventListener: (t, fn) => { ls[t] = fn; },
      fire: (t) => ls[t] && ls[t](),
    };
  };
  const tabApp = (win, over = {}) => ({
    document, Dagre: dagre, stylesText: 'body{color:red}', openWindow: () => win,
    actions: { openNodeDetail: vi.fn(), insertCreate: vi.fn() }, ...over,
  });
  const stub = (canvas) => { canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 }); };

  it('builds the graph in the child document: copies CSS, mirrors theme, fills the tab', () => {
    document.documentElement.setAttribute('data-theme', 'dark'); // data-density left unset → skipped
    const win = makeWin();
    const app = tabApp(win);
    const view = openSchemaView(app);
    expect(win.document.querySelector('style').textContent).toBe('body{color:red}');
    expect(win.document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(win.document.documentElement.getAttribute('data-density')).toBeNull();
    expect(win.document.body.className).toBe('schema-tab');
    expect(win.focus).toHaveBeenCalled(); // tab brought to front for key events
    const canvas = win.document.querySelector('.graph-overlay-canvas');
    expect(canvas.getAttribute('tabindex')).toBe('-1'); // focusable → receives ⌘ key events
    stub(canvas);
    view.render(GRAPH);
    expect(win.document.querySelectorAll('g.eg-card')).toHaveLength(3);
    // browser-tab title is "Schema:<db>"; headline is "Schema: <db>"; colour key in the bar; no close ✕
    expect(win.document.title).toBe('Schema:lin');
    expect(win.document.querySelector('.graph-overlay-title').textContent).toBe('Schema: lin');
    expect(win.document.querySelector('.graph-overlay-bar .schema-graph-legend')).not.toBeNull();
    expect(win.document.querySelector('.graph-overlay-close')).toBeNull();
    // fitWidth frames to the container aspect (no horizontal letterbox)
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const vb = canvas.querySelector('svg.explain-graph').getAttribute('viewBox').split(' ').map(Number);
    expect(vb[2] / vb[3]).toBeCloseTo(400 / 200, 4);
    // edges + cards are tagged for the move handler
    expect(canvas.querySelector('path[data-from="lin.a"][data-to="lin.mv"]')).not.toBeNull();
    expect(canvas.querySelector('g.eg-card[data-node-id="lin.mv"]')).not.toBeNull();
  });

  it('the theme switcher toggles the tab document’s data-theme', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const win = makeWin();
    const view = openSchemaView(tabApp(win));
    stub(win.document.querySelector('.graph-overlay-canvas'));
    view.render(GRAPH);
    const btn = win.document.querySelector('.graph-overlay-actions button[title="Toggle theme"]');
    expect(btn).not.toBeNull();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(win.document.documentElement.getAttribute('data-theme')).toBe('light');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(win.document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('falls back to stylesText="" when the app has none', () => {
    const win = makeWin();
    openSchemaView(tabApp(win, { stylesText: undefined }));
    expect(win.document.querySelector('style').textContent).toBe('');
  });

  it('⌘+drag on a node moves it and straightens only the incident edges; mouseup records the position', () => {
    const win = makeWin();
    const view = openSchemaView(tabApp(win));
    const canvas = win.document.querySelector('.graph-overlay-canvas');
    stub(canvas);
    const positions = {};
    view.render({ ...GRAPH, savedPositions: positions });
    const incident = canvas.querySelector('path[data-from="lin.a"][data-to="lin.mv"]');
    const other = canvas.querySelector('path[data-from="lin.mv"][data-to="lin.dst"]');
    const card = canvas.querySelector('g.eg-card[data-node-id="lin.a"]');
    const incBefore = incident.getAttribute('d');
    const otherBefore = other.getAttribute('d');
    card.dispatchEvent(new MouseEvent('mousedown', { metaKey: true, clientX: 100, clientY: 100, bubbles: true }));
    win.document.dispatchEvent(new MouseEvent('mousemove', { clientX: 160, clientY: 140, buttons: 1, bubbles: true }));
    expect(card.getAttribute('transform')).toMatch(/translate\(/);
    expect(incident.getAttribute('d')).not.toBe(incBefore); // incident edge re-routed straight
    expect(other.getAttribute('d')).toBe(otherBefore); // non-incident edge untouched
    win.document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(positions['lin.a']).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    // after release, further moves do nothing
    const settled = card.getAttribute('transform');
    win.document.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 300, bubbles: true }));
    expect(card.getAttribute('transform')).toBe(settled);
  });

  it('⌘Z undoes a node move, ⌘⇧Z and ⌘Y redo it; undo/redo past the ends are no-ops', () => {
    const win = makeWin();
    const view = openSchemaView(tabApp(win));
    const canvas = win.document.querySelector('.graph-overlay-canvas');
    stub(canvas);
    view.render({ ...GRAPH, savedPositions: {} });
    const card = canvas.querySelector('g.eg-card[data-node-id="lin.a"]');
    const key = (opts) => win.document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...opts }));
    // perform a move
    card.dispatchEvent(new MouseEvent('mousedown', { metaKey: true, clientX: 100, clientY: 100, bubbles: true }));
    win.document.dispatchEvent(new MouseEvent('mousemove', { clientX: 160, clientY: 140, buttons: 1, bubbles: true }));
    win.document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const moved = card.getAttribute('transform');
    expect(moved).toMatch(/translate\(/);
    key({ metaKey: true, key: 'z' });                     // undo → back to origin
    expect(card.getAttribute('transform')).toBe('translate(0 0)');
    key({ metaKey: true, key: 'y' });                     // ⌘Y redo → moved
    expect(card.getAttribute('transform')).toBe(moved);
    key({ metaKey: true, key: 'z' });                     // undo again
    key({ metaKey: true, shiftKey: true, key: 'z' });     // ⌘⇧Z redo → moved
    expect(card.getAttribute('transform')).toBe(moved);
    key({ metaKey: true, shiftKey: true, key: 'z' });     // redo past end → no-op (future empty)
    expect(card.getAttribute('transform')).toBe(moved);
    key({ metaKey: true, key: 'z' });                     // undo
    key({ metaKey: true, key: 'z' });                     // undo past end → no-op (past empty)
    expect(card.getAttribute('transform')).toBe('translate(0 0)');
    // a non-undo modifier key is ignored (no throw)
    key({ metaKey: true, key: 'a' });
    expect(card.getAttribute('transform')).toBe('translate(0 0)');
  });

  it('headline Undo/Redo buttons drive the move history and reflect enabled state', () => {
    const win = makeWin();
    const view = openSchemaView(tabApp(win));
    const canvas = win.document.querySelector('.graph-overlay-canvas');
    stub(canvas);
    view.render({ ...GRAPH, savedPositions: {} });
    const [undoBtn, redoBtn] = ['Undo move (⌘Z)', 'Redo move (⌘⇧Z)'].map((t) => win.document.querySelector(`button[title="${t}"]`));
    expect(undoBtn).not.toBeNull();
    expect(undoBtn.disabled).toBe(true); // nothing to undo yet
    expect(redoBtn.disabled).toBe(true);
    const card = canvas.querySelector('g.eg-card[data-node-id="lin.a"]');
    card.dispatchEvent(new MouseEvent('mousedown', { metaKey: true, clientX: 100, clientY: 100, bubbles: true }));
    win.document.dispatchEvent(new MouseEvent('mousemove', { clientX: 160, clientY: 140, buttons: 1, bubbles: true }));
    win.document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const moved = card.getAttribute('transform');
    expect(undoBtn.disabled).toBe(false); // a move is now undoable
    undoBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(card.getAttribute('transform')).toBe('translate(0 0)');
    expect(undoBtn.disabled).toBe(true); // nothing left to undo
    expect(redoBtn.disabled).toBe(false); // …but a redo is available
    redoBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(card.getAttribute('transform')).toBe(moved);
    expect(redoBtn.disabled).toBe(true);
  });

  it('plain drag, ⌘-drag off a node, and ⌘-drag on an unknown node id do not move anything', () => {
    const win = makeWin();
    const view = openSchemaView(tabApp(win));
    const canvas = win.document.querySelector('.graph-overlay-canvas');
    stub(canvas);
    view.render({ ...GRAPH, savedPositions: {} });
    const card = canvas.querySelector('g.eg-card[data-node-id="lin.a"]');
    card.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100, bubbles: true })); // no modifier
    win.document.dispatchEvent(new MouseEvent('mousemove', { clientX: 160, clientY: 140, buttons: 1, bubbles: true }));
    expect(card.getAttribute('transform')).toBeNull();
    canvas.dispatchEvent(new MouseEvent('mousedown', { metaKey: true, clientX: 5, clientY: 5, bubbles: true })); // empty space
    win.document.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 50, bubbles: true }));
    expect(card.getAttribute('transform')).toBeNull();
    const ghost = win.document.createElementNS('http://www.w3.org/2000/svg', 'g');
    ghost.setAttribute('data-node-id', 'nope');
    canvas.querySelector('svg').appendChild(ghost);
    ghost.dispatchEvent(new MouseEvent('mousedown', { metaKey: true, clientX: 5, clientY: 5, bubbles: true }));
    win.document.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: 60, bubbles: true }));
    expect(ghost.getAttribute('transform')).toBeNull();
  });

  it('records nothing when no savedPositions map is supplied', () => {
    const win = makeWin();
    const view = openSchemaView(tabApp(win));
    const canvas = win.document.querySelector('.graph-overlay-canvas');
    stub(canvas);
    view.render(GRAPH); // no savedPositions
    const card = canvas.querySelector('g.eg-card[data-node-id="lin.a"]');
    card.dispatchEvent(new MouseEvent('mousedown', { metaKey: true, clientX: 100, clientY: 100, bubbles: true }));
    win.document.dispatchEvent(new MouseEvent('mousemove', { clientX: 160, clientY: 140, buttons: 1, bubbles: true }));
    win.document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); // no throw
    expect(card.getAttribute('transform')).toMatch(/translate\(/);
  });

  it('ends the drag when the button is released off-window (a no-button mousemove)', () => {
    const win = makeWin();
    const view = openSchemaView(tabApp(win));
    const canvas = win.document.querySelector('.graph-overlay-canvas');
    stub(canvas);
    view.render({ ...GRAPH, savedPositions: {} });
    const card = canvas.querySelector('g.eg-card[data-node-id="lin.a"]');
    card.dispatchEvent(new MouseEvent('mousedown', { metaKey: true, clientX: 100, clientY: 100, buttons: 1, bubbles: true }));
    win.document.dispatchEvent(new MouseEvent('mousemove', { clientX: 160, clientY: 140, buttons: 1, bubbles: true }));
    const moved = card.getAttribute('transform');
    expect(moved).toMatch(/translate\(/);
    // buttons === 0 means the button was released outside the window → drag ends.
    win.document.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 200, buttons: 0, bubbles: true }));
    expect(canvas.classList.contains('grabbing')).toBe(false);
    // a subsequent move (even with a button) no longer relocates the node
    win.document.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 300, buttons: 1, bubbles: true }));
    expect(card.getAttribute('transform')).toBe(moved);
  });

  it('a plain (no-modifier) press on a card does not pan; on empty canvas it does', () => {
    const win = makeWin();
    const view = openSchemaView(tabApp(win));
    const canvas = win.document.querySelector('.graph-overlay-canvas');
    stub(canvas);
    view.render({ ...GRAPH, savedPositions: {} });
    const svg = canvas.querySelector('svg.explain-graph');
    const card = canvas.querySelector('g.eg-card[data-node-id="lin.a"]');
    // plain press on a card is swallowed → the canvas does not pan
    const vbBefore = svg.getAttribute('viewBox');
    card.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100, buttons: 1, bubbles: true }));
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 160, clientY: 160, buttons: 1, bubbles: true }));
    expect(svg.getAttribute('viewBox')).toBe(vbBefore); // no pan from a card
    canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    // plain press on EMPTY canvas falls through to the pan handler → viewBox moves
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 5, clientY: 5, buttons: 1, bubbles: true }));
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 80, clientY: 80, buttons: 1, bubbles: true }));
    expect(svg.getAttribute('viewBox')).not.toBe(vbBefore); // empty-canvas plain drag pans
  });

  it('repositions edge labels with a moved node and tolerates an unlabelled incident edge', () => {
    const win = makeWin();
    const view = openSchemaView(tabApp(win));
    const canvas = win.document.querySelector('.graph-overlay-canvas');
    stub(canvas);
    // lin.a has a labelled edge (feeds) and an unlabelled one (kind '') incident to it.
    const g = {
      focus: { kind: 'db', db: 'lin' },
      nodes: [
        { id: 'lin.a', label: 'a', kind: 'table', db: 'lin', name: 'a' },
        { id: 'lin.mv', label: 'mv', kind: 'mv', db: 'lin', name: 'mv' },
        { id: 'lin.x', label: 'x', kind: 'table', db: 'lin', name: 'x' },
      ],
      edges: [
        { from: 'lin.a', to: 'lin.mv', kind: 'feeds' },
        { from: 'lin.a', to: 'lin.x', kind: '' }, // falsy kind → no label rendered
      ],
      savedPositions: {},
    };
    view.render(g);
    const label = canvas.querySelector('text[data-lbl-eidx]');
    expect(label).not.toBeNull();
    const lblBefore = label.getAttribute('x');
    const card = canvas.querySelector('g.eg-card[data-node-id="lin.a"]');
    card.dispatchEvent(new MouseEvent('mousedown', { metaKey: true, clientX: 100, clientY: 100, buttons: 1, bubbles: true }));
    win.document.dispatchEvent(new MouseEvent('mousemove', { clientX: 220, clientY: 220, buttons: 1, bubbles: true })); // no throw on the unlabelled edge
    win.document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(label.getAttribute('x')).not.toBe(lblBefore); // label followed its edge
  });

  it('a ⌘ press with no movement records nothing (no undoable op)', () => {
    const win = makeWin();
    const view = openSchemaView(tabApp(win));
    const canvas = win.document.querySelector('.graph-overlay-canvas');
    stub(canvas);
    view.render({ ...GRAPH, savedPositions: {} });
    const undoBtn = win.document.querySelector('button[title="Undo move (⌘Z)"]');
    const card = canvas.querySelector('g.eg-card[data-node-id="lin.a"]');
    card.dispatchEvent(new MouseEvent('mousedown', { metaKey: true, clientX: 100, clientY: 100, buttons: 1, bubbles: true }));
    win.document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); // released without moving
    expect(card.getAttribute('transform')).toBeNull(); // never moved
    expect(undoBtn.disabled).toBe(true); // nothing recorded
  });

  it('titles a table-focus view "Schema:<db>.<table>"', () => {
    const win = makeWin();
    const view = openSchemaView(tabApp(win));
    stub(win.document.querySelector('.graph-overlay-canvas'));
    view.render({ ...GRAPH, focus: { kind: 'table', db: 'lin', table: 'events' } });
    expect(win.document.title).toBe('Schema:lin.events');
    expect(win.document.querySelector('.graph-overlay-title').textContent).toBe('Schema: lin.events');
  });

  it('⌘/Ctrl toggles the hand-cursor (.modkey) class', () => {
    const win = makeWin();
    const view = openSchemaView(tabApp(win));
    const canvas = win.document.querySelector('.graph-overlay-canvas');
    stub(canvas);
    view.render(GRAPH);
    win.document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })); // no modifier → no class
    expect(canvas.classList.contains('modkey')).toBe(false);
    win.document.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true, key: 'Meta' }));
    expect(canvas.classList.contains('modkey')).toBe(true);
    win.document.dispatchEvent(new KeyboardEvent('keyup', { metaKey: true, key: 'a' })); // still held → stays
    expect(canvas.classList.contains('modkey')).toBe(true);
    win.document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' }));
    expect(canvas.classList.contains('modkey')).toBe(false);
  });

  it('Esc closes the open detail pane in the tab', () => {
    const win = makeWin();
    const view = openSchemaView(tabApp(win));
    stub(win.document.querySelector('.graph-overlay-canvas'));
    view.render(GRAPH);
    const pane = win.document.createElement('div'); pane.className = 'schema-detail';
    win.document.querySelector('.graph-overlay-panel').appendChild(pane);
    win.document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(win.document.querySelector('.schema-detail')).toBeNull();
  });

  it('routes a node click to its OWN tab even when a second view is open', () => {
    // Open two views sharing one app; each must keep targeting its own document.
    const winA = makeWin();
    const captured = [];
    const app = tabApp(winA, { actions: { openNodeDetail: (n, doc) => captured.push(doc), insertCreate: vi.fn() } });
    const viewA = openSchemaView(app); stub(winA.document.querySelector('.graph-overlay-canvas')); viewA.render(GRAPH);
    const winB = makeWin();
    app.openWindow = () => winB;
    const viewB = openSchemaView(app); stub(winB.document.querySelector('.graph-overlay-canvas')); viewB.render(GRAPH);
    // Click a node in the FIRST tab after the second opened.
    winA.document.querySelector('g.eg-card[data-node-id="lin.a"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(captured[0]).toBe(winA.document); // not winB.document
  });

  it('falls back to the overlay when the window is null, has no document, or is COOP-severed', () => {
    openSchemaView({ document, Dagre: dagre, openWindow: () => null, actions: {} });
    expect(document.querySelector('.graph-overlay')).not.toBeNull();
    document.body.innerHTML = '';
    openSchemaView({ document, Dagre: dagre, openWindow: () => ({ document: null }), actions: {} });
    expect(document.querySelector('.graph-overlay')).not.toBeNull();
    document.body.innerHTML = '';
    openSchemaView({ document, Dagre: dagre, openWindow: () => ({ get document() { throw new Error('coop'); } }), actions: {} });
    expect(document.querySelector('.graph-overlay')).not.toBeNull();
  });
});

describe('buildRichSchemaSvg (rich cards)', () => {
  const RICH = {
    nodes: [
      {
        id: 'lin.a', label: 'a', kind: 'table', db: 'lin', name: 'a',
        card: {
          title: 'lin.a', kind: 'table', summary: 'MergeTree · 5 rows · 0 B',
          cols: [{ name: 'id', type: 'UInt64', roles: ['PK', 'SK'] }, { name: 'd', type: 'Date', roles: [] }],
          overflow: 2, skipLine: 'idx: i (minmax)',
        },
      },
      { id: 'lin.mv', label: 'mv', kind: 'mv', db: 'lin', name: 'mv' }, // no .card → header-only fallback
      { id: 'lin.dst', label: 'dst', kind: 'table', db: 'lin', name: 'dst' },
    ],
    edges: [
      { from: 'lin.a', to: 'lin.mv', kind: 'feeds' },
      { from: 'lin.mv', to: 'lin.dst', kind: '' }, // empty kind → no edge label drawn
    ],
  };

  it('draws a card group per node with title, summary, divider, columns + role badges, overflow and skip rows', () => {
    const built = buildRichSchemaSvg(RICH, dagre);
    expect(built.nodeCount).toBe(3);
    const svg = built.svg;
    expect(svg.querySelectorAll('g.eg-card')).toHaveLength(3);
    expect(svg.querySelector('rect.eg-node--table')).not.toBeNull();
    expect(svg.querySelector('rect.eg-node--mv')).not.toBeNull();
    expect([...svg.querySelectorAll('text.eg-card-title')].map((t) => t.textContent)).toContain('lin.a');
    expect([...svg.querySelectorAll('text.eg-card-header')].map((t) => t.textContent)).toContain('MergeTree · 5 rows · 0 B');
    expect(svg.querySelector('line.eg-card-divider')).not.toBeNull();
    expect(svg.querySelectorAll('text.eg-col').length).toBeGreaterThanOrEqual(2);
    expect(svg.querySelector('tspan.eg-badge--pk')).not.toBeNull();
    expect(svg.querySelector('tspan.eg-badge--sk')).not.toBeNull();
    expect([...svg.querySelectorAll('text.eg-col-more')].map((t) => t.textContent)).toContain('+2 more');
    expect(svg.querySelector('text.eg-skipidx').textContent).toBe('idx: i (minmax)');
    // only the labelled edge draws a mid-edge label; the empty-kind edge draws none
    expect([...svg.querySelectorAll('text.eg-edge-label')].map((t) => t.textContent)).toEqual(['feeds']);
  });

  it('falls back to a header-only card for a node without a .card model', () => {
    const built = buildRichSchemaSvg(RICH, dagre);
    const titles = [...built.svg.querySelectorAll('text.eg-card-title')].map((t) => t.textContent);
    expect(titles).toContain('mv'); // buildCardModel(node) → label
    const headers = [...built.svg.querySelectorAll('text.eg-card-header')].map((t) => t.textContent);
    expect(headers).toContain('mv · — rows · —'); // engine falls back to kind, no row/byte data
  });

  it('fires onNode with the clicked node (which carries db/name for SHOW CREATE)', () => {
    const onNode = vi.fn();
    const built = buildRichSchemaSvg(RICH, dagre, onNode);
    built.svg.querySelector('g.eg-card').dispatchEvent(new Event('click', { bubbles: true }));
    expect(onNode).toHaveBeenCalledTimes(1);
    const arg = onNode.mock.calls[0][0];
    expect(arg).toMatchObject({ db: 'lin' });
    expect(typeof arg.id).toBe('string');
  });

  it('returns an empty result (no card groups) for an empty or missing graph', () => {
    expect(buildRichSchemaSvg({ nodes: [], edges: [] }, dagre).nodeCount).toBe(0);
    const built = buildRichSchemaSvg(null, dagre);
    expect(built.nodeCount).toBe(0);
    expect(built.svg.querySelectorAll('g.eg-card')).toHaveLength(0);
  });

  it('marks external (other-db) nodes with eg-node--ext, leaving local nodes plain', () => {
    const g = {
      nodes: [
        { id: 'a.t', label: 't', kind: 'table', db: 'a', name: 't', external: false },
        { id: 'b.u', label: 'u', kind: 'mv', db: 'b', name: 'u', external: true },
      ],
      edges: [{ from: 'a.t', to: 'b.u', kind: 'feeds' }],
    };
    const built = buildRichSchemaSvg(g, dagre);
    expect(built.svg.querySelectorAll('rect.eg-node--ext')).toHaveLength(1);
    expect(built.svg.querySelector('rect.eg-node--ext').getAttribute('class')).toContain('eg-node--mv');
  });

  it('applies saved positions and straightens only the edges touching a moved node', () => {
    const built = buildRichSchemaSvg({ ...RICH, savedPositions: { 'lin.a': { x: 500, y: 500 } } }, dagre);
    const moved = [...built.svg.querySelectorAll('g.eg-card')].find((c) => c.getAttribute('data-node-id') === 'lin.a');
    expect(moved.querySelector('rect').getAttribute('x')).toBe('500'); // drawn at the saved x
    // the edge touching lin.a is a 2-point straight line (exactly one L); the other keeps dagre's route
    const inc = built.svg.querySelector('path[data-from="lin.a"][data-to="lin.mv"]');
    expect((inc.getAttribute('d').match(/L/g) || []).length).toBe(1);
    expect(built).toMatchObject({ nodes: expect.any(Array), edges: expect.any(Array) });
  });
});
