import { describe, it, expect, vi } from 'vitest';
import {
  isGoogleAuth, buildAuthorizeUrl, exchangeCodeForTokens, refreshTokens, bearerFromTokens,
} from '../../src/net/oauth.js';

const googleCfg = {
  clientId: 'cid',
  clientSecret: 'sek',
  audience: '',
  authUri: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUri: 'https://oauth2.googleapis.com/token',
};
const otherCfg = {
  clientId: 'cid2',
  clientSecret: '',
  audience: 'https://api.example/',
  authUri: 'https://auth.example/authorize',
  tokenUri: 'https://auth.example/token',
};

describe('isGoogleAuth', () => {
  it('detects google', () => {
    expect(isGoogleAuth(googleCfg.authUri)).toBe(true);
    expect(isGoogleAuth(otherCfg.authUri)).toBe(false);
    expect(isGoogleAuth(null)).toBe(false);
  });
});

describe('buildAuthorizeUrl', () => {
  it('google: offline access, no offline_access scope, no audience', () => {
    const url = new URL(buildAuthorizeUrl(googleCfg, { redirectUri: 'https://app/sql', challenge: 'ch', state: 'st' }));
    const q = url.searchParams;
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('code_challenge')).toBe('ch');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('state')).toBe('st');
    expect(q.get('audience')).toBeNull();
  });
  it('non-google: offline_access scope + audience, no access_type', () => {
    const url = new URL(buildAuthorizeUrl(otherCfg, { redirectUri: 'r', challenge: 'c', state: 's' }));
    const q = url.searchParams;
    expect(q.get('scope')).toBe('openid email profile offline_access');
    expect(q.get('audience')).toBe('https://api.example/');
    expect(q.get('access_type')).toBeNull();
  });
  it('merges extra authorizeParams (e.g. Auth0 organization)', () => {
    const cfg = { ...otherCfg, authorizeParams: { organization: 'org_x' } };
    const url = new URL(buildAuthorizeUrl(cfg, { redirectUri: 'r', challenge: 'c', state: 's' }));
    expect(url.searchParams.get('organization')).toBe('org_x');
  });
});

const tokenResp = (ok, body, status = ok ? 200 : 400) => ({
  ok, status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe('exchangeCodeForTokens', () => {
  it('posts code + verifier and returns tokens (with secret)', async () => {
    const f = vi.fn(async () => tokenResp(true, { id_token: 'idt' }));
    const out = await exchangeCodeForTokens(f, googleCfg, { code: 'c', verifier: 'v', redirectUri: 'r' });
    expect(out).toEqual({ id_token: 'idt' });
    const body = f.mock.calls[0][1].body.toString();
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('client_secret=sek');
  });
  it('omits client_secret when absent', async () => {
    const f = vi.fn(async () => tokenResp(true, { id_token: 'x' }));
    await exchangeCodeForTokens(f, otherCfg, { code: 'c', verifier: 'v', redirectUri: 'r' });
    expect(f.mock.calls[0][1].body.toString()).not.toContain('client_secret');
  });
  it('throws on a non-ok response', async () => {
    const f = vi.fn(async () => tokenResp(false, { error: 'bad' }));
    await expect(exchangeCodeForTokens(f, googleCfg, { code: 'c', verifier: 'v', redirectUri: 'r' }))
      .rejects.toThrow('Token exchange failed');
  });
});

describe('refreshTokens', () => {
  it('returns null without a refresh token', async () => {
    expect(await refreshTokens(vi.fn(), googleCfg, '')).toBeNull();
  });
  it('returns the token json on success (with secret)', async () => {
    const f = vi.fn(async () => tokenResp(true, { id_token: 'new' }));
    expect(await refreshTokens(f, googleCfg, 'rt')).toEqual({ id_token: 'new' });
    expect(f.mock.calls[0][1].body.toString()).toContain('client_secret=sek');
  });
  it('omits secret when absent', async () => {
    const f = vi.fn(async () => tokenResp(true, { id_token: 'new' }));
    await refreshTokens(f, otherCfg, 'rt');
    expect(f.mock.calls[0][1].body.toString()).not.toContain('client_secret');
  });
  it('returns null on a non-ok response', async () => {
    const f = vi.fn(async () => tokenResp(false, {}));
    expect(await refreshTokens(f, googleCfg, 'rt')).toBeNull();
  });
  it('returns null when fetch throws', async () => {
    const f = vi.fn(async () => { throw new Error('net'); });
    expect(await refreshTokens(f, googleCfg, 'rt')).toBeNull();
  });
});

describe('bearerFromTokens', () => {
  it('defaults to id_token, then access_token, then null', () => {
    expect(bearerFromTokens({ id_token: 'i', access_token: 'a' })).toBe('i');
    expect(bearerFromTokens({ access_token: 'a' })).toBe('a');
    expect(bearerFromTokens({})).toBeNull();
    expect(bearerFromTokens(null)).toBeNull();
  });
  it('prefers access_token when asked, falling back to id_token', () => {
    expect(bearerFromTokens({ id_token: 'i', access_token: 'a' }, 'access_token')).toBe('a');
    expect(bearerFromTokens({ id_token: 'i' }, 'access_token')).toBe('i');
    expect(bearerFromTokens({}, 'access_token')).toBeNull();
  });
});
