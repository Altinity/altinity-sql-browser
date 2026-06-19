import { describe, it, expect, vi } from 'vitest';
import { loadOAuthConfig, memoizeConfig } from '../../src/net/oauth-config.js';

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

const okConfig = { issuer: 'https://accounts.google.com', client_id: 'cid', client_secret: 'sek', audience: 'aud' };
const okDisc = {
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
};

describe('loadOAuthConfig', () => {
  it('resolves config + discovery', async () => {
    const f = fetcher([
      [/config\.json$/, resp(true, okConfig)],
      [/openid-configuration$/, resp(true, okDisc)],
    ]);
    const cfg = await loadOAuthConfig(f, '/sql');
    expect(cfg).toEqual({
      issuer: 'https://accounts.google.com',
      clientId: 'cid',
      clientSecret: 'sek',
      audience: 'aud',
      authUri: okDisc.authorization_endpoint,
      tokenUri: okDisc.token_endpoint,
      bearer: 'id_token',
      authorizeParams: {},
    });
    expect(f.mock.calls[0][0]).toBe('/sql/config.json');
  });
  it('defaults clientSecret/audience/bearer/authorizeParams', async () => {
    const f = fetcher([
      [/config\.json$/, resp(true, { issuer: 'https://i', client_id: 'c' })],
      [/openid-configuration$/, resp(true, okDisc)],
    ]);
    const cfg = await loadOAuthConfig(f, '');
    expect(cfg.clientSecret).toBe('');
    expect(cfg.audience).toBe('');
    expect(cfg.bearer).toBe('id_token');
    expect(cfg.authorizeParams).toEqual({});
  });
  it('honours bearer=access_token and authorize_params object', async () => {
    const f = fetcher([
      [/config\.json$/, resp(true, {
        issuer: 'https://i', client_id: 'c', bearer: 'access_token',
        authorize_params: { organization: 'org_x' },
      })],
      [/openid-configuration$/, resp(true, okDisc)],
    ]);
    const cfg = await loadOAuthConfig(f, '');
    expect(cfg.bearer).toBe('access_token');
    expect(cfg.authorizeParams).toEqual({ organization: 'org_x' });
  });
  it('ignores a non-object authorize_params and an unknown bearer', async () => {
    const f = fetcher([
      [/config\.json$/, resp(true, { issuer: 'https://i', client_id: 'c', bearer: 'weird', authorize_params: 'nope' })],
      [/openid-configuration$/, resp(true, okDisc)],
    ]);
    const cfg = await loadOAuthConfig(f, '');
    expect(cfg.bearer).toBe('id_token');
    expect(cfg.authorizeParams).toEqual({});
  });
  it('throws when config.json is not ok', async () => {
    const f = fetcher([[/config\.json$/, resp(false, null, 404)]]);
    await expect(loadOAuthConfig(f, '/sql')).rejects.toThrow('config.json: 404');
  });
  it('throws when config.json lacks issuer/client_id', async () => {
    const f = fetcher([[/config\.json$/, resp(true, { issuer: 'x' })]]);
    await expect(loadOAuthConfig(f, '/sql')).rejects.toThrow('missing issuer or client_id');
  });
  it('throws when discovery is not ok', async () => {
    const f = fetcher([
      [/config\.json$/, resp(true, okConfig)],
      [/openid-configuration$/, resp(false, null, 500)],
    ]);
    await expect(loadOAuthConfig(f, '/sql')).rejects.toThrow('OIDC discovery failed: 500');
  });
  it('throws when discovery lacks endpoints', async () => {
    const f = fetcher([
      [/config\.json$/, resp(true, okConfig)],
      [/openid-configuration$/, resp(true, { authorization_endpoint: 'a' })],
    ]);
    await expect(loadOAuthConfig(f, '/sql')).rejects.toThrow('missing authorization_endpoint or token_endpoint');
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
