// Browser entry point. `bootstrap(app, env)` handles the OAuth redirect
// callback, share-links, and the initial render; it is pure over an injected
// `env` so it is integration-tested. The module-level block at the bottom is
// the real side-effect that runs in the browser (and is coverage-ignored).

import { createApp } from './ui/app.js';
import { handleKeydown } from './ui/shortcuts.js';
import { exchangeCodeForTokens, bearerFromTokens } from './net/oauth.js';
import { decodeSqlFromHash } from './core/share.js';
import { isTokenExpired } from './core/jwt.js';

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

  // A shared query rides in the URL hash, which is lost through the OAuth
  // redirect (and we strip it below). Stash it in sessionStorage so it survives
  // the round-trip and restore it once we're back, signed in.
  let sharedSql = decodeSqlFromHash(loc.hash);
  if (sharedSql) ss.setItem('oauth_shared_sql', sharedSql);
  else sharedSql = ss.getItem('oauth_shared_sql') || '';
  if (sharedSql) {
    app.state.tabs[0].sql = sharedSql;
    app.state.tabs[0].name = 'Shared query';
    hist.replaceState(null, '', loc.pathname + loc.search);
  }

  if (app.token && !isTokenExpired(app.token, 0)) {
    ss.removeItem('oauth_shared_sql'); // consumed
    app.renderApp();
  } else {
    app.showLogin(callbackError);
  }
  return { callbackError, signedIn: app.isSignedIn() };
}

/* c8 ignore start -- browser entry side-effect, exercised via the live app */
if (typeof document !== 'undefined' && !globalThis.__ASB_NO_AUTOSTART__) {
  const app = createApp();
  document.addEventListener('keydown', (e) => handleKeydown(e, app));
  bootstrap(app, {
    location: window.location,
    sessionStorage: window.sessionStorage,
    history: window.history,
    fetch: window.fetch.bind(window),
  });
}
/* c8 ignore stop */
