// #276 Phase 2's ConnectionSession — auth + config + ClickHouse connection
// lifecycle (OAuth PKCE login/refresh, Basic probing, IdP config resolution),
// constructible without App/AppState/DOM; no imports
// from src/ui/** or src/editor/** (check:arch enforces). Rendering is the
// shell's job — auth loss surfaces through the injected `onAuthLost` callback,
// never a render/toast call. This is a port of the auth/config/connection
// lifecycle that used to live inline in src/ui/app.ts — comments
// below are carried over, adapted only where the code itself moved (e.g.
// `app.token` becomes a closed-over local, `ss`/`loc`/`win` become the
// injected `deps.storage`/`deps.location`/`deps.win`, and a couple of
// `app.renderApp()`/`renderLoginApp()` calls are gone because rendering isn't
// this module's job any more — see each call site below for the specific note).

import { decodeJwtPayload, isTokenExpired } from '../core/jwt.js';
import { generatePKCE, randomState } from '../core/pkce.js';
import type { PkceCrypto } from '../core/pkce.js';
import { resolveTarget } from '../core/target.js';
import { buildAuthorizeUrl, refreshTokens, bearerFromTokens } from '../net/oauth.js';
import { memoizeConfig, loadConfigDoc, resolveIdp } from '../net/oauth-config.js';
import type { ConfigDoc, ResolvedIdpConfig, ChAuthKind } from '../net/oauth-config.js';
import type { ChCtx as NetChCtx, queryJson } from '../net/ch-client.js';

// ── Injected dependency seam ─────────────────────────────────────────────────

/** The sessionStorage-like surface used by OAuth PKCE token bookkeeping. */
export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The minimal Web Crypto surface PKCE generation needs — real Web Crypto
 *  (browser `crypto` or Node's `webcrypto`) or an injectable stub: exactly
 *  `core/pkce.js`'s own `PkceCrypto` seam, re-exported under this session's
 *  naming so deps read uniformly. A real `Crypto` object satisfies it without
 *  a cast; a test stub only implements two members. */
export type SessionCrypto = PkceCrypto;

/** Every side effect this session needs, injected as a narrow bag — mirrors
 *  `query-execution-service.ts`'s own `QueryExecutionDeps` seam. Production
 *  wires the real browser/env objects; tests inject plain stubs. */
export interface ConnectionSessionDeps {
  fetch: typeof fetch;
  storage: SessionStorageLike;
  /** `href` is WRITTEN (the OAuth redirect assigns it) as well as read. */
  location: { origin: string; pathname: string; search: string; href: string };
  crypto: SessionCrypto;
  /** Basic-auth sign-in probe. */
  queryJson: typeof queryJson;
  /** Auth was lost (no token / expired-and-unrefreshable / CH rejected a
   *  valid login). The session never renders — it calls this and lets the
   *  shell decide how to show the login screen. */
  onAuthLost: (detail?: string) => void;
}

// ── The ClickHouse auth context ──────────────────────────────────────────────

/** The live ClickHouse auth context this session owns — `origin`/
 *  `authConfirmed` are mutated IN PLACE by `signOut`/`connectBasic`/
 *  `applyAuthSnapshot` here, and by `net/ch-client.js`'s `authedFetch` (its
 *  own one-shot latch) — this ONE object is never reconstructed, only ever
 *  mutated, so a caller holding a reference (or passing it straight into
 *  ch-client's functions) always observes the current auth state. Assignable
 *  to `net/ch-client.js`'s own `ChCtx` (whose `authConfirmed`/`authHeader`
 *  are optional there, since some callers build a throwaway ctx without
 *  them — this session always supplies both, matching the stricter
 *  `ui/app.types.ts` `ChCtx` shape the rest of the app already reads through,
 *  redeclared here rather than imported since `src/application/**` may not
 *  import `src/ui/**`). */
export interface SessionChCtx {
  fetch: typeof fetch;
  origin: string;
  authConfirmed: boolean;
  getToken(): Promise<string | null>;
  refresh(): Promise<boolean>;
  authHeader(token: string): string;
  onSignedOut(detail?: string): void;
}

// ── The session ───────────────────────────────────────────────────────────

/** The auth + config + ClickHouse connection lifecycle, constructible without
 *  App/AppState/DOM. See `createConnectionSession` for construction/seeding
 *  and each method below for the ported behavior. */
export interface ConnectionSession {
  readonly basePath: string;
  readonly hostHint: string;
  readonly chCtx: SessionChCtx;

  // state accessors (test-support + shell display; do not log values)
  token(): string | null;
  refreshToken(): string | null;
  authMode(): 'oauth' | 'basic';
  idpId(): string | null;
  chAuth(): ChAuthKind;
  basicUserClaim(): string;
  isSignedIn(): boolean;
  email(): string;
  host(): string;

  // config
  loadIdps(): Promise<ConfigDoc>;
  selectIdp(id: string): void;
  resolveConfig(): Promise<ResolvedIdpConfig>;
  ensureConfig(): Promise<ResolvedIdpConfig | null>;

  // lifecycle
  setTokens(id: string, refresh?: string): void;
  getToken(): Promise<string | null>;
  beginOAuth(idpId?: string, targetOrigin?: string): Promise<void>;
  connectBasic(input: { username: string; password: string; host?: string }): Promise<void>;
  signOut(): void;
  ensureFreshToken(): Promise<boolean>;

}

export function createConnectionSession(deps: ConnectionSessionDeps): ConnectionSession {
  const { storage: ss, location: loc, crypto: cryptoObj, fetch: fetchFn, queryJson: queryJsonFn } = deps;

  // Two ways to be signed in: OAuth (a JWT bearer, the default) or 'basic' —
  // a ClickHouse username/password sent as Authorization: Basic, optionally
  // against another host. A live basic session is restored from sessionStorage
  // (ch_basic_*), mirroring how the OAuth token is restored below.
  let token: string | null = ss.getItem('oauth_id_token');
  let refreshTok: string | null = ss.getItem('oauth_refresh_token');
  let authMode: 'oauth' | 'basic' = ss.getItem('ch_basic_auth') ? 'basic' : 'oauth';
  const basicCreds = (): string | null => ss.getItem('ch_basic_auth');
  const basicUser = (): string => ss.getItem('ch_basic_user') || '';
  const originHost = (o: string): string => { try { return new URL(o).host; } catch { return ''; } };

  // config.json may list several IdPs. Fetch the doc once; resolve OIDC
  // discovery per selected IdP. The chosen IdP id is persisted so it survives
  // the OAuth redirect (like oauth_state) and drives token exchange/refresh.
  const basePath = loc.pathname.replace(/\/+$/, '');
  const loadDoc = memoizeConfig(() => loadConfigDoc(fetchFn, basePath));
  const resolvedCache = new Map<string, Promise<ResolvedIdpConfig>>();
  let idpId: string | null = ss.getItem('oauth_idp') || null;
  function selectIdp(id: string): void { idpId = id; ss.setItem('oauth_idp', id); }
  async function resolveConfig(): Promise<ResolvedIdpConfig> {
    const { idps } = await loadDoc();
    const chosen = idps.find((i) => i.id === idpId) || idps[0];
    idpId = chosen.id;
    if (!resolvedCache.has(chosen.id)) resolvedCache.set(chosen.id, resolveIdp(fetchFn, chosen));
    return resolvedCache.get(chosen.id)!;
  }

  // A `?host=` query param pre-fills the credential server address on the login
  // screen (and disables SSO, which only targets the serving host).
  const hostHint = new URLSearchParams(loc.search || '').get('host') || '';

  // isSignedIn uses ZERO skew (bufferSeconds=0) — it's a point-in-time "is the
  // token still technically valid right now" check (drives whether the
  // workbench renders at all). getToken (below) uses the default 60s skew
  // instead — it drives whether a QUERY is about to be sent with a token that
  // will likely have expired by the time the request lands, so it refreshes
  // proactively before that happens. Same isTokenExpired call, deliberately
  // different bufferSeconds for deliberately different questions.
  const isSignedIn = (): boolean => (authMode === 'basic'
    ? !!basicCreds()
    : !!token && !isTokenExpired(token, 0));

  // The CH-facing identity for the current token — what currentUser() will be:
  // for ch_auth=basic it's the Basic username (honouring basicUserClaim); for
  // bearer it's the email the token-processor keys on. Shared by authHeader and
  // the header display so the UI never shows a different claim than CH sees.
  function chUsername(p: Record<string, unknown>): string {
    return String((chAuthVal === 'basic' && basicUserClaimVal && p[basicUserClaimVal])
      || p.email || p.preferred_username || p.sub || '');
  }
  const email = (): string => (authMode === 'basic'
    ? basicUser()
    : chUsername(decodeJwtPayload(token)));

  function setTokens(id: string, refresh?: string): void {
    token = id;
    ss.setItem('oauth_id_token', id);
    if (refresh) {
      refreshTok = refresh;
      ss.setItem('oauth_refresh_token', refresh);
    }
    // The PKCE verifier + CSRF state are one-shot — done with them once we hold
    // tokens. (The refresh path also lands here; they're already gone → no-op.)
    ss.removeItem('oauth_verifier');
    ss.removeItem('oauth_state');
  }
  function clearTokens(): void {
    token = null;
    refreshTok = null;
    idpId = null;
    authMode = 'oauth';
    chCtx.origin = loc.origin;
    chCtx.authConfirmed = false; // a fresh sign-in starts unconfirmed again
    ['oauth_id_token', 'oauth_refresh_token', 'oauth_verifier', 'oauth_state', 'oauth_return_route', 'oauth_idp', 'oauth_origin',
      'ch_basic_auth', 'ch_basic_user', 'ch_basic_origin'].forEach((k) => ss.removeItem(k));
  }
  // `signOut` is exactly today's app.ts `clearTokens()` — no render. (app.ts's
  // own `app.signOut` additionally re-renders the login screen; that's the
  // shell's job now, done by whatever caller notices signOut() was called.)
  const signOut = (): void => clearTokens();

  // --- OAuth -------------------------------------------------------------
  async function beginOAuth(idpArg?: string, targetOrigin?: string): Promise<void> {
    if (idpArg) selectIdp(idpArg);
    // A picked saved-connection can target another cluster: stash its origin so
    // the rebuilt chCtx (after the redirect reload) POSTs the bearer there.
    // Survives the redirect like oauth_state/oauth_idp; cleared for serving-host SSO.
    if (targetOrigin) ss.setItem('oauth_origin', targetOrigin);
    else ss.removeItem('oauth_origin');
    const cfg = await resolveConfig();
    const { verifier, challenge } = await generatePKCE(cryptoObj);
    const state = randomState(cryptoObj);
    ss.setItem('oauth_verifier', verifier);
    ss.setItem('oauth_state', state);
    const returnParams = new URLSearchParams(loc.search);
    ['code', 'state', 'scope', 'authuser', 'prompt', 'error', 'error_description', 'error_uri']
      .forEach((key) => returnParams.delete(key));
    const returnSearch = returnParams.toString();
    ss.setItem('oauth_return_route', JSON.stringify({
      state, search: returnSearch ? `?${returnSearch}` : '',
    }));
    loc.href = buildAuthorizeUrl(cfg, {
      redirectUri: loc.origin + basePath,
      challenge,
      state,
    });
  }

  async function refresh(): Promise<boolean> {
    // Basic credentials don't expire and can't be refreshed; a surviving 401
    // means the password is wrong → authedFetch falls through to onSignedOut.
    if (authMode === 'basic') return false;
    const cfg = await resolveConfig();
    const tokens = await refreshTokens(fetchFn, cfg, refreshTok);
    const bearer = bearerFromTokens(tokens, cfg.bearer);
    if (!bearer) return false;
    // `bearer` is only ever truthy when `tokens` (its own source) is non-null.
    setTokens(bearer, tokens?.refresh_token);
    return true;
  }

  async function getToken(): Promise<string | null> {
    // In basic mode the stored credential is the "token" authedFetch carries.
    if (authMode === 'basic') return basicCreds();
    if (!token) return null;
    if (!isTokenExpired(token)) return token;
    if (await refresh()) return token;
    clearTokens();
    return null;
  }

  // --- ClickHouse context --------------------------------------------------
  // How the token is presented to CH. 'bearer' (token_processor) or 'basic'
  // (OSS + a verifier like ch-jwt-verify, where the JWT is the Basic password
  // and the username is the token's email). Resolved from config by ensureConfig.
  let chAuthVal: ChAuthKind = 'bearer';
  // Which claim becomes the Basic username (per-IdP, from config). Empty → the
  // default chain. Lets one IdP map to a CH username distinct from another's.
  let basicUserClaimVal = '';
  function authHeader(t: string): string {
    // Basic mode: `t` is already base64(user:pass) — send it verbatim.
    if (authMode === 'basic') return 'Basic ' + t;
    if (chAuthVal !== 'basic') return 'Bearer ' + t;
    const user = chUsername(decodeJwtPayload(t));
    return 'Basic ' + btoa(unescape(encodeURIComponent(user + ':' + t)));
  }
  const chCtx: SessionChCtx = {
    fetch: fetchFn,
    // Where queries POST: the serving origin for OAuth, or the (possibly
    // cross-origin) target chosen at credential sign-in for basic mode.
    origin: authMode === 'basic'
      ? (ss.getItem('ch_basic_origin') || loc.origin)
      : (ss.getItem('oauth_origin') || loc.origin),
    // Flips true after the first 2xx; gates whether a later 401/403 is treated
    // as a sign-in failure (only before auth is confirmed) or a query error.
    authConfirmed: false,
    getToken,
    refresh,
    authHeader,
    // detail is set when CH rejects a *valid* login (authorization denial); the
    // no-arg calls (no token / expired + refresh failed) fall back to expiry.
    onSignedOut: (detail?: string) => {
      clearTokens();
      deps.onAuthLost(detail || 'Your session expired — please sign in again.');
    },
  };

  // Load config (once) and apply the CH auth mode before any query runs.
  // Fail-soft: if config can't be loaded we keep the current mode (bearer)
  // rather than blocking the query.
  async function ensureConfig(): Promise<ResolvedIdpConfig | null> {
    // Basic mode needs no OAuth config — the auth scheme is fixed.
    if (authMode === 'basic') return null;
    try {
      const cfg = await resolveConfig();
      chAuthVal = cfg.chAuth;
      basicUserClaimVal = cfg.basicUserClaim || '';
      return cfg;
    } catch {
      return null;
    }
  }

  // --- credentials (HTTP Basic) sign-in ----------------------------------
  // Validate a ClickHouse username/password against `host` (blank → the serving
  // host) with a probe query, then commit the session (NO render — the shell
  // re-renders after connectBasic resolves; app.ts's own `connect` used to call
  // `app.renderApp()` here, which is the shell's job now). The probe uses a
  // throwaway ctx so a bad password surfaces CH's own reason here (rejected as
  // a thrown Error) instead of auto-triggering onAuthLost.
  async function connectBasic({ username, password, host }: { username: string; password: string; host?: string }): Promise<void> {
    const user = String(username || '').trim();
    const target = resolveTarget(host, loc.origin);
    const creds = btoa(unescape(encodeURIComponent(user + ':' + (password || ''))));
    const probeCtx: NetChCtx = {
      fetch: fetchFn,
      origin: target,
      getToken: async () => creds,
      authHeader: () => 'Basic ' + creds,
      refresh: async () => false,
      onSignedOut: (detail?: string) => { throw new Error(detail || 'Authentication failed'); },
    };
    await queryJsonFn(probeCtx, 'SELECT 1');
    // Probe passed → commit the session and switch the live ctx to the target.
    authMode = 'basic';
    ss.setItem('ch_basic_auth', creds);
    ss.setItem('ch_basic_user', user);
    ss.setItem('ch_basic_origin', target);
    chCtx.origin = target;
  }

  // --- dashboard (#149 D1) -------------------------------------------------
  // ensureConfig + getToken, resolving (and refreshing) the auth token ONCE.
  // The dashboard calls this before fanning tiles out, so the tiles never each
  // race an expired-token refresh (a rotating refresh token used N-ways at once
  // would invalidate itself), and a single sign-out is handled by the caller
  // instead of N tiles each firing onSignedOut. Also used by bootstrap to
  // refresh a handed-off-but-expired token before falling back to login.
  async function ensureFreshToken(): Promise<boolean> {
    await ensureConfig();
    return !!(await getToken());
  }

  return {
    basePath,
    hostHint,
    chCtx,
    token: () => token,
    refreshToken: () => refreshTok,
    authMode: () => authMode,
    idpId: () => idpId,
    chAuth: () => chAuthVal,
    basicUserClaim: () => basicUserClaimVal,
    isSignedIn,
    email,
    // The host queries actually go to. chCtx.origin already resolves to the basic
    // target, the picked OAuth cluster (oauth_origin), or the serving origin — so a
    // cross-origin OAuth connection shows the cluster, not localhost. (URL.host drops
    // a default :443, so a 443 cluster shows a bare hostname; an 8443 one shows :8443.)
    host: () => originHost(chCtx.origin) || 'clickhouse',
    loadIdps: loadDoc,
    selectIdp,
    resolveConfig,
    ensureConfig,
    setTokens,
    getToken,
    beginOAuth,
    connectBasic,
    signOut,
    ensureFreshToken,
  };
}
