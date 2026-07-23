import { describe, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createConnectionSession } from '../../src/application/connection-session.js';
import type { ConnectionSessionDeps, SessionStorageLike } from '../../src/application/connection-session.js';
import type { ChCtx, queryJson } from '../../src/net/ch-client.js';
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
type RouteFn = (url: string, init?: RequestInit) => FakeResponse | null;

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
      const resp = r(url, init);
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
  onAuthLost?: (detail?: string) => void;
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
    const { session } = setup({
      storage: memStorage({ oauth_id_token: expiredToken, oauth_refresh_token: 'r0' }),
      routes: [(url) => (url.endsWith('/token') ? jsonResponse(200, {}) : null)],
    });
    await expect(session.getToken()).resolves.toBeNull();
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
});

// ── connectBasic ─────────────────────────────────────────────────────────────

describe('connectBasic', () => {
  it('probes with a Basic header, then commits session + chCtx.origin to the default host', async () => {
    const probes: { origin: string; header: string; token: string | null; refreshed: boolean }[] = [];
    const { session, storage, location } = setup({
      queryJson: fakeQueryJson(async (ctx) => {
        // Exercise the probe ctx's own getToken/refresh — the real authedFetch
        // (net/ch-client.ts) would call these; this fake queryJson stands in
        // for it, so it drives them itself to prove the throwaway ctx is
        // fully wired (getToken resolves the probe creds verbatim; refresh is
        // hardwired false — Basic credentials can't be refreshed).
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
});

describe('chCtx.onSignedOut', () => {
  it('clears tokens and reports the given detail', () => {
    const { session, onAuthLost } = setup({ storage: memStorage({ oauth_id_token: validToken }) });
    session.chCtx.onSignedOut('you are not welcome');
    expect(session.token()).toBeNull();
    expect(onAuthLost).toHaveBeenCalledWith('you are not welcome');
  });
  it('falls back to the default expired-session message', () => {
    const { session, onAuthLost } = setup({ storage: memStorage({ oauth_id_token: validToken }) });
    session.chCtx.onSignedOut();
    expect(onAuthLost).toHaveBeenCalledWith('Your session expired — please sign in again.');
  });
});

// ── ensureFreshToken ─────────────────────────────────────────────────────────

describe('ensureFreshToken', () => {
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
