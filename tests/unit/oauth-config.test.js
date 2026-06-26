import { describe, it, expect, vi } from 'vitest';
import { loadConfigDoc, resolveIdp, memoizeConfig } from '../../src/net/oauth-config.js';

const resp = (ok, body, status = ok ? 200 : 500) => ({
  ok,
  status,
  json: async () => body,
});

function fetcher(map) {
  return vi.fn(async (url) => {
    for (const [re, r] of map) if (re.test(url)) return r;
    throw new Error('unexpected url ' + url);
  });
}

const okDisc = {
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
};

describe('loadConfigDoc', () => {
  const docOf = async (body, base = '/sql') =>
    (await loadConfigDoc(fetcher([[/config\.json$/, resp(true, body)]]), base)).idps;

  it('wraps a single bare-object config into one IdP (host id/label defaults)', async () => {
    const f = fetcher([[/config\.json$/, resp(true, {
      issuer: 'https://accounts.google.com', client_id: 'cid', client_secret: 'sek', audience: 'aud',
    })]]);
    const { idps } = await loadConfigDoc(f, '/sql');
    expect(idps).toEqual([{
      id: 'accounts.google.com', label: 'Google', // issuer host → friendly name
      issuer: 'https://accounts.google.com', clientId: 'cid', clientSecret: 'sek',
      audience: 'aud', bearer: 'id_token', chAuth: 'bearer', authorizeParams: {},
      basicUserClaim: '',
    }]);
    expect(f.mock.calls[0][0]).toBe('/sql/config.json');
  });
  it('parses a list and honours explicit id/label', async () => {
    const idps = await docOf({ idps: [
      { id: 'g', label: 'Google', issuer: 'https://accounts.google.com', client_id: 'c1' },
      { id: 'a', label: 'Acme', issuer: 'https://acme.auth0.com', client_id: 'c2', bearer: 'access_token' },
    ] });
    expect(idps.map((i) => [i.id, i.label, i.bearer])).toEqual([
      ['g', 'Google', 'id_token'], ['a', 'Acme', 'access_token'],
    ]);
  });
  it('defaults id/label to the issuer host, and to the raw string for a non-URL issuer', async () => {
    const idps = await docOf({ idps: [
      { issuer: 'https://acme.auth0.com', client_id: 'c' },
      { issuer: 'weird', client_id: 'c' },
    ] });
    expect(idps[0].id).toBe('acme.auth0.com');
    expect(idps[0].label).toBe('acme.auth0.com'); // unknown host, no connection → host
    expect(idps[1].id).toBe('weird'); // new URL('weird') throws → raw fallback
  });
  it('derives a friendly label from an Auth0 connection or a known issuer host', async () => {
    const idps = await docOf({ idps: [
      // Auth0 brokering GitHub: tenant host is uninformative → use the connection.
      { issuer: 'https://altinity.auth0.com', client_id: 'c', authorize_params: { connection: 'github' } },
      // Unknown connection → capitalized.
      { issuer: 'https://x', client_id: 'c', authorize_params: { connection: 'okta-prod' } },
      // Direct Google issuer, no label/connection → mapped.
      { issuer: 'https://accounts.google.com', client_id: 'c' },
      // Explicit label always wins.
      { issuer: 'https://accounts.google.com', client_id: 'c', label: 'Staff SSO' },
    ] });
    expect(idps.map((i) => i.label)).toEqual(['GitHub', 'Okta-prod', 'Google', 'Staff SSO']);
  });
  it('defaults clientSecret/audience/bearer/chAuth/authorizeParams', async () => {
    const [idp] = await docOf({ issuer: 'https://i', client_id: 'c' });
    expect(idp.clientSecret).toBe('');
    expect(idp.audience).toBe('');
    expect(idp.bearer).toBe('id_token');
    expect(idp.chAuth).toBe('bearer');
    expect(idp.authorizeParams).toEqual({});
    expect(idp.basicUserClaim).toBe('');
  });
  it('honours ch_auth=basic, bearer=access_token, basic_user_claim, and an authorize_params object', async () => {
    const [idp] = await docOf({
      issuer: 'https://i', client_id: 'c', ch_auth: 'basic', bearer: 'access_token',
      basic_user_claim: 'nickname', authorize_params: { organization: 'org_x' },
    });
    expect(idp.chAuth).toBe('basic');
    expect(idp.bearer).toBe('access_token');
    expect(idp.basicUserClaim).toBe('nickname');
    expect(idp.authorizeParams).toEqual({ organization: 'org_x' });
  });
  it('ignores a non-object authorize_params and an unknown bearer', async () => {
    const [idp] = await docOf({ issuer: 'https://i', client_id: 'c', bearer: 'weird', authorize_params: 'nope' });
    expect(idp.bearer).toBe('id_token');
    expect(idp.authorizeParams).toEqual({});
  });
  it('throws when config.json is not ok', async () => {
    const f = fetcher([[/config\.json$/, resp(false, null, 404)]]);
    await expect(loadConfigDoc(f, '/sql')).rejects.toThrow('config.json: 404');
  });
  it('throws when an IdP lacks issuer/client_id', async () => {
    await expect(docOf({ issuer: 'x' })).rejects.toThrow('missing issuer or client_id');
  });
  it('returns no IdPs for an empty list (credentials-only deployment)', async () => {
    expect(await docOf({ idps: [] })).toEqual([]);
  });
  it('returns no IdPs for an IdP-less config (no idps, no issuer)', async () => {
    expect(await docOf({ basic_login: true })).toEqual([]);
  });
  it('defaults basicLogin to true and honours an explicit false', async () => {
    const load = (body) => loadConfigDoc(fetcher([[/config\.json$/, resp(true, body)]]), '/sql');
    expect((await load({ idps: [] })).basicLogin).toBe(true);
    expect((await load({ basic_login: false, idps: [] })).basicLogin).toBe(false);
    expect((await load({ issuer: 'https://i', client_id: 'c' })).basicLogin).toBe(true);
  });
});

describe('loadConfigDoc hosts', () => {
  const load = (body) => loadConfigDoc(fetcher([[/config\.json$/, resp(true, body)]]), '/sql');

  it('returns [] when no hosts are configured', async () => {
    expect((await load({ idps: [] })).hosts).toEqual([]);
  });

  it('normalizes basic and oauth host entries (defaults + auth)', async () => {
    const { hosts } = await load({
      idps: [],
      hosts: [
        { label: 'demo', url: 'http://localhost:8123', user: 'default', password: 'pw' },
        { label: 'antalya', url: 'https://antalya.demo.altinity.cloud', auth: 'oauth', idp: 'google' },
      ],
    });
    expect(hosts[0]).toEqual({ label: 'demo', url: 'http://localhost:8123', auth: 'basic', user: 'default', password: 'pw', idp: '' });
    expect(hosts[1]).toEqual({ label: 'antalya', url: 'https://antalya.demo.altinity.cloud', auth: 'oauth', user: '', password: '', idp: 'google' });
  });

  it('falls back the label to the url and defaults missing fields', async () => {
    const { hosts } = await load({ idps: [], hosts: [{ url: 'http://h:8123' }] });
    expect(hosts[0]).toEqual({ label: 'http://h:8123', url: 'http://h:8123', auth: 'basic', user: '', password: '', idp: '' });
  });
});

describe('resolveIdp', () => {
  const idp = {
    id: 'i', label: 'I', issuer: 'https://i', clientId: 'c', clientSecret: '',
    audience: '', bearer: 'id_token', chAuth: 'bearer', authorizeParams: {},
  };
  it('adds authUri/tokenUri from OIDC discovery, preserving the descriptor', async () => {
    const f = fetcher([[/openid-configuration$/, resp(true, okDisc)]]);
    const cfg = await resolveIdp(f, idp);
    expect(cfg).toEqual({ ...idp, authUri: okDisc.authorization_endpoint, tokenUri: okDisc.token_endpoint });
  });
  it('throws when discovery is not ok', async () => {
    const f = fetcher([[/openid-configuration$/, resp(false, null, 500)]]);
    await expect(resolveIdp(f, idp)).rejects.toThrow('OIDC discovery failed: 500');
  });
  it('throws when discovery lacks endpoints', async () => {
    const f = fetcher([[/openid-configuration$/, resp(true, { authorization_endpoint: 'a' })]]);
    await expect(resolveIdp(f, idp)).rejects.toThrow('missing authorization_endpoint or token_endpoint');
  });
});

describe('memoizeConfig', () => {
  it('calls the loader once and caches the result', async () => {
    const loader = vi.fn(async () => ({ ok: 1 }));
    const m = memoizeConfig(loader);
    const [a, b] = [await m(), await m()];
    expect(a).toBe(b);
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it('does not cache failures', async () => {
    let n = 0;
    const loader = vi.fn(async () => {
      n++;
      if (n === 1) throw new Error('boom');
      return { ok: 2 };
    });
    const m = memoizeConfig(loader);
    await expect(m()).rejects.toThrow('boom');
    expect(await m()).toEqual({ ok: 2 });
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
