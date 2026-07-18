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
    // `width` is the WRAPPER's inline width; the grid host's own CONTENT box
    // (where `effectiveGridColumns` — and CSS grid tracks — actually measure
    // from) is 40px narrower than that (`.dash-grid`'s 20px left+right
    // padding, styles.css — #291 review F2). Each case's width is chosen so
    // the resulting CONTENT width lands comfortably inside its target tier
    // (1200/800/500/300), not merely at a boundary the padding math could
    // tip either way.
    const cases = [
      { width: 1240, columns: 12 },
      { width: 840, columns: 6 },
      { width: 540, columns: 4 },
      { width: 340, columns: 2 },
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
    // e1 is the row's FIRST tile (colStart 0, span 6/medium).
    const card = page.locator('#edit-grid .dash-tile[data-tile-id="e1"]');
    const handle = page.locator('#edit-grid .dash-tile[data-tile-id="e1"] .dash-gg-resize');
    await expect(card).toHaveClass(/dash-gg-h-medium/);
    expect(await card.evaluate((node) => node.style.gridColumn)).toBe('span 6'); // unpinned before any drag

    // Raw page.mouse.* calls don't auto-scroll (unlike locator.click()) —
    // the harness stacks several scenario sections, so the edit-mode grid
    // can start below the fold.
    await handle.scrollIntoViewIfNeeded();
    const rect = await card.evaluate((node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top }; });
    const handleBox = await handle.boundingBox();

    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await expect(card).toHaveClass(/dash-gg-resizing/);
    // #291 review F3: PINNED to an explicit column start for the drag's
    // duration, not bare `span N` — e1's colStart is 0, so `1 / span 6`.
    expect(await card.evaluate((node) => node.style.gridColumn)).toBe('1 / span 6');

    // Drag to a point 3.5 columns wide, ~large-tier tall — assert the LIVE
    // (pre-release) preview matches the same pure snap functions the app uses.
    const midTargetX = rect.left + 3.5 * (await page.evaluate(() => window.__editColWidthPx()) + 8);
    const midTargetY = rect.top + 250;
    await page.mouse.move(midTargetX, midTargetY, { steps: 5 });
    const midExpected = await page.evaluate(({ dx, dy }) => ({
      span: window.__snapGridSpan(dx, window.__editColWidthPx(), window.__GRID_GAP_PX, window.__editColumns()),
      height: window.__snapGridHeight(dy),
    }), { dx: midTargetX - rect.left, dy: midTargetY - rect.top });
    expect(await card.evaluate((node) => node.style.gridColumn)).toBe(`1 / span ${midExpected.span}`);
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
    // The persisted-command dispatch survives; the DOM's own explicit pin is
    // still in place until the next reconciliation (this harness never
    // re-renders after a resize — unlike the real app, which resets to plain
    // `span N` on its next publish, unit-tested at the app layer).
    expect(await card.evaluate((node) => node.style.gridColumn)).toBe(`1 / span ${finalExpected.span}`);
    await expect(card).toHaveClass(new RegExp('dash-gg-h-' + finalExpected.height));
    const events = await page.evaluate(() => window.__resizeEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ tileId: 'e1', span: finalExpected.span, height: finalExpected.height });
  });

  test('a mid-row tile (colStart > 0) dragged wider stays pinned and clamps to the columns remaining at its own start (#291 review F3)', async ({ page }) => {
    await openWide(page);
    // e2 sits right after e1 in the same row (colStart 6, span 4/medium) —
    // the previously-untested case a naive `span`-only pin would let
    // self-wrap via the browser's own auto-placement once dragged wider.
    const card = page.locator('#edit-grid .dash-tile[data-tile-id="e2"]');
    const handle = page.locator('#edit-grid .dash-tile[data-tile-id="e2"] .dash-gg-resize');
    const colStart = await page.evaluate(() => window.__editColStart('e2'));
    expect(colStart).toBe(6);
    const rectBefore = await card.evaluate((node) => node.getBoundingClientRect().left);

    await handle.scrollIntoViewIfNeeded();
    const rect = await card.evaluate((node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top }; });
    const handleBox = await handle.boundingBox();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    // Pinned immediately — same left edge as before the drag (no jump).
    expect(await card.evaluate((node) => node.getBoundingClientRect().left)).toBeCloseTo(rectBefore, 0);
    expect(await card.evaluate((node) => node.style.gridColumn)).toBe('7 / span 4'); // colStart 6 → "7 /"

    // A huge rightward drag would naively request the full 12-column span —
    // clamped instead to 12-6=6, the columns actually free at this pinned
    // start, so the tile never demands phantom implicit tracks past the edge.
    // (Y stays at the medium-tier offset so only the SPAN clamp is exercised.)
    // Dispatched synthetically on window (where the wiring listens): Firefox
    // does not deliver real mouse moves this far outside the viewport, and the
    // clamp needs a request provably wider than the 6 columns that fit here.
    await page.evaluate(({ x, y }) => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }));
    }, { x: rect.left + 100000, y: rect.top + 210 });
    expect(await card.evaluate((node) => node.style.gridColumn)).toBe('7 / span 6');
    // Still pinned at the SAME left edge — growing the span never moved it.
    expect(await card.evaluate((node) => node.getBoundingClientRect().left)).toBeCloseTo(rectBefore, 0);
    // And it never overflows the grid's own content-box right edge.
    const overflow = await page.evaluate(() => {
      const grid = document.getElementById('edit-grid');
      const e2 = document.querySelector('#edit-grid [data-tile-id="e2"]');
      const cs = getComputedStyle(grid);
      const gridRect = grid.getBoundingClientRect();
      const contentRight = gridRect.right - parseFloat(cs.paddingRight);
      return e2.getBoundingClientRect().right - contentRight;
    });
    expect(overflow).toBeLessThanOrEqual(1);

    await page.mouse.up();
    const events = await page.evaluate(() => window.__resizeEvents);
    expect(events[events.length - 1]).toEqual({ tileId: 'e2', span: 6, height: 'medium' });
  });

  test('hover reveals the delete button and resize glyph only in edit mode; view mode never builds edit affordances', async ({ page }) => {
    await openWide(page);
    const delBtn = page.locator('#edit-grid .dash-tile[data-tile-id="e1"] .dash-gg-del');
    const resizeHandle = page.locator('#edit-grid .dash-tile[data-tile-id="e1"] .dash-gg-resize');
    const grip = page.locator('#edit-grid .dash-tile[data-tile-id="e1"] .dash-gg-grip');

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
