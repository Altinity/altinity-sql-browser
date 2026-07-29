import { test, expect } from '@playwright/test';

const fixturePath = '/tests/e2e/oauth-document-recovery/index.html';
const fixtureChPath = '/tests/e2e/oauth-document-recovery/ch';
const checkpointKey = 'oauth_document_recovery';
const markerKey = 'oauth_document_recovery_validated_callback';

// This is intentionally Chromium-only: native beforeunload prompt delivery is
// browser-policy-sensitive, while the application-level recovery transaction is
// already covered across the unit suite. Here a real browser proves the one-shot
// OAuth navigation bypass does not weaken the next ordinary reload warning.
test.describe('OAuth document recovery redirect (#512)', () => {
  test('restores dirty authored documents through a real 401 and OIDC redirect without restoring transients', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Chromium-only native beforeunload dialog semantics');
    const dialogs = [];
    let acceptUnexpectedDialog = true;
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.type());
      // A prompt here during the OAuth redirect is the regression; accepting
      // keeps the test able to report the complete observed dialog sequence.
      if (acceptUnexpectedDialog) await dialog.accept();
    });

    await page.goto(fixturePath);
    await page.waitForFunction(() => window.__oauthRecoveryReady === true);
    expect(await page.evaluate(() => window.__oauthRecoveryInitialCatalog())).toMatchObject({
      started: true, settled: true, succeeded: true, pending: 0,
    });
    expect(await page.evaluate(() => window.__oauthRecoveryInitialDirtyGuard)).toBe(true);
    const authLossResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === fixtureChPath
      && response.status() === 401
    ));
    await page.evaluate(() => window.__oauthRecoveryTrigger401());
    await authLossResponse;
    // Recovery retains the document session, but it must not remain in the
    // shell's flex flow: that used to push the workspace below a second scroll
    // region. The authentication form is a blocking viewport overlay instead.
    const recovery = page.locator('.auth-host');
    await expect(recovery).toHaveCSS('position', 'fixed');
    await expect(recovery).toHaveCSS('z-index', '120');
    const sso = page.locator('.login-inline .login-sso .login-btn');
    await expect(sso).toHaveText('Continue with Fixture SSO');

    // The authorize route really redirects away then returns `?code&state` to
    // this page. Clear the old document's latch before clicking so this wait is
    // necessarily satisfied by the callback document, not the initial boot.
    await page.evaluate(() => { window.__oauthRecoveryReady = false; });
    // bootstrap synchronously removes callback query parameters before the
    // document's `load` event, so observe the main-frame navigation itself
    // rather than a load-state URL that is deliberately already cleaned.
    const callback = page.waitForEvent('framenavigated', (frame) => (
      frame === page.mainFrame() && frame.url().includes('code=fixture-code')
    ));
    await sso.click();
    await callback;
    await page.waitForFunction(() => window.__oauthRecoveryReady === true);

    expect(dialogs).not.toContain('beforeunload');
    const restored = await page.evaluate(() => window.__oauthRecoveryState());
    const firstRender = await page.evaluate(() => window.__oauthRecoveryFirstRender);
    const renderCount = await page.evaluate(() => window.__oauthRecoveryRenderCount());
    expect(renderCount).toBe(1);
    expect(firstRender).toEqual(restored); // bootstrap restored before first signed-in render
    expect(restored).toHaveLength(2);
    expect(restored[0]).toMatchObject({
      id: 't1', savedId: 'saved-query', sqlDraft: 'SELECT dirty saved query',
      specText: '{ invalid JSON', dirtySql: true, dirtySpec: true, editorMode: 'spec',
      specParsed: null, result: null, columns: [],
    });
    expect(restored[0].diagnostics.length).toBeGreaterThan(0); // invalid raw Spec was revalidated
    expect(restored[0].chSession).toBeUndefined();
    expect(restored[1]).toMatchObject({
      id: 't2', doc: { kind: 'dashboard-variable', dashboardId: 'dash-1', variableName: 'region' },
      sqlDraft: "SELECT 'dirty variable'", dirtySql: true,
    });
    expect(await page.evaluate((key) => sessionStorage.getItem(key), checkpointKey)).toBeNull();

    // The checkpoint bypass is one-shot. The restored dirty tabs must still
    // protect an unrelated reload with the browser's native warning.
    acceptUnexpectedDialog = false;
    const reloadDialog = page.waitForEvent('dialog');
    const reload = page.reload();
    const dialog = await reloadDialog;
    expect(dialog.type()).toBe('beforeunload');
    await dialog.accept();
    await reload;
  });

  test('retries a callback-marked checkpoint after the matching workspace becomes available on reload', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Chromium-only OAuth redirect recovery scenario');
    const dialogs = [];
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.type());
      await dialog.accept();
    });

    await page.goto(`${fixturePath}?scenario=pending`);
    await page.waitForFunction(() => window.__oauthRecoveryReady === true);
    expect(await page.evaluate(() => window.__oauthRecoveryInitialDirtyGuard)).toBe(true);

    const authLossResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === fixtureChPath && response.status() === 401
    ));
    await page.evaluate(() => window.__oauthRecoveryTrigger401());
    await authLossResponse;
    const sso = page.locator('.login-inline .login-sso .login-btn');
    await expect(sso).toHaveText('Continue with Fixture SSO');

    await page.evaluate(() => { window.__oauthRecoveryReady = false; });
    const callback = page.waitForEvent('framenavigated', (frame) => (
      frame === page.mainFrame() && frame.url().includes('code=fixture-code')
    ));
    await sso.click();
    await callback;
    await page.waitForFunction(() => window.__oauthRecoveryReady === true);

    expect(dialogs).not.toContain('beforeunload');
    expect(await page.evaluate(() => window.__oauthRecoveryWorkspaceKey())).toBeNull();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), checkpointKey)).not.toBeNull();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), markerKey)).not.toBeNull();
    expect(await page.evaluate(() => window.__oauthRecoveryState()))
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ sqlDraft: 'SELECT dirty saved query' }),
      ]));

    // Keep the same authenticated tab, but reload it on the now-authoritative
    // route. There is no callback this time: only the persisted validated marker
    // may authorize the pending recovery before the first render.
    await page.evaluate((path) => {
      window.__oauthRecoveryReady = false;
      history.replaceState(null, '', `${path}?scenario=pending&ws=recovery-workspace`);
    }, fixturePath);
    await page.reload();
    await page.waitForFunction(() => window.__oauthRecoveryReady === true);

    expect(await page.evaluate(() => window.__oauthRecoveryWorkspaceKey())).toBe('recovery-workspace');
    const restored = await page.evaluate(() => window.__oauthRecoveryState());
    expect(await page.evaluate(() => window.__oauthRecoveryFirstRender)).toEqual(restored);
    expect(await page.evaluate(() => window.__oauthRecoveryRenderCount())).toBe(1);
    expect(restored).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 't1', sqlDraft: 'SELECT dirty saved query', specText: '{ invalid JSON',
        dirtySql: true, dirtySpec: true,
      }),
      expect.objectContaining({
        id: 't2', doc: {
          kind: 'dashboard-variable', dashboardId: 'dash-1', variableName: 'region',
        },
        sqlDraft: "SELECT 'dirty variable'", dirtySql: true,
      }),
    ]));
    expect(await page.evaluate((key) => sessionStorage.getItem(key), checkpointKey)).toBeNull();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), markerKey)).toBeNull();
  });

  test('leaves a valid checkpoint inert on token boot when no callback marker exists', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Chromium-only recovery fixture');
    await page.goto(`${fixturePath}?scenario=inert`);
    await page.waitForFunction(() => window.__oauthRecoveryReady === true);

    const state = await page.evaluate(() => window.__oauthRecoveryState());
    expect(state).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ sqlDraft: 'SELECT inert checkpoint must not restore' }),
    ]));
    expect(await page.evaluate(() => window.__oauthRecoveryFirstRender)).toEqual(state);
    expect(await page.evaluate(() => window.__oauthRecoveryRenderCount())).toBe(1);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), checkpointKey)).not.toBeNull();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), markerKey)).toBeNull();
  });
});
