import { describe, it, expect, vi } from 'vitest';
import { bootstrap } from '../../src/main.js';

function jwt(payload) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'RS256' })}.${b(payload)}.sig`;
}
const valid = jwt({ email: 'me@x.com', exp: Math.floor(Date.now() / 1000) + 3600 });

function fakeApp(over = {}) {
  return {
    token: null,
    state: { tabs: [{ id: 't1', sql: '', name: 'Untitled' }] },
    loadConfig: vi.fn(async () => ({ clientId: 'c', tokenUri: 'https://t', clientSecret: '' })),
    ensureConfig: vi.fn(async () => ({})),
    setTokens: vi.fn(function (id) { this.token = id; }),
    renderApp: vi.fn(),
    showLogin: vi.fn(),
    isSignedIn: vi.fn(() => false),
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

  it('seeds the first tab from a share-link hash (and stashes it for login)', async () => {
    const app = fakeApp();
    const sql = 'SELECT 1';
    const hash = '#' + btoa(unescape(encodeURIComponent(sql)));
    const env = fakeEnv({ location: { href: 'https://ch/sql' + hash, origin: 'https://ch', pathname: '/sql', search: '', hash } });
    await bootstrap(app, env);
    expect(app.state.tabs[0].sql).toBe('SELECT 1');
    expect(app.state.tabs[0].name).toBe('Shared query');
    expect(env.sessionStorage.getItem('oauth_shared_sql')).toBe('SELECT 1'); // survives a login redirect
  });

  it('restores a shared query from sessionStorage after the OAuth round-trip', async () => {
    // The hash is gone after the IdP redirect; the stash carries it through.
    const app = fakeApp({ token: valid, isSignedIn: () => true });
    const env = fakeEnv({ location: { href: 'https://ch/sql', origin: 'https://ch', pathname: '/sql', search: '', hash: '' } });
    env.sessionStorage.setItem('oauth_shared_sql', 'SELECT 42');
    await bootstrap(app, env);
    expect(app.state.tabs[0].sql).toBe('SELECT 42');
    expect(app.state.tabs[0].name).toBe('Shared query');
    expect(app.renderApp).toHaveBeenCalled();
    expect(env.sessionStorage.getItem('oauth_shared_sql')).toBeNull(); // consumed on render
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
