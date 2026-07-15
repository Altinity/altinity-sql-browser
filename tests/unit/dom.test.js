import { describe, it, expect, vi } from 'vitest';
import { h, s, withDocument, fixedAnchor, attachBackdropClose } from '../../src/ui/dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

describe('withDocument', () => {
  it('builds elements in the target document for the duration of fn, then restores', () => {
    const other = document.implementation.createHTMLDocument('');
    const el = withDocument(other, () => h('div', null, s('svg'), 'x'));
    expect(el.ownerDocument).toBe(other); // created in the target document
    expect(el.querySelector('svg').namespaceURI).toBe(SVG_NS);
    // restored: a subsequent build uses the global document again
    expect(h('div').ownerDocument).toBe(document);
  });
  it('returns fn’s value and restores the previous document even when fn throws', () => {
    expect(withDocument(document.implementation.createHTMLDocument(''), () => 7)).toBe(7);
    const other = document.implementation.createHTMLDocument('');
    expect(() => withDocument(other, () => { throw new Error('boom'); })).toThrow('boom');
    expect(h('div').ownerDocument).toBe(document); // not stuck on `other`
  });
  it('appends element children built in another document as nodes, not stringified text', () => {
    // Regression: cross-realm nodes fail the opener’s `instanceof Node`; they must
    // still be appended as elements (not coerced to "[object HTMLDivElement]").
    const other = document.implementation.createHTMLDocument('');
    const tree = withDocument(other, () => h('div', null, h('span', null, 'x'), h('i')));
    expect(tree.childElementCount).toBe(2);
    expect(tree.textContent).toBe('x'); // not "[object HTML…]"
    expect(tree.querySelector('span')).not.toBeNull();
  });
  it('nests: an inner withDocument restores the outer target, not the global', () => {
    const outer = document.implementation.createHTMLDocument('');
    const inner = document.implementation.createHTMLDocument('');
    withDocument(outer, () => {
      withDocument(inner, () => expect(h('div').ownerDocument).toBe(inner));
      expect(h('div').ownerDocument).toBe(outer); // restored to outer, not global
    });
  });
});

describe('fixedAnchor', () => {
  it('left-aligns under the anchor using native client coords with the default 6px gap', () => {
    const a = fixedAnchor({ bottom: 40, left: 100 });
    expect(a.top).toBe(46);
    expect(a.left).toBe(100);
    expect(a.right).toBeUndefined();
  });
  it('right-aligns to the anchor when viewportW is given', () => {
    const a = fixedAnchor({ bottom: 40, right: 1180 }, { viewportW: 1200 });
    expect(a.top).toBe(46);
    expect(a.right).toBe(20);
    expect(a.left).toBeUndefined();
  });
  it('honors a custom gap', () => {
    expect(fixedAnchor({ bottom: 40, left: 0 }, { gap: 0 }).top).toBe(40);
    expect(fixedAnchor({ bottom: 40, left: 0 }, { gap: 12 }).top).toBe(52);
  });
  it('floors the side inset at `min` (default 8)', () => {
    expect(fixedAnchor({ bottom: 0, left: 0 })).toMatchObject({ top: 6, left: 8 });
    expect(fixedAnchor({ bottom: 0, right: 1200 }, { viewportW: 1200 })).toMatchObject({ right: 8 });
  });
  it('honors a custom min inset', () => {
    expect(fixedAnchor({ bottom: 0, left: 2 }, { min: 0 }).left).toBe(2);
  });
  it('handles zero and fractional coordinates', () => {
    expect(fixedAnchor({ bottom: 10.5, left: 50.25 }, { gap: 0, min: 0 })).toMatchObject({ top: 10.5, left: 50.25 });
  });
});

describe('s (SVG namespace)', () => {
  it('creates elements in the SVG namespace with attrs, style, events, and children', () => {
    const onclick = vi.fn();
    const el = s('svg', { viewBox: '0 0 10 10', class: 'c', style: { width: '100%' }, onclick, title: null },
      s('path', { d: 'M0 0' }), 'x');
    expect(el.namespaceURI).toBe(SVG_NS);
    expect(el.getAttribute('viewBox')).toBe('0 0 10 10');
    expect(el.getAttribute('class')).toBe('c');
    expect(el.style.width).toBe('100%');
    expect(el.hasAttribute('title')).toBe(false); // null skipped
    expect(el.firstChild.namespaceURI).toBe(SVG_NS); // child path is namespaced
    expect(el.textContent).toContain('x');
    el.dispatchEvent(new Event('click'));
    expect(onclick).toHaveBeenCalled();
  });
});

describe('attachBackdropClose (#110)', () => {
  function setup() {
    const panel = h('div', { class: 'panel' }, h('div', { class: 'inner' }, 'x'));
    const backdrop = h('div', { class: 'backdrop' }, panel);
    document.body.appendChild(backdrop);
    const close = vi.fn();
    const detach = attachBackdropClose(backdrop, close);
    return { backdrop, panel, close, detach };
  }
  const down = (el) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  it('closes when mousedown and click both land on the backdrop itself', () => {
    const { backdrop, close } = setup();
    down(backdrop);
    click(backdrop);
    expect(close).toHaveBeenCalledTimes(1);
    backdrop.remove();
  });
  it('does not close when mousedown lands inside the panel, even if the click targets the backdrop', () => {
    // Simulates a drag that starts inside the panel and ends outside it — the
    // browser's click then targets the backdrop directly (#110's repro).
    const { backdrop, panel, close } = setup();
    down(panel.querySelector('.inner'));
    click(backdrop);
    expect(close).not.toHaveBeenCalled();
    backdrop.remove();
  });
  it('does not close on a click with no preceding mousedown', () => {
    const { backdrop, close } = setup();
    click(backdrop);
    expect(close).not.toHaveBeenCalled();
    backdrop.remove();
  });
  it('does not close a normal click inside the panel (mousedown and click both on a panel descendant)', () => {
    const { panel, close, backdrop } = setup();
    const inner = panel.querySelector('.inner');
    down(inner);
    click(inner); // bubbles to the backdrop; not stopped by the panel
    expect(close).not.toHaveBeenCalled();
    backdrop.remove();
  });
  it('does not reuse a stale mousedown-on-backdrop flag for a later click with no mousedown of its own', () => {
    const { backdrop, close } = setup();
    down(backdrop);
    click(backdrop);
    expect(close).toHaveBeenCalledTimes(1);
    click(backdrop); // no mousedown before this one — must not close again
    expect(close).toHaveBeenCalledTimes(1);
    backdrop.remove();
  });
  it('detach() removes both listeners — a later mousedown+click on the backdrop no longer closes', () => {
    const { backdrop, close, detach } = setup();
    detach();
    down(backdrop);
    click(backdrop);
    expect(close).not.toHaveBeenCalled();
    backdrop.remove();
  });
});

describe('h', () => {
  it('builds an element with no props', () => {
    const el = h('div');
    expect(el.tagName).toBe('DIV');
  });
  it('invokes a function component with props + children', () => {
    const Comp = vi.fn((props, children) => {
      const e = document.createElement('section');
      e.textContent = props.label + children.length;
      return e;
    });
    const el = h(Comp, { label: 'x' }, 'a', 'b');
    expect(Comp).toHaveBeenCalled();
    expect(el.textContent).toBe('x2');
  });
  it('function component with no props defaults to {}', () => {
    const Comp = (props) => { const e = document.createElement('p'); e.textContent = JSON.stringify(props); return e; };
    expect(h(Comp).textContent).toBe('{}');
  });
  it('applies a style object', () => {
    const el = h('div', { style: { color: 'red' } });
    expect(el.style.color).toBe('red');
  });
  it('applies class and className', () => {
    expect(h('div', { class: 'a' }).className).toBe('a');
    expect(h('div', { className: 'b' }).className).toBe('b');
  });
  it('applies raw html', () => {
    expect(h('div', { html: '<b>x</b>' }).innerHTML).toBe('<b>x</b>');
  });
  it('wires on* event listeners', () => {
    const onclick = vi.fn();
    const el = h('button', { onclick });
    el.dispatchEvent(new Event('click'));
    expect(onclick).toHaveBeenCalled();
  });
  it('an on* prop that is not a function becomes an attribute', () => {
    const el = h('div', { online: 'yes' });
    expect(el.getAttribute('online')).toBe('yes');
  });
  it('boolean true attributes render empty string', () => {
    expect(h('input', { disabled: true }).getAttribute('disabled')).toBe('');
  });
  it('string attributes pass through', () => {
    expect(h('a', { href: '/x' }).getAttribute('href')).toBe('/x');
  });
  it('skips null/false prop values', () => {
    const el = h('div', { title: null, hidden: false });
    expect(el.hasAttribute('title')).toBe(false);
    expect(el.hasAttribute('hidden')).toBe(false);
  });
  it('appends node, primitive, and nested-array children; skips null/false', () => {
    const child = document.createElement('span');
    const el = h('div', null, child, 'text', 42, [null, false, 'deep', [document.createElement('i')]]);
    // span, "text", "42", "deep", <i> = 5 nodes (null/false skipped, arrays flattened)
    expect(el.childNodes).toHaveLength(5);
    expect(el.firstChild).toBe(child);
    expect(el.textContent).toContain('text');
    expect(el.textContent).toContain('42');
    expect(el.querySelector('i')).not.toBeNull();
  });
});
