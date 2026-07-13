// The application controller. `createApp(env)` returns the `app` object every
// render module receives: state, DOM refs, persistence helpers, the ClickHouse
// fetch context, and the action callbacks. All environment access (document,
// window, location, fetch, crypto, sessionStorage) is injected so the whole
// controller is testable under happy-dom with stubs.

import { h, zoomScale, fixedAnchor } from './dom.js';
import { Icon } from './icons.js';
import {
  createState, activeTab, KEYS, recordHistory, recordScriptHistory, saveQuery, savedForTab, tabPanel, normalizeRowLimit,
  MOBILE_BREAKPOINT_PX, effectiveFilterActive,
} from '../state.js';
import { splitStatements, isRowReturning, leadingKeyword } from '../core/sql-split.js';
import {
  analyzeParameterizedSources, prepareParameterizedBatch, mergedSourceArgs, mergedSourceSql, executionView, analysisView,
  fieldControls, fieldControlKind,
} from '../core/param-pipeline.js';
import { hasOptionalBlocks } from '../core/optional-blocks.js';
import { parseSelectResult, firstRowPreview, SELECT_ROW_CAP } from '../core/script-result.js';
import { saveJSON, saveStr } from '../core/storage.js';
import { decodeJwtPayload, isTokenExpired } from '../core/jwt.js';
import { sqlString, inferQueryName, shortVersion, supportsExplainPretty, userShortName, withStatementBreak, detectSqlFormat, isSchemaMutatingSql, prepareExportSql, formatBytes, formatRows } from '../core/format.js';
import { EXPLAIN_VIEWS, parseExplain, detectExplainView, buildExplainQuery } from '../core/explain.js';
import { buildSchemaGraph, expandLineage } from '../core/schema-graph.js';
import { buildCardGraph } from '../core/schema-cards.js';
import { resolveTarget } from '../core/target.js';
import { toTSV, formatFileMeta, exportFilename, scriptExportName } from '../core/export.js';
import { newResult, applyStreamLine, parseErrorPos, findExceptionFrame } from '../core/stream.js';
import { buildResultSource } from '../core/query-source.js';
import { encodeShare } from '../core/share.js';
import { assembleReferenceData, buildCompletions } from '../core/completions.js';
import { generatePKCE, randomState } from '../core/pkce.js';
import { viewportZoom } from '../core/zoom-support.js';
import { configBase } from '../core/dashboard.js';
import { isQuerylessPanel } from '../core/panel-cfg.js';
import { snapshotAuth, restoreAuth, hasAuth, isAuthRequest, isAuthGrant, AUTH_REQUEST, AUTH_GRANT } from '../core/auth-handoff.js';
import * as oauthCfg from '../net/oauth-config.js';
import * as oauth from '../net/oauth.js';
import * as ch from '../net/ch-client.js';
import { createNoopPort } from '../editor/editor-port.js';
import { SCHEMA_GRAPH_MIME } from './dnd-mime.js';
import { renderTabs, selectTab, newTab, closeTab, loadIntoNewTab } from './tabs.js';
import { effect, batch } from '@preact/signals-core';
import { renderSchema } from './schema.js';
import { renderResults } from './results.js';
import { renderDashboard } from './dashboard.js';
import { openSchemaView } from './explain-graph.js';
import { openDetailPane } from './schema-detail.js';
import { renderSavedHistory } from './saved-history.js';
import { applyFieldState } from './var-field.js';
import { buildRelativeTimeField } from './relative-time-field.js';
import { buildRecentField } from './recent-field.js';
import { buildEnumField } from './enum-field.js';
import { wireComboInput } from './combobox.js';
import { recordRecent, clearRecent, clearAllRecent, recentOptions } from '../core/recent-values.js';
import { enumValues, parseParamType } from '../core/param-type.js';
import { paramComparisonColumns } from '../core/param-comparison.js';
import { resolveComparisonColumnType } from '../core/from-scope.js';
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
    // #170 review: names of `{name:Type}` variables whose value has hardened
    // to invalid (blur/Enter/execute committed a strict verdict of invalid).
    // setRunBtn's gate-less fallback (called from unrelated re-renders —
    // renderVarStrip's tail call on every SQL-editor keystroke, and the
    // hasSelection effect on every cursor/selection move) recomputes in
    // lenient 'input' mode, which reads a still-incomplete prefix (e.g. a
    // lone '-') as merely incomplete, not invalid — without this bookkeeping
    // that recompute would silently re-enable Run while the field itself
    // still paints red. Editing the field's value again (its own `oninput`)
    // clears the name here, returning it to normal lenient behavior.
    hardenedVars: new Set(),
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
    // Mobile-breakpoint seam (#126): matchMedia, injected so tests can drive the
    // breakpoint. renderApp uses it to seed + track `state.isMobile` against
    // MOBILE_BREAKPOINT_PX. null when the platform has no matchMedia (treated as
    // always-desktop — the mobile CSS still applies, just no JS branching).
    matchMedia: env.matchMedia || (typeof win.matchMedia === 'function' ? win.matchMedia.bind(win) : null),
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
  // configBase strips a trailing `/dashboard` so config.json / OAuth discovery
  // resolve from the SPA base (`/sql/config.json`) on the dashboard route too.
  // The same base is the single source of truth for the workbench↔dashboard
  // links (openDashboard, the dashboard's Back link) rather than hardcoding
  // `/sql` in several shapes.
  app.basePath = configBase(loc.pathname);
  const loadDoc = oauthCfg.memoizeConfig(() => oauthCfg.loadConfigDoc(fetchFn, app.basePath));
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
  // Persist the shared query-variable values (#134) after each edit.
  app.saveVarValues = () => saveJSON(KEYS.varValues, app.state.varValues);
  // Persist the optional-block activation map (#165) alongside varValues.
  app.saveFilterActive = () => saveJSON(KEYS.filterActive, app.state.filterActive);
  // Persist the per-variable recent-value MRU history (#171) alongside
  // varValues — same key convention, own key.
  app.saveVarRecent = () => saveJSON(KEYS.varRecent, app.state.varRecent);
  app.saveVarRecentDisabled = () => saveJSON(KEYS.varRecentDisabled, app.state.varRecentDisabled);
  // Record every successful statement's `boundParams` (#173's immutable
  // per-statement snapshots) into the recent-value history — the single hook
  // point every success path (run/runScript's single-statement + per-script-
  // statement paths, and the dashboard's per-tile completion) calls. A no-op
  // while the disable-history preference is on (existing history is left
  // alone, only new recording stops) or when nothing was actually bound.
  // Array-valued `rawValue` (an `Array(...)`-typed param) is skipped — v1
  // recents are a text-value affordance, like #172's (not yet built) enum
  // controls; #160's curated-`filter:`-param opt-out hook has nothing to
  // check yet (no curated param exists before #160 lands).
  app.recordBoundParams = (boundParams) => {
    if (app.state.varRecentDisabled || !boundParams || !boundParams.length) return;
    let map = app.state.varRecent;
    for (const p of boundParams) {
      if (typeof p.rawValue !== 'string') continue;
      map = recordRecent(map, p.name, p.rawValue);
    }
    if (map !== app.state.varRecent) {
      app.state.varRecent = map;
      app.saveVarRecent();
    }
  };
  // Per-field "Clear recent" (the dropdown footer) / "Clear all recent
  // values" (the File menu) — both no-op (no re-persist) when there was
  // nothing to clear, mirroring recordRecent's own same-reference no-op.
  app.clearVarRecent = (name) => {
    const next = clearRecent(app.state.varRecent, name);
    if (next !== app.state.varRecent) {
      app.state.varRecent = next;
      app.saveVarRecent();
    }
  };
  app.clearAllVarRecent = () => {
    app.state.varRecent = clearAllRecent();
    app.saveVarRecent();
  };
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

  // --- editor seam (#143) --------------------------------------------------
  // Like Chart/Dagre, the editor adapter factory is injected: main.js passes
  // the textarea adapter (the CM6 adapter swaps in with #21); headless app
  // tests omit it and get the noop port. The instance is created here — before
  // renderApp mounts it — so every consumer can call the port unconditionally.
  app.Editor = env.Editor || createNoopPort;
  app.editor = app.Editor(app);
  // The editor→state inversion (#143): the adapter reports each text change;
  // the state writes live here. Order matters — updateSaveBtn and the #134
  // variables strip read tab.sql, so the tab writes come first.
  app.editor.onDocChange((value) => {
    const tab = app.activeTab();
    tab.sql = value;
    tab.dirty = true;
    app.actions.rerenderTabs();
    app.updateSaveBtn();
    app.renderVarStrip();
  });
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
    app.editor.refreshReference(); // re-highlight with server keywords
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
    // #172 v2: a newly-loaded column may now resolve a String var's schema-
    // cache-inferred enum suggestion (paramComparisonColumns +
    // resolveComparisonColumnType) — repaint so it can upgrade from a plain
    // input the moment the idle-tick load lands, not just on the next
    // keystroke/tab-switch. renderVarStrip's own signature guard (which now
    // folds in each var's resolved enum options, see below) skips the actual
    // DOM rebuild when nothing changed, so this is a cheap no-op otherwise.
    app.renderVarStrip();
  }

  // --- query run ---------------------------------------------------------
  const now = () => (env.now || (() => win.performance.now()))();
  // The *wall* clock for the parameter pipeline (#173) — epoch ms, injected
  // separately from `now` above: performance.now() measures durations and is
  // wrong for epoch-relative values (#169's `now-1h`). Callers resolve one
  // wallNow() per execution wave and thread it through every prepare of that
  // wave; debounce/coalescing also live in the callers, never in the pipeline.
  const wallNow = () => (env.wallNow || (() => Date.now()))();
  app.wallNow = wallNow;
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
  // The workbench SQL as the pipeline's single parameterized source (#173).
  function tabAnalysis(sql) {
    return analyzeParameterizedSources([
      { id: 'tab', label: 'editor tab', kind: 'tab', sql, bindPolicy: 'row-returning' },
    ]);
  }
  // The optional-block activation map (#165): explicit filterActive entries
  // win; params without one derive activation from their stored value.
  const activeMap = () => effectiveFilterActive(app.state.varValues, app.state.filterActive);
  // Analyze + prepare `sql` as the workbench's single parameterized source
  // (#173): one call per SQL string per wave, drawing values from the shared
  // varValues (+ the #165 activation map). Returns the full prepared batch
  // ({fields, sources, diagnostics}) — `fields` is per-`{name:Type}` (#170's
  // validated state, for the var-strip's inline affordance); `sources[0]` is
  // this single source's `{statements, missing, invalid, errors, runnable}`.
  // Args for a request come from a source's statements (or mergedSourceArgs
  // when the SQL ships as one request); each statement's `sql` is its
  // execution view (#165) — byte-identical for SQL without optional blocks.
  function prepareAnalyzedBatch(analysis, wallNowMs, validationMode = 'execute') {
    return prepareParameterizedBatch(analysis, {
      values: app.state.varValues, active: activeMap(), wallNowMs, validationMode,
    });
  }
  function prepareTabBatch(sql, wallNowMs, validationMode = 'execute') {
    return prepareAnalyzedBatch(tabAnalysis(sql), wallNowMs, validationMode);
  }
  function prepareTabSource(sql, wallNowMs, validationMode = 'execute') {
    return prepareTabBatch(sql, wallNowMs, validationMode).sources[0];
  }
  // The execution text of one statement (#165): only active optional blocks
  // retained, markers stripped — byte-identical for SQL without blocks. Follows
  // the #134 bind gate: a non-row-returning statement passes through verbatim.
  function execStatementSql(stmt) {
    return isRowReturning(stmt) ? executionView(stmt, activeMap()) : stmt;
  }
  // Block execution while any {name:Type} variable in the active tab is unfilled
  // or invalid, or while its value can't serialize (e.g. an array value against
  // a scalar declaration) — toasting why (#134/#173). Gating on the whole
  // tab.sql — the exact set the variable strip shows — keeps every execution
  // path consistent: the Run button (setRunBtn), the Run/⌘↵ path, Explain, and
  // Export all agree. `wallNowMs` is the caller's wave clock.
  function varGateBlocked(wallNowMs = wallNow()) {
    const tab = app.activeTab();
    const src = tab ? prepareTabSource(tab.sql, wallNowMs) : null;
    if (!src) return false;
    const blockers = src.missing.concat(src.invalid);
    if (blockers.length) {
      flashToast('Enter a value for: ' + blockers.join(', '), { document: doc });
      return true;
    }
    if (src.errors.length) {
      flashToast(src.errors[0], { document: doc });
      return true;
    }
    return false;
  }

  // Execute one already-prepared read request into a caller-owned `result`,
  // with NO tab/global-state side effects. This is the request+stream+normalize
  // core that the workbench run(), the dashboard tiles, and the detached Data
  // view (#185) all perform identically: fold streamed lines into `result` via
  // applyStreamLine, capture a raw (explicit-FORMAT/EXPLAIN) body, and classify
  // an abort/network/other failure onto the result — never throwing. The caller
  // owns token freshness (resolved before this call), the AbortController /
  // query_id, parameter preparation, session_id, and any recent-value recording.
  // `onChunk` is the per-read repaint hook (the workbench repaints its pane; a
  // tile/detached view repaints its own surface). Returns the mutated `result`.
  async function runReadInto(result, { sql, format = 'Table', rowLimit = 0, params = {}, signal, queryId, onChunk } = {}) {
    try {
      const out = await ch.runQuery(chCtx, sql, {
        format,
        resultRowLimit: rowLimit,
        queryId,
        signal,
        params,
        onLine: (json) => applyStreamLine(json, result),
        onChunk,
      });
      if (out.error != null) result.error = out.error;
      else if (out.raw != null) {
        result.rawText = out.raw;
        result.progress.bytes = out.raw.length;
      }
    } catch (e) {
      // Cancel = abort: keep whatever streamed in, flag it partial (no error).
      if (e.name === 'AbortError') result.cancelled = true;
      else if (e instanceof TypeError) result.error = 'Network error';
      else result.error = String((e && e.message) || e);
    }
    return result;
  }
  app.runReadInto = runReadInto;

  async function run(opts) {
    if (app.state.running.value) return; // already running — cancel via cancel()/Esc
    const tab = app.activeTab();
    // `opts.sql` overrides the source SQL (a single selected statement); otherwise
    // the whole tab runs, byte-for-byte as before (FORMAT / EXPLAIN detection,
    // trailing `;`, history).
    const srcSql = opts && opts.sql != null ? opts.sql : tab.sql;
    if (!srcSql.trim()) return;
    const waveMs = wallNow(); // one wall clock for this run wave: gate + args see the same instant
    if (varGateBlocked(waveMs)) return; // block a run (incl. Explain / row-limit re-run) with unfilled variables
    // One prepared source for the whole run wave (#173), captured NOW —
    // synchronously with the gate check above, BEFORE the auth awaits below
    // (review F6 invariant, shared with runScript/exportDirect/exportScript):
    // gate and args see the same varValues snapshot; a value edited while a
    // token refresh is in flight applies to the NEXT run, and can never reach
    // the server as a never-gate-checked binding. Reused on success for the
    // recent-value recording (#171), so it reads exactly the boundParams that
    // were sent.
    const src = prepareTabSource(srcSql, waveMs);
    await ensureConfig();
    if (!(await getToken())) { chCtx.onSignedOut(); return; }
    cancelSchemaGraph(); // a Run/Explain takes over the result — don't leave a lineage fetch running

    // EXPLAIN-view bookkeeping: the Explain button (opts.explain) forces any query
    // into EXPLAIN-view mode; a normal Run clears that; switching an EXPLAIN tab
    // (opts.explainView) preserves it.
    if (opts && opts.explain) app.state.forceExplain = true;
    else if (!(opts && opts.explainView != null)) app.state.forceExplain = false;

    // Every downstream decision + the request itself operate on the statement's
    // execution view (#165): inactive optional blocks removed, markers
    // stripped — byte-identical to srcSql for SQL without blocks. History still
    // records the template (srcSql / tab.sql).
    const execSql = execStatementSql(srcSql);

    // An explicit FORMAT clause runs raw and shows ClickHouse's response verbatim
    // (single raw tab). Otherwise an EXPLAIN (typed, or forced by the button) gets
    // the five EXPLAIN views; everything else streams structured (Table).
    const explicitFmt = detectSqlFormat(execSql);
    const parsed = explicitFmt ? null : parseExplain(execSql);
    const explainMode = !explicitFmt && (parsed != null || app.state.forceExplain);
    let runSql = execSql;
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
      const inner = parsed ? parsed.inner : execSql;
      const explainOpts = { pretty: supportsExplainPretty(app.state.serverVersion) };
      runSql = explainView === 'explain' && parsed
        ? execSql
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
    // Keep the current Table/JSON/Panel tab across re-runs (#34); a saved-query
    // open passes its remembered view in opts.view to restore that instead
    // (a stray legacy 'chart' value maps to 'panel' — #166).
    const view = opts && opts.view === 'chart' ? 'panel' : opts && opts.view;
    // Flip the run signals last, in one batch: the results + Run-button effects
    // fire on this write and read runT0/elapsed, so the bookkeeping above must
    // already be set. (The old explicit setRunBtn(true)/renderResults are now
    // those effects' job.)
    batch(() => {
      app.state.resultView.value = ['table', 'json', 'panel'].includes(view) ? view : app.state.resultView.value;
      app.state.running.value = true;
    });

    try {
      await runReadInto(tab.result, {
        sql: runSql,
        format: fmt,
        rowLimit,
        queryId: app.state.runQueryId,
        signal: app.state.abortController.signal,
        // Native ClickHouse query parameters (#134/#173): pass prepared values
        // as param_<name> so the server substitutes them (only row-returning
        // statements bind — a CREATE VIEW / DDL source stays verbatim).
        params: { ...sessionParamsFor(tab, [srcSql]), ...mergedSourceArgs(src) },
        onChunk: () => renderResults(app),
      });
    } finally {
      clearInterval(app.state.runTick);
      app.state.runTick = null;
      app.state.abortController = null;
      app.state.runQueryId = null;
      app.state.runT0 = null;
      tab.result.progress.elapsed_ns = (now() - t0) * 1e6;
      // #185: capture the source that produced a normal, row-returning
      // structured result (fmt 'Table', so raw FORMAT / EXPLAIN are excluded;
      // empty results stay ineligible), so the Data Pane's Expand can open an
      // interactive, independently re-runnable detached view. The authored
      // template (srcSql — optional-block markers intact) and the run-time
      // title/description are snapshotted here, never re-derived from the
      // editor/Library at expand time (which may have changed). This MUST run
      // BEFORE the running flip below: that flip fires the results effect that
      // renders the toolbar + its Expand affordance, which gates on
      // `result.source` — set it after and the button never appears until the
      // next paint.
      if (!tab.result.error && !tab.result.cancelled && fmt === 'Table' && tab.result.rows.length > 0) {
        tab.result.source = buildResultSource({
          srcSql,
          tabId: tab.id,
          rowLimit,
          tabName: tab.name,
          savedEntry: savedForTab(app.state, tab),
        });
      }
      // Flip running off last: the results + Run-button effects fire here and
      // render the final stats, so elapsed_ns must already be recorded. (Old
      // explicit setRunBtn(false)/renderResults are now those effects' job.)
      app.state.running.value = false;
      if (!tab.result.error && !tab.result.cancelled) {
        app.recordHistory(tab, opts && opts.sql);
        // #171: this statement succeeded — record its bound params (exactly
        // what was actually sent; an omitted-optional-block param never
        // reached `src.statements[*].boundParams` in the first place).
        app.recordBoundParams(src.statements.flatMap((s) => s.boundParams));
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
    const waveMs = wallNow(); // one wall clock for the whole script wave
    if (varGateBlocked(waveMs)) return; // block a script run with unfilled variables
    // One prepared batch for the whole script (#173): `statements` came from
    // splitStatements(originalInput), so the batch's statements align by index.
    // Captured NOW — synchronously with the gate check above, BEFORE the auth
    // awaits (review F6 invariant, shared with run/exportDirect/exportScript):
    // gate and args see the same varValues snapshot; edits during the auth
    // await apply to the next run.
    const paramSrc = prepareTabSource(originalInput, waveMs);
    await ensureConfig();
    if (!(await getToken())) { chCtx.onSignedOut(); return; }
    cancelSchemaGraph(); // a script run takes over the result — don't leave a lineage fetch running
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
        // The wire text is the pipeline's per-statement execution view (#165):
        // inactive optional blocks removed for row-returning statements,
        // verbatim (byte-identical) for everything else and for block-free SQL.
        // The result grid keeps showing the authored `stmt`.
        const execStmt = paramSrc.statements[i].sql;
        const rowReturning = isRowReturning(stmt);
        // Over-fetch SELECTs by one past the display cap so a truncated result is
        // detectable (at exactly the cap it isn't).
        const opts = {
          format: rowReturning ? 'JSONCompact' : 'TSV',
          signal: app.state.abortController.signal,
          // Per-statement prepared args (#134/#173): the pipeline binds only
          // row-returning statements, so a DDL / CREATE VIEW statement in the
          // script is sent with its {name:Type} placeholders intact.
          params: { ...sp, ...paramSrc.statements[i].args, ...(rowReturning ? { max_result_rows: SELECT_ROW_CAP + 1, result_overflow_mode: 'break' } : {}) },
        };
        const s0 = now(); // this statement's own wall-clock (grid Time column)
        // Fresh query_id per attempt, published before the request so Cancel
        // issues KILL QUERY against the statement that's actually running.
        app.state.runQueryId = uid('q');
        let out = await attemptStatement(execStmt, { ...opts, queryId: app.state.runQueryId });
        // Retry ONLY when it's safe. SESSION_IS_LOCKED means the statement was
        // rejected before running → safe to retry (any statement). A connection
        // reset (fetch TypeError → "Network error") leaves it UNKNOWN whether the
        // statement ran, so only retry read-only statements — re-running an
        // INSERT/DDL could double-apply it. (A mid-retry Cancel aborts the retry.)
        const locked = out.error != null && SESSION_BUSY.test(out.error);
        if (!out.aborted && (locked || (out.transient && rowReturning))) {
          await sleep(retryMs);
          app.state.runQueryId = uid('q');
          out = await attemptStatement(execStmt, { ...opts, queryId: app.state.runQueryId });
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
        // #171: THIS statement succeeded — record its own boundParams. Per
        // statement, not per script: statement 1 of a later-failing script
        // still records; the failed statement and anything after the `break`
        // above never reaches this line.
        app.recordBoundParams(paramSrc.statements[i].boundParams);
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
    const sel = app.editor.getSelection().text;
    const hasSel = sel.trim() !== '';
    const input = hasSel ? sel : app.activeTab().sql;
    const statements = splitStatements(input);
    if (!statements.length) return; // nothing runnable (empty / comments-only)
    // The unfilled-variable gate (#134) lives in run()/runScript() — the shared
    // execution choke points — so Explain, row-limit re-runs, and Export are
    // gated too, not just this path.
    // Mobile (#126): a run jumps the bottom-nav to the Results panel so the data
    // the user just asked for is what they see next.
    if (app.state.isMobile.value) app.state.mobileView.value = 'results';
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
  // Keep `app.hardenedVars` (#170 review) in sync with a field's just-computed
  // 'execute'-mode verdict: added when it's invalid, cleared otherwise — so a
  // corrected-then-reharded value, or a variable that simply stopped being
  // invalid, doesn't linger in the set. Shared by every place that commits a
  // strict verdict for a field (blur, Enter, and the strip's initial/rebuild
  // paint, which is itself an 'execute'-mode read of the persisted value).
  function hardenVar(name, field) {
    if (field && field.state === 'invalid') app.hardenedVars.add(name);
    else app.hardenedVars.delete(name);
  }
  // The Run button's lenient ('input'-mode) gate for an already-computed
  // analysis. #170 review: a field that hardened to invalid (blur/Enter/
  // execute committed a strict invalid verdict) must keep blocking Run even
  // though this recompute is lenient — 'input' mode reads a still-incomplete
  // prefix like '-' as merely incomplete, not invalid — so `app.hardenedVars`
  // is folded in. Only names the batch actually declares are considered, so a
  // hardened flag for a variable that dropped out of the tab's SQL (or
  // belongs to a different tab) doesn't block Run forever; the
  // `!src.invalid.includes` filter just avoids listing a name twice. Shared
  // by setRunBtn's own fallback and renderVarStrip's tail (review F9: one
  // analysis per strip repaint feeds both consumers).
  function inputGate(analysis) {
    const batch = prepareAnalyzedBatch(analysis, wallNow(), 'input');
    const src = batch.sources[0];
    const hardened = [...app.hardenedVars].filter((name) => name in batch.fields && !src.invalid.includes(name));
    return { missing: src.missing, invalid: src.invalid.concat(hardened), errors: src.errors };
  }
  function setRunBtn(running, gate) {
    if (!app.dom.runBtn) return;
    // Disabled while running, or while any detected {name:Type} query variable
    // is missing, invalid (#170), or fails to serialize (#170 review finding:
    // the button's visible disabled state must match varGateBlocked's actual
    // gate, which already blocks on missing+invalid+errors) — with a tooltip
    // so the greyed-out button explains itself. Execution paths (run/
    // runScript) enforce the same gate via varGateBlocked. A caller that
    // already has the prepared source (renderVarStrip) passes its
    // {missing, invalid, errors} to avoid re-preparing; otherwise we compute
    // it here via inputGate — a merely 'incomplete' value (#170) stays
    // display-only and doesn't grey out the button while still focused.
    const tab = app.activeTab();
    if (gate == null) {
      gate = running || !tab
        ? { missing: [], invalid: [], errors: [] }
        : inputGate(tabAnalysis(tab.sql));
    }
    const blockers = gate.missing.concat(gate.invalid);
    app.dom.runBtn.disabled = running || blockers.length > 0 || gate.errors.length > 0;
    app.dom.runBtn.title = blockers.length
      ? 'Enter a value for: ' + blockers.join(', ')
      : gate.errors.length ? gate.errors[0] : '';
    // "Run selection" while the editor has a non-empty selection (so the mode is
    // discoverable); plain "Run" otherwise. Build the children and drop the null
    // (replaceChildren would coerce a null arg into a "null" text node).
    const label = running ? 'Running…' : (app.state.hasSelection.value ? 'Run selection' : 'Run');
    app.dom.runBtn.replaceChildren(
      ...[Icon.play(), h('span', null, label),
        running ? null : h('kbd', null, '⌘↵')].filter(Boolean));
  }
  app.setRunBtn = setRunBtn;
  // Repaint the query-variable strip (#134) for the active tab. Values live in
  // the shared, persisted `state.varValues` (keyed by variable name), so a value
  // typed once is reused by every query that references the same variable and is
  // restored on reload. The listed set comes from the all-active analysis view
  // (#165): a param confined to /*[ ]*/ optional blocks stays listed — marked
  // optional (blank allowed; blank keeps its blocks inactive) — while a param
  // outside blocks stays required. Typing keeps `state.filterActive` in sync
  // (blank ⇒ inactive, typed ⇒ active). Inputs rebuild only when the detected
  // {name:Type} set changes (signature guard) — so typing in the SQL editor
  // doesn't thrash the row or steal focus, and switching between tabs with the
  // same variables keeps the (already-correct, shared) values in place. Always
  // re-syncs the Run button's disabled/tooltip state.
  //
  // #172 v2 (schema-cache inference — the SUGGESTION tier): the enum member
  // list a plain `{name:String}` param's compared column implies, or null.
  // The declared type's own Enum members (v1, authoritative and blocking —
  // #170 validates those as a real Enum) are fieldControlKind's business;
  // this helper only ever resolves the workbench's own SQL against the
  // already-loaded schema cache (`paramComparisonColumns` +
  // `resolveComparisonColumnType`), never a new query, and the declared type
  // stays String, so #170 never blocks on a non-member.
  function inferredEnumOptions(v, sql, comparisonColumns) {
    if (parseParamType(v.type).base !== 'String') return null;
    const cmp = comparisonColumns[v.name];
    if (!cmp) return null;
    const colType = resolveComparisonColumnType(sql, cmp.pos, cmp, app.state.schema.value);
    return colType ? enumValues(colType) : null;
  }
  function renderVarStrip() {
    const strip = app.dom.varStrip;
    if (!strip) return;
    const tab = app.activeTab();
    // One analysis per repaint (review F9): fieldControls, the #172 v2
    // comparison scan, a rebuild's initial field paint, and the tail's Run-
    // button gate all feed off this single pass instead of re-analyzing the
    // same SQL a second time per editor keystroke.
    const analysis = tab ? tabAnalysis(tab.sql) : null;
    const vars = analysis ? fieldControls(analysis) : [];
    // #172 v2 scans the tab SQL's ANALYSIS materialization (review F2): in
    // the raw text a comparison inside a /*[ ]*/ optional block is one opaque
    // comment span and could never match. `resolveComparisonColumnType`
    // resolves each match's position against this same text. (Workbench-only
    // — the Dashboard has no schema cache and gets v1 straight from the type.)
    const scanSql = tab ? analysisView(tab.sql) : '';
    const comparisonColumns = tab ? paramComparisonColumns(scanSql) : {};
    // Each field's control kind + member list (shared enum > date-like > text
    // priority; a type-conflicted field degrades to text — fieldControlKind).
    const controls = vars.map((v) => fieldControlKind(v, inferredEnumOptions(v, scanSql, comparisonColumns)));
    // The signature folds in each var's control kind and resolved enum
    // options — not just name/type/optional — so a column landing on the
    // idle-tick loader (loadColumns calls renderVarStrip on completion)
    // upgrades a v2 field from plain input to the dropdown, and a type
    // conflict appearing or resolving restyles the field, even though the
    // {name:Type} set itself never changed.
    const sig = vars.map((v, i) => {
      const c = controls[i];
      return v.name + ':' + v.type + (v.optional ? '?' : '') + (v.conflict ? '!' : '')
        + ':' + c.kind + (c.enumOptions ? c.enumOptions.length : '');
    }).join(',');
    // The Run button's gate from this SAME analysis (review F9: setRunBtn's
    // gate-less fallback would re-analyze the identical SQL). Lazy so the
    // running / tab-less states (whose gate setRunBtn hard-empties anyway)
    // skip the prepare entirely.
    const runGate = () => (analysis && !app.state.running.value ? inputGate(analysis) : undefined);
    if (sig !== app.dom.varStripSig) {
      // A signature change while the user is focused INSIDE the strip would
      // replaceChildren() every field out from under them — a background
      // column load (loadColumns → renderVarStrip, the #172 v2 upgrade path)
      // completing mid-typing would steal focus, wipe the in-progress text
      // repaint, and destroy any open dropdown. Defer the rebuild until focus
      // leaves the strip: the upgrade only matters on the NEXT interaction
      // anyway. (Typing in the SQL editor also lands here on every keystroke,
      // but then focus is in the editor, not the strip — no deferral.)
      const active = doc.activeElement;
      if (active && strip.contains(active)) {
        app.dom.varStripRerenderPending = true;
        if (!app.dom.varStripDeferHooked) {
          app.dom.varStripDeferHooked = true;
          // One listener for the strip's lifetime (the strip node itself is
          // never replaced, only its children). `focusout` bubbles; when
          // focus merely moves BETWEEN fields of the strip, relatedTarget is
          // still inside it and the deferral holds.
          strip.addEventListener('focusout', (e) => {
            if (!app.dom.varStripRerenderPending) return;
            if (e.relatedTarget && strip.contains(e.relatedTarget)) return;
            app.dom.varStripRerenderPending = false;
            renderVarStrip();
          });
        }
        setRunBtn(app.state.running.value, runGate());
        return;
      }
      app.dom.varStripRerenderPending = false;
      app.dom.varStripSig = sig;
      if (!vars.length) {
        strip.replaceChildren();
        strip.style.display = 'none';
      } else {
        strip.style.display = '';
        // The freshly-(re)built strip paints each field's already-committed
        // state ('execute' mode — no field is mid-typing right after a
        // rebuild, e.g. a tab switch restoring a previously-invalid value).
        const initialFields = prepareAnalyzedBatch(analysis, wallNow(), 'execute').fields;
        strip.replaceChildren(...vars.map((v, i) => {
          // controls[i] (fieldControlKind above) picks the field's control:
          // #172 enum members (v1 declared or v2 inferred) > #169 date-like
          // preset combobox + live preview > plain text with recents (#171).
          // The field stays free-text in every case (absolute values / non-
          // members keep working); persistence/#170 validation stays exactly
          // the shared logic below — the combobox only adds its own focus/
          // keydown-nav/composition hooks, called first from the same
          // handlers (wireComboInput; see relative-time-field.js's header
          // comment on why this beats two independent listeners).
          const ctl = controls[i];
          // #173 acceptance (review F1): a type-conflicted field degrades to
          // the plain text control (ctl.kind above) and says so visibly — a
          // warning style distinct from is-invalid (the VALUE isn't wrong;
          // the declarations disagree) plus a tooltip listing them.
          const conflictNote = v.conflict
            ? 'Conflicting type declarations: ' + v.conflict.join(' vs ') : null;
          const baseTitle = v.name + ': ' + v.type
            + (v.optional ? ' — optional: blank leaves its filter block out' : '')
            + (conflictNote ? ' — ' + conflictNote : '');
          let combo = null;
          let input;
          const onValueInput = () => {
            app.state.varValues[v.name] = input.value;
            // Text controls sync activation with the value (#165).
            app.state.filterActive[v.name] = input.value !== '';
            app.saveVarValues();
            app.saveFilterActive();
            // Editing the value un-hardens it (#170 review): back to
            // neutral, lenient behavior until it's committed again.
            app.hardenedVars.delete(v.name);
            // 'input' mode (#170): a plausible prefix stays neutral while
            // the field is focused — only a value that's already certainly
            // wrong shows the inline error here.
            const batch = prepareTabBatch(tab.sql, wallNow(), 'input');
            applyFieldState(input, batch.fields[v.name], baseTitle, combo && combo.previewEl);
            setRunBtn(app.state.running.value, batch.sources[0]);
          };
          const onCommitHard = () => {
            // Hardens 'incomplete' → 'invalid' on commit (#170).
            const batch = prepareTabBatch(tab.sql, wallNow(), 'execute');
            hardenVar(v.name, batch.fields[v.name]);
            applyFieldState(input, batch.fields[v.name], baseTitle, combo && combo.previewEl);
            setRunBtn(app.state.running.value, batch.sources[0]);
          };
          // #171: live-filtered recents for this field (type + typed text),
          // called fresh on every dropdown open/keystroke — never a snapshot
          // — so a value recorded by a run that completes without changing
          // the strip's {name:Type} signature is never stale. (#160's
          // curated-param opt-out hook: nothing to check yet — no curated
          // param exists before #160 lands.)
          const getRecents = (text) => recentOptions(app.state.varRecent, v.name, v.type, text);
          const onClearRecent = () => app.clearVarRecent(v.name);
          const fieldOpts = {
            document: doc, name: v.name, type: v.type, value: app.state.varValues[v.name] || '',
            baseTitle, onValueInput, onCommit: onCommitHard, getRecents, onClearRecent,
          };
          if (ctl.kind === 'enum') combo = buildEnumField({ ...fieldOpts, values: ctl.enumOptions });
          else if (ctl.kind === 'date') combo = buildRelativeTimeField({ ...fieldOpts, wallNow });
          else combo = buildRecentField(fieldOpts);
          input = combo.input;
          wireComboInput(combo, { onValueInput, onCommit: onCommitHard });
          if (conflictNote) input.classList.add('is-conflict');
          hardenVar(v.name, initialFields[v.name]);
          applyFieldState(input, initialFields[v.name], baseTitle, combo && combo.previewEl);
          return h('label', { class: 'var-field' + (v.optional ? ' is-optional' : '') },
            h('span', { class: 'var-name' }, v.name), combo.el);
        }));
      }
    }
    setRunBtn(app.state.running.value, runGate());
  }
  app.renderVarStrip = renderVarStrip;
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
    const stmts = splitStatements(raw);
    // #165 Format policy: a statement containing /*[ ]*/ optional blocks is
    // never round-tripped through server-side formatQuery() — it would drop or
    // mangle the markers, silently destroying the template. Skip it with a
    // notice; other statements in a script still format normally.
    if (stmts.length <= 1 && hasOptionalBlocks(raw)) {
      flashToast('Statement contains optional blocks — not formatted', { document: doc });
      return;
    }
    await ensureConfig();
    if (!(await getToken())) { chCtx.onSignedOut(); return; }
    const tab = app.activeTab();
    setFmtBtn(true); // formatting a script is one request per statement — show busy
    try {
      if (stmts.length > 1) {
        // Multi-statement: format each (best-effort — keep the original text for any
        // statement that won't format, like insertCreate; skip a template, #165),
        // then reassemble with a `;` and a blank line between statements.
        const skipped = stmts.filter((s) => hasOptionalBlocks(s)).length;
        const formatted = await Promise.all(stmts.map((s) => (hasOptionalBlocks(s) ? s : formatOne(s).catch(() => s))));
        app.editor.replaceDocument(withStatementBreak(formatted.map((q, i) => q || stmts[i]).join(';\n\n')));
        clearFormatError();
        if (skipped) {
          flashToast(skipped + (skipped === 1 ? ' statement contains' : ' statements contain')
            + ' optional blocks — not formatted', { document: doc });
        }
        return;
      }
      // Single statement: send the raw (untrimmed) SQL so a syntax error's reported
      // position maps 1:1 onto the editor text; show it persistently + jump the caret.
      try {
        const q = await formatOne(raw);
        // Terminate so the caret lands past the last token — otherwise the input
        // event from the replace re-opens autocomplete on the trailing word.
        if (q) app.editor.replaceDocument(withStatementBreak(q));
        clearFormatError();
      } catch (e) {
        const msg = String((e && e.message) || e);
        tab.result = newResult('Table');
        tab.result.error = msg;
        tab.result.formatError = true; // a format error, not a run result (so success can clear just this)
        app.state.resultView.value = 'table';
        renderResults(app); // explicit: the format-error tab.result is an in-place write, and resultView may already be 'table' (no effect)
        const pos = parseErrorPos(msg);
        if (pos != null) app.editor.revealOffset(pos);
      }
    } finally {
      setFmtBtn(false);
    }
  }

  // Abort any in-flight schema-lineage fetch. Called both as a manual Cancel
  // (clearResult: true — the user asked to stop) and automatically whenever a
  // new operation takes over the drawer (a fresh graph request, or Run/Explain
  // replacing the tab's result outright) — in the automatic case the caller
  // overwrites tab.result itself right after, so aborting the network request
  // is all that's needed there (the identity guard in showSchemaGraph makes
  // this belt-and-suspenders, not load-bearing, for correctness).
  //
  // With clearResult, the visible result depends on how far the fetch got: if
  // Phase A (the free-edges graph) had already drawn, keep it on screen marked
  // `partial` (its view/MV source edges may be incomplete); otherwise there's
  // nothing worth keeping, so drop back to the normal empty-results placeholder.
  function cancelSchemaGraph({ clearResult = false } = {}) {
    if (app.state.schemaGraphAbortController) app.state.schemaGraphAbortController.abort();
    app.state.schemaGraphAbortController = null;
    if (!clearResult) return;
    const tab = app.activeTab();
    const sg = tab.result && tab.result.schemaGraph;
    if (!sg || !sg.loading) return;
    if (sg.nodes && sg.nodes.length) {
      sg.loading = false;
      sg.partial = true;
    } else {
      tab.result = null;
    }
    renderResults(app);
  }

  // Render the ClickHouse object-lineage graph for a dropped/clicked
  // database/table into the data pane (queries system.* + EXPLAIN AST; the
  // editor SQL is untouched). Two-phase on a large schema (#124): draws as soon
  // as the free edges (dependencies/target/engine-arg/dictionary) are known,
  // then a single second layout merges in view/MV source edges once EXPLAIN AST
  // settles — so the pane isn't blank for the whole round trip. Below
  // AST_PROGRESSIVE_THRESHOLD view/MV objects, loadSchemaLineage skips straight
  // to one draw instead (onBase/onProgress never fire) — a visible first paint
  // is just flicker when the whole fetch settles almost as fast anyway.
  async function showSchemaGraph(focus) {
    if (!focus || !focus.db) return;
    await ensureConfig();
    if (!(await getToken())) { chCtx.onSignedOut(); return; }
    cancelSchemaGraph(); // a new click/drag replaces whatever graph was in flight
    const tab = app.activeTab();
    // Show a loading placeholder first — even Phase A (system.tables +
    // system.dictionaries) is a network round trip.
    tab.result = newResult('Table');
    tab.result.schemaGraph = { focus, loading: true, nodes: [], edges: [] };
    // `result` is the stale-write guard (mirrors #97's identity-guard shape):
    // captured once, checked before every later write, so a Run/Explain or a
    // second graph request that replaces tab.result mid-fetch can never have
    // this call's (Phase A or Phase B) result land on the new tab.result.
    const result = tab.result;
    renderResults(app);
    const controller = new AbortController();
    app.state.schemaGraphAbortController = controller;
    try {
      const lineage = await ch.loadSchemaLineage(chCtx, focus, {
        signal: controller.signal,
        onBase: (base) => {
          if (tab.result !== result) return; // superseded before Phase A even landed
          const g = buildSchemaGraph(base, focus);
          result.schemaGraph = { focus, nodes: g.nodes, edges: g.edges, tableCount: (base.tables || []).length, loading: true };
          renderResults(app);
        },
        onProgress: (done, total) => {
          if (tab.result !== result || !result.schemaGraph || !result.schemaGraph.loading) return;
          result.schemaGraph.progress = { done, total };
          renderResults(app);
        },
      });
      if (tab.result !== result) return; // superseded while Phase B was resolving
      const g = buildSchemaGraph(lineage, focus);
      // tableCount lets the renderer explain an empty result ("N tables, none linked").
      result.schemaGraph = { focus, nodes: g.nodes, edges: g.edges, tableCount: (lineage.tables || []).length };
    } catch (e) {
      // AbortError means cancelSchemaGraph() already left the pane in a clean
      // state (partial graph or the empty placeholder) — nothing more to do.
      if (e.name === 'AbortError') return;
      if (tab.result !== result) return;
      tab.result = newResult('Table');
      tab.result.error = String((e && e.message) || e);
    } finally {
      if (app.state.schemaGraphAbortController === controller) app.state.schemaGraphAbortController = null;
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
        { tables: lineage.rows.tables, columnsByKey: cards.columnsByKey });
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
  // SHOW CREATE and pretty-print it through formatQuery(). Two round-trips
  // by design; if formatting fails the raw DDL is returned. Returns null on
  // failure or an empty statement (having already surfaced the toast), so
  // callers can no-op without inspecting the error themselves.
  async function fetchCreateSql(target) {
    await ensureConfig();
    if (!(await getToken())) { chCtx.onSignedOut(); return null; }
    try {
      const show = await ch.queryJson(chCtx, 'SHOW CREATE ' + target + ' FORMAT JSON');
      const stmt = (show.data && show.data[0] && show.data[0].statement) || '';
      if (!stmt) return null;
      try {
        const fmt = await ch.queryJson(chCtx, 'SELECT formatQuery(' + sqlString(stmt) + ') AS q FORMAT JSON');
        return (fmt.data && fmt.data[0] && fmt.data[0].q) || stmt;
      } catch { return stmt; /* formatting is best-effort — fall back to the raw DDL */ }
    } catch (e) {
      flashToast('SHOW CREATE failed: ' + String((e && e.message) || e), { document: doc });
      return null;
    }
  }

  // Replaces the active editor's content (undo restores the prior query).
  async function insertCreate(target) {
    const sql = await fetchCreateSql(target);
    if (sql != null) app.editor.replaceDocument(sql);
  }

  // Opens the DDL in a new tab, leaving the active tab untouched.
  async function openCreateInNewTab(target, name) {
    const sql = await fetchCreateSql(target);
    if (sql == null) return;
    loadIntoNewTab(app, name, sql);
    toEditorOnMobile();
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
    const panel = tabPanel(tab);
    // The gate matches the decode side (main.js): sql OR panel — a text panel
    // legitimately has no SQL, and a sql-only check would make it unshareable.
    if (!sql && !isQuerylessPanel(panel)) return;
    const url = loc.origin + loc.pathname + loc.search + '#' + encodeShare(sql, panel);
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
    const waveMs = wallNow(); // one wall clock for this export wave (gate + args)
    if (varGateBlocked(waveMs)) return; // don't export with unfilled variables (#134)
    const sel = app.editor.getSelection().text;
    const input = sel.trim() !== '' ? sel : app.activeTab().sql;
    const statements = splitStatements(input);
    if (!statements.length) { flashToast('Nothing to export', { document: doc }); return; }
    if (statements.length === 1) return exportDirect(statements[0], waveMs);
    return exportScriptEntry(statements, input, waveMs);
  }

  async function exportDirect(sqlInput, waveMs) {
    if (app.state.exporting.value) return;
    if (!app.canExport()) return; // aria-disabled button; defensive guard
    const tab = app.activeTab();
    // Export streams the execution view (#165) — identical bytes without blocks.
    const { sql, format } = prepareExportSql(execStatementSql(sqlInput));
    if (!sql) { flashToast('Nothing to export', { document: doc }); return; }
    const { ext, mime } = formatFileMeta(format);
    // Prepared args captured NOW — synchronously with exportEntry's gate
    // check, BEFORE the picker/auth awaits below (review F6 invariant, shared
    // with run/runScript/exportScript): gate and args see the same varValues
    // snapshot; edits during those awaits apply to the next export. (Session
    // params stay live below — they don't read varValues.)
    const paramArgs = mergedSourceArgs(prepareTabSource(sql, waveMs));

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
          // Native query-parameter substitution (#134/#173), same as run() —
          // paramArgs is the wave-start snapshot captured above (review F6).
          params: { ...sessionParamsFor(tab, [sql]), ...paramArgs },
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
  async function exportScriptEntry(statements, originalInput, waveMs) {
    if (!app.canExportScript()) {
      flashToast('Script export requires Chrome/Edge directory access over HTTPS', { document: doc });
      return;
    }
    if (!statements.some(isRowReturning)) {
      flashToast('Nothing to export — script has no result-producing statements.', { document: doc });
      return;
    }
    // One prepared batch for the whole export wave (#173), captured NOW —
    // synchronously with exportEntry's gate check, BEFORE the directory-picker
    // and auth awaits below (review F6 invariant, shared with run/runScript/
    // exportDirect): gate and args see the same varValues snapshot; edits
    // during those awaits apply to the next export. `statements` came from
    // splitStatements(originalInput), so the batch aligns by index.
    const paramSrc = prepareTabSource(originalInput, waveMs);
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
      await exportScript(statements, dir, paramSrc);
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
  async function exportScript(statements, dir, paramSrc) {
    const tab = app.activeTab();
    const t0 = now();
    const sp = sessionParamsFor(tab, statements);
    // `paramSrc` is the wave's prepared batch (#173), captured by
    // exportScriptEntry at wave start, before its awaits (review F6).
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
        // Wire text = the pipeline's per-statement execution view (#165);
        // verbatim for effect/DDL statements and for block-free SQL.
        const execStmt = paramSrc.statements[e.i].sql;
        const { sql, format } = prepareExportSql(execStmt);
        // Per-statement prepared args (#134/#173): the pipeline binds only
        // row-returning statements, so an effect/DDL statement (incl. CREATE
        // VIEW) is sent with its {name:Type} placeholders intact.
        const params = { ...sp, ...paramSrc.statements[e.i].args };
        exportScriptQueryId = 'export-' + uid('');
        exportScriptAbort = new AbortController();
        const signal = exportScriptAbort.signal;
        e.startedAt = now();
        e.status = e.type === 'rows' ? 'exporting' : 'running';
        renderResults(app);
        try {
          if (e.type !== 'rows') {
            const out = await ch.runQuery(chCtx, execStmt,
              { format: 'TSV', signal, queryId: exportScriptQueryId, params });
            if (out.error != null) throw new Error(out.error);
            e.status = 'ok';
          } else {
            const { ext } = formatFileMeta(format);
            const name = scriptExportName(e.i, e.sql, ext, taken);
            taken.add(name);
            e.file = name;
            const fileHandle = await dir.getFileHandle(name, { create: true });
            const resp = await ch.exportQuery(chCtx, sql,
              { queryId: exportScriptQueryId, signal, format, params });
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
  // to a saved entry and its SQL AND panel config are unchanged; "Save"
  // otherwise (incl. dirty) — a panel edit re-arms the button exactly like a
  // SQL edit (#166 dirty pin), else the stale "Saved" label would tell the
  // user their panel change needs no re-save.
  app.updateSaveBtn = () => {
    if (!app.dom.saveBtn) return;
    const tab = app.activeTab();
    const entry = savedForTab(app.state, tab);
    const panelClean = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
    const clean = !!entry && entry.sql.trim() === String(tab.sql || '').trim()
      && panelClean(entry.panel, tabPanel(tab));
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
    if (app.state.isMobile.value) {
      // Mobile (#126): the trigger can sit mid-toolbar (the toolbar scrolls), so
      // right-aligning to it pushes a fixed-width popover off the narrow
      // viewport's left edge. Center it horizontally instead (still dropped below
      // the trigger via `top`); the mobile max-width clamps keep it in-bounds.
      node.style.left = '50%';
      node.style.transform = 'translateX(-50%)';
    } else {
      node.style.right = a.right + 'px';
    }
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
    // A queryless panel (text, #166) is authored entirely in its cfg, so it
    // saves with empty SQL — the same per-type relaxation saveQuery applies.
    if (!String(tab.sql || '').trim() && !isQuerylessPanel(tabPanel(tab))) {
      flashToast('Nothing to save', { document: doc });
      return;
    }
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

  // On mobile (#126), jump the bottom-nav to the Editor panel after an action
  // that changes the editor content; a no-op on desktop.
  const toEditorOnMobile = () => { if (app.state.isMobile.value) app.state.mobileView.value = 'editor'; };

  // --- dashboard (#149 D1) ----------------------------------------------
  // ensureConfig + getToken, resolving (and refreshing) the auth token ONCE.
  // The dashboard calls this before fanning tiles out, so the tiles never each
  // race an expired-token refresh (a rotating refresh token used N-ways at once
  // would invalidate itself), and a single sign-out is handled by the caller
  // instead of N tiles each firing onSignedOut. Also used by bootstrap to
  // refresh a handed-off-but-expired token before falling back to login.
  async function ensureFreshToken() {
    await ensureConfig();
    return !!(await getToken());
  }
  app.ensureFreshToken = ensureFreshToken;

  // Dashboard tiles stream their read-only SQL through the shared
  // `app.runReadInto` seam directly (#193 — see src/ui/dashboard.js
  // `runSlotTile`), the same path run() and the detached Data view use; the
  // former bespoke `runTile`/`queryDashboardTile`/`parseJsonResult` machinery
  // was retired so cap/settings fixes can't apply to only one path.
  app.renderDashboard = () => renderDashboard(app);

  // One-time cross-tab auth handoff. The dashboard opens in a new same-origin
  // tab whose sessionStorage starts empty; rather than force a second sign-in,
  // this (opener) tab grants its live credentials once when the child asks.
  // Both sides pin the target origin AND the peer window; a timeout stops the
  // opener listening if the child never asks. Message contract: core/auth-handoff.
  // Two windows: the child waits HANDOFF_MS for a grant once it *asks* (a
  // same-origin reply is near-instant, so this is short); the opener listens far
  // longer (HANDOFF_LISTEN_MS) because it must survive the child's cold JS load
  // before the child can ask — a short opener window would drop a slow tab's
  // request and force a needless re-login.
  const HANDOFF_MS = env.handoffMs != null ? env.handoffMs : 4000;
  const HANDOFF_LISTEN_MS = env.handoffListenMs != null ? env.handoffListenMs : 30000;
  function sendAuthHandoff(child) {
    const onMsg = (e) => {
      if (!isAuthRequest(e, loc.origin, child)) return;
      const creds = snapshotAuth(ss);
      // Only grant when we actually hold credentials — never hand over an empty
      // snapshot (which the child would have to reject anyway).
      if (hasAuth(creds)) child.postMessage({ type: AUTH_GRANT, creds }, loc.origin);
      win.removeEventListener('message', onMsg);
    };
    win.addEventListener('message', onMsg);
    win.setTimeout(() => win.removeEventListener('message', onMsg), HANDOFF_LISTEN_MS);
  }
  // Open the dashboard in a new tab and stand ready to hand it our credentials.
  function openDashboard() {
    const child = app.openWindow(loc.origin + app.basePath + '/dashboard');
    if (child) sendAuthHandoff(child);
  }
  app.openDashboard = openDashboard;

  // Restore a handed-off credential snapshot into BOTH this tab's sessionStorage
  // and the already-constructed in-memory auth fields — token/authMode/idp/origin
  // were snapshotted from an empty ss at construction, so writing keys back alone
  // wouldn't take effect until a reload.
  function applyAuthSnapshot(creds) {
    restoreAuth(ss, creds);
    if (creds.ch_basic_auth) {
      app.authMode = 'basic';
      chCtx.origin = creds.ch_basic_origin || loc.origin;
    } else {
      if (creds.oauth_id_token) setTokens(creds.oauth_id_token, creds.oauth_refresh_token);
      if (creds.oauth_idp) app.idpId = creds.oauth_idp;
      chCtx.origin = creds.oauth_origin || loc.origin;
    }
  }
  // Child side: ask the opener for credentials once. Resolves true once a valid
  // grant is applied; false when there's no opener or the request times out (a
  // cold/bookmarked visit → the caller falls through to the normal login flow).
  app.receiveAuthHandoff = (handoffEnv) => new Promise((resolve) => {
    const opener = handoffEnv.opener;
    if (!opener) { resolve(false); return; }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      win.removeEventListener('message', onMsg);
      resolve(ok);
    };
    const onMsg = (e) => {
      if (!isAuthGrant(e, loc.origin, opener)) return;
      // Ignore an empty grant (opener signed out / mid-sign-in) — keep waiting so
      // the request times out into the normal login rather than falsely
      // reporting success with no credentials applied.
      if (!hasAuth(e.data.creds)) return;
      applyAuthSnapshot(e.data.creds);
      finish(true);
    };
    win.addEventListener('message', onMsg);
    opener.postMessage({ type: AUTH_REQUEST }, loc.origin);
    win.setTimeout(() => finish(false), HANDOFF_MS);
  });

  // --- actions registry --------------------------------------------------
  app.actions = {
    run: runEntry,
    cancel,
    newTab: () => newTab(app),
    selectTab: (id) => selectTab(app, id),
    closeTab: (id) => closeTab(app, id),
    loadIntoNewTab: (name, sql, savedId, panel) => { loadIntoNewTab(app, name, sql, savedId, panel); toEditorOnMobile(); },
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
    cancelSchemaGraph,
    expandSchemaGraph,
    openNodeDetail,
    insertCreate: async (target) => { await insertCreate(target); toEditorOnMobile(); },
    openCreateInNewTab: (target, name) => openCreateInNewTab(target, name),
    openShortcuts: () => openShortcuts(app),
    openDashboard,
    // Editor-mutating actions jump the mobile bottom-nav to the Editor panel
    // (#126) so a schema tap / SHOW CREATE lands where the user can see it.
    insertAtCursor: (text) => { app.editor.insertAtCursor(text); toEditorOnMobile(); },
    replaceEditor: (text) => { app.editor.replaceDocument(text); toEditorOnMobile(); },
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
    h('div', { class: 'logo-name' }, 'Altinity® SQL Browser'),
    h('div', { class: 'env-chip' }, app.host()),
    h('div', { class: 'hd-divider' }),
    ...libraryControls(app),
    h('div', { style: { flex: '1' } }),
    app.dom.connStatus,
    h('a', {
      // hd-hide-mobile: decorative/desktop-only header items are hidden below the
      // breakpoint (#126) so the essential controls (File menu, theme, user menu)
      // fit a phone width instead of overflowing off-screen. See styles.css.
      class: 'hd-btn hd-hide-mobile', href: 'https://github.com/Altinity/altinity-sql-browser',
      target: '_blank', rel: 'noopener noreferrer', title: 'View source on GitHub',
    }, Icon.github()),
    h('button', { class: 'hd-btn hd-hide-mobile', title: 'Keyboard shortcuts (?)', onclick: () => app.actions.openShortcuts() }, Icon.shortcuts()),
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
      else if (axis === 'sideRow') schemaPane.style.height = value + '%';
      else app.dom.editorRegion.style.height = value + '%';
    },
    save: (name, value) => app.savePref(name, value),
  };
  app.dom.sideSplit = h('div', { class: 'row-resize side-split', onmousedown: (e) => helpers.startDrag(e, 'sideRow', dragCtx) });
  // Mobile Tables view (#126): a Schema | Library segmented control at the top of
  // the sidebar. CSS hides it above the breakpoint; below it, it swaps which pane
  // shows (the sidebar's data-mobile-tab drives both the active-button style and
  // the pane visibility — no JS effect needed for the active state).
  app.dom.mobileSegmented = h('div', { class: 'mobile-segmented' },
    h('button', { class: 'mseg-btn', 'data-seg': 'schema', onclick: () => { state.mobileTab.value = 'schema'; } }, Icon.database(), h('span', null, 'Schema')),
    h('button', { class: 'mseg-btn', 'data-seg': 'library', onclick: () => { state.mobileTab.value = 'library'; } }, Icon.layers(), h('span', null, 'Queries')));
  sidebar.append(app.dom.mobileSegmented, schemaPane, app.dom.sideSplit, savedPane);
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
  // Query-variable strip (#134): one input per detected {name:Type} placeholder,
  // in a single row that scrolls horizontally (never wraps) when there are many.
  // Hidden (no vertical space) until the active tab has variables — see
  // renderVarStrip. Sits below the toolbar so it doesn't compete with the
  // splitter-sized editor for height.
  app.dom.varStrip = h('div', { class: 'var-strip', style: { display: 'none' } });
  app.dom.editorRegion = h('div', { class: 'editor-region', style: { height: state.editorPct + '%', minHeight: '0', overflow: 'hidden', flexShrink: '0' } });
  app.dom.resultsRegion = h('div', { class: 'results-region', style: { flex: '1', minHeight: '0', overflow: 'hidden' } });
  // Drop a database/table from the schema tree here → render its lineage graph.
  // Disabled in mobile mode (#126): native drag doesn't fire from touch, and the
  // schema tree drops its drag sources below the breakpoint, so accepting a drop
  // here would be a dead affordance. (Clicking a db row still draws the graph via
  // showSchemaGraph — #124's tap-native trigger — so nothing is lost.)
  app.dom.resultsRegion.addEventListener('dragover', (e) => {
    if (state.isMobile.value) return;
    if (e.dataTransfer && [...e.dataTransfer.types].includes(SCHEMA_GRAPH_MIME)) e.preventDefault();
  });
  app.dom.resultsRegion.addEventListener('drop', (e) => {
    if (state.isMobile.value) return;
    const payload = e.dataTransfer && e.dataTransfer.getData(SCHEMA_GRAPH_MIME);
    if (!payload) return;
    e.preventDefault();
    try { app.actions.showSchemaGraph(JSON.parse(payload)); } catch { /* malformed payload */ }
  });
  app.dom.editorResultsSplit = h('div', { class: 'row-resize', onmousedown: (e) => helpers.startDrag(e, 'row', dragCtx) });

  const workbench = h('div', { class: 'workbench' }, qtabsRow, editorToolbar, app.dom.varStrip, app.dom.editorRegion, app.dom.editorResultsSplit, app.dom.resultsRegion);
  app.dom.banner = h('div', { class: 'auth-banner', style: { display: 'none' } });
  const mainRow = h('div', { class: 'main-row' }, sidebar, sideHandle, workbench);

  // Mobile bottom-tab nav (#126): one full-screen panel at a time. CSS hides it
  // above the breakpoint; below it, `mainRow[data-mobile-view]` (set by the
  // effect below) picks which of sidebar / editor / results fills the screen.
  // The Results tab carries a live badge (row count, or ● while a query streams).
  app.dom.mobileBadge = h('span', { class: 'mnav-badge' });
  const navBtn = (view, icon, label, extra) => h('button', {
    class: 'mobile-nav-btn', 'data-view': view, onclick: () => { state.mobileView.value = view; },
  }, h('span', { class: 'mnav-ic' }, icon, extra || null), h('span', { class: 'mnav-label' }, label));
  app.dom.mobileNav = h('div', { class: 'mobile-nav' },
    navBtn('tables', Icon.database(), 'Tables'),
    navBtn('editor', Icon.code(), 'Editor'),
    navBtn('results', Icon.table2(), 'Results', app.dom.mobileBadge));

  app.root.replaceChildren(header, app.dom.banner, mainRow, app.dom.mobileNav);

  app.editor.mount(app.dom.editorRegion);
  // Reactive repaint of the tab-dependent surface — replaces the old tabs.js
  // refresh(): re-runs whenever the tab list or active tab changes, so tab ops
  // just mutate the signals.
  effect(() => {
    app.state.tabs.value;
    app.state.activeTabId.value;
    renderTabs(app);
    app.editor.syncFromState();
    app.updateSaveBtn();
    app.renderVarStrip(); // switching tabs / opening a saved query re-detects variables
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
    const sel = app.editor.hasFocus() ? app.editor.getSelection().text : '';
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
    // Crossing the mobile breakpoint (#126) adds/removes each row's drag source
    // and hover title, so repaint the tree when isMobile flips.
    app.state.isMobile.value;
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
  // Mobile mode (#126): mirror the viewport width into `isMobile` (drives the
  // schema tree's drag/hover affordances, the results drop target, and the
  // auto-navigation in the action wrappers) via the injected matchMedia seam.
  // When the platform has no matchMedia the app stays in desktop JS mode — the
  // mobile CSS still applies, just without JS branching.
  const mq = app.matchMedia && app.matchMedia('(max-width: ' + MOBILE_BREAKPOINT_PX + 'px)');
  if (mq) {
    state.isMobile.value = mq.matches;
    mq.addEventListener('change', (e) => { state.isMobile.value = e.matches; });
  }
  // Bottom-nav view switching: reflect the active mobile panel + Tables segmented
  // choice onto data-attributes the mobile CSS keys off (a no-op above the
  // breakpoint). Each runs once now for the initial paint.
  effect(() => { mainRow.dataset.mobileView = state.mobileView.value; });
  effect(() => { sidebar.dataset.mobileTab = state.mobileTab.value; });
  // The Results nav badge: ● while a query streams, else the row count (blank for
  // no/raw result). Same deps as the results repaint so it tracks run/tab/view.
  effect(() => {
    state.running.value; state.activeTabId.value; state.resultView.value;
    const r = app.activeTab().result;
    app.dom.mobileBadge.textContent = state.running.value
      ? '●'
      : (r && r.rawText == null && r.progress ? formatRows(r.progress.rows) : '');
  });
  // The shell is mounted (and laid out in a real engine), so the viewport-unit
  // overshoot is measurable now — publish --vp-zoom before any fullscreen graph
  // panel can open, so it sizes correctly on this engine (#70).
  app.applyViewportZoom();
  app.loadVersion();
  app.loadSchema();
  app.loadReference();
}
