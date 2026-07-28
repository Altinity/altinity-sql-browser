// Browser entry point. `bootstrap(app, env)` handles the OAuth redirect
// callback, share-links, and the initial render; it is pure over an injected
// `env` so it is integration-tested. The module-level block at the bottom is
// the real side-effect that runs in the browser (and is coverage-ignored).

import Chart from 'chart.js/auto';
// Side-effect only: registers Chart.js's `_adapters._date` implementation so
// `scales.x.type: 'time'` (line/area charts over a time-role X column — #309)
// can compute real time-boundary ticks; `chart.js/auto` bundles the `time`
// scale itself but ships no date-math backend of its own.
import 'chartjs-adapter-date-fns';
import Dagre from '@dagrejs/dagre';
import { createApp } from './ui/app.js';
import { createCodeMirrorEditor } from './editor/codemirror-adapter.js';
import { createSpecEditor } from './editor/spec-editor.js';
import { createCodeViewer } from './editor/code-viewer.js';
import { handleKeydown } from './ui/shortcuts.js';
import { exchangeCodeForTokens, bearerFromTokens } from './net/oauth.js';
import { decodeShare } from './core/share.js';
import { queryPanel } from './core/saved-query.js';
import { normalizeSqlRouteSearch, parseSqlRoute } from './core/sql-route.js';
import type { OAuthDocumentRecoveryApplyResult } from './ui/app.types.js';
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
  catalog: { loadVersion(): Promise<void> };
  conn: Pick<ConnectionSession,
    'basePath' | 'isSignedIn' | 'resolveConfig' | 'setTokens' | 'ensureConfig'>;
  renderCurrentSurface(): void;
  syncSqlRoute(search: string): void;
  /** The real `App.showLogin` is `(msg?: string) => void` — every other real
   *  caller (ui/login.ts) always passes a string. `callbackError` below is
   *  main.ts's own `string | null` sentinel (`null` means "no callback
   *  error"), so this contract states what's actually passed here. */
  showLogin(msg?: string | null): void;
  /** Create the disposable execution scope for the signed-in credential epoch
   * before any shell/catalog operation is allowed to run. */
  resumeAuthenticatedExecution(): void;
  /** Resolve the explicit or last-used StoredWorkspaceV5 and project it onto
   *  `app.state` before the first `renderApp()` — see
   *  `App.loadWorkspaceOnBoot`'s own doc comment (app.types.ts). The real
   *  return value is never read here (`Promise<unknown>` is enough for
   *  `bootstrap`'s own purposes). */
  loadWorkspaceOnBoot(): Promise<unknown>;
  /** Restore an OAuth-state-bound document session after the committed
   * workspace has loaded. The application owns validation and recovery-key
   * lifecycle; bootstrap only decides whether legacy share seeding still runs.
   */
  restoreOAuthDocumentRecovery(callbackState: string): OAuthDocumentRecoveryApplyResult;
  /** Retry a callback-marked pending recovery after an authoritative workspace
   * load. A plain checkpoint without that marker returns a non-restored result. */
  retryPendingOAuthDocumentRecovery(): OAuthDocumentRecoveryApplyResult;
  /** Consume the one-shot shared-link handoff after workspace load. A restored
   * OAuth document passes false so shared content is discarded, never merged. */
  consumeLegacyShared(allowRestore: boolean, consumedHandoff: string | null): boolean;
}

const recoveryOwnsLegacyShare = (
  recovery: OAuthDocumentRecoveryApplyResult | null,
): boolean => recovery?.kind === 'restored'
  || recovery?.kind === 'retry-deferred-retained'
  || recovery?.kind === 'workspace-unavailable-retained';

export async function bootstrap(app: BootstrapApp, env: BootstrapEnv): Promise<{ callbackError: string | null; signedIn: boolean }> {
  const loc = env.location;
  const ss = env.sessionStorage;
  const hist = env.history;
  // Canonicalize retired route parameters before showing either the login or
  // workbench surface. `iss`/`hd` must not look like active IdP selectors:
  // actual selection is config/session-owned.
  const initialParams = new URLSearchParams(loc.search);
  const hasRetiredLoginHint = initialParams.has('iss') || initialParams.has('hd');
  const normalizedRoute = hasRetiredLoginHint
    ? normalizeSqlRouteSearch(loc.search)
    : { route: parseSqlRoute(loc.search), search: loc.search };
  if (normalizedRoute.search !== loc.search) {
    hist.replaceState(null, '', loc.origin + loc.pathname + normalizedRoute.search + loc.hash);
    app.syncSqlRoute(normalizedRoute.search);
  }
  let dash = normalizedRoute.route.surface === 'dashboard';
  const u = new URL(loc.href);
  u.search = normalizedRoute.search;
  const code = u.searchParams.get('code');
  const stateParam = u.searchParams.get('state');
  const expectedState = ss.getItem('oauth_state');
  const errorParam = u.searchParams.get('error');
  let callbackError: string | null = null;
  // Recovery is bound to a fully completed callback, not merely a matching
  // state parameter. In particular, a failed callback must leave a retained
  // checkpoint retryable and must not ask the application to consume it.
  let successfulCallbackState: string | null = null;

  if (errorParam) {
    // The IdP bounced back with an error (e.g. ?error=access_denied) instead of
    // a code — surface it rather than dropping silently onto the login screen.
    callbackError = 'Sign-in failed: ' + (u.searchParams.get('error_description') || errorParam);
  } else if (code && stateParam) {
    if (stateParam !== expectedState) {
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
          redirectUri: loc.origin + app.conn.basePath,
        });
        const bearer = bearerFromTokens(tokens, cfg.bearer);
        if (!bearer) throw new Error('Token response missing bearer token');
        app.conn.setTokens(bearer, tokens.refresh_token);
        successfulCallbackState = stateParam;
      } catch (e) {
        callbackError = 'OAuth token exchange failed: ' + ((e instanceof Error && e.message) || e);
      }
    }
  }
  if (errorParam || (code && stateParam)) {
    ['code', 'state', 'scope', 'authuser', 'prompt', 'error', 'error_description', 'error_uri']
      .forEach((k) => u.searchParams.delete(k));
    if (stateParam && stateParam === expectedState) {
      try {
        const saved = JSON.parse(ss.getItem('oauth_return_route') || 'null') as {
          state?: unknown; search?: unknown;
        } | null;
        if (saved?.state === stateParam && typeof saved.search === 'string') {
          const restored = new URLSearchParams(saved.search);
          for (const key of new Set(restored.keys())) u.searchParams.delete(key);
          for (const [key, value] of restored) u.searchParams.append(key, value);
          ss.removeItem('oauth_return_route');
        }
      } catch {
        // Invalid same-tab return metadata is ignored; callback validation and
        // the normal implicit route remain authoritative.
      }
    }
    const qs = u.searchParams.toString();
    const callbackSearch = qs ? '?' + qs : '';
    // A callback can restore return-route state saved by an older version.
    // Canonicalize retired hints again so they cannot reappear on a failed
    // sign-in, which renders the login screen without a workspace rewrite.
    const callbackParams = new URLSearchParams(callbackSearch);
    const cleanedSearch = callbackParams.has('iss') || callbackParams.has('hd')
      ? normalizeSqlRouteSearch(callbackSearch).search
      : callbackSearch;
    hist.replaceState(null, '', loc.origin + loc.pathname + cleanedSearch + loc.hash);
    app.syncSqlRoute(cleanedSearch);
    dash = parseSqlRoute(cleanedSearch).surface === 'dashboard';
  }

  // A shared query (SQL + complete Spec) rides in the URL hash, which is lost
  // through the OAuth redirect (and we strip it below). Stash it in
  // sessionStorage so it survives the round-trip and restore it once we're back.
  // The dashboard route has no editor tab to seed, so it skips this entirely.
  // Gates are `sql || panel` (#166): a text panel legitimately has no SQL, so
  // a sql-only check would silently drop its share link.
  const sharedFromHash = !dash ? decodeShare(loc.hash) : null;
  if (sharedFromHash && (sharedFromHash.sql || queryPanel(sharedFromHash))) {
    ss.setItem('oauth_shared', JSON.stringify(sharedFromHash));
  }

  if (app.conn.isSignedIn()) {
    // Signed in either via a valid OAuth token or a restored basic session.
    // Resolve config first so the header shows the real CH identity (the
    // ch_auth=basic username, not the raw email claim) on first paint.
    // (ensureConfig is a no-op in basic mode.)
    await app.conn.ensureConfig();
    app.resumeAuthenticatedExecution();
    const workspace = await app.loadWorkspaceOnBoot();
    // A successful OAuth callback may restore its authored document session
    // now that the committed workspace projection is ready. A valid recovery
    // wins over (and deliberately never merges with) a legacy shared query.
    const recovery = successfulCallbackState === null
      ? (workspace ? app.retryPendingOAuthDocumentRecovery() : null)
      : app.restoreOAuthDocumentRecovery(successfulCallbackState);
    // Both paths consume the legacy handoff exactly once. Any application-level
    // restored outcome (including retained finalization warnings), and either
    // retained recovery-authority outcome, suppress shared content. Retained
    // recovery remains unpublished, so the normal available workspace renders
    // while its checkpoint is preserved for a later retry.
    let legacyShared: string | null = null;
    let legacySharedTaken = false;
    try {
      legacyShared = ss.getItem('oauth_shared');
      ss.removeItem('oauth_shared');
      legacySharedTaken = true;
    } catch {
      // Storage cleanup is independent finalization. In particular, a storage
      // backend that also rejected recovery-checkpoint removal must not hide
      // already-published tabs. Without a confirmed one-shot take, suppress
      // rather than apply the legacy handoff.
    }
    app.consumeLegacyShared(
      !recoveryOwnsLegacyShare(recovery) && legacySharedTaken,
      legacyShared,
    );
    app.renderCurrentSurface();
    void app.catalog.loadVersion();
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
  });
}
/* c8 ignore stop */
