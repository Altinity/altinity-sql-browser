import { test, expect } from '@playwright/test';

// End-to-end check of the html{zoom} viewport-unit fix (#70).
//
// The fullscreen graph panels size off vw/vh, but engines disagree on whether
// viewport units honor `zoom`. The app measures the actual overshoot at runtime
// (a 100vh probe vs the one-screen #root) and publishes it as --vp-zoom, which
// the panels divide by. This harness reproduces that mechanism and asserts the
// resulting panel fits exactly one screen (minus its 48px padding), rather than
// overflowing (no correction) or shrinking to ~83% (the Safari bug: dividing by
// --zoom when the engine's vh already tracked zoom).
//
// CAVEAT — this is a regression guard for the *mechanism*, not a Safari oracle.
// Playwright's WebKit applies `zoom` to getBoundingClientRect like Chromium
// (divisor ~1.2), whereas real Safari keeps rects in CSS px (divisor 1.0). So
// this passes on all three CI engines but does NOT exercise real Safari's
// viewport-unit behavior — that path is verified manually (see CHANGELOG / #71).
test.describe('fullscreen panel fits one screen under html{zoom}', () => {
  test('--vp-zoom is published and the graph-overlay panel fits the viewport', async ({ page }) => {
    await page.goto('/tests/e2e/zoom.html');
    await page.waitForFunction(() => window.__ready === true);

    const z = await page.evaluate(() => window.__zoom());

    // The runtime measurement produced a usable divisor and published it.
    expect(z.divisor).toBeGreaterThan(0);
    expect(z.vpZoom).toBeCloseTo(z.divisor, 3);

    // The panel fits within one screen (never overflows)…
    expect(z.panelH).toBeLessThanOrEqual(z.screenH + 1);
    expect(z.panelW).toBeLessThanOrEqual(z.screenW + 1);
    // …and isn't shrunk by the zoom factor: the gap is just the ~48px padding
    // (~5–6% of the screen), not the ~17% the pre-fix `/var(--zoom)` would lop off
    // on a 1.0-divisor engine. A relative bound cleanly separates the two and is
    // robust to the CI viewport size.
    expect((z.screenH - z.panelH) / z.screenH).toBeLessThan(0.12);
    expect((z.screenW - z.panelW) / z.screenW).toBeLessThan(0.12);
  });
});
