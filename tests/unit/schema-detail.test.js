import { describe, it, expect, afterEach } from 'vitest';
import { openDetailPane } from '../../src/ui/schema-detail.js';

afterEach(() => { document.body.innerHTML = ''; });

// openDetailPane mounts into the live overlay panel — create a stand-in.
function mountPanel() {
  const p = document.createElement('div');
  p.className = 'graph-overlay-panel';
  p.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 });
  document.body.appendChild(p);
  return p;
}
// A graph card stand-in (the rich full-view nodes carry data-node-id + a rect).
const SVG_NS = 'http://www.w3.org/2000/svg';
function mountCard(id, { rect = true } = {}) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'eg-card');
  g.setAttribute('data-node-id', id);
  if (rect) {
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('class', 'eg-node eg-node--table');
    r.setAttribute('x', '10'); r.setAttribute('y', '20'); r.setAttribute('width', '100'); r.setAttribute('height', '60');
    g.appendChild(r);
  }
  document.body.appendChild(g);
  return g;
}
const APP = (over = {}) => ({ document, actions: {}, ...over });
const NODE = { id: 'a.t', db: 'a', name: 't', kind: 'table' };
const DETAIL = {
  columns: [
    { name: 'id', type: 'UInt64', codec: 'LZ4', is_in_primary_key: 1, compressed: 1024, uncompressed: 4096 },
    { name: 'v', type: 'String', compressed: 50, uncompressed: 100 },
  ],
  partitions: [{ partition: '2024', parts: 3, rows: 100, bytes: 5000 }],
  ddl: 'CREATE TABLE a.t (id UInt64) ENGINE = MergeTree',
};

describe('openDetailPane', () => {
  it('mounts a pane with columns + key roles, partitions, and DDL', () => {
    mountPanel();
    const pane = openDetailPane(APP(), NODE, DETAIL);
    expect(pane).not.toBeNull();
    expect(document.querySelector('.schema-detail')).not.toBeNull();
    const heads = [...pane.querySelectorAll('h4')].map((e) => e.textContent);
    expect(heads).toContain('Columns (2)');
    expect(heads).toContain('Partitions (1)');
    expect(heads).toContain('DDL');
    // first column carries a PK role; second has none
    const roleCells = [...pane.querySelectorAll('.schema-detail-roles')].map((e) => e.textContent);
    expect(roleCells[0]).toBe('PK');
    expect(roleCells[1]).toBe('');
    expect(pane.querySelector('.schema-detail-ddl').textContent).toContain('CREATE TABLE');
  });

  it('has no action button in the head (just the ident + kind)', () => {
    mountPanel();
    const pane = openDetailPane(APP(), NODE, DETAIL);
    // the only button is the ✕ close affordance — no "Insert SHOW CREATE" etc.
    const labels = [...pane.querySelectorAll('.schema-detail-head button')];
    expect(labels).toHaveLength(0);
  });

  it('rings the clicked card with a double border (accent ring + selected class)', () => {
    mountPanel();
    const card = mountCard('a.t'); // NODE.id
    openDetailPane(APP(), NODE, DETAIL);
    expect(card.classList.contains('eg-card--selected')).toBe(true);
    const ring = card.querySelector('.eg-card-ring');
    expect(ring).not.toBeNull();
    expect(card.firstChild).toBe(ring);            // drawn behind the card content
    expect(ring.getAttribute('x')).toBe('7');      // node x 10 − 3
    expect(ring.getAttribute('width')).toBe('106'); // node w 100 + 6
  });

  it('moves the ring to the new card when another node is opened', () => {
    mountPanel();
    const cardA = mountCard('a.t');
    const cardB = mountCard('a.u');
    openDetailPane(APP(), NODE, DETAIL);
    expect(cardA.classList.contains('eg-card--selected')).toBe(true);
    openDetailPane(APP(), { id: 'a.u', db: 'a', name: 'u', kind: 'table' }, DETAIL);
    expect(cardA.classList.contains('eg-card--selected')).toBe(false);
    expect(cardA.querySelector('.eg-card-ring')).toBeNull();
    expect(cardB.classList.contains('eg-card--selected')).toBe(true);
    expect(cardB.querySelector('.eg-card-ring')).not.toBeNull();
  });

  it('marks a card with no rect (class only, no ring drawn)', () => {
    mountPanel();
    const card = mountCard('a.t', { rect: false });
    openDetailPane(APP(), NODE, DETAIL);
    expect(card.classList.contains('eg-card--selected')).toBe(true);
    expect(card.querySelector('.eg-card-ring')).toBeNull();
  });

  it('the ✕ button removes just the pane and clears the selection ring', () => {
    mountPanel();
    const card = mountCard('a.t');
    const pane = openDetailPane(APP(), NODE, DETAIL);
    pane.querySelector('.schema-detail-close').dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.querySelector('.schema-detail')).toBeNull();
    expect(card.classList.contains('eg-card--selected')).toBe(false);
    expect(card.querySelector('.eg-card-ring')).toBeNull();
  });

  it('dragging the handle resizes the pane, clamped to both bounds', () => {
    const panel = mountPanel();
    const pane = openDetailPane(APP(), NODE, DETAIL);
    const handle = pane.querySelector('.schema-detail-handle');
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 0, bubbles: true })); // tall → clamp to max
    expect(pane.style.flexBasis).toBe('500px'); // height(600) - TOP_MARGIN(100)
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 590, bubbles: true })); // short → clamp to min
    expect(pane.style.flexBasis).toBe('90px'); // MIN_H
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    // after mouseup the move listener is gone — a stray move does nothing
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 100, bubbles: true }));
    expect(pane.style.flexBasis).toBe('90px');
    void panel;
  });

  it('divides the drag delta by the pane zoom scale (html{zoom} bridge)', () => {
    mountPanel();
    const pane = openDetailPane(APP(), NODE, DETAIL);
    // zoomScale(pane) = rect.width / offsetWidth = 720 / 600 = 1.2
    pane.getBoundingClientRect = () => ({ left: 0, top: 0, right: 720, bottom: 600, width: 720, height: 600 });
    Object.defineProperty(pane, 'offsetWidth', { value: 600, configurable: true });
    const handle = pane.querySelector('.schema-detail-handle');
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 240, bubbles: true }));
    expect(pane.style.flexBasis).toBe('300px'); // (600 - 240) / 1.2
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 0, bubbles: true })); // tall → clamp to max
    expect(pane.style.flexBasis).toBe('400px'); // (height 600 / 1.2) - TOP_MARGIN(100)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  it('re-opening for another node replaces the pane, not stacks it', () => {
    mountPanel();
    openDetailPane(APP(), NODE, DETAIL);
    openDetailPane(APP(), { id: 'a.u', db: 'a', name: 'u' }, { columns: [], partitions: [], ddl: '' });
    expect(document.querySelectorAll('.schema-detail')).toHaveLength(1);
  });

  it('omits the partitions and DDL sections when absent; tolerates a kind-less node', () => {
    mountPanel();
    const pane = openDetailPane(APP(), { id: 'a.v', db: 'a', name: 'v' }, { columns: [], partitions: [], ddl: '' });
    const heads = [...pane.querySelectorAll('h4')].map((e) => e.textContent);
    expect(heads).toEqual(['Columns (0)']); // no Partitions / DDL headings
    expect(pane.querySelector('.schema-detail-ddl')).toBeNull();
    expect(pane.querySelector('.schema-detail-kind').textContent).toBe('table'); // kind fallback
  });

  it('mounts into the passed targetDoc (the schema tab) when given', () => {
    const childDoc = document.implementation.createHTMLDocument('');
    const panel = childDoc.createElement('div');
    panel.className = 'graph-overlay-panel';
    childDoc.body.appendChild(panel);
    const pane = openDetailPane({ document, actions: {} }, NODE, DETAIL, childDoc);
    expect(pane.ownerDocument).toBe(childDoc); // built in the child tab's document
    expect(childDoc.querySelector('.schema-detail')).not.toBeNull();
    expect(document.querySelector('.schema-detail')).toBeNull(); // not in the main document
  });

  it('falls back to the global document and tolerates missing columns/partitions', () => {
    mountPanel();
    const pane = openDetailPane({ actions: {} }, NODE, { ddl: '' }); // no document/detailDocument
    expect(pane).not.toBeNull();
    expect([...pane.querySelectorAll('h4')].map((e) => e.textContent)).toEqual(['Columns (0)']);
  });

  it('returns null when no overlay is open', () => {
    expect(openDetailPane(APP(), NODE, DETAIL)).toBeNull();
  });
});
