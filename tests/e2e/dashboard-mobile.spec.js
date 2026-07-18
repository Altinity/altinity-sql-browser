import { test, expect } from '@playwright/test';

async function openAt(page, width, height = 844) {
  await page.setViewportSize({ width, height });
  await page.goto('/tests/e2e/dashboard-mobile.html');
  await page.waitForFunction(() => window.__ready === true);
}

test.describe('Dashboard mobile layout', () => {
  test('keeps the accessible header on one line and truncates its title at phone widths', async ({ page }) => {
    await openAt(page, 390);
    const header = page.locator('.dash-header');
    const title = page.locator('.dash-title');

    await expect(page.getByRole('link', { name: 'Back to SQL Browser' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Toggle theme' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh dashboard' })).toBeVisible();
    await expect(page.locator('.dash-back-label')).toBeHidden();
    await expect(page.locator('.dash-refresh-label')).toBeHidden();
    for (const selector of ['.dash-fav', '.dash-skip', '.dash-src', '.dash-updated']) {
      await expect(page.locator(selector)).toBeHidden();
    }

    const geometry = await header.evaluate((node) => {
      const visible = [...node.children].filter((child) => getComputedStyle(child).display !== 'none');
      const rects = visible.map((child) => child.getBoundingClientRect());
      const title = node.querySelector('.dash-title');
      return {
        header: node.getBoundingClientRect(),
        centers: rects.map((rect) => rect.top + rect.height / 2),
        titleClientWidth: title.clientWidth,
        titleScrollWidth: title.scrollWidth,
        whiteSpace: getComputedStyle(title).whiteSpace,
        textOverflow: getComputedStyle(title).textOverflow,
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(Math.max(...geometry.centers) - Math.min(...geometry.centers)).toBeLessThan(2);
    expect(geometry.header.height).toBeLessThanOrEqual(47);
    expect(geometry.titleClientWidth).toBeLessThan(geometry.titleScrollWidth);
    expect(geometry.whiteSpace).toBe('nowrap');
    expect(geometry.textOverflow).toBe('ellipsis');
    expect(geometry.pageOverflow).toBeLessThanOrEqual(0);

    const refresh = page.getByRole('button', { name: 'Refresh dashboard' });
    await refresh.click();
    await expect(refresh).toBeDisabled();
    await expect(refresh).toBeEnabled();
    expect(await page.evaluate(() => window.__refreshCount)).toBe(1);
  });

  test('keeps title and actions reachable without viewport overflow at 360px', async ({ page }) => {
    await openAt(page, 360, 800);
    const result = await page.locator('.dash-header').evaluate((header) => {
      const title = header.querySelector('.dash-title').getBoundingClientRect();
      const theme = header.querySelector('.dash-icobtn').getBoundingClientRect();
      const refresh = header.querySelector('.dash-refresh').getBoundingClientRect();
      return {
        wraps: Math.abs((title.top + title.height / 2) - (theme.top + theme.height / 2)) > 2
          || Math.abs((theme.top + theme.height / 2) - (refresh.top + refresh.height / 2)) > 2,
        titleBeforeActions: title.right <= theme.left,
        actionsInside: refresh.right <= innerWidth,
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(result).toEqual({ wraps: false, titleBeforeActions: true, actionsInside: true, pageOverflow: 0 });
  });

  test('visually normalizes every saved layout on mobile and restores desktop CSS on resize', async ({ page }) => {
    await openAt(page, 390);
    for (const mode of ['wide', 'report', 'columns-2', 'columns-3']) {
      await page.evaluate((next) => window.__setLayout(next), mode);
      const layout = await page.locator('.dash-grid').evaluate((grid) => {
        const tile = grid.querySelector('.dash-tile');
        const style = getComputedStyle(grid);
        return {
          columns: style.gridTemplateColumns.split(' ').length,
          maxWidth: style.maxWidth,
          width: grid.getBoundingClientRect().width,
          availableWidth: grid.closest('.dash-page').clientWidth,
          tileMinHeight: getComputedStyle(tile).minHeight,
          prefs: window.__prefs,
          stored: [localStorage.getItem('asb:dashLayout'), localStorage.getItem('asb:dashCols')],
        };
      });
      expect(layout.columns).toBe(1);
      expect(layout.maxWidth).toBe('none');
      expect(layout.width).toBe(layout.availableWidth);
      expect(layout.tileMinHeight).toBe('300px');
      expect(layout.prefs).toEqual({ dashLayout: 'report', dashCols: 3 });
      expect(layout.stored).toEqual(['report', '3']);
    }

    await page.evaluate(() => window.__setLayout('report'));
    const applyCount = await page.evaluate(() => window.__layoutApplyCount);
    await page.setViewportSize({ width: 900, height: 844 });
    await expect(page.locator('.dash-layout-wrap').first()).toBeVisible();
    const restored = await page.locator('.dash-grid').evaluate((grid) => ({
      maxWidth: getComputedStyle(grid).maxWidth,
      tileMinHeight: getComputedStyle(grid.querySelector('.dash-tile')).minHeight,
      applyCount: window.__layoutApplyCount,
      stored: [localStorage.getItem('asb:dashLayout'), localStorage.getItem('asb:dashCols')],
    }));
    expect(restored).toEqual({ maxWidth: '1100px', tileMinHeight: '440px', applyCount, stored: ['report', '3'] });
  });

  test('scrolls filters in one row while fixed combobox content escapes clipping', async ({ page }) => {
    await openAt(page, 390);
    const scroll = page.locator('.filter-strip-scroll');
    const filters = page.locator('.dash-filters');
    const before = await scroll.evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      fieldWidths: [...node.querySelectorAll('.var-field')].map((field) => field.getBoundingClientRect().width),
      fieldTops: [...node.querySelectorAll('.var-field')].map((field) => field.getBoundingClientRect().top),
      overflowX: getComputedStyle(node).overflowX,
    }));
    expect(before.scrollWidth).toBeGreaterThan(before.clientWidth);
    expect(Math.max(...before.fieldTops) - Math.min(...before.fieldTops)).toBeLessThan(2);
    expect(Math.min(...before.fieldWidths)).toBeGreaterThan(150);
    expect(before.overflowX).toBe('auto');
    expect(await filters.evaluate((node) => getComputedStyle(node).flexWrap)).toBe('nowrap');

    // The fixed count status is a sibling of the scroll region, not inside it —
    // scrolling the fields must not move it.
    const countBefore = await page.locator('.dash-filter-count-host').evaluate((node) => node.getBoundingClientRect().left);
    await scroll.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
    expect(await scroll.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    const countAfter = await page.locator('.dash-filter-count-host').evaluate((node) => node.getBoundingClientRect().left);
    expect(countAfter).toBe(countBefore);
    await scroll.evaluate((node) => { node.scrollLeft = 0; });

    const first = page.getByRole('combobox', { name: 'region' });
    await first.focus();
    await first.press('ArrowDown');
    const list = page.locator('#var-recent-list-region');
    await expect(list).toBeVisible();
    const popover = await list.evaluate((node) => {
      const input = document.querySelector('[aria-label="region"]');
      const toolbar = document.querySelector('.dash-toolbar.has-filters');
      const listRect = node.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();
      return {
        position: getComputedStyle(node).position,
        anchored: Math.abs(listRect.left - inputRect.left) < 2 && listRect.top >= inputRect.bottom,
        escapesToolbar: listRect.bottom > toolbar.getBoundingClientRect().bottom,
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(popover).toEqual({ position: 'fixed', anchored: true, escapesToolbar: true, pageOverflow: 0 });
    await first.press('Enter');
    await expect(first).toHaveValue('alpha');
  });

  test('removes an empty toolbar only on mobile', async ({ page }) => {
    await openAt(page, 390);
    await expect(page.locator('#no-filter-toolbar')).toBeHidden();
    await page.setViewportSize({ width: 769, height: 844 });
    await expect(page.locator('#no-filter-toolbar')).toBeVisible();
  });

  test('desktop: filters stay on one row and scroll horizontally, the layout switcher and count stay fixed, no Clear-all control exists (#294)', async ({ page }) => {
    await openAt(page, 1100, 800);
    await expect(page.locator('.dash-filter-clear-all')).toHaveCount(0);

    const toolbar = page.locator('.dash-toolbar.has-filters');
    const before = await toolbar.evaluate((node) => node.getBoundingClientRect().height);

    const layout = await page.evaluate(() => {
      const layoutWrap = document.querySelector('.dash-layout-wrap');
      const scroll = document.querySelector('.filter-strip-scroll');
      const filters = document.querySelector('.dash-filters');
      const count = document.querySelector('.dash-filter-count-host');
      const fields = [...filters.querySelectorAll('.var-field')];
      const center = (rect) => rect.top + rect.height / 2;
      return {
        toolbarWrap: getComputedStyle(document.querySelector('.dash-toolbar')).flexWrap,
        layoutWrapVisible: getComputedStyle(layoutWrap).display !== 'none',
        layoutCenter: center(layoutWrap.getBoundingClientRect()),
        filtersWrap: getComputedStyle(filters).flexWrap,
        scrollWidth: scroll.scrollWidth,
        clientWidth: scroll.clientWidth,
        fieldTops: fields.map((field) => field.getBoundingClientRect().top),
        fieldWidths: fields.map((field) => field.getBoundingClientRect().width),
        countCenter: center(count.getBoundingClientRect()),
        countVisible: getComputedStyle(count.querySelector('.dash-filter-count')).display !== 'none',
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        // #294 review finding: the fixture's last field is a relative-time
        // field with a resolved-value preview line beneath the input, making
        // its `.var-field` taller than the plain recent-value fields — this
        // exercises the count staying vertically centered against a row taller
        // than one line, not just pinned to its top edge.
        scrollPaddingTop: parseFloat(getComputedStyle(scroll).paddingTop),
        scrollPaddingBottom: parseFloat(getComputedStyle(scroll).paddingBottom),
      };
    });
    expect(layout.toolbarWrap).toBe('nowrap');
    expect(layout.layoutWrapVisible).toBe(true);
    expect(layout.filtersWrap).toBe('nowrap');
    expect(layout.scrollWidth).toBeGreaterThan(layout.clientWidth);
    expect(Math.max(...layout.fieldTops) - Math.min(...layout.fieldTops)).toBeLessThan(2);
    expect(Math.min(...layout.fieldWidths)).toBeGreaterThan(150);
    expect(Math.abs(layout.countCenter - layout.layoutCenter)).toBeLessThan(3);
    expect(layout.countVisible).toBe(true);
    expect(layout.pageOverflow).toBeLessThanOrEqual(0);
    // The scroll viewport's `overflow-y: hidden` must not clip a focused
    // field's box-shadow ring (`.var-input:focus`'s 3px spread) — the vertical
    // padding is the buffer that keeps it visible.
    expect(layout.scrollPaddingTop).toBeGreaterThanOrEqual(3);
    expect(layout.scrollPaddingBottom).toBeGreaterThanOrEqual(3);

    // Scrolling the fields reaches the final one and doesn't grow the toolbar
    // or move the layout switcher / count off their row.
    await page.locator('.filter-strip-scroll').evaluate((node) => { node.scrollLeft = node.scrollWidth; });
    const after = await toolbar.evaluate((node) => node.getBoundingClientRect().height);
    expect(after).toBe(before);
    const lastField = page.locator('.dash-filters .var-field').last();
    await expect(lastField).toBeInViewport();
  });
});
