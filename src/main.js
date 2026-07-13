// Browser entry point. `bootstrap(app, env)` handles the OAuth redirect
// callback, share-links, and the initial render; it is pure over an injected
// `env` so it is integration-tested. The module-level block at the bottom is
// the real side-effect that runs in the browser (and is coverage-ignored).

import Chart from 'chart.js/auto';
import Dagre from '@dagrejs/dagre';
import { createApp } from './ui/app.js';
import { createCodeMirrorEditor } from './editor/codemirror-adapter.js';
import { createCodeViewer } from './editor/code-viewer.js';
import { handleKeydown } from './ui/shortcuts.js';
import { exchangeCodeForTokens, bearerFromTokens } from './net/oauth.js';
import { decodeShare } from './core/share.js';
import { upgradeSavedEntry } from './core/saved-io.js';
import { clonePanelCfg } from './core/panel-cfg.js';
import { isDashboardRoute } from './core/dashboard.js';

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

  // A shared query (SQL + panel config) rides in the URL hash, which is lost
  // through the OAuth redirect (and we strip it below). Stash it in
  // sessionStorage so it survives the round-trip and restore it once we're back.
  // The dashboard route has no editor tab to seed, so it skips this entirely.
  // Gates are `sql || panel` (#166): a text panel legitimately has no SQL, so
  // a sql-only check would silently drop its share link.
  if (!dash) {
    let shared = decodeShare(loc.hash);
    if (shared.sql || shared.panel) ss.setItem('oauth_shared', JSON.stringify(shared));
    else {
      // The stash is a second deserialization point that bypasses decodeShare —
      // it may hold a pre-#166 `{sql, chart}` stash, so upgrade applies here too.
      try {
        const raw = JSON.parse(ss.getItem('oauth_shared') || 'null') || { sql: '' };
        const up = upgradeSavedEntry(raw);
        shared = { sql: up.sql || '', panel: up.panel && up.panel.cfg ? up.panel : null };
      } catch { shared = { sql: '', panel: null }; }
    }
    if (shared.sql || shared.panel) {
      const t0 = app.state.tabs.value[0];
      t0.sql = shared.sql;
      t0.name = 'Shared query';
      if (shared.panel && shared.panel.cfg) {
        t0.panelCfg = clonePanelCfg(shared.panel.cfg);
        t0.panelKey = shared.panel.key ?? null;
        // A panel-only link (no SQL to run) must open the Panel drawer, or
        // the recipient lands on an empty Table view and sees nothing.
        if (!shared.sql) app.state.resultView.value = 'panel';
      }
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
  const app = createApp({ Chart, Dagre, Editor: createCodeMirrorEditor, CodeViewer: createCodeViewer, build: '__ASB_BUILD__' });
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
