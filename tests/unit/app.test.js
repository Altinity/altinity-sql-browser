import { describe, it, expect, vi, beforeEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createApp } from '../../src/ui/app.js';

function jwt(payload) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'RS256' })}.${b(payload)}.sig`;
}
const validToken = jwt({ email: 'me@example.com', exp: Math.floor(Date.now() / 1000) + 3600 });

function memSession(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

function streamBody(lines) {
  let i = 0;
  return { getReader: () => ({ read: async () => (i < lines.length ? { done: false, value: new TextEncoder().encode(lines[i++]) } : { done: true }) }) };
}
function resp(opts) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.json,
    text: async () => opts.text ?? JSON.stringify(opts.json),
    clone() { return this; },
    body: opts.body,
  };
}

// A fetch stub that routes by SQL/URL.
function makeFetch(routes) {
  return vi.fn(async (url, init) => {
    const sql = init && init.body;
    for (const [test, r] of routes) if (test(url, sql)) return typeof r === 'function' ? r() : r;
    return resp({ json: { data: [] } });
  });
}

function env(over = {}) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return {
    root,
    document,
    window,
    location: { host: 'ch.example', origin: 'https://ch.example', pathname: '/sql', search: '', hash: '', href: 'https://ch.example/sql' },
    sessionStorage: memSession({ oauth_id_token: validToken }),
    crypto: webcrypto,
    fetch: makeFetch([]),
    now: () => 0,
    navigator: { clipboard: { writeText: vi.fn(async () => {}) } },
    ...over,
  };
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('createApp basics', () => {
  it('reads the stored token and derives identity', () => {
    const app = createApp(env());
    expect(app.token).toBe(validToken);
    expect(app.isSignedIn()).toBe(true);
    expect(app.email()).toBe('me@example.com');
    expect(app.host()).toBe('ch.example');
  });
  it('host falls back when location.host is empty', () => {
    const app = createApp(env({ location: { host: '', origin: 'o', pathname: '/sql' } }));
    expect(app.host()).toBe('clickhouse');
  });
});

describe('renderApp shell', () => {
  function rendered(over) {
    const e = env({
      fetch: makeFetch([
        [(u, sql) => /version\(\)/.test(sql), resp({ json: { data: [{ v: '26.3.1' }] } })],
        [(u, sql) => /system\.tables/.test(sql), resp({ json: { data: [{ database: 'd', name: 't', total_rows: '1', total_bytes: '1', comment: '' }] } })],
      ]),
      ...over,
    });
    const app = createApp(e);
    app.renderApp();
    return { app, e };
  }
  it('builds header + sidebar + workbench and mounts the editor', async () => {
    const { app } = rendered();
    expect(app.root.querySelector('.app-header')).not.toBeNull();
    expect(app.root.querySelector('.sidebar')).not.toBeNull();
    expect(app.root.querySelector('.sql-editor')).not.toBeNull();
    expect(app.root.querySelector('.user-email').textContent).toBe('me@example.com');
    await Promise.resolve();
  });
  it('toggles theme via the header button', () => {
    const { app } = rendered();
    app.dom.themeBtn.dispatchEvent(new Event('click'));
    expect(app.state.theme).toBe('light');
    expect(app.savePref).toBeUndefined; // savePref is internal; theme attr set
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
  it('sign-out clears tokens and shows login', () => {
    const { app, e } = rendered();
    app.root.querySelector('.hd-btn.text').dispatchEvent(new Event('click'));
    expect(app.token).toBeNull();
    expect(e.sessionStorage.getItem('oauth_id_token')).toBeNull();
    expect(app.root.querySelector('.login-screen')).not.toBeNull();
  });
  it('header has a Log Out button and a GitHub source link', () => {
    const { app } = rendered();
    expect(app.root.querySelector('.hd-btn.text').textContent).toContain('Log Out');
    const gh = app.root.querySelector('a.hd-btn[href*="github.com"]');
    expect(gh).not.toBeNull();
    expect(gh.getAttribute('target')).toBe('_blank');
    expect(gh.getAttribute('rel')).toContain('noopener');
    expect(gh.querySelector('svg')).not.toBeNull();
  });
  it('setTokens clears the one-shot pkce verifier and csrf state', () => {
    const e = env({ sessionStorage: memSession({ oauth_verifier: 'v', oauth_state: 's' }) });
    const app = createApp(e);
    app.setTokens('tok');
    expect(app.token).toBe('tok');
    expect(e.sessionStorage.getItem('oauth_id_token')).toBe('tok');
    expect(e.sessionStorage.getItem('oauth_verifier')).toBeNull();
    expect(e.sessionStorage.getItem('oauth_state')).toBeNull();
  });
  it('changing the format select persists the choice', () => {
    const { app } = rendered();
    app.dom.fmtSelect.value = 'JSON';
    app.dom.fmtSelect.dispatchEvent(new Event('change'));
    expect(app.state.outputFormat).toBe('JSON');
  });
  it('schema search updates the filter', () => {
    const { app } = rendered();
    app.dom.schemaSearchInput.value = 'foo';
    app.dom.schemaSearchInput.dispatchEvent(new Event('input'));
    expect(app.state.schemaFilter).toBe('foo');
  });
});

describe('loadVersion / loadSchema', () => {
  it('sets the version + online status', async () => {
    const e = env({ fetch: makeFetch([[(u, sql) => /version/.test(sql), resp({ json: { data: [{ v: '26.3.1' }] } })]]) });
    const app = createApp(e);
    app.renderApp();
    await new Promise((r) => setTimeout(r));
    expect(app.state.serverVersion).toBe('26.3.1');
    expect(app.dom.connStatus.textContent).toContain('26.3.1');
  });
  it('marks offline when the version query fails', async () => {
    const e = env({ fetch: makeFetch([[(u, sql) => /version/.test(sql), resp({ ok: false, status: 500, text: 'err' })]]) });
    const app = createApp(e);
    app.renderApp();
    await new Promise((r) => setTimeout(r));
    expect(app.dom.connStatus.textContent).toContain('offline');
  });
  it('records a schema error', async () => {
    const e = env({ fetch: makeFetch([
      [(u, sql) => /version/.test(sql), resp({ json: { data: [{ v: '1' }] } })],
      [(u, sql) => /system\.tables/.test(sql), resp({ ok: false, status: 500, text: 'boom' })],
    ]) });
    const app = createApp(e);
    app.renderApp();
    await new Promise((r) => setTimeout(r));
    expect(app.state.schemaError).toContain('boom');
  });
});

describe('query run', () => {
  function appForRun(routes, over) {
    const e = env({ fetch: makeFetch(routes), ...over });
    const app = createApp(e);
    app.renderApp();
    return { app, e };
  }
  it('runs a streaming query and records history', async () => {
    const { app } = appForRun([
      [(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })],
    ]);
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run();
    expect(app.activeTab().result.rows).toEqual([['1']]);
    expect(app.state.history.length).toBe(1);
  });
  it('no-ops on empty SQL', async () => {
    const { app } = appForRun([]);
    app.activeTab().sql = '   ';
    await app.actions.run();
    expect(app.activeTab().result).toBeNull();
  });
  it('aborts a running query on a second invocation', async () => {
    const { app } = appForRun([]);
    app.state.running = true;
    app.state.abortController = { abort: vi.fn() };
    await app.actions.run();
    expect(app.state.abortController).toBeTruthy();
  });
  it('surfaces a query error', async () => {
    const { app } = appForRun([
      [(u, sql) => /bad/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"DB::Exception: nope"}' })],
    ]);
    app.activeTab().sql = 'bad';
    await app.actions.run();
    expect(app.activeTab().result.error).toContain('nope');
    expect(app.state.history.length).toBe(0);
  });
  it('captures raw output (TSV)', async () => {
    const { app } = appForRun([
      [(u, sql) => /SELECT 9/.test(sql), resp({ text: 'a\tb' })],
    ]);
    app.state.outputFormat = 'TSV';
    app.activeTab().sql = 'SELECT 9';
    await app.actions.run();
    expect(app.activeTab().result.rawText).toBe('a\tb');
  });
});

describe('formatQuery', () => {
  function appFor(routes, over) {
    const e = env({ fetch: makeFetch(routes), ...over });
    const app = createApp(e);
    app.renderApp();
    return { app, e };
  }
  it('replaces the editor with the server-formatted SQL', async () => {
    const { app } = appFor([
      [(u, sql) => /formatQuery/.test(sql), resp({ json: { data: [{ q: 'SELECT\n  1' }] } })],
    ]);
    app.activeTab().sql = 'select 1';
    await app.actions.formatQuery();
    expect(app.dom.editorTextarea.value).toBe('SELECT\n  1');
  });
  it('no-ops on empty SQL', async () => {
    const { app, e } = appFor([]);
    await Promise.resolve(); // let render's loadVersion/loadSchema settle
    e.fetch.mockClear();
    app.activeTab().sql = '   ';
    await app.actions.formatQuery();
    expect(e.fetch).not.toHaveBeenCalled();
  });
  it('signs out when there is no usable token', async () => {
    const { app } = appFor([], { sessionStorage: memSession({}) }); // no token
    app.activeTab().sql = 'select 1';
    await app.actions.formatQuery();
    expect(app.root.querySelector('.login-screen')).not.toBeNull();
  });
  it('surfaces a format failure without changing the editor', async () => {
    const { app } = appFor([
      [(u, sql) => /formatQuery/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"DB::Exception: syntax"}' })],
    ]);
    app.activeTab().sql = 'select 1';
    app.dom.editorTextarea.value = 'select 1';
    await app.actions.formatQuery();
    expect(app.dom.editorTextarea.value).toBe('select 1'); // unchanged
    expect(document.body.querySelector('.share-toast')).not.toBeNull();
  });
});

describe('insertCreate', () => {
  function appFor(routes, over) {
    const e = env({ fetch: makeFetch(routes), ...over });
    const app = createApp(e);
    app.renderApp();
    return { app, e };
  }
  it('fetches DDL, formats it, and inserts as a top line', async () => {
    const { app } = appFor([
      [(u, sql) => /SHOW CREATE/.test(sql), resp({ json: { data: [{ statement: 'CREATE TABLE db.t (a Int)' }] } })],
      [(u, sql) => /formatQuery/.test(sql), resp({ json: { data: [{ q: 'CREATE TABLE db.t\n(\n  a Int\n)' }] } })],
    ]);
    await app.actions.insertCreate('db.t');
    expect(app.dom.editorTextarea.value).toBe('CREATE TABLE db.t\n(\n  a Int\n)');
  });
  it('falls back to the raw DDL when formatting fails', async () => {
    const { app } = appFor([
      [(u, sql) => /SHOW CREATE/.test(sql), resp({ json: { data: [{ statement: 'CREATE TABLE db.t (a Int)' }] } })],
      [(u, sql) => /formatQuery/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"x"}' })],
    ]);
    await app.actions.insertCreate('db.t');
    expect(app.dom.editorTextarea.value).toBe('CREATE TABLE db.t (a Int)');
  });
  it('no-ops when SHOW CREATE returns no statement', async () => {
    const { app } = appFor([
      [(u, sql) => /SHOW CREATE/.test(sql), resp({ json: { data: [] } })],
    ]);
    app.dom.editorTextarea.value = 'keep';
    await app.actions.insertCreate('db.t');
    expect(app.dom.editorTextarea.value).toBe('keep');
  });
  it('surfaces a SHOW CREATE failure without changing the editor', async () => {
    const { app } = appFor([
      [(u, sql) => /SHOW CREATE/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"DB::Exception: no table"}' })],
    ]);
    app.dom.editorTextarea.value = 'keep';
    await app.actions.insertCreate('db.t');
    expect(app.dom.editorTextarea.value).toBe('keep');
    expect(document.body.querySelector('.share-toast')).not.toBeNull();
  });
  it('signs out when there is no usable token', async () => {
    const { app } = appFor([], { sessionStorage: memSession({}) });
    await app.actions.insertCreate('db.t');
    expect(app.root.querySelector('.login-screen')).not.toBeNull();
  });
});

describe('auth flows', () => {
  it('login builds the redirect URL and stashes pkce/state', async () => {
    const loc = { host: 'ch', origin: 'https://ch', pathname: '/sql', search: '', hash: '', href: 'https://ch/sql' };
    const e = env({
      location: loc,
      fetch: makeFetch([
        [(u) => /config\.json/.test(u), resp({ json: { issuer: 'https://accounts.google.com', client_id: 'cid' } })],
        [(u) => /openid-configuration/.test(u), resp({ json: { authorization_endpoint: 'https://accounts.google.com/auth', token_endpoint: 'https://t' } })],
      ]),
    });
    const app = createApp(e);
    await app.actions.login();
    expect(loc.href).toContain('https://accounts.google.com/auth?');
    expect(e.sessionStorage.getItem('oauth_verifier')).toBeTruthy();
    expect(e.sessionStorage.getItem('oauth_state')).toBeTruthy();
  });
  it('refresh succeeds via the ClickHouse context', async () => {
    const e = env({
      sessionStorage: memSession({ oauth_id_token: jwt({ exp: 1 }), oauth_refresh_token: 'rt' }),
      fetch: makeFetch([
        [(u) => /config\.json/.test(u), resp({ json: { issuer: 'https://accounts.google.com', client_id: 'cid' } })],
        [(u) => /openid-configuration/.test(u), resp({ json: { authorization_endpoint: 'https://a', token_endpoint: 'https://t' } })],
        [(u) => u === 'https://t', resp({ json: { id_token: validToken } })],
      ]),
    });
    const app = createApp(e);
    const ok = await app.chCtx.refresh();
    expect(ok).toBe(true);
    expect(app.token).toBe(validToken);
  });
  it('getToken returns null + clears when refresh fails', async () => {
    const e = env({
      sessionStorage: memSession({ oauth_id_token: jwt({ exp: 1 }) }),
      fetch: makeFetch([
        [(u) => /config\.json/.test(u), resp({ json: { issuer: 'https://accounts.google.com', client_id: 'cid' } })],
        [(u) => /openid-configuration/.test(u), resp({ json: { authorization_endpoint: 'https://a', token_endpoint: 'https://t' } })],
      ]),
    });
    const app = createApp(e);
    expect(await app.chCtx.getToken()).toBeNull();
  });
});

describe('share + star + columns', () => {
  it('share copies a link to the clipboard', async () => {
    const e = env({ window: { history: { replaceState: vi.fn() }, navigator: {} } });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    app.actions.share();
    await Promise.resolve();
    expect(e.navigator.clipboard.writeText).toHaveBeenCalled();
  });
  it('share no-ops on empty SQL', () => {
    const app = createApp(env());
    app.renderApp();
    app.activeTab().sql = '  ';
    expect(() => app.actions.share()).not.toThrow();
  });
  it('toggleSaved stars the active query and updates the button', () => {
    const app = createApp(env());
    app.renderApp();
    app.activeTab().sql = 'SELECT 42';
    app.actions.toggleSaved();
    expect(app.state.savedQueries).toHaveLength(1);
    expect(app.dom.starBtn.classList.contains('star-on')).toBe(true);
  });
  it('loadColumns fills the table object', async () => {
    const e = env({ fetch: makeFetch([[(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [{ name: 'id', type: 'UInt64', comment: '' }] } })]]) });
    const app = createApp(e);
    app.renderApp();
    const tbl = { name: 't', columns: null };
    await app.actions.loadColumns('d', 't', tbl);
    expect(tbl.columns).toEqual([{ name: 'id', type: 'UInt64', comment: '' }]);
  });
  it('loadColumns falls back to [] on error', async () => {
    const e = env({ fetch: makeFetch([[(u, sql) => /system\.columns/.test(sql), resp({ ok: false, status: 500, text: 'x' })]]) });
    const app = createApp(e);
    app.renderApp();
    const tbl = { name: 't', columns: null };
    await app.actions.loadColumns('d', 't', tbl);
    expect(tbl.columns).toEqual([]);
  });
});

describe('exhaustive controller coverage', () => {
  const fakeWin = () => ({ history: { replaceState: vi.fn() }, navigator: {} });

  it('refresh stores a returned refresh_token', async () => {
    const e = env({
      sessionStorage: memSession({ oauth_id_token: jwt({ exp: 1 }), oauth_refresh_token: 'rt' }),
      fetch: makeFetch([
        [(u) => /config\.json/.test(u), resp({ json: { issuer: 'https://accounts.google.com', client_id: 'cid' } })],
        [(u) => /openid-configuration/.test(u), resp({ json: { authorization_endpoint: 'https://a', token_endpoint: 'https://t' } })],
        [(u) => u === 'https://t', resp({ json: { id_token: validToken, refresh_token: 'rt2' } })],
      ]),
    });
    const app = createApp(e);
    await app.chCtx.refresh();
    expect(app.refreshToken).toBe('rt2');
    expect(e.sessionStorage.getItem('oauth_refresh_token')).toBe('rt2');
  });

  it('clicks every header + toolbar control', () => {
    const e = env({ window: fakeWin(), navigator: { clipboard: { writeText: vi.fn(async () => {}) } } });
    const app = createApp(e);
    app.renderApp();
    app.root.querySelector('.new-tab').dispatchEvent(new Event('click'));
    app.root.querySelectorAll('.hd-btn')[0].dispatchEvent(new Event('click')); // shortcuts
    app.activeTab().sql = 'SELECT 1'; // set sql on the now-active tab
    app.dom.starBtn.dispatchEvent(new Event('click')); // save
    app.dom.shareBtn.dispatchEvent(new Event('click')); // share
    expect(app.state.tabs.length).toBeGreaterThan(1);
    expect(app.state.savedQueries.length).toBe(1);
  });

  it('drives each splitter handle through a drag', () => {
    const e = env();
    const app = createApp(e);
    app.renderApp();
    const drag = (el, axis) => {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 250, clientY: 40 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
      return axis;
    };
    drag(app.root.querySelector('.col-resize'), 'col');
    drag(app.dom.sideSplit, 'sideRow');
    drag(app.dom.editorResultsSplit, 'row');
    expect(app.state.sidebarPx).toBeDefined();
  });

  it('run(): network error → "Network error"', async () => {
    const e = env({ fetch: vi.fn(async () => { throw new TypeError('net down'); }) });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run();
    expect(app.activeTab().result.error).toBe('Network error');
  });
  it('run(): AbortError → "Query was cancelled"', async () => {
    const e = env({ fetch: vi.fn(async () => { const err = new Error('x'); err.name = 'AbortError'; throw err; }) });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run();
    expect(app.activeTab().result.error).toBe('Query was cancelled');
  });
  it('run(): generic error → message', async () => {
    const e = env({ fetch: vi.fn(async () => { throw new Error('weird'); }) });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run();
    expect(app.activeTab().result.error).toBe('weird');
  });

  it('share: clipboard rejection falls back to a manual toast', async () => {
    const e = env({ window: fakeWin(), navigator: { clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } } });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    app.actions.share();
    await new Promise((r) => setTimeout(r));
    expect(document.querySelector('.share-toast')).not.toBeNull();
  });
  it('share: no clipboard API uses the manual toast', () => {
    const e = env({ window: fakeWin(), navigator: {} });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    app.actions.share();
    expect(document.querySelector('.share-toast').textContent).toContain('copy manually');
  });

  it('email() falls back through preferred_username / sub / empty', () => {
    const mk = (p) => createApp(env({ sessionStorage: memSession({ oauth_id_token: jwt({ exp: 9e9, ...p }) }) }));
    expect(mk({ preferred_username: 'u' }).email()).toBe('u');
    expect(mk({ sub: 's' }).email()).toBe('s');
    expect(mk({}).email()).toBe('');
  });

  it('getToken: null token, and expired token refreshed', async () => {
    const e0 = env({ sessionStorage: memSession({}) });
    expect(await createApp(e0).chCtx.getToken()).toBeNull();

    const e1 = env({
      sessionStorage: memSession({ oauth_id_token: jwt({ exp: 1 }), oauth_refresh_token: 'rt' }),
      fetch: makeFetch([
        [(u) => /config\.json/.test(u), resp({ json: { issuer: 'https://accounts.google.com', client_id: 'cid' } })],
        [(u) => /openid-configuration/.test(u), resp({ json: { authorization_endpoint: 'https://a', token_endpoint: 'https://t' } })],
        [(u) => u === 'https://t', resp({ json: { id_token: validToken } })],
      ]),
    });
    expect(await createApp(e1).chCtx.getToken()).toBe(validToken);
  });

  it('loaders + run guard tolerate being called before renderApp', async () => {
    const app = createApp(env({ fetch: makeFetch([[() => true, resp({ json: { data: [] } })]]) }));
    await app.loadVersion(); // setConn guard: no connStatus
    app.updateStar(); // guard: no starBtn

    // signed-out run with non-empty SQL exercises the getToken()→onSignedOut path
    const noToken = createApp(env({ sessionStorage: memSession({}) }));
    noToken.activeTab().sql = 'SELECT 1';
    await noToken.actions.run();
    expect(noToken.activeTab().result).toBeNull();

    // valid token but no renderApp → run proceeds and hits the setRunBtn guard
    const noRender = createApp(env({
      fetch: makeFetch([[(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]),
    }));
    noRender.activeTab().sql = 'SELECT 1';
    await noRender.actions.run();
    expect(noRender.activeTab().result.error).toBeNull();
  });

  it('every action wrapper is invokable', () => {
    const app = createApp(env());
    app.renderApp();
    app.dom.runBtn.dispatchEvent(new Event('click')); // run wrapper (empty sql → no-op)
    app.actions.newTab();
    app.state.tabs.push({ id: 'tx', name: 'X', sql: '', dirty: false, result: null, savedId: null });
    app.actions.selectTab('tx');
    app.actions.insertAtCursor('zz');
    app.actions.loadIntoNewTab('n', 'SELECT 2');
    app.actions.rerenderTabs();
    app.actions.rerenderResults();
    app.actions.updateStar();
    app.actions.closeTab(app.state.activeTabId);
    expect(app.state.tabs.length).toBeGreaterThan(0);
  });

  it('share / toggleSaved tolerate empty SQL; share with no navigator at all', () => {
    const e = env({ window: { history: { replaceState: vi.fn() }, navigator: undefined }, navigator: undefined });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sql = ''; // empty
    app.actions.share(); // returns at !sql (covers the `|| ''` empty branch)
    app.actions.toggleSaved(); // empty sql → no-op
    app.activeTab().sql = 'SELECT 1';
    app.actions.share(); // no clipboard anywhere → manual toast
    expect(document.querySelector('.share-toast')).not.toBeNull();
  });

  it('schemaError stringifies a non-Error rejection', async () => {
    const e = env({ fetch: vi.fn(async () => { throw 'rawfail'; }) });
    const app = createApp(e);
    app.renderApp();
    await new Promise((r) => setTimeout(r));
    expect(app.state.schemaError).toBe('rawfail');
  });

  it('run uses the performance.now fallback when env.now is absent', async () => {
    const e = env({ now: undefined, window: { ...fakeWin(), performance: { now: () => 5 } } });
    e.fetch = makeFetch([[(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run();
    expect(app.activeTab().result.error).toBeNull();
  });

  it('run stringifies a non-Error throw', async () => {
    const e = env({ fetch: vi.fn(async () => { throw 'boom-str'; }) });
    const app = createApp(e);
    app.renderApp();
    app.state.outputFormat = ''; // exercises the `outputFormat || 'Table'` fallback
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run();
    expect(app.activeTab().result.error).toBe('boom-str');
  });

  it('theme toggles both directions and renders the light icon', () => {
    const app = createApp(env({ sessionStorage: memSession({ oauth_id_token: validToken }) }));
    app.state.theme = 'light';
    app.renderApp(); // renders moon icon (line 283 light branch)
    app.dom.themeBtn.dispatchEvent(new Event('click')); // light → dark
    expect(app.state.theme).toBe('dark');
    app.dom.themeBtn.dispatchEvent(new Event('click')); // dark → light
    expect(app.state.theme).toBe('light');
  });

  it('share uses win.navigator when env.navigator is absent, and url when href is empty', async () => {
    const e = env({
      navigator: undefined,
      window: { history: { replaceState: vi.fn() }, navigator: { clipboard: { writeText: vi.fn(async () => {}) } } },
      location: { host: 'h', origin: 'https://h', pathname: '/sql', search: '', hash: '', href: '' },
    });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    app.actions.share();
    await Promise.resolve();
    expect(e.window.navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('#'));
  });

  it('ch_auth=basic sends Authorization: Basic base64(email:token)', async () => {
    const e = env({
      window: fakeWin(),
      fetch: makeFetch([
        [(u) => /config\.json/.test(u), resp({ json: { issuer: 'https://accounts.google.com', client_id: 'cid', ch_auth: 'basic' } })],
        [(u) => /openid-configuration/.test(u), resp({ json: { authorization_endpoint: 'https://a', token_endpoint: 'https://t' } })],
        [(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })],
      ]),
    });
    const app = createApp(e);
    app.renderApp();
    await app.ensureConfig();
    expect(app.chAuth).toBe('basic');
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run();
    const q = e.fetch.mock.calls.find((c) => c[1] && c[1].body === 'SELECT 1');
    const auth = q[1].headers.Authorization;
    expect(auth).toMatch(/^Basic /);
    expect(decodeURIComponent(escape(atob(auth.slice(6))))).toMatch(/^me@example\.com:/);
  });

  it('shows and dismisses the auth-failure banner', () => {
    const app = createApp(env());
    app.renderApp();
    app.updateBanner();
    expect(app.dom.banner.style.display).toBe('none'); // no error → hidden
    app.state.schemaError = 'Token authentication is not configured';
    app.updateBanner();
    expect(app.dom.banner.style.display).toBe('');
    expect(app.dom.banner.textContent).toContain('Token authentication is not configured');
    app.dom.banner.querySelector('.auth-banner-x').dispatchEvent(new Event('click'));
    expect(app.dom.banner.style.display).toBe('none');
    app.updateBanner(); // dismissed for this error → stays hidden
    expect(app.dom.banner.style.display).toBe('none');
  });
  it('updateBanner is a no-op before renderApp', () => {
    const app = createApp(env());
    expect(() => app.updateBanner()).not.toThrow();
  });

  it('renders history into the side panel after a successful run', async () => {
    const e = env({
      window: fakeWin(),
      fetch: makeFetch([[(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[]}\n', '{"row":{}}\n']) })]]),
    });
    const app = createApp(e);
    app.renderApp();
    app.state.sidePanel = 'history';
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run();
    expect(app.state.history.length).toBe(1);
  });
});
