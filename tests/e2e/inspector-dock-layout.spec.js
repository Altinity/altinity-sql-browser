import { test, expect } from '@playwright/test';

// #586 AC2 real-browser layout gate: `.main-row` must have a real
// `inspectorHost` slot "as a layout sibling of `queryHost`/`dashboardHost`,
// not a `position:fixed` overlay". happy-dom cannot evaluate CSS layout at
// all (see `sidebar-tabs-narrow.spec.js`'s own header comment for the same
// reasoning) — `tests/unit/app-shell.test.ts` proves DOM sibling order,
// `hidden`, and the inline `style.width` write, but nothing in the repo
// asserted the GEOMETRIC claim that is this phase's entire point until now.
//
// Reuses `dashboard-tree.html` (#426's fixture, already extended by
// sidebar-tabs-narrow.spec.js for the same reason): it mounts the REAL
// `mountAppShell`, so `.main-row`/`.query-host`/`.inspector-host`/
// `.inspector-resize` are genuine, styled DOM here, not a hand-built stand-in
// (see that spec's header comment on why this fixture, not a fresh one, is
// the right harness). It never wires a real docked surface (no workbench),
// so this spec drives `inspector-host.ts`'s own `showInInspector`/
// `releaseInspector` primitive directly via the fixture's own
// `window.__openInspector`/`__closeInspector` helpers (added alongside this
// spec) — the SAME shared mechanism every docked surface (Cell, Rows,
// Reference) is built on, so the geometry this gate checks is exactly and
// only that primitive's, never any one surface's content.

const open = async (page) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/tests/e2e/dashboard-tree.html');
  await page.waitForFunction(() => window.__ready === true);
};

test.describe('docked right-inspector layout geometry (#586 AC2)', () => {
  test('folded: .inspector-host and .inspector-resize contribute zero layout width', async ({ page }) => {
    await open(page);
    const host = page.locator('.inspector-host');
    const resize = page.locator('.inspector-resize');
    await expect(host).toBeHidden();
    await expect(resize).toBeHidden();
    // Playwright's boundingBox() returns null for a `display: none` element
    // (the `[hidden]` override, styles.css) — there is no box to measure at
    // all, the strongest form of "contributes zero layout width".
    expect(await host.boundingBox()).toBeNull();
    expect(await resize.boundingBox()).toBeNull();
  });

  test('open: .query-host narrows, and the inspector never intersects it — docked, not an overlay', async ({ page }) => {
    await open(page);
    const queryHost = page.locator('.query-host');
    const foldedBox = await queryHost.boundingBox();

    const mounted = await page.evaluate(() => window.__openInspector());
    expect(mounted).toBe(true);
    const inspectorHost = page.locator('.inspector-host');
    await expect(inspectorHost).toBeVisible();

    const openBox = await queryHost.boundingBox();
    const inspectorBox = await inspectorHost.boundingBox();

    // The real "docked, not overlay" assertion (AC2): centre width shrinks by
    // (about) the same amount the inspector claims — a `position: fixed`
    // overlay would consume zero centre width instead, leaving these equal.
    expect(openBox.width).toBeLessThan(foldedBox.width);
    // Geometric non-overlap: the two boxes' horizontal spans do not
    // intersect at all. A `position: fixed` overlay drawn ON TOP of the
    // centre surface would intersect it; a genuine layout sibling never can.
    const intersectsHorizontally = inspectorBox.x < openBox.x + openBox.width
      && openBox.x < inspectorBox.x + inspectorBox.width;
    expect(intersectsHorizontally).toBe(false);

    // Record the actual measured numbers for the report — not asserted
    // beyond the above (viewport chrome/sidebar width vary by engine).
    test.info().annotations.push(
      { type: 'query-host folded width', description: String(foldedBox.width) },
      { type: 'query-host open width', description: String(openBox.width) },
      { type: 'inspector-host open width', description: String(inspectorBox.width) },
    );
  });

  test('resize: dragging .inspector-resize changes the host width live', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__openInspector());
    const inspectorHost = page.locator('.inspector-host');
    await expect(inspectorHost).toBeVisible();
    const before = await inspectorHost.boundingBox();

    const handle = page.locator('.inspector-resize');
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // 'rightInspector' is anchored to the right edge (splitters.ts's
    // `dragValue`): width = viewportWidth - clientX, so moving the cursor
    // LEFT grows the host — pick a delta comfortably inside the [320,
    // 92vw] clamp for a 1280px viewport.
    await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();

    const after = await inspectorHost.boundingBox();
    expect(after.width).toBeGreaterThan(before.width + 100);

    test.info().annotations.push(
      { type: 'inspector-host width before drag', description: String(before.width) },
      { type: 'inspector-host width after drag', description: String(after.width) },
    );
  });
});

// #586 findings 2a/2b: happy-dom cannot evaluate real CSS layout at all (this
// file's own header comment), so the dock-aware maximum, the legacy-width
// regression, and the reclamp-on-viewport-resize behavior can only be proven
// here, against genuine `.main-row` geometry.
test.describe('docked right-inspector dock-aware width (#586 findings 2a/2b)', () => {
  test('maximum: an oversized preferred width is clamped to protect the centre surface, not just 92vw', async ({ page }) => {
    await open(page); // 1280x800
    await page.evaluate(() => window.__setRightInspectorPx(5000));
    const mounted = await page.evaluate(() => window.__openInspector());
    expect(mounted).toBe(true);

    const queryHost = page.locator('.query-host');
    const inspectorHost = page.locator('.inspector-host');
    const queryBox = await queryHost.boundingBox();
    const inspectorBox = await inspectorHost.boundingBox();

    // The OLD clampDrawerWidth alone would have let this claim ~92% of 1280
    // (≈1178px), leaving the centre surface a sliver. The dock-aware ceiling
    // instead reserves real room for `.query-host` beside the sidebar/handles.
    expect(inspectorBox.width).toBeLessThan(1280 * 0.92);
    expect(queryBox.width).toBeGreaterThan(200);

    test.info().annotations.push(
      { type: 'query-host width (oversized preference)', description: String(queryBox.width) },
      { type: 'inspector-host width (oversized preference)', description: String(inspectorBox.width) },
    );
  });

  test('legacy width: a modest persisted preference applies unclamped (no spurious shrink)', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__setRightInspectorPx(420));
    await page.evaluate(() => window.__openInspector());
    const box = await page.locator('.inspector-host').boundingBox();
    expect(Math.round(box.width)).toBe(420);
  });

  // 900px is deliberately ABOVE `MOBILE_BREAKPOINT_PX` (768, state.ts) — below
  // it `.inspector-host` switches to the full-screen `position: fixed; inset:
  // 0` mobile presentation (styles.css, explicitly out of scope for this fix,
  // see this file's own note on #586's fourth, deferred finding), which would
  // make any width assertion here about that CSS rule instead of the
  // dock-aware JS clamp this test targets.
  test('viewport resize while OPEN live re-clamps the displayed width, all the way down to the shared 320 floor', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__setRightInspectorPx(500));
    await page.evaluate(() => window.__openInspector());
    const inspectorHost = page.locator('.inspector-host');
    const before = await inspectorHost.boundingBox();
    expect(Math.round(before.width)).toBe(500);

    await page.setViewportSize({ width: 900, height: 800 });
    const after = await inspectorHost.boundingBox();
    // Default sidebarPx (248) + 2 handles (14) reserved, minus CENTRE_MIN_PX
    // (320): ceiling = 900-262-320 = 318, below the shared 320 floor — clamp
    // floors it at 320 exactly.
    expect(Math.round(after.width)).toBe(320);
    expect(after.width).toBeLessThan(before.width);

    test.info().annotations.push(
      { type: 'inspector-host width before resize', description: String(before.width) },
      { type: 'inspector-host width after resize (900px viewport)', description: String(after.width) },
    );
  });

  test('viewport resize while FOLDED re-clamps before the next unfold, not the stale wide-viewport width', async ({ page }) => {
    await open(page); // 1280x800
    await page.evaluate(() => window.__setRightInspectorPx(1000));
    await page.setViewportSize({ width: 900, height: 800 });
    const mounted = await page.evaluate(() => window.__openInspector());
    expect(mounted).toBe(true);
    const box = await page.locator('.inspector-host').boundingBox();
    // 1000px would have exceeded even 92% of a 900px viewport (828px) under
    // the OLD single-clamp-at-construction behavior; must never render that
    // wide, whether the reclamp ran while folded or only at the unfold that
    // follows it. Same derivation as the previous test: ceiling floors at 320.
    expect(Math.round(box.width)).toBe(320);
  });

  test('a wider sidebar leaves proportionally less room for the inspector', async ({ page }) => {
    await open(page); // 1280x800
    await page.evaluate(() => window.__setRightInspectorPx(600));
    await page.evaluate(() => window.__openInspector());
    const narrowSidebarBox = await page.locator('.inspector-host').boundingBox();
    await page.evaluate(() => window.__closeInspector());

    await page.evaluate(() => window.__setSidebarPx(420)); // the sidebar's own max
    await page.evaluate(() => window.__openInspector());
    const wideSidebarBox = await page.locator('.inspector-host').boundingBox();

    expect(wideSidebarBox.width).toBeLessThanOrEqual(narrowSidebarBox.width);

    test.info().annotations.push(
      { type: 'inspector-host width (sidebarPx 248)', description: String(narrowSidebarBox.width) },
      { type: 'inspector-host width (sidebarPx 420)', description: String(wideSidebarBox.width) },
    );
  });
});
