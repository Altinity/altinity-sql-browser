import { test, expect } from '@playwright/test';

// #426 — the Databases/Dashboards role switcher and the Dashboard hierarchy tree,
// in a real browser. happy-dom cannot observe CSS layout at all, so everything
// geometric here (host visibility contributing no layout, row indentation, long
// labels ellipsizing instead of widening the sidebar, the tree list scrolling) is
// only verifiable at this level. The gesture assertions are here for a different
// reason: they run against real timers and real event ordering.

const open = async (page, width = 1280) => {
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/tests/e2e/dashboard-tree.html');
  await page.waitForFunction(() => window.__ready === true);
};

const roleTab = (page, name) => page.locator('.upper-role-tabs .side-tab', { hasText: name });
const treeRow = (page, key) => page.locator(`.dash-tree-row[data-key="${key}"]`);

test.describe('upper sidebar role switcher', () => {
  test('renders both roles with counts and defaults to Databases', async ({ page }) => {
    await open(page);
    await expect(page.locator('.upper-role-tabs .side-tab')).toHaveCount(2);
    await expect(roleTab(page, 'Databases')).toHaveClass(/active/);
    // The schema stub loads two databases; the seed has three Dashboards.
    await expect(roleTab(page, 'Databases')).toContainText('· 2');
    await expect(roleTab(page, 'Dashboards')).toContainText('· 3');
    await expect(page.locator('.upper-role-host[data-role="databases"]')).toBeVisible();
    await expect(page.locator('.upper-role-host[data-role="dashboards"]')).toBeHidden();
  });

  test('a hidden role host contributes NO layout, so the visible one owns the pane', async ({ page }) => {
    await open(page);
    const geometry = await page.evaluate(() => {
      const pane = document.querySelector('.schema-pane');
      const databases = document.querySelector('.upper-role-host[data-role="databases"]');
      const paneBox = pane.getBoundingClientRect();
      const dbBox = databases.getBoundingClientRect();
      return {
        paneHeight: paneBox.height,
        dbHeight: dbBox.height,
        tabsHeight: document.querySelector('.upper-role-tabs').getBoundingClientRect().height,
        hiddenDisplay: getComputedStyle(document.querySelector('.upper-role-host[data-role="dashboards"]')).display,
      };
    });
    expect(geometry.hiddenDisplay).toBe('none');
    // The exposed host fills everything the tab row leaves — no invisible sibling
    // silently eating half the pane.
    expect(geometry.dbHeight).toBeGreaterThan(0);
    expect(Math.abs(geometry.paneHeight - geometry.tabsHeight - geometry.dbHeight)).toBeLessThan(2);
  });

  test('switching roles preserves the schema search text, scroll and expansion', async ({ page }) => {
    await open(page);
    const schemaSearch = page.locator('.upper-role-host[data-role="databases"] input');
    await schemaSearch.fill('events');
    // Expand a database so there is lazily-built row state to lose.
    await page.locator('.upper-role-host[data-role="databases"] .tree-row').first().click();
    const rowsBefore = await page.locator('.upper-role-host[data-role="databases"] .tree-row').count();

    await roleTab(page, 'Dashboards').click();
    await expect(page.locator('.upper-role-host[data-role="dashboards"]')).toBeVisible();
    await roleTab(page, 'Databases').click();

    // Preserved BY CONSTRUCTION: the host is never rebuilt, only un-hidden.
    await expect(schemaSearch).toHaveValue('events');
    expect(await page.locator('.upper-role-host[data-role="databases"] .tree-row').count()).toBe(rowsBefore);
  });

  test('the sidebar width and the upper/lower splitter survive a role switch', async ({ page }) => {
    await open(page);
    const before = await page.evaluate(() => ({
      sidebar: document.querySelector('.sidebar').getBoundingClientRect().width,
      pane: document.querySelector('.schema-pane').getBoundingClientRect().height,
    }));
    await roleTab(page, 'Dashboards').click();
    const after = await page.evaluate(() => ({
      sidebar: document.querySelector('.sidebar').getBoundingClientRect().width,
      pane: document.querySelector('.schema-pane').getBoundingClientRect().height,
    }));
    expect(after.sidebar).toBeCloseTo(before.sidebar, 0);
    expect(after.pane).toBeCloseTo(before.pane, 0);
  });
});

test.describe('Dashboard hierarchy tree', () => {
  test('renders every stored Dashboard, in order, as an ARIA tree', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await expect(page.locator('.dash-tree-list[role="tree"]')).toBeVisible();
    await expect(page.locator('.dash-tree-row')).toHaveCount(3);
    await expect(page.locator('.dash-tree-row .label')).toHaveText([
      'Sales revenue', 'Ops latency',
      'A very long dashboard title that must ellipsize rather than widen the sidebar',
    ]);
  });

  test('a long Dashboard title ellipsizes instead of widening the sidebar', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    const result = await page.evaluate(() => {
      const row = document.querySelector('.dash-tree-row[data-key="workspace:long"]');
      const label = row.querySelector('.label');
      return {
        clipped: label.scrollWidth > label.clientWidth,
        rowWidth: row.getBoundingClientRect().width,
        sidebarWidth: document.querySelector('.sidebar').getBoundingClientRect().width,
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(result.clipped).toBe(true);
    expect(result.rowWidth).toBeLessThanOrEqual(result.sidebarWidth + 1);
    expect(result.pageOverflow).toBeLessThanOrEqual(0);
  });

  test('expands into Variables before Panels, indented by level', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    // The chevron is the instant path — no double-click window to wait out.
    await treeRow(page, 'workspace:sales').locator('.chev').click();
    await expect(page.locator('.dash-tree-row')).toHaveCount(5);
    await expect(page.locator('.dash-tree-row .label')).toHaveText([
      'Sales revenue', 'Variables', 'Panels', 'Ops latency',
      'A very long dashboard title that must ellipsize rather than widen the sidebar',
    ]);
    await treeRow(page, 'workspace:sales:group:panels').click();
    const indents = await page.evaluate(() => ['workspace:sales', 'workspace:sales:group:panels', 'workspace:sales:tile:t-rev']
      .map((key) => getComputedStyle(document.querySelector(`.dash-tree-row[data-key="${key}"]`)).paddingLeft));
    expect(indents).toEqual(['10px', '24px', '38px']);
  });

  test('the current Dashboard and member read differently from keyboard focus', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').locator('.chev').click();
    await treeRow(page, 'workspace:sales:group:panels').click();
    await page.evaluate(() => window.__select('sales', { kind: 'tile', id: 't-rev' }));

    const styles = await page.evaluate(() => {
      const current = document.querySelector('.dash-tree-row[data-key="workspace:sales:tile:t-rev"]');
      const other = document.querySelector('.dash-tree-row[data-key="workspace:sales:tile:t-cost"]');
      current.focus();
      const focused = getComputedStyle(current);
      return {
        currentBg: getComputedStyle(current).backgroundColor,
        otherBg: getComputedStyle(other).backgroundColor,
        currentShadow: focused.boxShadow,
        isCurrent: current.classList.contains('is-current'),
        focusedIsCurrent: document.activeElement === current,
      };
    });
    expect(styles.isCurrent).toBe(true);
    expect(styles.focusedIsCurrent).toBe(true);
    // A tonal surface for "current", plus a ring for focus — two distinct signals
    // on the same row at the same time.
    expect(styles.currentBg).not.toBe(styles.otherBg);
    expect(styles.currentShadow).not.toBe('none');
    expect(styles.currentShadow.split(',').length).toBeGreaterThan(1);
  });

  test('a panel click opens its query only after the double-click window', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').locator('.chev').click();
    await treeRow(page, 'workspace:sales:group:panels').click();

    await treeRow(page, 'workspace:sales:tile:t-rev').click();
    // Real timers: nothing has fired yet.
    expect(await page.evaluate(() => window.__opened)).toEqual([]);
    await expect.poll(() => page.evaluate(() => window.__opened)).toEqual([
      { kind: 'query', queryId: 'q-rev' },
    ]);
  });

  test('a panel double-click cancels the query-open and focuses the tile in View', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').locator('.chev').click();
    await treeRow(page, 'workspace:sales:group:panels').click();

    await treeRow(page, 'workspace:sales:tile:t-rev').dblclick();
    await expect.poll(() => page.evaluate(() => window.__opened)).toEqual([
      { kind: 'dashboard', dashboardId: 'sales', mode: 'view', focus: { kind: 'tile', id: 't-rev' } },
    ]);
    // No Query-surface flash on the way through, and no second entry.
    expect(await page.evaluate(() => window.__opened.length)).toBe(1);
  });

  test('a Dashboard double-click opens View and leaves expansion untouched', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').dblclick();
    await expect.poll(() => page.evaluate(() => window.__opened)).toEqual([
      { kind: 'dashboard', dashboardId: 'sales', mode: 'view' },
    ]);
    // The scheduled expansion was cancelled outright, not toggled and undone.
    await expect(page.locator('.dash-tree-row')).toHaveCount(3);
  });

  test('a variable row opens its variable tab immediately and never a query', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').locator('.chev').click();
    await treeRow(page, 'workspace:sales:group:variables').click();

    // Both variables come from the panel SQL, shown as `name` + its type.
    await expect(page.locator('.dash-tree-row[data-key^="workspace:sales:variable:"] .label'))
      .toHaveText(['zone', 'region']);

    // A variable row acts on the FIRST click — there is no competing
    // double-click gesture on it, because there is no query to open.
    await treeRow(page, 'workspace:sales:variable:region').click();
    await expect.poll(() => page.evaluate(() => window.__variableTabs())).toEqual([
      // `region` is a direct-input variable, so its tab opens blank.
      { name: 'Variable: region', sql: '', kind: 'dashboard-variable', dashboardId: 'sales', variableName: 'region' },
    ]);
    expect(await page.evaluate(() => window.__opened)).toEqual([]);
  });

  test('keyboard traversal reaches every level and Enter acts', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    const first = treeRow(page, 'workspace:sales');
    await first.focus();
    await page.keyboard.press('ArrowRight'); // expand
    await expect(page.locator('.dash-tree-row')).toHaveCount(5);
    await page.keyboard.press('ArrowRight'); // into Variables
    await page.keyboard.press('ArrowRight'); // expand Variables
    await page.keyboard.press('ArrowDown');
    await expect(treeRow(page, 'workspace:sales:variable:zone')).toBeFocused();
    await page.keyboard.press('Enter');
    // `zone` carries Dashboard-local option SQL, so its tab opens ON that SQL.
    await expect.poll(() => page.evaluate(() => window.__variableTabs())).toEqual([
      {
        name: 'Variable: zone', sql: "SELECT 'eu', 'Europe'",
        kind: 'dashboard-variable', dashboardId: 'sales', variableName: 'zone',
      },
    ]);
    expect(await page.evaluate(() => window.__opened)).toEqual([]);
  });

  test('the action menu exposes the double-click operations to the keyboard', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    const row = treeRow(page, 'workspace:sales');
    await row.hover();
    await row.locator('.dash-tree-menu-btn').click();
    await expect(page.locator('.dash-tree-menu')).toBeVisible();
    await expect(page.locator('.dash-tree-menu .fm-label')).toHaveText(['Open in View', 'Open in Edit']);
    await page.locator('.dash-tree-menu .fm-item', { hasText: 'Open in Edit' }).click();
    await expect.poll(() => page.evaluate(() => window.__opened)).toEqual([
      { kind: 'dashboard', dashboardId: 'sales', mode: 'edit' },
    ]);
  });

  test('search narrows the tree and clearing it restores the prior state', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    const search = page.locator('.upper-role-host[data-role="dashboards"] input');
    await search.fill('zone');
    // The variable's own NAME matches, so its ancestors are exposed.
    await expect(page.locator('.dash-tree-row .label')).toHaveText(['Sales revenue', 'Variables', 'zone', 'Panels']);
    // The caret survives, because the input lives outside the repainted row list.
    await expect(search).toBeFocused();
    await search.fill('');
    await expect(page.locator('.dash-tree-row')).toHaveCount(3);
  });

  test('a long tree scrolls inside its own pane rather than overflowing the sidebar', async ({ page }) => {
    await open(page, 1280);
    await roleTab(page, 'Dashboards').click();
    // Open everything to make the list taller than the pane.
    await treeRow(page, 'workspace:sales').locator('.chev').click();
    await treeRow(page, 'workspace:sales:group:variables').click();
    await treeRow(page, 'workspace:sales:group:panels').click();
    const result = await page.evaluate(() => {
      const list = document.querySelector('.dash-tree-list');
      list.style.maxHeight = '80px'; // force the overflow condition deterministically
      return {
        overflowY: getComputedStyle(list).overflowY,
        scrollable: list.scrollHeight > list.clientHeight,
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(result.overflowY).toBe('auto');
    expect(result.scrollable).toBe(true);
    expect(result.pageOverflow).toBeLessThanOrEqual(0);
  });
});

// #428 — dragging a Library query onto a Dashboard destination. Real
// DragEvent/DataTransfer, because happy-dom has no native drag machinery: the
// unit suite hand-builds event objects, so only this level proves the two
// payloads actually ride the same real drag and that the browser delivers the
// drop to the row the pointer is over.
//
// Escape is deliberately not tested here: Playwright's synthesized drag is not a
// real drag session, so pressing Escape produces no `dragend`. The unit suite
// covers `dragend` clearing, which is the same code path a real Escape takes.
test.describe('Library → Dashboard assignment (#428)', () => {
  const libraryRow = (page) => page.locator('.saved-row', { hasText: 'Countries' });

  /** Start a real drag on the Library row and drop it on `key`, returning the
   *  MIME types the source actually published. */
  const dragLibraryOnto = async (page, key) => {
    await libraryRow(page).waitFor();
    return page.evaluate((rowKey) => {
      const source = [...document.querySelectorAll('.saved-row')]
        .find((row) => row.textContent.includes('Countries'));
      const target = document.querySelector(`.dash-tree-row[data-key="${rowKey}"]`);
      const dt = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const types = [...dt.types];
      const box = target.getBoundingClientRect();
      const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return types;
    }, key);
  };

  const committed = (page) => page.evaluate(() => window.__committed());

  test('one drag publishes both the subquery text and the Dashboard identity', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    const types = await dragLibraryOnto(page, 'workspace:ops');
    expect(types).toContain('application/x-asb-subquery');
    expect(types).toContain('application/x-asb-library-query');
  });

  test('dropping on a Dashboard row creates an owned copy and a tile', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await dragLibraryOnto(page, 'workspace:ops');

    await expect.poll(async () => {
      const workspace = await committed(page);
      return workspace.dashboards.find((d) => d.id === 'ops').tiles.length;
    }).toBe(1);

    const workspace = await committed(page);
    const ops = workspace.dashboards.find((d) => d.id === 'ops');
    const clone = workspace.queries.find((q) => q.id === ops.tiles[0].queryId);
    // A dedicated copy, not the Library entry itself.
    expect(clone.id).not.toBe('q-lib');
    expect(clone.sql).toBe("SELECT 'eu' AS v, 'Europe' AS l");
    expect(clone.spec.dashboard.role).toBe('panel');
    // The source stays in the Library, untouched.
    expect(workspace.queries.find((q) => q.id === 'q-lib').sql).toBe("SELECT 'eu' AS v, 'Europe' AS l");
    await expect(libraryRow(page)).toBeVisible();
    // The new panel row is revealed and is the tree's position…
    const newRow = page.locator('.dash-tree-row[data-key^="workspace:ops:tile:"]');
    await expect(newRow).toHaveCount(1);
    await expect(newRow).toHaveAttribute('tabindex', '0');
    // …and the panel's OWNED COPY opens in the editor, while the DASHBOARD does
    // not open (this fixture records navigation instead of performing it).
    expect(await page.evaluate(() => window.__opened))
      .toEqual([{ kind: 'query', queryId: clone.id }]);
  });

  test('dropping on an inferred Variables row copies only the SQL', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').locator('.chev').click();
    await treeRow(page, 'workspace:sales:group:variables').click();
    await dragLibraryOnto(page, 'workspace:sales:variable:region');

    await expect.poll(async () => {
      const workspace = await committed(page);
      return workspace.dashboards.find((d) => d.id === 'sales').variableConfigs.region?.sql;
    }).toBe("SELECT 'eu' AS v, 'Europe' AS l");

    const workspace = await committed(page);
    const sales = workspace.dashboards.find((d) => d.id === 'sales');
    // No clone, no tile — a variable assignment copies text and nothing else.
    expect(sales.tiles).toHaveLength(2);
    expect(workspace.queries).toHaveLength(3);
  });

  test('the Variables group and a panel row are not drop targets', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').locator('.chev').click();
    await treeRow(page, 'workspace:sales:group:panels').click();

    await expect(treeRow(page, 'workspace:sales:group:variables'))
      .not.toHaveAttribute('data-droptarget', /.*/);
    await expect(treeRow(page, 'workspace:sales:tile:t-rev'))
      .not.toHaveAttribute('data-droptarget', /.*/);
    await expect(treeRow(page, 'workspace:sales:group:panels'))
      .toHaveAttribute('data-droptarget', 'panel');
  });

  test('the drag highlight and active-target outline are real, painted CSS', async ({ page }) => {
    // The only level that can see this: happy-dom computes no layout or cascade,
    // so a rule that never matched would pass the unit suite silently. It also
    // pins the three states apart — an eligible row must NOT look like the
    // current Dashboard, which is what reusing `--bg-highlight` would have done.
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await libraryRow(page).waitFor();

    const styles = await page.evaluate(() => {
      const source = [...document.querySelectorAll('.saved-row')]
        .find((row) => row.textContent.includes('Countries'));
      const target = document.querySelector('.dash-tree-row[data-key="workspace:ops"]');
      const other = document.querySelector('.dash-tree-row[data-key="workspace:long"]');
      const read = (el) => {
        const style = getComputedStyle(el);
        return {
          style: style.outlineStyle,
          width: parseFloat(style.outlineWidth),
          colour: style.outlineColor,
          background: style.backgroundColor,
        };
      };
      const idle = read(target);
      const dt = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const box = target.getBoundingClientRect();
      target.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientX: box.left + box.width / 2, clientY: box.top + box.height / 2,
      }));
      const active = read(target);
      const eligible = read(other);
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return { idle, active, eligible, after: read(target), settled: read(other) };
    });

    // Idle: no outline at all.
    expect(styles.idle.style).not.toBe('dashed');
    // Eligible: a faint dashed edge appears, and NO tonal fill (that would make
    // it indistinguishable from the currently-open Dashboard).
    expect(styles.eligible.style).toBe('dashed');
    expect(styles.eligible.width).toBeGreaterThan(0);
    expect(styles.eligible.background).toBe(styles.idle.background);
    // Active: same channel, turned up — thicker, a different colour, plus fill.
    expect(styles.active.style).toBe('dashed');
    expect(styles.active.width).toBeGreaterThan(styles.eligible.width);
    expect(styles.active.colour).not.toBe(styles.eligible.colour);
    expect(styles.active.background).not.toBe(styles.idle.background);
    // dragend puts everything back.
    expect(styles.after.style).not.toBe('dashed');
    expect(styles.settled.style).not.toBe('dashed');
  });

  test('a collapsed Dashboard auto-expands under a hovering drag, without navigating', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await expect(treeRow(page, 'workspace:ops:group:panels')).toHaveCount(0);

    await libraryRow(page).waitFor();
    await page.evaluate(() => {
      const source = [...document.querySelectorAll('.saved-row')]
        .find((row) => row.textContent.includes('Countries'));
      const target = document.querySelector('.dash-tree-row[data-key="workspace:ops"]');
      const dt = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const box = target.getBoundingClientRect();
      target.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientX: box.left + box.width / 2, clientY: box.top + box.height / 2,
      }));
    });

    // Both groups open, so Panels and Variables rows become reachable mid-drag.
    await expect(treeRow(page, 'workspace:ops:group:panels')).toHaveCount(1);
    await expect(treeRow(page, 'workspace:ops:group:variables')).toHaveCount(1);
    expect(await page.evaluate(() => window.__opened)).toEqual([]);
  });
});
