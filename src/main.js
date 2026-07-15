// Browser entry point. `bootstrap(app, env)` handles the OAuth redirect
// callback, share-links, and the initial render; it is pure over an injected
// `env` so it is integration-tested. The module-level block at the bottom is
// the real side-effect that runs in the browser (and is coverage-ignored).

import Chart from 'chart.js/auto';
import Dagre from '@dagrejs/dagre';
import { createApp } from './ui/app.js';
import { createCodeMirrorEditor } from './editor/codemirror-adapter.js';
import { createSpecEditor } from './editor/spec-editor.js';
import { createCodeViewer } from './editor/code-viewer.js';
import { handleKeydown } from './ui/shortcuts.js';
import { exchangeCodeForTokens, bearerFromTokens } from './net/oauth.js';
import { decodeShare } from './core/share.js';
import { cloneJson, queryName, queryPanel, queryView, upgradeSavedQuery } from './core/saved-query.js';
import { isDashboardRoute } from './core/dashboard.js';
import { rolePreviewView } from './core/result-choice.js';
import { isQuerylessPanel } from './core/panel-cfg.js';
import { setTabSpecDraft } from './state.js';

export async function bootstrap(app, env) {
  const loc = env.location;
  const ss = env.sessionStorage;
  const hist = env.history;
  // The standalone dashboard route (#149) reuses this same bootstrap + app: it
  // shares the OAuth-callback handling below, but renders the dashboard instead
  // of the workbench and skips editor-only share-link seeding.
  const dash = isDashboardRoute(loc.pathname);
  const u = new URL(loc.href);
  const code = u.searchParams.get('code');
  const stateParam = u.searchParams.get('state');
  const errorParam = u.searchParams.get('error');
  let callbackError = null;

  if (errorParam) {
    // The IdP bounced back with an error (e.g. ?error=access_denied) instead of
    // a code — surface it rather than dropping silently onto the login screen.
    callbackError = 'Sign-in failed: ' + (u.searchParams.get('error_description') || errorParam);
  } else if (code && stateParam) {
    if (stateParam !== ss.getItem('oauth_state')) {
      callbackError = 'OAuth state mismatch — please try again.';
    } else {
      try {
        const cfg = await app.loadConfig();
        const tokens = await exchangeCodeForTokens(env.fetch, cfg, {
          code,
          verifier: ss.getItem('oauth_verifier'),
          redirectUri: loc.origin + loc.pathname,
        });
        const bearer = bearerFromTokens(tokens, cfg.bearer);
        if (!bearer) throw new Error('Token response missing bearer token');
        app.setTokens(bearer, tokens.refresh_token);
      } catch (e) {
        callbackError = 'OAuth token exchange failed: ' + ((e && e.message) || e);
      }
    }
  }
  if (errorParam || (code && stateParam)) {
    ['code', 'state', 'scope', 'authuser', 'prompt', 'error', 'error_description', 'error_uri']
      .forEach((k) => u.searchParams.delete(k));
    const qs = u.searchParams.toString();
    hist.replaceState(null, '', loc.origin + loc.pathname + (qs ? '?' + qs : '') + loc.hash);
  }

  // A shared query (SQL + complete Spec) rides in the URL hash, which is lost
  // through the OAuth redirect (and we strip it below). Stash it in
  // sessionStorage so it survives the round-trip and restore it once we're back.
  // The dashboard route has no editor tab to seed, so it skips this entirely.
  // Gates are `sql || panel` (#166): a text panel legitimately has no SQL, so
  // a sql-only check would silently drop its share link.
  if (!dash) {
    let shared = decodeShare(loc.hash);
    if (shared.sql || queryPanel(shared)) ss.setItem('oauth_shared', JSON.stringify(shared));
    else {
      // The stash is a second deserialization point that bypasses decodeShare —
      // it may hold a pre-#166 `{sql, chart}` stash, so upgrade applies here too.
      try {
        const raw = JSON.parse(ss.getItem('oauth_shared') || 'null') || { sql: '' };
        shared = upgradeSavedQuery(raw.specVersion == null
          ? { name: 'Shared query', ...raw }
          : raw);
      } catch { shared = decodeShare(''); }
    }
    const panel = queryPanel(shared);
    if (shared.sql || panel) {
      const t0 = app.state.tabs.value[0];
      t0.sqlDraft = shared.sql;
      t0.name = queryName(shared);
      t0.specVersion = shared.specVersion;
      setTabSpecDraft(t0, cloneJson(shared.spec));
      // Restore the initial result view with the same role-aware precedence as
      // Library activation (#244): a role-owned transient preview (Filter)
      // wins over the persisted view, regardless of whether the share carries
      // SQL to run — a SQL-bearing share never auto-runs here, so this only
      // pre-selects the drawer the recipient lands on before they click Run.
      const launchView = rolePreviewView(shared.spec) || queryView(shared);
      if (launchView) app.state.resultView.value = launchView === 'chart' ? 'panel' : launchView;
      // A queryless panel with no role/persisted view (no SQL to run) still
      // needs the Panel drawer open, or the recipient lands on an empty Table
      // view and sees nothing.
      else if (!shared.sql && isQuerylessPanel(panel)) app.state.resultView.value = 'panel';
      hist.replaceState(null, '', loc.pathname + loc.search);
    }
  }

  // A freshly-opened dashboard tab is signed out (per-tab sessionStorage); try a
  // one-time credential handoff from the opener before deciding what to render.
  // A cold/bookmarked visit has no opener → falls through to the login screen,
  // which after sign-in returns to /sql/dashboard and renders the dashboard.
  if (dash && !app.isSignedIn()) {
    await app.receiveAuthHandoff(env);
    // The opener may hand over an *expired* id_token whose refresh token is still
    // good (an idle opener refreshes only lazily). Attempt a refresh before
    // giving up — otherwise a valid handoff would still bounce to a full re-login.
    if (!app.isSignedIn()) await app.ensureFreshToken();
  }

  if (app.isSignedIn()) {
    // Signed in either via a valid OAuth token or a restored basic session.
    ss.removeItem('oauth_shared'); // consumed
    // Resolve config first so the header shows the real CH identity (the
    // ch_auth=basic username, not the raw email claim) on first paint.
    // (ensureConfig is a no-op in basic mode.)
    await app.ensureConfig();
    if (dash) app.renderDashboard(); else app.renderApp();
  } else {
    app.showLogin(callbackError);
  }
  return { callbackError, signedIn: app.isSignedIn() };
}

/* c8 ignore start -- browser entry side-effect, exercised via the live app */
if (typeof document !== 'undefined' && !globalThis.__ASB_NO_AUTOSTART__) {
  const app = createApp({
    Chart, Dagre, Editor: createCodeMirrorEditor, SpecEditor: createSpecEditor,
    CodeViewer: createCodeViewer, build: '__ASB_BUILD__',
  });
  document.addEventListener('keydown', (e) => handleKeydown(e, app));
  bootstrap(app, {
    location: window.location,
    sessionStorage: window.sessionStorage,
    history: window.history,
    fetch: window.fetch.bind(window),
    opener: window.opener, // dashboard tab reads its opener for the auth handoff
  });
}
/* c8 ignore stop */
