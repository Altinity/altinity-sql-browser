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
import { setTabSpecDraft, SAVED_VIEWS } from './state.js';
import type { State } from './ui/app.types.js';
import type { BootstrapEnv } from './env.types.js';
import type { ConnectionSession } from './application/connection-session.js';
import type { SpecEditorApp } from './editor/spec-editor.js';
import type { ShortcutKeydownEvent } from './ui/shortcuts.js';

/** The narrow slice of the real `app` controller `bootstrap` reads — not the
 *  full ~50-member `App` contract (app.types.ts). A real `App` (this module's
 *  own `createApp()` call below) satisfies this directly, and so does
 *  tests/unit/main.test.ts's long-standing minimal `fakeApp()` fixture — no
 *  cast needed on either side (same convention as ui/shortcuts.ts's
 *  ShortcutsApp). Identity/auth reads go through `conn` (#276 Phase 5 —
 *  the flat `App` delegates were deleted; `loadConfig` is now `resolveConfig`,
 *  its real name on `ConnectionSession`). */
export interface BootstrapApp {
  state: Pick<State, 'tabs' | 'resultView'>;
  conn: Pick<ConnectionSession,
    'isSignedIn' | 'resolveConfig' | 'setTokens' | 'receiveAuthHandoff' | 'ensureFreshToken' | 'ensureConfig'>;
  renderDashboard(): void;
  renderApp(): void;
  /** The real `App.showLogin` is `(msg?: string) => void` — every other real
   *  caller (ui/login.ts) always passes a string. `callbackError` below is
   *  main.ts's own `string | null` sentinel (`null` means "no callback
   *  error"), so this contract states what's actually passed here. */
  showLogin(msg?: string | null): void;
  /** #287 W4: resolve the current StoredWorkspaceV1 aggregate (migrating the
   *  legacy flat state once, if needed) and project it onto `app.state`
   *  before the first `renderApp()` — see `App.loadWorkspaceOnBoot`'s own doc
   *  comment (app.types.ts). The real return value is never read here
   *  (`Promise<unknown>` is enough for `bootstrap`'s own purposes). */
  loadWorkspaceOnBoot(): Promise<unknown>;
}

/** `app.state.resultView`'s value union, reused at the one cast below. */
type ResultView = State['resultView']['value'];

export async function bootstrap(app: BootstrapApp, env: BootstrapEnv): Promise<{ callbackError: string | null; signedIn: boolean }> {
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
  let callbackError: string | null = null;

  if (errorParam) {
    // The IdP bounced back with an error (e.g. ?error=access_denied) instead of
    // a code — surface it rather than dropping silently onto the login screen.
    callbackError = 'Sign-in failed: ' + (u.searchParams.get('error_description') || errorParam);
  } else if (code && stateParam) {
    if (stateParam !== ss.getItem('oauth_state')) {
      callbackError = 'OAuth state mismatch — please try again.';
    } else {
      try {
        const cfg = await app.conn.resolveConfig();
        const tokens = await exchangeCodeForTokens(env.fetch, cfg, {
          code,
          // `verifier` is written to sessionStorage just before the redirect;
          // CodeExchangeParams' field is non-nullable, but a cast (not a
          // behavior guard) keeps the exact pre-existing pass-through-null
          // runtime shape for a stale/direct hit with no stashed verifier.
          verifier: ss.getItem('oauth_verifier') as string,
          redirectUri: loc.origin + loc.pathname,
        });
        const bearer = bearerFromTokens(tokens, cfg.bearer);
        if (!bearer) throw new Error('Token response missing bearer token');
        app.conn.setTokens(bearer, tokens.refresh_token);
      } catch (e) {
        callbackError = 'OAuth token exchange failed: ' + ((e instanceof Error && e.message) || e);
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
        // `JSON.parse`'s own return is untyped; the ingress shape here is the
        // same loosely-checked `Record<string, unknown>` saved-query.js's own
        // helpers (isPlainObject et al.) treat arbitrary stored JSON as.
        const raw = (JSON.parse(ss.getItem('oauth_shared') || 'null') || { sql: '' }) as Record<string, unknown>;
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
      const rolePreview = rolePreviewView(shared.spec);
      const launchView = rolePreview || queryView(shared);
      // Normalize a legacy `view: 'chart'` (pre-Panel shares) to 'panel', then
      // validate against the resultView union before assigning (#266): the v2
      // tagged decode passes `spec.view` through verbatim, so a crafted share
      // link could otherwise set `resultView` to an arbitrary string. Mirrors
      // ui/saved-history.ts's `rolePreview || SAVED_VIEWS.has(...)` guard — a
      // role-owned Filter preview wins, a persisted table/json/panel restores,
      // and any other value silently falls back to the default view. `as`:
      // that check is the runtime proof `normalized` is a resultView member.
      const normalized = launchView === 'chart' ? 'panel' : launchView;
      if (rolePreview || SAVED_VIEWS.has(normalized ?? '')) app.state.resultView.value = normalized as ResultView;
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
  if (dash && !app.conn.isSignedIn()) {
    await app.conn.receiveAuthHandoff(env);
    // The opener may hand over an *expired* id_token whose refresh token is still
    // good (an idle opener refreshes only lazily). Attempt a refresh before
    // giving up — otherwise a valid handoff would still bounce to a full re-login.
    if (!app.conn.isSignedIn()) await app.conn.ensureFreshToken();
  }

  if (app.conn.isSignedIn()) {
    // Signed in either via a valid OAuth token or a restored basic session.
    ss.removeItem('oauth_shared'); // consumed
    // Resolve config first so the header shows the real CH identity (the
    // ch_auth=basic username, not the raw email claim) on first paint.
    // (ensureConfig is a no-op in basic mode.)
    await app.conn.ensureConfig();
    if (dash) app.renderDashboard();
    else {
      // #287 W4: resolve + project the aggregate before the Workbench's first
      // paint so the saved-query sidebar/Save flow already treat it as the
      // single source of truth (the /dashboard branch above keeps resolving
      // its own copy via `renderDashboard` → `loadDashboardWorkspace`).
      await app.loadWorkspaceOnBoot();
      app.renderApp();
    }
  } else {
    app.showLogin(callbackError);
  }
  return { callbackError, signedIn: app.conn.isSignedIn() };
}

// Set once by tests/setup.js to keep the browser-only autostart block below
// from running under happy-dom.
declare global {
  // eslint-disable-next-line no-var
  var __ASB_NO_AUTOSTART__: boolean | undefined;
}

/* c8 ignore start -- browser entry side-effect, exercised via the live app */
// `createSpecEditor`'s own `SpecEditorApp` param (spec-editor.ts) is a real,
// pre-existing mismatch against `App` (`App.specValidators` is
// `SpecValidationService`, `SpecEditorApp` wants the differently-shaped
// `SpecValidatorsLike` — a "weak type" with zero overlapping property names)
// — out of this task's file scope to widen; bridged the same `object`-param
// way as tests/unit/app.test.ts's own `asSpecEditorApp`.
const asSpecEditorApp = (v: object): SpecEditorApp => v as SpecEditorApp;
// `KeyboardEvent.target`'s real DOM type (`EventTarget | null`) doesn't
// structurally satisfy `ShortcutKeydownEvent`'s `target` (shortcuts.ts's own
// doc comment says a real `KeyboardEvent` "satisfies it directly", true at
// runtime but not for TS's structural check on `target`) — same bridge.
const asShortcutEvent = (v: object): ShortcutKeydownEvent => v as ShortcutKeydownEvent;

if (typeof document !== 'undefined' && !globalThis.__ASB_NO_AUTOSTART__) {
  const app = createApp({
    Chart, Dagre, Editor: createCodeMirrorEditor,
    SpecEditor: (app) => createSpecEditor(asSpecEditorApp(app)),
    CodeViewer: createCodeViewer, build: '__ASB_BUILD__',
  });
  document.addEventListener('keydown', (e) => handleKeydown(asShortcutEvent(e), app));
  bootstrap(app, {
    location: window.location,
    sessionStorage: window.sessionStorage,
    history: window.history,
    fetch: window.fetch.bind(window),
    opener: window.opener, // dashboard tab reads its opener for the auth handoff
  });
}
/* c8 ignore stop */
