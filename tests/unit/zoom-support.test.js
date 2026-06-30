import { describe, it, expect } from 'vitest';
import { viewportZoom } from '../../src/core/zoom-support.js';

describe('viewportZoom', () => {
  it('returns the overshoot of a 100vh probe over the one-screen reference', () => {
    // Chromium: 100vh is 1.2× one screen → divisor 1.2.
    expect(viewportZoom(960, 800)).toBeCloseTo(1.2, 10);
    // WebKit/Safari: 100vh == one screen → divisor 1.
    expect(viewportZoom(800, 800)).toBe(1);
  });
  it('returns null when either measurement is missing or degenerate', () => {
    // happy-dom / no layout: rects are 0 → leave the CSS default in place.
    expect(viewportZoom(0, 0)).toBeNull();
    expect(viewportZoom(800, 0)).toBeNull();
    expect(viewportZoom(0, 800)).toBeNull();
    expect(viewportZoom(NaN, 800)).toBeNull();
    expect(viewportZoom(800, NaN)).toBeNull();
    expect(viewportZoom(Infinity, 800)).toBeNull();
    expect(viewportZoom(-960, 800)).toBeNull();
    expect(viewportZoom(960, -800)).toBeNull();
  });
});
