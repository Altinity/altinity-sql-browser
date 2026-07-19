import { test, expect } from '@playwright/test';

// Grafana-grid KPI tile polish (#316): real-browser coverage for what
// happy-dom cannot see — actual geometry (footer collapse, frameless view
// mode, equal-width card wrapping, container-query value typography, delta
// bottom-alignment, and the 12/6/4/2 responsive column clamp applied to a
// KPI tile). The pure math (computeGrafanaGridLayout et al.) and the DOM
// shape/attribute contract are already covered under vitest — this suite
// verifies the real browser renders what that contract promises.

async function openWide(page) {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto('/tests/e2e/dashboard-grid-kpi.html');
  await page.waitForFunction(() => window.__ready === true);
}

test.describe('Dashboard grafana-grid KPI tiles (#316)', () => {
  test('edit mode: KPI tile footer is collapsed (no visible line) while a normal tile keeps its visible footer', async ({ page }) => {
    await openWide(page);
    const kpiFoot = page.locator('#editcmp-grid [data-tile-id="kpi-edit"] .dash-tile-foot');
    const normalFoot = page.locator('#editcmp-grid [data-tile-id="normal-edit"] .dash-tile-foot');

    expect(await kpiFoot.evaluate((node) => node.hidden)).toBe(true);
    const kpiFootBox = await kpiFoot.evaluate((node) => node.getBoundingClientRect());
    expect(kpiFootBox.height).toBe(0);
    expect(await kpiFoot.evaluate((node) => getComputedStyle(node).display)).toBe('none');

    expect(await normalFoot.evaluate((node) => node.hidden)).toBe(false);
    const normalFootBox = await normalFoot.evaluate((node) => node.getBoundingClientRect());
    expect(normalFootBox.height).toBeGreaterThan(0);
    expect(await normalFoot.evaluate((node) => getComputedStyle(node).display)).toBe('flex');

    // The KPI edit tile still has its header + edit affordances (title, grip,
    // remove, resize) — only the footer is suppressed.
    const kpiCard = page.locator('#editcmp-grid [data-tile-id="kpi-edit"]');
    await expect(kpiCard.locator('.dash-tile-head')).toBeVisible();
    await expect(kpiCard.locator('.dash-tile-name')).toHaveText('Active users');
    await expect(kpiCard.locator('.dash-gg-grip')).toHaveCount(1);
    await expect(kpiCard.locator('.dash-gg-del')).toHaveCount(1);
    await expect(kpiCard.locator('.dash-gg-resize')).toHaveCount(1);
  });

  test('view mode: KPI tile is frameless (transparent border/background, hidden header) while a normal tile keeps its frame', async ({ page }) => {
    await openWide(page);
    const kpiCard = page.locator('#viewframeless-grid [data-tile-id="kpi-view"]');
    const normalCard = page.locator('#viewframeless-grid [data-tile-id="normal-view"]');

    const kpiStyle = await kpiCard.evaluate((node) => {
      const cs = getComputedStyle(node);
      return { border: cs.borderTopColor, bg: cs.backgroundColor, radius: cs.borderRadius, shadow: cs.boxShadow };
    });
    expect(kpiStyle.border).toBe('rgba(0, 0, 0, 0)');
    expect(kpiStyle.bg).toBe('rgba(0, 0, 0, 0)');
    expect(kpiStyle.radius).toBe('0px');
    expect(kpiStyle.shadow).toBe('none');
    await expect(kpiCard.locator('.dash-tile-head')).toBeHidden();
    expect(await kpiCard.locator('.dash-tile-body').evaluate((node) => getComputedStyle(node).padding)).toBe('0px');

    // Accessible group name survives the hidden header.
    await expect(kpiCard).toHaveAttribute('role', 'group');
    await expect(kpiCard).toHaveAttribute('aria-label', 'Availability');

    // Grid placement (span) is still on the frameless card.
    const gridColumn = await kpiCard.evaluate((node) => node.style.gridColumn);
    expect(gridColumn).toMatch(/^span \d+$/);

    // No edit affordances in view mode.
    await expect(kpiCard.locator('.dash-gg-grip')).toHaveCount(0);
    await expect(kpiCard.locator('.dash-gg-del')).toHaveCount(0);
    await expect(kpiCard.locator('.dash-gg-resize')).toHaveCount(0);

    // The neighboring NORMAL view-mode tile is a control: still fully framed.
    const normalStyle = await normalCard.evaluate((node) => {
      const cs = getComputedStyle(node);
      return { border: cs.borderTopColor, bg: cs.backgroundColor };
    });
    expect(normalStyle.border).not.toBe('rgba(0, 0, 0, 0)');
    expect(normalStyle.bg).not.toBe('rgba(0, 0, 0, 0)');
    await expect(normalCard.locator('.dash-tile-head')).toBeVisible();
  });

  test('loading/unfilled/zero-data/error KPI state cards remain visible and correctly classified, frameless', async ({ page }) => {
    await openWide(page);
    const loading = page.locator('[data-tile-id="state-loading"] .dash-kpi-state-card');
    const unfilled = page.locator('[data-tile-id="state-unfilled"] .dash-kpi-state-card');
    const zeroData = page.locator('[data-tile-id="state-zero"] .dash-kpi-state-card');
    const failure = page.locator('[data-tile-id="state-error"] .dash-kpi-state-card');

    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('role', 'status');
    await expect(loading).toHaveAttribute('aria-label', 'Loading metric: Loading…');

    await expect(unfilled).toBeVisible();
    await expect(unfilled).toHaveAttribute('role', 'status');

    await expect(zeroData).toBeVisible();
    await expect(zeroData).toHaveAttribute('role', 'status');

    await expect(failure).toBeVisible();
    await expect(failure).toHaveAttribute('role', 'alert');
    await expect(failure).toHaveAttribute('aria-label', 'Failing metric: Query failed: syntax error');

    // The state cards' own tile wrapper stays frameless in view mode too.
    const wrapper = page.locator('[data-tile-id="state-loading"]');
    const wrapperStyle = await wrapper.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(wrapperStyle).toBe('rgba(0, 0, 0, 0)');
  });

  test('equal-width responsive KPI card grid: same-row cards match widths; a partial last row does not stretch', async ({ page }) => {
    await openWide(page);
    const count = await page.evaluate(() => window.__ewCardCount);
    expect(count).toBe(5);
    const boxes = await page.locator('#equalwidth-grid .kpi-card').evaluateAll(
      (nodes) => nodes.map((node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width }; }),
    );
    expect(boxes).toHaveLength(5);
    // Group by row (same top, within 1px).
    const rows = [];
    for (const box of boxes) {
      const row = rows.find((r) => Math.abs(r[0].top - box.top) < 1);
      if (row) row.push(box); else rows.push([box]);
    }
    expect(rows.length).toBeGreaterThan(1); // wraps to at least 2 rows at 500px
    for (const row of rows) {
      const widths = row.map((b) => b.width);
      for (const w of widths) expect(w).toBeCloseTo(widths[0], 0);
    }
    // The tile's own content width (for comparison against a stretched card).
    const tileWidth = await page.locator('#equalwidth-grid .dash-tile-body').evaluate((node) => node.getBoundingClientRect().width);
    const lastRow = rows[rows.length - 1];
    if (lastRow.length < rows[0].length) {
      // Partial last row: its card width equals the FIRST row's column width,
      // not the full tile width.
      expect(lastRow[0].width).toBeCloseTo(rows[0][0].width, 0);
      expect(lastRow[0].width).toBeLessThan(tileWidth - 1);
    }
  });

  test('value + unit stay on one line at representative narrow widths (no orphaned unit)', async ({ page }) => {
    await openWide(page);
    for (const width of [500, 300, 200]) {
      await page.evaluate((px) => window.__setUnitOrphanWidth(px), width);
      const cards = page.locator('#unitorphan-grid .kpi-card');
      const count = await cards.count();
      for (let i = 0; i < count; i++) {
        const card = cards.nth(i);
        const numberBox = await card.locator('.kpi-value-number').evaluate((node) => node.getBoundingClientRect());
        const unitBox = await card.locator('.kpi-value-unit').evaluate((node) => node.getBoundingClientRect());
        // Same visual line: the unit span's top matches the number span's top.
        expect(Math.abs(numberBox.top - unitBox.top)).toBeLessThan(2);
        // And the unit starts right where the number ends (immediately after,
        // not wrapped below) — its left edge is at/after the number's right edge.
        expect(unitBox.left).toBeGreaterThanOrEqual(numberBox.right - 1);
      }
    }
  });

  test('delta rows bottom-align across cards with different description lengths', async ({ page }) => {
    await openWide(page);
    const cards = page.locator('#delta-grid .kpi-card');
    await expect(cards).toHaveCount(2);
    const deltaBoxes = await page.locator('#delta-grid .kpi-delta').evaluateAll(
      (nodes) => nodes.map((node) => node.getBoundingClientRect().bottom),
    );
    expect(deltaBoxes).toHaveLength(2);
    expect(Math.abs(deltaBoxes[0] - deltaBoxes[1])).toBeLessThan(2);

    // The long description is visually clamped (its rendered box is shorter
    // than its scrollable content) but the FULL text remains in the DOM.
    const longDesc = page.locator('#delta-grid .kpi-card', { hasText: 'Long' }).locator('.kpi-description');
    const overflowing = await longDesc.evaluate((node) => node.scrollHeight > node.clientHeight + 1);
    expect(overflowing).toBe(true);
    await expect(longDesc).toHaveText(/wrap onto two lines and clamp there in the rendered card\.$/);
  });

  test('clamps effective columns at 12/6/4/2 and a full-span KPI tile goes one-card-per-row when narrow', async ({ page }) => {
    await openWide(page);
    const cases = [
      { width: 1240, columns: 12, onePerRow: false },
      { width: 840, columns: 6, onePerRow: false },
      { width: 540, columns: 4, onePerRow: false },
      { width: 340, columns: 2, onePerRow: true },
    ];
    for (const { width, columns, onePerRow } of cases) {
      await page.evaluate((px) => window.__setResponsiveKpiWidth(px), width);
      const model = await page.evaluate(() => window.__responsiveKpiModel);
      expect(model.columns).toBe(columns);
      const boxes = await page.locator('#responsive-grid2 .kpi-card').evaluateAll(
        (nodes) => nodes.map((node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top }; }),
      );
      expect(boxes.length).toBe(4);
      const uniqueTops = new Set(boxes.map((b) => Math.round(b.top)));
      if (onePerRow) {
        // 4 cards, each its own row.
        expect(uniqueTops.size).toBe(4);
      } else {
        // More than one card shares a row at wider widths.
        expect(uniqueTops.size).toBeLessThan(4);
      }
      // No horizontal overflow of the tile's own body.
      const overflow = await page.evaluate(() => {
        const body = document.querySelector('#responsive-grid2 .dash-tile-body');
        return body.scrollWidth - body.clientWidth;
      });
      expect(overflow).toBeLessThanOrEqual(1);
    }
  });

  test('never overflows the viewport horizontally at a real 360px width, and the KPI cards wrap deterministically without overflowing the tile', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto('/tests/e2e/dashboard-grid-kpi.html');
    await page.waitForFunction(() => window.__ready === true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    const boxes = await page.locator('#realviewport-grid .kpi-card').evaluateAll(
      (nodes) => nodes.map((node) => { const r = node.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width }; }),
    );
    expect(boxes).toHaveLength(3);
    // At this width the tile is narrow enough that cards wrap onto more than
    // one row (deterministic auto-fill wrapping, not a single stretched row).
    const rows = [];
    for (const box of boxes) {
      const row = rows.find((r) => Math.abs(r[0].top - box.top) < 1);
      if (row) row.push(box); else rows.push([box]);
    }
    expect(rows.length).toBeGreaterThan(1);
    // No card ever overflows its own tile's right edge.
    const tileRight = await page.locator('#realviewport-grid .dash-tile-body').evaluate((node) => node.getBoundingClientRect().right);
    for (const box of boxes) expect(box.left + box.width).toBeLessThanOrEqual(tileRight + 1);
    // A lone partial-last-row card does not stretch across the full tile width.
    const lastRow = rows[rows.length - 1];
    if (lastRow.length === 1 && rows[0].length > 1) {
      expect(lastRow[0].width).toBeCloseTo(rows[0][0].width, 0);
    }
  });

  test('frameless view mode holds in both light and dark themes', async ({ page }) => {
    await openWide(page);
    const kpiCard = page.locator('#viewframeless-grid [data-tile-id="kpi-view"]');
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => window.__setTheme(t), theme);
      const style = await kpiCard.evaluate((node) => {
        const cs = getComputedStyle(node);
        return { border: cs.borderTopColor, bg: cs.backgroundColor };
      });
      expect(style.border).toBe('rgba(0, 0, 0, 0)');
      expect(style.bg).toBe('rgba(0, 0, 0, 0)');
      await expect(kpiCard.locator('.dash-tile-head')).toBeHidden();
    }
  });
});
