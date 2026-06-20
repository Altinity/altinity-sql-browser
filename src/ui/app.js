// The application controller. `createApp(env)` returns the `app` object every
// render module receives: state, DOM refs, persistence helpers, the ClickHouse
// fetch context, and the action callbacks. All environment access (document,
// window, location, fetch, crypto, sessionStorage) is injected so the whole
// controller is testable under happy-dom with stubs.

import { h } from './dom.js';
import { Icon } from './icons.js';
import {
  createState, activeTab, KEYS, recordHistory, findSavedBySql, toggleSaved,
} from '../state.js';
import { saveJSON, saveStr } from '../core/storage.js';
import { decodeJwtPayload, isTokenExpired } from '../core/jwt.js';
import { sqlString } from '../core/format.js';
import { newResult, applyStreamLine } from '../core/stream.js';
import { encodeSqlForHash } from '../core/share.js';
import { generatePKCE, randomState } from '../core/pkce.js';
import * as oauthCfg from '../net/oauth-config.js';
import * as oauth from '../net/oauth.js';
import * as ch from '../net/ch-client.js';
import { mountEditor, insertAtCursor, insertTopLine, replaceEditor } from './editor.js';
import { renderTabs, selectTab, newTab, closeTab, loadIntoNewTab } from './tabs.js';
import { renderSchema } from './schema.js';
import { renderResults } from './results.js';
import { renderSavedHistory } from './saved-history.js';
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
  };

  const loadConfig = oauthCfg.memoizeConfig(() => oauthCfg.loadOAuthConfig(fetchFn, loc.pathname));

  // --- persistence -------------------------------------------------------
  app.saveJSON = saveJSON;
  app.savePref = (name, value) => saveStr(KEYS[name], String(value));

  // --- identity ----------------------------------------------------------
  app.host = () => loc.host || 'clickhouse';
  app.activeTab = () => activeTab(app.state);
  app.isSignedIn = () => !!app.token && !isTokenExpired(app.token, 0);
  app.email = () => {
    const p = decodeJwtPayload(app.token);
    return p.email || p.preferred_username || p.sub || '';
  };

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
    ['oauth_id_token', 'oauth_refresh_token', 'oauth_verifier', 'oauth_state'].forEach((k) => ss.removeItem(k));
  }
  app.setTokens = setTokens;
  app.clearTokens = clearTokens;
  app.loadConfig = loadConfig;

  app.signOut = () => { clearTokens(); renderLogin(app); };
  app.showLogin = (msg) => renderLogin(app, msg);

  // --- OAuth -------------------------------------------------------------
  async function login() {
    const cfg = await loadConfig();
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
    const cfg = await loadConfig();
    const tokens = await oauth.refreshTokens(fetchFn, cfg, app.refreshToken);
    const bearer = oauth.bearerFromTokens(tokens, cfg.bearer);
    if (!bearer) return false;
    setTokens(bearer, tokens.refresh_token);
    return true;
  }

  async function getToken() {
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
  function authHeader(token) {
    if (app.chAuth !== 'basic') return 'Bearer ' + token;
    const p = decodeJwtPayload(token);
    const user = p.email || p.preferred_username || p.sub || '';
    return 'Basic ' + btoa(unescape(encodeURIComponent(user + ':' + token)));
  }
  const chCtx = {
    fetch: fetchFn,
    origin: loc.origin,
    getToken,
    refresh,
    authHeader,
    onSignedOut: () => { clearTokens(); renderLogin(app, 'Session expired'); },
  };
  app.chCtx = chCtx;

  // Load config (once) and apply the CH auth mode before any query runs.
  // Fail-soft: if config can't be loaded we keep the current mode (bearer)
  // rather than blocking the query.
  async function ensureConfig() {
    try {
      const cfg = await loadConfig();
      app.chAuth = cfg.chAuth;
      return cfg;
    } catch {
      return null;
    }
  }
  app.ensureConfig = ensureConfig;

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
    app.dom.connStatus.replaceChildren(h('span', { class: 'ver' },
      online ? 'ClickHouse ' + app.state.serverVersion : 'offline'));
  }
  app.loadSchema = async () => {
    try {
      await ensureConfig();
      app.state.schema = await ch.loadSchema(chCtx);
      app.state.schemaError = null;
    } catch (e) {
      app.state.schemaError = String((e && e.message) || e);
    }
    renderSchema(app);
    updateBanner();
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
    renderSchema(app);
  }

  // --- query run ---------------------------------------------------------
  async function run() {
    if (app.state.running) {
      if (app.state.abortController) app.state.abortController.abort();
      return;
    }
    const tab = app.activeTab();
    if (!tab.sql.trim()) return;
    await ensureConfig();
    if (!(await getToken())) { chCtx.onSignedOut(); return; }

    const fmt = app.state.outputFormat || 'Table';
    const t0 = (env.now || (() => win.performance.now()))();
    tab.result = newResult(fmt);
    app.state.resultSort = { col: null, dir: 'asc' };
    app.state.resultView = 'table';
    app.state.running = true;
    setRunBtn(true);
    renderResults(app);
    app.state.abortController = new AbortController();

    try {
      const out = await ch.runQuery(chCtx, tab.sql, {
        format: fmt,
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
      if (e.name === 'AbortError') tab.result.error = 'Query was cancelled';
      else if (e instanceof TypeError) tab.result.error = 'Network error';
      else tab.result.error = String((e && e.message) || e);
    } finally {
      app.state.running = false;
      app.state.abortController = null;
      tab.result.progress.elapsed_ns = ((env.now || (() => win.performance.now()))() - t0) * 1e6;
      setRunBtn(false);
      renderResults(app);
      if (!tab.result.error) app.recordHistory(tab);
    }
  }
  function setRunBtn(running) {
    if (!app.dom.runBtn) return;
    app.dom.runBtn.disabled = running;
    app.dom.runBtn.replaceChildren(Icon.play(), h('span', null, running ? 'Running…' : 'Run'),
      running ? null : h('kbd', null, '⌘↵'));
  }

  // Pretty-print the editor's SQL via ClickHouse's formatQuery(), in place.
  async function formatQuery() {
    const sql = (app.activeTab().sql || '').trim();
    if (!sql) return;
    await ensureConfig();
    if (!(await getToken())) { chCtx.onSignedOut(); return; }
    try {
      const json = await ch.queryJson(chCtx, 'SELECT formatQuery(' + sqlString(sql) + ') AS q FORMAT JSON');
      const q = (json.data && json.data[0] && json.data[0].q) || '';
      if (q) replaceEditor(app, q);
    } catch (e) {
      flashToast('Format failed: ' + String((e && e.message) || e), { document: doc });
    }
  }

  // Fetch the DDL for `target` (e.g. 'db.table' or 'DATABASE db') with
  // SHOW CREATE, pretty-print it through formatQuery(), and drop it in as a top
  // line. Two round-trips by design; if formatting fails the raw DDL is used.
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
      insertTopLine(app, out);
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
    const sql = (app.activeTab().sql || '').trim();
    if (!sql) return;
    const url = loc.origin + loc.pathname + loc.search + '#' + encodeSqlForHash(sql);
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
  app.updateStar = () => {
    if (!app.dom.starBtn) return;
    const saved = !!findSavedBySql(app.state, app.activeTab().sql || '');
    app.dom.starBtn.replaceChildren(Icon.star(saved));
    app.dom.starBtn.classList.toggle('star-on', saved);
    app.dom.starBtn.title = saved ? 'Remove from saved (⌘S)' : 'Save query (⌘S)';
  };
  function toggleSavedActive() {
    toggleSaved(app.state, app.activeTab().sql || '', saveJSON);
    app.updateStar();
    if (app.state.sidePanel === 'saved') renderSavedHistory(app);
  }

  function toggleTheme() {
    app.state.theme = app.state.theme === 'dark' ? 'light' : 'dark';
    app.savePref('theme', app.state.theme);
    doc.documentElement.setAttribute('data-theme', app.state.theme);
    if (app.dom.themeBtn) app.dom.themeBtn.replaceChildren(app.state.theme === 'dark' ? Icon.sun() : Icon.moon());
  }

  // --- actions registry --------------------------------------------------
  app.actions = {
    run,
    newTab: () => newTab(app),
    selectTab: (id) => selectTab(app, id),
    closeTab: (id) => closeTab(app, id),
    loadIntoNewTab: (name, sql) => loadIntoNewTab(app, name, sql),
    login,
    share,
    toggleSaved: toggleSavedActive,
    formatQuery,
    insertCreate,
    openShortcuts: () => openShortcuts(app),
    insertAtCursor: (text) => insertAtCursor(app, text),
    insertTopLine: (text) => insertTopLine(app, text),
    loadColumns,
    rerenderTabs: () => renderTabs(app),
    rerenderResults: () => renderResults(app),
    updateStar: () => app.updateStar(),
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

  const header = h('div', { class: 'app-header' },
    h('div', { class: 'logo-mark' }, 'A'),
    h('div', { class: 'logo-name' }, 'Altinity SQL Browser'),
    h('div', { class: 'env-chip' }, app.host()),
    h('div', { style: { flex: '1' } }),
    app.dom.connStatus,
    h('button', { class: 'hd-btn', title: 'Keyboard shortcuts (?)', onclick: () => app.actions.openShortcuts() }, Icon.shortcuts()),
    app.dom.themeBtn,
    h('div', { class: 'user-email', title: app.email() }, app.email()),
    h('button', { class: 'hd-btn text', title: 'Log out', onclick: () => app.signOut() }, 'Log Out'),
    h('a', {
      class: 'hd-btn', href: 'https://github.com/Altinity/altinity-sql-browser',
      target: '_blank', rel: 'noopener noreferrer', title: 'View source on GitHub',
    }, Icon.github()));

  app.dom.schemaSearchInput = h('input', {
    type: 'text', placeholder: 'Search tables, columns…',
    oninput: (e) => { state.schemaFilter = e.target.value; renderSchema(app); },
  });
  app.dom.schemaList = h('div', { class: 'schema-list' });
  const schemaPane = h('div', { class: 'side-pane schema-pane', style: { height: state.sideSplitPct + '%', flexShrink: '0', minHeight: '0' } },
    h('div', { class: 'schema-search' }, h('div', { class: 'search-wrap' }, Icon.search(), app.dom.schemaSearchInput)),
    app.dom.schemaList);

  app.dom.savedTabsRow = h('div', { class: 'side-tabs' });
  app.dom.savedList = h('div', { class: 'saved-list' });
  const savedPane = h('div', { class: 'side-pane saved-pane', style: { flex: '1', minHeight: '0' } }, app.dom.savedTabsRow, app.dom.savedList);

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
  app.dom.fmtSelect = h('select', {
    class: 'tb-select', title: 'Output format',
    onchange: (e) => { state.outputFormat = e.target.value; app.savePref('format', state.outputFormat); },
  },
    h('option', { value: 'Table', selected: state.outputFormat === 'Table' }, 'Table'),
    h('option', { value: 'TSV', selected: state.outputFormat === 'TSV' }, 'TSV'),
    h('option', { value: 'JSON', selected: state.outputFormat === 'JSON' }, 'JSON'));
  app.dom.starBtn = h('button', { class: 'tb-btn star-btn', title: 'Save query', onclick: () => app.actions.toggleSaved() });
  app.dom.shareBtn = h('button', { class: 'tb-btn', title: 'Share query (copies link)', onclick: () => app.actions.share() }, Icon.share(), 'Share');

  const editorToolbar = h('div', { class: 'ed-toolbar' }, app.dom.runBtn, h('div', { style: { flex: '1' } }), app.dom.starBtn, app.dom.shareBtn, app.dom.fmtSelect);
  app.dom.editorRegion = h('div', { class: 'editor-region', style: { height: state.editorPct + '%', minHeight: '0', overflow: 'hidden', flexShrink: '0' } });
  app.dom.resultsRegion = h('div', { class: 'results-region', style: { flex: '1', minHeight: '0', overflow: 'hidden' } });
  app.dom.editorResultsSplit = h('div', { class: 'row-resize', onmousedown: (e) => helpers.startDrag(e, 'row', dragCtx) });

  const workbench = h('div', { class: 'workbench' }, qtabsRow, editorToolbar, app.dom.editorRegion, app.dom.editorResultsSplit, app.dom.resultsRegion);
  app.dom.banner = h('div', { class: 'auth-banner', style: { display: 'none' } });
  app.root.replaceChildren(header, app.dom.banner, h('div', { class: 'main-row' }, sidebar, sideHandle, workbench));

  mountEditor(app, app.dom.editorRegion);
  renderTabs(app);
  renderResults(app);
  renderSchema(app);
  renderSavedHistory(app);
  app.updateStar();
  app.loadVersion();
  app.loadSchema();
}
