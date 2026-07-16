import { describe, it, expect } from 'vitest';
import { svg, svgFilled, iconEl, Icon } from '../../src/ui/icons.js';

describe('svg', () => {
  it('builds a stroked single-path icon with defaults', () => {
    const el = svg('M0 0L1 1');
    expect(el.tagName.toLowerCase()).toBe('svg');
    expect(el.getAttribute('fill')).toBe('none');
    expect(el.getAttribute('stroke')).toBe('currentColor');
    expect(el.querySelector('path')!.getAttribute('d')).toBe('M0 0L1 1');
  });
  it('omits fill when fill is falsy', () => {
    const el = svg('M0 0', 10, 10, { fill: '' });
    expect(el.hasAttribute('fill')).toBe(false);
  });
  it('honours custom stroke + size', () => {
    const el = svg('M0 0', 20, 24, { stroke: 2 });
    expect(el.getAttribute('width')).toBe('20');
    expect(el.getAttribute('height')).toBe('24');
    expect(el.getAttribute('stroke-width')).toBe('2');
  });
});

describe('svgFilled', () => {
  it('builds a filled icon', () => {
    const el = svgFilled('M0 0z', 16, 16);
    expect(el.getAttribute('fill')).toBe('currentColor');
    expect(el.getAttribute('width')).toBe('16');
    expect(el.getAttribute('viewBox')).toBe('0 0 16 16');
  });
  it('honours an explicit viewBox distinct from the display size', () => {
    const el = svgFilled('M0 0z', 15, 15, 24, 24);
    expect(el.getAttribute('width')).toBe('15');
    expect(el.getAttribute('viewBox')).toBe('0 0 24 24');
  });
});

describe('iconEl', () => {
  it('builds a multi-element icon from an html body', () => {
    const el = iconEl('<circle cx="1" cy="1" r="1"/>', 12, 12, 1.5);
    expect(el.querySelector('circle')).not.toBeNull();
    expect(el.getAttribute('stroke-width')).toBe('1.5');
  });
});

describe('Icon set', () => {
  it('every icon factory returns an svg element', () => {
    const names = Object.keys(Icon) as (keyof typeof Icon)[];
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) {
      const el = Icon[name]();
      expect(el.tagName.toLowerCase(), name).toBe('svg');
    }
  });
  it('star toggles fill', () => {
    expect(Icon.star(true).getAttribute('fill')).toBe('currentColor');
    expect(Icon.star(false).getAttribute('fill')).toBe('none');
    expect(Icon.star().getAttribute('fill')).toBe('none');
  });
});
