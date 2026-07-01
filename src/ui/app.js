// The application controller. `createApp(env)` returns the `app` object every
// render module receives: state, DOM refs, persistence helpers, the ClickHouse
// fetch context, and the action callbacks. All environment access (document,
// window, location, fetch, crypto, sessionStorage) is injected so the whole
// controller is testable under happy-dom with stubs.

import { h, zoomScale, fixedAnchor } from './dom.js';
import { Icon } from './icons.js';
import {
  createState, activeTab, KEYS, recordHistory, recordScriptHistory, saveQuery, savedForTab, tabChart, normalizeRowLimit,
} from '../state.js';
import { splitStatements, isRowReturning, leadingKeyword } from '../core/sql-split.js';
import { parseSelectResult, firstRowPreview, SELECT_ROW_CAP } from '../core/script-result.js';
import { saveJSON, saveStr } from '../core/storage.js';
import { decodeJwtPayload, isTokenExpired } from '../core/jwt.js';
import { sqlString, inferQueryName, shortVersion, supportsExplainPretty, userShortName, withStatementBreak, detectSqlFormat, isSchemaMutatingSql, prepareExportSql, formatBytes } from '../core/format.js';
import { EXPLAIN_VIEWS, parseExplain, detectExplainView, buildExplainQuery } from '../core/explain.js';
import { buildSchemaGraph, expandLineage } from '../core/schema-graph.js';
import { buildCardGraph } from '../core/schema-cards.js';
import { resolveTarget } from '../core/target.js';
import { toTSV, formatFileMeta, exportFilename, scriptExportName } from '../core/export.js';
import { newResult, applyStreamLine, parseErrorPos, findExceptionFrame } from '../core/stream.js';
import { encodeShare } from '../core/share.js';
import { assembleReferenceData, buildCompletions } from '../core/completions.js';
import { generatePKCE, randomState } from '../core/pkce.js';
import { viewportZoom } from '../core/zoom-support.js';
import * as oauthCfg from '../net/oauth-config.js';
import * as oauth from '../net/oauth.js';
import * as ch from '../net/ch-client.js';
import { mountEditor, insertAtCursor, replaceEditor, SCHEMA_GRAPH_MIME } from './editor.js';
import { renderTabs, selectTab, newTab, closeTab, loadIntoNewTab } from './tabs.js';
import { effect, batch } from '@preact/signals-core';
import { renderSchema } from './schema.js';
import { renderResults } from './results.js';
import { openSchemaView } from './explain-graph.js';
import { openDetailPane } from './schema-detail.js';
import { renderSavedHistory } from './saved-history.js';
import { libraryControls, renderLibraryTitle } from './file-menu.js';
import { renderLogin } from './login.js';
import { openShortcuts } from './shortcuts.js';
import { startDrag } from './splitters.js';
import { flashToast } from './toast.js';

export function createApp(env = {}) {
  const doc = env.document || document;
  const win = env.window || window;
  const loc = env.location || win.location;
  const fetchFn = env.fetch || win.fetch.bind(win);
  const cryptoObj = env.crypto || win.crypto;
  const ss = env.sessionStorage || win.sessionStorage;

  const app = {
    state: createState(),
    dom: {},
    root: env.root || doc.getElementById('root'),
    document: doc,
    token: ss.getItem('oauth_id_token'),
    refreshToken: ss.getItem('oauth_refresh_token'),
    // Charting seam: the Chart.js constructor (injected so tests stub it) and a
    // CSS-custom-property reader (canvas needs real colors, not `var(--x)`).
    Chart: env.Chart || win.Chart,
    cssVar: env.cssVar || ((name) => win.getComputedStyle(doc.documentElement).getPropertyValue(name)),
    // Pipeline-graph layout seam: dagre (injected like Chart). The DOT parser and
    // SVG drawer are ours; dagre only computes node positions + edge bend points.
    Dagre: env.Dagre || win.dagre,
    // The schema graph opens in a real browser tab driven by this window. All
    // three are injected seams: openWindow so tests can stub window.open,
    // stylesText/faviconHref so the child tab can inline the page's CSS and
    // favicon (about:blank ships neither).
    openWindow: env.openWindow || ((...a) => win.open(...a)),
    stylesText: env.stylesText || (doc.querySelector('style') ? doc.querySelector('style').textContent : ''),
    faviconHref: env.faviconHref
      || (doc.querySelector('link[rel~="icon"]') ? doc.querySelector('link[rel~="icon"]').getAttribute('href') : ''),
    // Streaming Export (issue #87) needs the File System Access API and a
    // secure context; both are injected seams (like openWindow) so tests can
    // stub them without a real browser. Fixed for the session (browser +
    // origin don't change), so this is computed once rather than as a signal.
    showSaveFilePicker: env.showSaveFilePicker
      || (typeof win.showSaveFilePicker === 'function' ? win.showSaveFilePicker.bind(win) : null),
    // Script export (issue #99) needs a whole directory, not one file — same
    // File System Access family as showSaveFilePicker (every browser that has
    // one has the other), so this is the same seam pattern.
    showDirectoryPicker: env.showDirectoryPicker
      || (typeof win.showDirectoryPicker === 'function' ? win.showDirectoryPicker.bind(win) : null),
    isSecureContext: env.isSecureContext != null ? env.isSecureContext : !!win.isSecureContext,
    // Build stamp ("v0.1.4 (abc1234)") injected at build time via main.js; shown
    // in the user menu so a bug report can be tied to a build. 'dev' in tests /
    // an un-built run where the placeholder was never replaced.
    build: env.build || 'dev',
  };
  // Chromium (+ a secure context) only — Firefox/Safari and plain-HTTP have no
  // File System Access API. The Export button feature-detects this at build
  // time and renders aria-disabled + a tooltip rather than hiding outright.
  app.canExport = () => !!app.showSaveFilePicker && app.isSecureContext;
  // The script-export path additionally needs a directory picker (defensive —
  // the button's own enabled/tooltip state stays gated on canExport, since every
  // browser with showSaveFilePicker also has showDirectoryPicker).
  app.canExportScript = () => !!app.showDirectoryPicker && app.isSecureContext;

  // Two ways to be signed in: OAuth (a JWT bearer, the default) or 'basic' —
  // a ClickHouse username/password sent as Authorization: Basic, optionally
  // against another host. A live basic session is restored from sessionStorage
  // (ch_basic_*), mirroring how the OAuth token is restored above.
  app.authMode = ss.getItem('ch_basic_auth') ? 'basic' : 'oauth';
  const basicCreds = () => ss.getItem('ch_basic_auth');
  const basicUser = () => ss.getItem('ch_basic_user') || '';
  const originHost = (o) => { try { return new URL(o).host; } catch { return ''; } };

  // config.json may list several IdPs. Fetch the doc once; resolve OIDC
  // discovery per selected IdP. The chosen IdP id is persisted so it survives
  // the OAuth redirect (like oauth_state) and drives token exchange/refresh.
  const loadDoc = oauthCfg.memoizeConfig(() => oauthCfg.loadConfigDoc(fetchFn, loc.pathname));
  const resolvedCache = new Map();
  app.idpId = ss.getItem('oauth_idp') || null;
  function selectIdp(id) { app.idpId = id; ss.setItem('oauth_idp', id); }
  async function resolveConfig() {
    const { idps } = await loadDoc();
    const chosen = idps.find((i) => i.id === app.idpId) || idps[0];
    app.idpId = chosen.id;
    if (!resolvedCache.has(chosen.id)) resolvedCache.set(chosen.id, oauthCfg.resolveIdp(fetchFn, chosen));
    return resolvedCache.get(chosen.id);
  }
  app.loadIdps = loadDoc;
  app.selectIdp = selectIdp;

  // --- persistence -------------------------------------------------------
  app.saveJSON = saveJSON;
  app.saveStr = saveStr;
  app.savePref = (name, value) => saveStr(KEYS[name], String(value));
  app.FileReader = env.FileReader || win.FileReader;
  // Exposed seam for the header File menu (file-menu.js): the file-download
  // helper (defined below). The library title (name + dirty dot) repaints via a
  // libraryName/libraryDirty effect, so callers just mutate those signals.
  app.downloadFile = downloadFile;

  // --- identity ----------------------------------------------------------
  // The host queries actually go to. chCtx.origin already resolves to the basic
  // target, the picked OAuth cluster (oauth_origin), or the serving origin — so a
  // cross-origin OAuth connection shows the cluster, not localhost. (URL.host drops
  // a default :443, so a 443 cluster shows a bare hostname; an 8443 one shows :8443.)
  app.host = () => originHost(chCtx.origin) || 'clickhouse';
  app.activeTab = () => activeTab(app.state);
  // A `?host=` query param pre-fills the credential server address on the login
  // screen (and disables SSO, which only targets the serving host).
  app.hostHint = new URLSearchParams(loc.search || '').get('host') || '';
  app.isSignedIn = () => (app.authMode === 'basic'
    ? !!basicCreds()
    : !!app.token && !isTokenExpired(app.token, 0));
  // The CH-facing identity for the current token — what currentUser() will be:
  // for ch_auth=basic it's the Basic username (honouring basicUserClaim); for
  // bearer it's the email the token-processor keys on. Shared by authHeader and
  // the header display so the UI never shows a different claim than CH sees.
  function chUsername(p) {
    return (app.chAuth === 'basic' && app.basicUserClaim && p[app.basicUserClaim])
      || p.email || p.preferred_username || p.sub || '';
  }
  app.chUsername = chUsername;
  app.email = () => (app.authMode === 'basic'
    ? basicUser()
    : chUsername(decodeJwtPayload(app.token)));

  function setTokens(id, refresh) {
    app.token = id;
    ss.setItem('oauth_id_token', id);
    if (refresh) {
      app.refreshToken = refresh;
      ss.setItem('oauth_refresh_token', refresh);
    }
    // The PKCE verifier + CSRF state are one-shot — done with them once we hold
    // tokens. (The refresh path also lands here; they're already gone → no-op.)
    ss.removeItem('oauth_verifier');
    ss.removeItem('oauth_state');
  }
  function clearTokens() {
    app.token = null;
    app.refreshToken = null;
    app.idpId = null;
    app.authMode = 'oauth';
    chCtx.origin = loc.origin;
    chCtx.authConfirmed = false; // a fresh sign-in starts unconfirmed again
    ['oauth_id_token', 'oauth_refresh_token', 'oauth_verifier', 'oauth_state', 'oauth_idp', 'oauth_origin',
      'ch_basic_auth', 'ch_basic_user', 'ch_basic_origin'].forEach((k) => ss.removeItem(k));
  }
  app.setTokens = setTokens;
  app.clearTokens = clearTokens;
  app.loadConfig = resolveConfig;

  app.signOut = () => { clearTokens(); renderLogin(app); };
  app.showLogin = (msg) => renderLogin(app, msg);

  // --- OAuth -------------------------------------------------------------
  async function login(idpId, targetOrigin) {
    if (idpId) selectIdp(idpId);
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
    loc.href = oauth.buildAuthorizeUrl(cfg, {
      redirectUri: loc.origin + loc.pathname,
      challenge,
      state,
    });
  }

  async function refresh() {
    // Basic credentials don't expire and can't be refreshed; a surviving 401
    // means the password is wrong → authedFetch falls through to onSignedOut.
    if (app.authMode === 'basic') return false;
    const cfg = await resolveConfig();
    const tokens = await oauth.refreshTokens(fetchFn, cfg, app.refreshToken);
    const bearer = oauth.bearerFromTokens(tokens, cfg.bearer);
    if (!bearer) return false;
    setTokens(bearer, tokens.refresh_token);
    return true;
  }

  async function getToken() {
    // In basic mode the stored credential is the "token" authedFetch carries.
    if (app.authMode === 'basic') return basicCreds();
    if (!app.token) return null;
    if (!isTokenExpired(app.token)) return app.token;
    if (await refresh()) return app.token;
    clearTokens();
    return null;
  }

  // --- ClickHouse context ------------------------------------------------
  // How the token is presented to CH. 'bearer' (token_processor) or 'basic'
  // (OSS + a verifier like ch-jwt-verify, where the JWT is the Basic password
  // and the username is the token's email). Resolved from config by ensureConfig.
  app.chAuth = 'bearer';
  // Which claim becomes the Basic username (per-IdP, from config). Empty → the
  // default chain. Lets one IdP map to a CH username distinct from another's.
  app.basicUserClaim = '';
  function authHeader(token) {
    // Basic mode: `token` is already base64(user:pass) — send it verbatim.
    if (app.authMode === 'basic') return 'Basic ' + token;
    if (app.chAuth !== 'basic') return 'Bearer ' + token;
    const user = chUsername(decodeJwtPayload(token));
    return 'Basic ' + btoa(unescape(encodeURIComponent(user + ':' + token)));
  }
  const chCtx = {
    fetch: fetchFn,
    // Where queries POST: the serving origin for OAuth, or the (possibly
    // cross-origin) target chosen at credential sign-in for basic mode.
    origin: app.authMode === 'basic'
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
    onSignedOut: (detail) => {
      clearTokens();
      renderLogin(app, detail || 'Your session expired — please sign in again.');
    },
  };
  app.chCtx = chCtx;

  // Load config (once) and apply the CH auth mode before any query runs.
  // Fail-soft: if config can't be loaded we keep the current mode (bearer)
  // rather than blocking the query.
  async function ensureConfig() {
    // Basic mode needs no OAuth config — the auth scheme is fixed.
    if (app.authMode === 'basic') return null;
    try {
      const cfg = await resolveConfig();
      app.chAuth = cfg.chAuth;
      app.basicUserClaim = cfg.basicUserClaim || '';
      return cfg;
    } catch {
      return null;
    }
  }
  app.ensureConfig = ensureConfig;

  // --- credentials (HTTP Basic) sign-in ----------------------------------
  // Validate a ClickHouse username/password against `host` (blank → the serving
  // host) with a probe query, then commit the session and enter the workbench.
  // The probe uses a throwaway ctx so a bad password surfaces CH's own reason
  // here (rejected as a thrown Error) instead of auto-rendering the login.
  async function connect({ username, password, host }) {
    const user = String(username || '').trim();
    const target = resolveTarget(host, loc.origin);
    const creds = btoa(unescape(encodeURIComponent(user + ':' + (password || ''))));
    const probeCtx = {
      fetch: fetchFn,
      origin: target,
      getToken: async () => creds,
      authHeader: () => 'Basic ' + creds,
      refresh: async () => false,
      onSignedOut: (detail) => { throw new Error(detail || 'Authentication failed'); },
    };
    await ch.queryJson(probeCtx, 'SELECT 1');
    // Probe passed → commit the session and switch the live ctx to the target.
    app.authMode = 'basic';
    ss.setItem('ch_basic_auth', creds);
    ss.setItem('ch_basic_user', user);
    ss.setItem('ch_basic_origin', target);
    chCtx.origin = target;
    app.renderApp();
  }

  // --- data loaders ------------------------------------------------------
  app.loadVersion = async () => {
    try {
      await ensureConfig();
      app.state.serverVersion = await ch.loadServerVersion(chCtx);
      setConn(true);
    } catch {
      setConn(false);
    }
  };
  function setConn(online) {
    if (!app.dom.connStatus) return;
    app.dom.connStatus.classList.toggle('dim', !online);
    const full = app.state.serverVersion;
    // Show a short version (e.g. 26.3.10); full string on hover so the header
    // doesn't crowd/overflow on a narrow window.
    app.dom.connStatus.title = online ? 'ClickHouse ' + full : '';
    app.dom.connStatus.replaceChildren(h('span', { class: 'ver' },
      online ? 'ClickHouse ' + shortVersion(full) : 'offline'));
  }
  app.loadSchema = async () => {
    try {
      await ensureConfig();
      const schema = await ch.loadSchema(chCtx);
      // One batched write → one repaint (the schema effect + the banner effect
      // react to these signals; no manual renderSchema/updateBanner needed).
      batch(() => { app.state.schema.value = schema; app.state.schemaError.value = null; });
    } catch (e) {
      app.state.schemaError.value = String((e && e.message) || e);
    }
    app.rebuildCompletions();
  };
  // Editor reference data + autocomplete candidates. Loaded once per connection
  // (the keystroke rule, #25): keywords/functions drive both version-correct
  // highlighting and the autocomplete list; completion then runs client-side.
  app.refData = assembleReferenceData(null); // built-in fallback until loaded
  app.rebuildCompletions = () => {
    app.completions = buildCompletions(app.refData, app.state.schema.value);
  };
  app.rebuildCompletions();
  // Hover docs (#27) are fetched on demand per entity and cached for reuse —
  // descriptions are large, so they stay out of the bulk reference load. The
  // cache holds the resolved string (incl. '' for no-doc / error) so each entity
  // is queried at most once per connection; an in-flight promise is cached too
  // to dedupe concurrent hovers of the same word.
  app.docCache = new Map();
  app.entityDoc = (name) => {
    if (app.docCache.has(name)) return Promise.resolve(app.docCache.get(name));
    const p = ensureConfig().then(() => ch.loadEntityDoc(chCtx, name, sqlString));
    app.docCache.set(name, p); // dedupe concurrent hovers of the same name
    p.then((doc) => {
      // Cache a resolved doc ('' included = genuinely no doc), but DROP a failed
      // fetch (null) so a transient error doesn't suppress it for the session (#8).
      if (doc === null) app.docCache.delete(name);
      else app.docCache.set(name, doc);
    });
    return p;
  };
  app.loadReference = async () => {
    await ensureConfig();
    app.refData = assembleReferenceData(await ch.loadReferenceData(chCtx));
    app.docCache.clear(); // re-fetch hover docs against the (possibly new) connection
    app.rebuildCompletions();
    if (app.dom.editorSync) app.dom.editorSync(); // re-highlight with server keywords
  };
  // A prominent, dismissible banner for schema/auth failures — the schema-panel
  // text alone is easy to miss on first deploy. Driven by app.state.schemaError.
  function updateBanner() {
    const b = app.dom.banner;
    if (!b) return;
    const err = app.state.schemaError.value;
    if (!err || app.state.bannerDismissedFor.value === err) {
      b.style.display = 'none';
      return;
    }
    b.style.display = '';
    b.replaceChildren(
      h('span', { class: 'auth-banner-msg' },
        'ClickHouse rejected the request — JWT auth may not be configured: ' + err),
      h('button', {
        class: 'auth-banner-x',
        title: 'Dismiss',
        onclick: () => { app.state.bannerDismissedFor.value = err; b.style.display = 'none'; },
      }, '×'),
    );
  }
  app.updateBanner = updateBanner;
  // Measure the engine's viewport-unit overshoot under html{zoom} (#70): a
  // `height:100vh` probe against the `height:100%`-sized #root (reliably one
  // screen on every engine). Returns the divisor (~--zoom on Chromium, ~1 on
  // WebKit/Safari) or null when there's no layout to measure (happy-dom).
  // Injected so the controller stays testable without a real layout engine.
  app.measureViewportZoom = env.measureViewportZoom || (() => {
    const probe = doc.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:100vh;visibility:hidden;pointer-events:none';
    doc.body.appendChild(probe);
    const vp = viewportZoom(probe.getBoundingClientRect().height, app.root.getBoundingClientRect().height);
    probe.remove();
    return vp;
  });
  // Publish the measured divisor as --vp-zoom, which the fullscreen graph panels
  // divide their vw/vh sizing by. Leaves the CSS default (--vp-zoom: var(--zoom),
  // the Chromium-correct value) untouched when unmeasurable, so behavior never
  // regresses. app.vpZoom is mirrored onto the schema graph's child tab.
  function applyViewportZoom() {
    const vp = app.measureViewportZoom();
    if (vp == null) return;
    app.vpZoom = vp;
    doc.documentElement.style.setProperty('--vp-zoom', String(vp));
  }
  app.applyViewportZoom = applyViewportZoom;
  // Lazily load a table's columns into the schema signal by REFERENCE (no
  // in-place mutation): replace the target table object with `{...tb, columns}`.
  // 'loading' is written synchronously (before the await) so the schema effect
  // paints the spinner immediately; the result/[] write repaints with the data.
  // `tb.columns` stays the completion cache that buildCompletions reads.
  async function loadColumns(db, table) {
    const setCols = (cols) => {
      app.state.schema.value = app.state.schema.value.map((d) =>
        (d.db === db
          ? { ...d, tables: d.tables.map((t) => (t.name === table ? { ...t, columns: cols } : t)) }
          : d));
    };
    setCols('loading');
    try {
      await ensureConfig();
      setCols(await ch.loadColumns(chCtx, db, table, sqlString));
    } catch {
      setCols([]);
    }
    app.rebuildCompletions(); // newly-loaded columns become completion candidates (#26)
  }

  // --- query run ---------------------------------------------------------
  const now = () => (env.now || (() => win.performance.now()))();
  // A unique id for a query_id / session_id. Prefer crypto.randomUUID; its
  // fallback (non-secure context, where randomUUID is undefined) must still be
  // unique across tabs sharing one time origin — so mix in Math.random, not just
  // `now()` (performance.now is coarsened and can repeat for back-to-back calls).
  const uid = (prefix) => (cryptoObj.randomUUID
    ? cryptoObj.randomUUID()
    : prefix + now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
  // One retry after this delay (ms) smooths a transient failure on the rapid,
  // same-session requests of a script (env-injectable; tests set 0).
  const retryMs = env.retryMs != null ? env.retryMs : 250;
  const sleep = (ms) => new Promise((r) => win.setTimeout(r, ms));
  // ClickHouse's transient "session is busy / locked by a concurrent client"
  // (SESSION_IS_LOCKED, code 373) — retryable once the prior request releases it.
  const SESSION_BUSY = /SESSION_IS_LOCKED|session .* is locked|locked by a concurrent/i;
  // Milliseconds since the running query started (0 when idle). Used for the
  // live counter, computed fresh so each render/tick shows the current value.
  app.elapsedMs = () => (app.state.runT0 != null ? now() - app.state.runT0 : 0);
  // Exposed so results.js can compute a script-export row's live elapsed time
  // (now() - e.startedAt) with the same injected clock as exportScript itself.
  app.now = now;
  // Update only the live elapsed-ms readout (no table re-render). Driven by an
  // interval while running so it ticks even for queries that emit no rows (sleep).
  function tickElapsed() {
    if (app.dom.runElapsedEl) app.dom.runElapsedEl.textContent = app.elapsedMs().toFixed(0) + ' ms';
  }
  app.tickElapsed = tickElapsed;

  // A ClickHouse HTTP session ties a tab's requests together so session state —
  // temporary tables, SET settings — survives across the separate HTTP requests
  // of a multiquery script (and across successive runs in the tab). ClickHouse's
  // HTTP interface runs one statement per request and is otherwise stateless, so
  // without this a `CREATE TEMPORARY TABLE …; INSERT …; SELECT …` script can't
  // see its own temp table. The id is per-tab (lazily minted) so tabs don't share
  // state and never collide on the per-session lock (only one query runs at a
  // time, guarded by `running`). No `session_timeout` override is needed:
  // ClickHouse resets the idle timer when each query is *released* (end of the
  // request, not the start) and cancels it while a query runs, so the default
  // (60s) never lapses between a script's back-to-back statements.
  function sessionParams(tab) {
    tab.chSession = tab.chSession || uid('sess-');
    return { session_id: tab.chSession };
  }
  // Only TEMPORARY tables and session `SET`s need a session; permanent DDL/DML and
  // SELECTs are global. So we attach a session_id ONLY when the SQL needs one — or
  // when the tab already opened one (sticky, so a temp table / SET from an earlier
  // run stays visible to later runs in that tab). Ordinary scripts run session-LESS,
  // which avoids the session lock / replica-affinity reset that intermittently
  // surfaces as a "Network error". (Schema / reference loads are always
  // session-less — they fan out in parallel and would deadlock on the lock.)
  const needsSession = (sqls) => sqls.some((s) => /\bTEMPORARY\b/i.test(s) || leadingKeyword(s) === 'SET');
  function sessionParamsFor(tab, sqls) {
    return tab.chSession != null || needsSession(sqls) ? sessionParams(tab) : {};
  }

  async function run(opts) {
    if (app.state.running.value) return; // already running — cancel via cancel()/Esc
    const tab = app.activeTab();
    // `opts.sql` overrides the source SQL (a single selected statement); otherwise
    // the whole tab runs, byte-for-byte as before (FORMAT / EXPLAIN detection,
    // trailing `;`, history).
    const srcSql = opts && opts.sql != null ? opts.sql : tab.sql;
    if (!srcSql.trim()) return;
    await ensureConfig();
    if (!(await getToken())) { chCtx.onSignedOut(); return; }

    // EXPLAIN-view bookkeeping: the Explain button (opts.explain) forces any query
    // into EXPLAIN-view mode; a normal Run clears that; switching an EXPLAIN tab
    // (opts.explainView) preserves it.
    if (opts && opts.explain) app.state.forceExplain = true;
    else if (!(opts && opts.explainView != null)) app.state.forceExplain = false;

    // An explicit FORMAT clause runs raw and shows ClickHouse's response verbatim
    // (single raw tab). Otherwise an EXPLAIN (typed, or forced by the button) gets
    // the five EXPLAIN views; everything else streams structured (Table).
    const explicitFmt = detectSqlFormat(srcSql);
    const parsed = explicitFmt ? null : parseExplain(srcSql);
    const explainMode = !explicitFmt && (parsed != null || app.state.forceExplain);
    let runSql = srcSql;
    let fmt;
    let explainView = null;
    if (explainMode) {
      // View precedence: an explicit tab click wins; otherwise a *typed* EXPLAIN
      // is honored exactly (canonical match → its rich view, else the verbatim
      // Explain view); the button-forced path falls through to Explain. We never
      // inherit a stale view from a previous run/tab — typing a plain EXPLAIN must
      // show the plan, not whatever view was last open.
      explainView = (opts && opts.explainView)
        || (parsed && detectExplainView(parsed))
        || 'explain';
      fmt = (EXPLAIN_VIEWS.find((v) => v.id === explainView) || EXPLAIN_VIEWS[0]).chFormat;
      const inner = parsed ? parsed.inner : srcSql;
      const explainOpts = { pretty: supportsExplainPretty(app.state.serverVersion) };
      runSql = explainView === 'explain' && parsed
        ? srcSql
        : buildExplainQuery(inner, explainView, explainOpts);
    } else {
      fmt = explicitFmt || 'Table';
    }

    // Cap a normal result query (Table or explicit-FORMAT SELECT) at the global
    // row limit; EXPLAIN/PIPELINE/ESTIMATE are exempt (small output, and a cap
    // would truncate a plan oddly). The streaming guard reads it off the result;
    // runQuery adds the server-side max_result_rows for the Table path.
    const rowLimit = explainMode ? 0 : app.state.resultRowLimit;
    const t0 = now();
    tab.result = newResult(fmt, rowLimit);
    if (explainView) tab.result.explainView = explainView;
    app.state.resultSort = { col: null, dir: 'asc' };
    app.state.runT0 = t0;
    app.state.runQueryId = uid('q');
    app.state.abortController = new AbortController();
    app.state.runTick = setInterval(tickElapsed, 100);
    // Keep the current Table/JSON/Chart tab across re-runs (#34); a saved-query
    // open passes its remembered view in opts.view to restore that instead.
    const view = opts && opts.view;
    // Flip the run signals last, in one batch: the results + Run-button effects
    // fire on this write and read runT0/elapsed, so the bookkeeping above must
    // already be set. (The old explicit setRunBtn(true)/renderResults are now
    // those effects' job.)
    batch(() => {
      app.state.resultView.value = ['table', 'json', 'chart'].includes(view) ? view : app.state.resultView.value;
      app.state.running.value = true;
    });

    try {
      const out = await ch.runQuery(chCtx, runSql, {
        format: fmt,
        resultRowLimit: rowLimit,
        queryId: app.state.runQueryId,
        signal: app.state.abortController.signal,
        params: sessionParamsFor(tab, [srcSql]),
        onLine: (json) => applyStreamLine(json, tab.result),
        onChunk: () => renderResults(app),
      });
      if (out.error != null) tab.result.error = out.error;
      else if (out.raw != null) {
        tab.result.rawText = out.raw;
        tab.result.progress.bytes = out.raw.length;
      }
    } catch (e) {
      // Cancel = abort: keep whatever streamed in, flag it partial (no error).
      if (e.name === 'AbortError') tab.result.cancelled = true;
      else if (e instanceof TypeError) tab.result.error = 'Network error';
      else tab.result.error = String((e && e.message) || e);
    } finally {
      clearInterval(app.state.runTick);
      app.state.runTick = null;
      app.state.abortController = null;
      app.state.runQueryId = null;
      app.state.runT0 = null;
      tab.result.progress.elapsed_ns = (now() - t0) * 1e6;
      // Flip running off last: the results + Run-button effects fire here and
      // render the final stats, so elapsed_ns must already be recorded. (Old
      // explicit setRunBtn(false)/renderResults are now those effects' job.)
      app.state.running.value = false;
      if (!tab.result.error && !tab.result.cancelled) {
        app.recordHistory(tab, opts && opts.sql);
        if (isSchemaMutatingSql(runSql)) app.loadSchema(); // not awaited — fire and forget
      }
    }
  }

  // Run one script statement, classifying the outcome for the retry logic: a
  // Cancel → { aborted }; a connection-level fetch failure → { error:'Network
  // error', transient } (retryable); any other throw → { error }. Otherwise the
  // runQuery result itself ({ raw } | { error }).
  async function attemptStatement(stmt, opts) {
    try {
      return await ch.runQuery(chCtx, stmt, opts);
    } catch (e) {
      if (e.name === 'AbortError') return { aborted: true };
      return { error: e instanceof TypeError ? 'Network error' : String((e && e.message) || e), transient: e instanceof TypeError };
    }
  }

  // Run a `;`-separated script sequentially: one ClickHouse request per statement
  // (CH's HTTP interface runs exactly one statement per request), stopping on the
  // first failure. Row-returning statements (SELECT/WITH/SHOW/…) are fetched as
  // JSONCompact capped at 100 rows; everything else runs for effect and reports
  // OK. The result is a per-statement summary grid (tab.result.script). The whole
  // script is recorded as one history entry on a clean run. `originalInput` is the
  // exact text that was split (the selection or the whole editor).
  async function runScript(statements, originalInput) {
    if (app.state.running.value) return;
    await ensureConfig();
    if (!(await getToken())) { chCtx.onSignedOut(); return; }
    app.state.forceExplain = false;
    const tab = app.activeTab();
    const t0 = now();
    const entries = [];
    tab.result = { script: entries };
    app.state.resultSort = { col: null, dir: 'asc' };
    app.state.runT0 = t0;
    app.state.abortController = new AbortController();
    app.state.runTick = setInterval(tickElapsed, 100);
    let aborted = false;
    // Attach a session only if the script needs one (TEMPORARY / SET) or the tab
    // already has one — same params for every statement, computed once.
    const sp = sessionParamsFor(tab, statements);
    app.state.running.value = true; // the results effect paints the (empty) grid
    try {
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i];
        const rowReturning = isRowReturning(stmt);
        // Over-fetch SELECTs by one past the display cap so a truncated result is
        // detectable (at exactly the cap it isn't).
        const opts = {
          format: rowReturning ? 'JSONCompact' : 'TSV',
          signal: app.state.abortController.signal,
          params: { ...sp, ...(rowReturning ? { max_result_rows: SELECT_ROW_CAP + 1, result_overflow_mode: 'break' } : {}) },
        };
        const s0 = now(); // this statement's own wall-clock (grid Time column)
        // Fresh query_id per attempt, published before the request so Cancel
        // issues KILL QUERY against the statement that's actually running.
        app.state.runQueryId = uid('q');
        let out = await attemptStatement(stmt, { ...opts, queryId: app.state.runQueryId });
        // Retry ONLY when it's safe. SESSION_IS_LOCKED means the statement was
        // rejected before running → safe to retry (any statement). A connection
        // reset (fetch TypeError → "Network error") leaves it UNKNOWN whether the
        // statement ran, so only retry read-only statements — re-running an
        // INSERT/DDL could double-apply it. (A mid-retry Cancel aborts the retry.)
        const locked = out.error != null && SESSION_BUSY.test(out.error);
        if (!out.aborted && (locked || (out.transient && rowReturning))) {
          await sleep(retryMs);
          app.state.runQueryId = uid('q');
          out = await attemptStatement(stmt, { ...opts, queryId: app.state.runQueryId });
        }
        if (out.aborted) { aborted = true; break; }
        // A connection reset on a non-idempotent statement: don't silently retry —
        // tell the user it may have run so they can decide whether to re-run.
        if (out.transient && !rowReturning) out.error = 'Network error — the statement may have executed; re-run it manually if needed.';
        const ms = now() - s0;
        if (out.error != null) {
          entries.push({ sql: stmt, status: 'error', error: out.error, ms });
          renderResults(app);
          break; // stop-on-first-failure: skip the remaining statements
        }
        if (rowReturning) {
          const sel = parseSelectResult(out.raw, SELECT_ROW_CAP);
          entries.push({ sql: stmt, status: 'rows', columns: sel.columns, rows: sel.rows, truncated: sel.truncated, preview: firstRowPreview(sel.rows), ms });
        } else {
          entries.push({ sql: stmt, status: 'ok', ms });
        }
        renderResults(app);
      }
    } finally {
      clearInterval(app.state.runTick);
      app.state.runTick = null;
      app.state.abortController = null;
      app.state.runQueryId = null;
      app.state.runT0 = null;
      tab.result.elapsedMs = now() - t0;
      if (aborted) tab.result.cancelled = true;
      app.state.running.value = false;
      // A statement that actually ran (status !== 'error') and was schema-mutating
      // refreshes the tree even if a later statement in the script failed — it
      // already took effect server-side.
      if (entries.some((e) => e.status !== 'error' && isSchemaMutatingSql(e.sql))) app.loadSchema();
      // One history entry for the whole script — but only on a clean run (mirrors
      // run(): no history for an aborted or failed script).
      if (!aborted && !entries.some((e) => e.status === 'error')) {
        recordScriptHistory(app.state, originalInput, tab.result.elapsedMs, saveJSON);
        if (app.state.sidePanel.value === 'history') renderSavedHistory(app);
      }
    }
  }

  // The Run button / ⌘+Enter entry point. A non-empty (non-whitespace) editor
  // selection runs just that text; otherwise the whole tab. The chosen text is
  // split: one statement keeps today's rich Table/Chart/EXPLAIN path (run());
  // more than one runs sequentially as a script (runScript).
  function runEntry(opts) {
    if (app.state.running.value) return;
    const ta = app.dom.editorTextarea;
    const sel = ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '';
    const hasSel = sel.trim() !== '';
    const input = hasSel ? sel : app.activeTab().sql;
    const statements = splitStatements(input);
    if (!statements.length) return; // nothing runnable (empty / comments-only)
    // >1 statement → script grid (a remembered single-result view doesn't apply).
    if (statements.length > 1) return runScript(statements, input);
    // 1 statement → today's rich path. Forward opts (e.g. a saved query's
    // remembered view / Explain); a selection adds the sql override.
    return run(hasSel ? { ...opts, sql: input } : opts);
  }
  // Stop an in-flight query: abort the stream and KILL QUERY on the server.
  function cancel() {
    if (!app.state.running.value) return;
    if (app.state.abortController) app.state.abortController.abort();
    ch.killQuery(chCtx, app.state.runQueryId, sqlString);
  }
  function setRunBtn(running) {
    if (!app.dom.runBtn) return;
    app.dom.runBtn.disabled = running;
    // "Run selection" while the editor has a non-empty selection (so the mode is
    // discoverable); plain "Run" otherwise. Build the children and drop the null
    // (replaceChildren would coerce a null arg into a "null" text node).
    const label = running ? 'Running…' : (app.state.hasSelection.value ? 'Run selection' : 'Run');
    app.dom.runBtn.replaceChildren(
      ...[Icon.play(), h('span', null, label),
        running ? null : h('kbd', null, '⌘↵')].filter(Boolean));
  }
  app.setRunBtn = setRunBtn;
  // The Export button reflects both browser support (canExport) and whether an
  // export is already running — the button stays aria-disabled (not natively
  // disabled) in either case so its tooltip still shows on hover.
  function setExportBtn(exporting) {
    if (!app.dom.exportBtn) return;
    const can = app.canExport();
    const disabled = exporting || !can;
    app.dom.exportBtn.classList.toggle('is-disabled', disabled);
    if (disabled) app.dom.exportBtn.setAttribute('aria-disabled', 'true');
    else app.dom.exportBtn.removeAttribute('aria-disabled');
    app.dom.exportBtn.title = exporting
      ? 'Export in progress…'
      : can ? 'Export full result to a file (streams to disk, uncapped)'
        : 'Large export requires Chrome/Edge over HTTPS';
  }
  app.setExportBtn = setExportBtn;
  // Busy state for the Format button — formatting a multi-statement script is one
  // request per statement, so it can take a moment; show a spinner + disable.
  function setFmtBtn(busy) {
    if (!app.dom.fmtBtn) return;
    app.dom.fmtBtn.disabled = busy;
    app.dom.fmtBtn.replaceChildren(
      busy ? h('span', { class: 'spin' }, Icon.spinner()) : Icon.braces(),
      busy ? 'Formatting…' : 'Format');
  }
  app.setFmtBtn = setFmtBtn;

  // Pretty-print the editor's SQL via ClickHouse's formatQuery(), in place. The
  // raw (untrimmed) SQL is sent so a syntax error's reported position maps 1:1
  // onto the editor text. On error we show it persistently in the results panel
  // and jump the caret to the offending token; a later successful format clears
  // that error. Success never touches real run results.
  // Clear a prior format-error result (a later successful format clears just this).
  function clearFormatError() {
    const tab = app.activeTab();
    if (tab.result && tab.result.formatError) { tab.result = null; renderResults(app); }
  }
  // Format one statement via ClickHouse's formatQuery(); returns the formatted text.
  const formatOne = async (s) => {
    const json = await ch.queryJson(chCtx, 'SELECT formatQuery(' + sqlString(s) + ') AS q FORMAT JSON');
    return (json.data && json.data[0] && json.data[0].q) || '';
  };

  async function formatQuery() {
    const raw = app.activeTab().sql || '';
    if (!raw.trim()) return;
    await ensureConfig();
    if (!(await getToken())) { chCtx.onSignedOut(); return; }
    const tab = app.activeTab();
    const stmts = splitStatements(raw);
    setFmtBtn(true); // formatting a script is one request per statement — show busy
    try {
      if (stmts.length > 1) {
        // Multi-statement: format each (best-effort — keep the original text for any
        // statement that won't format, like insertCreate), then reassemble with a
        // `;` and a blank line between statements.
        const formatted = await Promise.all(stmts.map((s) => formatOne(s).catch(() => s)));
        replaceEditor(app, withStatementBreak(formatted.map((q, i) => q || stmts[i]).join(';\n\n')));
        clearFormatError();
        return;
      }
      // Single statement: send the raw (untrimmed) SQL so a syntax error's reported
      // position maps 1:1 onto the editor text; show it persistently + jump the caret.
      try {
        const q = await formatOne(raw);
        // Terminate so the caret lands past the last token — otherwise the input
        // event from the replace re-opens autocomplete on the trailing word.
        if (q) replaceEditor(app, withStatementBreak(q));
        clearFormatError();
      } catch (e) {
        const msg = String((e && e.message) || e);
        tab.result = newResult('Table');
        tab.result.error = msg;
        tab.result.formatError = true; // a format error, not a run result (so success can clear just this)
        app.state.resultView.value = 'table';
        renderResults(app); // explicit: the format-error tab.result is an in-place write, and resultView may already be 'table' (no effect)
        const pos = parseErrorPos(msg);
        if (pos != null) app.dom.editorRevealCaret(pos);
      }
    } finally {
      setFmtBtn(false);
    }
  }

  // Render the ClickHouse object-lineage graph for a dropped database/table into
  // the data pane (queries system.* + EXPLAIN AST; the editor SQL is untouched).
  async function showSchemaGraph(focus) {
    if (!focus || !focus.db) return;
    await ensureConfig();
    if (!(await getToken())) { chCtx.onSignedOut(); return; }
    const tab = app.activeTab();
    // Show a loading placeholder first — the lineage queries (system.* + an
    // EXPLAIN AST per view/MV) can take a moment on a large database.
    tab.result = newResult('Table');
    tab.result.schemaGraph = { focus, loading: true, nodes: [], edges: [] };
    renderResults(app);
    try {
      const rows = await ch.loadSchemaLineage(chCtx, focus);
      const g = buildSchemaGraph(rows, focus);
      // tableCount lets the renderer explain an empty result ("N tables, none linked").
      tab.result.schemaGraph = { focus, nodes: g.nodes, edges: g.edges, tableCount: (rows.tables || []).length };
    } catch (e) {
      tab.result = newResult('Table');
      tab.result.error = String((e && e.message) || e);
    }
    renderResults(app);
  }

  // Open the schema lineage fullscreen with RICH cards. Lazily fetches a separate
  // enriched dataset (the inline pane stays compact and untouched): re-loads
  // lineage + the per-table column / skip-index metadata (best-effort), attaches a
  // card model to each node, then opens the overlay. Re-fetch (vs reusing the inline
  // result) keeps the inline path's shape frozen and the card data off the hot path.
  async function expandSchemaGraph(focus) {
    if (!focus || !focus.db) return;
    // Pin the result whose Expand was clicked NOW: a tab switch during the async
    // fetch must not redirect the saved-positions map to a different tab's result.
    const clickedTab = app.activeTab();
    const sg = (clickedTab && clickedTab.result && clickedTab.result.schemaGraph) || null;
    // Open the view synchronously so a real tab survives the click gesture (a
    // pop-up opened after an await is blocked); fill it once the lineage loads.
    const view = openSchemaView(app);
    // Everything after the synchronous open is wrapped: a token-refresh rejection,
    // a lineage/cards fetch failure, or a graph-build throw must surface in the view
    // (fail) instead of leaving the just-opened tab/overlay stranded on "Loading…".
    try {
      await ensureConfig();
      if (!(await getToken())) { chCtx.onSignedOut(); view.fail('Sign in to view the schema graph.'); return; }
      // Walk lineage transitively across DB boundaries (soft-capped) — pulls in
      // objects an other database references, instead of dead-ending at the edge.
      const lineage = await ch.loadLineageTransitive(chCtx, focus);
      const g = buildSchemaGraph(lineage.rows, focus);
      const ex = expandLineage(g, focus.db); // closure around focus.db, tags external nodes
      // Card metadata for every database the expansion reached (external nodes too).
      const dbs = [...new Set(ex.nodes.map((n) => n.db).filter(Boolean))];
      const cards = await ch.loadSchemaCards(chCtx, dbs);
      const cardGraph = buildCardGraph({ nodes: ex.nodes, edges: ex.edges },
        { tables: lineage.rows.tables, columnsByKey: cards.columnsByKey, skipByKey: cards.skipByKey });
      // Persist manually-moved node positions per result: the map hangs off the live
      // schemaGraph result (captured above) so re-opening keeps the layout.
      const positions = (sg && sg.savedPositions) || {};
      if (sg) sg.savedPositions = positions;
      view.render({
        nodes: cardGraph.nodes, edges: cardGraph.edges, focus,
        tableCount: (lineage.rows.tables || []).length,
        truncated: lineage.truncated || ex.truncated,
        savedPositions: positions,
      });
    } catch {
      view.fail('Could not load the schema graph');
    }
  }

  // Open the detail pane for a clicked fullscreen node: lazily load the table's full
  // columns / partitions / DDL (best-effort) and mount the pane in the overlay.
  // Keyed per overlay document (same resolution as openDetailPane's own `doc`) so a
  // slow fetch for an earlier click can't clobber a newer pane once it resolves —
  // last-clicked wins, not last-resolved (#97).
  const latestDetailRequest = new WeakMap();
  async function openNodeDetail(node, targetDoc) {
    if (!node || !node.db || !node.name) return;
    const overlayDoc = targetDoc || (app && app.document) || document;
    latestDetailRequest.set(overlayDoc, node);
    openDetailPane(app, node, { columns: 'loading' }, targetDoc);
    const detail = await ch.loadTableDetail(chCtx, node.db, node.name);
    if (latestDetailRequest.get(overlayDoc) !== node) return; // superseded by a later click
    openDetailPane(app, node, detail, targetDoc);
  }

  // EXPLAIN wraps the whole editor as a single statement, so it can't run against a
  // `;`-separated script (ClickHouse would reject `EXPLAIN a; b; …` with a confusing
  // parse error). Say so with our own message instead.
  function explainMultiBlocked() {
    if (splitStatements(app.activeTab().sql).length <= 1) return false;
    flashToast('Explain isn’t available for a multi-statement script — run one statement at a time.', { document: doc });
    return true;
  }
  // Explain the current query without editing it: run it through the EXPLAIN
  // views (the editor SQL is left untouched; run() wraps it as needed).
  function explainQuery() { return explainMultiBlocked() ? undefined : run({ explain: true }); }
  // Switch the active EXPLAIN view (re-runs the derived query, keeps the mode).
  function setExplainView(id) { return explainMultiBlocked() ? undefined : run({ explainView: id }); }
  // Change the global result-row cap: persist the (normalized) preference and
  // re-run the current query so a raise genuinely fetches more (server-side cap),
  // a lower one stops sooner. run() no-ops on an empty editor, so changing the
  // limit with nothing typed just saves the preference.
  function setResultRowLimit(n) {
    app.state.resultRowLimit = normalizeRowLimit(n);
    app.savePref('resultRowLimit', app.state.resultRowLimit);
    return run();
  }

  // Fetch the DDL for `target` (e.g. 'db.table' or 'DATABASE db') with
  // SHOW CREATE, pretty-print it through formatQuery(), and drop it into the
  // editor (replacing its content — undo restores the prior query). Two
  // round-trips by design; if formatting fails the raw DDL is used.
  async function insertCreate(target) {
    await ensureConfig();
    if (!(await getToken())) { chCtx.onSignedOut(); return; }
    try {
      const show = await ch.queryJson(chCtx, 'SHOW CREATE ' + target + ' FORMAT JSON');
      const stmt = (show.data && show.data[0] && show.data[0].statement) || '';
      if (!stmt) return;
      let out = stmt;
      try {
        const fmt = await ch.queryJson(chCtx, 'SELECT formatQuery(' + sqlString(stmt) + ') AS q FORMAT JSON');
        out = (fmt.data && fmt.data[0] && fmt.data[0].q) || stmt;
      } catch { /* formatting is best-effort — fall back to the raw DDL */ }
      replaceEditor(app, out);
    } catch (e) {
      flashToast('SHOW CREATE failed: ' + String((e && e.message) || e), { document: doc });
    }
  }

  // --- saved / history bridges ------------------------------------------
  app.recordHistory = (tab, sqlText) => {
    recordHistory(app.state, tab, saveJSON, undefined, sqlText);
    if (app.state.sidePanel.value === 'history') renderSavedHistory(app);
  };

  // --- share + star ------------------------------------------------------
  function share() {
    const tab = app.activeTab();
    const sql = (tab.sql || '').trim();
    if (!sql) return;
    const url = loc.origin + loc.pathname + loc.search + '#' + encodeShare(sql, tabChart(tab));
    win.history && win.history.replaceState && win.history.replaceState(null, '', url);
    const clip = (env.navigator || win.navigator || {}).clipboard;
    if (clip && clip.writeText) {
      clip.writeText(loc.href || url)
        .then(() => flashToast('Link copied to clipboard', { document: doc }))
        .catch(() => flashToast('Link in URL — copy manually', { document: doc }));
    } else {
      flashToast('Link in URL — copy manually', { document: doc });
    }
  }
  // --- copy / export results --------------------------------------------
  // A result is exportable once it has raw text or at least one row.
  function exportableResult() {
    const r = app.activeTab().result;
    // A script result is a per-statement grid, not a single exportable table.
    return r && !r.error && !r.script && (r.rawText != null || r.rows.length > 0) ? r : null;
  }
  // `targetDoc` defaults to the main document, but a detached view (issue
  // #100's Data Pane) passes its own — the Clipboard API ties writeText's
  // permission to the *focused* document, so resolving navigator off the main
  // window unconditionally would risk a NotAllowedError when the click came
  // from a different (same-origin) top-level browsing context. `env.navigator`
  // still wins first so tests can inject a stub regardless of which doc they
  // simulate.
  function copySnapshot(r, targetDoc) {
    const d = targetDoc || doc;
    if (!r) { flashToast('Nothing to copy', { document: d }); return; }
    const text = r.rawText != null ? r.rawText : toTSV(r.columns, r.rows);
    const clip = (env.navigator || (d.defaultView || win).navigator || {}).clipboard;
    if (clip && clip.writeText) {
      clip.writeText(text)
        .then(() => flashToast('Copied to clipboard', { document: d }))
        .catch(() => flashToast('Copy failed', { document: d }));
    } else {
      flashToast('Copy not supported', { document: d });
    }
  }
  function copyResult() { copySnapshot(exportableResult(), doc); }
  // --- streaming export (issue #87 single-file / #99 script) --------------
  // Full, uncapped export of a query — never the loaded grid — streamed
  // straight to a user-chosen file. Its own query_id + abort, kept separate
  // from app.state.runQueryId/abortController so an export and a grid run
  // never clobber each other's cancel state.
  let exportAbort = null;
  let exportQueryId = null;
  // Script-export state (issue #99) — its own abort/query-id, reassigned each
  // iteration so Cancel reaches the in-flight statement, and kept distinct
  // from both app.state.run* and the single-export state above.
  let exportScriptAbort = null;
  let exportScriptQueryId = null;
  let exportScriptCancelled = false;
  let exportScriptTick = null;

  // The Export button dispatches by statement count: one statement keeps the
  // rich single-file flow below; more than one opens the script-export flow
  // (its own directory + per-statement log, since one file per script makes
  // no sense). Mirrors runEntry's split/branch.
  function exportEntry() {
    if (app.state.exporting.value) return;
    const ta = app.dom.editorTextarea;
    const sel = ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '';
    const input = sel.trim() !== '' ? sel : app.activeTab().sql;
    const statements = splitStatements(input);
    if (!statements.length) { flashToast('Nothing to export', { document: doc }); return; }
    if (statements.length === 1) return exportDirect(statements[0]);
    return exportScriptEntry(statements);
  }

  async function exportDirect(sqlInput) {
    if (app.state.exporting.value) return;
    if (!app.canExport()) return; // aria-disabled button; defensive guard
    const tab = app.activeTab();
    const { sql, format } = prepareExportSql(sqlInput);
    if (!sql) { flashToast('Nothing to export', { document: doc }); return; }
    const { ext, mime } = formatFileMeta(format);

    // Flip the flag before the picker (not after, like the file handle) so a
    // second click while the native dialog is still open is blocked by the
    // guard above — the button's own disabled state (setExportBtn) also
    // reflects this via an effect, but the guard is the authority.
    app.state.exporting.value = true;
    try {
      // Picker FIRST, before any await: showSaveFilePicker requires the click's
      // transient activation, which a prior await (e.g. a token refresh in
      // ensureConfig/getToken can be a network round trip) would forfeit.
      let handle;
      try {
        handle = await app.showSaveFilePicker({
          suggestedName: exportFilename(tab.name, Date.now(), ext),
          types: [{ description: format + ' data', accept: { [mime]: ['.' + ext] } }],
        });
      } catch (e) {
        if (e && e.name === 'AbortError') return; // user dismissed the picker
        flashToast('Save dialog failed: ' + String((e && e.message) || e), { document: doc });
        return;
      }

      // Now the awaits are safe — we already hold the file handle.
      await ensureConfig();
      if (!(await getToken())) { chCtx.onSignedOut(); return; }

      exportQueryId = 'export-' + uid('');
      exportAbort = new AbortController();
      const progress = showExportProgress(cancelExport);
      try {
        const resp = await ch.exportQuery(chCtx, sql, {
          queryId: exportQueryId, signal: exportAbort.signal, format,
          params: sessionParamsFor(tab, [sql]),
        });
        const tag = resp.headers.get('X-ClickHouse-Exception-Tag'); // null on servers < 24.11
        const err = await streamToFile(resp, handle, {
          signal: exportAbort.signal, tag, onProgress: (bytes) => progress.update(bytes),
        });
        if (err) flashToast('Export incomplete — server error mid-stream: ' + err, { document: doc });
        else flashToast('Export complete', { document: doc });
      } catch (e) {
        // AbortError (cancelled) and 'signed out' (chCtx.onSignedOut already
        // rendered the login screen) both already have their own signal — an
        // extra toast on top would just be a confusing second message.
        const msg = String((e && e.message) || e);
        if (!(e && e.name === 'AbortError') && msg !== 'signed out') {
          flashToast('Export failed: ' + msg, { document: doc });
        }
      } finally {
        progress.remove();
        exportAbort = null;
        exportQueryId = null;
      }
    } finally {
      app.state.exporting.value = false;
    }
  }

  // Stream `resp.body` to `handle` with a hold-back buffer: ClickHouse's
  // mid-stream exception frame (findExceptionFrame) is at most 16 KiB and
  // always trailing, so bytes are only committed to disk once they've aged
  // out of a 32 KiB window — at EOF the retained tail is inspected and only
  // the clean prefix is written, so a mid-stream exception is never written
  // into the file. Memory stays flat (one HOLDBACK-sized buffer) regardless of
  // result size. Reads the stream directly (not via a TransformStream) because
  // the write is conditional (withhold, inspect, commit) — a passthrough
  // transform can't un-write. Returns the CH error message, or null when clean.
  async function streamToFile(resp, handle, { signal, tag, onProgress }) {
    const writable = await handle.createWritable();
    const HOLDBACK = 32 * 1024; // >= ClickHouse's MAX_EXCEPTION_SIZE (16 KiB) + margin
    const reader = resp.body.getReader();
    let held = new Uint8Array(0);
    let written = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        const merged = new Uint8Array(held.length + value.length);
        merged.set(held);
        merged.set(value, held.length);
        const commit = Math.max(0, merged.length - HOLDBACK);
        if (commit > 0) {
          await writable.write(merged.subarray(0, commit));
          written += commit;
          onProgress(written);
        }
        held = merged.subarray(commit);
      }
      // EOF: inspect the retained tail (latin1: 1 char per byte, for byte-accurate slicing).
      const frame = findExceptionFrame(latin1(held), tag);
      const clean = frame ? held.subarray(0, frame.cleanBytes) : held;
      if (clean.length) {
        await writable.write(clean);
        written += clean.length;
        onProgress(written);
      }
      await writable.close();
      return frame ? frame.message : null;
    } catch (e) {
      // writable.abort() would discard everything already committed: on
      // Chrome/File System Access API it leaves a hidden, 0-byte
      // `.crswap` swap file behind and never materializes the visible
      // target at all — so a cancelled/failed export recovers nothing.
      // close() instead finalizes the bytes already written under the
      // target handle, then move() (Chrome 110+) renames it in place with
      // a `.partial` suffix so it reads as an inspectable, clearly-labeled
      // partial artifact rather than a clean export. Best-effort: on
      // browsers without move() (or if it throws), the file is still
      // recoverable under its original name, just without the suffix.
      await writable.close().catch(() => {});
      if (typeof handle.move === 'function') await handle.move(handle.name + '.partial').catch(() => {});
      throw e;
    } finally {
      reader.releaseLock();
    }
  }
  const latin1 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return s; };

  // Mirrors cancel() (the grid run) but on the export's own id/abort.
  function cancelExport() {
    if (exportAbort) exportAbort.abort();
    ch.killQuery(chCtx, exportQueryId, sqlString);
  }

  // Directory picker first (transient-activation rule, same as exportDirect's
  // save-file picker), and skip the prompt entirely when there's nothing to
  // export — no point asking for a folder a script will never write into.
  async function exportScriptEntry(statements) {
    if (!app.canExportScript()) {
      flashToast('Script export requires Chrome/Edge directory access over HTTPS', { document: doc });
      return;
    }
    if (!statements.some(isRowReturning)) {
      flashToast('Nothing to export — script has no result-producing statements.', { document: doc });
      return;
    }
    // Flip the flag before the picker (mirrors exportDirect) so a second click
    // while the directory dialog / auth is still in flight is blocked by
    // exportEntry's guard — exportScript itself doesn't set this until after
    // those awaits, which would otherwise leave a re-entrancy window open.
    app.state.exporting.value = true;
    try {
      let dir;
      try {
        dir = await app.showDirectoryPicker({ mode: 'readwrite' });
      } catch (e) {
        if (e && e.name === 'AbortError') return; // dismissed → silent no-op
        flashToast('Folder dialog failed: ' + String((e && e.message) || e), { document: doc });
        return;
      }
      await ensureConfig();
      if (!(await getToken())) { chCtx.onSignedOut(); return; }
      await exportScript(statements, dir);
    } finally {
      // No-op if exportScript already reset it — covers every early-return
      // path above that never reaches exportScript's own finally.
      app.state.exporting.value = false;
    }
  }

  // Run a script's statements sequentially into `dir`, one file per
  // row-returning statement, for effect otherwise. A single shared session
  // carries SET/TEMPORARY state across statements (sessionParamsFor). The log
  // lives in tab.result.scriptExport — per-statement metadata only (status,
  // file, bytes, time); the exported rows themselves are never held in
  // memory/state, so a multi-million-row script export stays flat. Stop on
  // first failure, mirroring runScript's script grid — but with no retry
  // (statements run one-at-a-time in a single session, so SESSION_IS_LOCKED
  // can't self-collide, and a partially-written file shouldn't be silently
  // re-attempted).
  async function exportScript(statements, dir) {
    const tab = app.activeTab();
    const t0 = now();
    const sp = sessionParamsFor(tab, statements);
    const entries = statements.map((sql, i) => ({
      i, sql, type: isRowReturning(sql) ? 'rows' : 'effect',
      status: 'pending', file: null, bytes: 0, startedAt: null, ms: 0, error: null,
    }));
    tab.result = { scriptExport: entries, startedAt: t0 };
    app.state.resultSort = { col: null, dir: 'asc' };
    exportScriptCancelled = false;
    app.state.exporting.value = true;
    const taken = new Set();
    try {
      // Live elapsed for the running row (bytes tick via onProgress; this ticks
      // time). Started inside the try so a throw here still clears it below —
      // an interval set before the try would otherwise leak forever.
      exportScriptTick = setInterval(() => renderResults(app), 200);
      renderResults(app);
      for (const e of entries) {
        if (exportScriptCancelled) { e.status = 'skipped'; continue; }
        const { sql, format } = prepareExportSql(e.sql);
        exportScriptQueryId = 'export-' + uid('');
        exportScriptAbort = new AbortController();
        const signal = exportScriptAbort.signal;
        e.startedAt = now();
        e.status = e.type === 'rows' ? 'exporting' : 'running';
        renderResults(app);
        try {
          if (e.type !== 'rows') {
            const out = await ch.runQuery(chCtx, e.sql,
              { format: 'TSV', signal, queryId: exportScriptQueryId, params: sp });
            if (out.error != null) throw new Error(out.error);
            e.status = 'ok';
          } else {
            const { ext } = formatFileMeta(format);
            const name = scriptExportName(e.i, e.sql, ext, taken);
            taken.add(name);
            e.file = name;
            const fileHandle = await dir.getFileHandle(name, { create: true });
            const resp = await ch.exportQuery(chCtx, sql,
              { queryId: exportScriptQueryId, signal, format, params: sp });
            const tag = resp.headers.get('X-ClickHouse-Exception-Tag');
            const midErr = await streamToFile(resp, fileHandle,
              { signal, tag, onProgress: (b) => { e.bytes = b; } });
            if (midErr) {
              e.status = 'failed';
              e.error = 'File may be incomplete; server failed after streaming started. ' + midErr;
              e.ms = now() - e.startedAt;
              break; // stop-on-first-failure
            }
            e.status = 'ok';
          }
          e.ms = now() - e.startedAt;
          renderResults(app);
        } catch (ex) {
          e.ms = now() - e.startedAt;
          if (ex && ex.name === 'AbortError') { e.status = 'cancelled'; exportScriptCancelled = true; }
          else { e.status = 'failed'; e.error = String((ex && ex.message) || ex); }
          break; // stop-on-first-failure
        }
      }
      for (const e of entries) if (e.status === 'pending') e.status = 'skipped';
    } finally {
      clearInterval(exportScriptTick); exportScriptTick = null;
      exportScriptAbort = null;
      exportScriptQueryId = null;
      app.state.exporting.value = false;
      tab.result.elapsedMs = now() - t0;
      // A schema-mutating effect statement that actually ran refreshes the tree
      // (mirrors runScript) even though this export ran outside runScript.
      if (entries.some((e) => e.status === 'ok' && isSchemaMutatingSql(e.sql))) app.loadSchema();
      renderResults(app);
    }
  }

  // Mirrors cancelExport but on the script's own active id/abort.
  function cancelExportScript() {
    exportScriptCancelled = true; // stops the loop from starting the next statement
    if (exportScriptAbort) exportScriptAbort.abort();
    ch.killQuery(chCtx, exportScriptQueryId, sqlString);
  }

  // Inline progress banner (bytes written + elapsed, with Cancel) — no extra
  // tab/window; see the issue's "Why inline, not a child tab" rationale.
  function showExportProgress(onCancel) {
    const t0 = now();
    const stat = h('span', { class: 'exp-stat' }, formatBytes(0) + ' · 0s');
    const el = h('div', { class: 'export-progress' },
      h('span', { class: 'spin' }, Icon.spinner()),
      h('span', { class: 'exp-label' }, 'Exporting…'),
      stat,
      h('button', { class: 'exp-cancel', title: 'Cancel export', onclick: onCancel }, Icon.close(), h('span', null, 'Cancel')));
    doc.body.appendChild(el);
    return {
      update(bytes) {
        stat.textContent = formatBytes(bytes) + ' · ' + ((now() - t0) / 1000).toFixed(0) + 's';
      },
      remove() { el.remove(); },
    };
  }
  // Trigger a browser download. Injectable via env.download for tests.
  function downloadFile(filename, mime, content) {
    if (env.download) { env.download(filename, mime, content); return; }
    const url = win.URL || win.webkitURL;
    const href = url.createObjectURL(new win.Blob([content], { type: mime }));
    const a = doc.createElement('a');
    a.href = href;
    a.download = filename;
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    url.revokeObjectURL(href);
  }

  // The toolbar Save button reads "Saved" (accent) when the active tab is linked
  // to a saved entry and its SQL is unchanged; "Save" otherwise (incl. dirty).
  app.updateSaveBtn = () => {
    if (!app.dom.saveBtn) return;
    const tab = app.activeTab();
    const entry = savedForTab(app.state, tab);
    const clean = !!entry && entry.sql.trim() === String(tab.sql || '').trim();
    app.dom.saveBtn.classList.toggle('saved', clean);
    app.dom.saveBtn.replaceChildren(Icon.bookmark(), h('span', null, clean ? 'Saved' : 'Save'));
    app.dom.saveBtn.title = clean ? 'Saved — edit to re-save (⌘S)' : 'Save query (⌘S)';
  };
  // Open `node` as a popover anchored under `anchorEl`: fixed-position below the
  // button, Esc + click-outside close (capture listeners), stored at
  // app.dom[refKey] and cleared on close. Returns { close }.
  function anchoredPopover(node, anchorEl, refKey) {
    const close = () => {
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('mousedown', onOutside, true);
      if (app.dom[refKey]) { app.dom[refKey].remove(); app.dom[refKey] = null; }
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    const onOutside = (e) => {
      if (app.dom[refKey] && !node.contains(e.target) && !anchorEl.contains(e.target)) close();
    };
    app.dom[refKey] = node;
    const r = anchorEl.getBoundingClientRect();
    // Right-align under the button, bridging html{zoom} (see fixedAnchor / zoomScale).
    const a = fixedAnchor(r, zoomScale(anchorEl), { viewportW: win.innerWidth || 0 });
    node.style.position = 'fixed';
    node.style.top = a.top + 'px';
    node.style.right = a.right + 'px';
    doc.body.appendChild(node);
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('mousedown', onOutside, true);
    return { close };
  }

  // Name popover anchored under the Save button. Prefill with the tab's name (or
  // a name inferred from the SQL); Enter/Save → saveQuery (create or update in
  // place) + relink the tab; Esc / click-outside cancels.
  function openSavePopover() {
    const tab = app.activeTab();
    if (!String(tab.sql || '').trim()) { flashToast('Nothing to save', { document: doc }); return; }
    if (app.dom.savePopover) return;
    const entry = savedForTab(app.state, tab);
    const prefill = entry ? entry.name : (tab.name && tab.name !== 'Untitled' ? tab.name : inferQueryName(tab.sql));
    const input = h('input', { class: 'sp-input', value: prefill });
    const descInput = h('textarea', { class: 'sp-desc', rows: '3', placeholder: 'What this query does — included in Markdown export' });
    if (entry && entry.description) descInput.value = entry.description;
    let close;
    const commit = () => {
      if (!input.value.trim()) return;
      saveQuery(app.state, tab, input.value, descInput.value, saveJSON);
      close();
      app.updateSaveBtn();
      app.actions.rerenderTabs();
      renderSavedHistory(app);
      flashToast('Saved', { document: doc }); // saveQuery dirtied the library → title effect adds the dot
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    // In the multiline description, plain Enter inserts a newline; ⌘/Ctrl+Enter commits.
    descInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); } });
    const pop = h('div', { class: 'save-popover' },
      h('div', { class: 'sp-label' }, 'Save query as'),
      input,
      h('div', { class: 'sp-label' }, 'Description', h('span', { class: 'sp-opt' }, ' — optional')),
      descInput,
      h('div', { class: 'sp-actions' },
        h('button', { class: 'sp-cancel', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'sp-save', onclick: commit }, 'Save')));
    ({ close } = anchoredPopover(pop, app.dom.saveBtn, 'savePopover'));
    setTimeout(() => { input.focus(); input.select(); });
  }
  app.openSavePopover = openSavePopover;

  // User menu: dropdown under the header user button, holding the identity and
  // a Log out item. Same close model as the save popover (Esc + outside click).
  function openUserMenu() {
    if (app.dom.userMenu) return;
    let close;
    const logoutBtn = h('button', { class: 'um-item danger', onclick: () => { close(); app.signOut(); } }, Icon.logout(), h('span', null, 'Log out'));
    const menu = h('div', { class: 'user-menu' },
      h('div', { class: 'um-id' }, app.email()),
      logoutBtn,
      h('div', { class: 'um-build', title: 'App version / build' }, app.build));
    ({ close } = anchoredPopover(menu, app.dom.userBtn, 'userMenu'));
    setTimeout(() => logoutBtn.focus());
  }
  app.openUserMenu = openUserMenu;

  function toggleTheme() {
    app.state.theme = app.state.theme === 'dark' ? 'light' : 'dark';
    app.savePref('theme', app.state.theme);
    doc.documentElement.setAttribute('data-theme', app.state.theme);
    if (app.dom.themeBtn) app.dom.themeBtn.replaceChildren(app.state.theme === 'dark' ? Icon.sun() : Icon.moon());
  }
  // Exposed so the schema-view overlay can drive the same toggle (keeps state +
  // saved pref + header icon in sync rather than flipping data-theme behind them).
  app.toggleTheme = toggleTheme;

  // --- actions registry --------------------------------------------------
  app.actions = {
    run: runEntry,
    cancel,
    newTab: () => newTab(app),
    selectTab: (id) => selectTab(app, id),
    closeTab: (id) => closeTab(app, id),
    loadIntoNewTab: (name, sql, savedId, chart) => loadIntoNewTab(app, name, sql, savedId, chart),
    login: (idpId, targetOrigin) => login(idpId, targetOrigin),
    connect,
    share,
    copyResult,
    copySnapshot,
    exportEntry,
    exportDirect,
    cancelExport,
    cancelExportScript,
    save: openSavePopover,
    openUserMenu,
    formatQuery,
    explainQuery,
    setExplainView,
    setResultRowLimit,
    showSchemaGraph,
    expandSchemaGraph,
    openNodeDetail,
    insertCreate,
    openShortcuts: () => openShortcuts(app),
    insertAtCursor: (text) => insertAtCursor(app, text),
    replaceEditor: (text) => replaceEditor(app, text),
    loadColumns,
    rerenderTabs: () => renderTabs(app),
    rerenderResults: () => renderResults(app),
    updateSaveBtn: () => app.updateSaveBtn(),
  };

  app.renderApp = () => renderApp(app, { toggleTheme, startDrag });
  return app;
}

/** Build the signed-in shell and mount all regions. */
export function renderApp(app, helpers) {
  const { state, document: doc } = app;
  doc.documentElement.setAttribute('data-theme', state.theme);
  doc.documentElement.setAttribute('data-density', state.density);

  app.dom = {};
  app.dom.connStatus = h('div', { class: 'conn-status dim' }, h('span', { class: 'ver' }, 'Connecting…'));
  app.dom.themeBtn = h('button', { class: 'hd-btn', title: 'Toggle theme', onclick: helpers.toggleTheme });
  app.dom.themeBtn.appendChild(state.theme === 'dark' ? Icon.sun() : Icon.moon());
  app.dom.userBtn = h('button', { class: 'hd-btn user-btn', title: app.email(), onclick: () => app.actions.openUserMenu() },
    h('span', { class: 'user-short' }, userShortName(app.email())), Icon.chevDown());

  const header = h('div', { class: 'app-header' },
    h('div', { class: 'logo-mark' }, 'A'),
    h('div', { class: 'logo-name' }, 'Altinity SQL Browser'),
    h('div', { class: 'env-chip' }, app.host()),
    h('div', { class: 'hd-divider' }),
    ...libraryControls(app),
    h('div', { style: { flex: '1' } }),
    app.dom.connStatus,
    h('a', {
      class: 'hd-btn', href: 'https://github.com/Altinity/altinity-sql-browser',
      target: '_blank', rel: 'noopener noreferrer', title: 'View source on GitHub',
    }, Icon.github()),
    h('button', { class: 'hd-btn', title: 'Keyboard shortcuts (?)', onclick: () => app.actions.openShortcuts() }, Icon.shortcuts()),
    app.dom.themeBtn,
    app.dom.userBtn);

  app.dom.schemaSearchInput = h('input', {
    type: 'text', placeholder: 'Search tables, columns…',
    oninput: (e) => { state.schemaFilter.value = e.target.value; },
  });
  app.dom.schemaList = h('div', { class: 'schema-list' });
  const schemaPane = h('div', { class: 'side-pane schema-pane', style: { height: state.sideSplitPct + '%', flexShrink: '0', minHeight: '0' } },
    h('div', { class: 'schema-search' }, h('div', { class: 'search-wrap' }, Icon.search(), app.dom.schemaSearchInput)),
    app.dom.schemaList);

  app.dom.savedTabsRow = h('div', { class: 'side-tabs' });
  app.dom.savedSearch = h('div', { class: 'saved-search' });
  app.dom.savedList = h('div', { class: 'saved-list' });
  const savedPane = h('div', { class: 'side-pane saved-pane', style: { flex: '1', minHeight: '0' } }, app.dom.savedTabsRow, app.dom.savedSearch, app.dom.savedList);

  const sidebar = h('div', { class: 'sidebar', style: { width: state.sidebarPx + 'px' } });
  const rectFor = (axis) => {
    if (axis === 'sideRow') return sidebar.getBoundingClientRect();
    return { top: app.dom.editorRegion.getBoundingClientRect().top, bottom: app.dom.resultsRegion.getBoundingClientRect().bottom };
  };
  const dragCtx = {
    state,
    rectFor,
    // The px-based 'col' axis divides clientX by the page zoom; the '%' axes use a
    // zoom-cancelling ratio and ignore `scale` (dragValue's default), so we needn't
    // special-case the axis here — just report the page zoom from the sidebar.
    scale: () => zoomScale(sidebar),
    apply: (axis, value) => {
      if (axis === 'col') sidebar.style.width = value + 'px';
      else if (axis === 'sideRow') sidebar.firstElementChild.style.height = value + '%';
      else app.dom.editorRegion.style.height = value + '%';
    },
    save: (name, value) => app.savePref(name, value),
  };
  app.dom.sideSplit = h('div', { class: 'row-resize side-split', onmousedown: (e) => helpers.startDrag(e, 'sideRow', dragCtx) });
  sidebar.append(schemaPane, app.dom.sideSplit, savedPane);
  const sideHandle = h('div', { class: 'col-resize', onmousedown: (e) => helpers.startDrag(e, 'col', dragCtx) });

  app.dom.qtabsInner = h('div', { class: 'qtabs-inner' });
  const qtabsRow = h('div', { class: 'qtabs' }, app.dom.qtabsInner,
    h('button', { class: 'new-tab', title: 'New query', onclick: () => app.actions.newTab() }, Icon.plus()));

  app.dom.runBtn = h('button', { class: 'run-btn', onclick: () => app.actions.run() }, Icon.play(), h('span', null, 'Run'), h('kbd', null, '⌘↵'));
  app.dom.fmtBtn = h('button', { class: 'tb-btn', title: 'Format SQL (⌘⇧↵)', onclick: () => app.actions.formatQuery() }, Icon.braces(), 'Format');
  app.dom.explainBtn = h('button', { class: 'tb-btn', title: 'Explain this query (plan, indexes, pipeline, estimate)', onclick: () => app.actions.explainQuery() }, Icon.plan(), 'Explain');
  app.dom.saveBtn = h('button', { class: 'tb-btn save-btn', onclick: () => app.actions.save() });
  // Chromium + secure-context only (app.canExport), and disabled while one is
  // already running (app.state.exporting — see setExportBtn's effect below).
  // Aria-disabled with a tooltip rather than natively `disabled` — a natively
  // disabled button swallows pointer events, so its title tooltip often never
  // shows, exactly where a "why is this greyed out?" explanation matters most.
  app.dom.exportBtn = h('button', {
    class: 'tb-btn', onclick: () => app.actions.exportEntry(),
  }, Icon.download(), 'Export');
  app.dom.shareBtn = h('button', { class: 'tb-btn', title: 'Share query (copies link)', onclick: () => app.actions.share() }, Icon.share(), 'Share');

  const editorToolbar = h('div', { class: 'ed-toolbar' }, app.dom.runBtn, app.dom.fmtBtn, app.dom.explainBtn, app.dom.saveBtn, h('div', { style: { flex: '1' } }), app.dom.exportBtn, app.dom.shareBtn);
  app.dom.editorRegion = h('div', { class: 'editor-region', style: { height: state.editorPct + '%', minHeight: '0', overflow: 'hidden', flexShrink: '0' } });
  app.dom.resultsRegion = h('div', { class: 'results-region', style: { flex: '1', minHeight: '0', overflow: 'hidden' } });
  // Drop a database/table from the schema tree here → render its lineage graph.
  app.dom.resultsRegion.addEventListener('dragover', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes(SCHEMA_GRAPH_MIME)) e.preventDefault();
  });
  app.dom.resultsRegion.addEventListener('drop', (e) => {
    const payload = e.dataTransfer && e.dataTransfer.getData(SCHEMA_GRAPH_MIME);
    if (!payload) return;
    e.preventDefault();
    try { app.actions.showSchemaGraph(JSON.parse(payload)); } catch { /* malformed payload */ }
  });
  app.dom.editorResultsSplit = h('div', { class: 'row-resize', onmousedown: (e) => helpers.startDrag(e, 'row', dragCtx) });

  const workbench = h('div', { class: 'workbench' }, qtabsRow, editorToolbar, app.dom.editorRegion, app.dom.editorResultsSplit, app.dom.resultsRegion);
  app.dom.banner = h('div', { class: 'auth-banner', style: { display: 'none' } });
  app.root.replaceChildren(header, app.dom.banner, h('div', { class: 'main-row' }, sidebar, sideHandle, workbench));

  mountEditor(app, app.dom.editorRegion);
  // Reactive repaint of the tab-dependent surface — replaces the old tabs.js
  // refresh(): re-runs whenever the tab list or active tab changes, so tab ops
  // just mutate the signals.
  effect(() => {
    app.state.tabs.value;
    app.state.activeTabId.value;
    renderTabs(app);
    if (app.dom.editorSync) app.dom.editorSync();
    app.updateSaveBtn();
  });
  // Reactive repaint of the results pane: re-runs on a tab switch, a Table/JSON/
  // Chart view change, or a run-state flip. (renderResults' activeTab() also
  // reads tabs.value, so a tab-list change repaints here too.) Streaming-data
  // repaints still call renderResults directly from run()'s onChunk.
  effect(() => {
    app.state.activeTabId.value;
    app.state.resultView.value;
    app.state.running.value;
    renderResults(app);
  });
  // The Run button reflects the run state (label + disabled) and the selection
  // (Run ↔ Run selection).
  effect(() => { app.state.hasSelection.value; app.setRunBtn(app.state.running.value); });
  // The Export button reflects the exporting state — set here (not just at
  // click-time) so a second click while one export is already running is
  // blocked visually too, not just by exportDirect's own re-entrance guard.
  effect(() => { app.setExportBtn(app.state.exporting.value); });
  // Track the editor's text selection into a signal so the Run button label and
  // ⌘+Enter target just the highlighted text. `selectionchange` is the one event
  // that fires for keyboard, mouse, and programmatic selection; gate on the
  // editor being focused so selecting elsewhere (results, address bar) is ignored.
  app.syncSelection = () => {
    const ta = app.dom.editorTextarea;
    const focused = ta && app.document.activeElement === ta;
    const sel = focused ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '';
    app.state.hasSelection.value = sel.trim() !== '';
  };
  app.document.addEventListener('selectionchange', app.syncSelection);
  // Reactive repaint of the schema tree — replaces the scattered renderSchema()
  // calls: re-runs on schema load, load error, filter text, or expand/collapse.
  // Registered here (post-mount) so app.dom.schemaList already exists; the effect
  // also runs once now for the initial paint.
  effect(() => {
    app.state.schema.value;
    app.state.schemaError.value;
    app.state.schemaFilter.value;
    app.state.expanded.value;
    renderSchema(app);
  });
  // The schema/auth-failure banner reflects schemaError (a separate surface).
  effect(() => {
    app.state.schemaError.value;
    app.updateBanner();
  });
  // Reactive repaint of the side panel: re-runs when the active panel changes
  // (Library ↔ History). Data-driven repaints (savedQueries/history mutations)
  // still call renderSavedHistory directly until those slices are signals too.
  effect(() => {
    app.state.sidePanel.value;
    renderSavedHistory(app);
  });
  // Reactive repaint of the header library title (name + unsaved-changes dot):
  // re-runs when the name or dirty flag changes. The edit-mode toggle is driven
  // separately (editingLibrary is not a signal — file-menu.js renders it directly).
  effect(() => {
    app.state.libraryName.value;
    app.state.libraryDirty.value;
    renderLibraryTitle(app);
  });
  // The shell is mounted (and laid out in a real engine), so the viewport-unit
  // overshoot is measurable now — publish --vp-zoom before any fullscreen graph
  // panel can open, so it sizes correctly on this engine (#70).
  app.applyViewportZoom();
  app.loadVersion();
  app.loadSchema();
  app.loadReference();
}
