import { describe, it, expect, vi, afterEach } from 'vitest';
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
const APP = (over = {}) => ({ document, actions: { insertCreate: vi.fn() }, ...over });
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

  it('"Insert SHOW CREATE" runs insertCreate with the qualified ident', () => {
    mountPanel();
    const app = APP();
    const pane = openDetailPane(app, NODE, DETAIL);
    const btn = [...pane.querySelectorAll('button')].find((b) => /Insert SHOW CREATE/.test(b.textContent));
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.actions.insertCreate).toHaveBeenCalledWith('a.t');
  });

  it('the ✕ button removes just the pane', () => {
    mountPanel();
    const pane = openDetailPane(APP(), NODE, DETAIL);
    pane.querySelector('.schema-detail-close').dispatchEvent(new Event('click', { bubbles: true }));
    expect(document.querySelector('.schema-detail')).toBeNull();
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
    const pane = openDetailPane({ document, actions: { insertCreate: vi.fn() } }, NODE, DETAIL, childDoc);
    expect(pane.ownerDocument).toBe(childDoc); // built in the child tab's document
    expect(childDoc.querySelector('.schema-detail')).not.toBeNull();
    expect(document.querySelector('.schema-detail')).toBeNull(); // not in the main document
  });

  it('falls back to the global document and tolerates missing columns/partitions', () => {
    mountPanel();
    const pane = openDetailPane({ actions: { insertCreate: vi.fn() } }, NODE, { ddl: '' }); // no document/detailDocument
    expect(pane).not.toBeNull();
    expect([...pane.querySelectorAll('h4')].map((e) => e.textContent)).toEqual(['Columns (0)']);
  });

  it('returns null when no overlay is open', () => {
    expect(openDetailPane(APP(), NODE, DETAIL)).toBeNull();
  });
});
