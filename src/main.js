// Browser entry point. `bootstrap(app, env)` handles the OAuth redirect
// callback, share-links, and the initial render; it is pure over an injected
// `env` so it is integration-tested. The module-level block at the bottom is
// the real side-effect that runs in the browser (and is coverage-ignored).

import Chart from 'chart.js/auto';
import Dagre from '@dagrejs/dagre';
import { createApp } from './ui/app.js';
import { createCodeMirrorEditor } from './editor/codemirror-adapter.js';
import { handleKeydown } from './ui/shortcuts.js';
import { exchangeCodeForTokens, bearerFromTokens } from './net/oauth.js';
import { decodeShare } from './core/share.js';
import { cloneChartCfg } from './core/chart-data.js';

export async function bootstrap(app, env) {
  const loc = env.location;
  const ss = env.sessionStorage;
  const hist = env.history;
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

  // A shared query (SQL + chart config) rides in the URL hash, which is lost
  // through the OAuth redirect (and we strip it below). Stash it in
  // sessionStorage so it survives the round-trip and restore it once we're back.
  let shared = decodeShare(loc.hash);
  if (shared.sql) ss.setItem('oauth_shared', JSON.stringify(shared));
  else {
    try { shared = JSON.parse(ss.getItem('oauth_shared') || 'null') || { sql: '', chart: null }; }
    catch { shared = { sql: '', chart: null }; }
  }
  if (shared.sql) {
    const t0 = app.state.tabs.value[0];
    t0.sql = shared.sql;
    t0.name = 'Shared query';
    if (shared.chart && shared.chart.cfg) {
      t0.chartCfg = cloneChartCfg(shared.chart.cfg);
      t0.chartKey = shared.chart.key ?? null;
    }
    hist.replaceState(null, '', loc.pathname + loc.search);
  }

  if (app.isSignedIn()) {
    // Signed in either via a valid OAuth token or a restored basic session.
    ss.removeItem('oauth_shared'); // consumed
    // Resolve config first so the header shows the real CH identity (the
    // ch_auth=basic username, not the raw email claim) on first paint.
    // (ensureConfig is a no-op in basic mode.)
    await app.ensureConfig();
    app.renderApp();
  } else {
    app.showLogin(callbackError);
  }
  return { callbackError, signedIn: app.isSignedIn() };
}

/* c8 ignore start -- browser entry side-effect, exercised via the live app */
if (typeof document !== 'undefined' && !globalThis.__ASB_NO_AUTOSTART__) {
  const app = createApp({ Chart, Dagre, Editor: createCodeMirrorEditor, build: '__ASB_BUILD__' });
  document.addEventListener('keydown', (e) => handleKeydown(e, app));
  bootstrap(app, {
    location: window.location,
    sessionStorage: window.sessionStorage,
    history: window.history,
    fetch: window.fetch.bind(window),
  });
}
/* c8 ignore stop */
