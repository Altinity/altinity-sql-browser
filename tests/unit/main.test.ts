import { describe, it, expect, vi } from 'vitest';
import { bootstrap } from '../../src/main.js';
import type { BootstrapApp } from '../../src/main.js';
import { newTabObj, SAVED_VIEWS, setTabSpecDraft, tabPanel } from '../../src/state.js';
import { signal } from '@preact/signals-core';
import {
  cloneJson, queryName, queryPanel, queryView, upgradeSavedQuery,
} from '../../src/core/saved-query.js';
import { isQuerylessPanel } from '../../src/core/panel-cfg.js';
import type { BootstrapEnv } from '../../src/env.types.js';
import type { ResolvedIdpConfig } from '../../src/net/oauth-config.js';
import type { State } from '../../src/ui/app.types.js';
import {
  OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY,
  OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_VERSION,
  encodeOAuthDocumentRecoveryValidatedCallback,
} from '../../src/core/oauth-document-recovery.js';

// Node's own global (no `@types/node` in this project — see dashboard.test.ts's
// own note on the same constraint); this suite runs under Vitest/Node, where
// the real global exists — this types only the one call this fixture makes.
declare const Buffer: { from(s: string): { toString(enc: string): string } };

function jwt(payload: Record<string, unknown>): string {
  const b = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'RS256' })}.${b(payload)}.sig`;
}
const valid = jwt({ email: 'me@x.com', exp: Math.floor(Date.now() / 1000) + 3600 });

// `bootstrap`'s own `BootstrapApp`/`BootstrapEnv` contracts (main.ts, env.types.ts)
// are real browser DOM shapes (`Location`/`History`/`Storage`/`Window`); these
// small `asX` casts bridge a minimal fixture to the real type without an
// `unknown` bridge — same pattern as tests/unit/{app,dashboard,oauth}.test.ts's
// own `asWindow`/`asFetch`/`as Location` casts.
const asLocation = (v: object): Location => v as Location;
const asFetch = (v: object): typeof fetch => v as typeof fetch;

type FakeApp = BootstrapApp & {
  token: string | null;
  state: Pick<State, 'tabs' | 'resultView'>;
};

// `conn` overrides are merged onto the default stub (not a full-object
// replace) so a test can override e.g. just `isSignedIn` without losing the
// other conn defaults — `rest` (everything else) still spreads directly.
function fakeApp(over: Partial<Omit<FakeApp, 'conn'>> & { conn?: Partial<FakeApp['conn']> } = {}): FakeApp {
  const { conn: connOver, ...rest } = over;
  const self = {
    token: null as string | null,
    state: {
      tabs: signal([newTabObj('t1')]),
      resultView: signal<'table' | 'json' | 'panel'>('table'),
    },
    conn: {
      basePath: '/sql',
      resolveConfig: vi.fn(async () => ({ clientId: 'c', tokenUri: 'https://t', clientSecret: '' }) as ResolvedIdpConfig),
      ensureConfig: vi.fn(async () => ({}) as ResolvedIdpConfig),
      setTokens: vi.fn((id: string) => { self.token = id; }),
      // Default mirrors the real controller: signed in iff a token is held.
      // Tests that exercise a basic session (or a dynamic token check)
      // override this directly, either here or post-construction.
      isSignedIn: () => !!self.token,
      ...connOver,
    },
    catalog: { loadVersion: vi.fn(async () => {}) },
    renderCurrentSurface: vi.fn(),
    resumeAuthenticatedExecution: vi.fn(),
    // #588 phase 4 wave 4: `syncSqlRoute` moved off the flat `App` contract
    // onto `app.nav`.
    nav: { syncSqlRoute: vi.fn() },
    showLogin: vi.fn(),
    // #287 W4: bootstrap awaits this before the first renderApp() on the
    // non-dashboard route — a no-op stub here (the aggregate-projection
    // behavior itself is app.test.ts's/state.test.ts's concern, not
    // bootstrap's own).
    loadWorkspaceOnBoot: vi.fn(async () => null),
    // The real application owns recovery validation/consumption. Most bootstrap
    // paths have no successful OAuth callback, and therefore never call this;
    // the default result keeps successful-callback tests on the legacy-share
    // fallback path unless they explicitly exercise recovery.
    restoreOAuthDocumentRecovery: vi.fn(() => ({ kind: 'absent' })),
    retryPendingOAuthDocumentRecovery: vi.fn(() => ({ kind: 'absent' })),
    // Bootstrap owns handoff consumption; this fixture mirrors the real app's
    // pure application step so the long-standing share compatibility cases
    // remain bootstrap integration coverage rather than mock-only call checks.
    consumeLegacyShared: vi.fn((allowRestore: boolean, encoded: string | null) => {
      if (!allowRestore || encoded === null) return false;
      let shared;
      try {
        const raw = JSON.parse(encoded) as Record<string, unknown>;
        shared = upgradeSavedQuery(raw.specVersion == null
          ? { name: 'Shared query', ...raw }
          : raw);
      } catch {
        return false;
      }
      const panel = queryPanel(shared);
      if (!shared.sql && !panel) return false;
      const tab = self.state.tabs.value[0];
      tab.sqlDraft = shared.sql;
      tab.name = queryName(shared);
      tab.specVersion = shared.specVersion;
      setTabSpecDraft(tab, cloneJson(shared.spec));
      const launchView = queryView(shared);
      const normalized = launchView === 'chart' ? 'panel' : launchView;
      if (SAVED_VIEWS.has(normalized ?? '')) {
        self.state.resultView.value = normalized as State['resultView']['value'];
      } else if (!shared.sql && isQuerylessPanel(panel)) {
        self.state.resultView.value = 'panel';
      }
      return true;
    }),
    ...rest,
  } as FakeApp;
  return self;
}

const signedInApp = (): FakeApp => fakeApp({ token: valid, conn: { isSignedIn: () => true } });

// `over` only ever supplies `location`/`fetch`/`opener` at real call sites below;
// each is merged explicitly (not spread) so `history.replaceState` keeps its
// concrete `Mock` type for direct `.mock.calls` inspection (one test below).
// No return-type annotation here, deliberately: an explicit `: BootstrapEnv`
// would widen the returned value to that interface for every caller (losing
// `replaceState`'s concrete type the same way it would on `history` itself);
// the object below already structurally satisfies `BootstrapEnv` wherever
// `bootstrap()` consumes it, so the richer inferred type is free.
function fakeEnv(over: { location?: Location; fetch?: typeof fetch } = {}) {
  return {
    location: over.location ?? asLocation({ href: 'https://ch/sql', origin: 'https://ch', pathname: '/sql', search: '', hash: '' }),
    sessionStorage: {
      _m: new Map<string, string>(),
      getItem(k: string) { return this._m.get(k) ?? null; },
      setItem(k: string, v: string) { this._m.set(k, v); },
      removeItem(k: string) { this._m.delete(k); },
      clear() { this._m.clear(); },
      key(): string | null { return null; },
      length: 0,
    },
    history: {
      length: 0,
      scrollRestoration: 'auto' as const,
      state: null,
      back() {},
      forward() {},
      go() {},
      pushState() {},
      replaceState: vi.fn(),
    },
    fetch: over.fetch ?? asFetch(vi.fn()),
  };
}

describe('bootstrap', () => {
  it('renders login when there is no token', async () => {
    const app = fakeApp();
    const out = await bootstrap(app, fakeEnv());
    expect(app.showLogin).toHaveBeenCalledWith(null);
    expect(app.catalog.loadVersion).not.toHaveBeenCalled();
    expect(out.signedIn).toBe(false);
  });

  it('renders the app when already signed in', async () => {
    const app = fakeApp({ token: valid, conn: { isSignedIn: () => true } });
    await bootstrap(app, fakeEnv());
    expect(app.resumeAuthenticatedExecution).toHaveBeenCalledOnce();
    expect(app.catalog.loadVersion).toHaveBeenCalledOnce();
    expect(app.renderCurrentSurface).toHaveBeenCalled();
  });

  it('mounts the initial surface before an authentication-losing version probe can replace it with Login', async () => {
    let releaseWorkspace!: () => void;
    const workspaceGate = new Promise<null>((resolve) => { releaseWorkspace = () => resolve(null); });
    let signedIn = true;
    let visible: 'none' | 'surface' | 'login' = 'none';
    const app = fakeApp({
      conn: { isSignedIn: () => signedIn },
      loadWorkspaceOnBoot: vi.fn(() => workspaceGate),
      renderCurrentSurface: vi.fn(() => { visible = 'surface'; }),
      showLogin: vi.fn(() => { visible = 'login'; }),
    });
    app.catalog.loadVersion = vi.fn(async () => {
      signedIn = false;
      app.showLogin();
    });

    const boot = bootstrap(app, fakeEnv());
    await Promise.resolve();
    expect(app.catalog.loadVersion).not.toHaveBeenCalled();
    releaseWorkspace();
    await boot;
    await vi.waitFor(() => expect(app.catalog.loadVersion).toHaveBeenCalledOnce());

    expect(app.renderCurrentSurface).toHaveBeenCalledOnce();
    expect(app.showLogin).toHaveBeenCalledOnce();
    expect(visible).toBe('login');
    expect(vi.mocked(app.renderCurrentSurface).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(app.catalog.loadVersion).mock.invocationCallOrder[0]);
  });

  it('renders the app for a restored basic session (no token)', async () => {
    // A credentials session has no OAuth token; isSignedIn() carries it.
    const app = fakeApp({ token: null, conn: { isSignedIn: () => true } });
    const out = await bootstrap(app, fakeEnv());
    expect(app.conn.ensureConfig).toHaveBeenCalled();
    expect(app.renderCurrentSurface).toHaveBeenCalled();
    expect(out.signedIn).toBe(true);
  });

  it('restores a marked pending recovery on token reload before render and suppresses shared content', async () => {
    let renderedSql = '';
    const app = fakeApp({
      token: valid,
      conn: { isSignedIn: () => true },
      loadWorkspaceOnBoot: vi.fn(async () => ({ key: 'recovery' })),
      renderCurrentSurface: vi.fn(() => { renderedSql = app.state.tabs.value[0].sqlDraft; }),
    });
    app.retryPendingOAuthDocumentRecovery = vi.fn(() => {
      app.state.tabs.value[0].sqlDraft = 'SELECT pending recovery';
      return {
        kind: 'restored',
        finalization: 'checkpoint-retained',
        warning: 'checkpoint-remove-failed',
      } as const;
    });
    const env = fakeEnv();
    env.sessionStorage.setItem('oauth_document_recovery', 'marked checkpoint fixture');
    env.sessionStorage.setItem(
      OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_KEY,
      encodeOAuthDocumentRecoveryValidatedCallback({
        version: OAUTH_DOCUMENT_RECOVERY_VALIDATED_CALLBACK_VERSION,
        oauthState: 'pending-state',
        validatedAt: Date.now(),
        documentSessionFingerprint: 'pending-live-session',
      }),
    );
    env.sessionStorage.setItem('oauth_shared', JSON.stringify({
      sql: 'SELECT shared must lose',
      specVersion: 1,
      spec: { name: 'Shared query', favorite: false },
    }));

    await bootstrap(app, env);

    expect(renderedSql).toBe('SELECT pending recovery');
    expect(app.retryPendingOAuthDocumentRecovery).toHaveBeenCalledOnce();
    expect(app.restoreOAuthDocumentRecovery).not.toHaveBeenCalled();
    expect(app.consumeLegacyShared).toHaveBeenCalledWith(false, expect.any(String));
    expect(env.sessionStorage.getItem('oauth_shared')).toBeNull();
    expect(vi.mocked(app.loadWorkspaceOnBoot).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(app.retryPendingOAuthDocumentRecovery).mock.invocationCallOrder[0]);
    expect(vi.mocked(app.retryPendingOAuthDocumentRecovery).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(app.renderCurrentSurface).mock.invocationCallOrder[0]);
  });

  it('does not restore an ordinary checkpoint without the pending marker on token reload', async () => {
    const app = fakeApp({
      token: valid,
      conn: { isSignedIn: () => true },
      loadWorkspaceOnBoot: vi.fn(async () => ({ key: 'recovery' })),
    });
    app.retryPendingOAuthDocumentRecovery = vi.fn(() => ({ kind: 'absent' } as const));
    const env = fakeEnv();
    env.sessionStorage.setItem('oauth_document_recovery', 'unmarked checkpoint fixture');

    await bootstrap(app, env);

    expect(app.retryPendingOAuthDocumentRecovery).toHaveBeenCalledOnce();
    expect(app.restoreOAuthDocumentRecovery).not.toHaveBeenCalled();
    expect(app.state.tabs.value[0].sqlDraft).toBe('');
    expect(app.renderCurrentSurface).toHaveBeenCalledOnce();
  });

  it('discards the shared handoff when pending recovery is deferred before publication', async () => {
    let renderedSql = '';
    const app = fakeApp({
      token: valid,
      conn: { isSignedIn: () => true },
      loadWorkspaceOnBoot: vi.fn(async () => ({ key: 'recovery' })),
      renderCurrentSurface: vi.fn(() => { renderedSql = app.state.tabs.value[0].sqlDraft; }),
    });
    app.retryPendingOAuthDocumentRecovery = vi.fn(
      () => ({ kind: 'retry-deferred-retained' } as const),
    );
    const env = fakeEnv();
    env.sessionStorage.setItem('oauth_document_recovery', 'retained checkpoint');
    env.sessionStorage.setItem('oauth_shared', JSON.stringify({
      sql: 'SELECT shared must never appear',
      specVersion: 1,
      spec: { name: 'Shared fallback', favorite: false },
    }));

    await expect(bootstrap(app, env)).resolves.toMatchObject({ signedIn: true });

    expect(app.retryPendingOAuthDocumentRecovery).toHaveBeenCalledOnce();
    expect(app.consumeLegacyShared).toHaveBeenCalledWith(false, expect.any(String));
    expect(renderedSql).toBe('');
    expect(env.sessionStorage.getItem('oauth_document_recovery')).toBe('retained checkpoint');
    expect(env.sessionStorage.getItem('oauth_shared')).toBeNull();
    expect(app.renderCurrentSurface).toHaveBeenCalledOnce();
  });

  it('still renders deferred recovery authority when shared handoff cleanup fails', async () => {
    const app = fakeApp({
      token: valid,
      conn: { isSignedIn: () => true },
      loadWorkspaceOnBoot: vi.fn(async () => ({ key: 'recovery' })),
    });
    app.retryPendingOAuthDocumentRecovery = vi.fn(
      () => ({ kind: 'retry-deferred-retained' } as const),
    );
    const env = fakeEnv();
    env.sessionStorage.setItem('oauth_shared', JSON.stringify({
      sql: 'SELECT retained handoff must not render',
      specVersion: 1,
      spec: { name: 'Suppressed share', favorite: false },
    }));
    const removeItem = env.sessionStorage.removeItem;
    env.sessionStorage.removeItem = vi.fn((key: string) => {
      if (key === 'oauth_shared') throw new Error('raw cleanup failure');
      removeItem.call(env.sessionStorage, key);
    });

    await expect(bootstrap(app, env)).resolves.toMatchObject({ signedIn: true });

    expect(app.consumeLegacyShared).toHaveBeenCalledWith(false, expect.any(String));
    expect(app.state.tabs.value[0].sqlDraft).toBe('');
    expect(app.renderCurrentSurface).toHaveBeenCalledOnce();
  });

  it('exchanges the OAuth code on a valid callback', async () => {
    const app = fakeApp();
    const env = fakeEnv({
      location: asLocation({ href: 'https://ch/sql?code=abc&state=st', origin: 'https://ch', pathname: '/sql', search: '?code=abc&state=st', hash: '' }),
      fetch: asFetch(vi.fn(async () => ({ ok: true, json: async () => ({ id_token: valid }), text: async () => '' }))),
    });
    env.sessionStorage.setItem('oauth_state', 'st');
    env.sessionStorage.setItem('oauth_verifier', 'v');
    await bootstrap(app, env);
    expect(app.conn.setTokens).toHaveBeenCalledWith(valid, undefined);
    expect(app.restoreOAuthDocumentRecovery).toHaveBeenCalledWith('st');
    expect(app.retryPendingOAuthDocumentRecovery).not.toHaveBeenCalled();
    expect(env.history.replaceState).toHaveBeenCalled();
    expect(app.renderCurrentSurface).toHaveBeenCalled();
  });

  it('loads the workspace, restores a successful callback recovery, then renders it before any shared placeholder', async () => {
    let renderedSql = '';
    const restore = vi.fn(() => {
      const tab = app.state.tabs.value[0];
      tab.sqlDraft = 'SELECT recovered';
      tab.name = 'Recovered draft';
      return { kind: 'restored', finalization: 'complete' } as const;
    });
    const app = fakeApp({
      renderCurrentSurface: vi.fn(() => { renderedSql = app.state.tabs.value[0].sqlDraft; }),
    });
    app.restoreOAuthDocumentRecovery = restore;
    const env = fakeEnv({
      location: asLocation({
        href: 'https://ch/sql?code=abc&state=st', origin: 'https://ch', pathname: '/sql',
        search: '?code=abc&state=st', hash: '',
      }),
      fetch: asFetch(vi.fn(async () => ({ ok: true, json: async () => ({ id_token: valid }), text: async () => '' }))),
    });
    env.sessionStorage.setItem('oauth_state', 'st');
    env.sessionStorage.setItem('oauth_verifier', 'v');
    env.sessionStorage.setItem('oauth_shared', JSON.stringify({
      sql: 'SELECT shared', specVersion: 1, spec: { name: 'Shared query', favorite: false },
    }));

    await bootstrap(app, env);

    expect(restore).toHaveBeenCalledWith('st');
    expect(app.state.tabs.value[0].sqlDraft).toBe('SELECT recovered');
    expect(renderedSql).toBe('SELECT recovered');
    expect(env.sessionStorage.getItem('oauth_shared')).toBeNull();
    expect(vi.mocked(app.loadWorkspaceOnBoot).mock.invocationCallOrder[0])
      .toBeLessThan(restore.mock.invocationCallOrder[0]);
    expect(restore.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(app.renderCurrentSurface).mock.invocationCallOrder[0]);
  });

  it.each([
    'spec-revalidation-failed',
    'checkpoint-remove-failed',
  ] as const)('renders published recovery when %s finalization fails and never falls back to shared content', async (warning) => {
    let renderedSql = '';
    const app = fakeApp({
      renderCurrentSurface: vi.fn(() => { renderedSql = app.state.tabs.value[0].sqlDraft; }),
    });
    app.restoreOAuthDocumentRecovery = vi.fn(() => {
      app.state.tabs.value[0].sqlDraft = 'SELECT recovered despite warning';
      return { kind: 'restored', finalization: 'checkpoint-retained', warning } as const;
    });
    const env = fakeEnv({
      location: asLocation({
        href: 'https://ch/sql?code=abc&state=st', origin: 'https://ch', pathname: '/sql',
        search: '?code=abc&state=st', hash: '',
      }),
      fetch: asFetch(vi.fn(async () => ({
        ok: true, json: async () => ({ id_token: valid }), text: async () => '',
      }))),
    });
    env.sessionStorage.setItem('oauth_state', 'st');
    env.sessionStorage.setItem('oauth_verifier', 'v');
    env.sessionStorage.setItem('oauth_shared', JSON.stringify({
      sql: 'SELECT must not replace recovery',
      specVersion: 1,
      spec: { name: 'Shared query', favorite: false },
    }));

    await expect(bootstrap(app, env)).resolves.toMatchObject({ signedIn: true });

    expect(renderedSql).toBe('SELECT recovered despite warning');
    expect(app.consumeLegacyShared).toHaveBeenCalledWith(false, expect.any(String));
    expect(env.sessionStorage.getItem('oauth_shared')).toBeNull();
  });

  it('renders recovered tabs when storage-wide removal also rejects legacy handoff cleanup', async () => {
    let renderedSql = '';
    const app = fakeApp({
      renderCurrentSurface: vi.fn(() => { renderedSql = app.state.tabs.value[0].sqlDraft; }),
    });
    app.restoreOAuthDocumentRecovery = vi.fn(() => {
      app.state.tabs.value[0].sqlDraft = 'SELECT retained recovery';
      return {
        kind: 'restored',
        finalization: 'checkpoint-retained',
        warning: 'checkpoint-remove-failed',
      } as const;
    });
    const env = fakeEnv({
      location: asLocation({
        href: 'https://ch/sql?code=abc&state=st', origin: 'https://ch', pathname: '/sql',
        search: '?code=abc&state=st', hash: '',
      }),
      fetch: asFetch(vi.fn(async () => ({
        ok: true, json: async () => ({ id_token: valid }), text: async () => '',
      }))),
    });
    env.sessionStorage.setItem('oauth_state', 'st');
    env.sessionStorage.setItem('oauth_verifier', 'v');
    env.sessionStorage.setItem('oauth_document_recovery', 'retained-checkpoint');
    env.sessionStorage.setItem('oauth_shared', JSON.stringify({
      sql: 'SELECT must remain suppressed',
      specVersion: 1,
      spec: { name: 'Shared query', favorite: false },
    }));
    env.sessionStorage.removeItem = vi.fn(() => {
      throw new Error('storage removal unavailable');
    });

    await expect(bootstrap(app, env)).resolves.toMatchObject({ signedIn: true });

    expect(renderedSql).toBe('SELECT retained recovery');
    expect(app.consumeLegacyShared).toHaveBeenCalledWith(false, expect.any(String));
    expect(env.sessionStorage.getItem('oauth_document_recovery')).toBe('retained-checkpoint');
    expect(env.sessionStorage.getItem('oauth_shared')).not.toBeNull();
    expect(app.renderCurrentSurface).toHaveBeenCalledOnce();
  });

  it.each([
    { kind: 'absent' } as const,
    { kind: 'invalid-cleared', reason: 'expired' } as const,
    { kind: 'workspace-mismatch-retained' } as const,
    { kind: 'callback-mismatch' } as const,
  ])('falls back to the legacy shared seed when recovery is $kind', async (result) => {
    const restore = vi.fn(() => result);
    const app = fakeApp();
    app.restoreOAuthDocumentRecovery = restore;
    const env = fakeEnv({
      location: asLocation({
        href: 'https://ch/sql?code=abc&state=st', origin: 'https://ch', pathname: '/sql',
        search: '?code=abc&state=st', hash: '',
      }),
      fetch: asFetch(vi.fn(async () => ({ ok: true, json: async () => ({ id_token: valid }), text: async () => '' }))),
    });
    env.sessionStorage.setItem('oauth_state', 'st');
    env.sessionStorage.setItem('oauth_shared', JSON.stringify({
      sql: 'SELECT shared', specVersion: 1, spec: { name: 'Shared query', favorite: false },
    }));

    await bootstrap(app, env);

    expect(restore).toHaveBeenCalledWith('st');
    expect(app.state.tabs.value[0].sqlDraft).toBe('SELECT shared');
    expect(env.sessionStorage.getItem('oauth_shared')).toBeNull();
  });

  it('suppresses the shared handoff when a fresh callback retains recovery for an unavailable workspace', async () => {
    const app = fakeApp({
      loadWorkspaceOnBoot: vi.fn(async () => null),
    });
    app.restoreOAuthDocumentRecovery = vi.fn(
      () => ({ kind: 'workspace-unavailable-retained' } as const),
    );
    const env = fakeEnv({
      location: asLocation({
        href: 'https://ch/sql?code=abc&state=st', origin: 'https://ch', pathname: '/sql',
        search: '?code=abc&state=st', hash: '',
      }),
      fetch: asFetch(vi.fn(async () => ({
        ok: true, json: async () => ({ id_token: valid }), text: async () => '',
      }))),
    });
    env.sessionStorage.setItem('oauth_state', 'st');
    env.sessionStorage.setItem('oauth_shared', JSON.stringify({
      sql: 'SELECT shared must not appear',
      specVersion: 1,
      spec: { name: 'Suppressed share', favorite: false },
    }));

    await expect(bootstrap(app, env)).resolves.toMatchObject({ signedIn: true });

    expect(app.restoreOAuthDocumentRecovery).toHaveBeenCalledWith('st');
    expect(app.consumeLegacyShared).toHaveBeenCalledWith(false, expect.any(String));
    expect(app.state.tabs.value[0].sqlDraft).toBe('');
    expect(env.sessionStorage.getItem('oauth_shared')).toBeNull();
    expect(app.renderCurrentSurface).toHaveBeenCalledOnce();
  });

  it('restores the state-bound pre-login route before resolving a workspace', async () => {
    const app = fakeApp();
    const env = fakeEnv({
      location: asLocation({
        href: 'https://ch/sql?code=abc&state=st', origin: 'https://ch',
        pathname: '/sql', search: '?code=abc&state=st', hash: '',
      }),
      fetch: asFetch(vi.fn(async () => ({
        ok: true, json: async () => ({ id_token: valid }), text: async () => '',
      }))),
    });
    env.sessionStorage.setItem('oauth_state', 'st');
    env.sessionStorage.setItem('oauth_verifier', 'v');
    env.sessionStorage.setItem('oauth_return_route', JSON.stringify({
      state: 'st', search: '?ws=missing&surface=dashboard&mode=view&keep=1',
    }));
    await bootstrap(app, env);
    expect(env.history.replaceState).toHaveBeenCalledWith(
      null, '', 'https://ch/sql?ws=missing&surface=dashboard&mode=view&keep=1',
    );
    expect(app.nav.syncSqlRoute).toHaveBeenCalledWith(
      '?ws=missing&surface=dashboard&mode=view&keep=1',
    );
    expect(env.sessionStorage.getItem('oauth_return_route')).toBeNull();
    expect(app.loadWorkspaceOnBoot).toHaveBeenCalledOnce();
  });

  it('does not restore return metadata associated with a different OAuth state', async () => {
    const app = fakeApp();
    const env = fakeEnv({
      location: asLocation({
        href: 'https://ch/sql?code=abc&state=evil', origin: 'https://ch',
        pathname: '/sql', search: '?code=abc&state=evil', hash: '',
      }),
    });
    env.sessionStorage.setItem('oauth_state', 'expected');
    env.sessionStorage.setItem('oauth_return_route', JSON.stringify({
      state: 'expected', search: '?ws=private',
    }));
    await bootstrap(app, env);
    expect(app.nav.syncSqlRoute).toHaveBeenCalledWith('');
    expect(env.sessionStorage.getItem('oauth_return_route')).not.toBeNull();
  });

  it('reports a CSRF state mismatch', async () => {
    const app = fakeApp();
    const env = fakeEnv({
      location: asLocation({ href: 'https://ch/sql?code=abc&state=evil', origin: 'https://ch', pathname: '/sql', search: '?code=abc&state=evil', hash: '' }),
    });
    env.sessionStorage.setItem('oauth_state', 'expected');
    await bootstrap(app, env);
    expect(app.showLogin).toHaveBeenCalledWith('OAuth state mismatch — please try again.');
    expect(app.restoreOAuthDocumentRecovery).not.toHaveBeenCalled();
  });

  it('surfaces an IdP error callback with its description', async () => {
    const app = fakeApp();
    const env = fakeEnv({
      location: asLocation({ href: 'https://ch/sql?error=access_denied&error_description=User+denied', origin: 'https://ch', pathname: '/sql', search: '?error=access_denied&error_description=User+denied', hash: '' }),
    });
    await bootstrap(app, env);
    expect(app.showLogin).toHaveBeenCalledWith('Sign-in failed: User denied');
    expect(app.restoreOAuthDocumentRecovery).not.toHaveBeenCalled();
    expect(env.history.replaceState).toHaveBeenCalled();
    expect(app.renderCurrentSurface).not.toHaveBeenCalled();
  });

  it('falls back to the error code when no description is given', async () => {
    const app = fakeApp();
    const env = fakeEnv({
      location: asLocation({ href: 'https://ch/sql?error=access_denied', origin: 'https://ch', pathname: '/sql', search: '?error=access_denied', hash: '' }),
    });
    await bootstrap(app, env);
    expect(app.showLogin).toHaveBeenCalledWith('Sign-in failed: access_denied');
  });

  it('reports a token-exchange failure', async () => {
    const app = fakeApp();
    const env = fakeEnv({
      location: asLocation({ href: 'https://ch/sql?code=abc&state=st', origin: 'https://ch', pathname: '/sql', search: '?code=abc&state=st', hash: '' }),
      fetch: asFetch(vi.fn(async () => ({ ok: false, text: async () => 'denied' }))),
    });
    env.sessionStorage.setItem('oauth_state', 'st');
    await bootstrap(app, env);
    expect(app.showLogin).toHaveBeenCalledWith(expect.stringContaining('OAuth token exchange failed'));
    expect(app.restoreOAuthDocumentRecovery).not.toHaveBeenCalled();
  });

  it('errors when the token response has no bearer', async () => {
    const app = fakeApp();
    const env = fakeEnv({
      location: asLocation({ href: 'https://ch/sql?code=abc&state=st', origin: 'https://ch', pathname: '/sql', search: '?code=abc&state=st', hash: '' }),
      fetch: asFetch(vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => '{}' }))),
    });
    env.sessionStorage.setItem('oauth_state', 'st');
    await bootstrap(app, env);
    expect(app.showLogin).toHaveBeenCalledWith(expect.stringContaining('missing bearer token'));
  });

  it('stringifies a non-Error thrown during exchange', async () => {
    const app = fakeApp({ conn: { resolveConfig: vi.fn(async () => { throw 'plain failure'; }) } });
    const env = fakeEnv({
      location: asLocation({ href: 'https://ch/sql?code=abc&state=st', origin: 'https://ch', pathname: '/sql', search: '?code=abc&state=st', hash: '' }),
    });
    env.sessionStorage.setItem('oauth_state', 'st');
    await bootstrap(app, env);
    expect(app.showLogin).toHaveBeenCalledWith('OAuth token exchange failed: plain failure');
  });

  it('seeds the first tab from a legacy (SQL-only) share-link hash', async () => {
    const app = signedInApp();
    const sql = 'SELECT 1';
    const hash = '#' + btoa(unescape(encodeURIComponent(sql)));
    const env = fakeEnv({ location: asLocation({ href: 'https://ch/sql' + hash, origin: 'https://ch', pathname: '/sql', search: '', hash }) });
    await bootstrap(app, env);
    expect(app.state.tabs.value[0].sqlDraft).toBe('SELECT 1');
    expect(app.state.tabs.value[0].name).toBe('Shared query');
    expect(tabPanel(app.state.tabs.value[0])).toBeNull();
    expect(env.sessionStorage.getItem('oauth_shared')).toBeNull();
  });

  it('seeds SQL + chart config from a tagged share-link hash', async () => {
    const app = signedInApp();
    const chart = { cfg: { type: 'pie', x: 0, y: [1], series: null }, key: 'a:String|b:UInt64' };
    const hash = '#' + btoa(unescape(encodeURIComponent(JSON.stringify({ __asb: 1, sql: 'SELECT a, b FROM t', chart }))));
    const env = fakeEnv({ location: asLocation({ href: 'https://ch/sql' + hash, origin: 'https://ch', pathname: '/sql', search: '', hash }) });
    await bootstrap(app, env);
    expect(app.state.tabs.value[0].sqlDraft).toBe('SELECT a, b FROM t');
    expect(tabPanel(app.state.tabs.value[0])).toEqual(chart);
    expect(tabPanel(app.state.tabs.value[0])).not.toBe(chart); // cloned, not aliased
  });

  it('seeds a text panel from a share link with EMPTY SQL (#166 — the gate is sql || panel)', async () => {
    const app = signedInApp();
    const panel = { cfg: { type: 'text', content: '# Note' } };
    const hash = '#' + btoa(unescape(encodeURIComponent(JSON.stringify({ __asb: 1, sql: '', panel }))));
    const env = fakeEnv({ location: asLocation({ href: 'https://ch/sql' + hash, origin: 'https://ch', pathname: '/sql', search: '', hash }) });
    await bootstrap(app, env);
    expect(app.state.tabs.value[0].name).toBe('Shared query');
    expect(app.state.tabs.value[0].sqlDraft).toBe('');
    expect(tabPanel(app.state.tabs.value[0])).toEqual(panel);
    expect(app.state.resultView.value).toBe('panel');
    expect(env.sessionStorage.getItem('oauth_shared')).toBeNull();
  });

  // v2 share hash: { __asb: 2, query: { sql, specVersion, spec } } (src/core/share.js).
  const v2Hash = (query: Record<string, unknown>): string => '#' + btoa(unescape(encodeURIComponent(JSON.stringify({
    __asb: 2, query: { specVersion: 1, spec: { name: 'Shared query', favorite: false }, ...query },
  }))));
  const v2Env = (query: Record<string, unknown>): BootstrapEnv => {
    const hash = v2Hash(query);
    return fakeEnv({ location: asLocation({ href: 'https://ch/sql' + hash, origin: 'https://ch', pathname: '/sql', search: '', hash }) });
  };

  // #447 replaced the two "#244 Filter role wins over the persisted view" cases:
  // no role owns a transient launch preview any more, so a share's own persisted
  // view is the only thing that selects the drawer — even alongside a non-panel
  // role, and even when that role would once have overridden it.
  it('restores the persisted view of a shared query that also carries a non-panel role', async () => {
    const app = signedInApp();
    const panelCfg = { cfg: { type: 'kpi' } };
    const env = v2Env({
      sql: 'SELECT 1',
      spec: { name: 'Shared query', favorite: false, view: 'panel', dashboard: { role: 'setup' }, panel: panelCfg },
    });
    await bootstrap(app, env);
    expect(app.state.resultView.value).toBe('panel');
    // The role and the dormant Panel state survive untouched in the tab's Spec.
    expect(app.state.tabs.value[0].specParsed?.dashboard).toEqual({ role: 'setup' });
    expect(app.state.tabs.value[0].specParsed?.panel).toEqual(panelCfg);
  });

  it('leaves the default view alone for a share carrying a non-panel role and NO persisted view', async () => {
    const app = signedInApp();
    const env = v2Env({ sql: 'SELECT 1', spec: { name: 'Shared query', favorite: false, dashboard: { role: 'setup' } } });
    await bootstrap(app, env);
    expect(app.state.tabs.value[0].sqlDraft).toBe('SELECT 1');
    expect(app.state.resultView.value).toBe('table'); // fakeApp()'s untouched default
  });

  it('restores a SQL-bearing shared Panel query\'s persisted view:"panel" (no role)', async () => {
    const app = signedInApp();
    const panelCfg = { cfg: { type: 'kpi' } };
    const env = v2Env({ sql: 'SELECT 1', spec: { name: 'Shared query', favorite: false, view: 'panel', panel: panelCfg } });
    await bootstrap(app, env);
    expect(app.state.resultView.value).toBe('panel');
  });

  it.each(['table', 'json'])('restores a SQL-bearing shared query\'s persisted %s preference', async (view) => {
    const app = signedInApp();
    const env = v2Env({ sql: 'SELECT 1', spec: { name: 'Shared query', favorite: false, view } });
    await bootstrap(app, env);
    expect(app.state.resultView.value).toBe(view);
  });

  it('leaves the default result view alone for a share with no role and no persisted view', async () => {
    const app = signedInApp();
    const env = v2Env({ sql: 'SELECT 1' });
    await bootstrap(app, env);
    expect(app.state.resultView.value).toBe('table'); // fakeApp()'s untouched default
  });

  it('restores a stashed share\'s persisted view through the OAuth round-trip', async () => {
    const app = fakeApp({ token: valid, conn: { isSignedIn: () => true } });
    const env = fakeEnv({ location: asLocation({ href: 'https://ch/sql', origin: 'https://ch', pathname: '/sql', search: '', hash: '' }) });
    env.sessionStorage.setItem('oauth_shared', JSON.stringify({
      sql: 'SELECT 1', specVersion: 1, spec: { name: 'Shared query', favorite: false, view: 'json' },
    }));
    await bootstrap(app, env);
    expect(app.state.resultView.value).toBe('json');
  });

  it('maps a legacy persisted view:"chart" through the Panel compatibility path in a share', async () => {
    const app = signedInApp();
    const panelCfg = { cfg: { type: 'pie', x: 0, y: [1], series: null } };
    const env = v2Env({ sql: 'SELECT 1', spec: { name: 'Shared query', favorite: false, view: 'chart', panel: panelCfg } });
    await bootstrap(app, env);
    expect(app.state.resultView.value).toBe('panel');
  });

  it('ignores an out-of-enum spec.view from a crafted share, keeping the default (#266)', async () => {
    // The v2 tagged decode passes `spec.view` through verbatim, so a share link
    // can carry any string; it must not reach the resultView signal.
    const app = signedInApp();
    const env = v2Env({ sql: 'SELECT 1', spec: { name: 'Shared query', favorite: false, view: 'javascript:alert(1)' } });
    await bootstrap(app, env);
    expect(app.state.tabs.value[0].sqlDraft).toBe('SELECT 1'); // the share still seeds
    expect(app.state.resultView.value).toBe('table'); // but the bogus view is dropped
  });

  it('restores a shared query (SQL + chart) from sessionStorage after the OAuth round-trip', async () => {
    // The hash is gone after the IdP redirect; the stash carries it through.
    const app = fakeApp({ token: valid, conn: { isSignedIn: () => true } });
    const env = fakeEnv({ location: asLocation({ href: 'https://ch/sql', origin: 'https://ch', pathname: '/sql', search: '', hash: '' }) });
    const chart = { cfg: {
      type: 'line', x: 0, y: [1], series: null,
      style: {
        curve: 'smooth', points: 'hide', scale: 'zero', legend: 'show', grid: 'hide', axes: 'hide',
        extension: { dense: true },
      },
    }, key: 'k' };
    env.sessionStorage.setItem('oauth_shared', JSON.stringify({ sql: 'SELECT 42', chart }));
    await bootstrap(app, env);
    expect(app.state.tabs.value[0].sqlDraft).toBe('SELECT 42');
    expect(app.state.tabs.value[0].name).toBe('Shared query');
    expect(tabPanel(app.state.tabs.value[0])).toEqual(chart);
    expect(app.renderCurrentSurface).toHaveBeenCalled();
    expect(env.sessionStorage.getItem('oauth_shared')).toBeNull(); // consumed on render
  });

  it('falls back to no shared query when the sessionStorage stash is corrupt', async () => {
    const app = fakeApp({ token: valid, conn: { isSignedIn: () => true } });
    const env = fakeEnv({ location: asLocation({ href: 'https://ch/sql', origin: 'https://ch', pathname: '/sql', search: '', hash: '' }) });
    env.sessionStorage.setItem('oauth_shared', '{not json');
    await bootstrap(app, env);
    expect(app.state.tabs.value[0].sqlDraft).toBe('');
    expect(app.state.tabs.value[0].name).toBe('Untitled');
  });

  const dashLoc = (over: Partial<Location> = {}): Location => asLocation({
    href: 'https://ch/sql?ws=ops&surface=dashboard',
    origin: 'https://ch',
    pathname: '/sql',
    search: '?ws=ops&surface=dashboard',
    hash: '',
    ...over,
  });

  it('hands the unified dashboard route to the surface coordinator', async () => {
    const app = fakeApp({ token: valid, conn: { isSignedIn: () => true } });
    await bootstrap(app, fakeEnv({ location: dashLoc() }));
    expect(app.loadWorkspaceOnBoot).toHaveBeenCalledOnce();
    expect(app.catalog.loadVersion).toHaveBeenCalledOnce();
    expect(app.renderCurrentSurface).toHaveBeenCalledOnce();
  });

  it('skips editor share-link seeding on the dashboard route', async () => {
    const app = fakeApp({ token: valid, conn: { isSignedIn: () => true } });
    const sql = 'SELECT 1';
    const hash = '#' + btoa(unescape(encodeURIComponent(sql)));
    await bootstrap(app, fakeEnv({ location: dashLoc({
      href: 'https://ch/sql?ws=ops&surface=dashboard' + hash, hash,
    }) }));
    expect(app.state.tabs.value[0].sqlDraft).toBe(''); // not seeded — dashboard has no editor tab
    expect(app.renderCurrentSurface).toHaveBeenCalled();
  });

  it('preserves route and extra params while stripping only OAuth callback params', async () => {
    const app = fakeApp({ token: valid, conn: { isSignedIn: () => true } });
    const env = fakeEnv({
      location: asLocation({
        href: 'https://ch/sql?ws=ops&surface=dashboard&mode=view&code=c&state=st&keep=1',
        origin: 'https://ch', pathname: '/sql',
        search: '?ws=ops&surface=dashboard&mode=view&code=c&state=st&keep=1', hash: '',
      }),
      fetch: asFetch(vi.fn(async () => ({ ok: true, json: async () => ({ id_token: valid, refresh_token: 'r' }), text: async () => '' }))),
    });
    env.sessionStorage.setItem('oauth_state', 'st');
    env.sessionStorage.setItem('oauth_verifier', 'v');
    await bootstrap(app, env);
    const url = env.history.replaceState.mock.calls[0][2];
    expect(url).toContain('ws=ops');
    expect(url).toContain('surface=dashboard');
    expect(url).toContain('mode=view');
    expect(url).toContain('keep=1');
    expect(url).not.toContain('code=');
  });

  it('removes retired issuer and hosted-domain hints before rendering the login screen', async () => {
    const app = fakeApp();
    const env = fakeEnv({
      location: asLocation({
        href: 'https://ch/sql?iss=https%3A%2F%2Faccounts.google.com&hd=altinity.com&ws=ops',
        origin: 'https://ch', pathname: '/sql',
        search: '?iss=https%3A%2F%2Faccounts.google.com&hd=altinity.com&ws=ops', hash: '',
      }),
    });
    await bootstrap(app, env);
    expect(env.history.replaceState).toHaveBeenCalledWith(null, '', 'https://ch/sql?ws=ops');
    expect(app.nav.syncSqlRoute).toHaveBeenCalledWith('?ws=ops');
    expect(app.showLogin).toHaveBeenCalled();
  });

  it('removes retired login hints restored by an OAuth error callback', async () => {
    const app = fakeApp();
    const env = fakeEnv({
      location: asLocation({
        href: 'https://ch/sql?error=access_denied&state=st', origin: 'https://ch',
        pathname: '/sql', search: '?error=access_denied&state=st', hash: '',
      }),
    });
    env.sessionStorage.setItem('oauth_state', 'st');
    env.sessionStorage.setItem('oauth_return_route', JSON.stringify({
      state: 'st', search: '?iss=https%3A%2F%2Faccounts.google.com&hd=altinity.com&ws=ops',
    }));
    await bootstrap(app, env);
    expect(env.history.replaceState).toHaveBeenCalledWith(null, '', 'https://ch/sql?ws=ops');
    expect(app.nav.syncSqlRoute).toHaveBeenCalledWith('?ws=ops');
    expect(env.sessionStorage.getItem('oauth_return_route')).toBeNull();
    expect(app.showLogin).toHaveBeenCalledWith('Sign-in failed: access_denied');
  });
});
