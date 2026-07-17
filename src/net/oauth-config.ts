// Loads the deployment's OAuth configuration from `./config.json` — either a
// single IdP (a bare object, legacy) or several (`{ idps: [...] }`).
// `loadConfigDoc` fetches + normalizes the list; `resolveIdp` runs the issuer's
// OIDC discovery for one chosen IdP into the object the oauth module consumes.
//
// `fetchFn` is injected so this is fully testable without a network.

/** Which token to send to ClickHouse. */
export type BearerKind = 'id_token' | 'access_token';
/** How the bearer token reaches ClickHouse. */
export type ChAuthKind = 'bearer' | 'basic';
/** How a saved host entry authenticates. */
export type HostAuthKind = 'oauth' | 'basic';

/** One raw `config.json` IdP entry, as authored (untrusted, all-optional). */
export interface RawIdpEntry {
  id?: string;
  label?: string;
  issuer?: string;
  client_id?: string;
  client_secret?: string;
  audience?: string;
  bearer?: string;
  ch_auth?: string;
  basic_user_claim?: string;
  authorize_params?: Record<string, unknown>;
}

/** One raw `config.json` `hosts[]` entry, as authored. */
export interface RawHostEntry {
  label?: string;
  url?: string;
  auth?: string;
  user?: string;
  password?: string;
  idp?: string;
  insecure?: boolean;
}

/** The raw `config.json` document: a list of IdPs, or a single bare legacy IdP. */
export interface RawConfigDoc extends RawIdpEntry {
  idps?: RawIdpEntry[];
  basic_login?: boolean;
  hosts?: RawHostEntry[];
}

/** The canonical (pre-discovery) IdP descriptor `resolveIdp` and the login UI consume. */
export interface IdpDescriptor {
  id: string;
  label: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  audience: string;
  bearer: BearerKind;
  chAuth: ChAuthKind;
  basicUserClaim: string;
  authorizeParams: Record<string, unknown>;
}

/** `IdpDescriptor` extended with the OIDC-discovered endpoints. */
export interface ResolvedIdpConfig extends IdpDescriptor {
  authUri: string;
  tokenUri: string;
}

/** A saved-connection descriptor for the login host picker. */
export interface HostDescriptor {
  label: string;
  url: string;
  auth: HostAuthKind;
  user: string;
  password: string;
  idp: string;
  insecure: boolean;
}

/** `loadConfigDoc`'s normalized result. */
export interface ConfigDoc {
  idps: IdpDescriptor[];
  basicLogin: boolean;
  hosts: HostDescriptor[];
}

/** OIDC discovery document fields this module reads. */
interface OidcDiscoveryDoc {
  authorization_endpoint?: string;
  token_endpoint?: string;
}

/** Host of an issuer URL, used as the default id/label. Falls back to the raw string. */
function idpHost(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

// Friendly provider names so the sign-in button reads "Continue with GitHub"
// rather than "Continue with altinity.auth0.com" when a config sets no `label`.
const CONNECTION_NAMES: Record<string, string> = { github: 'GitHub', google: 'Google', 'google-oauth2': 'Google', gitlab: 'GitLab' };
const ISSUER_NAMES: Record<string, string> = { 'accounts.google.com': 'Google', 'login.microsoftonline.com': 'Microsoft', 'github.com': 'GitHub' };

/**
 * Button label for an IdP. Prefers an explicit `label`; else derives one from an
 * Auth0-style `authorize_params.connection` (e.g. github → "GitHub"), then a
 * known issuer host (accounts.google.com → "Google"); finally the issuer host.
 */
function idpLabel(e: RawIdpEntry): string {
  if (e.label) return e.label;
  const conn = e.authorize_params && e.authorize_params.connection;
  if (conn) {
    const c = String(conn).toLowerCase();
    return CONNECTION_NAMES[c] || (c.charAt(0).toUpperCase() + c.slice(1));
  }
  // `!`: `idpLabel` is only ever called from `normalizeEntry`, right after its
  // own `!e.issuer` guard already confirmed a truthy issuer — the original
  // .js read `e.issuer` bare here.
  const host = idpHost(e.issuer!);
  return ISSUER_NAMES[host] || host;
}

/** Map one raw config.json entry to the canonical (pre-discovery) IdP descriptor. */
function normalizeEntry(e: RawIdpEntry): IdpDescriptor {
  if (!e || !e.issuer || !e.client_id) {
    throw new Error('config.json IdP missing issuer or client_id');
  }
  return {
    id: e.id || idpHost(e.issuer),
    label: idpLabel(e),
    issuer: e.issuer,
    clientId: e.client_id,
    clientSecret: e.client_secret || '',
    audience: e.audience || '',
    // Which token to send to ClickHouse: 'id_token' (default; forward-mode CH)
    // or 'access_token' (audience-gated CH).
    bearer: e.bearer === 'access_token' ? 'access_token' : 'id_token',
    // How the token reaches ClickHouse: 'bearer' (default; Authorization: Bearer
    // <jwt>) or 'basic' (Authorization: Basic base64(user:jwt), for OSS CH
    // behind a verifier such as ch-jwt-verify).
    chAuth: e.ch_auth === 'basic' ? 'basic' : 'bearer',
    // For ch_auth=basic, which JWT claim becomes the Basic username (= the CH
    // user the verifier must return). Empty → default chain (email →
    // preferred_username → sub). Set e.g. 'nickname' when an IdP must map to a
    // CH username distinct from another IdP's (avoids same-name collisions —
    // e.g. a token-directory Bearer user vs. a static http user on Antalya CH).
    basicUserClaim: e.basic_user_claim || '',
    // Extra params merged into /authorize (e.g. Auth0 { organization: 'org_…' }).
    authorizeParams: e.authorize_params && typeof e.authorize_params === 'object'
      ? e.authorize_params
      : {},
  };
}

/**
 * Map one raw `hosts[]` entry to a saved-connection descriptor for the login
 * picker: `{ label, url, auth, user, password, idp, insecure }`. `auth` is 'oauth'
 * (sign in via the named `idp`, querying `url` cross-origin) or 'basic' (prefill
 * the credentials form with `url`/`user`/`password`). `insecure` flags an
 * accept-invalid-certificate host — the browser can't reach it until the user
 * trusts the cert, so the picker surfaces that step (see renderLogin).
 */
function normalizeHost(h: RawHostEntry | null | undefined): HostDescriptor {
  const e = h || {};
  return {
    label: e.label || e.url || '',
    url: e.url || '',
    auth: e.auth === 'oauth' ? 'oauth' : 'basic',
    user: e.user || '',
    password: e.password || '',
    idp: e.idp || '',
    insecure: !!e.insecure,
  };
}

/**
 * Fetch config.json and normalize to `{ idps: [descriptor, ...], basicLogin, hosts }`.
 * Accepts a list (`{ idps: [...] }`) or a single bare object (legacy) wrapped
 * into one entry. An IdP-less config (no `idps`, no `issuer`) is valid — it
 * describes a credentials-only deployment, so `idps` comes back empty rather
 * than throwing. `basicLogin` (top-level `basic_login`, default true) lets an
 * SSO-only deployment hide the username/password path.
 * @param basePath  e.g. location.pathname ('/sql')
 */
export async function loadConfigDoc(fetchFn: typeof fetch, basePath = ''): Promise<ConfigDoc> {
  const cfgUrl = basePath.replace(/\/$/, '') + '/config.json';
  const cfgResp = await fetchFn(cfgUrl, { cache: 'no-store' });
  if (!cfgResp.ok) throw new Error('GET ' + cfgUrl + ': ' + cfgResp.status);
  const cfg = await cfgResp.json() as RawConfigDoc;
  // A list, a legacy bare IdP object, or neither (credentials-only → no IdPs).
  const list: RawIdpEntry[] = Array.isArray(cfg.idps)
    ? cfg.idps
    : (cfg.issuer || cfg.client_id) ? [cfg] : [];
  return {
    idps: list.map(normalizeEntry),
    basicLogin: cfg.basic_login !== false,
    // Optional saved-connection list for the login host picker (npm run local
    // fills it from ~/.clickhouse-client/config.xml). Empty when absent.
    hosts: Array.isArray(cfg.hosts) ? cfg.hosts.map(normalizeHost) : [],
  };
}

/**
 * Resolve one IdP's authorize/token endpoints via OIDC discovery. Returns the
 * descriptor extended with `authUri`/`tokenUri` — the object oauth.js consumes.
 */
export async function resolveIdp(fetchFn: typeof fetch, idp: IdpDescriptor): Promise<ResolvedIdpConfig> {
  const discUrl = idp.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration';
  const discResp = await fetchFn(discUrl, { cache: 'no-store' });
  if (!discResp.ok) throw new Error('OIDC discovery failed: ' + discResp.status);
  const disc = await discResp.json() as OidcDiscoveryDoc;
  if (!disc.authorization_endpoint || !disc.token_endpoint) {
    throw new Error('OIDC discovery missing authorization_endpoint or token_endpoint');
  }
  return { ...idp, authUri: disc.authorization_endpoint, tokenUri: disc.token_endpoint };
}

/**
 * Memoize a loader so the config document is fetched once. Returns a function
 * with the same signature; a failed load is not cached (so a retry re-fetches).
 */
export function memoizeConfig<A extends unknown[], R>(loader: (...args: A) => R | Promise<R>): (...args: A) => Promise<R> {
  let promise: Promise<R> | null = null;
  return (...args: A) => {
    if (promise) return promise;
    promise = Promise.resolve(loader(...args)).catch((e) => {
      promise = null;
      throw e;
    });
    return promise;
  };
}
