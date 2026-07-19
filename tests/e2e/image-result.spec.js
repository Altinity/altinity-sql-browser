import { test, expect } from '@playwright/test';

// Real-browser coverage for the FORMAT PNG image result (#307): a validated
// PNG payload renders as a visible <img> behind the locked "Image (PNG)"
// result-view tab in the Workbench, and a Dashboard Image panel tile paints
// the same bytes filling the tile body with its aspect ratio preserved
// (never stretched to the tile's box) — both invisible to the happy-dom unit
// suite (real image decode + CSS object-fit layout).
test.describe('FORMAT PNG image result (#307)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/image-result.html');
    await page.waitForFunction(() => window.__ready === true);
  });

  test('Workbench: a completed PNG run shows a locked Image (PNG) tab and a visible <img>', async ({ page }) => {
    const tabs = page.locator('#results-region .result-view-tab');
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toHaveClass(/active/);
    await expect(tabs.first()).toContainText('Image (PNG)');

    const img = page.locator('#results-region .image-result-view img');
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute('src', /^blob:/);
    await expect(img).toHaveAttribute('width', '2');
    await expect(img).toHaveAttribute('height', '2');
    // A real decode — happy-dom can't do this — proves the blob: URL the
    // seam minted is the actual validated PNG bytes, not a placeholder.
    const natural = await img.evaluate((el) => new Promise((resolveNat) => {
      if (el.complete && el.naturalWidth) resolveNat({ w: el.naturalWidth, h: el.naturalHeight });
      else el.addEventListener('load', () => resolveNat({ w: el.naturalWidth, h: el.naturalHeight }), { once: true });
    }));
    expect(natural).toEqual({ w: 2, h: 2 });

    // Row-cap selector is exempt for an image result (no row concept).
    await expect(page.locator('#results-region .row-limit-select')).toHaveCount(0);
  });

  test('Workbench: Download PNG hands back the exact validated bytes, no Copy button', async ({ page }) => {
    await expect(page.locator('#results-region .res-act', { hasText: 'Copy' })).toHaveCount(0);
    await page.locator('#results-region .res-act', { hasText: 'Download PNG' }).click();
    const downloaded = await page.evaluate(() => window.__downloaded);
    expect(downloaded).toMatchObject({ mime: 'image/png', size: 77 });
    expect(downloaded.filename).toContain('.png');
  });

  // `getBoundingClientRect` on an `object-fit` <img> always reports the CSS
  // box (100%/100% of the tile) regardless of fit — that's not proof of
  // no-distortion. Only the actual rendered pixels are: screenshot the tile
  // body and sample real pixel colour at several fractional points. `contain`
  // on a 1:1 source inside a 3:1 (or 1:3) box must letterbox — the tile's own
  // opaque background (`.dash-tile { background: var(--bg-side) }`) visible
  // at the long axis's edges, the PNG's saturated red/green/blue/yellow
  // quadrants only in the centered square — never stretched to fill the box.
  async function samplePixels(page, locator, points) {
    const buf = await locator.screenshot();
    return page.evaluate(async ({ base64, points: pts }) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + base64;
      await new Promise((res) => { img.onload = res; });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return pts.map(([xf, yf]) => {
        const x = Math.min(img.naturalWidth - 1, Math.floor(img.naturalWidth * xf));
        const y = Math.min(img.naturalHeight - 1, Math.floor(img.naturalHeight * yf));
        return [...ctx.getImageData(x, y, 1, 1).data];
      });
    }, { base64: buf.toString('base64'), points });
  }
  function colourDist([r1, g1, b1], [r2, g2, b2]) {
    return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
  }

  test('Dashboard Image tile: a wide (3:1) tile letterboxes a 1:1 source instead of stretching it', async ({ page }) => {
    const img = page.locator('#wide-tile-body img.panel-image');
    await expect(img).toBeVisible();
    await expect(img).toHaveClass(/panel-image-fit-contain/);
    expect(await img.evaluate((el) => getComputedStyle(el).objectFit)).toBe('contain');

    const tile = page.locator('#wide-tile-body');
    // Top-left corner is always outside the centered square in a 3:1 tile —
    // the tile's own background colour, whatever it is.
    const [bg, leftEdge, rightEdge, center] = await samplePixels(page, tile, [
      [0.02, 0.05], [0.03, 0.5], [0.97, 0.5], [0.5, 0.5],
    ]);
    // The 1:1 image, height-limited to a centered square, cannot reach the
    // 600px-wide tile's left/right thirds — a stretched/fill render would
    // paint image colour there instead of background.
    expect(colourDist(leftEdge, bg)).toBeLessThan(20);
    expect(colourDist(rightEdge, bg)).toBeLessThan(20);
    // Center must be the image itself (a saturated quadrant colour, distinct from background).
    expect(colourDist(center, bg)).toBeGreaterThan(60);
  });

  test('Dashboard Image tile: a tall (1:3) tile letterboxes a 1:1 source instead of stretching it', async ({ page }) => {
    const img = page.locator('#tall-tile-body img.panel-image');
    await expect(img).toBeVisible();

    const tile = page.locator('#tall-tile-body');
    const [bg, topEdge, bottomEdge, center] = await samplePixels(page, tile, [
      [0.05, 0.02], [0.5, 0.03], [0.5, 0.97], [0.5, 0.5],
    ]);
    // Same 1:1 source, now width-limited to a centered square — the
    // 600px-tall tile's top/bottom thirds must still show background.
    expect(colourDist(topEdge, bg)).toBeLessThan(20);
    expect(colourDist(bottomEdge, bg)).toBeLessThan(20);
    expect(colourDist(center, bg)).toBeGreaterThan(60);
  });
});
