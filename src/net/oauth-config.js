// Loads the deployment's OAuth configuration: `./config.json` (issuer +
// client_id [+ optional client_secret/audience]) followed by the issuer's
// OIDC discovery document to resolve the authorize/token endpoints.
//
// `fetchFn` is injected so this is fully testable without a network. The
// returned object is the canonical config the oauth module consumes.

/**
 * @param {(url: string, init?: object) => Promise<Response>} fetchFn
 * @param {string} basePath  e.g. location.pathname ('/sql')
 * @returns {Promise<{clientId,clientSecret,audience,authUri,tokenUri,issuer}>}
 */
export async function loadOAuthConfig(fetchFn, basePath = '') {
  const cfgUrl = basePath.replace(/\/$/, '') + '/config.json';
  const cfgResp = await fetchFn(cfgUrl, { cache: 'no-store' });
  if (!cfgResp.ok) throw new Error('GET ' + cfgUrl + ': ' + cfgResp.status);
  const cfg = await cfgResp.json();
  if (!cfg.issuer || !cfg.client_id) {
    throw new Error('config.json missing issuer or client_id');
  }
  const discUrl = cfg.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration';
  const discResp = await fetchFn(discUrl, { cache: 'no-store' });
  if (!discResp.ok) throw new Error('OIDC discovery failed: ' + discResp.status);
  const disc = await discResp.json();
  if (!disc.authorization_endpoint || !disc.token_endpoint) {
    throw new Error('OIDC discovery missing authorization_endpoint or token_endpoint');
  }
  return {
    issuer: cfg.issuer,
    clientId: cfg.client_id,
    clientSecret: cfg.client_secret || '',
    audience: cfg.audience || '',
    authUri: disc.authorization_endpoint,
    tokenUri: disc.token_endpoint,
    // Which token to send to ClickHouse: 'id_token' (default; forward-mode CH
    // that doesn't enforce audience) or 'access_token' (audience-gated CH).
    bearer: cfg.bearer === 'access_token' ? 'access_token' : 'id_token',
    // Extra params merged into the /authorize request (e.g. Auth0
    // { "organization": "org_…" }). Pass-through, no interpretation.
    authorizeParams: cfg.authorize_params && typeof cfg.authorize_params === 'object'
      ? cfg.authorize_params
      : {},
  };
}

/**
 * Memoize a loader so config + discovery are fetched once. Returns a function
 * with the same signature; a failed load is not cached (so a retry re-fetches).
 */
export function memoizeConfig(loader) {
  let promise = null;
  return (...args) => {
    if (promise) return promise;
    promise = Promise.resolve(loader(...args)).catch((e) => {
      promise = null;
      throw e;
    });
    return promise;
  };
}
