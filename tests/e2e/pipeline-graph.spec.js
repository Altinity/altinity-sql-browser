import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Real-browser regression for the EXPLAIN PIPELINE graph view. The DOT fixture
// is the *actual* `EXPLAIN PIPELINE graph = 1` output captured from the **antalya
// demo cluster** running the **ontime** dataset, for a deliberately complicated
// query — a fact/dim join plus a second aggregated subquery join, with GROUP BYs,
// ORDER BY and LIMIT — so the pipeline has many parallel lanes and stages:
//
//   SELECT a.DisplayAirportName AS airport, o.flights, o.avg_dep_delay, st.state_flights
//   FROM (
//     SELECT OriginCode, count() AS flights, round(avg(DepDelayMinutes), 1) AS avg_dep_delay
//     FROM ontime.fact_ontime WHERE Year = 2023 AND DepDel15 = 1 GROUP BY OriginCode
//   ) o
//   INNER JOIN ontime.dim_airports a ON o.OriginCode = a.AirportCode
//   INNER JOIN (
//     SELECT OriginState, count() AS state_flights
//     FROM ontime.fact_ontime WHERE Year = 2023 GROUP BY OriginState
//   ) st ON a.StateCode = st.OriginState
//   ORDER BY o.flights DESC LIMIT 20
//
// Rendering the captured DOT (rather than hitting a live cluster, which needs
// OAuth and isn't available in CI) keeps the test deterministic while still
// exercising the parser + layout + SVG on a real-world complex graph.

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOT = readFileSync(join(__dirname, 'fixtures', 'ontime-pipeline-graph.dot'), 'utf8');

test.describe('EXPLAIN PIPELINE graph (antalya ontime fact/dim join)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/pipeline.html');
    await page.waitForFunction(() => window.__ready === true);
    await page.evaluate((dot) => window.__renderPipeline(dot), DOT);
  });

  test('draws every processor and edge from the captured pipeline', async ({ page }) => {
    const svg = page.locator('svg.explain-graph');
    await expect(svg).toBeVisible();
    // 37 processors (n1..n37); 42 edges in the DOT, of which 2 are self-loops
    // (Resize feedback) → 40 rendered.
    await expect(page.locator('rect.eg-node')).toHaveCount(37);
    await expect(page.locator('text.eg-label')).toHaveCount(37);
    await expect(page.locator('path.eg-edge')).toHaveCount(40);
    // a single reusable arrowhead, referenced by the edges
    await expect(page.locator('marker#eg-arrow')).toHaveCount(1);
    expect(await page.locator('path.eg-edge').first().getAttribute('marker-end')).toBe('url(#eg-arrow)');
  });

  test('labels the real ClickHouse processors (compact × N lanes)', async ({ page }) => {
    const labels = await page.locator('text.eg-label').allTextContents();
    expect(labels).toContain('JoiningTransform × 8');
    expect(labels).toContain('MergeTreeSelect(pool: ReadPool, algorithm: Thread) × 4');
    expect(labels).toContain('AggregatingTransform × 4');
    expect(labels).toContain('MergingSortedTransform');
    expect(labels).toContain('Limit');
  });

  test('fullscreen overlay pans and zooms the graph and closes on Escape', async ({ page }) => {
    await page.evaluate((dot) => window.__openFullscreen(dot), DOT);
    const overlay = page.locator('.graph-overlay');
    await expect(overlay).toBeVisible();
    const svg = page.locator('.graph-overlay-canvas svg.explain-graph');
    const vb = () => svg.getAttribute('viewBox').then((s) => s.split(' ').map(Number));

    const [, , w0] = await vb();
    // wheel over the canvas → zoom in (smaller viewBox width)
    await page.locator('.graph-overlay-canvas').hover();
    await page.mouse.wheel(0, -300);
    const [, , w1] = await vb();
    expect(w1).toBeLessThan(w0);

    // drag → pan (viewBox x changes)
    const [x1] = await vb();
    const box = await page.locator('.graph-overlay-canvas').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2);
    await page.mouse.up();
    const [x2] = await vb();
    expect(x2).not.toBe(x1);

    // Fit resets; Escape closes
    await page.getByRole('button', { name: 'Fit' }).click();
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
  });

  test('lays out vertically (stages stacked) with horizontal parallel lanes', async ({ page }) => {
    const m = await page.evaluate(() => {
      const rects = [...document.querySelectorAll('rect.eg-node')];
      const rows = {};
      for (const r of rects) {
        const y = +r.getAttribute('y');
        rows[y] = (rows[y] || 0) + 1;
      }
      const svg = document.querySelector('svg.explain-graph');
      return {
        rowCount: Object.keys(rows).length,
        maxPerRow: Math.max(...Object.values(rows)),
        width: +svg.getAttribute('width'),
        height: +svg.getAttribute('height'),
        viewBox: svg.getAttribute('viewBox'),
      };
    });
    expect(m.rowCount).toBeGreaterThanOrEqual(5); // many sequential stages → vertical
    expect(m.maxPerRow).toBeGreaterThanOrEqual(2); // parallel processors → side-by-side
    expect(m.viewBox).toBe(`0 0 ${m.width} ${m.height}`);
  });
});
