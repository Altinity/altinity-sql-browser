import { describe, it, expect, vi } from 'vitest';
import { bootstrap } from '../../src/main.js';
import { newTabObj, tabPanel } from '../../src/state.js';
import { signal } from '@preact/signals-core';

function jwt(payload) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'RS256' })}.${b(payload)}.sig`;
}
const valid = jwt({ email: 'me@x.com', exp: Math.floor(Date.now() / 1000) + 3600 });

function fakeApp(over = {}) {
  return {
    token: null,
    state: {
      tabs: signal([newTabObj('t1')]),
      resultView: signal('table'),
    },
    loadConfig: vi.fn(async () => ({ clientId: 'c', tokenUri: 'https://t', clientSecret: '' })),
    ensureConfig: vi.fn(async () => ({})),
    setTokens: vi.fn(function (id) { this.token = id; }),
    renderApp: vi.fn(),
    renderDashboard: vi.fn(),
    receiveAuthHandoff: vi.fn(async () => false),
    ensureFreshToken: vi.fn(async () => false),
    showLogin: vi.fn(),
    // Default mirrors the real controller: signed in iff a token is held.
    // Tests that exercise a basic session override this directly.
    isSignedIn() { return !!this.token; },
    ...over,
  };
}

function fakeEnv(over = {}) {
  return {
    location: { href: 'https://ch/sql', origin: 'https://ch', pathname: '/sql', search: '', hash: '' },
    sessionStorage: { _m: new Map(), getItem(k) { return this._m.get(k) ?? null; }, setItem(k, v) { this._m.set(k, v); }, removeItem(k) { this._m.delete(k); } },
    history: { replaceState: vi.fn() },
    fetch: vi.fn(),
    ...over,
  };
}

describe('bootstrap', () => {
  it('renders login when there is no token', async () => {
    const app = fakeApp();
    const out = await bootstrap(app, fakeEnv());
    expect(app.showLogin).toHaveBeenCalledWith(null);
    expect(out.signedIn).toBe(false);
  });

  it('renders the app when already signed in', async () => {
    const app = fakeApp({ token: valid, isSignedIn: () => true });
    await bootstrap(app, fakeEnv());
    expect(app.renderApp).toHaveBeenCalled();
  });

  it('renders the app for a restored basic session (no token)', async () => {
    // A credentials session has no OAuth token; isSignedIn() carries it.
    const app = fakeApp({ token: null, isSignedIn: () => true });
    const out = await bootstrap(app, fakeEnv());
    expect(app.ensureConfig).toHaveBeenCalled();
    expect(app.renderApp).toHaveBeenCalled();
    expect(out.signedIn).toBe(true);
  });

  it('exchanges the OAuth code on a valid callback', async () => {
    const app = fakeApp();
    const env = fakeEnv({
      location: { href: 'https://ch/sql?code=abc&state=st', origin: 'https://ch', pathname: '/sql', search: '?code=abc&state=st', hash: '' },
      fetch: vi.fn(async () => ({ ok: true, json: async () => ({ id_token: valid }), text: async () => '' })),
    });
    env.sessionStorage.setItem('oauth_state', 'st');
    env.sessionStorage.setItem('oauth_verifier', 'v');
    await bootstrap(app, env);
    expect(app.setTokens).toHaveBeenCalledWith(valid, undefined);
    expect(env.history.replaceState).toHaveBeenCalled();
    expect(app.renderApp).toHaveBeenCalled();
  });

  it('reports a CSRF state mismatch', async () => {
    const app = fakeApp();
    const env = fakeEnv({
      location: { href: 'https://ch/sql?code=abc&state=evil', origin: 'https://ch', pathname: '/sql', search: '?code=abc&state=evil', hash: '' },
    });
    env.sessionStorage.setItem('oauth_state', 'expected');
    await bootstrap(app, env);
    expect(app.showLogin).toHaveBeenCalledWith('OAuth state mismatch — please try again.');
  });

  it('surfaces an IdP error callback with its description', async () => {
    const app = fakeApp();
    const env = fakeEnv({
      location: { href: 'https://ch/sql?error=access_denied&error_description=User+denied', origin: 'https://ch', pathname: '/sql', search: '?error=access_denied&error_description=User+denied', hash: '' },
    });
    await bootstrap(app, env);
    expect(app.showLogin).toHaveBeenCalledWith('Sign-in failed: User denied');
    expect(env.history.replaceState).toHaveBeenCalled();
    expect(app.renderApp).not.toHaveBeenCalled();
  });

  it('falls back to the error code when no description is given', async () => {
    const app = fakeApp();
    const env = fakeEnv({
      location: { href: 'https://ch/sql?error=access_denied', origin: 'https://ch', pathname: '/sql', search: '?error=access_denied', hash: '' },
    });
    await bootstrap(app, env);
    expect(app.showLogin).toHaveBeenCalledWith('Sign-in failed: access_denied');
  });

  it('reports a token-exchange failure', async () => {
    const app = fakeApp();
    const env = fakeEnv({
      location: { href: 'https://ch/sql?code=abc&state=st', origin: 'https://ch', pathname: '/sql', search: '?code=abc&state=st', hash: '' },
      fetch: vi.fn(async () => ({ ok: false, text: async () => 'denied' })),
    });
    env.sessionStorage.setItem('oauth_state', 'st');
    await bootstrap(app, env);
    expect(app.showLogin).toHaveBeenCalledWith(expect.stringContaining('OAuth token exchange failed'));
  });

  it('errors when the token response has no bearer', async () => {
    const app = fakeApp();
    const env = fakeEnv({
      location: { href: 'https://ch/sql?code=abc&state=st', origin: 'https://ch', pathname: '/sql', search: '?code=abc&state=st', hash: '' },
      fetch: vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => '{}' })),
    });
    env.sessionStorage.setItem('oauth_state', 'st');
    await bootstrap(app, env);
    expect(app.showLogin).toHaveBeenCalledWith(expect.stringContaining('missing bearer token'));
  });

  it('stringifies a non-Error thrown during exchange', async () => {
    const app = fakeApp({ loadConfig: vi.fn(async () => { throw 'plain failure'; }) });
    const env = fakeEnv({
      location: { href: 'https://ch/sql?code=abc&state=st', origin: 'https://ch', pathname: '/sql', search: '?code=abc&state=st', hash: '' },
    });
    env.sessionStorage.setItem('oauth_state', 'st');
    await bootstrap(app, env);
    expect(app.showLogin).toHaveBeenCalledWith('OAuth token exchange failed: plain failure');
  });

  it('seeds the first tab from a legacy (SQL-only) share-link hash', async () => {
    const app = fakeApp();
    const sql = 'SELECT 1';
    const hash = '#' + btoa(unescape(encodeURIComponent(sql)));
    const env = fakeEnv({ location: { href: 'https://ch/sql' + hash, origin: 'https://ch', pathname: '/sql', search: '', hash } });
    await bootstrap(app, env);
    expect(app.state.tabs.value[0].sqlDraft).toBe('SELECT 1');
    expect(app.state.tabs.value[0].name).toBe('Shared query');
    expect(tabPanel(app.state.tabs.value[0])).toBeNull();
    expect(JSON.parse(env.sessionStorage.getItem('oauth_shared'))).toEqual({
      sql: 'SELECT 1', specVersion: 1, spec: { name: 'Shared query', favorite: false },
    });
  });

  it('seeds SQL + chart config from a tagged share-link hash', async () => {
    const app = fakeApp();
    const chart = { cfg: { type: 'pie', x: 0, y: [1], series: null }, key: 'a:String|b:UInt64' };
    const hash = '#' + btoa(unescape(encodeURIComponent(JSON.stringify({ __asb: 1, sql: 'SELECT a, b FROM t', chart }))));
    const env = fakeEnv({ location: { href: 'https://ch/sql' + hash, origin: 'https://ch', pathname: '/sql', search: '', hash } });
    await bootstrap(app, env);
    expect(app.state.tabs.value[0].sqlDraft).toBe('SELECT a, b FROM t');
    expect(tabPanel(app.state.tabs.value[0])).toEqual(chart);
    expect(tabPanel(app.state.tabs.value[0])).not.toBe(chart); // cloned, not aliased
  });

  it('seeds a text panel from a share link with EMPTY SQL (#166 — the gate is sql || panel)', async () => {
    const app = fakeApp();
    const panel = { cfg: { type: 'text', content: '# Note' } };
    const hash = '#' + btoa(unescape(encodeURIComponent(JSON.stringify({ __asb: 1, sql: '', panel }))));
    const env = fakeEnv({ location: { href: 'https://ch/sql' + hash, origin: 'https://ch', pathname: '/sql', search: '', hash } });
    await bootstrap(app, env);
    expect(app.state.tabs.value[0].name).toBe('Shared query');
    expect(app.state.tabs.value[0].sqlDraft).toBe('');
    expect(tabPanel(app.state.tabs.value[0])).toEqual(panel);
    expect(app.state.resultView.value).toBe('panel');
    expect(JSON.parse(env.sessionStorage.getItem('oauth_shared'))).toEqual({
      sql: '', specVersion: 1,
      spec: { name: 'Shared query', favorite: false, panel },
    });
  });

  // v2 share hash: { __asb: 2, query: { sql, specVersion, spec } } (src/core/share.js).
  const v2Hash = (query) => '#' + btoa(unescape(encodeURIComponent(JSON.stringify({
    __asb: 2, query: { specVersion: 1, spec: { name: 'Shared query', favorite: false }, ...query },
  }))));
  const v2Env = (query) => {
    const hash = v2Hash(query);
    return fakeEnv({ location: { href: 'https://ch/sql' + hash, origin: 'https://ch', pathname: '/sql', search: '', hash } });
  };

  it('opens Filter for a v2 share carrying Filter-role SQL, before any run is possible (#244)', async () => {
    const app = fakeApp();
    const env = v2Env({ sql: 'SELECT 1', spec: { name: 'Shared query', favorite: false, dashboard: { role: 'filter' } } });
    await bootstrap(app, env);
    expect(app.state.tabs.value[0].sqlDraft).toBe('SELECT 1');
    expect(app.state.resultView.value).toBe('filter');
  });

  it('Filter role wins over a dormant persisted view:"panel" carried in a share (#244)', async () => {
    const app = fakeApp();
    const panelCfg = { cfg: { type: 'kpi' } };
    const env = v2Env({
      sql: 'SELECT 1',
      spec: { name: 'Shared query', favorite: false, view: 'panel', dashboard: { role: 'filter' }, panel: panelCfg },
    });
    await bootstrap(app, env);
    expect(app.state.resultView.value).toBe('filter');
    // dormant Panel state and the persisted view survive untouched in the tab's Spec.
    expect(app.state.tabs.value[0].specParsed.view).toBe('panel');
    expect(app.state.tabs.value[0].specParsed.panel).toEqual(panelCfg);
  });

  it('restores a SQL-bearing shared Panel query\'s persisted view:"panel" (no role)', async () => {
    const app = fakeApp();
    const panelCfg = { cfg: { type: 'kpi' } };
    const env = v2Env({ sql: 'SELECT 1', spec: { name: 'Shared query', favorite: false, view: 'panel', panel: panelCfg } });
    await bootstrap(app, env);
    expect(app.state.resultView.value).toBe('panel');
  });

  it.each(['table', 'json'])('restores a SQL-bearing shared query\'s persisted %s preference', async (view) => {
    const app = fakeApp();
    const env = v2Env({ sql: 'SELECT 1', spec: { name: 'Shared query', favorite: false, view } });
    await bootstrap(app, env);
    expect(app.state.resultView.value).toBe(view);
  });

  it('leaves the default result view alone for a share with no role and no persisted view', async () => {
    const app = fakeApp();
    const env = v2Env({ sql: 'SELECT 1' });
    await bootstrap(app, env);
    expect(app.state.resultView.value).toBe('table'); // fakeApp()'s untouched default
  });

  it('restores Filter for a Filter-role share stashed through the OAuth round-trip (#244)', async () => {
    const app = fakeApp({ token: valid, isSignedIn: () => true });
    const env = fakeEnv({ location: { href: 'https://ch/sql', origin: 'https://ch', pathname: '/sql', search: '', hash: '' } });
    env.sessionStorage.setItem('oauth_shared', JSON.stringify({
      sql: 'SELECT 1', specVersion: 1, spec: { name: 'Shared query', favorite: false, dashboard: { role: 'filter' } },
    }));
    await bootstrap(app, env);
    expect(app.state.resultView.value).toBe('filter');
  });

  it('maps a legacy persisted view:"chart" through the Panel compatibility path in a share', async () => {
    const app = fakeApp();
    const panelCfg = { cfg: { type: 'pie', x: 0, y: [1], series: null } };
    const env = v2Env({ sql: 'SELECT 1', spec: { name: 'Shared query', favorite: false, view: 'chart', panel: panelCfg } });
    await bootstrap(app, env);
    expect(app.state.resultView.value).toBe('panel');
  });

  it('never persists a transient view:"filter" into the restored tab Spec (#244)', async () => {
    const app = fakeApp();
    const env = v2Env({ sql: 'SELECT 1', spec: { name: 'Shared query', favorite: false, dashboard: { role: 'filter' } } });
    await bootstrap(app, env);
    expect(app.state.tabs.value[0].specParsed.view).toBeUndefined();
  });

  it('restores a shared query (SQL + chart) from sessionStorage after the OAuth round-trip', async () => {
    // The hash is gone after the IdP redirect; the stash carries it through.
    const app = fakeApp({ token: valid, isSignedIn: () => true });
    const env = fakeEnv({ location: { href: 'https://ch/sql', origin: 'https://ch', pathname: '/sql', search: '', hash: '' } });
    const chart = { cfg: {
      type: 'line', x: 0, y: [1], series: null,
      style: { curve: 'smooth', points: 'hide', extension: { dense: true } },
    }, key: 'k' };
    env.sessionStorage.setItem('oauth_shared', JSON.stringify({ sql: 'SELECT 42', chart }));
    await bootstrap(app, env);
    expect(app.state.tabs.value[0].sqlDraft).toBe('SELECT 42');
    expect(app.state.tabs.value[0].name).toBe('Shared query');
    expect(tabPanel(app.state.tabs.value[0])).toEqual(chart);
    expect(app.renderApp).toHaveBeenCalled();
    expect(env.sessionStorage.getItem('oauth_shared')).toBeNull(); // consumed on render
  });

  it('falls back to no shared query when the sessionStorage stash is corrupt', async () => {
    const app = fakeApp({ token: valid, isSignedIn: () => true });
    const env = fakeEnv({ location: { href: 'https://ch/sql', origin: 'https://ch', pathname: '/sql', search: '', hash: '' } });
    env.sessionStorage.setItem('oauth_shared', '{not json');
    await bootstrap(app, env);
    expect(app.state.tabs.value[0].sqlDraft).toBe('');
    expect(app.state.tabs.value[0].name).toBe('Untitled');
  });

  const dashLoc = (over = {}) => ({ href: 'https://ch/sql/dashboard', origin: 'https://ch', pathname: '/sql/dashboard', search: '', hash: '', ...over });

  it('renders the dashboard when signed in on the /sql/dashboard route', async () => {
    const app = fakeApp({ token: valid, isSignedIn: () => true });
    await bootstrap(app, fakeEnv({ location: dashLoc() }));
    expect(app.renderDashboard).toHaveBeenCalled();
    expect(app.renderApp).not.toHaveBeenCalled();
  });

  it('attempts the auth handoff, then renders the dashboard once it signs the tab in', async () => {
    const app = fakeApp();
    app.receiveAuthHandoff = vi.fn(async () => { app.token = valid; return true; });
    const env = fakeEnv({ location: dashLoc(), opener: { postMessage: vi.fn() } });
    await bootstrap(app, env);
    expect(app.receiveAuthHandoff).toHaveBeenCalledWith(env);
    expect(app.renderDashboard).toHaveBeenCalled();
    expect(app.showLogin).not.toHaveBeenCalled();
  });

  it('falls back to login on a cold dashboard visit with no handoff', async () => {
    const app = fakeApp();
    await bootstrap(app, fakeEnv({ location: dashLoc() }));
    expect(app.receiveAuthHandoff).toHaveBeenCalled();
    expect(app.ensureFreshToken).toHaveBeenCalled(); // tried a refresh before giving up
    expect(app.showLogin).toHaveBeenCalledWith(null);
    expect(app.renderDashboard).not.toHaveBeenCalled();
  });

  it('refreshes an expired handed-off token before falling back to login', async () => {
    // The handoff applies an expired id_token (isSignedIn() still false); a
    // refresh via ensureFreshToken recovers a valid one, so we render — not login.
    const app = fakeApp({ isSignedIn() { return this.token === valid; } });
    app.receiveAuthHandoff = vi.fn(async () => { app.token = 'expired'; return true; });
    app.ensureFreshToken = vi.fn(async () => { app.token = valid; return true; });
    await bootstrap(app, fakeEnv({ location: dashLoc(), opener: { postMessage: vi.fn() } }));
    expect(app.ensureFreshToken).toHaveBeenCalled();
    expect(app.renderDashboard).toHaveBeenCalled();
    expect(app.showLogin).not.toHaveBeenCalled();
  });

  it('skips editor share-link seeding on the dashboard route', async () => {
    const app = fakeApp({ token: valid, isSignedIn: () => true });
    const sql = 'SELECT 1';
    const hash = '#' + btoa(unescape(encodeURIComponent(sql)));
    await bootstrap(app, fakeEnv({ location: dashLoc({ href: 'https://ch/sql/dashboard' + hash, hash }) }));
    expect(app.state.tabs.value[0].sqlDraft).toBe(''); // not seeded — dashboard has no editor tab
    expect(app.renderDashboard).toHaveBeenCalled();
  });

  it('preserves extra query params while stripping oauth ones', async () => {
    const app = fakeApp({ token: valid, isSignedIn: () => true });
    const env = fakeEnv({
      location: { href: 'https://ch/sql?code=c&state=st&keep=1', origin: 'https://ch', pathname: '/sql', search: '?code=c&state=st&keep=1', hash: '' },
      fetch: vi.fn(async () => ({ ok: true, json: async () => ({ id_token: valid, refresh_token: 'r' }), text: async () => '' })),
    });
    env.sessionStorage.setItem('oauth_state', 'st');
    env.sessionStorage.setItem('oauth_verifier', 'v');
    await bootstrap(app, env);
    const url = env.history.replaceState.mock.calls[0][2];
    expect(url).toContain('keep=1');
    expect(url).not.toContain('code=');
  });
});
