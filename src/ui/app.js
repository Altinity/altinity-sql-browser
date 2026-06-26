// The application controller. `createApp(env)` returns the `app` object every
// render module receives: state, DOM refs, persistence helpers, the ClickHouse
// fetch context, and the action callbacks. All environment access (document,
// window, location, fetch, crypto, sessionStorage) is injected so the whole
// controller is testable under happy-dom with stubs.

import { h } from './dom.js';
import { Icon } from './icons.js';
import {
  createState, activeTab, KEYS, recordHistory, saveQuery, savedForTab, tabChart,
} from '../state.js';
import { saveJSON, saveStr } from '../core/storage.js';
import { decodeJwtPayload, isTokenExpired } from '../core/jwt.js';
import { sqlString, inferQueryName, shortVersion, userShortName, withStatementBreak, detectSqlFormat } from '../core/format.js';
import { EXPLAIN_VIEWS, parseExplain, detectExplainView, buildExplainQuery } from '../core/explain.js';
import { buildSchemaGraph, expandLineage } from '../core/schema-graph.js';
import { buildCardGraph } from '../core/schema-cards.js';
import { resolveTarget } from '../core/target.js';
import { toTSV, toCSV } from '../core/export.js';
import { newResult, applyStreamLine, parseErrorPos } from '../core/stream.js';
import { encodeShare } from '../core/share.js';
import { assembleReferenceData, buildCompletions } from '../core/completions.js';
import { generatePKCE, randomState } from '../core/pkce.js';
import * as oauthCfg from '../net/oauth-config.js';
import * as oauth from '../net/oauth.js';
import * as ch from '../net/ch-client.js';
import { mountEditor, insertAtCursor, replaceEditor, SCHEMA_GRAPH_MIME } from './editor.js';
import { renderTabs, selectTab, newTab, closeTab, loadIntoNewTab } from './tabs.js';
import { renderSchema } from './schema.js';
import { renderResults } from './results.js';
import { openSchemaFullscreen } from './explain-graph.js';
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
    doc,
    token: ss.getItem('oauth_id_token'),
    refreshToken: ss.getItem('oauth_refresh_token'),
    // Charting seam: the Chart.js constructor (injected so tests stub it) and a
    // CSS-custom-property reader (canvas needs real colors, not `var(--x)`).
    Chart: env.Chart || win.Chart,
    cssVar: env.cssVar || ((name) => win.getComputedStyle(doc.documentElement).getPropertyValue(name)),
    // Pipeline-graph layout seam: dagre (injected like Chart). The DOT parser and
    // SVG drawer are ours; dagre only computes node positions + edge bend points.
    Dagre: env.Dagre || win.dagre,
  };

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
  // Exposed seams for the header File menu (file-menu.js): the file-download
  // helper (defined below) and a library-title refresh (dirty dot + name) run
  // after a library mutation made outside file-menu.js (e.g. the save popover).
  app.downloadFile = downloadFile;
  app.updateLibraryTitle = () => renderLibraryTitle(app);

  // --- identity ----------------------------------------------------------
  app.host = () => (app.authMode === 'basic'
    ? originHost(chCtx.origin) || 'clickhouse'
    : loc.host || 'clickhouse');
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
      app.state.schema = await ch.loadSchema(chCtx);
      app.state.schemaError = null;
    } catch (e) {
      app.state.schemaError = String((e && e.message) || e);
    }
    app.rebuildCompletions();
    renderSchema(app);
    updateBanner();
  };
  // Editor reference data + autocomplete candidates. Loaded once per connection
  // (the keystroke rule, #25): keywords/functions drive both version-correct
  // highlighting and the autocomplete list; completion then runs client-side.
  app.refData = assembleReferenceData(null); // built-in fallback until loaded
  app.rebuildCompletions = () => {
    app.completions = buildCompletions(app.refData, app.state.schema);
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
    const err = app.state.schemaError;
    if (!err || app._bannerDismissedFor === err) {
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
        onclick: () => { app._bannerDismissedFor = err; b.style.display = 'none'; },
      }, '×'),
    );
  }
  app.updateBanner = updateBanner;
  async function loadColumns(db, table, tableObj) {
    tableObj.columns = 'loading';
    renderSchema(app);
    try {
      await ensureConfig();
      tableObj.columns = await ch.loadColumns(chCtx, db, table, sqlString);
    } catch {
      tableObj.columns = [];
    }
    app.rebuildCompletions(); // newly-loaded columns become completion candidates (#26)
    renderSchema(app);
  }

  // --- query run ---------------------------------------------------------
  const now = () => (env.now || (() => win.performance.now()))();
  // Milliseconds since the running query started (0 when idle). Used for the
  // live counter, computed fresh so each render/tick shows the current value.
  app.elapsedMs = () => (app.state.runT0 != null ? now() - app.state.runT0 : 0);
  // Update only the live elapsed-ms readout (no table re-render). Driven by an
  // interval while running so it ticks even for queries that emit no rows (sleep).
  function tickElapsed() {
    if (app.dom.runElapsedEl) app.dom.runElapsedEl.textContent = app.elapsedMs().toFixed(0) + ' ms';
  }
  app.tickElapsed = tickElapsed;

  async function run(opts) {
    if (app.state.running) return; // already running — cancel via cancel()/Esc
    const tab = app.activeTab();
    if (!tab.sql.trim()) return;
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
    const explicitFmt = detectSqlFormat(tab.sql);
    const parsed = explicitFmt ? null : parseExplain(tab.sql);
    const explainMode = !explicitFmt && (parsed != null || app.state.forceExplain);
    let runSql = tab.sql;
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
      const inner = parsed ? parsed.inner : tab.sql;
      runSql = explainView === 'explain'
        ? (parsed ? tab.sql : 'EXPLAIN ' + tab.sql)
        : buildExplainQuery(inner, explainView);
    } else {
      fmt = explicitFmt || 'Table';
    }

    const t0 = now();
    tab.result = newResult(fmt);
    if (explainView) tab.result.explainView = explainView;
    app.state.resultSort = { col: null, dir: 'asc' };
    // Keep the current Table/JSON/Chart tab across re-runs (#34); a saved-query
    // open passes its remembered view in opts.view to restore that instead.
    const view = opts && opts.view;
    app.state.resultView = ['table', 'json', 'chart'].includes(view) ? view : app.state.resultView;
    app.state.running = true;
    app.state.runT0 = t0;
    app.state.runQueryId = cryptoObj.randomUUID ? cryptoObj.randomUUID() : 'q' + t0;
    setRunBtn(true);
    renderResults(app);
    app.state.abortController = new AbortController();
    app.state.runTick = setInterval(tickElapsed, 100);

    try {
      const out = await ch.runQuery(chCtx, runSql, {
        format: fmt,
        queryId: app.state.runQueryId,
        signal: app.state.abortController.signal,
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
      app.state.running = false;
      app.state.abortController = null;
      app.state.runQueryId = null;
      app.state.runT0 = null;
      tab.result.progress.elapsed_ns = (now() - t0) * 1e6;
      setRunBtn(false);
      renderResults(app);
      if (!tab.result.error && !tab.result.cancelled) app.recordHistory(tab);
    }
  }
  // Stop an in-flight query: abort the stream and KILL QUERY on the server.
  function cancel() {
    if (!app.state.running) return;
    if (app.state.abortController) app.state.abortController.abort();
    ch.killQuery(chCtx, app.state.runQueryId, sqlString);
  }
  function setRunBtn(running) {
    if (!app.dom.runBtn) return;
    app.dom.runBtn.disabled = running;
    // Build the children and drop the null (replaceChildren would otherwise
    // coerce a null arg into a "null" text node → "Running…null").
    app.dom.runBtn.replaceChildren(
      ...[Icon.play(), h('span', null, running ? 'Running…' : 'Run'),
        running ? null : h('kbd', null, '⌘↵')].filter(Boolean));
  }
  app.setRunBtn = setRunBtn;

  // Pretty-print the editor's SQL via ClickHouse's formatQuery(), in place. The
  // raw (untrimmed) SQL is sent so a syntax error's reported position maps 1:1
  // onto the editor text. On error we show it persistently in the results panel
  // and jump the caret to the offending token; a later successful format clears
  // that error. Success never touches real run results.
  async function formatQuery() {
    const raw = app.activeTab().sql || '';
    if (!raw.trim()) return;
    await ensureConfig();
    if (!(await getToken())) { chCtx.onSignedOut(); return; }
    const tab = app.activeTab();
    try {
      const json = await ch.queryJson(chCtx, 'SELECT formatQuery(' + sqlString(raw) + ') AS q FORMAT JSON');
      const q = (json.data && json.data[0] && json.data[0].q) || '';
      // Terminate so the caret lands past the last token — otherwise the input
      // event from the replace re-opens autocomplete on the trailing word.
      if (q) replaceEditor(app, withStatementBreak(q));
      if (tab.result && tab.result.formatError) { tab.result = null; renderResults(app); } // clear a prior format error
    } catch (e) {
      const msg = String((e && e.message) || e);
      tab.result = newResult('Table');
      tab.result.error = msg;
      tab.result.formatError = true; // a format error, not a run result (so success can clear just this)
      app.state.resultView = 'table';
      renderResults(app);
      const pos = parseErrorPos(msg);
      if (pos != null) app.dom.editorRevealCaret(pos);
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
    await ensureConfig();
    if (!(await getToken())) { chCtx.onSignedOut(); return; }
    let lineage;
    try {
      // Walk lineage transitively across DB boundaries (soft-capped) — pulls in
      // objects an other database references, instead of dead-ending at the edge.
      lineage = await ch.loadLineageTransitive(chCtx, focus);
    } catch {
      // The inline graph is still on screen; tell the user the expand didn't load.
      flashToast('Could not load the schema graph', { document: doc });
      return;
    }
    const g = buildSchemaGraph(lineage.rows, focus);
    const ex = expandLineage(g, focus.db); // closure around focus.db, tags external nodes
    // Card metadata for every database the expansion reached (external nodes too).
    const dbs = [...new Set(ex.nodes.map((n) => n.db).filter(Boolean))];
    const cards = await ch.loadSchemaCards(chCtx, dbs);
    const cardGraph = buildCardGraph({ nodes: ex.nodes, edges: ex.edges },
      { tables: lineage.rows.tables, columnsByKey: cards.columnsByKey, skipByKey: cards.skipByKey });
    openSchemaFullscreen(app, {
      nodes: cardGraph.nodes, edges: cardGraph.edges, focus,
      tableCount: (lineage.rows.tables || []).length,
      truncated: lineage.truncated || ex.truncated,
    });
  }

  // Open the detail pane for a clicked fullscreen node: lazily load the table's full
  // columns / partitions / DDL (best-effort) and mount the pane in the overlay.
  async function openNodeDetail(node) {
    if (!node || !node.db || !node.name) return;
    const detail = await ch.loadTableDetail(chCtx, node.db, node.name);
    openDetailPane(app, node, detail);
  }

  // Explain the current query without editing it: run it through the EXPLAIN
  // views (the editor SQL is left untouched; run() wraps it as needed).
  function explainQuery() { return run({ explain: true }); }
  // Switch the active EXPLAIN view (re-runs the derived query, keeps the mode).
  function setExplainView(id) { return run({ explainView: id }); }

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
  app.recordHistory = (tab) => {
    recordHistory(app.state, tab, saveJSON);
    if (app.state.sidePanel === 'history') renderSavedHistory(app);
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
    return r && !r.error && (r.rawText != null || r.rows.length > 0) ? r : null;
  }
  function copyResult() {
    const r = exportableResult();
    if (!r) { flashToast('Nothing to copy', { document: doc }); return; }
    const text = r.rawText != null ? r.rawText : toTSV(r.columns, r.rows);
    const clip = (env.navigator || win.navigator || {}).clipboard;
    if (clip && clip.writeText) {
      clip.writeText(text)
        .then(() => flashToast('Copied to clipboard', { document: doc }))
        .catch(() => flashToast('Copy failed', { document: doc }));
    } else {
      flashToast('Copy not supported', { document: doc });
    }
  }
  function exportResult() {
    const r = exportableResult();
    if (!r) { flashToast('Nothing to export', { document: doc }); return; }
    let content, ext, mime;
    if (r.rawText != null) {
      content = r.rawText;
      ext = r.rawFormat === 'JSON' ? 'json' : 'tsv';
      mime = ext === 'json' ? 'application/json' : 'text/tab-separated-values';
    } else {
      content = toCSV(r.columns, r.rows);
      ext = 'csv';
      mime = 'text/csv';
    }
    const base = (app.activeTab().name || 'result').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'result';
    downloadFile(base + '.' + ext, mime, content);
    flashToast('Exported ' + base + '.' + ext, { document: doc });
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
    node.style.position = 'fixed';
    node.style.top = (r.bottom + 6) + 'px';
    node.style.right = Math.max(8, (win.innerWidth || 0) - r.right) + 'px';
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
      app.updateLibraryTitle();
      flashToast('Saved', { document: doc });
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
    const menu = h('div', { class: 'user-menu' },
      h('div', { class: 'um-id' }, app.email()),
      h('button', { class: 'um-item danger', onclick: () => { close(); app.signOut(); } }, Icon.logout(), h('span', null, 'Log out')));
    ({ close } = anchoredPopover(menu, app.dom.userBtn, 'userMenu'));
  }
  app.openUserMenu = openUserMenu;

  function toggleTheme() {
    app.state.theme = app.state.theme === 'dark' ? 'light' : 'dark';
    app.savePref('theme', app.state.theme);
    doc.documentElement.setAttribute('data-theme', app.state.theme);
    if (app.dom.themeBtn) app.dom.themeBtn.replaceChildren(app.state.theme === 'dark' ? Icon.sun() : Icon.moon());
  }

  // --- actions registry --------------------------------------------------
  app.actions = {
    run,
    cancel,
    newTab: () => newTab(app),
    selectTab: (id) => selectTab(app, id),
    closeTab: (id) => closeTab(app, id),
    loadIntoNewTab: (name, sql, savedId, chart) => loadIntoNewTab(app, name, sql, savedId, chart),
    login: (idpId, targetOrigin) => login(idpId, targetOrigin),
    connect,
    share,
    copyResult,
    exportResult,
    save: openSavePopover,
    openUserMenu,
    formatQuery,
    explainQuery,
    setExplainView,
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
  const { state, doc } = app;
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
    oninput: (e) => { state.schemaFilter = e.target.value; renderSchema(app); },
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
  app.dom.shareBtn = h('button', { class: 'tb-btn', title: 'Share query (copies link)', onclick: () => app.actions.share() }, Icon.share(), 'Share');

  const editorToolbar = h('div', { class: 'ed-toolbar' }, app.dom.runBtn, app.dom.fmtBtn, app.dom.explainBtn, app.dom.saveBtn, h('div', { style: { flex: '1' } }), app.dom.shareBtn);
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
  renderTabs(app);
  renderResults(app);
  renderSchema(app);
  renderSavedHistory(app);
  app.updateSaveBtn();
  app.loadVersion();
  app.loadSchema();
  app.loadReference();
}
