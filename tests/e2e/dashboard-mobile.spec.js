import { test, expect } from '@playwright/test';

async function openAt(page, width, height = 844) {
  await page.setViewportSize({ width, height });
  await page.goto('/tests/e2e/dashboard-mobile.html');
  await page.waitForFunction(() => window.__ready === true);
}

test.describe('Dashboard mobile layout', () => {
  // #425: a Dashboard is full-bleed on mobile — the sidebar and its resize handle
  // belong to the Query surface. #471 amends the bottom nav half of that rule: with
  // the Dashboard toolbar's `< Query` button gone and no per-tile action on a
  // tile-less Dashboard, hiding the nav here would leave a phone with no route to
  // the Workbench at all. It stays, showing ONLY Editor — the panel switcher's other
  // two values still say nothing about a Dashboard. Only a real browser can check
  // any of this; happy-dom applies no CSS.
  test('hides the sidebar, and keeps only the Editor route in the bottom nav', async ({ page }) => {
    await openAt(page, 390);
    const hidden = await page.evaluate(() => ({
      sidebar: getComputedStyle(document.querySelector('.sidebar')).display,
      handle: getComputedStyle(document.querySelector('.col-resize')).display,
      nav: getComputedStyle(document.querySelector('.mobile-nav')).display,
      navButtons: [...document.querySelectorAll('.mobile-nav-btn')]
        .filter((button) => getComputedStyle(button).display !== 'none')
        .map((button) => button.dataset.view),
      dashWidth: Math.round(document.querySelector('.dash-page').getBoundingClientRect().width),
      viewport: document.documentElement.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
    }));
    expect(hidden.sidebar).toBe('none');
    expect(hidden.handle).toBe('none');
    expect(hidden.nav).not.toBe('none');
    expect(hidden.navButtons).toEqual(['editor']);
    // Full-bleed is a WIDTH claim, and a bottom bar does not touch it: the Dashboard
    // still gets the whole viewport width, with no page overflow.
    expect(hidden.dashWidth).toBe(hidden.viewport);
    expect(hidden.pageOverflow).toBeLessThanOrEqual(0);
  });

  // #471: the nav is a bar at the bottom of the flex column, so it must SHORTEN the
  // Dashboard rather than float over its last row — content hidden behind it would
  // be unreachable exactly where the tile actions live.
  test('the bottom nav shortens the Dashboard instead of overlapping it', async ({ page }) => {
    await openAt(page, 390);
    const layout = await page.evaluate(() => {
      const nav = document.querySelector('.mobile-nav').getBoundingClientRect();
      const page_ = document.querySelector('.dash-page').getBoundingClientRect();
      return {
        navTop: Math.round(nav.top), navBottom: Math.round(nav.bottom),
        pageBottom: Math.round(page_.bottom), viewportHeight: window.innerHeight,
      };
    });
    expect(layout.pageBottom).toBeLessThanOrEqual(layout.navTop);
    expect(layout.navBottom).toBeLessThanOrEqual(layout.viewportHeight);
  });

  // At desktop widths the sidebar STAYS beside the Dashboard — that is the point
  // of #425's shell split, and the mobile rules must not leak upward.
  test('keeps the sidebar beside the Dashboard at desktop widths', async ({ page }) => {
    await openAt(page, 1280, 900);
    const geometry = await page.evaluate(() => ({
      sidebar: getComputedStyle(document.querySelector('.sidebar')).display,
      sidebarWidth: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
      dashLeft: Math.round(document.querySelector('.dashboard-host').getBoundingClientRect().left),
    }));
    expect(geometry.sidebar).not.toBe('none');
    expect(geometry.sidebarWidth).toBeGreaterThan(200);
    expect(geometry.dashLeft).toBeGreaterThanOrEqual(geometry.sidebarWidth);
  });

  test('keeps the shared application header on one line at phone widths', async ({ page }) => {
    await openAt(page, 390);
    const header = page.locator('.app-header');

    // #426 removed the header's Application-surface group — Dashboard selection
    // moved to the upper-left tree, so the brand zone is non-interactive now.
    await expect(page.locator('.header-brand-zone button')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Dashboard mode' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Toggle theme' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh dashboard' })).toBeVisible();
    await expect(page.locator('.dash-refresh-label')).toHaveCount(0);
    await expect(page.locator('.dash-layout-wrap')).toBeVisible();

    const geometry = await header.evaluate((node) => {
      const visible = [...node.children].filter((child) => getComputedStyle(child).display !== 'none');
      const rects = visible.map((child) => child.getBoundingClientRect());
      return {
        header: node.getBoundingClientRect(),
        centers: rects.map((rect) => rect.top + rect.height / 2),
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(Math.max(...geometry.centers) - Math.min(...geometry.centers)).toBeLessThan(2);
    expect(geometry.header.height).toBe(44);
    expect(geometry.pageOverflow).toBeLessThanOrEqual(0);

    const refresh = page.getByRole('button', { name: 'Refresh dashboard' });
    await refresh.click();
    await expect(refresh).toBeDisabled();
    await expect(refresh).toBeEnabled();
    expect(await page.evaluate(() => window.__refreshCount)).toBe(1);
  });

  test('keeps primary tools reachable through one-row horizontal scrolling at 360px', async ({ page }) => {
    await openAt(page, 360, 800);
    const result = await page.locator('.dash-toolbar-primary').evaluate((toolbar) => {
      const children = [...toolbar.children].filter((child) => getComputedStyle(child).display !== 'none');
      const centers = children.map((child) => {
        const rect = child.getBoundingClientRect();
        return rect.top + rect.height / 2;
      });
      return {
        oneRow: Math.max(...centers) - Math.min(...centers) < 2,
        scrolls: toolbar.scrollWidth > toolbar.clientWidth,
        overflowX: getComputedStyle(toolbar).overflowX,
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(result).toEqual({ oneRow: true, scrolls: true, overflowX: 'auto', pageOverflow: 0 });
  });

  test('keeps every visible Dashboard header control reachable just above the mobile breakpoint', async ({ page }) => {
    await openAt(page, 820, 700);
    const result = await page.locator('.dashboard-app-header').evaluate((header) => {
      const visible = [...header.children].filter((child) => getComputedStyle(child).display !== 'none');
      const rects = visible.map((child) => child.getBoundingClientRect());
      return {
        oneRow: Math.max(...rects.map((rect) => rect.top + rect.height / 2))
          - Math.min(...rects.map((rect) => rect.top + rect.height / 2)) < 2,
        inside: rects.every((rect) => rect.left >= 0 && rect.right <= innerWidth),
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        outside: visible.flatMap((child, index) => (
          rects[index].left < 0 || rects[index].right > innerWidth
            ? [`${child.className}:${rects[index].left}-${rects[index].right}`] : []
        )),
      };
    });
    expect(result).toEqual({ oneRow: true, inside: true, pageOverflow: 0, outside: [] });
  });

  test('visually normalizes every flow preset on mobile and restores desktop CSS on resize', async ({ page }) => {
    await openAt(page, 390);
    // 'wide'/'full-width' removed (#321) — every remaining flow preset still
    // normalizes to one column on mobile.
    for (const mode of ['report', 'columns-2', 'columns-3']) {
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
        };
      });
      expect(layout.columns).toBe(1);
      expect(layout.maxWidth).toBe('none');
      expect(layout.width).toBe(layout.availableWidth);
      expect(layout.tileMinHeight).toBe('300px');
    }

    await page.evaluate(() => window.__setLayout('report'));
    const applyCount = await page.evaluate(() => window.__layoutApplyCount);
    await page.setViewportSize({ width: 900, height: 844 });
    await expect(page.locator('.dash-layout-wrap').first()).toBeVisible();
    const restored = await page.locator('.dash-grid').evaluate((grid) => ({
      maxWidth: getComputedStyle(grid).maxWidth,
      tileMinHeight: getComputedStyle(grid.querySelector('.dash-tile')).minHeight,
      applyCount: window.__layoutApplyCount,
    }));
    expect(restored).toEqual({ maxWidth: '1100px', tileMinHeight: '440px', applyCount });
  });

  test('scrolls variables in one row while fixed combobox content escapes clipping', async ({ page }) => {
    await openAt(page, 390);
    const scroll = page.locator('.dash-variable-host');
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
    expect(await scroll.evaluate((node) => getComputedStyle(node).flexWrap)).toBe('nowrap');

    await scroll.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
    expect(await scroll.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    await scroll.evaluate((node) => { node.scrollLeft = 0; });

    const first = page.getByRole('combobox', { name: 'region' });
    await first.focus();
    await first.press('ArrowDown');
    const list = page.locator('#var-recent-list-region');
    await expect(list).toBeVisible();
    const popover = await list.evaluate((node) => {
      const input = document.querySelector('[aria-label="region"]');
      const toolbar = document.querySelector('.dash-toolbar.has-variables');
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

  test('includes the compound time-range control in the scrolled variable row without clipping at 360px (#335)', async ({ page }) => {
    await openAt(page, 360, 800);
    await expect(page.locator('.trf-trigger')).toBeVisible();
    // The "Time" section label sits in the same variable row, ahead of the fields.
    await expect(page.locator('.dash-time-variable-host .flabel', { hasText: 'Time' })).toBeVisible();

    const result = await page.locator('.dash-time-variable-host').evaluate((host) => {
      const field = host.querySelector('.var-field.is-time-range');
      const trigger = host.querySelector('.trf-trigger');
      return {
        hasField: !!field,
        triggerText: trigger.textContent,
        fieldWidth: field.getBoundingClientRect().width,
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(result.hasField).toBe(true);
    // The wave-resolved absolute range renders in the closed trigger.
    expect(result.triggerText).toContain('→');
    // The row scrolls (never wraps, never clips the page) — the compound
    // control's wide trigger stays on the single field row with the others.
    expect(result.fieldWidth).toBeGreaterThan(150);
    expect(result.pageOverflow).toBeLessThanOrEqual(0);
  });

  test('keeps the time-range control on the field row without viewport overflow in landscape (~780px) (#335)', async ({ page }) => {
    await openAt(page, 780, 420);
    await expect(page.locator('.trf-trigger')).toBeVisible();
    const result = await page.locator('.dash-time-variable-host').evaluate((host) => {
      const trigger = host.querySelector('.trf-trigger').getBoundingClientRect();
      return {
        triggerWithinRow: trigger.top >= host.getBoundingClientRect().top - 1,
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(result.triggerWithinRow).toBe(true);
    expect(result.pageOverflow).toBeLessThanOrEqual(0);
  });

  test('removes an empty toolbar at every viewport width (2026-07-18: the layout switcher no longer lives there, so an empty toolbar is never worth showing)', async ({ page }) => {
    await openAt(page, 390);
    await expect(page.locator('#no-variable-toolbar')).toBeHidden();
    await page.setViewportSize({ width: 1100, height: 844 });
    await expect(page.locator('#no-variable-toolbar')).toBeHidden();
  });

  test('marks a required variable name bold instead of a leading asterisk; an optional name stays muted (2026-07-18)', async ({ page }) => {
    await openAt(page, 1100, 800);
    const names = await page.locator('.dash-variable-host .var-name').evaluateAll((nodes) => nodes.map((node) => ({
      // The old convention prepended a literal "*" via `::after { content }` —
      // never part of `textContent` even before this change — so the real
      // regression check is the CSS-generated content string itself, not the
      // DOM text (which never had an asterisk to begin with).
      afterContent: getComputedStyle(node, '::after').content,
      fontWeight: getComputedStyle(node).fontWeight,
      optional: node.closest('.var-field').classList.contains('is-optional'),
    })));
    const required = names.filter((n) => !n.optional);
    const optional = names.filter((n) => n.optional);
    expect(required.length).toBeGreaterThan(0);
    expect(optional.length).toBeGreaterThan(0);
    for (const n of [...required, ...optional]) expect(n.afterContent).not.toContain('*');
    for (const n of required) expect(Number(n.fontWeight)).toBeGreaterThanOrEqual(700);
    for (const n of optional) expect(Number(n.fontWeight)).toBeLessThan(700);
  });

  test('desktop: variables stay on one row and Clear all remains reachable', async ({ page }) => {
    await openAt(page, 1100, 800);
    await expect(page.locator('.dash-clear-variables')).toBeVisible();
    // These two selectors deliberately keep their pre-#459 names: they assert the
    // ABSENCE of markup the curated-filter layer used to render (a count chip and
    // its host), so they have to name what was removed.
    await expect(page.locator('.dash-filter-count')).toHaveCount(0);
    await expect(page.locator('.dash-filter-count-host')).toHaveCount(0);

    const toolbar = page.locator('.dash-toolbar.has-variables');
    const before = await toolbar.evaluate((node) => node.getBoundingClientRect().height);

    const layout = await page.evaluate(() => {
      const host = document.querySelector('.dash-variable-host');
      const fields = [...host.querySelectorAll('.var-field')];
      return {
        toolbarWrap: getComputedStyle(document.querySelector('.dash-toolbar')).flexWrap,
        variablesWrap: getComputedStyle(host).flexWrap,
        scrollWidth: host.scrollWidth,
        clientWidth: host.clientWidth,
        fieldTops: fields.map((field) => field.getBoundingClientRect().top),
        fieldWidths: fields.map((field) => field.getBoundingClientRect().width),
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        // The scroll viewport's `overflow-y: hidden` must not clip a focused
        // field's box-shadow ring (`.var-input:focus`'s 3px spread) — the
        // vertical padding is the buffer that keeps it visible (#294 review
        // finding, exercised against the fixture's taller relative-time field).
        hostPaddingTop: parseFloat(getComputedStyle(host).paddingTop),
        hostPaddingBottom: parseFloat(getComputedStyle(host).paddingBottom),
      };
    });
    expect(layout.toolbarWrap).toBe('nowrap');
    expect(layout.variablesWrap).toBe('nowrap');
    expect(layout.scrollWidth).toBeGreaterThan(layout.clientWidth);
    expect(Math.max(...layout.fieldTops) - Math.min(...layout.fieldTops)).toBeLessThan(2);
    expect(Math.min(...layout.fieldWidths)).toBeGreaterThan(150);
    expect(layout.pageOverflow).toBeLessThanOrEqual(0);
    expect(layout.hostPaddingTop).toBeGreaterThanOrEqual(3);
    expect(layout.hostPaddingBottom).toBeGreaterThanOrEqual(3);

    // Scrolling the fields reaches the final one and doesn't grow the toolbar.
    await page.locator('.dash-variable-host').evaluate((node) => { node.scrollLeft = node.scrollWidth; });
    const after = await toolbar.evaluate((node) => node.getBoundingClientRect().height);
    expect(after).toBe(before);
    const lastField = page.locator('.dash-variable-host .var-field').last();
    await expect(lastField).toBeInViewport();
  });

  test('the File-style layout picker leads the Dashboard primary tool row', async ({ page }) => {
    await openAt(page, 1100, 800);
    const style = page.locator('.dash-style-btn');
    await expect(style).toBeVisible();
    await expect(style).toHaveClass(/hd-file-btn/);
    await expect(style).toHaveText(/Report/);
    await expect(page.locator('.dashboard-app-header')).not.toContainText('Style');
    // No more four-button segmented control.
    await expect(page.locator('.dash-seg-layout')).toHaveCount(0);
    await expect(page.locator('.dash-contextbar')).toHaveCount(0);
    const controlSizes = await page.evaluate(() => {
      const edit = [...document.querySelectorAll('.dashboard-mode-switch .editor-mode-btn')]
        .find((button) => button.textContent === 'Edit').getBoundingClientRect();
      const refresh = document.querySelector('.dash-refresh').getBoundingClientRect();
      return { edit: [edit.width, edit.height], refresh: [refresh.width, refresh.height] };
    });
    // #437: refresh is now an icon-only square control — same control HEIGHT as
    // Edit (both `.editor-mode-btn`), but narrower since it carries no label text.
    expect(controlSizes.refresh[1]).toBe(controlSizes.edit[1]);
    expect(controlSizes.refresh[0]).toBeLessThan(controlSizes.edit[0]);

    const geometry = await page.evaluate(() => {
      const toolbar = document.querySelector('.dash-toolbar-primary');
      const children = [...toolbar.children];
      const tileCountIndex = children.findIndex((c) => c.classList.contains('dash-tile-count'));
      const layoutWrapIndex = children.findIndex((c) => c.classList.contains('dash-layout-wrap'));
      const layoutWrap = children[layoutWrapIndex];
      const tileCount = children[tileCountIndex];
      return {
        styleFirst: layoutWrapIndex === 0,
        tileCountSecond: tileCountIndex === 1,
        inToolbarNotHeader: !document.querySelector('.dashboard-app-header .dash-layout-wrap'),
        sameRow: Math.abs(
          (layoutWrap.getBoundingClientRect().top + layoutWrap.getBoundingClientRect().height / 2)
          - (tileCount.getBoundingClientRect().top + tileCount.getBoundingClientRect().height / 2),
        ) < 2,
      };
    });
    expect(geometry).toEqual({
      styleFirst: true, tileCountSecond: true,
      inToolbarNotHeader: true, sameRow: true,
    });

    await style.click();
    const menu = page.locator('.dash-style-menu');
    await expect(menu).toHaveClass(/file-menu/);
    await expect(menu.locator('.fm-label')).toHaveText(
      ['Grid Tiles', 'Full view', 'Report', '2 columns', '3 columns'],
    );
    await menu.getByRole('menuitem', { name: '2 columns' }).click();
    await expect(style).toHaveText(/2 columns/);
    expect(await style.evaluate((button) => button.value)).toBe('columns-2');
  });
});
