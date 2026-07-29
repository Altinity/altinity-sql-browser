import { test, expect } from '@playwright/test';

// #471/#535 — a Dashboard tile head's own actions: the expand action that replaced
// the Dashboard-level `< Query` button, and #535's duplicate and widen beside it.
//
// Everything here is something the unit suite cannot reach: a subtle action that
// only a real browser reveals on hover/focus, a KPI tile whose head is a
// pointer-transparent overlay, the real pointer-drag engine the action must not
// trigger, the shipped tab strip the opened document lands in, and the mobile
// bottom nav that is a phone's route off a Dashboard now that the toolbar button
// is gone.

const open = async (page, { width = 1280, height = 800 } = {}) => {
  await page.setViewportSize({ width, height });
  await page.goto('/tests/e2e/tile-open-workbench.html');
  await page.waitForFunction(() => window.__ready === true);
};

const roleTab = (page, name) => page.locator('.upper-role-tabs .side-tab', { hasText: name });
const treeRow = (page, key) => page.locator(`.dash-tree-row[data-key="${key}"]`);
const tabNames = (page) => page.locator('.qtab .name');
const tabs = (page) => page.evaluate(() => window.__tabs());
const surface = (page) => page.evaluate(() => window.__surface());
/** The tile card whose name is `title`, and the action inside it. */
const tileCard = (page, title) => page
  .locator('.dash-tile', { has: page.locator('.dash-tile-name', { hasText: title }) });
const tileAction = (page, title) => tileCard(page, title).locator('.dash-tile-open');
const tileNames = (page) => page.locator('.dash-tile .dash-tile-name');
/** #544: in EDIT mode a tile's head carries the `⋯`, and every action except widen
 *  is one of its rows. View mode keeps #471's direct expand icon. */
const tileMenu = (page, title) => tileCard(page, title).locator('.dash-tile-menu');
const menuRow = (page, label) => page.locator('.dash-tile-actions .fm-item', { hasText: label });
const openTileMenu = async (page, title) => {
  await tileMenu(page, title).click();
  await expect(page.locator('.dash-tile-actions')).toBeVisible();
};

/** Open a Dashboard from the tree the way the shipped gestures do (#429/#472): the
 *  row's name opens it in View, Shift-click in Edit, and expansion belongs to the
 *  chevron alone — a plain click no longer merely expands, as it did under #426. */
const openDashboard = async (page, dashboardId, mode = 'view') => {
  await roleTab(page, 'Dashboards').click();
  const row = treeRow(page, `workspace:${dashboardId}`);
  await row.locator('.label').click(mode === 'edit' ? { modifiers: ['Shift'] } : {});
  await expect(page.locator('.dash-page')).toBeVisible();
};

test('a tile action opens that tile\'s own document in the shipped tab strip', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await open(page);
  await openDashboard(page, 'sales');

  const action = tileAction(page, 'Live KPIs');
  // Subtle until the tile is hovered — but present in the DOM and named, not
  // conjured on hover.
  await expect(action).toHaveAttribute('aria-label', 'Open Live KPIs in Workbench and run');
  await expect(action).toHaveAttribute('title', 'Open in Workbench and run');
  expect(await action.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  await tileCard(page, 'Live KPIs').hover();
  await expect.poll(() => action.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

  const runsBefore = await page.evaluate(() => window.__execCalls());
  await action.click();

  // #535: the query RAN on arrival — the tile was showing a result, so the editor
  // does too. Proven by the execution seam, not by pixels: an empty result pane and
  // a pane that has not been asked to render yet look identical.
  await expect.poll(() => page.evaluate(() => window.__execCalls())).toBeGreaterThan(runsBefore);

  // We are on the Workbench, and the tile's document is the ACTIVE tab.
  await expect.poll(() => surface(page)).toBe('query');
  await expect(tabNames(page)).toHaveText(['Untitled', 'Live KPIs']);
  const open2 = await tabs(page);
  expect(open2.at(-1)).toMatchObject({ name: 'Live KPIs', savedId: 'q-sales', active: true });
  // The shipped SQL editor holds that document.
  await expect.poll(() => page.evaluate(() => window.__app.sqlEditor.getValue())).toBe('SELECT 1 AS v');
  expect(pageErrors).toEqual([]);
});

test('two Dashboard copies with the SAME name open two tabs; re-opening selects the existing one', async ({ page }) => {
  await open(page);

  // Dashboard `sales` → its copy of `Live KPIs`.
  await openDashboard(page, 'sales');
  await tileAction(page, 'Live KPIs').click();
  await expect(tabNames(page)).toHaveText(['Untitled', 'Live KPIs']);

  // Dashboard `ops` → a DIFFERENT document that happens to share the name.
  await openDashboard(page, 'ops');
  await tileAction(page, 'Live KPIs').click();
  await expect(tabNames(page)).toHaveText(['Untitled', 'Live KPIs', 'Live KPIs']);
  expect((await tabs(page)).map((t) => t.savedId)).toEqual([null, 'q-sales', 'q-ops']);

  // Re-opening `sales`'s tile selects the tab it already has — no third copy, and
  // the identity it selects by is the id, not the name it shares with `ops`.
  await page.locator('.qtab').first().click();
  await openDashboard(page, 'sales');
  await tileAction(page, 'Live KPIs').click();
  await expect(tabNames(page)).toHaveText(['Untitled', 'Live KPIs', 'Live KPIs']);
  const after = await tabs(page);
  expect(after.filter((t) => t.active).map((t) => t.savedId)).toEqual(['q-sales']);
});

test('tab keyboard activation, roving navigation, and close preserve focus', async ({ page }) => {
  await open(page);
  await openDashboard(page, 'sales');
  await tileAction(page, 'Live KPIs').click();
  await openDashboard(page, 'ops');
  await tileAction(page, 'Live KPIs').click();

  const selectors = page.locator('.qtab-select');
  await expect(selectors).toHaveCount(3);
  await expect(selectors.nth(2)).toHaveAttribute('tabindex', '0');
  await expect(selectors.nth(1)).toHaveAttribute('tabindex', '-1');

  // A native Space click changes the active signal, replaces the whole strip,
  // and must focus the replacement rather than the now-detached old button.
  await selectors.nth(1).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.qtab-select[data-tab-id="t2"]')).toBeFocused();
  await expect(page.locator('.qtab-select[data-tab-id="t2"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.qtab-select[data-tab-id="t2"]')).toHaveAttribute('tabindex', '0');

  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.qtab-select[data-tab-id="t3"]')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.locator('.qtab-select[data-tab-id="t1"]')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.locator('.qtab-select[data-tab-id="t3"]')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.qtab-select[data-tab-id="t1"]')).toBeFocused();

  // Close the focused active first tab. Its next neighbour becomes the first
  // remaining tab and receives both selection and focus.
  await page.locator('.qtab.active .close').click();
  await expect(page.locator('.qtab-select[data-tab-id="t2"]')).toBeFocused();
  await expect(page.locator('.qtab-select[data-tab-id="t2"]')).toHaveAttribute('aria-selected', 'true');
});

test('closing a clean inactive tab focuses the surviving active tab', async ({ page }) => {
  await open(page);
  await openDashboard(page, 'sales');
  await tileAction(page, 'Live KPIs').click();
  await openDashboard(page, 'ops');
  await tileAction(page, 'Live KPIs').click();

  await expect(page.locator('.qtab-select[data-tab-id="t3"]')).toHaveAttribute('aria-selected', 'true');
  await page.locator('.qtab').filter({ has: page.locator('[data-tab-id="t2"]') }).locator('.close').click();
  await expect(page.locator('.qtab-select[data-tab-id="t2"]')).toHaveCount(0);
  await expect(page.locator('.qtab-select[data-tab-id="t3"]')).toBeFocused();
  await expect(page.locator('.qtab-select[data-tab-id="t3"]')).toHaveAttribute('aria-selected', 'true');
});

test('confirming a dirty inactive close focuses the surviving active tab', async ({ page }) => {
  await open(page);
  await openDashboard(page, 'sales');
  await tileAction(page, 'Live KPIs').click();
  await openDashboard(page, 'ops');
  await tileAction(page, 'Live KPIs').click();

  // Dirty the sales copy, then return selection to the ops copy so the close
  // target is inactive when its confirmation opens.
  await page.locator('.qtab-select[data-tab-id="t2"]').click();
  await page.locator('.cm-content[data-language="sql"]').click();
  await page.keyboard.type(' ');
  await page.locator('.qtab-select[data-tab-id="t3"]').click();
  await page.locator('.qtab').filter({ has: page.locator('[data-tab-id="t2"]') }).locator('.close').click();
  await expect(page.locator('.qtab-close-confirm')).toBeVisible();
  await page.locator('.qtab-close-confirm-go').click();

  await expect(page.locator('.qtab-select[data-tab-id="t2"]')).toHaveCount(0);
  await expect(page.locator('.qtab-select[data-tab-id="t3"]')).toBeFocused();
  await expect(page.locator('.qtab-select[data-tab-id="t3"]')).toHaveAttribute('aria-selected', 'true');
});

test('the action is keyboard reachable and activates on Enter', async ({ page }) => {
  await open(page);
  await openDashboard(page, 'sales');

  const action = tileAction(page, 'Live KPIs');
  await action.focus();
  // Focus alone reveals it — a keyboard user never hovers.
  await expect.poll(() => action.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await expect(action).toBeFocused();
  await page.keyboard.press('Enter');

  await expect.poll(() => surface(page)).toBe('query');
  expect((await tabs(page)).at(-1)).toMatchObject({ savedId: 'q-sales', active: true });
});

// #553: Add panel moved off the Dashboard row onto the Panels group row — it
// creates a member of that group rather than acting on the Dashboard itself.
test('the Panels-row plus creates a blank linked Panel and focuses its SQL editor', async ({ page }) => {
  await open(page);
  // Begin on the actual Dashboard surface. A successful mutation must not
  // rerender that surface (which force-closes overlays) before the dialog can
  // close and perform its reveal/open/focus settlement.
  await openDashboard(page, 'sales');
  await expect.poll(() => surface(page)).toBe('dashboard');
  // The Panels group row only paints once the Dashboard is expanded.
  await treeRow(page, 'workspace:sales').locator('.dash-tree-chev').click();
  const panelsGroup = treeRow(page, 'workspace:sales:group:panels');
  const plus = panelsGroup.locator('.dash-tree-act[aria-label="Add panel to Sales"]');

  // The direct action is a real keyboard target, revealed by focus just like
  // the adjacent pencil and trash. Focus it explicitly: browser tab order also
  // includes the independently interactive row label, so it is not portable to
  // assert that the plus immediately follows the disclosure control.
  await plus.focus();
  await expect(plus).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(plus).toBeFocused();
  await expect.poll(() => plus.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'Add panel' });
  await expect(dialog).toBeVisible();
  const name = dialog.getByRole('textbox', { name: 'Panel name' });
  const description = dialog.getByRole('textbox', { name: 'Panel description' });
  await name.fill('New revenue panel');
  await description.fill('Created from the tree');
  await name.focus();
  await page.keyboard.press('Enter');

  // Settlement happens only after the dialog closes: the linked tab is active,
  // blank and clean, and focus belongs to the real CodeMirror SQL editor.
  await expect(dialog).toBeHidden();
  await expect.poll(() => surface(page)).toBe('query');
  const active = (await tabs(page)).find((tab) => tab.active);
  expect(active).toMatchObject({
    name: 'New revenue panel',
    sql: '',
    spec: {
      name: 'New revenue panel',
      description: 'Created from the tree',
      dashboard: { role: 'panel' },
    },
    dirtySql: false,
    dirtySpec: false,
  });
  expect(active.savedId).toBeTruthy();
  expect(active.committedToken).toBeTruthy();
  await expect(page.locator('.cm-content[data-language="sql"]')).toBeFocused();
  // The row is addressed by TILE id, not the query id. Its visible existence is
  // asserted by name after reveal expanded the Panels group.
  await expect(page.locator('.dash-tree-row', { hasText: 'New revenue panel' })).toHaveCount(1);
  expect(await page.evaluate(() => window.__libraryIds())).not.toContain(active.savedId);

  // Ordinary linked-query lifecycle from here: typing dirties the tab; Save
  // updates the owned query and returns it to clean without moving it to Library.
  await page.keyboard.type('SELECT 42');
  await expect.poll(async () => (await tabs(page)).find((tab) => tab.active).dirtySql).toBe(true);
  await page.locator('.save-btn').click();
  await expect.poll(async () => (await page.evaluate(() => window.__queries()))
    .find((query) => query.id === active.savedId).sql).toBe('SELECT 42');
  await expect.poll(async () => (await tabs(page)).find((tab) => tab.active).dirtySql).toBe(false);
  expect(await page.evaluate(() => window.__libraryIds())).not.toContain(active.savedId);
});

test('a KPI tile in VIEW mode still exposes a reachable action', async ({ page }) => {
  // The hard case, and the reason this spec exists: a grafana-grid KPI tile is
  // frameless, and its head is an absolutely-positioned `pointer-events: none`
  // overlay that View mode used to keep hidden forever (nothing else in it exists
  // outside Edit mode). Both the reveal and the pointer-events opt-in are pure CSS,
  // so only a real browser can show the action is genuinely clickable rather than
  // merely present in the DOM.
  await open(page);
  await openDashboard(page, 'sales');

  const kpi = page.locator('.dash-gg-tile.is-kpi');
  await expect(kpi).toHaveCount(1);
  const action = kpi.locator('.dash-tile-open');
  expect(await action.evaluate((el) => getComputedStyle(el.parentElement).opacity)).toBe('0');
  await kpi.hover();
  await expect.poll(() => action.evaluate((el) => getComputedStyle(el.parentElement).opacity)).toBe('1');
  await expect.poll(() => action.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('auto');
  // The KPI value is still what the tile shows — the chrome is an overlay.
  await expect(kpi.locator('.kpi-card, .dash-kpi-state-card')).toHaveCount(1);

  // A real click, hit-tested through the overlay chain.
  await action.click();
  await expect.poll(() => surface(page)).toBe('query');
  expect((await tabs(page)).at(-1)).toMatchObject({ savedId: 'q-kpi', active: true });
});

test('a KPI tile in EDIT mode packs its two controls top-right, in reading order', async ({ page }) => {
  // Geometry, because CSS decides it and happy-dom sees none of it: a KPI tile has
  // no heading to push its controls right, so the head squares them up itself. ONE
  // `margin-left: auto` inside the group would absorb the free space at that point
  // and strand whatever precedes it at the LEFT edge. #544 cut the group from four
  // to two (inline widen, then the `⋯`), which makes that failure mode easier to
  // see, not harder: a split pair is unmistakable.
  await open(page);
  await openDashboard(page, 'sales', 'edit');

  const kpi = page.locator('.dash-gg-tile.is-kpi');
  await kpi.hover();
  const geometry = await kpi.evaluate((tile) => {
    const box = (sel) => {
      const rect = tile.querySelector(sel).getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    };
    const head = tile.querySelector(':scope > .dash-tile-head').getBoundingClientRect();
    return {
      headLeft: head.left,
      headRight: head.right,
      headWidth: head.width,
      actions: ['.dash-tile-widen', '.dash-tile-menu'].map(box),
      // …and nothing the head used to carry is left behind in it.
      retired: ['.dash-tile-dup', '.dash-gg-del', '.dash-tile-open']
        .map((sel) => tile.querySelector(sel)).filter(Boolean).length,
    };
  });
  const [widen, menu] = geometry.actions;
  expect(geometry.retired).toBe(0);
  // The whole group is right-packed: the FIRST control starts past the head's
  // midpoint, and the second follows it with no gap opened between them.
  expect(widen.left).toBeGreaterThan(geometry.headLeft + geometry.headWidth * 0.5);
  expect(widen.right).toBeLessThanOrEqual(menu.left + 1);
  expect(menu.right).toBeLessThanOrEqual(geometry.headRight + 1);
});

// #535 — the widen step, in a real CSS grid. Everything here is invisible to
// happy-dom: the rendered column span, the pixel height, and whether the `hidden`
// attribute actually hides a button whose author-sheet `display: inline-flex` beats
// the UA sheet's `[hidden] { display: none }`.
test('widen doubles a grid tile\'s rendered width and height, then wraps', async ({ page }) => {
  // Wide enough that the grid host clears `effectiveGridColumns`' 1160px tier and
  // renders all 12 columns. At the default 1280 viewport the sidebar leaves it in
  // the 6-column tier, where the fixture's span-8 tile is ALREADY full width and a
  // widen changes nothing horizontally — a real clamp, not a bug, but it would make
  // this assertion untestable.
  await open(page, { width: 1600, height: 900 });
  await openDashboard(page, 'sales', 'edit');

  const tile = tileCard(page, 'Live KPIs');
  const widen = tile.locator('.dash-tile-widen');
  await tile.hover();
  await expect(widen).toHaveAttribute('title', 'Widen to 12 columns'); // span 8 -> 12
  const before = await tile.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });

  await widen.click();
  await expect(widen).toHaveAttribute('title', 'Shrink to 1 column');
  const wide = await tile.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  // Wider AND taller on screen, and the persisted placement says exactly why.
  expect(wide.width).toBeGreaterThan(before.width);
  expect(wide.height).toBeGreaterThan(before.height);
  expect((await page.evaluate(() => window.__dashboard('sales'))).items['t-sales'])
    .toEqual({ span: 12, height: 4 });

  // At the maximum the next press wraps to a single column.
  await widen.click();
  await expect(widen).toHaveAttribute('title', 'Widen to 2 columns');
  await expect.poll(() => tile.evaluate((el) => el.getBoundingClientRect().width))
    .toBeLessThan(wide.width / 2);
});

// #544 — the NARROW rule, which is a CSS container query and therefore invisible to
// happy-dom in a way no JS assertion can substitute for. Two independent gates for
// two independent questions: `hidden` says the STYLE has no width to step, this says
// this particular TILE has no room to offer the shortcut. The menu row is unaffected
// by either, so widen is never unreachable.
test('a narrow tile drops the inline widen but keeps its menu row', async ({ page }) => {
  await open(page, { width: 1600, height: 900 });
  await openDashboard(page, 'sales', 'edit');

  const tile = tileCard(page, 'Live KPIs');
  const widen = tile.locator('.dash-tile-widen');
  await tile.hover();
  // Wide (span 8 of twelve): the shortcut is there.
  await expect(widen).toBeVisible();
  await expect.poll(() => widen.evaluate((el) => getComputedStyle(el).display)).not.toBe('none');

  // Two presses take it from span 8 to the maximum and then WRAP to a single column
  // — the same gesture a user makes, and the width where the ellipsized title has
  // nothing left to give.
  await widen.click();
  await widen.click();
  await expect.poll(() => tile.evaluate((el) => el.getBoundingClientRect().width))
    .toBeLessThan(260);
  await expect.poll(() => widen.evaluate((el) => getComputedStyle(el).display)).toBe('none');
  // `hidden` is NOT what did it — the style still has widths to step.
  await expect(widen).not.toHaveAttribute('hidden', '');

  // The `⋯` survives at that width, and still offers the step.
  const menu = tile.locator('.dash-tile-menu');
  await tile.hover();
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(menuRow(page, 'Widen to 2 columns')).toBeVisible();
  await menuRow(page, 'Widen to 2 columns').click();
  // Read defensively: the commit republishes, and a poll that THROWS mid-rebuild
  // aborts instead of retrying.
  await expect.poll(() => page.evaluate(
    async () => (await window.__dashboard('sales'))?.items?.['t-sales']?.span ?? null,
  )).toBe(2);
});

// #544 — the `⋯` is the first `openMenu` trigger to sit at the viewport's RIGHT
// edge; every earlier one (the File button, the style picker, a tree row) anchors
// near the left, so a left-aligned 252px panel always fit. Only a real layout can
// show the clamp working.
test('a right-edge tile\'s menu stays inside the viewport', async ({ page }) => {
  await open(page, { width: 1280, height: 900 });
  await openDashboard(page, 'sales', 'edit');

  // The rightmost tile's trigger, whichever tile that is at this width.
  const triggers = page.locator('.dash-tile-menu');
  const count = await triggers.count();
  let rightmost = triggers.nth(0);
  let maxRight = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const card = triggers.nth(i);
    await card.evaluate((el) => el.closest('.dash-tile').scrollIntoView({ block: 'nearest' }));
    const box = await card.boundingBox();
    if (box && box.x + box.width > maxRight) { maxRight = box.x + box.width; rightmost = card; }
  }
  await rightmost.evaluate((el) => el.closest('.dash-tile').scrollIntoView({ block: 'nearest' }));
  await rightmost.click();

  const menu = page.locator('.dash-tile-actions');
  await expect(menu).toBeVisible();
  const geometry = await menu.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewportWidth: window.innerWidth };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
});

test('widen hides itself for a single-column style, and the hidden attribute really hides it', async ({ page }) => {
  await open(page);
  await openDashboard(page, 'sales', 'edit');
  const widen = tileCard(page, 'Live KPIs').locator('.dash-tile-widen');
  await tileCard(page, 'Live KPIs').hover();
  await expect(widen).toBeVisible();

  // Report is one centred column — there is no width to step through. `hidden`
  // needs its own CSS rule here, because the base rule's `display: inline-flex`
  // outranks the UA stylesheet.
  await page.locator('.dash-style-btn').click();
  await page.locator('.dash-style-menu').getByRole('menuitem', { name: 'Report' }).click();
  await expect(widen).toBeHidden();

  await page.locator('.dash-style-btn').click();
  await page.locator('.dash-style-menu').getByRole('menuitem', { name: '3 columns' }).click();
  await expect(widen).toBeVisible();
  await expect(widen).toHaveAttribute('title', 'Widen to 2 columns');
});

// #535 — duplication commits TWO resources and then rebuilds the route; only a real
// IndexedDB round trip proves both landed and the copy actually rendered.
test('duplicate commits a copy right after the source, and it renders', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await open(page);
  await openDashboard(page, 'sales', 'edit');
  await expect(tileNames(page)).toHaveText(['Revenue KPI', 'Live KPIs', 'Runbook']);

  const tile = tileCard(page, 'Live KPIs');
  await tile.hover();
  await openTileMenu(page, 'Live KPIs');
  await menuRow(page, 'Duplicate panel').click();

  // The copy shares the source's NAME, so it is located by position, never by text.
  await expect(tileNames(page)).toHaveText(['Revenue KPI', 'Live KPIs', 'Live KPIs', 'Runbook']);
  const committed = await page.evaluate(() => window.__dashboard('sales'));
  expect(committed.tiles.map((t) => t.queryId))
    .toEqual(['q-kpi', 'q-sales', committed.tiles[2].queryId, 'q-text']);
  // Its own dedicated owned copy, and NOT a Library query.
  const copyQueryId = committed.tiles[2].queryId;
  expect(copyQueryId).not.toBe('q-sales');
  expect(await page.evaluate(() => window.__libraryIds())).not.toContain(copyQueryId);
  // Same size as the source, not the query's add-time size hint.
  expect(committed.items[committed.tiles[2].id]).toEqual(committed.items['t-sales']);
  expect(pageErrors).toEqual([]);
});

test('the KPI overlay action is reachable by keyboard, which reveals the head', async ({ page }) => {
  // The overlay is `opacity: 0` + `pointer-events: none` and is revealed by `:hover`
  // and `:focus-within`. A keyboard user never hovers, so focus must be the whole
  // path: reveal, then activate.
  await open(page);
  await openDashboard(page, 'sales');

  const kpi = page.locator('.dash-gg-tile.is-kpi');
  const action = kpi.locator('.dash-tile-open');
  await action.focus();
  await expect(action).toBeFocused();
  await expect.poll(() => action.evaluate((el) => getComputedStyle(el.parentElement).opacity)).toBe('1');
  await page.keyboard.press('Enter');

  await expect.poll(() => surface(page)).toBe('query');
  expect((await tabs(page)).at(-1)).toMatchObject({ savedId: 'q-kpi', active: true });
});

test('Saving the opened tab updates the Dashboard copy, not the same-named sibling', async ({ page }) => {
  // The acceptance criterion that the identity argument rests on, asserted directly:
  // `q-sales` and `q-ops` are both named `Live KPIs`, each owned by a different
  // Dashboard. Editing the one this tile opened must write only that copy.
  await open(page);
  await openDashboard(page, 'sales');
  await tileAction(page, 'Live KPIs').click();
  await expect.poll(() => surface(page)).toBe('query');

  await page.locator('.cm-content[data-language="sql"]').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('SELECT 99 AS v');
  await page.locator('.save-btn').click();

  await expect.poll(async () => (await page.evaluate(() => window.__queries()))
    .find((query) => query.id === 'q-sales').sql).toBe('SELECT 99 AS v');
  const queries = await page.evaluate(() => window.__queries());
  // The same-named copy in the OTHER Dashboard is untouched, and no new query was
  // created (a name-keyed write would have hit one of these).
  expect(queries.find((query) => query.id === 'q-ops').sql).toBe('SELECT 2 AS v');
  expect(queries.map((query) => query.id)).toEqual(['q-sales', 'q-ops', 'q-kpi', 'q-text']);
  // The tab is clean again, and still linked to the Dashboard's copy.
  await expect(page.locator('.qtab.active .dirty')).toHaveCount(0);
  expect((await tabs(page)).at(-1)).toMatchObject({ savedId: 'q-sales' });
});

test('Back returns to the Dashboard the tile belonged to, at the offset it was left at', async ({ page }) => {
  // #471's own acceptance criteria: opening a tile's query must not disturb the
  // Dashboard, and ordinary history navigation is the way back — which is exactly
  // what removing the global `< Query` button leans on. The URL carries no Dashboard
  // id, so before the history snapshot this landed on the collection's FIRST
  // Dashboard, at the top of the page. Two Dashboards and a non-zero offset is the
  // only shape that can tell the difference.
  await open(page, { width: 1280, height: 600 });
  await openDashboard(page, 'ops');       // an entry for a DIFFERENT Dashboard first
  await openDashboard(page, 'sales');     // …then the one we actually leave

  const scroller = page.locator('.dash-page');
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const left = await scroller.evaluate((el) => el.scrollTop);
  expect(left, 'the fixture must be scrollable for this to mean anything').toBeGreaterThan(0);

  await tileAction(page, 'Live KPIs').click();
  await expect.poll(() => surface(page)).toBe('query');

  await page.goBack();

  await expect.poll(() => surface(page)).toBe('dashboard');
  await expect(page.locator('.dash-page')).toBeVisible();
  // The Dashboard the tile belonged to — `sales`, not `ops` and not the first entry.
  expect(await page.evaluate(() => window.__app.mainSurface.dashboardId)).toBe('sales');
  // Its own tiles are what came back (`ops` has a single tile and no KPI).
  await expect(page.locator('.dash-tile')).toHaveCount(3);
  // …at the offset it was left at, not the top.
  await expect.poll(() => page.locator('.dash-page').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(left / 2);
});

test('a queryless (Text) tile exposes no action at all', async ({ page }) => {
  await open(page);
  await openDashboard(page, 'sales');

  await expect(tileAction(page, 'Runbook')).toHaveCount(0);
  // …while its query-backed siblings do have one (the panel tile + the KPI tile).
  await expect(page.locator('.dash-tile-open')).toHaveCount(2);
});

test('pressing the action never starts a tile drag or reorders the Dashboard', async ({ page }) => {
  await open(page);
  // Edit mode is where the drag engine is wired at all.
  await openDashboard(page, 'sales', 'edit');

  // The `⋯`, not #471's expand: drag is wired in EDIT mode only, and Edit's head
  // carries the menu trigger.
  const action = tileMenu(page, 'Live KPIs');
  const card = tileCard(page, 'Live KPIs');
  const before = await card.boundingBox();
  const box = await action.boundingBox();

  // A modifier-held press-and-drag FROM the action: the identical gesture on the
  // tile body would arm a reorder.
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 240, box.y + 120, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up('ControlOrMeta');

  await expect(page.locator('.dash-floating')).toHaveCount(0);
  await expect(page.locator('.dash-grid.dash-reordering')).toHaveCount(0);
  // The tile did not move, and the tile order is unchanged.
  expect(await card.boundingBox()).toMatchObject({ x: before.x, y: before.y });
  await expect(tileNames(page)).toHaveText(['Revenue KPI', 'Live KPIs', 'Runbook']);
  // Still on the Dashboard — a drag attempt is not an open.
  expect(await surface(page)).toBe('dashboard');
});

// A touch device matches neither `:hover` nor `:focus-visible`, so a hover-revealed
// action would be permanently invisible there — and on a phone this action is the
// only way into the query behind a tile. `@media (hover: none)` is what prevents
// that, and it needs real touch emulation to evaluate: a 360px desktop viewport
// still reports `hover: hover`.
test.describe('touch', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('the action is permanently visible where there is no hover and no keyboard', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'isMobile emulation is unsupported on Firefox');
    await open(page, { width: 390, height: 844 });
    await openDashboard(page, 'sales');

    const action = tileAction(page, 'Live KPIs');
    // No hover, no focus — and still visible.
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
    await expect.poll(() => action.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    // Including a KPI tile, whose whole chrome overlay is otherwise hover-revealed —
    // and in EDIT mode, where that reveal is additionally `:not(.is-view)`-scoped, so
    // a touch device satisfied neither half of it. #544: which control sits in that
    // head depends on the mode — View has the direct expand, Edit has the `⋯`, and on
    // a phone the `⋯` is the ONLY route to duplicate or remove.
    for (const [mode, cls] of [['view', '.dash-tile-open'], ['edit', '.dash-tile-menu']]) {
      await openDashboard(page, 'sales', mode);
      const kpiAction = page.locator(`.dash-gg-tile.is-kpi ${cls}`);
      await expect.poll(
        () => kpiAction.evaluate((el) => getComputedStyle(el.parentElement).opacity),
        { message: `KPI head hidden on touch in ${mode} mode` },
      ).toBe('1');
      await expect.poll(
        () => kpiAction.evaluate((el) => getComputedStyle(el).opacity),
        { message: `${cls} hidden on touch in ${mode} mode` },
      ).toBe('1');
    }
    await openDashboard(page, 'sales');
    // The tap itself is chromium-only: WebKit's mobile emulation hit-tests a tap to
    // the root element, which is a Playwright emulation limit rather than anything
    // about this button (its click path is covered on both engines above).
    test.skip(browserName !== 'chromium', 'tap emulation is chromium-only here');
    await action.tap();
    await expect.poll(() => surface(page)).toBe('query');
    expect((await tabs(page)).at(-1)).toMatchObject({ savedId: 'q-sales', active: true });
  });
});

test('on a phone the bottom nav is the route off a Dashboard, and offers only Editor', async ({ page }) => {
  // #471 removed the toolbar's `< Query` button. A Dashboard with no tiles has no
  // per-tile action either, so the mobile rules stop hiding the bottom nav here —
  // otherwise a phone would have no way back at all (the sidebar is hidden too).
  //
  // Opened at desktop width and then narrowed, because the tree that opens a
  // Dashboard is itself hidden below the breakpoint — which is exactly the trap this
  // test exists for. The mobile rules are CSS-only, so the resize is the whole
  // transition.
  await open(page);
  await openDashboard(page, 'ops');
  await page.setViewportSize({ width: 360, height: 720 });

  const nav = page.locator('.mobile-nav');
  await expect(nav).toBeVisible();
  await expect(nav.locator('.mobile-nav-btn:visible')).toHaveCount(1);
  const editor = nav.locator('.mobile-nav-btn[data-view="editor"]');
  await expect(editor).toBeVisible();
  // Editor is a DESTINATION here, never the panel already on screen, so it must not
  // be painted as the active tab.
  expect(await editor.evaluate((el) => getComputedStyle(el, '::before').content)).toBe('none');

  await editor.click();
  await expect.poll(() => surface(page)).toBe('query');
  // And it landed on the editor panel, not merely on the surface.
  await expect(page.locator('.main-row')).toHaveAttribute('data-mobile-view', 'editor');
  // The editor/results splitter is present for desktop dragging, but it must not
  // consume a visible row in the single-pane mobile editor.
  await expect(page.locator('.editor-results-split')).toBeHidden();
});
