import { describe, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createConnectionSession } from '../../src/application/connection-session.js';
import type { ConnectionSessionDeps, SessionStorageLike } from '../../src/application/connection-session.js';
import type {
  AuthenticatedCancellationLease,
  ChCtx,
  queryJson,
} from '../../src/net/ch-client.js';
import { jwt, memStorage } from '../helpers/auth-fixtures.js';

// ── Fakes / helpers ──────────────────────────────────────────────────────────

const nowSec = (): number => Math.floor(Date.now() / 1000);
const validToken = jwt({ email: 'me@example.com', exp: nowSec() + 3600 });
// Expires within getToken's default 60s skew but NOT within isSignedIn's zero
// skew — the one token that tells the two checks apart.
const expiringSoonToken = jwt({ email: 'soon@example.com', exp: nowSec() + 30 });
const expiredToken = jwt({ email: 'gone@example.com', exp: nowSec() - 10 });

// `memStorage` comes from tests/helpers/auth-fixtures.ts — its MemStorage
// shape structurally satisfies the session's SessionStorageLike.
const _storageTypeCheck: SessionStorageLike = memStorage();
void _storageTypeCheck;

interface FakeResponse { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }
function jsonResponse(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type RouteFn = (url: string, init?: RequestInit) => FakeResponse | null | Promise<FakeResponse | null>;

// One shared config.json doc: 'g' is a default (bearer) IdP; 'basicidp' maps
// ch_auth=basic with a custom basic_user_claim, for the chUsername/authHeader
// basic-mode tests.
const CONFIG_DOC_RAW = {
  idps: [
    { id: 'g', issuer: 'https://issuer.example', client_id: 'cid-g' },
    { id: 'basicidp', issuer: 'https://issuer2.example', client_id: 'cid-b', ch_auth: 'basic', basic_user_claim: 'nickname' },
  ],
  basic_login: true,
};

/** Routes config.json + OIDC discovery generically; extra `routes` (e.g. a
 * scripted token endpoint) are checked first so a test can override/extend
 * the defaults. */
function makeFetch(routes: RouteFn[] = []): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit): Promise<FakeResponse> => {
    calls.push(url);
    for (const r of routes) {
      const resp = await r(url, init);
      if (resp) return resp;
    }
    if (url.endsWith('/config.json')) return jsonResponse(200, CONFIG_DOC_RAW);
    if (url.includes('/.well-known/openid-configuration')) {
      const issuer = url.replace(/\/\.well-known.*/, '');
      return jsonResponse(200, { authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token' });
    }
    return jsonResponse(404, {});
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

type QueryJsonFn = typeof queryJson;
/** A queued `queryJson` fake for the Basic-auth probe — `connectBasic` only
 * ever calls it with `(ctx, 'SELECT 1')`. */
function fakeQueryJson(impl: (ctx: ChCtx, sql: string) => Promise<unknown>): QueryJsonFn {
  return (async (ctx: ChCtx, sql: string) => impl(ctx, sql)) as unknown as QueryJsonFn;
}

interface SetupOpts {
  storage?: SessionStorageLike;
  location?: { origin: string; pathname: string; search: string; href: string };
  routes?: RouteFn[];
  queryJson?: QueryJsonFn;
  onAuthLost?: ConnectionSessionDeps['onAuthLost'];
  prepareOAuthRedirect?: ConnectionSessionDeps['prepareOAuthRedirect'];
  armOAuthRedirectUnloadBypass?: ConnectionSessionDeps['armOAuthRedirectUnloadBypass'];
  clearOAuthDocumentRecovery?: ConnectionSessionDeps['clearOAuthDocumentRecovery'];
}
function setup(opts: SetupOpts = {}) {
  const fetchMock = makeFetch(opts.routes || []);
  const storage = opts.storage || memStorage();
  const onAuthLost = opts.onAuthLost || vi.fn();
  const location = opts.location || { origin: 'https://ch.example', pathname: '/sql', search: '', href: 'https://ch.example/sql' };
  const deps: ConnectionSessionDeps = {
    fetch: fetchMock.fn,
    storage,
    location,
    // Explicit `node:crypto` webcrypto, NOT ambient `globalThis.crypto` — a
    // sibling spec stubbing the global (or a differently-ordered aggregation
    // where it's undefined at setup() time) must not break PKCE here.
    crypto: webcrypto,
    queryJson: opts.queryJson || fakeQueryJson(async () => ({ data: [{ 1: 1 }] })),
    onAuthLost,
    prepareOAuthRedirect: opts.prepareOAuthRedirect,
    armOAuthRedirectUnloadBypass: opts.armOAuthRedirectUnloadBypass,
    clearOAuthDocumentRecovery: opts.clearOAuthDocumentRecovery,
  };
  return { deps, storage, location, fetchMock, onAuthLost, session: createConnectionSession(deps) };
}

// ── construction seeding ─────────────────────────────────────────────────────

describe('construction seeding', () => {
  it('restores an OAuth session from sessionStorage', () => {
    const { session } = setup({ storage: memStorage({ oauth_id_token: validToken, oauth_refresh_token: 'r0' }) });
    expect(session.authMode()).toBe('oauth');
    expect(session.token()).toBe(validToken);
    expect(session.refreshToken()).toBe('r0');
  });

  it('restores a basic session (authMode + chCtx.origin) from sessionStorage', () => {
    const { session } = setup({
      storage: memStorage({ ch_basic_auth: 'YWJj', ch_basic_user: 'bob', ch_basic_origin: 'https://other.example' }),
    });
    expect(session.authMode()).toBe('basic');
    expect(session.chCtx.origin).toBe('https://other.example');
  });

  it('falls back to the serving origin when a basic session has no ch_basic_origin', () => {
    const { session, location } = setup({ storage: memStorage({ ch_basic_auth: 'YWJj' }) });
    expect(session.chCtx.origin).toBe(location.origin);
  });

  it('falls back to the serving origin for oauth when no oauth_origin is stashed', () => {
    const { session, location } = setup({ storage: memStorage({ oauth_id_token: validToken }) });
    expect(session.chCtx.origin).toBe(location.origin);
  });

  it('restores a stashed cross-cluster oauth_origin', () => {
    const { session } = setup({ storage: memStorage({ oauth_id_token: validToken, oauth_origin: 'https://cluster.example' }) });
    expect(session.chCtx.origin).toBe('https://cluster.example');
  });

  it('restores the persisted idpId', () => {
    const { session } = setup({ storage: memStorage({ oauth_idp: 'g' }) });
    expect(session.idpId()).toBe('g');
  });

  it('uses the unified /sql pathname as basePath', () => {
    const { session } = setup({ location: { origin: 'https://ch.example', pathname: '/sql/', search: '?surface=dashboard', href: '' } });
    expect(session.basePath).toBe('/sql');
  });

  it('reads hostHint from ?host=', () => {
    const { session } = setup({ location: { origin: 'https://ch.example', pathname: '/sql', search: '?host=myhost%3A9000', href: '' } });
    expect(session.hostHint).toBe('myhost:9000');
  });

  it('defaults chAuth to bearer and basicUserClaim to empty before any config load', () => {
    const { session } = setup();
    expect(session.chAuth()).toBe('bearer');
    expect(session.basicUserClaim()).toBe('');
  });

  it('starts restored credentials in starting and an empty session signed out', () => {
    const { session: restored } = setup({ storage: memStorage({ oauth_id_token: validToken }) });
    const { session: empty } = setup();
    expect(restored.connection.value).toEqual({ kind: 'starting', epoch: 0 });
    expect(empty.connection.value).toEqual({ kind: 'signed-out', epoch: 0 });
    expect(restored.chCtx.currentEpoch()).toBe(0);
  });
});

describe('connection lifecycle ownership', () => {
  it('uses empty Basic storage as an empty display identity and never refreshes Basic credentials', async () => {
    const { session } = setup({ storage: memStorage({ ch_basic_auth: 'YWJj' }) });
    expect(session.email()).toBe('');
    await expect(session.chCtx.refresh()).resolves.toBe(false);
  });

  it('publishes only transport settlements as connected/offline', () => {
    const { session } = setup({ storage: memStorage({ oauth_id_token: validToken }) });
    session.chCtx.onTransportConnected();
    expect(session.connection.value).toEqual({ kind: 'connected', epoch: 0 });
    session.chCtx.onTransportOffline(new TypeError('network'));
    expect(session.connection.value).toEqual({ kind: 'offline', epoch: 0, detail: 'Network unavailable' });
    session.chCtx.onTransportConnected();
    expect(session.connection.value).toEqual({ kind: 'connected', epoch: 0 });
  });

  it('installs and explicitly removes credential scopes in new epochs', () => {
    const { session } = setup();
    session.setTokens(validToken, 'r1');
    expect(session.connection.value).toEqual({ kind: 'starting', epoch: 1 });
    expect(session.chCtx.currentEpoch()).toBe(1);
    session.signOut();
    expect(session.connection.value).toEqual({ kind: 'signed-out', epoch: 2 });
  });

  it('invalidates involuntary auth loss once and reports it once', () => {
    const { session, onAuthLost } = setup({ storage: memStorage({ oauth_id_token: validToken }) });
    session.chCtx.onTransportConnected();
    session.chCtx.onSignedOut('expired by IdP');
    expect(session.connection.value).toEqual({ kind: 'auth-required', epoch: 1, detail: 'expired by IdP' });
    expect(session.token()).toBeNull();
    expect(onAuthLost).toHaveBeenCalledTimes(1);
    session.chCtx.onSignedOut('duplicate');
    expect(session.connection.value).toEqual({ kind: 'auth-required', epoch: 1, detail: 'expired by IdP' });
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  it('ignores auth loss captured by an older credential epoch', () => {
    const { session, onAuthLost } = setup({ storage: memStorage({ oauth_id_token: validToken }) });
    const oldEpoch = session.chCtx.currentEpoch();
    session.setTokens('replacement-token');
    session.chCtx.onSignedOut('stale failure', oldEpoch);
    expect(session.token()).toBe('replacement-token');
    expect(session.connection.value).toEqual({ kind: 'starting', epoch: oldEpoch + 1 });
    expect(onAuthLost).not.toHaveBeenCalled();
  });
});

// ── isSignedIn (zero skew) vs getToken (default skew) ───────────────────────

describe('isSignedIn vs getToken skew', () => {
  it('isSignedIn is true and getToken refreshes for a token expiring within 60s but not yet', async () => {
    const { session, storage, fetchMock } = setup({
      storage: memStorage({ oauth_id_token: expiringSoonToken, oauth_refresh_token: 'r0' }),
      routes: [(url) => (url.endsWith('/token') ? jsonResponse(200, { id_token: 'refreshed-token', refresh_token: 'r1' }) : null)],
    });
    expect(session.isSignedIn()).toBe(true);
    const tok = await session.getToken();
    expect(tok).toBe('refreshed-token');
    expect(storage.getItem('oauth_id_token')).toBe('refreshed-token');
    expect(fetchMock.calls.some((u) => u.endsWith('/token'))).toBe(true);
  });

  it('isSignedIn is false with no token, and false once a token is fully expired', () => {
    const { session: noToken } = setup();
    expect(noToken.isSignedIn()).toBe(false);
    const { session: expired } = setup({ storage: memStorage({ oauth_id_token: expiredToken }) });
    expect(expired.isSignedIn()).toBe(false);
  });

  it('isSignedIn reads basic creds directly', () => {
    const { session } = setup({ storage: memStorage({ ch_basic_auth: 'YWJj' }) });
    expect(session.isSignedIn()).toBe(true);
  });

  it('getToken returns a still-valid token directly, without refreshing', async () => {
    const { session, fetchMock } = setup({ storage: memStorage({ oauth_id_token: validToken }) });
    await expect(session.getToken()).resolves.toBe(validToken);
    expect(fetchMock.calls.some((u) => u.endsWith('/token'))).toBe(false);
  });

  it('getToken returns null with no token', async () => {
    const { session } = setup();
    await expect(session.getToken()).resolves.toBeNull();
  });

  it('getToken reads basic creds directly, in basic mode', async () => {
    const { session } = setup({ storage: memStorage({ ch_basic_auth: 'YWJj' }) });
    await expect(session.getToken()).resolves.toBe('YWJj');
  });
});

// ── email()/chUsername chain + authHeader ───────────────────────────────────

describe('email() / chUsername chain', () => {
  it('prefers email', () => {
    const { session } = setup({ storage: memStorage({ oauth_id_token: jwt({ email: 'e@x.com', preferred_username: 'pu', sub: 's', exp: nowSec() + 60 }) }) });
    expect(session.email()).toBe('e@x.com');
  });
  it('falls back to preferred_username when email is absent', () => {
    const { session } = setup({ storage: memStorage({ oauth_id_token: jwt({ preferred_username: 'pu', sub: 's', exp: nowSec() + 60 }) }) });
    expect(session.email()).toBe('pu');
  });
  it('falls back to sub when email and preferred_username are absent', () => {
    const { session } = setup({ storage: memStorage({ oauth_id_token: jwt({ sub: 's', exp: nowSec() + 60 }) }) });
    expect(session.email()).toBe('s');
  });
  it('falls back to empty string when no claim is present', () => {
    const { session } = setup({ storage: memStorage({ oauth_id_token: jwt({ exp: nowSec() + 60 }) }) });
    expect(session.email()).toBe('');
  });
  it('reads ch_basic_user in basic mode', () => {
    const { session } = setup({ storage: memStorage({ ch_basic_auth: 'YWJj', ch_basic_user: 'bob' }) });
    expect(session.email()).toBe('bob');
  });
});

describe('chCtx.authHeader', () => {
  it('basic mode sends the stored credential verbatim', () => {
    const { session } = setup({ storage: memStorage({ ch_basic_auth: 'YWJj' }) });
    expect(session.chCtx.authHeader('YWJj')).toBe('Basic YWJj');
  });
  it('bearer (default chAuth) sends Bearer <token>', () => {
    const { session } = setup({ storage: memStorage({ oauth_id_token: validToken }) });
    expect(session.chCtx.authHeader(validToken)).toBe('Bearer ' + validToken);
  });
  it('chAuth=basic sends Basic base64(chUsername:token), honouring basicUserClaim', async () => {
    const tok = jwt({ nickname: 'nicky', email: 'e@x.com', exp: nowSec() + 3600 });
    const { session } = setup({ storage: memStorage({ oauth_id_token: tok, oauth_idp: 'basicidp' }) });
    await session.ensureConfig();
    expect(session.chAuth()).toBe('basic');
    expect(session.basicUserClaim()).toBe('nickname');
    expect(session.chCtx.authHeader(tok)).toBe('Basic ' + btoa(unescape(encodeURIComponent('nicky:' + tok))));
  });
});

// ── setTokens / refresh ──────────────────────────────────────────────────────

describe('setTokens', () => {
  it('stores the id token and removes the one-shot verifier/state, without touching refresh', () => {
    const { session, storage } = setup({ storage: memStorage({ oauth_verifier: 'v', oauth_state: 's' }) });
    session.setTokens('idtok');
    expect(storage.getItem('oauth_id_token')).toBe('idtok');
    expect(storage.getItem('oauth_verifier')).toBeNull();
    expect(storage.getItem('oauth_state')).toBeNull();
    expect(session.refreshToken()).toBeNull();
  });
  it('stores the refresh token when given', () => {
    const { session, storage } = setup();
    session.setTokens('idtok2', 'reftok2');
    expect(storage.getItem('oauth_refresh_token')).toBe('reftok2');
    expect(session.refreshToken()).toBe('reftok2');
  });
});

describe('refresh (via getToken)', () => {
  it('fails without touching tokens when authMode is basic', async () => {
    const { session } = setup({ storage: memStorage({ ch_basic_auth: 'YWJj' }) });
    // basic mode short-circuits refresh() to false, but getToken itself never
    // reaches refresh() for basic mode — assert the direct behavior instead.
    await expect(session.getToken()).resolves.toBe('YWJj');
  });

  it('clears everything when the token endpoint rejects the refresh', async () => {
    const { session, storage } = setup({
      storage: memStorage({ oauth_id_token: expiredToken, oauth_refresh_token: 'r0', oauth_idp: 'g' }),
      routes: [(url) => (url.endsWith('/token') ? jsonResponse(401, {}) : null)],
    });
    session.chCtx.authConfirmed = true;
    const tok = await session.getToken();
    expect(tok).toBeNull();
    expect(session.token()).toBeNull();
    expect(session.refreshToken()).toBeNull();
    expect(session.idpId()).toBeNull();
    expect(session.authMode()).toBe('oauth');
    expect(session.chCtx.authConfirmed).toBe(false);
    for (const k of [
      'oauth_id_token', 'oauth_refresh_token', 'oauth_verifier', 'oauth_state', 'oauth_idp', 'oauth_origin',
      'ch_basic_auth', 'ch_basic_user', 'ch_basic_origin',
    ]) expect(storage.getItem(k)).toBeNull();
  });

  it('returns false when the token endpoint yields no usable bearer', async () => {
    const { session, onAuthLost } = setup({
      storage: memStorage({ oauth_id_token: expiredToken, oauth_refresh_token: 'r0' }),
      routes: [(url) => (url.endsWith('/token') ? jsonResponse(200, {}) : null)],
    });
    await expect(session.getToken()).resolves.toBeNull();
    expect(session.connection.value).toMatchObject({ kind: 'auth-required', epoch: 1 });
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  it('preserves credentials and reports offline when refresh configuration cannot load', async () => {
    const { session, storage, onAuthLost } = setup({
      storage: memStorage({ oauth_id_token: expiredToken, oauth_refresh_token: 'r0' }),
      routes: [(url) => (url.endsWith('/config.json') ? jsonResponse(500, {}) : null)],
    });
    await expect(session.getToken()).rejects.toThrow();
    expect(session.connection.value).toEqual({
      kind: 'offline', epoch: 0, detail: 'Unable to refresh session',
    });
    expect(session.token()).toBe(expiredToken);
    expect(storage.getItem('oauth_refresh_token')).toBe('r0');
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it('preserves credentials and reports offline when the IdP transport is unavailable', async () => {
    const { session, storage, onAuthLost } = setup({
      storage: memStorage({ oauth_id_token: expiredToken, oauth_refresh_token: 'r0' }),
      routes: [async (url) => {
        if (url.endsWith('/token')) throw new TypeError('network down');
        return null;
      }],
    });
    await expect(session.getToken()).rejects.toThrow('network down');
    expect(session.connection.value).toEqual({
      kind: 'offline', epoch: 0, detail: 'Unable to refresh session',
    });
    expect(session.token()).toBe(expiredToken);
    expect(storage.getItem('oauth_refresh_token')).toBe('r0');
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it('shares one refresh promise for all callers in the same epoch', async () => {
    const tokenResponse = deferred<FakeResponse>();
    let tokenCalls = 0;
    const { session } = setup({
      storage: memStorage({ oauth_id_token: expiredToken, oauth_refresh_token: 'r0' }),
      routes: [async (url) => {
        if (!url.endsWith('/token')) return null;
        tokenCalls += 1;
        return tokenResponse.promise;
      }],
    });
    const first = session.getToken();
    const second = session.getToken();
    await vi.waitFor(() => expect(tokenCalls).toBe(1));
    expect(session.connection.value.kind).toBe('refreshing');
    expect(tokenCalls).toBe(1);
    tokenResponse.resolve(jsonResponse(200, { id_token: 'shared-token', refresh_token: 'r1' }));
    await expect(Promise.all([first, second])).resolves.toEqual(['shared-token', 'shared-token']);
    expect(tokenCalls).toBe(1);
    expect(session.connection.value).toEqual({ kind: 'starting', epoch: 0 });
  });

  it('fences a late refresh after a newer credential scope is installed', async () => {
    const oldResponse = deferred<FakeResponse>();
    const { session, storage, onAuthLost } = setup({
      storage: memStorage({ oauth_id_token: expiredToken, oauth_refresh_token: 'old-refresh' }),
      routes: [async (url) => (url.endsWith('/token') ? oldResponse.promise : null)],
    });
    const oldGet = session.getToken();
    await vi.waitFor(() => expect(session.connection.value.kind).toBe('refreshing'));
    session.setTokens('new-login-token', 'new-refresh');
    const newEpoch = session.connection.value.epoch;
    oldResponse.resolve(jsonResponse(200, { id_token: 'stale-token', refresh_token: 'stale-refresh' }));
    await expect(oldGet).resolves.toBe('new-login-token');
    expect(session.connection.value).toEqual({ kind: 'starting', epoch: newEpoch });
    expect(storage.getItem('oauth_id_token')).toBe('new-login-token');
    expect(storage.getItem('oauth_refresh_token')).toBe('new-refresh');
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it('does not send a replacement refresh token when config resolves after an epoch change', async () => {
    const configResponse = deferred<FakeResponse>();
    let tokenCalls = 0;
    const { session, storage } = setup({
      storage: memStorage({ oauth_id_token: expiredToken, oauth_refresh_token: 'old-refresh' }),
      routes: [
        (url) => (url.endsWith('/config.json') ? configResponse.promise : null),
        (url) => {
          if (!url.endsWith('/token')) return null;
          tokenCalls += 1;
          return jsonResponse(200, { id_token: 'must-not-be-used' });
        },
      ],
    });
    const oldGet = session.getToken();
    await vi.waitFor(() => expect(session.connection.value.kind).toBe('refreshing'));
    session.setTokens('replacement-token', 'replacement-refresh');
    configResponse.resolve(jsonResponse(200, CONFIG_DOC_RAW));

    await expect(oldGet).resolves.toBe('replacement-token');
    expect(tokenCalls).toBe(0);
    expect(storage.getItem('oauth_id_token')).toBe('replacement-token');
    expect(storage.getItem('oauth_refresh_token')).toBe('replacement-refresh');
  });

  it('does not let an old finally clear a newer epoch refresh slot', async () => {
    const oldResponse = deferred<FakeResponse>();
    const newResponse = deferred<FakeResponse>();
    let oldCalls = 0;
    let newCalls = 0;
    const { session } = setup({
      storage: memStorage({ oauth_id_token: expiredToken, oauth_refresh_token: 'old-refresh' }),
      routes: [async (url, init) => {
        if (!url.endsWith('/token')) return null;
        const body = String(init?.body || '');
        if (body.includes('old-refresh')) {
          oldCalls += 1;
          return oldResponse.promise;
        }
        newCalls += 1;
        return newResponse.promise;
      }],
    });
    const oldGet = session.getToken();
    await vi.waitFor(() => expect(oldCalls).toBe(1));
    session.setTokens(expiredToken, 'new-refresh');
    const newGetA = session.getToken();
    await vi.waitFor(() => expect(newCalls).toBe(1));
    oldResponse.resolve(jsonResponse(200, { id_token: 'stale' }));
    await oldGet;
    const newGetB = session.getToken();
    expect(newCalls).toBe(1);
    newResponse.resolve(jsonResponse(200, { id_token: 'fresh' }));
    await expect(Promise.all([newGetA, newGetB])).resolves.toEqual(['fresh', 'fresh']);
    expect(newCalls).toBe(1);
  });
});

// ── beginOAuth ───────────────────────────────────────────────────────────────

describe('beginOAuth', () => {
  it('builds the authorize URL, stashes PKCE + state, selects the idp, redirects', async () => {
    const { session, storage, location } = setup();
    await session.beginOAuth('g', 'https://cluster.example');
    expect(session.idpId()).toBe('g');
    expect(storage.getItem('oauth_idp')).toBe('g');
    expect(storage.getItem('oauth_origin')).toBe('https://cluster.example');
    expect(storage.getItem('oauth_verifier')).toBeTruthy();
    expect(storage.getItem('oauth_state')).toBeTruthy();
    expect(JSON.parse(storage.getItem('oauth_return_route')!)).toEqual({
      state: storage.getItem('oauth_state'), search: '',
    });
    expect(location.href).not.toBe('');
    const url = new URL(location.href);
    expect(url.origin + url.pathname).toBe('https://issuer.example/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid-g');
    expect(url.searchParams.get('redirect_uri')).toBe(location.origin + location.pathname);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(storage.getItem('oauth_state'));
  });

  it('clears oauth_origin when no targetOrigin is given, and keeps the current idp selection', async () => {
    const { session, storage } = setup({ storage: memStorage({ oauth_origin: 'https://stale.example', oauth_idp: 'g' }) });
    await session.beginOAuth();
    expect(storage.getItem('oauth_origin')).toBeNull();
    expect(session.idpId()).toBe('g');
  });

  it('associates the pre-login application route with the OAuth state', async () => {
    const { session, storage } = setup({
      location: {
        origin: 'https://ch.example', pathname: '/sql',
        search: '?ws=ops&surface=dashboard&mode=view&code=stale&keep=1',
        href: 'https://ch.example/sql?ws=ops&surface=dashboard&mode=view&code=stale&keep=1',
      },
    });
    await session.beginOAuth('g');
    expect(JSON.parse(storage.getItem('oauth_return_route')!)).toEqual({
      state: storage.getItem('oauth_state'),
      search: '?ws=ops&surface=dashboard&mode=view&keep=1',
    });
  });

  it('prepares after the complete PKCE attempt is stored, but does not arm for a clean session', async () => {
    const arm = vi.fn(() => vi.fn());
    const prepare = vi.fn((state: string) => {
      const storedState = storage.getItem('oauth_state');
      expect(storedState).toBe(state);
      expect(storage.getItem('oauth_verifier')).toBeTruthy();
      expect(JSON.parse(storage.getItem('oauth_return_route')!)).toEqual({ state, search: '' });
      return false;
    });
    const { session, storage, location } = setup({
      prepareOAuthRedirect: prepare,
      armOAuthRedirectUnloadBypass: arm,
    });

    await session.beginOAuth('g');

    expect(prepare).toHaveBeenCalledWith(storage.getItem('oauth_state'));
    expect(arm).not.toHaveBeenCalled();
    expect(location.href).toContain('https://issuer.example/authorize');
  });

  it('rolls back instead of navigating when durable recovery has no unload-bypass capability', async () => {
    const storage = memStorage({
      oauth_verifier: 'previous-verifier',
      oauth_state: 'previous-state',
      oauth_return_route: 'previous-route',
    });
    const { session, location } = setup({
      storage,
      prepareOAuthRedirect: () => true,
    });

    await expect(session.beginOAuth('g')).rejects.toThrow(
      'OAuth recovery redirect requires an unload bypass',
    );

    expect(location.href).toBe('https://ch.example/sql');
    expect(storage.getItem('oauth_verifier')).toBe('previous-verifier');
    expect(storage.getItem('oauth_state')).toBe('previous-state');
    expect(storage.getItem('oauth_return_route')).toBe('previous-route');
    expect(session.connection.value).toEqual({ kind: 'signed-out', epoch: 1 });
  });

  it('arms the one-shot unload bypass immediately before assigning the OAuth redirect', async () => {
    const events: string[] = [];
    let href = 'https://ch.example/sql';
    const location = {
      origin: 'https://ch.example', pathname: '/sql', search: '',
      get href() { return href; },
      set href(value: string) { events.push('href'); href = value; },
    };
    const arm = vi.fn(() => {
      events.push('arm');
      return () => events.push('disarm');
    });
    const { session } = setup({
      location,
      prepareOAuthRedirect: () => { events.push('prepare'); return true; },
      armOAuthRedirectUnloadBypass: arm,
    });

    await session.beginOAuth('g');

    expect(events).toEqual(['prepare', 'arm', 'href']);
    expect(arm).toHaveBeenCalledTimes(1);
  });

  it('stops writing OAuth keys when a reentrant storage setter signs out', async () => {
    const backing = memStorage();
    let session!: ReturnType<typeof createConnectionSession>;
    let signedOut = false;
    const storage: SessionStorageLike = {
      getItem: backing.getItem,
      setItem: (key, value) => {
        backing.setItem(key, value);
        if (key === 'oauth_verifier' && !signedOut) {
          signedOut = true;
          session.signOut();
        }
      },
      removeItem: backing.removeItem,
    };
    const prepare = vi.fn(() => true);
    const arm = vi.fn(() => vi.fn());
    const clearOAuthDocumentRecovery = vi.fn();
    const configured = setup({
      storage,
      prepareOAuthRedirect: prepare,
      armOAuthRedirectUnloadBypass: arm,
      clearOAuthDocumentRecovery,
    });
    session = configured.session;

    await expect(session.beginOAuth('g')).rejects.toThrow('Authentication attempt superseded');

    expect(configured.location.href).toBe('https://ch.example/sql');
    expect(backing.getItem('oauth_verifier')).toBeNull();
    expect(backing.getItem('oauth_state')).toBeNull();
    expect(backing.getItem('oauth_return_route')).toBeNull();
    expect(backing.getItem('oauth_idp')).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
    expect(arm).not.toHaveBeenCalled();
    expect(clearOAuthDocumentRecovery).toHaveBeenCalledTimes(1);
    expect(session.connection.value).toEqual({ kind: 'signed-out', epoch: 2 });
  });

  it('disarms and does not navigate when the arm callback signs out reentrantly', async () => {
    let session!: ReturnType<typeof createConnectionSession>;
    const disarm = vi.fn();
    const configured = setup({
      prepareOAuthRedirect: () => true,
      armOAuthRedirectUnloadBypass: () => {
        session.signOut();
        return disarm;
      },
    });
    session = configured.session;

    await expect(session.beginOAuth('g')).rejects.toThrow('Authentication attempt superseded');

    expect(configured.location.href).toBe('https://ch.example/sql');
    expect(disarm).toHaveBeenCalledTimes(1);
    expect(configured.storage.getItem('oauth_verifier')).toBeNull();
    expect(configured.storage.getItem('oauth_state')).toBeNull();
    expect(configured.storage.getItem('oauth_return_route')).toBeNull();
    expect(session.connection.value).toEqual({ kind: 'signed-out', epoch: 2 });
  });

  it('rolls back all attempt keys and restores auth-required lifecycle when preparation fails', async () => {
    const storage = memStorage({ oauth_id_token: validToken });
    const arm = vi.fn(() => vi.fn());
    const { session, location } = setup({
      storage,
      prepareOAuthRedirect: () => { throw new Error('snapshot write failed'); },
      armOAuthRedirectUnloadBypass: arm,
    });
    session.chCtx.onSignedOut('session expired');
    storage.setItem('oauth_verifier', 'previous-verifier');
    storage.setItem('oauth_state', 'previous-state');
    storage.setItem('oauth_return_route', 'previous-route');

    await expect(session.beginOAuth('g')).rejects.toThrow('snapshot write failed');

    expect(location.href).toBe('https://ch.example/sql');
    expect(arm).not.toHaveBeenCalled();
    expect(storage.getItem('oauth_verifier')).toBe('previous-verifier');
    expect(storage.getItem('oauth_state')).toBe('previous-state');
    expect(storage.getItem('oauth_return_route')).toBe('previous-route');
    expect(session.connection.value).toEqual({ kind: 'auth-required', epoch: 2, detail: 'session expired' });
  });

  it('rolls back a partial OAuth-attempt storage write without navigating or arming', async () => {
    const backing = memStorage({
      oauth_idp: 'g', oauth_verifier: 'old-verifier', oauth_state: 'old-state', oauth_return_route: 'old-route',
    });
    const storage: SessionStorageLike = {
      getItem: backing.getItem,
      setItem: (key, value) => {
        if (key === 'oauth_state' && value !== 'old-state') throw new Error('storage full');
        backing.setItem(key, value);
      },
      removeItem: backing.removeItem,
    };
    const arm = vi.fn(() => vi.fn());
    const { session, location } = setup({ storage, armOAuthRedirectUnloadBypass: arm });

    await expect(session.beginOAuth()).rejects.toThrow('storage full');

    expect(location.href).toBe('https://ch.example/sql');
    expect(arm).not.toHaveBeenCalled();
    expect(backing.getItem('oauth_verifier')).toBe('old-verifier');
    expect(backing.getItem('oauth_state')).toBe('old-state');
    expect(backing.getItem('oauth_return_route')).toBe('old-route');
  });

  it('stops rollback after its first restore mutation reentrantly signs out', async () => {
    const backing = memStorage({
      oauth_verifier: 'old-verifier',
      oauth_state: 'old-state',
      oauth_return_route: 'old-route',
    });
    let session!: ReturnType<typeof createConnectionSession>;
    let signedOut = false;
    const storage: SessionStorageLike = {
      getItem: backing.getItem,
      setItem: (key, value) => {
        backing.setItem(key, value);
        if (key === 'oauth_verifier' && value === 'old-verifier' && !signedOut) {
          signedOut = true;
          session.signOut();
        }
      },
      removeItem: backing.removeItem,
    };
    const clearOAuthDocumentRecovery = vi.fn();
    const configured = setup({
      storage,
      prepareOAuthRedirect: () => { throw new Error('snapshot failed'); },
      clearOAuthDocumentRecovery,
    });
    session = configured.session;

    await expect(session.beginOAuth('g')).rejects.toThrow('snapshot failed');

    expect(configured.location.href).toBe('https://ch.example/sql');
    expect(backing.getItem('oauth_verifier')).toBeNull();
    expect(backing.getItem('oauth_state')).toBeNull();
    expect(backing.getItem('oauth_return_route')).toBeNull();
    expect(clearOAuthDocumentRecovery).toHaveBeenCalledTimes(1);
    expect(session.connection.value).toEqual({ kind: 'signed-out', epoch: 2 });
  });

  it('stops rollback when a restore mutation itself throws', async () => {
    const backing = memStorage({
      oauth_verifier: 'old-verifier',
      oauth_state: 'old-state',
      oauth_return_route: 'old-route',
    });
    const rollbackValues: Record<string, string> = {
      oauth_verifier: 'old-verifier',
      oauth_state: 'old-state',
      oauth_return_route: 'old-route',
    };
    const restoreAttempts: string[] = [];
    const storage: SessionStorageLike = {
      getItem: backing.getItem,
      setItem: (key, value) => {
        if (value === rollbackValues[key]) {
          restoreAttempts.push(key);
          if (key === 'oauth_verifier') throw new Error('restore blocked');
        }
        backing.setItem(key, value);
      },
      removeItem: backing.removeItem,
    };
    const { session } = setup({
      storage,
      prepareOAuthRedirect: () => { throw new Error('snapshot failed'); },
    });

    await expect(session.beginOAuth('g')).rejects.toThrow('snapshot failed');

    expect(restoreAttempts).toEqual(['oauth_verifier']);
    expect(session.connection.value).toEqual({ kind: 'signed-out', epoch: 1 });
  });

  it('does not continue stale rollback after its first restore starts a newer attempt', async () => {
    const backing = memStorage({
      oauth_verifier: 'old-verifier',
      oauth_state: 'old-state',
      oauth_return_route: 'old-route',
    });
    const oldRollbackWrites: string[] = [];
    let session!: ReturnType<typeof createConnectionSession>;
    let newer: Promise<void> | undefined;
    let startedNewer = false;
    const storage: SessionStorageLike = {
      getItem: backing.getItem,
      setItem: (key, value) => {
        if (value === 'old-verifier' || value === 'old-state' || value === 'old-route') {
          oldRollbackWrites.push(`${key}:${value}`);
        }
        backing.setItem(key, value);
        if (key === 'oauth_verifier' && value === 'old-verifier' && !startedNewer) {
          startedNewer = true;
          newer = session.beginOAuth('basicidp');
        }
      },
      removeItem: backing.removeItem,
    };
    let prepareCalls = 0;
    const configured = setup({
      storage,
      prepareOAuthRedirect: () => {
        prepareCalls += 1;
        if (prepareCalls === 1) throw new Error('older snapshot failed');
        return false;
      },
    });
    session = configured.session;

    const older = session.beginOAuth('g');
    await expect(older).rejects.toThrow('older snapshot failed');
    expect(newer).toBeDefined();
    await expect(newer!).resolves.toBeUndefined();

    expect(oldRollbackWrites).toEqual(['oauth_verifier:old-verifier']);
    const state = backing.getItem('oauth_state');
    expect(JSON.parse(backing.getItem('oauth_return_route')!)).toEqual({ state, search: '' });
    expect(configured.location.href).toContain('https://issuer2.example/authorize');
    expect(session.connection.value).toEqual({ kind: 'reauthenticating', epoch: 2 });
  });

  it('preserves the redirect error when storage cannot verify rollback ownership', async () => {
    const backing = memStorage();
    let readsFail = false;
    const storage: SessionStorageLike = {
      getItem: (key) => {
        if (readsFail) throw new Error(`cannot read ${key}`);
        return backing.getItem(key);
      },
      setItem: backing.setItem,
      removeItem: backing.removeItem,
    };
    const { session, location } = setup({
      storage,
      prepareOAuthRedirect: () => {
        readsFail = true;
        throw new Error('snapshot failed');
      },
    });

    await expect(session.beginOAuth('g')).rejects.toThrow('snapshot failed');
    expect(location.href).toBe('https://ch.example/sql');
  });

  it('disarms and rolls back the OAuth attempt when assigning href fails', async () => {
    const events: string[] = [];
    const storage = memStorage({
      oauth_verifier: 'old-verifier', oauth_state: 'old-state', oauth_return_route: 'old-route',
      oauth_idp: 'basicidp', oauth_origin: 'https://old-cluster.example',
    });
    const rollback = vi.fn();
    const location = {
      origin: 'https://ch.example', pathname: '/sql', search: '',
      get href() { return 'https://ch.example/sql'; },
      set href(_value: string) { events.push('href'); throw new Error('redirect blocked'); },
    };
    const { session } = setup({
      storage,
      location,
      prepareOAuthRedirect: () => ({ hasRecoverySnapshot: true, rollback }),
      armOAuthRedirectUnloadBypass: () => {
        events.push('arm');
        return () => events.push('disarm');
      },
    });

    await expect(session.beginOAuth('g')).rejects.toThrow('redirect blocked');

    expect(events).toEqual(['arm', 'href', 'disarm']);
    expect(storage.getItem('oauth_verifier')).toBe('old-verifier');
    expect(storage.getItem('oauth_state')).toBe('old-state');
    expect(storage.getItem('oauth_return_route')).toBe('old-route');
    expect(storage.getItem('oauth_idp')).toBe('basicidp');
    expect(storage.getItem('oauth_origin')).toBe('https://old-cluster.example');
    expect(session.idpId()).toBe('basicidp');
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('replaces every OAuth attempt key on retry', async () => {
    const { session, storage, location } = setup({
      storage: memStorage({
        oauth_verifier: 'stale-verifier', oauth_state: 'stale-state', oauth_return_route: 'stale-route',
      }),
      prepareOAuthRedirect: () => false,
    });

    await session.beginOAuth('g');
    const first = {
      verifier: storage.getItem('oauth_verifier'),
      state: storage.getItem('oauth_state'),
      route: storage.getItem('oauth_return_route'),
    };
    location.search = '?ws=next';
    await session.beginOAuth('g');

    expect(storage.getItem('oauth_verifier')).not.toBe(first.verifier);
    expect(storage.getItem('oauth_state')).not.toBe(first.state);
    expect(storage.getItem('oauth_return_route')).not.toBe(first.route);
    expect(JSON.parse(storage.getItem('oauth_return_route')!)).toEqual({
      state: storage.getItem('oauth_state'), search: '?ws=next',
    });
  });

  it('does not let an older config-delayed attempt roll back or disarm a newer redirect', async () => {
    const oldDiscovery = deferred<FakeResponse>();
    const prepare = vi.fn(() => true);
    const disarmNewer = vi.fn();
    const arm = vi.fn(() => disarmNewer);
    const { session, storage, location, fetchMock } = setup({
      routes: [(url) => (
        url.includes('issuer.example/.well-known/openid-configuration')
          ? oldDiscovery.promise
          : null
      )],
      prepareOAuthRedirect: prepare,
      armOAuthRedirectUnloadBypass: arm,
    });
    const older = session.beginOAuth('g');
    await vi.waitFor(() => expect(fetchMock.calls.some(
      (url) => url.includes('issuer.example/.well-known/openid-configuration'),
    )).toBe(true));

    location.search = '?ws=newer';
    await session.beginOAuth('basicidp');
    const newerAttempt = {
      verifier: storage.getItem('oauth_verifier'),
      state: storage.getItem('oauth_state'),
      route: storage.getItem('oauth_return_route'),
      href: location.href,
      lifecycle: session.connection.value,
    };

    oldDiscovery.resolve(jsonResponse(200, {
      authorization_endpoint: 'https://issuer.example/authorize',
      token_endpoint: 'https://issuer.example/token',
    }));
    await expect(older).rejects.toThrow('Authentication attempt superseded');

    expect(storage.getItem('oauth_verifier')).toBe(newerAttempt.verifier);
    expect(storage.getItem('oauth_state')).toBe(newerAttempt.state);
    expect(storage.getItem('oauth_return_route')).toBe(newerAttempt.route);
    expect(location.href).toBe(newerAttempt.href);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(newerAttempt.state);
    expect(arm).toHaveBeenCalledTimes(1);
    expect(disarmNewer).not.toHaveBeenCalled();
    expect(session.connection.value).toBe(newerAttempt.lifecycle);
    expect(session.connection.value).toEqual({ kind: 'reauthenticating', epoch: 2 });
  });

  it('does not let a stale attempt mutate storage after the newer attempt rolls itself back', async () => {
    const oldDiscovery = deferred<FakeResponse>();
    const backing = memStorage({
      oauth_verifier: 'original-verifier',
      oauth_state: 'original-state',
      oauth_return_route: 'original-route',
    });
    const mutations: string[] = [];
    const storage: SessionStorageLike = {
      getItem: backing.getItem,
      setItem: (key, value) => {
        if (key.startsWith('oauth_') && key !== 'oauth_idp') mutations.push(`set:${key}`);
        backing.setItem(key, value);
      },
      removeItem: (key) => {
        if (key.startsWith('oauth_') && key !== 'oauth_idp') mutations.push(`remove:${key}`);
        backing.removeItem(key);
      },
    };
    const arm = vi.fn(() => vi.fn());
    const { session, fetchMock } = setup({
      storage,
      routes: [(url) => (
        url.includes('issuer.example/.well-known/openid-configuration')
          ? oldDiscovery.promise
          : null
      )],
      prepareOAuthRedirect: () => { throw new Error('newer snapshot failed'); },
      armOAuthRedirectUnloadBypass: arm,
    });
    const older = session.beginOAuth('g');
    await vi.waitFor(() => expect(fetchMock.calls.some(
      (url) => url.includes('issuer.example/.well-known/openid-configuration'),
    )).toBe(true));

    await expect(session.beginOAuth('basicidp')).rejects.toThrow('newer snapshot failed');
    const mutationsAfterNewerRollback = mutations.length;
    expect(session.connection.value).toEqual({ kind: 'signed-out', epoch: 2 });

    oldDiscovery.resolve(jsonResponse(200, {
      authorization_endpoint: 'https://issuer.example/authorize',
      token_endpoint: 'https://issuer.example/token',
    }));
    await expect(older).rejects.toThrow('Authentication attempt superseded');

    expect(mutations).toHaveLength(mutationsAfterNewerRollback);
    expect(backing.getItem('oauth_verifier')).toBe('original-verifier');
    expect(backing.getItem('oauth_state')).toBe('original-state');
    expect(backing.getItem('oauth_return_route')).toBe('original-route');
    expect(arm).not.toHaveBeenCalled();
    expect(session.connection.value).toEqual({ kind: 'signed-out', epoch: 2 });
  });

  it('preserves the original auth-required prior when an overlapping retry fails', async () => {
    const oldDiscovery = deferred<FakeResponse>();
    const { session, fetchMock } = setup({
      storage: memStorage({ oauth_id_token: validToken }),
      routes: [(url) => (
        url.includes('issuer.example/.well-known/openid-configuration')
          ? oldDiscovery.promise
          : null
      )],
      prepareOAuthRedirect: () => { throw new Error('newer snapshot failed'); },
    });
    session.chCtx.onSignedOut('original authentication detail');
    expect(session.connection.value).toEqual({
      kind: 'auth-required', epoch: 1, detail: 'original authentication detail',
    });

    const older = session.beginOAuth('g');
    await vi.waitFor(() => expect(fetchMock.calls.some(
      (url) => url.includes('issuer.example/.well-known/openid-configuration'),
    )).toBe(true));
    await expect(session.beginOAuth('basicidp')).rejects.toThrow('newer snapshot failed');

    expect(session.connection.value).toEqual({
      kind: 'auth-required', epoch: 3, detail: 'original authentication detail',
    });
    oldDiscovery.resolve(jsonResponse(200, {
      authorization_endpoint: 'https://issuer.example/authorize',
      token_endpoint: 'https://issuer.example/token',
    }));
    await expect(older).rejects.toThrow('Authentication attempt superseded');
    expect(session.connection.value).toEqual({
      kind: 'auth-required', epoch: 3, detail: 'original authentication detail',
    });
  });

  it('keeps a reentrant newer attempt authoritative when an older storage write resumes', async () => {
    const backing = memStorage({
      oauth_verifier: 'original-verifier',
      oauth_state: 'original-state',
      oauth_return_route: 'original-route',
    });
    const location = {
      origin: 'https://ch.example', pathname: '/sql', search: '?ws=older', href: 'https://ch.example/sql',
    };
    let session!: ReturnType<typeof createConnectionSession>;
    let newer: Promise<void> | undefined;
    let startedNewer = false;
    const storage: SessionStorageLike = {
      getItem: backing.getItem,
      setItem: (key, value) => {
        backing.setItem(key, value);
        if (key === 'oauth_state' && !startedNewer) {
          startedNewer = true;
          location.search = '?ws=newer';
          newer = session.beginOAuth('basicidp');
        }
      },
      removeItem: backing.removeItem,
    };
    const prepare = vi.fn(() => true);
    const disarmNewer = vi.fn();
    const arm = vi.fn(() => disarmNewer);
    ({ session } = setup({
      storage,
      location,
      prepareOAuthRedirect: prepare,
      armOAuthRedirectUnloadBypass: arm,
    }));

    const older = session.beginOAuth('g');
    await expect(older).rejects.toThrow('Authentication attempt superseded');
    expect(newer).toBeDefined();
    await expect(newer!).resolves.toBeUndefined();

    const state = backing.getItem('oauth_state');
    expect(JSON.parse(backing.getItem('oauth_return_route')!)).toEqual({
      state, search: '?ws=newer',
    });
    expect(backing.getItem('oauth_verifier')).not.toBe('original-verifier');
    expect(state).not.toBe('original-state');
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(state);
    expect(arm).toHaveBeenCalledTimes(1);
    expect(disarmNewer).not.toHaveBeenCalled();
    expect(session.connection.value).toEqual({ kind: 'reauthenticating', epoch: 2 });
  });

  it('disarms a stale bypass when a returning href setter starts a newer attempt', async () => {
    let href = 'https://ch.example/sql';
    let session!: ReturnType<typeof createConnectionSession>;
    let newer: Promise<void> | undefined;
    let startedNewer = false;
    const location = {
      origin: 'https://ch.example', pathname: '/sql', search: '',
      get href() { return href; },
      set href(value: string) {
        href = value;
        if (!startedNewer) {
          startedNewer = true;
          newer = session.beginOAuth('basicidp');
        }
      },
    };
    const disarmOlder = vi.fn();
    const disarmNewer = vi.fn();
    const arm = vi.fn()
      .mockImplementationOnce(() => disarmOlder)
      .mockImplementationOnce(() => disarmNewer);
    ({ session } = setup({
      location,
      prepareOAuthRedirect: () => true,
      armOAuthRedirectUnloadBypass: arm,
    }));

    const older = session.beginOAuth('g');
    await expect(older).rejects.toThrow('Authentication attempt superseded');
    expect(disarmOlder).toHaveBeenCalledTimes(1);
    expect(newer).toBeDefined();
    await expect(newer!).resolves.toBeUndefined();

    expect(arm).toHaveBeenCalledTimes(2);
    expect(disarmNewer).not.toHaveBeenCalled();
    expect(location.href).toContain('https://issuer2.example/authorize');
    expect(session.connection.value).toEqual({ kind: 'reauthenticating', epoch: 2 });
  });

  it('restores the prior lifecycle when redirect preparation fails', async () => {
    const { session } = setup({
      storage: memStorage({ oauth_id_token: validToken }),
      routes: [(url) => (url.endsWith('/config.json') ? jsonResponse(500, {}) : null)],
    });
    await expect(session.beginOAuth('g')).rejects.toThrow();
    expect(session.connection.value).toEqual({ kind: 'signed-out', epoch: 1 });
  });
});

// ── config ───────────────────────────────────────────────────────────────────

describe('config', () => {
  it('loadIdps resolves the normalized config doc', async () => {
    const { session } = setup();
    const doc = await session.loadIdps();
    expect(doc.idps.map((i) => i.id)).toEqual(['g', 'basicidp']);
  });

  it('selectIdp persists the choice', () => {
    const { session, storage } = setup();
    session.selectIdp('basicidp');
    expect(session.idpId()).toBe('basicidp');
    expect(storage.getItem('oauth_idp')).toBe('basicidp');
  });

  it('resolveConfig finds the selected idp and memoizes discovery per idp', async () => {
    const { session, fetchMock } = setup();
    session.selectIdp('g');
    const a = await session.resolveConfig();
    const b = await session.resolveConfig();
    expect(a.id).toBe('g');
    expect(b).toBe(a);
    expect(fetchMock.calls.filter((u) => u.includes('/.well-known/')).length).toBe(1);
  });

  it('resolveConfig falls back to the first idp when none is selected', async () => {
    const { session } = setup();
    const cfg = await session.resolveConfig();
    expect(cfg.id).toBe('g');
  });
});

describe('ensureConfig', () => {
  it('applies chAuth/basicUserClaim from the resolved config', async () => {
    const { session } = setup({ storage: memStorage({ oauth_idp: 'basicidp' }) });
    const cfg = await session.ensureConfig();
    expect(cfg && cfg.id).toBe('basicidp');
    expect(session.chAuth()).toBe('basic');
    expect(session.basicUserClaim()).toBe('nickname');
  });

  it('is a fail-soft null when config.json cannot be loaded', async () => {
    const { session } = setup({ routes: [(url) => (url.endsWith('/config.json') ? jsonResponse(500, {}) : null)] });
    await expect(session.ensureConfig()).resolves.toBeNull();
    expect(session.chAuth()).toBe('bearer');
  });

  it('short-circuits to null (no fetch) in basic mode', async () => {
    const { session, fetchMock } = setup({ storage: memStorage({ ch_basic_auth: 'YWJj' }) });
    await expect(session.ensureConfig()).resolves.toBeNull();
    expect(fetchMock.calls.length).toBe(0);
  });

  it('does not let old discovery rewrite a replacement epoch auth-header policy', async () => {
    const discovery = deferred<FakeResponse>();
    const { session, fetchMock } = setup({
      storage: memStorage({ oauth_id_token: validToken, oauth_idp: 'basicidp' }),
      routes: [(url) => (url.includes('issuer2.example/.well-known/') ? discovery.promise : null)],
    });
    const oldEnsure = session.ensureConfig();
    await vi.waitFor(() => expect(fetchMock.calls.some((url) => url.includes('issuer2.example/.well-known/'))).toBe(true));

    session.selectIdp('g');
    session.setTokens('replacement-token', 'replacement-refresh');
    discovery.resolve(jsonResponse(200, {
      authorization_endpoint: 'https://issuer2.example/authorize',
      token_endpoint: 'https://issuer2.example/token',
    }));

    await expect(oldEnsure).resolves.toBeNull();
    expect(session.chAuth()).toBe('bearer');
    expect(session.basicUserClaim()).toBe('');
  });
});

// ── connectBasic ─────────────────────────────────────────────────────────────

describe('connectBasic', () => {
  it('probes with a Basic header, then commits session + chCtx.origin to the default host', async () => {
    const probes: { origin: string; header: string; token: string | null; refreshed: boolean }[] = [];
    const { session, storage, location } = setup({
      queryJson: fakeQueryJson(async (ctx) => {
        // Exercise the probe ctx's own getToken/refresh — the real
        // authenticatedRequest (net/authenticated-clickhouse-request.ts,
        // reached via net/ch-client.ts's queryJson) would call these; this
        // fake queryJson stands in for it, so it drives them itself to prove
        // the throwaway ctx is fully wired (getToken resolves the probe
        // creds verbatim; refresh is hardwired false — Basic credentials
        // can't be refreshed).
        const t = await ctx.getToken();
        const r = await ctx.refresh();
        probes.push({ origin: ctx.origin, header: ctx.authHeader!(''), token: t, refreshed: r });
        return { data: [{ 1: 1 }] };
      }),
    });
    await session.connectBasic({ username: 'bob', password: 'pw' });
    expect(probes[0].origin).toBe(location.origin);
    expect(probes[0].header).toBe('Basic ' + btoa(unescape(encodeURIComponent('bob:pw'))));
    expect(probes[0].token).toBe(btoa(unescape(encodeURIComponent('bob:pw'))));
    expect(probes[0].refreshed).toBe(false);
    expect(session.authMode()).toBe('basic');
    expect(storage.getItem('ch_basic_auth')).toBe(btoa(unescape(encodeURIComponent('bob:pw'))));
    expect(storage.getItem('ch_basic_user')).toBe('bob');
    expect(storage.getItem('ch_basic_origin')).toBe(location.origin);
    expect(session.chCtx.origin).toBe(location.origin);
  });

  it('targets a custom host when given', async () => {
    const { session, storage } = setup();
    await session.connectBasic({ username: 'bob', password: 'pw', host: 'myhost:8443' });
    expect(storage.getItem('ch_basic_origin')).toBe('https://myhost:8443');
    expect(session.chCtx.origin).toBe('https://myhost:8443');
  });

  it('trims the username and tolerates an empty one', async () => {
    const { session, storage } = setup();
    await session.connectBasic({ username: '  bob  ', password: 'pw' });
    expect(storage.getItem('ch_basic_user')).toBe('bob');
    const { session: s2, storage: storage2 } = setup();
    await s2.connectBasic({ username: '', password: 'pw' });
    expect(storage2.getItem('ch_basic_user')).toBe('');
  });

  it('propagates a probe rejection and commits nothing', async () => {
    const { session, storage } = setup({ queryJson: fakeQueryJson(async () => { throw new Error('wrong password'); }) });
    await expect(session.connectBasic({ username: 'bob', password: 'bad' })).rejects.toThrow('wrong password');
    expect(storage.getItem('ch_basic_auth')).toBeNull();
    expect(session.authMode()).toBe('oauth');
  });

  it('the probe ctx.onSignedOut throws, with the given detail or a default', async () => {
    const { session } = setup({ queryJson: fakeQueryJson(async (ctx) => { ctx.onSignedOut('denied: bad creds'); return {}; }) });
    await expect(session.connectBasic({ username: 'bob', password: 'bad' })).rejects.toThrow('denied: bad creds');
    const { session: s2 } = setup({ queryJson: fakeQueryJson(async (ctx) => { ctx.onSignedOut(); return {}; }) });
    await expect(s2.connectBasic({ username: 'bob', password: 'bad' })).rejects.toThrow('Authentication failed');
  });

  it('does not let a slow older probe overwrite a newer successful login', async () => {
    const alice = deferred<void>();
    const bob = deferred<void>();
    let probes = 0;
    const { session, storage } = setup({
      queryJson: fakeQueryJson(async (ctx) => {
        probes += 1;
        const token = await ctx.getToken();
        const decoded = atob(token || '');
        if (decoded.startsWith('alice:')) await alice.promise;
        else await bob.promise;
        return { data: [{ 1: 1 }] };
      }),
    });
    const older = session.connectBasic({ username: 'alice', password: 'old', host: 'old.example' });
    const newer = session.connectBasic({ username: 'bob', password: 'new', host: 'new.example' });
    await vi.waitFor(() => expect(probes).toBe(2));
    bob.resolve();
    await expect(newer).resolves.toBeUndefined();
    const winningEpoch = session.connection.value.epoch;
    alice.resolve();
    await expect(older).rejects.toThrow('Authentication attempt superseded');
    expect(session.connection.value).toEqual({ kind: 'starting', epoch: winningEpoch });
    expect(storage.getItem('ch_basic_user')).toBe('bob');
    expect(storage.getItem('ch_basic_origin')).toBe('https://new.example:8443');
    expect(session.chCtx.origin).toBe('https://new.example:8443');
  });
});

// ── signOut / onSignedOut ────────────────────────────────────────────────────

describe('signOut', () => {
  it('clears every auth key and resets mode/origin/authConfirmed, without calling onAuthLost', () => {
    const { session, storage, location, onAuthLost } = setup({
      storage: memStorage({
        oauth_id_token: validToken, oauth_refresh_token: 'r', oauth_verifier: 'v', oauth_state: 's',
        oauth_idp: 'g', oauth_origin: 'https://cluster.example',
        ch_basic_auth: 'YWJj', ch_basic_user: 'bob', ch_basic_origin: 'https://other.example',
      }),
    });
    session.chCtx.authConfirmed = true;
    session.signOut();
    for (const k of [
      'oauth_id_token', 'oauth_refresh_token', 'oauth_verifier', 'oauth_state', 'oauth_idp', 'oauth_origin',
      'ch_basic_auth', 'ch_basic_user', 'ch_basic_origin',
    ]) expect(storage.getItem(k)).toBeNull();
    expect(session.token()).toBeNull();
    expect(session.authMode()).toBe('oauth');
    expect(session.chCtx.origin).toBe(location.origin);
    expect(session.chCtx.authConfirmed).toBe(false);
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it('clears document recovery only for explicit sign-out, not involuntary auth loss', () => {
    const clearOAuthDocumentRecovery = vi.fn();
    const { session } = setup({
      storage: memStorage({ oauth_id_token: validToken }),
      clearOAuthDocumentRecovery,
    });

    session.chCtx.onSignedOut('expired');
    expect(clearOAuthDocumentRecovery).not.toHaveBeenCalled();
    session.signOut();
    expect(clearOAuthDocumentRecovery).toHaveBeenCalledTimes(1);
  });

  it('still clears document recovery and stays signed out when auth storage cleanup throws', () => {
    const backing = memStorage({ oauth_id_token: validToken });
    const storage: SessionStorageLike = {
      getItem: backing.getItem,
      setItem: backing.setItem,
      removeItem: (key) => {
        if (key === 'oauth_id_token') throw new Error('auth storage cleanup failed');
        backing.removeItem(key);
      },
    };
    const clearOAuthDocumentRecovery = vi.fn();
    const { session } = setup({ storage, clearOAuthDocumentRecovery });

    expect(() => session.signOut()).toThrow('auth storage cleanup failed');

    expect(clearOAuthDocumentRecovery).toHaveBeenCalledTimes(1);
    expect(session.connection.value).toEqual({ kind: 'signed-out', epoch: 1 });
  });

  it('surfaces a recovery cleanup failure after credentials clear successfully', () => {
    const { session } = setup({
      storage: memStorage({ oauth_id_token: validToken }),
      clearOAuthDocumentRecovery: () => { throw new Error('recovery cleanup failed'); },
    });

    expect(() => session.signOut()).toThrow('recovery cleanup failed');
    expect(session.token()).toBeNull();
    expect(session.connection.value).toEqual({ kind: 'signed-out', epoch: 1 });
  });
});

describe('chCtx.onSignedOut', () => {
  it('reports a discovered empty session once without converting explicit signed-out state', () => {
    const { session, onAuthLost } = setup();
    session.chCtx.onSignedOut('no credentials');
    session.chCtx.onSignedOut('duplicate');
    expect(session.connection.value).toEqual({ kind: 'signed-out', epoch: 0 });
    expect(onAuthLost).toHaveBeenCalledTimes(1);
    expect(onAuthLost).toHaveBeenCalledWith('no credentials');
  });

  it('captures the in-memory credential even if sessionStorage changes before a failure settles', () => {
    const storage = memStorage({ oauth_id_token: validToken });
    const { session, onAuthLost } = setup({ storage });
    // OAuth's token is deliberately held in memory; a storage mutation must
    // not weaken the exact cancellation authority captured for an in-flight
    // operation.
    storage.removeItem('oauth_id_token');
    session.chCtx.onSignedOut('credential disappeared');
    expect(session.connection.value).toMatchObject({ kind: 'auth-required', detail: 'credential disappeared' });
    expect(onAuthLost).toHaveBeenCalledWith('credential disappeared', expect.objectContaining({ authorization: `Bearer ${validToken}` }));
  });

  it('clears tokens and reports the given detail', () => {
    const { session, onAuthLost } = setup({ storage: memStorage({ oauth_id_token: validToken }) });
    session.chCtx.onSignedOut('you are not welcome');
    expect(session.token()).toBeNull();
    expect(onAuthLost).toHaveBeenCalledWith(
      'you are not welcome',
      expect.objectContaining({ authorization: `Bearer ${validToken}`, epoch: 0 }),
    );
  });
  it('retains the exact prior Basic target for inline recovery, but not explicit sign-out', () => {
    const { session } = setup({ storage: memStorage({
      ch_basic_auth: 'YWJj', ch_basic_user: 'bob', ch_basic_origin: 'https://db.example:9440',
    }) });
    session.chCtx.onSignedOut('credentials rejected');
    expect(session.chCtx.origin).toBe('https://ch.example');
    expect(session.basicRecoveryOrigin()).toBe('https://db.example:9440');

    session.signOut();
    expect(session.basicRecoveryOrigin()).toBeNull();
  });
  it('falls back to the default expired-session message', () => {
    const { session, onAuthLost } = setup({ storage: memStorage({ oauth_id_token: validToken }) });
    session.chCtx.onSignedOut();
    expect(onAuthLost).toHaveBeenCalledWith(
      'Your session expired — please sign in again.',
      expect.objectContaining({ authorization: `Bearer ${validToken}` }),
    );
  });
  it('supplies an immutable latest-credential cancellation lease before clearing storage', () => {
    const storage = memStorage({ oauth_id_token: validToken });
    let captured: AuthenticatedCancellationLease | undefined;
    let tokenDuringCallback: string | null = null;
    const { session, fetchMock } = setup({
      storage,
      onAuthLost: (_detail, lease) => {
        captured = lease;
        tokenDuringCallback = storage.getItem('oauth_id_token');
      },
    });
    session.setTokens(expiringSoonToken, 'rotated-refresh');
    const closingEpoch = session.connection.value.epoch;
    session.chCtx.origin = 'https://rotated-cluster.example:9440';
    session.chCtx.onSignedOut(undefined, closingEpoch);
    expect(tokenDuringCallback).toBe(expiringSoonToken);
    expect(captured).toEqual({
      epoch: closingEpoch,
      origin: 'https://rotated-cluster.example:9440',
      authorization: `Bearer ${expiringSoonToken}`,
      fetch: session.chCtx.fetch,
    });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(captured?.fetch).toBe(session.chCtx.fetch);
    expect(fetchMock.calls).toEqual([]);
    expect(storage.getItem('oauth_id_token')).toBeNull();
  });
  it('prebuilds the Basic header and exact target origin into the lease', async () => {
    const { session } = setup();
    await session.connectBasic({ username: 'alice', password: 'secret', host: 'db.example:8443' });
    const lease = session.captureCancellationLease();
    expect(lease).toEqual({
      epoch: session.connection.value.epoch,
      origin: 'https://db.example:8443',
      authorization: `Basic ${btoa('alice:secret')}`,
      fetch: session.chCtx.fetch,
    });
  });
  it('returns no cancellation lease for a superseded epoch or an empty current credential', () => {
    const { session } = setup({ storage: memStorage({ oauth_id_token: validToken }) });
    const captureAtEpoch = session.captureCancellationLease as (expectedEpoch?: number) =>
      AuthenticatedCancellationLease | null;
    expect(captureAtEpoch(session.connection.value.epoch + 1)).toBeNull();
    session.signOut();
    expect(session.captureCancellationLease()).toBeNull();
  });
  it('probes an empty Basic password as an intentional empty credential', async () => {
    let auth = '';
    const { session } = setup({
      queryJson: fakeQueryJson(async (ctx) => {
        const credential = await ctx.getToken();
        if (credential === null || !ctx.authHeader) throw new Error('missing Basic credential');
        auth = ctx.authHeader(credential);
        return {};
      }),
    });
    await session.connectBasic({ username: 'alice', password: '' });
    expect(auth).toBe(`Basic ${btoa('alice:')}`);
  });
  it('clears credentials even when the auth-loss consumer throws', () => {
    const storage = memStorage({ oauth_id_token: validToken, oauth_refresh_token: 'refresh' });
    const { session } = setup({
      storage,
      onAuthLost: () => { throw new Error('scope teardown failed'); },
    });
    expect(() => session.chCtx.onSignedOut()).toThrow('scope teardown failed');
    expect(session.token()).toBeNull();
    expect(session.refreshToken()).toBeNull();
    expect(storage.getItem('oauth_id_token')).toBeNull();
    expect(storage.getItem('oauth_refresh_token')).toBeNull();
  });
});

// ── ensureFreshToken ─────────────────────────────────────────────────────────

describe('ensureFreshToken', () => {
  it('returns null rather than invalidating a newer credential when a failed refresh is deliberately kept in its old epoch', async () => {
    let session!: ReturnType<typeof createConnectionSession>;
    const { session: created } = setup({
      storage: memStorage({ oauth_id_token: expiredToken }),
      routes: [(url) => (url.endsWith('/token') ? jsonResponse(200, {}) : null)],
      onAuthLost: () => session.signOut(),
    });
    session = created;
    await expect(session.getToken()).resolves.toBeNull();
  });

  it('resolves true when a valid token is available', async () => {
    const { session } = setup({ storage: memStorage({ oauth_id_token: validToken }) });
    await expect(session.ensureFreshToken()).resolves.toBe(true);
  });
  it('resolves false with no token', async () => {
    const { session } = setup();
    await expect(session.ensureFreshToken()).resolves.toBe(false);
  });
});

// ── host() ───────────────────────────────────────────────────────────────────

describe('host()', () => {
  it('derives the host from chCtx.origin', () => {
    const { session } = setup({ location: { origin: 'https://ch.example:8443', pathname: '/sql', search: '', href: '' } });
    expect(session.host()).toBe('ch.example:8443');
  });
  it('falls back to "clickhouse" when chCtx.origin is not a parseable URL', () => {
    const { session } = setup();
    session.chCtx.origin = 'not a url';
    expect(session.host()).toBe('clickhouse');
  });
});
