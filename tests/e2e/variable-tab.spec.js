import { test, expect } from '@playwright/test';

// #457 — a Dashboard variable's option SQL is edited in the MAIN editor, as a
// dedicated tab, and not in a drawer of its own.
//
// This spec exists at the e2e level for a reason the unit suite cannot cover: the
// whole claim is "the existing editing surface is REUSED". Proving that needs the
// real tab strip, a real CodeMirror instance holding a real document, and the real
// Save control — none of which `dashboard-tree.html` mounts, and none of which
// happy-dom can render.

const open = async (page) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/tests/e2e/variable-tab.html');
  await page.waitForFunction(() => window.__ready === true);
};

const roleTab = (page, name) => page.locator('.upper-role-tabs .side-tab', { hasText: name });
const treeRow = (page, key) => page.locator(`.dash-tree-row[data-key="${key}"]`);
const tabNames = (page) => page.locator('.qtab .name');
// BOTH CodeMirror instances are mounted (SQL + Spec JSON), so every editor
// selector must name which one — a bare `.cm-content` is a strict-mode violation.
const sqlEditor = (page) => page.locator('.cm-content[data-language="sql"]');
const editorText = (page) => page.evaluate(() => window.__app.sqlEditor.getValue());

/** Expand `dashboardId` and its Variables group, then click variable `name`.
 *  Expansion is driven off which ROWS exist rather than off any attribute: the
 *  chevron carries none, and the tree is fully repainted on every toggle. */
const openVariable = async (page, dashboardId, name) => {
  await roleTab(page, 'Dashboards').click();
  const group = treeRow(page, `workspace:${dashboardId}:group:variables`);
  if (!(await group.count())) await treeRow(page, `workspace:${dashboardId}`).locator('.chev').click();
  const variable = treeRow(page, `workspace:${dashboardId}:variable:${name}`);
  if (!(await variable.count())) await group.click();
  await variable.click();
};

test('a variable row opens a real editor tab loaded with its committed SQL', async ({ page }) => {
  await open(page);
  await openVariable(page, 'sales', 'zone');

  // The SHIPPED tab strip, beside the query tab that was already open.
  await expect(tabNames(page)).toHaveText(['Untitled', 'Variable: zone']);
  await expect(page.locator('.qtab').last()).toHaveClass(/active/);
  // The SHIPPED CodeMirror instance holds the variable's stored option SQL.
  await expect.poll(() => editorText(page)).toBe("SELECT 'eu', 'Europe'");
  // It is the SQL editor that is live — a variable is an SQL document, and the
  // Spec pane stays hidden for it.
  await expect(sqlEditor(page)).toBeVisible();
  await expect(page.locator('.spec-pane')).toBeHidden();
});

test('the same variable name in two Dashboards opens two independent tabs', async ({ page }) => {
  await open(page);
  await openVariable(page, 'sales', 'zone');
  await openVariable(page, 'ops', 'zone');

  await expect(tabNames(page)).toHaveText(['Untitled', 'Variable: zone', 'Variable: zone']);
  expect(await page.evaluate(() => window.__variableTabs().map((t) => t.dashboardId)))
    .toEqual(['sales', 'ops']);
  // `ops` has no stored configuration, so its tab is blank — not `sales`'s SQL.
  await expect.poll(() => editorText(page)).toBe('');
});

test('re-clicking a variable selects the tab it already has, keeping unsaved edits', async ({ page }) => {
  await open(page);
  await openVariable(page, 'sales', 'zone');
  await sqlEditor(page).click();
  await page.keyboard.type(' -- edited');

  // A different tab first, so the re-click has to actually re-select.
  await page.locator('.qtab').first().click();
  await openVariable(page, 'sales', 'zone');

  await expect(tabNames(page)).toHaveText(['Untitled', 'Variable: zone']);
  await expect.poll(() => editorText(page)).toContain('-- edited');
});

test('Save writes the edited SQL to that variable, and nothing to the Library', async ({ page }) => {
  await open(page);
  await openVariable(page, 'sales', 'zone');
  await sqlEditor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type("SELECT 'us', 'United States'");

  await page.locator('.save-btn').click();

  await expect.poll(() => page.evaluate(() => window.__storedSql('sales', 'zone')))
    .toBe("SELECT 'us', 'United States'");
  // Never a saved query: the Library is untouched and the tab has no link.
  expect(await page.evaluate(() => window.__app.state.savedQueries.map((q) => q.id)))
    .toEqual(['q-sales', 'q-ops', 'q-long']);
  expect(await page.evaluate(() => window.__app.activeTab().savedId)).toBeNull();
  // A successful save clears the tab's dirty marker.
  await expect(page.locator('.qtab.active .dirty')).toHaveCount(0);
});

test('saving a blank document removes the configuration entirely', async ({ page }) => {
  await open(page);
  await openVariable(page, 'sales', 'zone');
  await sqlEditor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');

  await page.locator('.save-btn').click();

  // Back to direct input — not an empty string that would read as
  // configured-but-broken later.
  await expect.poll(() => page.evaluate(() => window.__storedSql('sales', 'zone'))).toBeNull();
});

test('typing marks the tab dirty, and Spec mode is refused with a variable-specific reason', async ({ page }) => {
  await open(page);
  await openVariable(page, 'sales', 'zone');
  await sqlEditor(page).click();
  await page.keyboard.type('x');

  await expect(page.locator('.qtab.active .dirty')).toHaveCount(1);
  // A variable document has no Spec to author, and the hovered title has to say
  // so rather than telling the user to save a query they cannot save.
  await expect(page.locator('.editor-mode-btn', { hasText: 'Spec' }))
    .toHaveAttribute('title', 'A dashboard variable has no Spec.');
});

// #466 — closing a dirty tab (either kind) confirms first, through a REAL click
// → popover → click round trip happy-dom cannot render at all.
test('closing a dirty variable tab confirms first; Cancel keeps the draft open', async ({ page }) => {
  await open(page);
  await openVariable(page, 'sales', 'zone');
  await sqlEditor(page).click();
  await page.keyboard.type('x');
  // Dismiss any CM6 completion popup the typed character opened — it can
  // otherwise overlap and intercept the click meant for the tab strip below.
  await page.keyboard.press('Escape');

  await page.locator('.qtab.active .close').click();
  await expect(page.locator('.qtab-close-confirm')).toBeVisible();
  await expect(page.locator('.qtab-close-confirm .fm-section')).toContainText('Close “Variable: zone”?');
  await page.locator('.qtab-close-confirm-cancel').click();

  await expect(page.locator('.qtab-close-confirm')).toHaveCount(0);
  await expect(tabNames(page)).toHaveText(['Untitled', 'Variable: zone']);
  await expect(page.locator('.qtab.active .dirty')).toHaveCount(1); // draft untouched
});

// Review finding: `openMenu` autofocuses a row as soon as it opens, and a
// browser's native focused-button activation fires on Enter — a real UA
// behavior no unit test can exercise. The destructive row is listed FIRST
// (visually matching the Dashboard tree's own delete-confirm), so this is the
// one place that actually proves Enter lands on Cancel, not on it.
test('pressing Enter right after the confirm opens does NOT discard the draft', async ({ page }) => {
  await open(page);
  await openVariable(page, 'sales', 'zone');
  await sqlEditor(page).click();
  await page.keyboard.type('x');
  // Dismiss any CM6 completion popup the typed character opened — it can
  // otherwise overlap and intercept the click meant for the tab strip below.
  await page.keyboard.press('Escape');

  await page.locator('.qtab.active .close').click();
  await expect(page.locator('.qtab-close-confirm')).toBeVisible();
  // `openMenu`'s own initial-focus assignment is deferred a tick (a browser
  // click already focuses the clicked `.close` button itself; the deferred
  // focus is what lets the popover's own focus grab win afterward) — wait for
  // it to actually settle on Cancel, matching a real user's reaction time,
  // rather than racing it with an instantaneous keypress.
  await expect(page.locator('.qtab-close-confirm-cancel')).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.locator('.qtab-close-confirm')).toHaveCount(0);
  await expect(tabNames(page)).toHaveText(['Untitled', 'Variable: zone']);
  await expect(page.locator('.qtab.active .dirty')).toHaveCount(1); // draft untouched
});

test('confirming the close discards the dirty tab', async ({ page }) => {
  await open(page);
  await openVariable(page, 'sales', 'zone');
  await sqlEditor(page).click();
  await page.keyboard.type('x');
  // Dismiss any CM6 completion popup the typed character opened — it can
  // otherwise overlap and intercept the click meant for the tab strip below.
  await page.keyboard.press('Escape');

  await page.locator('.qtab.active .close').click();
  await page.locator('.qtab-close-confirm-go').click();

  await expect(page.locator('.qtab-close-confirm')).toHaveCount(0);
  await expect(tabNames(page)).toHaveText(['Untitled']);
});

test('Run executes a valid variable query through the bounded probe and displays its rows', async ({ page }) => {
  await open(page);
  await openVariable(page, 'sales', 'zone');
  await sqlEditor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type("SELECT 'v1', 'Label 1'");

  await page.locator('.run-btn').click();

  await expect.poll(() => page.evaluate(() => window.__runResult())).toEqual({
    error: null, rows: [['v1', 'Label 1']], columns: [{ name: 'value', type: 'String' }, { name: 'label', type: 'String' }],
  });
  await expect(page.locator('.results-error')).toHaveCount(0);
});

test('Run reports a column-shape problem, never a successful result', async ({ page }) => {
  await open(page);
  await openVariable(page, 'sales', 'zone');
  await sqlEditor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('SELECT 1');

  await page.locator('.run-btn').click();

  await expect(page.locator('.results-error')).toContainText('exactly two columns');
  expect(await page.evaluate(() => window.__runResult().error)).toContain('exactly two columns');
});

test('a long variable name never widens the tab strip or scrolls the page', async ({ page }) => {
  // `Variable: is_initial_query` (the issue's own example) is a far longer tab
  // title than any query tab normally carries, and a tab strip whose children are
  // pinned `flex-shrink: 0` would push its host wider — a failure happy-dom cannot
  // observe at all, and one this repo has already shipped once on a toolbar row.
  await open(page);
  await openVariable(page, 'long', 'is_initial_query');
  await expect(tabNames(page)).toHaveText(['Untitled', 'Variable: is_initial_query']);

  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 800 });
    const box = await page.evaluate(() => {
      const strip = document.querySelector('.qtabs-inner');
      const name = document.querySelector('.qtab:last-child .name');
      return {
        stripWidth: strip.getBoundingClientRect().width,
        hostWidth: strip.parentElement.getBoundingClientRect().width,
        bodyScroll: document.body.scrollWidth,
        bodyClient: document.body.clientWidth,
        textOverflow: getComputedStyle(name).textOverflow,
      };
    });
    // The strip stays inside the column it lives in — at 360px the tabs shrink to
    // fit rather than the strip growing.
    expect(box.stripWidth, `strip overflows its host at ${width}px`)
      .toBeLessThanOrEqual(box.hostWidth + 1);
    // …and the page itself never gains a horizontal scrollbar because of it.
    expect(box.bodyScroll, `page scrolls horizontally at ${width}px`)
      .toBeLessThanOrEqual(box.bodyClient + 1);
    // Whatever cannot fit is ellipsized, never clipped bare.
    expect(box.textOverflow).toBe('ellipsis');
  }
});
