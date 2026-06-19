// OAuth2 Authorization-Code + PKCE flow, parameterized over an injected
// `fetchFn` and the resolved config from oauth-config.js. Every function here
// is a pure transform or a single fetch — no DOM, no globals.

/** True for Google's authorization endpoint (drives the offline-access form). */
export function isGoogleAuth(authUri) {
  return !!authUri && authUri.includes('accounts.google.com');
}

/**
 * Build the full /authorize redirect URL. Pure.
 * @param {object} cfg     resolved config (clientId, authUri, audience)
 * @param {object} p       { redirectUri, challenge, state }
 */
export function buildAuthorizeUrl(cfg, p) {
  const google = isGoogleAuth(cfg.authUri);
  const params = {
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
  for (const [k, v] of Object.entries(cfg.authorizeParams || {})) params[k] = v;
  return cfg.authUri + '?' + new URLSearchParams(params).toString();
}

/** Exchange an authorization code for tokens. */
export async function exchangeCodeForTokens(fetchFn, cfg, p) {
  const body = {
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
  return resp.json();
}

/**
 * Redeem a refresh_token for fresh tokens. Returns the token JSON, or null on
 * any failure (caller treats null as "must re-login").
 */
export async function refreshTokens(fetchFn, cfg, refreshToken) {
  if (!refreshToken) return null;
  try {
    const body = {
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
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Pull the bearer token to send to ClickHouse out of a token response.
 * `prefer` is 'id_token' (default) or 'access_token'; each falls back to the
 * other so a provider that returns only one still works.
 */
export function bearerFromTokens(tokens, prefer = 'id_token') {
  if (!tokens) return null;
  return prefer === 'access_token'
    ? tokens.access_token || tokens.id_token || null
    : tokens.id_token || tokens.access_token || null;
}
