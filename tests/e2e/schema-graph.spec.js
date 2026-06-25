import { test, expect } from '@playwright/test';

// Real-browser regression for the schema-lineage graph view. The graph object is
// shaped exactly like buildSchemaGraph's output for a small `lin` lineage schema
// (source table → MV → target table, plus a dictionary sourcing the table) so the
// test exercises the real dagre geometry + the kind-coloured SVG renderer + legend
// in a browser, without needing a live cluster (which requires OAuth).

const GRAPH = {
  focus: { kind: 'db', db: 'lin' },
  nodes: [
    { id: 'lin.events', label: 'lin.events', kind: 'table' },
    { id: 'lin.events_mv', label: 'lin.events_mv', kind: 'mv' },
    { id: 'lin.events_daily', label: 'lin.events_daily', kind: 'table' },
    { id: 'lin.dim_dict', label: 'lin.dim_dict', kind: 'dictionary' },
  ],
  edges: [
    { from: 'lin.events', to: 'lin.events_mv', kind: 'feeds', label: 'feeds' },
    { from: 'lin.events_mv', to: 'lin.events_daily', kind: 'writes', label: 'writes' },
    { from: 'lin.events', to: 'lin.dim_dict', kind: 'dict', label: 'dict' },
  ],
};

test.describe('schema lineage graph (lin MV + dictionary)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/pipeline.html');
    await page.waitForFunction(() => window.__ready === true);
    await page.evaluate((g) => window.__renderSchema(g), GRAPH);
  });

  test('draws kind-coloured nodes, relationship edges, edge labels and a legend', async ({ page }) => {
    await expect(page.locator('svg.explain-graph')).toBeVisible();
    await expect(page.locator('rect.eg-node')).toHaveCount(4);
    await expect(page.locator('rect.eg-node--mv')).toHaveCount(1);
    await expect(page.locator('rect.eg-node--dictionary')).toHaveCount(1);
    await expect(page.locator('rect.eg-node--table')).toHaveCount(2);
    await expect(page.locator('path.eg-edge')).toHaveCount(3);
    await expect(page.locator('path.eg-edge--writes')).toHaveCount(1);
    await expect(page.locator('path.eg-edge--dict')).toHaveCount(1);
    const edgeLabels = await page.locator('text.eg-edge-label').allTextContents();
    expect(edgeLabels).toContain('feeds');
    expect(edgeLabels).toContain('writes');
    // qualified node labels (db visible) and the kind legend
    const nodeLabels = await page.locator('text.eg-label').allTextContents();
    expect(nodeLabels).toContain('lin.events_mv');
    await expect(page.locator('.schema-graph-legend')).toBeVisible();
  });

  test('lays out the source→MV→target flow top-to-bottom', async ({ page }) => {
    const y = await page.evaluate(() => {
      // rect+label aren't grouped; the label's y is the node centre (all nodes
      // share a height, so label-y ordering == node ordering).
      const at = (label) => {
        const t = [...document.querySelectorAll('text.eg-label')].find((n) => n.textContent === label);
        return Math.round(+t.getAttribute('y'));
      };
      return { src: at('lin.events'), mv: at('lin.events_mv'), dst: at('lin.events_daily') };
    });
    expect(y.mv).toBeGreaterThan(y.src);
    expect(y.dst).toBeGreaterThan(y.mv);
  });
});
