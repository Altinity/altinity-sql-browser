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

  // #429/#472 — the three targets, against real event ordering and real timers.
  test('a Dashboard name click opens View at once and leaves expansion untouched', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').locator('.label').click();
    await expect.poll(() => page.evaluate(() => window.__opened)).toEqual([
      { kind: 'dashboard', dashboardId: 'sales', mode: 'view' },
    ]);
    // Still collapsed: opening is not expanding.
    await expect(page.locator('.dash-tree-row')).toHaveCount(3);
  });

  // Real dblclick timing, not two synthesized clicks: the row dispatches the SAME
  // idempotent open twice and never a second, different action. (That the repeat then
  // writes no history entry is `app.openDashboard`'s job — proved against the real
  // controller in `tests/unit/app.test.ts`; this fixture stubs it out.)
  test('a Dashboard double-click repeats one command and expands nothing', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').locator('.label').dblclick();
    await expect.poll(() => page.evaluate(() => window.__opened)).toEqual([
      { kind: 'dashboard', dashboardId: 'sales', mode: 'view' },
      { kind: 'dashboard', dashboardId: 'sales', mode: 'view' },
    ]);
    await expect(page.locator('.dash-tree-row')).toHaveCount(3);
  });

  // #472 wants the three targets "separately announced". A `treeitem` names itself
  // from its CONTENTS, so before the row carried an explicit name, the chevron's label
  // was folded into it ("Expand Sales revenue Sales revenue 2"). Asserted through
  // `getByRole`, which resolves names with Playwright's own accname implementation in
  // every engine — happy-dom cannot compute an accessible name at all.
  test('the row announces itself, its chevron and its trailing actions separately', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    const tree = page.getByRole('tree', { name: 'Dashboards' });
    await expect(tree.getByRole('treeitem', { name: 'Sales revenue 2', exact: true })).toHaveCount(1);
    // No row's own name may contain a control's verb.
    await expect(tree.getByRole('treeitem', { name: /Expand|Collapse|Edit dashboard|Delete dashboard/ })).toHaveCount(0);
    // The controls keep those names for themselves. The pencil is `display:
    // none` (and thus absent from the accessibility tree) until the row is
    // hovered or holds focus, like the trailing `⋯` it sits beside.
    await expect(tree.getByRole('button', { name: 'Expand Sales revenue' })).toHaveCount(1);
    await treeRow(page, 'workspace:sales').hover();
    await expect(tree.getByRole('button', { name: 'Edit dashboard Sales revenue' })).toHaveCount(1);
    await tree.getByRole('button', { name: 'Expand Sales revenue' }).click();
    await expect(tree.getByRole('button', { name: 'Collapse Sales revenue' })).toHaveCount(1);
    await expect(tree.getByRole('treeitem', { name: /Expand|Collapse|Edit dashboard|Delete dashboard/ })).toHaveCount(0);
  });

  test('a Dashboard Shift-click on the name opens Edit', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').locator('.label').click({ modifiers: ['Shift'] });
    await expect.poll(() => page.evaluate(() => window.__opened)).toEqual([
      { kind: 'dashboard', dashboardId: 'sales', mode: 'edit' },
    ]);
    await expect(page.locator('.dash-tree-row')).toHaveCount(3);
  });

  test('the chevron expands without navigating, and the name does not expand', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    const chevron = treeRow(page, 'workspace:sales').locator('.dash-tree-chev');
    await expect(chevron).toHaveAttribute('aria-expanded', 'false');
    await expect(chevron).toHaveAttribute('aria-label', 'Expand Sales revenue');
    await chevron.click();
    await expect(page.locator('.dash-tree-row')).toHaveCount(5);
    await expect(treeRow(page, 'workspace:sales').locator('.dash-tree-chev'))
      .toHaveAttribute('aria-label', 'Collapse Sales revenue');
    // A real browser focuses a button on mousedown; the toggle rebuilt every row, so
    // this also proves focus came back to the NEW button rather than being dropped.
    await expect(treeRow(page, 'workspace:sales').locator('.dash-tree-chev')).toBeFocused();
    expect(await page.evaluate(() => window.__opened)).toEqual([]);
  });

  // Caught in a real browser and nowhere else: the control is 10 wide by 24 tall so
  // the glyph is worth aiming at, and hit-testing uses the TRANSFORMED box — so if
  // the collapsed row's `rotate(-90deg)` were applied to the button instead of to
  // the glyph inside it, its clickable band would become 24 wide and 10 tall,
  // overlapping the row icon and expanding when the user meant to open. happy-dom
  // has no layout and cannot see any of this.
  test('the chevron\'s hit area stays in its own slot, collapsed and expanded', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    const boxes = async () => page.evaluate(() => {
      const row = document.querySelector('.dash-tree-row[data-key="workspace:sales"]');
      const b = (el) => { const r = el.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), left: r.left, right: r.right }; };
      return { chev: b(row.querySelector('.dash-tree-chev')), icon: b(row.querySelector('.icon')), row: b(row) };
    });
    const collapsed = await boxes();
    // Upright box, not a rotated band.
    expect(collapsed.chev.w).toBeLessThanOrEqual(11);
    expect(collapsed.chev.h).toBeGreaterThan(11);
    // ...and it does not reach the icon beside it, so the icon's clicks still open.
    expect(collapsed.chev.right).toBeLessThanOrEqual(collapsed.icon.left);
    expect(collapsed.chev.left).toBeGreaterThanOrEqual(collapsed.row.left);

    await page.locator('.dash-tree-row[data-key="workspace:sales"] .dash-tree-chev').click();
    const expanded = await boxes();
    expect(expanded.chev.w).toBeLessThanOrEqual(11);
    expect(expanded.chev.right).toBeLessThanOrEqual(expanded.icon.left);
    // Clicking the ICON is row content and therefore opens, proving the slot is clean.
    await page.locator('.dash-tree-row[data-key="workspace:sales"] .icon').click();
    await expect.poll(() => page.evaluate(() => window.__opened)).toEqual([
      { kind: 'dashboard', dashboardId: 'sales', mode: 'view' },
    ]);
  });

  test('Enter and Space on the chevron toggle expansion and never navigate', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').locator('.dash-tree-chev').focus();
    // The trap: the tree's key handler is on the LIST, and its Enter opens the
    // Dashboard. Native button activation must not reach it — nor fire twice.
    await page.keyboard.press('Enter');
    await expect(page.locator('.dash-tree-row')).toHaveCount(5);
    await page.keyboard.press('Space');
    await expect(page.locator('.dash-tree-row')).toHaveCount(3);
    expect(await page.evaluate(() => window.__opened)).toEqual([]);
  });

  // #472: "focus styling must visibly distinguish the disclosure control from the
  // navigation target from the trailing action". happy-dom can see none of this, and
  // `:focus-visible` only applies under real keyboard modality — so it has to be a
  // real Tab walk in a real browser. Which doubles as proof that all four targets
  // are keyboard-reachable, in row order, within ONE composite tab stop.
  //
  // #553 moved Add panel off this row onto the Panels group row (see the
  // dedicated test below), so the Dashboard row's own cluster is pencil, trash.
  test('Tab walks the row, its chevron and its trailing actions, each ringed differently', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    const ring = () => page.evaluate(() => {
      const el = document.activeElement;
      const style = getComputedStyle(el);
      return {
        what: el.classList.contains('dash-tree-chev') ? 'chevron'
          : el.classList.contains('dash-tree-act') ? el.getAttribute('aria-label')
            : el.dataset.key ?? el.tagName,
        outline: style.outlineStyle === 'none' ? 'none' : style.outlineWidth + ' ' + style.outlineStyle,
        shadow: style.boxShadow,
      };
    });
    // Establish keyboard modality (and land on the row) with real keys, not
    // `focus()` — Chromium withholds `:focus-visible` after a pointer interaction.
    await treeRow(page, 'workspace:sales').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    const row = await ring();
    await page.keyboard.press('Tab');
    const chevron = await ring();
    await page.keyboard.press('Tab');
    const pencil = await ring();
    await page.keyboard.press('Tab');
    const trash = await ring();

    // The cluster is pencil, trash — destructive last — and Tab reaches both
    // inside the one composite tab stop, in paint order.
    expect([row.what, chevron.what, pencil.what, trash.what]).toEqual([
      'workspace:sales', 'chevron', 'Edit dashboard Sales revenue', 'Delete dashboard Sales revenue',
    ]);
    // The row rings with a box-shadow and no outline; the chevron with an outline and
    // no shadow. Different channels, so neither reads as the other — and neither
    // trailing button matches the chevron's channel.
    expect(row.shadow).not.toBe('none');
    expect(row.outline).toBe('none');
    expect(chevron.outline).toContain('solid');
    expect(chevron.shadow).toBe('none');
    expect(pencil.outline).not.toBe(chevron.outline);
    expect(trash.outline).not.toBe(chevron.outline);
    // Nothing was opened or expanded by walking the row.
    expect(await page.evaluate(() => window.__opened)).toEqual([]);
    await expect(page.locator('.dash-tree-row')).toHaveCount(3);
  });

  // #553: Add panel's new home. The Panels group row's own composite tab stop
  // is chevron then plus — proof the move did not strand it from the keyboard.
  test('Tab walks the Panels group row to its own chevron and Add panel action', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').locator('.dash-tree-chev').click();
    const panels = treeRow(page, 'workspace:sales:group:panels');
    await panels.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await expect(panels).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(panels.locator('.dash-tree-chev')).toBeFocused();
    await page.keyboard.press('Tab');
    const plus = panels.locator('.dash-tree-act[aria-label="Add panel to Sales revenue"]');
    await expect(plus).toBeFocused();
    await expect(plus).toHaveAttribute('aria-haspopup', 'dialog');
    // Reachable by mouse too: click opens the dialog, matching the keyboard path.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Add panel' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Add panel' })).toBeHidden();
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

  // #494 removed the `⋯` from every production row: a Dashboard row's last
  // menu item was *Open in Edit*, and Shift-click / Shift+Enter remain its
  // gestures. What replaced the menu is two real buttons.
  test('no row renders an overflow menu, and the direct controls are real buttons', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await expect(page.locator('.dash-tree-menu-btn')).toHaveCount(0);
    const row = treeRow(page, 'workspace:sales');
    await row.hover();
    await expect(row.getByRole('button', { name: 'Edit dashboard Sales revenue' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Delete dashboard Sales revenue' })).toBeVisible();
    // Shift+Enter still opens Edit mode, unchanged by the menu's removal.
    await row.focus();
    await page.keyboard.press('Shift+Enter');
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

// #429 phase 3 — the Dashboard row's rename pencil, real-browser only for the
// same reason the Tab-order test above is: `:focus-visible` and a real
// accessible name (`getByRole`) need a real browser, and happy-dom cannot
// compute either.
test.describe('Dashboard metadata pencil (#429 phase 3)', () => {
  // `display: none` (and thus unclickable/absent from the a11y tree) until the
  // row is hovered or holds focus, like every other control in #494's trailing
  // cluster — so each interaction here hovers the row first.
  const pencil = async (page, key) => {
    const row = treeRow(page, key);
    await row.hover();
    return row.locator('.dash-tree-act[aria-label^="Edit dashboard"]');
  };
  const dialog = (page) => page.locator('.fm-dialog-card');

  test('opens prefilled, edits, and commits — the tree label updates', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await (await pencil(page, 'workspace:sales')).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).locator('#dash-rename-name')).toHaveValue('Sales revenue');
    await expect(dialog(page).locator('#dash-rename-description')).toHaveValue('');

    await dialog(page).locator('#dash-rename-name').fill('Sales revenue (EMEA)');
    await dialog(page).locator('#dash-rename-description').fill('Quarterly figures');
    await dialog(page).getByRole('button', { name: 'Save' }).click();
    await expect(dialog(page)).toHaveCount(0);

    await expect(treeRow(page, 'workspace:sales').locator('.label')).toHaveText('Sales revenue (EMEA)');
    const committed = await page.evaluate(() => window.__committed());
    const renamed = committed.dashboards.find((d) => d.id === 'sales');
    expect(renamed.title).toBe('Sales revenue (EMEA)');
    expect(renamed.description).toBe('Quarterly figures');
    // The other Dashboard and every query are untouched.
    expect(committed.dashboards.find((d) => d.id === 'ops').title).toBe('Ops latency');
    expect(committed.queries).toHaveLength(3);
  });

  test('Escape and Cancel commit nothing', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await (await pencil(page, 'workspace:sales')).click();
    await dialog(page).locator('#dash-rename-name').fill('Should not be saved');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(treeRow(page, 'workspace:sales').locator('.label')).toHaveText('Sales revenue');

    await (await pencil(page, 'workspace:sales')).click();
    await dialog(page).locator('#dash-rename-name').fill('Should not be saved either');
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(treeRow(page, 'workspace:sales').locator('.label')).toHaveText('Sales revenue');
    const committed = await page.evaluate(() => window.__committed());
    expect(committed.dashboards.find((d) => d.id === 'sales').title).toBe('Sales revenue');
  });

  test('a blank title disables Save, and never navigates or expands the row', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await (await pencil(page, 'workspace:sales')).click();
    await dialog(page).locator('#dash-rename-name').fill('   ');
    await expect(dialog(page).getByRole('button', { name: 'Save' })).toBeDisabled();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.__opened)).toEqual([]);
    await expect(page.locator('.dash-tree-row')).toHaveCount(3);
  });

  test('the trigger is accessibly labelled and returns focus to itself on close', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    const trigger = await pencil(page, 'workspace:sales');
    const tree = page.getByRole('tree', { name: 'Dashboards' });
    await expect(tree.getByRole('button', { name: 'Edit dashboard Sales revenue' })).toHaveCount(1);
    await trigger.click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  });

  // Real-browser-only regression: replacing an already-open dialog
  // force-closes it first, and that closing dialog's OWN `onClose` used to
  // reset this SAME trigger's `aria-expanded` back to "false" right after the
  // new dialog had just set it "true" — happy-dom cannot see the consequence,
  // since it never enforces the `[aria-expanded="true"] { display: inline-flex }`
  // CSS rule that is the only thing keeping a hover-revealed trigger visible
  // (and thus focusable) once the pointer has moved onto the dialog itself.
  test('repeated activation leaves the trigger visibly revealed, not stranded by a stale aria-expanded', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    const trigger = await pencil(page, 'workspace:sales');
    // Three activations of the SAME trigger, dispatched directly rather than
    // through Playwright's pointer-actionability checks: a real second mouse
    // click cannot reach a button the first dialog's backdrop now covers, but
    // a keyboard autorepeat's synthesized click can (the review's own repro),
    // and a direct `.click()` is the fair proxy for that — same synchronous
    // call stack as the unit-level "opens exactly ONE dialog" regression, now
    // asserting on the REAL CSS the unit test cannot see.
    await trigger.evaluate((el) => { el.click(); el.click(); el.click(); });
    await expect(dialog(page)).toHaveCount(1);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // Off the row entirely, so nothing but `aria-expanded="true"` is keeping
    // the trigger's `display` non-`none`.
    await page.mouse.move(0, 0);
    await expect(trigger).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
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

  test('Add to dashboard is fully keyboard-operable and restores focus on Escape', async ({ page }) => {
    await open(page);
    const add = libraryRow(page).getByRole('button', { name: 'Add to dashboard…' });
    await expect(add).toHaveCSS('opacity', '0');
    await libraryRow(page).hover();
    await expect(add).toHaveCSS('opacity', '1');
    await page.mouse.move(0, 0);
    // Reach the action from the row's preceding native keyboard stop. A direct
    // `add.focus()` would still pass if the control accidentally became
    // `tabindex=-1`, which is exactly the regression this acceptance test guards.
    await libraryRow(page).locator('.sv-star').focus();
    await page.keyboard.press('Tab');
    await expect(add).toBeFocused();
    await expect(add).toBeVisible();
    await expect(add).toHaveCSS('opacity', '1');

    await page.keyboard.press('Enter');
    const choose = page.getByRole('menu', { name: 'Choose a dashboard for Countries' });
    await expect(choose).toBeVisible();
    const destinations = choose.getByRole('menuitem');
    await expect(destinations).toHaveCount(3);
    await expect(destinations.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(destinations.nth(1)).toBeFocused();
    await page.keyboard.press('Enter');

    const confirm = page.getByRole('menu', { name: 'Confirm adding Countries to Ops latency' });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('menuitem', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    await expect(add).toBeFocused();

    // Complete the same path without touching the pointer: select Ops again,
    // move from the safe default Cancel to Add, and activate it.
    await page.keyboard.press('Enter');
    const chooseAgain = page.getByRole('menu', { name: 'Choose a dashboard for Countries' });
    await expect(chooseAgain.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const confirmAgain = page.getByRole('menu', { name: 'Confirm adding Countries to Ops latency' });
    await expect(confirmAgain.getByRole('menuitem', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(confirmAgain.getByRole('menuitem', { name: 'Add' })).toBeFocused();
    await page.keyboard.press('Enter');

    await expect.poll(async () => {
      const current = await committed(page);
      return current.dashboards.find((d) => d.id === 'ops').tiles.length;
    }).toBe(1);
    await expect(roleTab(page, 'Dashboards')).toHaveAttribute('aria-pressed', 'true');
    const newPanel = page.locator('.dash-tree-row[data-key^="workspace:ops:tile:"]');
    await expect(newPanel).toHaveCount(1);
    await expect(newPanel).toHaveAttribute('tabindex', '0');
    await expect(newPanel).toBeFocused();
  });

  test('the chooser flips above a Library row at the viewport bottom', async ({ page }) => {
    await open(page);
    const row = libraryRow(page);
    await row.evaluate((element) => {
      Object.assign(element.style, {
        position: 'fixed', right: '4px', bottom: '4px', width: '300px', zIndex: '100',
      });
    });
    const add = row.getByRole('button', { name: 'Add to dashboard…' });
    await row.hover();
    const triggerBox = await add.boundingBox();
    await add.click();

    const choose = page.getByRole('menu', { name: 'Choose a dashboard for Countries' });
    const chooseBox = await choose.boundingBox();
    expect(chooseBox.y + chooseBox.height).toBeLessThanOrEqual(triggerBox.y);
    expect(chooseBox.y).toBeGreaterThanOrEqual(8);

    await choose.getByRole('menuitem').first().click();
    const confirm = page.getByRole('menu', { name: 'Confirm adding Countries to Sales revenue' });
    const confirmBox = await confirm.boundingBox();
    expect(confirmBox.y + confirmBox.height).toBeLessThanOrEqual(triggerBox.y);
    expect(confirmBox.y).toBeGreaterThanOrEqual(8);
    await expect(confirm.getByRole('menuitem', { name: 'Add' })).toBeVisible();
    await expect(confirm.getByRole('menuitem', { name: 'Cancel' })).toBeVisible();
  });

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

/**
 * #494/#495 — the direct action cluster in a REAL browser.
 *
 * Everything here is real-browser-only on purpose: the controls are
 * `display: none` until hover/`:focus-within` (so happy-dom, which enforces no
 * CSS at all, cannot tell an unreachable control from a reachable one), native
 * Enter/Space activation is a browser behaviour rather than a DOM API, and
 * `getByRole` is the only cross-engine way to read an accessible name.
 */
test.describe('direct row actions (#494)', () => {
  const act = async (page, key, name) => {
    const row = treeRow(page, key);
    await row.hover();
    return row.getByRole('button', { name });
  };

  test('Enter on the pencil opens exactly one dialog and does NOT open the Dashboard', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    // Tab to the pencil the way a keyboard user reaches it — row, chevron,
    // pencil (#553 moved Add panel off this row onto the Panels group row) —
    // rather than calling `.click()`, which is what let the #495 review defect
    // through: the tree's own Enter handler runs on the LIST and would
    // otherwise navigate instead.
    await treeRow(page, 'workspace:sales').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(treeRow(page, 'workspace:sales')
      .getByRole('button', { name: 'Edit dashboard Sales revenue' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Edit dashboard' })).toBeVisible();
    await expect(page.locator('.fm-dialog-card')).toHaveCount(1);
    expect(await page.evaluate(() => window.__opened)).toEqual([]);
    await page.keyboard.press('Escape');
  });

  test('Space on the pencil behaves the same, and neither navigates', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await expect(page.getByRole('dialog', { name: 'Edit dashboard' })).toBeVisible();
    expect(await page.evaluate(() => window.__opened)).toEqual([]);
    await page.keyboard.press('Escape');
  });

  test('a pointer-opened pencil moves the composite Tab stop to its own row', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    const row = treeRow(page, 'workspace:ops');
    await row.hover();
    const pencil = row.getByRole('button', { name: 'Edit dashboard Ops latency' });
    await pencil.click();
    await expect(page.getByRole('dialog', { name: 'Edit dashboard' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(pencil).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(row.getByRole('button', { name: 'Delete dashboard Ops latency' })).toBeFocused();
  });

  test('the dialog announces itself as a modal named by its heading', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await (await act(page, 'workspace:sales', 'Edit dashboard Sales revenue')).click();
    const dialog = page.getByRole('dialog', { name: 'Edit dashboard' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await page.keyboard.press('Escape');
  });

  test('a panel row exposes a pencil and a trash that name the panel', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').locator('.chev').click();
    await treeRow(page, 'workspace:sales:group:panels').click();
    const row = treeRow(page, 'workspace:sales:tile:t-rev');
    await row.hover();
    await expect(row.getByRole('button', { name: 'Edit Revenue' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Remove Revenue from dashboard' })).toBeVisible();
    // The row's own announcement stays ITS own — nested control labels are not
    // folded into the treeitem's accessible name.
    await expect(page.getByRole('treeitem', { name: 'Revenue', exact: true })).toHaveCount(1);
  });

  test('the panel pencil edits the owned query and the tree label follows', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').locator('.chev').click();
    await treeRow(page, 'workspace:sales:group:panels').click();
    await (await act(page, 'workspace:sales:tile:t-rev', 'Edit Revenue')).click();
    const dialog = page.getByRole('dialog', { name: 'Edit panel' });
    await expect(dialog).toBeVisible();
    await dialog.locator('#panel-metadata-name').fill('Revenue by region');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(treeRow(page, 'workspace:sales:tile:t-rev').locator('.label'))
      .toHaveText('Revenue by region');
    // Committed, not merely painted.
    await expect.poll(async () => {
      const committed = await page.evaluate(() => window.__committed());
      return committed.queries.find((query) => query.id === 'q-rev').spec.name;
    }).toBe('Revenue by region');
  });

  // Same real-browser-only regression as the Dashboard pencil above: the
  // replacement dialog's own force-close resets THIS trigger's
  // `aria-expanded` too, and only a real `[aria-expanded="true"]` CSS rule can
  // show whether it landed before or after the new dialog's own "true".
  test('repeated activation of the panel pencil leaves the trigger visibly revealed', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').locator('.chev').click();
    await treeRow(page, 'workspace:sales:group:panels').click();
    const trigger = await act(page, 'workspace:sales:tile:t-rev', 'Edit Revenue');
    // See the Dashboard pencil's own comment above: a direct `.click()`,
    // dispatched three times in one call, is the fair proxy for the keyboard
    // autorepeat that is the only real way a user re-activates a trigger a
    // modal backdrop already covers.
    await trigger.evaluate((el) => { el.click(); el.click(); el.click(); });
    await expect(page.locator('.fm-dialog-card')).toHaveCount(1);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.mouse.move(0, 0);
    await expect(trigger).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  });

  // #494's Browser-accessibility section asks for REAL keyboard events, not
  // `.click()` substitutes — and the ring is the half a mouse-driven test
  // cannot show, because Chromium withholds `:focus-visible` after a pointer
  // interaction.
  test('a keyboard-driven panel delete leaves focus on a VISIBLY ringed row', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').locator('.chev').click();
    await treeRow(page, 'workspace:sales:group:panels').click();

    // Walk to the first panel row's trash with real keys: row → pencil → trash.
    await treeRow(page, 'workspace:sales:tile:t-rev').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(treeRow(page, 'workspace:sales:tile:t-rev')
      .getByRole('button', { name: 'Remove Revenue from dashboard' })).toBeFocused();
    await page.keyboard.press('Enter');

    // The confirmation opens on CANCEL, so an Enter pressed out of momentum
    // cannot delete anything; the destructive item is one step away.
    await expect(page.locator('.dash-tree-confirm .fm-item', { hasText: 'Cancel' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.dash-tree-confirm .fm-item', { hasText: 'Remove panel' })).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(treeRow(page, 'workspace:sales:tile:t-rev')).toHaveCount(0);
    const landed = await page.evaluate(() => ({
      key: document.activeElement?.dataset?.key ?? document.activeElement?.tagName,
      ringed: document.activeElement?.matches(':focus-visible') ?? false,
    }));
    expect(landed.key).toMatch(/:tile:t-cost$/);
    expect(landed.ringed).toBe(true);
  });

  // #494: "narrow sidebar layout must preserve the label's usable width and
  // ellipsis rather than overlapping or wrapping the controls". Two revealed
  // buttons per row is two more than #429 phase 3 had, and happy-dom can see
  // none of this — only a real layout can.
  test('a long title still ellipsizes in a narrow pane with the cluster revealed', async ({ page }) => {
    await open(page, 900);
    await roleTab(page, 'Dashboards').click();
    const row = treeRow(page, 'workspace:long');
    await row.hover();
    const box = await page.evaluate(() => {
      const el = document.querySelector('.dash-tree-row[data-key="workspace:long"]');
      const label = el.querySelector('.label');
      const acts = [...el.querySelectorAll('.dash-tree-act')];
      const list = document.querySelector('.dash-tree-list');
      const listBox = list.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      return {
        actCount: acts.length,
        // The label is clipped, not wrapped: one line, and narrower than its
        // own content.
        lines: Math.round(labelBox.height),
        clipped: label.scrollWidth > label.clientWidth,
        // No control sits on top of the label…
        overlap: acts.some((act) => act.getBoundingClientRect().left < labelBox.right - 0.5),
        // …and, the assertion that actually bites: the label SHRINKS to make
        // room, so all controls stay inside the visible pane instead of being
        // pushed off its right edge where nothing can reach them.
        spilled: acts.filter((act) => act.getBoundingClientRect().right > listBox.right + 0.5).length,
        rowOverflow: el.scrollWidth - list.clientWidth,
      };
    });
    // #553: Add panel moved to the Panels group row, so a Dashboard row's own
    // cluster is pencil + trash.
    expect(box.actCount).toBe(2);
    expect(box.lines).toBeLessThanOrEqual(24);
    expect(box.clipped).toBe(true);
    expect(box.overlap).toBe(false);
    expect(box.spilled).toBe(0);
    expect(box.rowOverflow).toBeLessThanOrEqual(0);
  });

  test('the panel trash confirms, then removes the tile and its owned query', async ({ page }) => {
    await open(page);
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').locator('.chev').click();
    await treeRow(page, 'workspace:sales:group:panels').click();
    await (await act(page, 'workspace:sales:tile:t-cost', 'Remove Cost from dashboard')).click();
    // A confirmation naming both resources, not an immediate delete.
    await expect(page.locator('.dash-tree-confirm .fm-section'))
      .toHaveText('Remove panel “Cost” from “Sales revenue”? This also deletes its dedicated query copy.');
    await page.locator('.dash-tree-confirm .fm-item', { hasText: 'Remove panel' }).click();
    await expect(treeRow(page, 'workspace:sales:tile:t-cost')).toHaveCount(0);
    await expect.poll(async () => {
      const committed = await page.evaluate(() => window.__committed());
      return {
        tiles: committed.dashboards.find((d) => d.id === 'sales').tiles.map((t) => t.id),
        queries: committed.queries.map((q) => q.id).sort(),
      };
    }).toEqual({ tiles: ['t-rev'], queries: ['q-lib', 'q-rev'] });
    // Focus did not vanish with the row it was standing on: the surviving
    // sibling panel row holds it, with a visible ring. `toContainText` would
    // have passed with focus on `<body>`.
    const landed = await page.evaluate(() =>
      document.activeElement?.dataset?.key ?? document.activeElement?.tagName);
    expect(landed).toMatch(/:tile:t-rev$/);
  });
});

// #553 — Dashboard, Variables and Panels counts share ONE inline `· N`
// placement, and the narrow-sidebar breakpoint (#552's `@container sidebar
// (max-width: 220px)`, reused verbatim — no second container or threshold)
// hides all three uniformly. happy-dom cannot see any of this: the container
// query is real CSS layout, and the drag that reaches it needs a real
// `.col-resize` pointer sequence (`src/ui/splitters.ts`'s `dragValue('col',
// ev)` reads `ev.clientX` directly), the same pattern `sidebar-tabs-narrow.spec.js`
// (#552) uses.
test.describe('Dashboard tree counts at the narrow sidebar (#553)', () => {
  /** Drag `.col-resize` to `targetX` the way a real user does. */
  const dragSidebarTo = async (page, targetX) => {
    const handle = page.locator('.col-resize');
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetX, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
  };
  const expandSales = async (page) => {
    await roleTab(page, 'Dashboards').click();
    await treeRow(page, 'workspace:sales').locator('.dash-tree-chev').click();
    await treeRow(page, 'workspace:sales:group:variables').click();
    await treeRow(page, 'workspace:sales:group:panels').click();
  };

  test('the wide (default) sidebar shows Dashboard, Variables and Panels counts inline after the label', async ({ page }) => {
    await open(page);
    await expandSales(page);
    const countText = (key) => treeRow(page, key).locator('.dash-tree-count').textContent();
    await expect.poll(() => countText('workspace:sales')).toBe('· 2');
    await expect.poll(() => countText('workspace:sales:group:variables')).toBe('· 2');
    await expect.poll(() => countText('workspace:sales:group:panels')).toBe('· 2');
    for (const key of ['workspace:sales', 'workspace:sales:group:variables', 'workspace:sales:group:panels']) {
      await expect(treeRow(page, key).locator('.dash-tree-count')).toBeVisible();
    }
  });

  test('dragging to <=220px hides every dot/count, but the count stays in the accessible name and actions stay reachable', async ({ page }) => {
    await open(page);
    await expandSales(page);
    await dragSidebarTo(page, 200);
    await expect.poll(() => page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width))
      .toBeLessThanOrEqual(220);

    for (const key of ['workspace:sales', 'workspace:sales:group:variables', 'workspace:sales:group:panels']) {
      await expect(treeRow(page, key).locator('.dash-tree-count')).toBeHidden();
    }
    // Hidden from sight only: `rowAccessibleName` sets the row's `aria-label`
    // explicitly, so the count a sighted user no longer sees is still what a
    // screen reader announces.
    const tree = page.getByRole('tree', { name: 'Dashboards' });
    await expect(tree.getByRole('treeitem', { name: 'Sales revenue 2', exact: true })).toHaveCount(1);
    await expect(tree.getByRole('treeitem', { name: 'Variables 2', exact: true })).toHaveCount(1);
    await expect(tree.getByRole('treeitem', { name: 'Panels 2', exact: true })).toHaveCount(1);

    // The label recovered the space rather than being crushed, and Add panel —
    // its new home on the Panels row — is still reachable by both mouse and
    // keyboard at this width.
    const panelsRow = treeRow(page, 'workspace:sales:group:panels');
    const label = await panelsRow.locator('.label').boundingBox();
    expect(label.width).toBeGreaterThan(0);
    const plus = panelsRow.locator('.dash-tree-act[aria-label="Add panel to Sales revenue"]');
    await plus.focus();
    await expect(plus).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Add panel' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Add panel' })).toBeHidden();

    // Expand/collapse by mouse still works too.
    const chev = treeRow(page, 'workspace:sales').locator('.dash-tree-chev');
    await expect(chev).toHaveAttribute('aria-expanded', 'true');
    await chev.click();
    await expect(chev).toHaveAttribute('aria-expanded', 'false');
    await expect(treeRow(page, 'workspace:sales:group:panels')).toHaveCount(0);
  });

  test('widening the sidebar back past 220px restores every count', async ({ page }) => {
    await open(page);
    await expandSales(page);
    await dragSidebarTo(page, 200);
    await expect.poll(() => page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width))
      .toBeLessThanOrEqual(220);

    await dragSidebarTo(page, 300);
    await expect.poll(() => page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width))
      .toBeGreaterThan(220);

    for (const key of ['workspace:sales', 'workspace:sales:group:variables', 'workspace:sales:group:panels']) {
      await expect(treeRow(page, key).locator('.dash-tree-count')).toBeVisible();
    }
  });
});
