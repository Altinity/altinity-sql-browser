import { test, expect } from '@playwright/test';

// Grafana-grid layout engine (#291 Wave 3): real-layout coverage for what
// happy-dom cannot see — actual CSS grid packing/wrapping, semantic tile
// pixel heights, the responsive column clamp, corner-drag resize live
// feedback, and hover-revealed edit chrome. The pure math itself
// (effectiveGridColumns/snapGridSpan/snapGridHeight/computeGrafanaGridLayout)
// is already 100%-covered under vitest — this suite verifies the REAL
// browser renders what that math promises, not the math again.

async function openWide(page) {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto('/tests/e2e/dashboard-grid.html');
  await page.waitForFunction(() => window.__ready === true);
}

test.describe('Dashboard grafana-grid layout', () => {
  test('packs mixed spans into the row/colStart the pure model computed, wrapping only where it doesn\'t fit', async ({ page }) => {
    await openWide(page);
    const grid = page.locator('#packing-grid');
    await expect(grid).toHaveCSS('display', 'grid');

    const model = await page.evaluate(() => window.__packingModel);
    expect(model.columns).toBe(12); // 1400px container ⇒ widest breakpoint

    // Content box (inside the grid host's own left/right padding — 20px,
    // `.dash-grid` in styles.css) is where grid columns actually start; the
    // border-box rect alone would be off by that padding.
    const gridBox = await grid.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const cs = getComputedStyle(node);
      const padLeft = parseFloat(cs.paddingLeft);
      const padRight = parseFloat(cs.paddingRight);
      return { left: r.left + padLeft, right: r.right - padRight, width: r.width - padLeft - padRight };
    });
    const boxes = await page.locator('#packing-grid .dash-tile').evaluateAll(
      (nodes) => nodes.map((node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top }; }),
    );
    expect(boxes).toHaveLength(model.tiles.length);

    // Column width implied by the rendered grid (12 columns, 8px gap — GRID_GAP_PX).
    const colWidth = (gridBox.width - 8 * 11) / 12;
    for (let i = 0; i < model.tiles.length; i++) {
      const t = model.tiles[i];
      const box = boxes[i];
      const expectedLeft = gridBox.left + t.colStart * (colWidth + 8);
      expect(box.left).toBeCloseTo(expectedLeft, 0);
      // Same row ⇒ same top (within a px); wrapped row ⇒ strictly lower and
      // does not overlap the previous row's bottom.
      const sameRowAsPrev = i > 0 && model.tiles[i - 1].row === t.row;
      if (sameRowAsPrev) expect(Math.abs(box.top - boxes[i - 1].top)).toBeLessThan(2);
      else if (i > 0) expect(box.top).toBeGreaterThan(boxes[i - 1].top);
    }
    // The model's own expectation for this fixture: 2 rows (5 tiles then 3).
    expect(model.tiles.map((t) => t.row)).toEqual([0, 0, 0, 0, 0, 1, 1, 1]);
    expect(model.tiles.map((t) => t.colStart)).toEqual([0, 3, 6, 9, 10, 0, 4, 6]);
    // No tile ever overflows the grid's own right edge.
    for (const box of boxes) expect(box.right).toBeLessThanOrEqual(gridBox.right + 1);
  });

  test('renders compact/medium/large tiles at their semantic pixel heights', async ({ page }) => {
    await openWide(page);
    const heights = await page.locator('#heights-grid .dash-tile').evaluateAll(
      (nodes) => nodes.map((node) => node.getBoundingClientRect().height),
    );
    expect(heights[0]).toBeCloseTo(118, 0);
    expect(heights[1]).toBeCloseTo(210, 0);
    expect(heights[2]).toBeCloseTo(296, 0);
  });

  test('clamps effective columns at the 12/6/4/2 container-width breakpoints, and a full-span tile never overflows', async ({ page }) => {
    await openWide(page);
    const cases = [
      { width: 1200, columns: 12 },
      { width: 800, columns: 6 },
      { width: 500, columns: 4 },
      { width: 300, columns: 2 },
    ];
    for (const { width, columns } of cases) {
      await page.evaluate((px) => window.__setResponsiveWidth(px), width);
      const result = await page.evaluate(() => {
        const grid = document.getElementById('responsive-grid');
        const wide = document.querySelector('#responsive-grid [data-tile-id="r-wide"]');
        const gridRect = grid.getBoundingClientRect();
        const cs = getComputedStyle(grid);
        const padLeft = parseFloat(cs.paddingLeft);
        const padRight = parseFloat(cs.paddingRight);
        const contentLeft = gridRect.left + padLeft;
        const contentRight = gridRect.right - padRight;
        const wideRect = wide.getBoundingClientRect();
        return {
          templateColumnCount: getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length,
          modelColumns: window.__responsiveModel.columns,
          wideWidth: wideRect.width,
          wideLeft: wideRect.left,
          contentLeft,
          contentWidth: contentRight - contentLeft,
          overflowsRight: wideRect.right > contentRight + 1,
        };
      });
      expect(result.modelColumns).toBe(columns);
      expect(result.templateColumnCount).toBe(columns);
      // A stored span-12 tile clamps to `effectiveGridSpan(12, columns) === columns`
      // ⇒ it spans the full row (the grid's own content-box left edge to right edge)
      // at every tier.
      expect(result.wideLeft).toBeCloseTo(result.contentLeft, 0);
      expect(result.wideWidth).toBeCloseTo(result.contentWidth, 0);
      expect(result.overflowsRight).toBe(false);
    }
  });

  test('never overflows the viewport horizontally at a real 360px width', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/tests/e2e/dashboard-grid.html');
    await page.waitForFunction(() => window.__ready === true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('corner-drag resize live-previews span/height during the drag and dispatches exactly one terminal placement', async ({ page }) => {
    await openWide(page);
    const card = page.locator('#edit-grid .dash-tile[data-tile-id="e1"]');
    const handle = page.locator('#edit-grid .dash-gg-resize');
    await expect(card).toHaveClass(/dash-gg-h-medium/);
    expect(await card.evaluate((node) => node.style.gridColumn)).toBe('span 6');

    // Raw page.mouse.* calls don't auto-scroll (unlike locator.click()) —
    // the harness stacks several scenario sections, so the edit-mode grid
    // can start below the fold.
    await handle.scrollIntoViewIfNeeded();
    const rect = await card.evaluate((node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top }; });
    const handleBox = await handle.boundingBox();

    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await expect(card).toHaveClass(/dash-gg-resizing/);

    // Drag to a point 3.5 columns wide, ~large-tier tall — assert the LIVE
    // (pre-release) preview matches the same pure snap functions the app uses.
    const midTargetX = rect.left + 3.5 * (await page.evaluate(() => window.__editColWidthPx()) + 8);
    const midTargetY = rect.top + 250;
    await page.mouse.move(midTargetX, midTargetY, { steps: 5 });
    const midExpected = await page.evaluate(({ dx, dy }) => ({
      span: window.__snapGridSpan(dx, window.__editColWidthPx(), window.__GRID_GAP_PX, window.__editColumns()),
      height: window.__snapGridHeight(dy),
    }), { dx: midTargetX - rect.left, dy: midTargetY - rect.top });
    expect(await card.evaluate((node) => node.style.gridColumn)).toBe(`span ${midExpected.span}`);
    await expect(card).toHaveClass(new RegExp('dash-gg-h-' + midExpected.height));
    expect(await page.evaluate(() => window.__resizeEvents.length)).toBe(0); // no dispatch mid-drag

    // Move to a final, distinct target and release — exactly one terminal event.
    const finalTargetX = rect.left + 2.2 * (await page.evaluate(() => window.__editColWidthPx()) + 8);
    const finalTargetY = rect.top + 118;
    await page.mouse.move(finalTargetX, finalTargetY, { steps: 5 });
    await page.mouse.up();
    await expect(card).not.toHaveClass(/dash-gg-resizing/);

    const finalExpected = await page.evaluate(({ dx, dy }) => ({
      span: window.__snapGridSpan(dx, window.__editColWidthPx(), window.__GRID_GAP_PX, window.__editColumns()),
      height: window.__snapGridHeight(dy),
    }), { dx: finalTargetX - rect.left, dy: finalTargetY - rect.top });
    expect(await card.evaluate((node) => node.style.gridColumn)).toBe(`span ${finalExpected.span}`);
    await expect(card).toHaveClass(new RegExp('dash-gg-h-' + finalExpected.height));
    const events = await page.evaluate(() => window.__resizeEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ tileId: 'e1', span: finalExpected.span, height: finalExpected.height });
  });

  test('hover reveals the delete button and resize glyph only in edit mode; view mode never builds edit affordances', async ({ page }) => {
    await openWide(page);
    const delBtn = page.locator('#edit-grid .dash-gg-del');
    const resizeHandle = page.locator('#edit-grid .dash-gg-resize');
    const grip = page.locator('#edit-grid .dash-gg-grip');

    // Grip is always visible in edit mode (not hover-gated); delete + the
    // resize glyph start hidden (opacity 0) and reveal on hover (styles.css
    // "Grafana-grid layout engine" section).
    await expect(grip).toBeVisible();
    expect(await delBtn.evaluate((node) => getComputedStyle(node).opacity)).toBe('0');
    expect(await resizeHandle.evaluate((node) => getComputedStyle(node, '::after').opacity)).toBe('0');

    await page.locator('#edit-grid .dash-tile[data-tile-id="e1"]').hover();
    expect(await delBtn.evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
    expect(await resizeHandle.evaluate((node) => getComputedStyle(node, '::after').opacity)).toBe('1');

    // View/read-only mode never constructs the edit affordances at all (not
    // merely CSS-hidden) — `ui/dashboard.ts`'s `ensureTileEl` gates their
    // construction on `!readOnly`.
    await expect(page.locator('#viewonly-grid .dash-gg-grip')).toHaveCount(0);
    await expect(page.locator('#viewonly-grid .dash-gg-del')).toHaveCount(0);
    await expect(page.locator('#viewonly-grid .dash-gg-resize')).toHaveCount(0);
  });
});
