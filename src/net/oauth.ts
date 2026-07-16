// OAuth2 Authorization-Code + PKCE flow, parameterized over an injected
// `fetchFn` and the resolved config from oauth-config.js. Every function here
// is a pure transform or a single fetch — no DOM, no globals.

import type { ResolvedIdpConfig } from './oauth-config.js';

/** The params `buildAuthorizeUrl` merges into the /authorize redirect. */
export interface AuthorizeParams {
  redirectUri: string;
  challenge: string;
  state: string;
}

/** The params `exchangeCodeForTokens` posts to the token endpoint. */
export interface CodeExchangeParams {
  code: string;
  verifier: string;
  redirectUri: string;
}

/** A token-endpoint JSON response — only `id_token`/`access_token` are read
 *  here, but a provider may return other fields (e.g. `refresh_token`),
 *  passed through untouched by `exchangeCodeForTokens`/`refreshTokens`. */
export interface TokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  [key: string]: unknown;
}

/** True for Google's authorization endpoint (drives the offline-access form). */
export function isGoogleAuth(authUri: string | null | undefined): boolean {
  return !!authUri && authUri.includes('accounts.google.com');
}

/**
 * Build the full /authorize redirect URL. Pure.
 * @param cfg  resolved config (clientId, authUri, audience)
 */
export function buildAuthorizeUrl(cfg: ResolvedIdpConfig, p: AuthorizeParams): string {
  const google = isGoogleAuth(cfg.authUri);
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: p.redirectUri,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    scope: google ? 'openid email profile' : 'openid email profile offline_access',
    state: p.state,
  };
  if (cfg.audience) params.audience = cfg.audience;
  if (google) params.access_type = 'offline';
  // Extra pass-through params (e.g. Auth0 `organization`).
  for (const [k, v] of Object.entries(cfg.authorizeParams || {})) params[k] = String(v);
  return cfg.authUri + '?' + new URLSearchParams(params).toString();
}

/** Exchange an authorization code for tokens. */
export async function exchangeCodeForTokens(fetchFn: typeof fetch, cfg: ResolvedIdpConfig, p: CodeExchangeParams): Promise<TokenResponse> {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: cfg.clientId,
    code_verifier: p.verifier,
  };
  if (cfg.clientSecret) body.client_secret = cfg.clientSecret;
  const resp = await fetchFn(cfg.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!resp.ok) throw new Error('Token exchange failed: ' + (await resp.text()));
  return resp.json() as Promise<TokenResponse>;
}

/**
 * Redeem a refresh_token for fresh tokens. Returns the token JSON, or null on
 * any failure (caller treats null as "must re-login").
 */
export async function refreshTokens(fetchFn: typeof fetch, cfg: ResolvedIdpConfig, refreshToken: string | null | undefined): Promise<TokenResponse | null> {
  if (!refreshToken) return null;
  try {
    const body: Record<string, string> = {
      grant_type: 'refresh_token',
      client_id: cfg.clientId,
      refresh_token: refreshToken,
    };
    if (cfg.clientSecret) body.client_secret = cfg.clientSecret;
    const resp = await fetchFn(cfg.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    if (!resp.ok) return null;
    return await resp.json() as TokenResponse;
  } catch {
    return null;
  }
}

/**
 * Pull the bearer token to send to ClickHouse out of a token response.
 * `prefer` is 'id_token' (default) or 'access_token'; each falls back to the
 * other so a provider that returns only one still works.
 */
export function bearerFromTokens(tokens: TokenResponse | null | undefined, prefer: 'id_token' | 'access_token' = 'id_token'): string | null {
  if (!tokens) return null;
  return prefer === 'access_token'
    ? tokens.access_token || tokens.id_token || null
    : tokens.id_token || tokens.access_token || null;
}
