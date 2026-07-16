import { describe, it, expect } from 'vitest';
import { fitBox, fitWidthBox, zoomBox, panBox, viewBoxStr } from '../../src/core/panzoom.js';

describe('fitBox', () => {
  it('frames the graph with fractional padding on every side', () => {
    expect(fitBox(100, 50, 0.04)).toEqual({ x: -4, y: -2, w: 108, h: 54 });
  });
  it('defaults the padding', () => {
    const b = fitBox(200, 100);
    expect(b.w).toBeGreaterThan(200);
    expect(b.x).toBeLessThan(0);
  });
});

describe('fitWidthBox', () => {
  it('fills the padded width and matches the container aspect (so width has no letterbox)', () => {
    const vb = fitWidthBox(1000, 4000, 800, 400); // tall graph in a wide container
    expect(vb.w).toBeCloseTo(1080); // 1000 + 2*(1000*0.04)
    expect(vb.w / vb.h).toBeCloseTo(800 / 400); // aspect == container → width fills
    expect(vb.x).toBeCloseTo(-40);
    expect(vb.y).toBeCloseTo(-40); // anchored at the top
  });
  it('falls back to the graph height when the container size is unknown', () => {
    expect(fitWidthBox(1000, 500, 0, 0).h).toBeCloseTo(580); // gh + 2*px
  });
});

describe('zoomBox', () => {
  const vb = { x: 0, y: 0, w: 100, h: 100 };
  it('zooms in around a point, keeping it fixed', () => {
    const out = zoomBox(vb, 2, 50, 50, 10, 300);
    expect(out).toEqual({ x: 25, y: 25, w: 50, h: 50 }); // centred point stays centred
  });
  it('keeps an off-centre point fixed', () => {
    const cx = 20, cy = 80;
    const out = zoomBox(vb, 2, cx, cy, 10, 300);
    expect((cx - out.x) / out.w).toBeCloseTo((cx - vb.x) / vb.w); // same relative x
    expect((cy - out.y) / out.h).toBeCloseTo((cy - vb.y) / vb.h);
  });
  it('clamps zoom-in at minW (and scales height by the same ratio)', () => {
    const out = zoomBox({ x: 0, y: 0, w: 20, h: 20 }, 4, 10, 10, 10, 300);
    expect(out.w).toBe(10); // wanted 5, clamped to 10
    expect(out.h).toBe(10);
  });
  it('clamps zoom-out at maxW', () => {
    const out = zoomBox({ x: 0, y: 0, w: 200, h: 200 }, 0.5, 100, 100, 10, 300);
    expect(out.w).toBe(300); // wanted 400, clamped to 300
  });
  it('returns a degenerate (zero-size) box unchanged', () => {
    const vb = { x: 0, y: 0, w: 0, h: 0 };
    expect(zoomBox(vb, 2, 0, 0, 10, 300)).toBe(vb);
  });
});

describe('panBox', () => {
  it('translates by svg-unit deltas (size unchanged)', () => {
    expect(panBox({ x: 0, y: 0, w: 100, h: 100 }, 10, 5)).toEqual({ x: -10, y: -5, w: 100, h: 100 });
  });
});

describe('viewBoxStr', () => {
  it('serializes to the SVG viewBox attribute form', () => {
    expect(viewBoxStr({ x: -4, y: -2, w: 108, h: 54 })).toBe('-4 -2 108 54');
  });
});
