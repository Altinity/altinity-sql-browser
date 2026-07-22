import { test, expect } from '@playwright/test';

// #335: the compound Dashboard time-range control, driven in a REAL browser
// against the actual DashboardViewerSession + buildFilterBar + buildTimeRangeField
// + openAnchoredDialog + validateTimeRangeDraft pipeline (see time-range.html).
// happy-dom cannot exercise the popover placement/viewport clamp, the real
// focus trap / focus return, or the `.fill()`-driven input revalidation, so
// these live here.

const open = async (page) => {
  await page.locator('.trf-trigger').click();
  await expect(page.locator('.trf-popover')).toBeVisible();
};
const fromBox = (page) => page.getByRole('textbox', { name: 'From' });
const toBox = (page) => page.getByRole('textbox', { name: 'To' });
const applyBtn = (page) => page.locator('.trf-btn-primary');

test.describe('Dashboard compound time-range control', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/e2e/time-range.html');
    await page.waitForFunction(() => window.__ready === true);
  });

  test('renders one resolved-range trigger, suppresses the pair’s own fields, keeps the non-group field', async ({ page }) => {
    // The from/to pair resolved into exactly one date-like group.
    expect(await page.evaluate(() => window.__groups()))
      .toEqual([{ key: 'f-from\u0000f-to', from: 'from', to: 'to' }]);

    const trigger = page.locator('.trf-trigger');
    await expect(trigger).toBeVisible();
    // The closed trigger shows the wave-resolved absolute range and names it.
    await expect(trigger).toContainText(' → ');
    await expect(trigger).toContainText('2026-07-21 12:00:00');
    await expect(trigger).toContainText('2026-07-22 12:00:00');
    await expect(trigger).toHaveAttribute('aria-label', /from -1d to now, resolved/);
    await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');

    // The "Time" section label sits ahead of the per-param fields.
    await expect(page.locator('.dash-filters .flabel', { hasText: 'Time' })).toBeVisible();

    // The pair's own individual fields are gone (the compound control
    // represents them); the non-group `service` filter keeps its field.
    await expect(page.getByRole('combobox', { name: 'from' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'to' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'service' })).toHaveCount(1);
  });

  test('opens with both bounds seeded, resolved previews, and Recently used as the resting state', async ({ page }) => {
    await open(page);
    const dialog = page.getByRole('dialog', { name: 'Time range' });
    await expect(dialog).toBeVisible();

    await expect(fromBox(page)).toHaveValue('-1d');
    await expect(toBox(page)).toHaveValue('now');

    // Both preview lines resolved against the ONE shared wave `now`.
    const previews = page.locator('.trf-preview');
    await expect(previews.nth(0)).toHaveText('= 2026-07-21 12:00:00');
    await expect(previews.nth(1)).toHaveText('= 2026-07-22 12:00:00');

    // The right column's resting state (the single programmatic open-focus is
    // NOT a user activation): Recently used, empty on first open.
    await expect(page.locator('.trf-right-header')).toHaveText('Recently used');
    await expect(page.locator('.trf-empty')).toHaveText('No recent ranges yet');
    await expect(page.locator('.trf-const')).toHaveCount(0);
  });

  test('shows a field’s constants on focus; staging a constant fills the input without committing', async ({ page }) => {
    await open(page);
    // A genuine focus (not the open-focus) activates a field → its constants.
    await toBox(page).focus();
    await expect(page.locator('.trf-right-header')).toHaveText('To · constants');
    await expect(page.locator('.trf-const').first()).toBeVisible();

    await page.evaluate(() => window.__resetExec());
    await page.locator('.trf-const', { hasText: '-6h' }).click();
    // Staged: the input holds the token, the popover stays open, nothing ran.
    await expect(toBox(page)).toHaveValue('-6h');
    await expect(page.locator('.trf-popover')).toBeVisible();
    expect(await page.evaluate(() => window.__execLog.length)).toBe(0);
  });

  test('disables Apply on unparseable input and on an inverted range', async ({ page }) => {
    await open(page);
    await fromBox(page).fill('garbage');
    await expect(applyBtn(page)).toBeDisabled();
    await expect(page.locator('.trf-preview.is-error').first()).toBeVisible();

    // now (12:00) > -1d (yesterday) → an inverted range: a range error, Apply gated.
    await fromBox(page).fill('now');
    await toBox(page).fill('-1d');
    const rangeErr = page.locator('.trf-range-error');
    await expect(rangeErr).toBeVisible();
    await expect(rangeErr).toContainText('must not be after');
    await expect(applyBtn(page)).toBeDisabled();
  });

  test('a valid Apply closes the popover, commits both bounds in exactly one wave, and updates the trigger', async ({ page }) => {
    await open(page);
    await fromBox(page).fill('-7d');
    await toBox(page).fill('now');
    await expect(applyBtn(page)).toBeEnabled();

    await page.evaluate(() => window.__resetExec());
    await applyBtn(page).click();
    await page.evaluate(() => window.__lastApply);

    // Closed first, then committed — the popover is gone by the time the
    // commit-driven rebuild ran.
    await expect(page.locator('.trf-popover')).toHaveCount(0);

    // Exactly ONE wave: each dependent tile (a + b consume from/to) ran once;
    // the non-dependent service tile (c) did not run.
    const log = await page.evaluate(() => window.__execLog);
    expect(log.filter((s) => s.includes('tile-a')).length).toBe(1);
    expect(log.filter((s) => s.includes('tile-b')).length).toBe(1);
    expect(log.filter((s) => s.includes('tile-c')).length).toBe(0);
    expect(log.length).toBe(2);

    // The trigger re-resolved its label + aria against the committed pair.
    await expect(page.locator('.trf-trigger')).toHaveAttribute('aria-label', /from -7d to now, resolved/);
    expect(await page.evaluate(() => window.__live())).toBe('Time range applied: -7d → now');
  });

  test('records the outgoing range in Recently used across changes; picking a recent applies it immediately', async ({ page }) => {
    // Change #1: -1d/now → -7d/now records the outgoing -1d/now.
    await open(page);
    await fromBox(page).fill('-7d');
    await toBox(page).fill('now');
    await applyBtn(page).click();
    await page.evaluate(() => window.__lastApply);

    // Change #2: -7d/now → -30d/now records the outgoing -7d/now (newest first).
    await open(page);
    await fromBox(page).fill('-30d');
    await toBox(page).fill('now');
    await applyBtn(page).click();
    await page.evaluate(() => window.__lastApply);

    expect(await page.evaluate(() => window.__recents().map((r) => [r.from, r.to])))
      .toEqual([['-7d', 'now'], ['-1d', 'now']]);

    // Reopen — Recently used now lists both, newest first.
    await open(page);
    const recents = page.locator('.trf-recent');
    await expect(recents).toHaveCount(2);
    await expect(recents.nth(0)).toHaveText('-7d → now');
    await expect(recents.nth(1)).toHaveText('-1d → now');

    // Picking a recent is an immediate apply: closes first, one wave, trigger updates.
    await page.evaluate(() => window.__resetExec());
    await recents.nth(0).click();
    await page.evaluate(() => window.__lastApply);
    await expect(page.locator('.trf-popover')).toHaveCount(0);
    const log = await page.evaluate(() => window.__execLog);
    expect(log.filter((s) => s.includes('tile-a')).length).toBe(1);
    expect(log.filter((s) => s.includes('tile-b')).length).toBe(1);
    expect(log.length).toBe(2);
    await expect(page.locator('.trf-trigger')).toHaveAttribute('aria-label', /from -7d to now, resolved/);
  });

  test('Escape closes and returns focus to the trigger; a backdrop click closes', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.trf-popover')).toHaveCount(0);
    // Focus returned to the control's trigger, not stranded on <body>.
    expect(await page.evaluate(() => document.activeElement?.classList.contains('trf-trigger'))).toBe(true);

    // Backdrop click (a genuine mousedown+click whose target is the overlay).
    await open(page);
    await page.locator('.ms-overlay').click({ position: { x: 4, y: 4 } });
    await expect(page.locator('.trf-popover')).toHaveCount(0);
  });

  test('renders the control and popover in both light and dark themes', async ({ page }) => {
    const bg = async () => page.locator('.trf-popover').evaluate((n) => getComputedStyle(n).backgroundColor);

    await page.evaluate(() => window.__setTheme('dark'));
    await open(page);
    await expect(page.getByRole('dialog', { name: 'Time range' })).toBeVisible();
    const darkBg = await bg();
    await page.keyboard.press('Escape');

    await page.evaluate(() => window.__setTheme('light'));
    await open(page);
    await expect(page.getByRole('dialog', { name: 'Time range' })).toBeVisible();
    const lightBg = await bg();

    // The theme tokens actually apply to the popover chrome in both directions.
    expect(darkBg).not.toBe(lightBg);
    await expect(page.locator('.trf-trigger')).toBeVisible();
  });

  for (const theme of ['dark', 'light']) {
    test(`keeps enabled, hover, and disabled Apply states distinct in ${theme} theme`, async ({ page }) => {
      await page.evaluate((nextTheme) => window.__setTheme(nextTheme), theme);
      await open(page);
      const apply = applyBtn(page);
      const styles = () => apply.evaluate((el) => {
        const css = getComputedStyle(el);
        return { background: css.backgroundColor, color: css.color, opacity: css.opacity };
      });
      const enabled = await styles();
      await apply.hover();
      const hovered = await styles();
      expect(hovered.background).not.toBe(enabled.background);

      await fromBox(page).fill('not-a-time');
      await expect(apply).toBeDisabled();
      expect(await styles()).not.toEqual(hovered);
    });
  }

  test('keeps the popover inside the viewport at a 360px width', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.reload();
    await page.waitForFunction(() => window.__ready === true);

    await open(page);
    const geom = await page.locator('.trf-popover').evaluate((n) => {
      const r = n.getBoundingClientRect();
      return { left: r.left, right: r.right, innerWidth, pageOverflow: document.documentElement.scrollWidth - innerWidth };
    });
    expect(geom.left).toBeGreaterThanOrEqual(0);
    expect(geom.right).toBeLessThanOrEqual(geom.innerWidth + 1);
    expect(geom.pageOverflow).toBeLessThanOrEqual(0);
  });

  test('real Chart.js charts synchronize hover and reverse brushing commits one exact atomic range', async ({ page }) => {
    await expect(page.locator('#chart-a')).toHaveClass(/dash-time-chart/);
    await expect(page.locator('#chart-b')).toHaveClass(/dash-time-chart/);
    await expect(page.locator('#chart-c')).toHaveClass(/dash-time-chart/);
    expect(await page.evaluate(() => window.__groups())).toHaveLength(1);

    const geometry = await page.evaluate(() => {
      const chart = window.__charts.a;
      const rect = chart.canvas.getBoundingClientRect();
      const clientX = (pixel) => rect.left + pixel * rect.width / chart.width;
      const clientY = (pixel) => rect.top + pixel * rect.height / chart.height;
      const startPixel = chart.chartArea.right - 35;
      const endPixel = chart.chartArea.left + 55;
      const hoverPoint = chart.data.datasets[0].data[4];
      return {
        hoverX: clientX(chart.scales.x.getPixelForValue(hoverPoint.x)),
        hoverY: clientY(chart.scales.y.getPixelForValue(hoverPoint.y)),
        y: clientY((chart.chartArea.top + chart.chartArea.bottom) / 2),
        startX: clientX(startPixel), endX: clientX(endPixel),
        expected: [chart.scales.x.getValueForPixel(endPixel), chart.scales.x.getValueForPixel(startPixel)],
      };
    });

    const peerBefore = await page.evaluate(() => window.__peerDraws());
    await page.mouse.move(geometry.hoverX, geometry.hoverY);
    await expect.poll(() => page.evaluate(() => window.__peerDraws())).toBeGreaterThan(peerBefore);
    expect(await page.evaluate(() => window.__charts.a.getActiveElements().length)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__charts.b.getActiveElements().length)).toBe(0);
    expect(await page.evaluate(() => window.__charts.c.getActiveElements().length)).toBe(0);
    const peerCursor = await page.locator('#chart-b').evaluate((canvas) => {
      const host = canvas.closest('.chart-box');
      const pseudo = getComputedStyle(host, '::after');
      return {
        visible: host.classList.contains('is-time-crosshair'),
        top: pseudo.top, bottom: pseudo.bottom,
        color: pseudo.backgroundColor,
        height: host.getBoundingClientRect().height,
      };
    });
    expect(peerCursor).toMatchObject({ visible: true, top: '0px', bottom: '0px' });
    expect(peerCursor.height).toBeGreaterThan(0);
    expect(peerCursor.color).toBe('rgb(251, 191, 36)');

    await page.evaluate(() => { window.__selected = null; window.__resetExec(); });
    await page.mouse.move(geometry.startX, geometry.y);
    await page.mouse.down();
    await page.mouse.move(geometry.endX, geometry.y, { steps: 3 });
    await page.mouse.up();
    await page.waitForFunction(() => Array.isArray(window.__selected));
    await page.evaluate(() => window.__lastApply);

    const selected = await page.evaluate(() => window.__selected);
    // Browser engines round synthetic mouse coordinates differently at
    // fractional device pixels; stay within five minutes of the exact scale
    // inversion while proving the values were not snapped to a sample row.
    expect(Math.abs(selected[0] - geometry.expected[0])).toBeLessThan(300_000);
    expect(Math.abs(selected[1] - geometry.expected[1])).toBeLessThan(300_000);
    expect(selected[0]).toBeLessThan(selected[1]);
    expect(await page.evaluate(([from, to]) => {
      const samples = window.__charts.a.data.datasets[0].data.map((point) => point.x);
      return [from, to].every((value) => samples.every((sample) => Math.abs(value - sample) > 60_000));
    }, selected)).toBe(true);
    const log = await page.evaluate(() => window.__execLog);
    expect(log.filter((s) => s.includes('tile-a'))).toHaveLength(1);
    expect(log.filter((s) => s.includes('tile-b'))).toHaveLength(1);
    expect(await page.evaluate(() => window.__live())).toMatch(/^Time range applied:/);

    // Modified drag is reserved for Dashboard tile movement and never starts
    // a chart selection.
    await expect(page.locator('#chart-a')).toHaveCSS('cursor', 'crosshair');
    await page.locator('.chart-row').evaluate((el) => el.classList.add('dash-grid', 'modkey'));
    await expect(page.locator('#chart-a')).toHaveCSS('cursor', 'grab');
    await page.locator('.chart-row').evaluate((el) => el.classList.add('dash-reordering'));
    await expect(page.locator('#chart-a')).toHaveCSS('cursor', 'grabbing');
    await page.locator('.chart-row').evaluate((el) => el.classList.remove('modkey', 'dash-reordering', 'dash-grid'));
    await page.evaluate(() => { window.__selected = null; window.__resetExec(); });
    await page.keyboard.down('Control');
    await page.mouse.move(geometry.endX, geometry.y);
    await page.mouse.down();
    await page.mouse.move(geometry.startX, geometry.y);
    await page.mouse.up();
    await page.keyboard.up('Control');
    expect(await page.evaluate(() => window.__selected)).toBeNull();
    expect(await page.evaluate(() => window.__execLog)).toEqual([]);

    // Destroying a chart during an active brush cancels the gesture and
    // removes the interaction affordance without committing a range.
    await page.mouse.move(geometry.startX, geometry.y);
    await page.mouse.down();
    await page.mouse.move(geometry.endX, geometry.y);
    await page.evaluate(() => window.__charts.a.destroy());
    await page.mouse.up();
    expect(await page.evaluate(() => window.__selected)).toBeNull();
    await expect(page.locator('#chart-a')).not.toHaveClass(/dash-time-chart/);
  });
});
