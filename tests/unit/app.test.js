import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import dagre from '@dagrejs/dagre';
import { createApp } from '../../src/ui/app.js';
import { createCodeMirrorEditor } from '../../src/editor/codemirror-adapter.js';
import { AST_PROGRESSIVE_THRESHOLD } from '../../src/net/ch-client.js';
import { libraryControls, openFileMenu } from '../../src/ui/file-menu.js';
import { emptyRecentMap, recordRecent } from '../../src/core/recent-values.js';

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

// An in-memory Web Storage stub for tests that assert against the app's
// localStorage seam (storage.js reaches globalThis.localStorage ambiently, not
// via the injected env). Stubbing the global keeps the assertion insulated from
// the host runtime's native Web Storage — e.g. Node 25's native localStorage,
// which without --localstorage-file leaves getItem undefined (issue #130).
function memStore(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

function streamBody(lines) {
  let i = 0;
  return {
    getReader: () => ({
      read: async () => (i < lines.length ? { done: false, value: new TextEncoder().encode(lines[i++]) } : { done: true }),
      releaseLock: () => {},
    }),
  };
}
// A body whose reader throws on the first read — for mid-export failure tests.
function throwingBody(message) {
  return { getReader: () => ({ read: async () => { throw new Error(message); }, releaseLock: () => {} }) };
}
function resp(opts) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.json,
    text: async () => opts.text ?? JSON.stringify(opts.json),
    clone() { return this; },
    body: opts.body,
    headers: { get: (name) => (opts.headers && opts.headers[name]) ?? null },
  };
}
// Build a ClickHouse mid-stream exception frame's raw text (issue #87):
// \r\n__exception__\r\n<tag>\r\n<message>\n<len> <tag>\r\n__exception__\r\n
function exceptionFrame(tag, message) {
  const len = new TextEncoder().encode(message).length;
  return '\r\n__exception__\r\n' + tag + '\r\n' + message + '\n' + len + ' ' + tag + '\r\n__exception__\r\n';
}
// A fake FileSystemWritableFileStream + its handle, for streaming-export tests.
function fakeFileHandle(name = 'export.tsv') {
  const chunks = [];
  const writable = {
    write: vi.fn(async (chunk) => { chunks.push(Uint8Array.from(chunk)); }),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  const handle = { name, createWritable: vi.fn(async () => writable), move: vi.fn(async () => {}) };
  return { handle, writable, chunks };
}
function writtenText(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { merged.set(c, o); o += c.length; }
  return new TextDecoder().decode(merged);
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
    Dagre: dagre,
    Editor: createCodeMirrorEditor, // the real adapter — app tests exercise editor-backed flows (#143/#21)
    fetch: makeFetch([]),
    now: () => 0,
    retryMs: 0, // instant script-statement retry in tests (no real 250ms wait)
    navigator: { clipboard: { writeText: vi.fn(async () => {}) } },
    ...over,
  };
}

beforeEach(() => { document.body.innerHTML = ''; document.documentElement.style.removeProperty('--vp-zoom'); });
afterEach(() => vi.unstubAllGlobals());

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
  it('reads the ?host= URL param into app.hostHint (empty when absent)', () => {
    expect(createApp(env()).hostHint).toBe('');
    const app = createApp(env({ location: { host: 'h', origin: 'https://h', pathname: '/sql', search: '?host=antalya.demo:9000' } }));
    expect(app.hostHint).toBe('antalya.demo:9000');
  });
  it('openWindow + stylesText seams resolve from env, from window.open, and from the page <style>', () => {
    // env-provided seams win
    const a1 = createApp(env({ openWindow: () => 'X', stylesText: 'body{color:red}' }));
    expect(a1.openWindow()).toBe('X');
    expect(a1.stylesText).toBe('body{color:red}');
    // default openWindow delegates to window.open
    const open = vi.fn(() => 'W');
    const a2 = createApp(env({ window: { ...window, open }, openWindow: undefined, stylesText: undefined }));
    expect(a2.openWindow('', '_blank')).toBe('W');
    expect(open).toHaveBeenCalledWith('', '_blank');
    // default stylesText reads the served page's inlined <style>
    const styleEl = document.createElement('style');
    styleEl.textContent = '.x{}';
    document.head.appendChild(styleEl);
    expect(createApp(env({ stylesText: undefined })).stylesText).toBe('.x{}');
    styleEl.remove();
  });
  it('faviconHref resolves from env, from the page <link rel=icon>, or empty when neither is present', () => {
    expect(createApp(env({ faviconHref: 'data:image/x;base64,AA' })).faviconHref).toBe('data:image/x;base64,AA');
    expect(createApp(env({ faviconHref: undefined })).faviconHref).toBe(''); // no <link> in the test document
    const linkEl = document.createElement('link');
    linkEl.setAttribute('rel', 'icon');
    linkEl.setAttribute('href', 'data:image/y;base64,BB');
    document.head.appendChild(linkEl);
    expect(createApp(env({ faviconHref: undefined })).faviconHref).toBe('data:image/y;base64,BB');
    linkEl.remove();
  });
  it('exposes the injected document as app.document, not just the global document', () => {
    const customDoc = document.implementation.createHTMLDocument('');
    const app = createApp(env({ document: customDoc, root: customDoc.createElement('div') }));
    expect(app.document).toBe(customDoc);
    expect(app.document).not.toBe(document);
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
    expect(app.root.querySelector('.cm-editor')).not.toBeNull();
    // user control shows the short name (local-part) + full email on hover
    expect(app.dom.userBtn.querySelector('.user-short').textContent).toBe('me');
    expect(app.dom.userBtn.getAttribute('title')).toBe('me@example.com');
    await Promise.resolve();
  });
  it('toggles theme via the header button', () => {
    const { app } = rendered();
    app.dom.themeBtn.dispatchEvent(new Event('click')); // default light → dark
    expect(app.state.theme).toBe('dark');
    expect(app.savePref).toBeUndefined; // savePref is internal; theme attr set
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
  it('user menu: open → Log out clears tokens and shows login', () => {
    const { app, e } = rendered();
    app.dom.userBtn.dispatchEvent(new Event('click'));
    const menu = document.querySelector('.user-menu');
    expect(menu).not.toBeNull();
    expect(menu.querySelector('.um-id').textContent).toBe('me@example.com');
    expect(menu.querySelector('.um-build').textContent).toBe(app.build); // build stamp ('dev' here)
    menu.querySelector('.um-item.danger').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.token).toBeNull();
    expect(e.sessionStorage.getItem('oauth_id_token')).toBeNull();
    expect(app.root.querySelector('.login-screen')).not.toBeNull();
    expect(document.querySelector('.user-menu')).toBeNull(); // closed
  });
  it('user menu autofocuses the Log out item on open', async () => {
    const { app } = rendered();
    app.dom.userBtn.dispatchEvent(new Event('click'));
    const menu = document.querySelector('.user-menu');
    await new Promise((r) => setTimeout(r));
    expect(document.activeElement).toBe(menu.querySelector('.um-item.danger'));
  });
  it('user menu closes on Escape and outside-click; header has a GitHub source link', () => {
    const { app } = rendered();
    app.dom.userBtn.dispatchEvent(new Event('click'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.user-menu')).toBeNull();
    app.actions.openUserMenu();
    app.actions.openUserMenu(); // idempotent while open
    expect(document.querySelectorAll('.user-menu')).toHaveLength(1);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.querySelector('.user-menu')).toBeNull();
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
  it('schema search updates the filter', () => {
    const { app } = rendered();
    app.dom.schemaSearchInput.value = 'foo';
    app.dom.schemaSearchInput.dispatchEvent(new Event('input'));
    expect(app.state.schemaFilter.value).toBe('foo');
  });
});

describe('applyViewportZoom — html{zoom} viewport-unit divisor (#70)', () => {
  it('publishes the measured divisor as --vp-zoom on the document root', () => {
    // Inject the measurement seam (real layout needs a browser; viewportZoom is
    // unit-tested separately). 1 = the WebKit/Safari case the fix targets.
    const app = createApp(env({ measureViewportZoom: () => 1 }));
    app.renderApp();
    expect(app.vpZoom).toBe(1);
    expect(document.documentElement.style.getPropertyValue('--vp-zoom')).toBe('1');
  });

  it('leaves --vp-zoom (the CSS default) untouched when the layout is unmeasurable', () => {
    // happy-dom has no layout, so the default seam's 100vh probe measures 0 → null.
    const app = createApp(env());
    app.renderApp();
    expect(app.vpZoom).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue('--vp-zoom')).toBe('');
  });

  it('measures via a transient 100vh probe by default, leaving no probe behind', () => {
    const app = createApp(env());
    app.renderApp(); // the default seam ran: appended its probe, measured, removed it
    expect(document.querySelector('div[style*="100vh"]')).toBeNull();
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
    expect(app.state.schemaError.value).toContain('boom');
  });
});

describe('loadReference / rebuildCompletions (#25)', () => {
  it('loads server keywords + functions into refData and the completion list', async () => {
    const e = env({ fetch: makeFetch([
      [(u, sql) => /system\.keywords/.test(sql), resp({ json: { data: [{ keyword: 'PREWHERE' }] } })],
      [(u, sql) => /system\.functions/.test(sql), resp({ json: { data: [{ name: 'toDate', is_aggregate: 0 }] } })],
    ]) });
    const app = createApp(e);
    app.renderApp();
    await app.loadReference();
    expect(app.refData.keywordSet.has('PREWHERE')).toBe(true); // drives the tokenizer too
    expect(app.refData.funcSet.has('toDate')).toBe(true);
    expect(app.completions.some((c) => c.label === 'PREWHERE')).toBe(true);
  });
  it('starts with the built-in fallback before any load', () => {
    const app = createApp(env());
    expect(app.refData.keywordSet.has('SELECT')).toBe(true);
    expect(app.completions.length).toBeGreaterThan(0);
  });
  it('rebuildCompletions folds in already-loaded schema columns', () => {
    const app = createApp(env());
    app.state.schema.value = [{ db: 'd', tables: [{ name: 't', columns: [{ name: 'c', type: 'UInt8' }] }] }];
    app.rebuildCompletions();
    expect(app.completions.some((c) => c.kind === 'column' && c.label === 'c' && c.parent === 't')).toBe(true);
  });
  it('loadReference tolerates being called before the editor mounts', async () => {
    const app = createApp(env()); // no renderApp → refreshReference hits the unmounted guard
    await expect(app.loadReference()).resolves.toBeUndefined();
    expect(app.refData).toBeTruthy();
  });
  it('without env.Editor the noop port stands in — headless consumers stay callable (#143)', async () => {
    const e = env();
    delete e.Editor;
    const app = createApp(e);
    await expect(app.loadReference()).resolves.toBeUndefined(); // refreshReference on the noop port
    expect(app.editor.hasFocus()).toBe(false);
    expect(app.editor.getSelection()).toEqual({ start: 0, end: 0, text: '' });
    expect(() => app.actions.insertAtCursor('x')).not.toThrow();
  });
  it('loadColumns folds the newly-loaded columns into the completion list (#26)', async () => {
    const e = env({ fetch: makeFetch([
      [(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [{ name: 'id', type: 'UInt64', comment: '' }] } })],
    ]) });
    const app = createApp(e); // no renderApp → loadSchema can't clobber our schema mid-test
    app.state.schema.value = [{ db: 'd', tables: [{ name: 't', columns: null }] }];
    await app.actions.loadColumns('d', 't');
    expect(app.completions.some((c) => c.kind === 'column' && c.label === 'id' && c.parent === 't')).toBe(true);
  });
  it('entityDoc fetches a hover description on demand and caches it (#27)', async () => {
    const fetch = makeFetch([
      [(u, sql) => /system\.functions/.test(sql) && /description/.test(sql),
        resp({ json: { data: [{ description: '\nCounts rows.' }] } })],
    ]);
    const app = createApp(env({ fetch }));
    const first = await app.entityDoc('count');
    const second = await app.entityDoc('count'); // served from cache, no second query
    expect(first).toBe('Counts rows.'); // first non-empty line (CH leading blank stripped)
    expect(second).toBe('Counts rows.');
    const docQueries = fetch.mock.calls.filter(([, init]) => init && /system\.functions/.test(init.body) && /description/.test(init.body));
    expect(docQueries.length).toBe(1);
  });
  it('does not cache a FAILED doc fetch — it retries on the next hover (#8 review)', async () => {
    let calls = 0;
    const fetch = makeFetch([
      [(u, sql) => /system\.functions/.test(sql) && /description/.test(sql), () => {
        calls += 1;
        return calls === 1
          ? resp({ ok: false, status: 500, text: 'boom' })            // transient failure
          : resp({ json: { data: [{ description: 'Now works.' }] } }); // later succeeds
      }],
    ]);
    const app = createApp(env({ fetch }));
    expect(await app.entityDoc('count')).toBeNull(); // failed → null, not cached
    expect(await app.entityDoc('count')).toBe('Now works.'); // retried, not served from a cached error
    expect(calls).toBe(2);
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
    // a plain SELECT needs no session, so none is opened (avoids the session race)
    expect(app.chCtx.fetch.mock.calls.map((c) => c[0]).some((u) => /session_id=/.test(u))).toBe(false);
  });
  it('opens a ClickHouse session only for SQL that needs one (SET / TEMPORARY), and it sticks to the tab', async () => {
    const { app } = appForRun([[() => true, resp({ body: streamBody(['{"row":{}}\n']) })]]);
    app.activeTab().sql = 'SET max_threads = 1';
    await app.actions.run(); // SET → opens a session
    const setUrl = app.chCtx.fetch.mock.calls.map((c) => c[0]).find((u) => /session_id=/.test(u));
    expect(setUrl).not.toMatch(/session_timeout/); // rely on the server default (60s) — see sessionParams
    const sid = /session_id=([^&]+)/.exec(setUrl)[1];
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT 1'; // plain SELECT now, but the tab already has a session
    await app.actions.run();
    const selUrl = app.chCtx.fetch.mock.calls.map((c) => c[0]).find((u) => /session_id=/.test(u));
    expect(/session_id=([^&]+)/.exec(selUrl)[1]).toBe(sid); // sticky: same session id
  });
  it('refreshes the schema after a successful schema-mutating statement (#diagnose-db-creation)', async () => {
    const { app } = appForRun([
      [(u, sql) => /CREATE DATABASE/.test(sql), resp({ body: streamBody([]) })],
    ]);
    await new Promise((r) => setTimeout(r)); // let the initial-mount loadSchema settle
    const spy = vi.spyOn(app, 'loadSchema');
    app.activeTab().sql = 'CREATE DATABASE t3';
    await app.actions.run();
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('does not refresh the schema after a plain SELECT', async () => {
    const { app } = appForRun([
      [(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })],
    ]);
    await new Promise((r) => setTimeout(r));
    const spy = vi.spyOn(app, 'loadSchema');
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run();
    expect(spy).not.toHaveBeenCalled();
  });
  it('keeps the current result view on a plain re-run, and restores a remembered view when opened (#34)', async () => {
    const routes = [[(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })]];
    const { app } = appForRun(routes, { Chart: class { destroy() {} } }); // Chart seam so the chart view renders
    app.activeTab().sql = 'SELECT 1';
    app.state.resultView.value = 'chart';
    await app.actions.run();                  // no opts → keep the current (chart) tab
    expect(app.state.resultView.value).toBe('chart');
    await app.actions.run({ view: 'json' });  // saved-query open restores its view
    expect(app.state.resultView.value).toBe('json');
    await app.actions.run({ view: 'table' });
    expect(app.state.resultView.value).toBe('table');
    await app.actions.run({ view: 'chart' });
    expect(app.state.resultView.value).toBe('chart');
    await app.actions.run({ view: 'bogus' }); // unknown view → keep current (chart)
    expect(app.state.resultView.value).toBe('chart');
  });
  it('switching the result view repaints via the effect (the view-tab onclick only sets the signal)', async () => {
    const routes = [[(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })]];
    const { app } = appForRun(routes);
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run();
    const region = app.dom.resultsRegion;
    expect(region.querySelector('.res-table')).not.toBeNull(); // table view by default
    const jsonTab = [...region.querySelectorAll('.result-view-tab')].find((b) => b.textContent.includes('JSON'));
    jsonTab.dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.state.resultView.value).toBe('json');
    expect(region.querySelector('.json-view')).not.toBeNull(); // repainted by the results effect, not the onclick
    expect(region.querySelector('.res-table')).toBeNull();
  });
  it('no-ops on empty SQL', async () => {
    const { app } = appForRun([]);
    app.activeTab().sql = '   ';
    await app.actions.run();
    expect(app.activeTab().result).toBeNull();
  });
  it('run() while already running is a no-op (cancel is separate)', async () => {
    const { app } = appForRun([]);
    app.state.running.value = true;
    const ac = { abort: vi.fn() };
    app.state.abortController = ac;
    await app.actions.run();
    expect(ac.abort).not.toHaveBeenCalled(); // re-running no longer aborts
    expect(app.state.running.value).toBe(true);
  });
  it('setRunBtn: "Running…" with no trailing "null"; "Run" + kbd when idle', () => {
    const { app } = appForRun([]);
    app.setRunBtn(true);
    expect(app.dom.runBtn.disabled).toBe(true);
    expect(app.dom.runBtn.textContent).toBe('Running…'); // regression: not "Running…null"
    app.setRunBtn(false);
    expect(app.dom.runBtn.disabled).toBe(false);
    expect(app.dom.runBtn.textContent).toContain('Run');
    expect(app.dom.runBtn.querySelector('kbd')).not.toBeNull();
  });
  it('typing drives the real onDocChange subscriber: tab.sql/dirty, tab strip, Save button, var strip (#143)', () => {
    const { app } = appForRun([]);
    const view = app.dom.editorView;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'SELECT {p:UInt8}' } });
    // the subscriber (registered once in createApp) owns the state writes…
    expect(app.activeTab().sql).toBe('SELECT {p:UInt8}');
    expect(app.activeTab().dirty).toBe(true);
    // …and runs its dependents AFTER them: the var strip read the new text
    // (visible strip proves the tab.sql write happened first), and the Run
    // button picked up the unfilled-variable gate.
    expect(app.dom.varStrip.style.display).not.toBe('none');
    expect(app.dom.varStrip.querySelector('.var-name').textContent).toBe('p');
    expect(app.dom.runBtn.disabled).toBe(true);
    // the tab strip re-rendered with the dirty marker
    expect(app.dom.qtabsInner.querySelector('.dirty')).not.toBeNull();
  });
  it('query variables (#134): renders an input per detected {name:Type}, hides when none', () => {
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT {database:String}, {table:String}';
    app.renderVarStrip();
    expect(app.dom.varStrip.style.display).not.toBe('none');
    const fields = app.dom.varStrip.querySelectorAll('.var-field');
    expect([...fields].map((f) => f.querySelector('.var-name').textContent)).toEqual(['database', 'table']);
    expect(app.dom.varStrip.querySelector('.var-input').placeholder).toBe('String');
    // an unfilled variable disables Run with an explanatory tooltip
    expect(app.dom.runBtn.disabled).toBe(true);
    expect(app.dom.runBtn.title).toContain('database');
    // re-detecting the same set is idempotent (signature guard skips the rebuild)
    const before = app.dom.varStrip.querySelector('.var-input');
    app.renderVarStrip();
    expect(app.dom.varStrip.querySelector('.var-input')).toBe(before);
    // no variables → strip hidden again
    app.activeTab().sql = 'SELECT 1';
    app.renderVarStrip();
    expect(app.dom.varStrip.style.display).toBe('none');
    expect(app.dom.runBtn.disabled).toBe(false);
  });
  it('query variables (#134): typing a value updates the shared store, persists, and re-enables Run', () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT {id:UInt32}';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.value = '42';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(app.state.varValues.id).toBe('42'); // shared, name-keyed store (not per-tab)
    expect(JSON.parse(globalThis.localStorage.getItem('asb:varValues')).id).toBe('42'); // persisted
    expect(app.dom.runBtn.disabled).toBe(false);
    expect(app.dom.runBtn.title).toBe('');
  });
  it('query variables (#134): a value is shared across queries — reused/prefilled by name', () => {
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT {database:String}';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.value = 'analytics';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // a *different* query using the same variable prefills the value, no retyping
    app.activeTab().sql = 'SELECT count() FROM {database:String}.events WHERE 1';
    app.renderVarStrip();
    expect(app.dom.varStrip.querySelector('.var-input').value).toBe('analytics');
    expect(app.dom.runBtn.disabled).toBe(false); // already satisfied from the shared store
  });
  it('query variables (#134): a persisted value is restored on load and prefilled', () => {
    vi.stubGlobal('localStorage', memStore({ 'asb:varValues': JSON.stringify({ table: 'events' }) }));
    const { app } = appForRun([]);
    expect(app.state.varValues.table).toBe('events'); // loaded from localStorage at startup
    app.activeTab().sql = 'SELECT * FROM {table:String}';
    app.renderVarStrip();
    expect(app.dom.varStrip.querySelector('.var-input').value).toBe('events');
    expect(app.dom.runBtn.disabled).toBe(false);
  });
  it('query variables (#134): a run with an unfilled variable is blocked and toasts', async () => {
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r)); // let the initial-mount fetches settle
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT {id:UInt32}';
    await app.actions.run(); // ⌘↵/button path (runEntry) — bypasses the disabled button
    expect(app.activeTab().result).toBeNull(); // never executed
    expect(app.chCtx.fetch.mock.calls.length).toBe(0);
    expect(document.body.querySelector('.share-toast').textContent).toContain('id');
  });
  it('query variables (#134): a filled SELECT is sent with native param_<name> args', async () => {
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    const tab = app.activeTab();
    tab.sql = 'WITH {database:String} AS d, {table:String} AS t SELECT 1';
    app.state.varValues = { database: 'default', table: 'events' };
    await app.actions.run();
    const [url, init] = app.chCtx.fetch.mock.calls[0];
    expect(url).toMatch(/param_database=default/);
    expect(url).toMatch(/param_table=events/);
    // the SQL text itself is untouched — ClickHouse does the substitution
    expect(init.body).toContain('{database:String}');
  });
  it('relative time (#169): a DateTime var gets the combobox — focus opens the preset list', () => {
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT {from:DateTime}';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    expect(input.getAttribute('role')).toBe('combobox');
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(app.dom.varStrip.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
    expect(app.dom.varStrip.querySelector('.var-combo-preview')).not.toBeNull();
  });
  it('relative time (#169): a non-date type gets the recents-only combobox (#171), not the date-like preset+preview one', () => {
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT {n:UInt32}';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    // Still a combobox (#171 gives every field a recents dropdown)...
    expect(input.getAttribute('role')).toBe('combobox');
    // ...but never the date-like field's preset live preview.
    expect(app.dom.varStrip.querySelector('.var-combo-preview')).toBeNull();
  });
  it('relative time (#169): picking a preset inserts the expression, persists it (not the resolved value), and shows a live preview', () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([], { wallNow: () => 1751200000000 });
    app.activeTab().sql = 'SELECT {from:DateTime}';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    const opt = app.dom.varStrip.querySelector('[role="option"]'); // first preset: -15m
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(input.value).toBe('-15m'); // the expression stays in the field
    expect(app.state.varValues.from).toBe('-15m'); // …and is what's stored/persisted
    expect(JSON.parse(globalThis.localStorage.getItem('asb:varValues')).from).toBe('-15m');
    const preview = app.dom.varStrip.querySelector('.var-combo-preview');
    expect(preview.textContent).toContain('-15m →');
  });
  it('relative time (#169): an invalid (near-miss) expression disables Run with a structured reason', () => {
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT {from:DateTime}';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.value = 'now/q';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true })); // hardens (#170)
    expect(app.dom.runBtn.disabled).toBe(true);
    expect(app.dom.runBtn.title).toContain('from');
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(input.title).toMatch(/Not a valid relative time expression/);
  });
  it("relative time (#169 review finding #2): typing a near-miss stays neutral (incomplete) — Run stays enabled until blur hardens it", () => {
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT {from:DateTime}';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.value = 'now/q';
    input.dispatchEvent(new Event('input', { bubbles: true })); // still typing — 'input' mode
    expect(app.dom.runBtn.disabled).toBe(false);
    expect(input.classList.contains('is-invalid')).toBe(false);
    expect(app.hardenedVars.has('from')).toBe(false);
    input.dispatchEvent(new Event('blur', { bubbles: true })); // commits — 'execute' mode hardens it
    expect(app.dom.runBtn.disabled).toBe(true);
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(app.hardenedVars.has('from')).toBe(true);
    // The hardened state (#170's app.hardenedVars mechanism) persists across
    // an unrelated re-render — the same mechanism the type-validator's own
    // incomplete→invalid hardening already relies on, now also reached via
    // the relative-time near-miss path (review finding #2's whole point: it
    // routes through the exact same states, not a bespoke gate).
    app.dom.varStripSig = null; // force renderVarStrip to rebuild the strip
    app.renderVarStrip();
    expect(app.dom.runBtn.disabled).toBe(true);
    const rebuiltInput = app.dom.varStrip.querySelector('.var-input');
    expect(rebuiltInput.classList.contains('is-invalid')).toBe(true);
  });
  it('relative time (#169): Enter with the preset list closed hardens/gates via the same keydown path as a plain field', () => {
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT {from:DateTime}';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.value = 'now/q';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(app.dom.runBtn.disabled).toBe(true);
    expect(input.classList.contains('is-invalid')).toBe(true);
  });
  it('relative time (#169): Enter with an active preset option commits it via keydown instead of hardening the prior text', () => {
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT {from:DateTime}';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.focus(); // a real focus (not a synthetic dispatchEvent) — matches document.activeElement
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(input.value).toBe('-15m'); // the first preset, committed — not left as invalid/empty text
    expect(input.getAttribute('aria-expanded')).toBe('false'); // list closed by the commit
  });
  it('relative time (#169): a filled relative expression resolves to epoch seconds on the wave clock and re-resolves on the next run', async () => {
    const { app, e } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]], { wallNow: () => 1751200000000 });
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    const tab = app.activeTab();
    tab.sql = 'SELECT {from:DateTime}';
    app.state.varValues = { from: '-1h' };
    await app.actions.run();
    const [url1] = app.chCtx.fetch.mock.calls[0];
    expect(url1).toMatch(new RegExp(`param_from=${Math.round((1751200000000 - 3600000) / 1000)}(?:&|$)`));
    // advance the injected clock and re-run: the stored expression re-resolves
    // to a different absolute value (the moving window, #173's batch clock)
    e.wallNow = () => 1751200000000 + 3600000;
    app.chCtx.fetch.mockClear();
    await app.actions.run();
    const [url2] = app.chCtx.fetch.mock.calls[0];
    expect(url2).toMatch(new RegExp(`param_from=${Math.round(1751200000000 / 1000)}(?:&|$)`));
  });
  it('relative time (#169): a Date var formats as a calendar date; non-date types are unaffected by a relative-looking value', async () => {
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]], { wallNow: () => 1751200000000 });
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    const tab = app.activeTab();
    tab.sql = 'SELECT {day:Date}, {tag:String}';
    app.state.varValues = { day: 'now', tag: '-1h' }; // a String var keeps a relative-looking value verbatim
    await app.actions.run();
    const [url] = app.chCtx.fetch.mock.calls[0];
    const expectedDay = new Date(1751200000000).toISOString().slice(0, 10);
    expect(url).toMatch(new RegExp(`param_day=${expectedDay}(?:&|$)`));
    expect(url).toMatch(/param_tag=-1h(?:&|$)/);
  });
  it('relative time (#169): composes with an optional /*[ ]*/ block (#165) — a relative value inside an active block resolves and binds', async () => {
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]], { wallNow: () => 1751200000000 });
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    const tab = app.activeTab();
    tab.sql = 'SELECT * FROM t WHERE 1 /*[ AND d >= {from:DateTime} ]*/';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.value = '-1h';
    input.dispatchEvent(new Event('input', { bubbles: true })); // activates the block (#165) and stores the expression
    await app.actions.run();
    const [url, init] = app.chCtx.fetch.mock.calls[0];
    expect(init.body).toContain('AND d >= {from:DateTime}'); // block materialized (active)
    expect(url).toMatch(new RegExp(`param_from=${Math.round((1751200000000 - 3600000) / 1000)}(?:&|$)`));
  });
  it('query variables (#134): a CREATE VIEW definition is sent unchanged (no substitution)', async () => {
    const { app } = appForRun([[(u, sql) => /CREATE VIEW/.test(sql), resp({ body: streamBody([]) })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    const tab = app.activeTab();
    tab.sql = 'CREATE VIEW v AS SELECT {x:String}';
    app.state.varValues = { x: 'default' }; // even with a value present, a view is not substituted
    await app.actions.run(); // not row-returning, no variables shown → runs freely
    const [url, init] = app.chCtx.fetch.mock.calls[0];
    expect(url).not.toMatch(/param_x/);
    expect(init.body).toContain('{x:String}');
  });
  it('query variables (#134): a script substitutes reads but leaves a VIEW verbatim', async () => {
    const { app } = appForRun([
      [(u, sql) => /CREATE VIEW/.test(sql), resp({ text: '' })],
      [(u, sql) => /SELECT/.test(sql), resp({ text: '{"meta":[{"name":"id","type":"UInt32"}],"data":[["5"]]}' })],
    ]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    const tab = app.activeTab();
    tab.sql = 'CREATE VIEW v AS SELECT {x:String}; SELECT {id:UInt32}';
    app.state.varValues = { id: '5' }; // x is confined to the view → not required, not sent
    await app.actions.run(); // >1 statement → runScript
    const viewCall = app.chCtx.fetch.mock.calls.find((c) => /CREATE VIEW/.test(c[1].body));
    const selCall = app.chCtx.fetch.mock.calls.find((c) => /SELECT \{id/.test(c[1].body));
    expect(viewCall[0]).not.toMatch(/param_/);
    expect(selCall[0]).toMatch(/param_id=5/);
  });
  it('query variables (#134): the gate lives at the executor, so Explain is blocked too', async () => {
    const { app } = appForRun([[() => true, resp({ text: 'plan' })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT {id:UInt32}';
    await app.actions.explainQuery(); // clicks Explain → run({explain}) → gate
    expect(app.chCtx.fetch.mock.calls.length).toBe(0);
    expect(document.body.querySelector('.share-toast').textContent).toContain('id');
  });
  it('query variables (#134): a multi-statement script is blocked when a variable is unfilled', async () => {
    const { app } = appForRun([[() => true, resp({ text: '{"meta":[],"data":[]}' })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT {a:String}; SELECT 1';
    await app.actions.run(); // >1 statement → runScript → gate
    expect(app.chCtx.fetch.mock.calls.length).toBe(0);
    expect(document.body.querySelector('.share-toast').textContent).toContain('a');
  });
  it('query variables (#173): an Array(T) value binds as a ClickHouse array literal', async () => {
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT {xs:Array(String)}';
    app.state.varValues = { xs: ['a', "b'c"] };
    await app.actions.run();
    const [url] = app.chCtx.fetch.mock.calls[0];
    expect(decodeURIComponent(url)).toContain("param_xs=['a','b\\'c']");
  });
  it('query variables (#173): a value that cannot serialize for the declaration blocks the run and toasts', async () => {
    const { app } = appForRun([[() => true, resp({ body: streamBody([]) })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT {db:String}';
    app.state.varValues = { db: ['not', 'scalar'] }; // array value, scalar declaration → structural
    await app.actions.run();
    expect(app.chCtx.fetch.mock.calls.length).toBe(0);
    expect(document.body.querySelector('.share-toast').textContent).toContain('array value');
  });
  it('optional blocks (#165): Run enables with the optional param blank; the block and its arg are omitted', async () => {
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT * FROM t WHERE 1 /*[ AND d = {d:String} ]*/';
    app.renderVarStrip();
    expect(app.dom.runBtn.disabled).toBe(false); // blank optional never gates
    await app.actions.run();
    const [url, init] = app.chCtx.fetch.mock.calls[0];
    expect(init.body).toBe('SELECT * FROM t WHERE 1 '); // inactive block removed from the wire
    expect(url).not.toMatch(/param_d/); // its param is never sent
  });
  it('optional blocks (#165): typing a value activates the block — predicate included, param bound', async () => {
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT * FROM t WHERE 1 /*[ AND d = {d:String} ]*/';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.value = 'abc';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(app.state.filterActive.d).toBe(true); // text control syncs activation
    await app.actions.run();
    const [url, init] = app.chCtx.fetch.mock.calls[0];
    expect(init.body).toBe('SELECT * FROM t WHERE 1  AND d = {d:String} '); // markers stripped, content kept
    expect(url).toMatch(/param_d=abc/);
  });
  it('optional blocks (#165): the strip lists a block-only param with the optional affordance', () => {
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT {y:UInt16} FROM t /*[ AND d = {d:String} ]*/';
    app.renderVarStrip();
    const fields = [...app.dom.varStrip.querySelectorAll('.var-field')];
    expect(fields.map((f) => f.querySelector('.var-name').textContent)).toEqual(['y', 'd']);
    expect(fields.map((f) => f.classList.contains('is-optional'))).toEqual([false, true]);
    expect(fields[1].querySelector('.var-input').title).toContain('optional');
    // the required param still gates Run
    expect(app.dom.runBtn.disabled).toBe(true);
    expect(app.dom.runBtn.title).toContain('y');
    expect(app.dom.runBtn.title).not.toContain('d');
  });
  it('optional blocks (#165): activation persists alongside the value (own storage key)', () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT 1 /*[ AND d = {d:String} ]*/';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.value = 'v1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(JSON.parse(globalThis.localStorage.getItem('asb:filterActive'))).toEqual({ d: true });
    expect(JSON.parse(globalThis.localStorage.getItem('asb:varValues'))).toEqual({ d: 'v1' });
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(JSON.parse(globalThis.localStorage.getItem('asb:filterActive'))).toEqual({ d: false });
  });
  it('optional blocks (#165): a persisted active:false with a stale value keeps the block omitted', async () => {
    vi.stubGlobal('localStorage', memStore({
      'asb:varValues': JSON.stringify({ d: 'stale' }),
      'asb:filterActive': JSON.stringify({ d: false }),
    }));
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT * FROM t WHERE 1 /*[ AND d = {d:String} ]*/';
    await app.actions.run();
    const [url, init] = app.chCtx.fetch.mock.calls[0];
    expect(init.body).toBe('SELECT * FROM t WHERE 1 '); // dormant value is inert
    expect(url).not.toMatch(/param_d/);
  });
  it('optional blocks (#165): a template error blocks the run with a toast', async () => {
    const { app } = appForRun([[() => true, resp({ body: streamBody([]) })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT 1 /*[ AND 1 = 1 ]*/'; // parameterless block
    await app.actions.run();
    expect(app.chCtx.fetch.mock.calls.length).toBe(0);
    expect(document.body.querySelector('.share-toast').textContent).toContain('optional block');
  });
  it('optional blocks (#165): Explain wraps the materialized statement, not the raw template', async () => {
    const { app } = appForRun([[() => true, resp({ text: 'plan' })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT * FROM t WHERE 1 /*[ AND d = {d:String} ]*/';
    app.state.varValues = { d: 'x' };
    app.state.filterActive = { d: true };
    await app.actions.explainQuery();
    const [url, init] = app.chCtx.fetch.mock.calls.find((c) => c[1] && c[1].body);
    expect(init.body).toMatch(/^EXPLAIN/);
    expect(init.body).toContain('AND d = {d:String}'); // active block content in
    expect(init.body).not.toContain('/*['); // markers never reach the server
    expect(url).toMatch(/param_d=x/);
  });
  it('optional blocks (#165): a script sends each statement materialized, args per statement', async () => {
    const { app } = appForRun([[() => true, resp({ text: '{"meta":[],"data":[]}' })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT 1 /*[ AND a = {a:String} ]*/; SELECT 2 /*[ AND b = {b:String} ]*/';
    app.state.varValues = { a: 'x' };
    app.state.filterActive = { a: true };
    await app.actions.run(); // >1 statement → runScript
    const bodies = app.chCtx.fetch.mock.calls.map((c) => c[1] && c[1].body);
    expect(bodies).toContain('SELECT 1  AND a = {a:String} '); // active block in
    expect(bodies).toContain('SELECT 2 '); // inactive block out
    const aCall = app.chCtx.fetch.mock.calls.find((c) => /SELECT 1/.test(c[1].body));
    expect(aCall[0]).toMatch(/param_a=x/);
    const bCall = app.chCtx.fetch.mock.calls.find((c) => /SELECT 2/.test(c[1].body));
    expect(bCall[0]).not.toMatch(/param_b/);
  });
  it('typed validation (#170): a clearly-invalid value shows the inline error immediately and disables Run', () => {
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT {n:UInt8}';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.value = 'abc'; // not a plausible prefix of anything — invalid, not incomplete
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(app.dom.runBtn.disabled).toBe(true);
    expect(app.dom.runBtn.title).toContain('n');
  });
  it('typed validation (#170): an out-of-range value shows a specific reason, exceeding server strictness on purpose', () => {
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT {n:UInt8}';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.value = '256'; // the live server accepts this and silently wraps to 0 — blocked client-side instead
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(input.title).toBe('Expected UInt8 from 0 to 255');
  });
  it("typed validation (#170): a plausible mid-typing prefix ('-') stays neutral while focused, hardens on blur", () => {
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT {n:Int32}';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.value = '-';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(false); // neutral — could still become '-5'
    expect(app.dom.runBtn.disabled).toBe(false); // 'input' mode never hardens
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(true); // blur commits — hardens to invalid
    expect(app.dom.runBtn.disabled).toBe(true);
  });
  it('typed validation (#170 review): a hardened invalid value keeps blocking Run across unrelated re-renders, until the field itself is edited', () => {
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT {n:Int32}';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.value = '-';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true })); // hardens '-' to invalid
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(app.dom.runBtn.disabled).toBe(true);

    // renderVarStrip's own tail call (fired on every SQL-editor keystroke via
    // onDocChange) recomputes Run's gate gate-less, in lenient 'input' mode —
    // which alone would read the still-incomplete '-' as merely incomplete
    // and silently re-enable Run while the field still paints red. The
    // signature is unchanged (same {n:Int32}), so this only re-derives the
    // Run button, exactly the path that regressed.
    app.renderVarStrip();
    expect(app.dom.runBtn.disabled).toBe(true);
    expect(app.dom.runBtn.title).toContain('n');
    expect(input.classList.contains('is-invalid')).toBe(true);

    // Same gate-less fallback, reached from the hasSelection effect (fires on
    // every cursor/selection move).
    app.state.hasSelection.value = true;
    expect(app.dom.runBtn.disabled).toBe(true);

    // Editing the field's own value clears its hardened flag — lenient
    // 'input'-mode behavior resumes, and a now-valid value re-enables Run.
    input.value = '-5';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(false);
    expect(app.dom.runBtn.disabled).toBe(false);
  });
  it('typed validation (#170): Enter also hardens an incomplete value', () => {
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT {n:Float64}';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.value = '1e'; // live-rejected, but a genuine mid-typing state
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(false);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(app.dom.runBtn.disabled).toBe(true);
  });
  it('typed validation (#170): correcting an invalid value clears the affordance and re-enables Run', () => {
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT {n:UInt8}';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.value = 'abc';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(app.dom.runBtn.disabled).toBe(true);
    input.value = '42';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(false);
    expect(app.dom.runBtn.disabled).toBe(false);
  });
  it('typed validation (#170): an out-of-scope type (String) is never marked invalid', () => {
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT {s:String}';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.value = 'anything at all, ,,, {}';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('is-invalid')).toBe(false);
    expect(app.dom.runBtn.disabled).toBe(false);
  });
  it('typed validation (#170): a run is blocked and toasts for an invalid (not just missing) variable', async () => {
    const { app } = appForRun([[() => true, resp({ body: streamBody([]) })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT {n:UInt8}';
    app.state.varValues = { n: '256' };
    await app.actions.run();
    expect(app.chCtx.fetch.mock.calls.length).toBe(0);
    expect(document.body.querySelector('.share-toast').textContent).toContain('n');
  });
  it('typed validation (#170): a persisted invalid value paints the affordance on strip (re)build, e.g. a tab switch', () => {
    const { app } = appForRun([]);
    app.activeTab().sql = 'SELECT {n:UInt8}';
    app.state.varValues = { n: '256' };
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(app.dom.runBtn.disabled).toBe(true);
  });
  it('the wall clock (#173) is its own injected seam, distinct from the duration clock', () => {
    const app = createApp(env({ wallNow: () => 777 })); // injected → tests can pin the wave clock
    expect(app.wallNow()).toBe(777);
    const app2 = createApp(env()); // default → Date.now (epoch ms), while env.now stays 0
    expect(app2.wallNow()).toBeGreaterThan(1e12);
    expect(app2.now()).toBe(0);
  });
  it('tickElapsed updates the live ms readout, and no-ops without the element', () => {
    const { app } = appForRun([]);
    app.state.runT0 = 0;
    app.dom.runElapsedEl = document.createElement('span');
    app.tickElapsed(); // env.now → 0
    expect(app.dom.runElapsedEl.textContent).toBe('0 ms');
    app.dom.runElapsedEl = null;
    expect(() => app.tickElapsed()).not.toThrow();
  });
  it('cancel() aborts + issues KILL QUERY when running; no-op when idle', async () => {
    const { app, e } = appForRun([]);
    app.actions.cancel(); // idle → no-op, no throw
    const abort = vi.fn();
    app.state.running.value = true;
    app.state.abortController = { abort, signal: {} };
    app.state.runQueryId = 'qid-1';
    app.actions.cancel();
    expect(abort).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r)); // let the fire-and-forget KILL QUERY run
    const kill = e.fetch.mock.calls.find((c) => /KILL QUERY/.test((c[1] && c[1].body) || ''));
    expect(kill).toBeTruthy();
    expect(kill[1].body).toContain("query_id = 'qid-1'");
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
  it('runs raw and captures the response when the SQL ends with a FORMAT clause', async () => {
    const { app } = appForRun([
      [(u, sql) => /SELECT 9/.test(sql), resp({ text: 'a\tb' })],
    ]);
    app.activeTab().sql = 'SELECT 9 FORMAT TabSeparatedWithNames';
    await app.actions.run();
    expect(app.activeTab().result.rawText).toBe('a\tb');
    expect(app.activeTab().result.rawFormat).toBe('TabSeparatedWithNames'); // label for the raw tab
  });
  const sentExplains = (e) => e.fetch.mock.calls.map((c) => c[1] && c[1].body).filter((b) => /EXPLAIN/.test(b || ''));
  it('runs a plain EXPLAIN verbatim in the Explain view (clean TabSeparatedRaw)', async () => {
    const { app, e } = appForRun([
      [(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'Expression\n  ReadFromTable' })],
    ]);
    app.activeTab().sql = 'EXPLAIN SELECT 1';
    await app.actions.run();
    expect(app.activeTab().result.explainView).toBe('explain');
    expect(app.activeTab().result.rawText).toBe('Expression\n  ReadFromTable');
    expect(sentExplains(e)).toContain('EXPLAIN SELECT 1'); // verbatim
  });
  it('keeps a complex EXPLAIN (extra settings) on the verbatim Explain view', async () => {
    const { app, e } = appForRun([[(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'plan' })]]);
    app.activeTab().sql = 'EXPLAIN indexes = 1, actions = 1 SELECT 1';
    await app.actions.run();
    expect(app.activeTab().result.explainView).toBe('explain'); // not auto-jumped to Indexes
    expect(sentExplains(e)).toContain('EXPLAIN indexes = 1, actions = 1 SELECT 1'); // run as typed
  });
  it('auto-selects the Indexes view for an exact indexes=1 EXPLAIN', async () => {
    const { app } = appForRun([[(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'idx plan' })]]);
    app.activeTab().sql = 'EXPLAIN indexes = 1 SELECT 1';
    await app.actions.run();
    expect(app.activeTab().result.explainView).toBe('indexes');
  });
  it('does not leak a previous rich view onto a freshly-typed plain EXPLAIN', async () => {
    const { app } = appForRun([[(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'digraph{}' })]]);
    app.activeTab().sql = 'EXPLAIN PIPELINE graph = 1 SELECT 1';
    await app.actions.run();
    expect(app.activeTab().result.explainView).toBe('pipeline');
    app.activeTab().sql = 'EXPLAIN SELECT 2'; // plain → must show the plan, not pipeline
    await app.actions.run();
    expect(app.activeTab().result.explainView).toBe('explain');
  });
  it('setExplainView re-runs a derived query and never edits the SQL', async () => {
    const { app, e } = appForRun([[(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'digraph{}' })]]);
    app.activeTab().sql = 'EXPLAIN SELECT 1';
    await app.actions.run();
    await app.actions.setExplainView('pipeline');
    expect(app.activeTab().sql).toBe('EXPLAIN SELECT 1'); // editor untouched
    expect(app.activeTab().result.explainView).toBe('pipeline');
    expect(sentExplains(e)).toContain('EXPLAIN PIPELINE graph = 1 SELECT 1');
  });
  it('the Explain button explains a plain SELECT (wraps it, editor untouched)', async () => {
    const { app, e } = appForRun([[(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'plan' })]]);
    app.activeTab().sql = 'SELECT 1';
    await app.actions.explainQuery();
    expect(app.activeTab().sql).toBe('SELECT 1'); // editor untouched
    expect(app.activeTab().result.explainView).toBe('explain');
    expect(sentExplains(e)).toContain('EXPLAIN SELECT 1');
  });
  it('Explain on a multi-statement script shows a message and sends no EXPLAIN', async () => {
    const { app, e } = appForRun([[(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'plan' })]]);
    app.activeTab().sql = 'SELECT 1; SELECT 2';
    await app.actions.explainQuery();
    expect(document.querySelector('.share-toast').textContent).toMatch(/multi-statement/);
    expect(sentExplains(e)).toHaveLength(0); // nothing sent to ClickHouse
    expect(app.activeTab().result).toBeNull();
  });
  it('setExplainView on a multi-statement script is also blocked', async () => {
    const { app, e } = appForRun([[(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'plan' })]]);
    app.activeTab().sql = 'SELECT 1; SELECT 2';
    await app.actions.setExplainView('pipeline');
    expect(document.querySelector('.share-toast').textContent).toMatch(/multi-statement/);
    expect(sentExplains(e)).toHaveLength(0);
  });
  it('runs ESTIMATE as a structured table (streaming), not raw', async () => {
    const { app } = appForRun([
      [(u, sql) => /ESTIMATE/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"rows","type":"UInt64"}]}\n', '{"row":{"rows":"42"}}\n']) })],
    ]);
    app.activeTab().sql = 'EXPLAIN ESTIMATE SELECT 1';
    await app.actions.run();
    expect(app.activeTab().result.explainView).toBe('estimate');
    expect(app.activeTab().result.rows).toEqual([['42']]);
    expect(app.activeTab().result.rawText).toBeNull();
  });
  it('decorates the auto-derived Explain/Indexes queries with pretty=1, compact=1 on a >=26.3 server', async () => {
    const { app, e } = appForRun([
      [(u, sql) => /version\(\)/.test(sql), resp({ json: { data: [{ v: '26.3.1' }] } })],
      [(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'plan' })],
    ]);
    await new Promise((r) => setTimeout(r)); // let app.loadVersion() resolve
    app.activeTab().sql = 'SELECT 1';
    await app.actions.explainQuery();
    expect(sentExplains(e)).toContain('EXPLAIN pretty = 1, compact = 1 SELECT 1');
    app.activeTab().sql = 'EXPLAIN indexes = 1 SELECT 1';
    await app.actions.run();
    expect(sentExplains(e)).toContain('EXPLAIN indexes = 1, pretty = 1, compact = 1 SELECT 1');
  });
  it('never decorates a typed, verbatim EXPLAIN even on a >=26.3 server', async () => {
    const { app, e } = appForRun([
      [(u, sql) => /version\(\)/.test(sql), resp({ json: { data: [{ v: '26.3.1' }] } })],
      [(u, sql) => /EXPLAIN/.test(sql), resp({ text: 'plan' })],
    ]);
    await new Promise((r) => setTimeout(r)); // let app.loadVersion() resolve
    app.activeTab().sql = 'EXPLAIN SELECT 1';
    await app.actions.run();
    expect(sentExplains(e)).toContain('EXPLAIN SELECT 1'); // verbatim, no decoration
  });
  it('an explicit FORMAT on an EXPLAIN still wins over the raw default', async () => {
    const { app } = appForRun([
      [(u, sql) => /EXPLAIN/.test(sql), resp({ text: '{"plan":[]}' })],
    ]);
    app.activeTab().sql = 'EXPLAIN SELECT 1 FORMAT JSON';
    await app.actions.run();
    expect(app.activeTab().result.rawFormat).toBe('JSON'); // FORMAT clause, not the EXPLAIN default
  });

  // ── multiquery / run-selection (#83) ──────────────────────────────────────
  const SCRIPT = 'CREATE TABLE t (a Int8); INSERT INTO t VALUES (1); SELECT count() AS c FROM t';
  const scriptRoutes = () => [
    [(u, sql) => /CREATE TABLE t/.test(sql), resp({ text: '' })],
    [(u, sql) => /INSERT INTO t/.test(sql), resp({ text: '' })],
    [(u, sql) => /SELECT count/.test(sql), resp({ text: JSON.stringify({ meta: [{ name: 'c', type: 'UInt64' }], data: [['1']] }) })],
  ];

  it('runs a ;-separated script sequentially, one summary row per statement, and records one history entry', async () => {
    const { app } = appForRun(scriptRoutes());
    app.state.sidePanel.value = 'history'; // exercise the history repaint in the finally
    app.activeTab().sql = SCRIPT;
    await app.actions.run();
    const script = app.activeTab().result.script;
    expect(script.map((e) => e.status)).toEqual(['ok', 'ok', 'rows']);
    expect(script[2]).toMatchObject({ preview: '1', columns: [{ name: 'c', type: 'UInt64' }], rows: [['1']] });
    expect(script.every((e) => typeof e.ms === 'number')).toBe(true); // per-statement time recorded
    expect(app.state.history).toHaveLength(1);
    expect(app.state.history[0].sql).toBe(SCRIPT);
    // SELECT statements are sent with the JSONCompact + row-cap params
    // (over-fetched by one past the display cap to detect truncation).
    const urls = app.chCtx.fetch.mock.calls.map((c) => c[0]);
    const selUrl = urls.find((u) => /max_result_rows=101/.test(u));
    expect(selUrl).toMatch(/result_overflow_mode=break/);
    // this script needs no session (permanent table) → session-less (no race)
    expect(urls.some((u) => /session_id=/.test(u))).toBe(false);
  });
  it('refreshes the schema once a script contains a schema-mutating statement that actually ran (#diagnose-db-creation)', async () => {
    const { app } = appForRun(scriptRoutes());
    await new Promise((r) => setTimeout(r)); // let the initial-mount loadSchema settle
    const spy = vi.spyOn(app, 'loadSchema');
    app.activeTab().sql = SCRIPT; // CREATE TABLE t; INSERT …; SELECT …
    await app.actions.run();
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('still refreshes the schema when a later statement fails — the DDL already ran server-side', async () => {
    const { app } = appForRun([
      [(u, sql) => /CREATE TABLE t/.test(sql), resp({ text: '' })],
      [(u, sql) => /INSERT INTO t/.test(sql), resp({ ok: false, status: 500, text: 'DB::Exception: boom' })],
    ]);
    await new Promise((r) => setTimeout(r));
    const spy = vi.spyOn(app, 'loadSchema');
    app.activeTab().sql = SCRIPT;
    await app.actions.run();
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('does not refresh the schema for a script with no schema-mutating statement', async () => {
    const { app } = appForRun([
      [(u, sql) => /SELECT/.test(sql), resp({ text: JSON.stringify({ meta: [{ name: 'n', type: 'Int' }], data: [['1']] }) })],
    ]);
    await new Promise((r) => setTimeout(r));
    const spy = vi.spyOn(app, 'loadSchema');
    app.activeTab().sql = 'SELECT 1; SELECT 2';
    await app.actions.run();
    expect(spy).not.toHaveBeenCalled();
  });
  it('a script with CREATE TEMPORARY / SET shares one session across all its statements', async () => {
    const { app } = appForRun([
      [(u, sql) => /TEMPORARY/.test(sql), resp({ text: '' })],
      [(u, sql) => /INSERT INTO t/.test(sql), resp({ text: '' })],
      [(u, sql) => /SELECT \* FROM t/.test(sql), resp({ text: JSON.stringify({ meta: [{ name: 'a', type: 'Int8' }], data: [['1']] }) })],
    ]);
    app.activeTab().sql = 'CREATE TEMPORARY TABLE t (a Int8); INSERT INTO t VALUES (1); SELECT * FROM t';
    await app.actions.run();
    const sids = app.chCtx.fetch.mock.calls.map((c) => c[0]).filter((u) => /session_id=/.test(u)).map((u) => /session_id=([^&]+)/.exec(u)[1]);
    expect(sids).toHaveLength(3); // all three statements carry the session
    expect(new Set(sids).size).toBe(1); // and it's the same one (temp table persists)
  });

  it('flags a SELECT as truncated when more than the cap rows come back', async () => {
    const data = Array.from({ length: 101 }, (_, i) => [String(i)]);
    const { app } = appForRun([
      [(u, sql) => /SELECT/.test(sql), resp({ text: JSON.stringify({ meta: [{ name: 'n', type: 'Int' }], data }) })],
    ]);
    app.activeTab().sql = 'SELECT 1; SELECT 2'; // two statements → script mode
    await app.actions.run();
    const last = app.activeTab().result.script[1];
    expect(last.rows).toHaveLength(100); // displayed cap
    expect(last.truncated).toBe(true);
  });

  it('a comment-only selection is a no-op (nothing is sent)', async () => {
    const { app } = appForRun([]);
    app.editor.replaceDocument('-- just a note');
    app.dom.editorView.dispatch({ selection: { anchor: 0, head: app.editor.getValue().length } });
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run();
    expect(app.activeTab().result).toBeNull(); // no run started
    // the comment text was never POSTed to ClickHouse
    expect(app.chCtx.fetch.mock.calls.some((c) => /just a note/.test(c[1] && c[1].body))).toBe(false);
  });

  it('copyResult treats a script result as non-exportable (no throw)', async () => {
    const { app } = appForRun(scriptRoutes());
    app.activeTab().sql = SCRIPT;
    await app.actions.run();
    expect(app.activeTab().result.script).toHaveLength(3);
    expect(() => app.actions.copyResult()).not.toThrow();
  });

  it('stops on the first failing statement and skips the rest (no history)', async () => {
    const { app } = appForRun([
      [(u, sql) => /CREATE TABLE t/.test(sql), resp({ text: '' })],
      [(u, sql) => /INSERT INTO t/.test(sql), resp({ ok: false, status: 500, text: 'DB::Exception: boom' })],
    ]);
    app.activeTab().sql = SCRIPT;
    await app.actions.run();
    const script = app.activeTab().result.script;
    expect(script).toHaveLength(2); // CREATE ok, INSERT error; SELECT never run
    expect(script[1]).toMatchObject({ status: 'error' });
    expect(script[1].error).toMatch(/boom/);
    expect(app.state.history).toHaveLength(0);
  });

  it('reports a connection reset (TypeError) on a non-idempotent statement without retrying it', async () => {
    const { app } = appForRun([
      [(u, sql) => /CREATE TABLE t/.test(sql), () => { throw new TypeError('fetch failed'); }],
    ]);
    app.activeTab().sql = SCRIPT;
    await app.actions.run();
    expect(app.activeTab().result.script[0]).toMatchObject({ status: 'error' });
    expect(app.activeTab().result.script[0].error).toMatch(/may have executed/);
  });

  it('surfaces a non-abort thrown error message per statement', async () => {
    const { app } = appForRun([
      [(u, sql) => /CREATE TABLE t/.test(sql), () => { throw new Error('kaput'); }],
    ]);
    app.activeTab().sql = SCRIPT;
    await app.actions.run();
    expect(app.activeTab().result.script[0]).toMatchObject({ status: 'error', error: 'kaput' });
  });

  it('aborts mid-script: marks the result cancelled and records no history', async () => {
    const { app } = appForRun([
      [(u, sql) => /CREATE TABLE t/.test(sql), resp({ text: '' })],
      [(u, sql) => /INSERT INTO t/.test(sql), () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }],
    ]);
    app.activeTab().sql = SCRIPT;
    await app.actions.run();
    expect(app.activeTab().result.cancelled).toBe(true);
    expect(app.activeTab().result.script).toHaveLength(1); // CREATE ran; INSERT aborted before pushing
    expect(app.state.history).toHaveLength(0);
  });

  it('retries a READ-ONLY statement once on a transient connection reset (Network error → success)', async () => {
    let sel = 0;
    const { app } = appForRun([
      [(u, sql) => /CREATE TABLE t/.test(sql), resp({ text: '' })],
      [(u, sql) => /INSERT INTO t/.test(sql), resp({ text: '' })],
      // the SELECT (idempotent) resets once, then the retry succeeds
      [(u, sql) => /SELECT count/.test(sql), () => { if (sel++ === 0) throw new TypeError('Failed to fetch'); return resp({ text: JSON.stringify({ meta: [{ name: 'c', type: 'UInt64' }], data: [['1']] }) }); }],
    ]);
    app.activeTab().sql = SCRIPT;
    await app.actions.run();
    expect(sel).toBe(2); // retried the SELECT
    expect(app.activeTab().result.script.map((e) => e.status)).toEqual(['ok', 'ok', 'rows']); // recovered
  });

  it('does NOT retry a non-idempotent statement on a connection reset (surfaces "may have executed")', async () => {
    let inserts = 0;
    const { app } = appForRun([
      [(u, sql) => /CREATE TABLE t/.test(sql), resp({ text: '' })],
      [(u, sql) => /INSERT INTO t/.test(sql), () => { inserts++; throw new TypeError('Failed to fetch'); }],
    ]);
    app.activeTab().sql = SCRIPT;
    await app.actions.run();
    expect(inserts).toBe(1); // the INSERT is NOT re-sent — it may have run server-side
    expect(app.activeTab().result.script[1]).toMatchObject({ status: 'error' });
    expect(app.activeTab().result.script[1].error).toMatch(/may have executed/);
  });

  it('retries a statement once when the ClickHouse session is briefly locked', async () => {
    let n = 0;
    const locked = '{"exception":"Code: 373. DB::Exception: Session abc is locked by a concurrent client. (SESSION_IS_LOCKED)"}';
    const { app } = appForRun([
      [(u, sql) => /CREATE TABLE t/.test(sql), () => (n++ === 0 ? resp({ ok: false, status: 500, text: locked }) : resp({ text: '' }))],
      [(u, sql) => /INSERT INTO t/.test(sql), resp({ text: '' })],
      [(u, sql) => /SELECT count/.test(sql), resp({ text: JSON.stringify({ meta: [{ name: 'c', type: 'UInt64' }], data: [['1']] }) })],
    ]);
    app.activeTab().sql = SCRIPT;
    await app.actions.run();
    expect(n).toBe(2); // retried past the transient lock
    expect(app.activeTab().result.script[0].status).toBe('ok');
  });

  it('does not retry a genuine query error (stops on the first failure)', async () => {
    let inserts = 0;
    const { app } = appForRun([
      [(u, sql) => /CREATE TABLE t/.test(sql), resp({ text: '' })],
      [(u, sql) => /INSERT INTO t/.test(sql), () => { inserts++; return resp({ ok: false, status: 400, text: '{"exception":"DB::Exception: bad value"}' }); }],
    ]);
    app.activeTab().sql = SCRIPT;
    await app.actions.run();
    expect(inserts).toBe(1); // no retry for a non-transient error
    expect(app.activeTab().result.script[1]).toMatchObject({ status: 'error' });
  });

  it('session_id falls back to a unique non-UUID id without crypto.randomUUID', async () => {
    const noUuid = { getRandomValues: (a) => webcrypto.getRandomValues(a) }; // non-secure context: no randomUUID
    const { app } = appForRun([[() => true, resp({ body: streamBody(['{"row":{}}\n']) })]], { crypto: noUuid });
    app.activeTab().sql = 'SET max_threads = 1'; // SET opens a session, so a session_id is sent
    await app.actions.run();
    const url = app.chCtx.fetch.mock.calls.map((c) => c[0]).find((u) => /session_id=/.test(u));
    expect(decodeURIComponent(/session_id=([^&]+)/.exec(url)[1])).toMatch(/^sess-/); // collision-resistant fallback
  });

  it('run-selection: a non-empty selection runs only the selected statement (rich path) and records that text', async () => {
    const { app } = appForRun([
      [(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })],
    ]);
    app.editor.replaceDocument('SELECT 1; SELECT 2');
    app.dom.editorView.dispatch({ selection: { anchor: 0, head: 8 } }); // "SELECT 1"
    await app.actions.run();
    expect(app.activeTab().result.rows).toEqual([['1']]); // single-statement rich path, not the script grid
    expect(app.activeTab().result.script).toBeUndefined();
    expect(app.state.history[0].sql).toBe('SELECT 1'); // the selection, not the whole editor
  });

  it('runEntry while already running is a no-op', async () => {
    const { app } = appForRun([]);
    app.state.running.value = true;
    app.activeTab().sql = SCRIPT;
    await app.actions.run();
    expect(app.activeTab().result).toBeNull();
  });

  it('a signed-out script run hits onSignedOut and produces no result', async () => {
    const app = createApp(env({ sessionStorage: memSession({}) }));
    app.renderApp();
    app.activeTab().sql = SCRIPT;
    await app.actions.run();
    expect(app.activeTab().result).toBeNull(); // returns before building the grid
  });

  it('syncSelection drives hasSelection; setRunBtn flips to "Run selection"', () => {
    const { app } = appForRun([]);
    let focused = true;
    let sel = { start: 0, end: 8, text: 'SELECT 1' };
    app.editor = { ...app.editor, hasFocus: () => focused, getSelection: () => sel };
    app.syncSelection();
    expect(app.state.hasSelection.value).toBe(true);
    app.setRunBtn(false);
    expect(app.dom.runBtn.textContent).toContain('Run selection');
    // collapsed selection → false; unfocused editor → false
    sel = { start: 0, end: 0, text: '' };
    app.syncSelection();
    expect(app.state.hasSelection.value).toBe(false);
    sel = { start: 0, end: 8, text: 'SELECT 1' };
    focused = false;
    app.syncSelection();
    expect(app.state.hasSelection.value).toBe(false);
  });

  // ── result-row cap (#86) ──────────────────────────────────────────────────
  const runUrl = (e, re) => e.fetch.mock.calls.findLast((c) => re.test((c[1] && c[1].body) || ''))[0];
  it('caps a normal SELECT server-side and trims block-boundary overage (flagging capped)', async () => {
    const { app, e } = appForRun([
      [(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody([
        '{"meta":[{"name":"a","type":"UInt8"}]}\n',
        '{"row":{"a":"1"}}\n', '{"row":{"a":"2"}}\n', '{"row":{"a":"3"}}\n', // overage past the cap of 2
      ]) })],
    ]);
    app.state.resultRowLimit = 2;
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run();
    const url = runUrl(e, /SELECT 1/);
    expect(url).toContain('max_result_rows=2');
    expect(url).toContain('result_overflow_mode=break');
    expect(app.activeTab().result.rows).toEqual([['1'], ['2']]); // overage trimmed client-side
    expect(app.activeTab().result.capped).toBe(true);
  });
  it('does not cap EXPLAIN/ESTIMATE runs even though ESTIMATE streams as Table', async () => {
    const { app, e } = appForRun([
      [(u, sql) => /ESTIMATE/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"rows","type":"UInt64"}]}\n', '{"row":{"rows":"42"}}\n']) })],
    ]);
    app.state.resultRowLimit = 100;
    app.activeTab().sql = 'EXPLAIN ESTIMATE SELECT 1';
    await app.actions.run();
    expect(runUrl(e, /ESTIMATE/)).not.toContain('max_result_rows');
    expect(app.activeTab().result.capped).toBe(false);
  });
  it('setResultRowLimit persists the normalized preference and re-runs with the new cap', async () => {
    // Route the app's localStorage seam through an in-memory stub so the
    // persistence assertion below doesn't touch the host runtime's native Web
    // Storage (broken under Node 25 without --localstorage-file — issue #130).
    vi.stubGlobal('localStorage', memStore());
    const { app, e } = appForRun([
      [(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })],
    ]);
    app.activeTab().sql = 'SELECT 1';
    await app.actions.setResultRowLimit(99); // not an option → snaps back to the default 500
    expect(app.state.resultRowLimit).toBe(500);
    expect(globalThis.localStorage.getItem('asb:resultRowLimit')).toBe('500');
    await app.actions.setResultRowLimit(1000);
    expect(app.state.resultRowLimit).toBe(1000);
    expect(runUrl(e, /SELECT 1/)).toContain('max_result_rows=1000'); // re-ran with the new cap
  });

  it('run(): the args snapshot is captured at wave start — a var edit during the auth awaits does not change the sent params (review F6)', async () => {
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    app.activeTab().sql = 'SELECT {id:String}';
    app.state.varValues = { id: 'first' };
    const p = app.actions.run(); // runs synchronously through the gate + capture, suspends at ensureConfig/getToken
    app.state.varValues.id = 'second'; // the mid-await edit — must apply to the NEXT run only
    await p;
    const urls = app.chCtx.fetch.mock.calls.map(([url]) => url);
    expect(urls.some((u) => /param_id=first/.test(u))).toBe(true); // the gate-time snapshot was sent
    expect(urls.some((u) => /param_id=second/.test(u))).toBe(false);
  });

  describe('enum variables (#172)', () => {
    const ENUM_TYPE = "Enum8('active' = 1, 'deleted' = 2, 'banned' = 3)";
    it('v1: a declared Enum8 variable renders a dropdown of its members', () => {
      const { app } = appForRun([]);
      app.activeTab().sql = `SELECT * FROM t WHERE status = {status:${ENUM_TYPE}}`;
      app.renderVarStrip();
      const input = app.dom.varStrip.querySelector('.var-input');
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      const opts = [...app.dom.varStrip.querySelectorAll('[role="option"]')].map((o) => o.textContent);
      expect(opts).toEqual(['active', 'deleted', 'banned']);
    });
    it('v1: a non-member value is gated inline (blocking — the declared type is a real Enum)', () => {
      const { app } = appForRun([]);
      app.activeTab().sql = `SELECT * FROM t WHERE status = {status:${ENUM_TYPE}}`;
      app.renderVarStrip();
      const input = app.dom.varStrip.querySelector('.var-input');
      input.value = 'nope';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      expect(app.dom.runBtn.disabled).toBe(true);
      expect(input.classList.contains('is-invalid')).toBe(true);
      expect(input.title).toMatch(/Expected one of: 'active', 'deleted', 'banned'/);
    });
    it('v1: a bare numeric code matching a declared code passes (live-server fact)', () => {
      const { app } = appForRun([]);
      app.activeTab().sql = `SELECT * FROM t WHERE status = {status:${ENUM_TYPE}}`;
      app.renderVarStrip();
      const input = app.dom.varStrip.querySelector('.var-input');
      input.value = '2';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      expect(app.dom.runBtn.disabled).toBe(false);
      expect(input.classList.contains('is-invalid')).toBe(false);
    });
    it('v2: a String var compared to a column not yet loaded stays a plain input (no dropdown, no recents recorded)', () => {
      const { app } = appForRun([]);
      app.state.schema.value = [{ db: 'd', tables: [{ name: 'events', columns: null }] }];
      app.activeTab().sql = 'SELECT * FROM events WHERE status = {s:String}';
      app.renderVarStrip();
      const input = app.dom.varStrip.querySelector('.var-input');
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      expect(app.dom.varStrip.querySelectorAll('[role="option"]')).toHaveLength(0);
    });
    it('v2: the dropdown appears once the idle-tick loader caches the compared column as an Enum — zero new queries beyond the one column load', async () => {
      const { app } = appForRun([
        [(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [{ name: 'status', type: ENUM_TYPE, comment: '' }] } })],
      ]);
      app.state.schema.value = [{ db: 'd', tables: [{ name: 'events', columns: null }] }];
      app.activeTab().sql = 'SELECT * FROM events WHERE status = {s:String}';
      app.renderVarStrip();
      let input = app.dom.varStrip.querySelector('.var-input');
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      expect(app.dom.varStrip.querySelectorAll('[role="option"]')).toHaveLength(0); // not loaded yet
      await app.actions.loadColumns('d', 'events'); // the CM6 adapter's idle-tick load, or a schema-panel expand
      // The strip's own signature guard folds in each var's resolved enum
      // options (not just name/type/optional) — the {name:Type} SET itself
      // never changed, only the schema cache did, and the field still upgrades.
      input = app.dom.varStrip.querySelector('.var-input');
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      const opts = [...app.dom.varStrip.querySelectorAll('[role="option"]')].map((o) => o.textContent);
      expect(opts).toEqual(['active', 'deleted', 'banned']);
    });
    it('v2: a non-member value still executes (suggestion-only — the declared type stays String)', async () => {
      const { app } = appForRun([
        [(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [{ name: 'status', type: ENUM_TYPE, comment: '' }] } })],
        [(u, sql) => /SELECT \* FROM events/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })],
      ]);
      app.state.schema.value = [{ db: 'd', tables: [{ name: 'events', columns: null }] }];
      app.activeTab().sql = 'SELECT * FROM events WHERE status = {s:String}';
      app.renderVarStrip();
      await app.actions.loadColumns('d', 'events');
      const input = app.dom.varStrip.querySelector('.var-input');
      input.value = 'not-a-member';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      expect(input.classList.contains('is-invalid')).toBe(false);
      expect(app.dom.runBtn.disabled).toBe(false);
      await app.actions.run();
      expect(app.chCtx.fetch.mock.calls.some(([url]) => /param_s=not-a-member/.test(url))).toBe(true);
    });
    it('v1: Enter with no active option (list closed) falls through to the plain hard-commit/harden path', () => {
      const { app } = appForRun([]);
      app.activeTab().sql = `SELECT * FROM t WHERE status = {status:${ENUM_TYPE}}`;
      app.renderVarStrip();
      const input = app.dom.varStrip.querySelector('.var-input');
      input.value = 'nope';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(app.dom.runBtn.disabled).toBe(true);
      expect(input.classList.contains('is-invalid')).toBe(true);
    });
    it('v1: Enter with an active option commits it via keydown (combobox delegation)', () => {
      const { app } = appForRun([]);
      app.activeTab().sql = `SELECT * FROM t WHERE status = {status:${ENUM_TYPE}}`;
      app.renderVarStrip();
      const input = app.dom.varStrip.querySelector('.var-input');
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      expect(input.value).toBe('active'); // the first member, committed
      expect(input.getAttribute('aria-expanded')).toBe('false');
    });
    it('v2: ambiguous (JOIN, unqualified column) degrades silently to a plain input', () => {
      const { app } = appForRun([]);
      app.state.schema.value = [{ db: 'd', tables: [
        { name: 'events', columns: [{ name: 'status', type: ENUM_TYPE }] },
        { name: 'other', columns: [] },
      ] }];
      app.activeTab().sql = 'SELECT * FROM events e JOIN other o ON 1=1 WHERE status = {s:String}';
      app.renderVarStrip();
      const input = app.dom.varStrip.querySelector('.var-input');
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      expect(app.dom.varStrip.querySelectorAll('[role="option"]')).toHaveLength(0);
    });
    it('v2: a background column load never steals focus mid-typing — the strip rebuild defers until blur, then applies', async () => {
      const { app } = appForRun([
        [(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [{ name: 'status', type: ENUM_TYPE, comment: '' }] } })],
      ]);
      app.state.schema.value = [{ db: 'd', tables: [{ name: 'events', columns: null }] }];
      app.activeTab().sql = 'SELECT * FROM events WHERE status = {s:String} AND r = {region:String}';
      app.renderVarStrip();
      const region = app.dom.varStrip.querySelectorAll('.var-input')[1];
      region.focus(); // real focus: sets document.activeElement AND fires the field's focus listener (dropdown opens)
      region.value = 'us-';
      region.dispatchEvent(new Event('input', { bubbles: true }));
      expect(region.getAttribute('aria-expanded')).toBe('true'); // recents dropdown open (empty is fine — it's open state that matters)
      // The background idle-tick column load completes while the user is
      // mid-typing in the UNRELATED region field: the {s} upgrade must NOT
      // rebuild the strip out from under them.
      await app.actions.loadColumns('d', 'events');
      expect(document.activeElement).toBe(region);                              // focus survived
      expect(app.dom.varStrip.querySelectorAll('.var-input')[1]).toBe(region);  // same node — no rebuild
      expect(region.value).toBe('us-');                                         // typed text survived
      expect(region.getAttribute('aria-expanded')).toBe('true');                // open dropdown survived
      // On blur (focus leaves the strip) the deferred upgrade applies: the
      // strip rebuilds and {s} now offers the schema-cache-inferred dropdown.
      region.blur();
      const rebuilt = app.dom.varStrip.querySelectorAll('.var-input');
      expect(rebuilt[1]).not.toBe(region); // strip was rebuilt after blur
      expect(rebuilt[1].value).toBe('us-'); // the typed value carried through varValues
      rebuilt[0].dispatchEvent(new Event('focus', { bubbles: true }));
      const opts = [...app.dom.varStrip.querySelectorAll('[role="option"]')].map((o) => o.textContent);
      expect(opts).toEqual(['active', 'deleted', 'banned']);
    });
    it('v2: a comparison inside a /*[ ]*/ optional block still matches — the scan runs on the analysis materialization, not the raw SQL (review F2)', () => {
      const { app } = appForRun([]);
      app.state.schema.value = [{ db: 'd', tables: [{ name: 't', columns: [{ name: 'status', type: ENUM_TYPE }] }] }];
      // In the RAW text this whole comparison is one opaque comment span.
      app.activeTab().sql = 'SELECT * FROM t WHERE 1 /*[ AND status = {s:String} ]*/';
      app.renderVarStrip();
      const input = app.dom.varStrip.querySelector('.var-input');
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      const opts = [...app.dom.varStrip.querySelectorAll('[role="option"]')].map((o) => o.textContent);
      expect(opts).toEqual(['active', 'deleted', 'banned']);
    });
    it('v2: alias-qualified + unqualified refs to the same single-table column still get the dropdown (review F3: resolved identity, not qualifier text)', () => {
      const { app } = appForRun([]);
      app.state.schema.value = [{ db: 'd', tables: [{ name: 'events', columns: [{ name: 'status', type: ENUM_TYPE }] }] }];
      app.activeTab().sql = 'SELECT * FROM events e WHERE e.status = {s:String} OR status = {s:String}';
      app.renderVarStrip();
      const input = app.dom.varStrip.querySelector('.var-input');
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      const opts = [...app.dom.varStrip.querySelectorAll('[role="option"]')].map((o) => o.textContent);
      expect(opts).toEqual(['active', 'deleted', 'banned']);
    });
    it('a type-conflicted variable renders a plain input with a visible warning — the enum control is disabled (#173 acceptance, review F1)', () => {
      const { app } = appForRun([]);
      app.activeTab().sql = `SELECT * FROM t WHERE status = {status:${ENUM_TYPE}}; SELECT {status:String}`;
      app.renderVarStrip();
      const input = app.dom.varStrip.querySelector('.var-input');
      expect(input.classList.contains('is-conflict')).toBe(true); // visible warning, distinct from is-invalid
      expect(input.classList.contains('is-invalid')).toBe(false);
      expect(input.title).toContain('Conflicting type declarations');
      expect(input.title).toContain('String');
      input.dispatchEvent(new Event('focus', { bubbles: true }));
      // No member dropdown: the field degraded to the plain (recents-only) control.
      expect(app.dom.varStrip.querySelectorAll('[role="option"]')).toHaveLength(0);
    });
    it('v2: moving focus BETWEEN strip fields keeps the deferred rebuild pending — it only applies once focus leaves the strip', async () => {
      const { app } = appForRun([
        [(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [{ name: 'status', type: ENUM_TYPE, comment: '' }] } })],
      ]);
      app.state.schema.value = [{ db: 'd', tables: [{ name: 'events', columns: null }] }];
      app.activeTab().sql = 'SELECT * FROM events WHERE status = {s:String} AND r = {region:String}';
      app.renderVarStrip();
      const inputs = app.dom.varStrip.querySelectorAll('.var-input');
      const sInput = inputs[0];
      const region = inputs[1];
      region.focus();
      await app.actions.loadColumns('d', 'events'); // deferred: focus is inside the strip
      // Tabbing from region to the s field: the focusout's relatedTarget is
      // still inside the strip, so the deferral holds — no rebuild yet.
      region.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: sInput }));
      expect(app.dom.varStrip.querySelectorAll('.var-input')[1]).toBe(region);
      // Focus finally leaves the strip → the deferred upgrade applies.
      region.blur();
      expect(app.dom.varStrip.querySelectorAll('.var-input')[1]).not.toBe(region);
    });
  });
});

describe('recent-value history (#171)', () => {
  function appForRun(routes, over) {
    const e = env({ fetch: makeFetch(routes), ...over });
    const app = createApp(e);
    app.renderApp();
    return { app, e };
  }

  it('a successful single-statement run records its boundParams (rawValue, not the resolved value)', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]], { wallNow: () => 1751200000000 });
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT {from:DateTime}';
    app.state.varValues = { from: '-1h' };
    await app.actions.run();
    expect(app.state.varRecent.byName.from.map((e) => e.value)).toEqual(['-1h']); // the expression, never the epoch timestamp
    expect(JSON.parse(globalThis.localStorage.getItem('asb:varRecent')).byName.from[0].value).toBe('-1h');
  });

  it('a failed statement records nothing', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([[() => true, resp({ ok: false, status: 500, text: 'DB::Exception: boom' })]]);
    app.activeTab().sql = 'SELECT {id:String}';
    app.state.varValues = { id: 'nope' };
    await app.actions.run();
    expect(app.state.varRecent.byName.id).toBeUndefined();
  });

  it('script (#173): statement 1 of a later-failing script records; the failing statement (and anything after it) does not', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([
      [(u, sql) => /SELECT \{a:String\}/.test(sql), resp({ text: JSON.stringify({ meta: [{ name: 'a', type: 'String' }], data: [['x']] }) })],
      [(u, sql) => /SELECT \{b:String\}/.test(sql), resp({ ok: false, status: 500, text: 'DB::Exception: boom' })],
    ]);
    app.activeTab().sql = 'SELECT {a:String}; SELECT {b:String}; SELECT {c:String}';
    app.state.varValues = { a: 'va', b: 'vb', c: 'vc' };
    await app.actions.run(); // >1 statement → runScript, stops after statement 2 fails
    expect(app.state.varRecent.byName.a.map((e) => e.value)).toEqual(['va']);
    expect(app.state.varRecent.byName.b).toBeUndefined();
    expect(app.state.varRecent.byName.c).toBeUndefined(); // never even attempted
  });

  it('a param confined to an inactive optional block is never recorded, even with a non-empty stored value (#165)', async () => {
    vi.stubGlobal('localStorage', memStore({
      'asb:varValues': JSON.stringify({ d: 'stale' }),
      'asb:filterActive': JSON.stringify({ d: false }),
    }));
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT * FROM t WHERE 1 /*[ AND d = {d:String} ]*/';
    await app.actions.run();
    expect(app.state.varRecent.byName.d).toBeUndefined();
  });

  it('an empty string is never recorded, even when actively bound (#165 allows a real empty-string bind)', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT * FROM t WHERE 1 /*[ AND d = {d:String} ]*/';
    app.state.varValues = { d: '' };
    app.state.filterActive = { d: true }; // explicitly active despite the blank value
    await app.actions.run();
    expect(app.state.varRecent.byName.d).toBeUndefined();
  });

  it('re-running a known value moves it to the front, no duplicate; caps and MRU order follow core/recent-values.js', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT {tenant:String}';
    app.state.varValues = { tenant: 'acme' };
    await app.actions.run();
    app.state.varValues = { tenant: 'other' };
    await app.actions.run();
    app.state.varValues = { tenant: 'acme' }; // re-use → move-to-front, no duplicate
    await app.actions.run();
    expect(app.state.varRecent.byName.tenant.map((e) => e.value)).toEqual(['acme', 'other']);
  });

  it('the disable-history preference stops new recording; existing history is retained', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT {id:String}';
    app.state.varValues = { id: 'first' };
    await app.actions.run();
    app.state.varRecentDisabled = true;
    app.state.varValues = { id: 'second' };
    await app.actions.run();
    expect(app.state.varRecent.byName.id.map((e) => e.value)).toEqual(['first']); // not recorded, nothing lost
  });

  it('recorded recents persist across reload (state layer round-trip, shared like varValues)', async () => {
    const store = memStore();
    vi.stubGlobal('localStorage', store);
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT {tenant:String}';
    app.state.varValues = { tenant: 'acme' };
    await app.actions.run();
    const { app: app2 } = appForRun([]); // fresh app, same localStorage — simulates a reload
    expect(app2.state.varRecent.byName.tenant.map((e) => e.value)).toEqual(['acme']);
  });

  it('the var-strip recents dropdown lists newest-first, filters as you type, click inserts and leaves the field editable', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT {tenant:String}';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    // Type each value into the real field (not a direct state write) — the
    // var-strip's own <input> DOM node is built once per {name:Type}
    // signature and only reflects state.varValues through its own typing
    // path, exactly like a real user run.
    input.value = 'acme';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await app.actions.run();
    input.value = 'other';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await app.actions.run();
    // Reopen on a blank field (a fresh look at "everything recorded so far",
    // not filtered by whatever text happens to already be in the box).
    input.value = '';
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    expect([...app.dom.varStrip.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['other', 'acme']);
    input.value = 'ac';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect([...app.dom.varStrip.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['acme']);
    const optAcme = app.dom.varStrip.querySelector('[role="option"]');
    optAcme.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(input.value).toBe('acme');
    expect(input.readOnly).toBe(false); // field stays editable — never becomes select-only
  });

  it('"Clear recent" (the dropdown footer) empties just that field\'s history', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]]);
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT {tenant:String}';
    app.state.varValues = { tenant: 'acme' };
    await app.actions.run();
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    const clearBtn = app.dom.varStrip.querySelector('button.var-combo-clear');
    clearBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(app.state.varRecent.byName.tenant).toBeUndefined();
  });

  it('a date-like field composes ONE dropdown: Recent first, then Presets (user decision, phase-7 feedback)', async () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([[(u, sql) => /SELECT/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })]], { wallNow: () => 1751200000000 });
    await new Promise((r) => setTimeout(r));
    app.chCtx.fetch.mockClear();
    app.activeTab().sql = 'SELECT {from:DateTime}';
    app.renderVarStrip();
    const input = app.dom.varStrip.querySelector('.var-input');
    input.value = '-3h'; // not one of RELATIVE_TIME_PRESETS
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await app.actions.run();
    // Reopen on a blank field so the group check isn't itself filtered by
    // whatever text happens to already be in the box.
    input.value = '';
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    const groups = [...app.dom.varStrip.querySelectorAll('.combo-group')].map((g) => g.textContent);
    expect(groups).toEqual(['Recent', 'Presets']);
    expect([...app.dom.varStrip.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toContain('-3h');
  });

  it('app.clearVarRecent clears one name and is a no-op (no re-persist) for a name with no history', () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([]);
    app.state.varRecent = { version: 1, nextSeq: 2, byName: { a: [{ value: '1', seq: 1 }] } };
    app.saveVarRecent = vi.fn(app.saveVarRecent);
    app.clearVarRecent('nope'); // no history for this name → no-op
    expect(app.state.varRecent.byName.a).toBeDefined();
    expect(app.saveVarRecent).not.toHaveBeenCalled();
    app.clearVarRecent('a');
    expect(app.state.varRecent.byName.a).toBeUndefined();
    expect(app.saveVarRecent).toHaveBeenCalledTimes(1);
  });

  it('app.clearAllVarRecent resets every name\'s history and persists', () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([]);
    app.state.varRecent = { version: 1, nextSeq: 3, byName: { a: [{ value: '1', seq: 1 }], b: [{ value: '2', seq: 2 }] } };
    app.clearAllVarRecent();
    expect(app.state.varRecent).toEqual({ version: 1, nextSeq: 1, byName: {} });
    expect(JSON.parse(globalThis.localStorage.getItem('asb:varRecent'))).toEqual({ version: 1, nextSeq: 1, byName: {} });
  });

  it('the File menu\'s "Clear all recent values" + preference toggle drive the same app seams', () => {
    vi.stubGlobal('localStorage', memStore());
    const { app } = appForRun([]);
    app.state.varRecent = recordRecent(emptyRecentMap(), 'a', '1');
    for (const node of libraryControls(app)) document.body.appendChild(node);
    openFileMenu(app);
    const checkbox = document.querySelector('.fm-checkbox');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    expect(app.state.varRecentDisabled).toBe(true);
    expect(JSON.parse(globalThis.localStorage.getItem('asb:varRecentDisabled'))).toBe(true);
    const clearAll = [...document.querySelectorAll('.fm-item')].find((b) => /Clear all recent values/.test(b.textContent));
    clearAll.dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.state.varRecent.byName.a).toBeUndefined();
    document.body.replaceChildren();
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
    // withStatementBreak appends a newline so the caret lands past the last
    // token — otherwise the replace re-opens autocomplete on it (#format bug).
    expect(app.editor.getValue()).toBe('SELECT\n  1\n');
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
  it('shows a format error persistently in the results panel and moves the caret to it', async () => {
    const { app } = appFor([
      [(u, sql) => /formatQuery/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"Code: 62. DB::Exception: Syntax error: failed at position 8 (BEWEEN): BEWEEN 2. Expected one of: BETWEEN, …. (SYNTAX_ERROR)"}' })],
    ]);
    app.activeTab().sql = 'select x BEWEEN 2';
    app.editor.replaceDocument('select x BEWEEN 2');
    await app.actions.formatQuery();
    expect(app.editor.getValue()).toBe('select x BEWEEN 2'); // editor unchanged
    const err = app.root.querySelector('.results-error');
    expect(err).not.toBeNull();
    expect(err.textContent).toContain('Code: 62. DB::Exception: Syntax error: failed at position 8 (BEWEEN): BEWEEN 2. Expected one of: BETWEEN, …. (SYNTAX_ERROR)'); // full original message, untruncated
    expect(app.dom.editorView.state.selection.main.head).toBe(7); // caret jumped to the offending token (pos 8 → offset 7)
    expect(app.activeTab().result.formatError).toBe(true);
  });
  it('a later successful format clears a prior format error', async () => {
    const { app } = appFor([
      [(u, sql) => /BEWEEN/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"Syntax error: failed at position 8 (BEWEEN): x. Expected one of: foo"}' })],
      [(u, sql) => /formatQuery/.test(sql), resp({ json: { data: [{ q: 'SELECT 1' }] } })],
    ]);
    app.activeTab().sql = 'select x BEWEEN 2';
    await app.actions.formatQuery();
    expect(app.root.querySelector('.results-error')).not.toBeNull();
    app.activeTab().sql = 'select 1'; // fixed
    await app.actions.formatQuery();
    expect(app.root.querySelector('.results-error')).toBeNull(); // error cleared
    expect(app.activeTab().result).toBeNull();
  });
  it('formats a multi-statement script one statement at a time, joined by ;<blank>', async () => {
    const { app } = appFor([
      [(u, sql) => /create table/.test(sql), resp({ json: { data: [{ q: 'CREATE TABLE t\n(\n    a Int8\n)' }] } })],
      [(u, sql) => /count/.test(sql), resp({ json: { data: [{ q: 'SELECT count()\nFROM t' }] } })],
    ]);
    app.activeTab().sql = 'create table t (a Int8); select count() from t';
    await app.actions.formatQuery();
    expect(app.editor.getValue()).toBe('CREATE TABLE t\n(\n    a Int8\n);\n\nSELECT count()\nFROM t\n');
  });
  it('multi-statement format is best-effort: an unformattable statement keeps its original text', async () => {
    const { app } = appFor([
      [(u, sql) => /create table/.test(sql), resp({ json: { data: [{ q: 'CREATE TABLE t (a Int8)' }] } })],
      [(u, sql) => /bad syntax/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"Syntax error"}' })],
    ]);
    app.activeTab().sql = 'create table t (a Int8); bad syntax here';
    await app.actions.formatQuery();
    expect(app.editor.getValue()).toContain('bad syntax here'); // original kept
    expect(app.root.querySelector('.results-error')).toBeNull(); // no scary error for the script
  });
  it('a multi-statement format clears a prior single-statement format error', async () => {
    const { app } = appFor([
      [(u, sql) => /BEWEEN/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"Syntax error: failed at position 8 (BEWEEN): x"}' })],
      [(u, sql) => /formatQuery/.test(sql), resp({ json: { data: [{ q: 'SELECT 1' }] } })],
    ]);
    app.activeTab().sql = 'select x BEWEEN 2';
    await app.actions.formatQuery();
    expect(app.root.querySelector('.results-error')).not.toBeNull();
    app.activeTab().sql = 'select 1; select 2'; // now a script
    await app.actions.formatQuery();
    expect(app.root.querySelector('.results-error')).toBeNull();
  });
  it('optional blocks (#165): a single statement with a block is skipped with a notice — no server call', async () => {
    const { app, e } = appFor([]);
    await Promise.resolve(); // let render's loadVersion/loadSchema settle
    e.fetch.mockClear();
    app.activeTab().sql = 'select 1 /*[ AND d = {d:String} ]*/';
    app.editor.replaceDocument('select 1 /*[ AND d = {d:String} ]*/');
    await app.actions.formatQuery();
    expect(e.fetch).not.toHaveBeenCalled(); // never round-tripped through formatQuery()
    expect(app.editor.getValue()).toBe('select 1 /*[ AND d = {d:String} ]*/'); // untouched
    expect(document.body.querySelector('.share-toast').textContent)
      .toContain('optional blocks — not formatted');
  });
  it('optional blocks (#165): a script formats the other statements and skips the template with a notice', async () => {
    const { app, e } = appFor([
      [(u, sql) => /formatQuery/.test(sql), resp({ json: { data: [{ q: 'SELECT 1' }] } })],
    ]);
    app.activeTab().sql = 'select 1; select 2 /*[ AND d = {d:String} ]*/';
    await app.actions.formatQuery();
    expect(app.editor.getValue()).toBe('SELECT 1;\n\nselect 2 /*[ AND d = {d:String} ]*/\n');
    expect(document.body.querySelector('.share-toast').textContent)
      .toContain('1 statement contains optional blocks — not formatted');
    // exactly one formatQuery round trip — the template statement never went out
    const fmtCalls = e.fetch.mock.calls.filter((c) => /formatQuery/.test(c[1] && c[1].body));
    expect(fmtCalls).toHaveLength(1);
    expect(fmtCalls[0][1].body).not.toContain('{d:String}');
  });
  it('setFmtBtn toggles a busy/spinner state and no-ops without the button', () => {
    const { app } = appFor([]);
    app.setFmtBtn(true);
    expect(app.dom.fmtBtn.disabled).toBe(true);
    expect(app.dom.fmtBtn.textContent).toContain('Formatting…');
    app.setFmtBtn(false);
    expect(app.dom.fmtBtn.disabled).toBe(false);
    expect(app.dom.fmtBtn.textContent).toBe('Format');
    const noRender = createApp(env()); // no renderApp → no fmtBtn
    expect(() => noRender.setFmtBtn(true)).not.toThrow();
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
    expect(app.editor.getValue()).toBe('CREATE TABLE db.t\n(\n  a Int\n)');
  });
  it('falls back to the raw DDL when formatting fails', async () => {
    const { app } = appFor([
      [(u, sql) => /SHOW CREATE/.test(sql), resp({ json: { data: [{ statement: 'CREATE TABLE db.t (a Int)' }] } })],
      [(u, sql) => /formatQuery/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"x"}' })],
    ]);
    await app.actions.insertCreate('db.t');
    expect(app.editor.getValue()).toBe('CREATE TABLE db.t (a Int)');
  });
  it('no-ops when SHOW CREATE returns no statement', async () => {
    const { app } = appFor([
      [(u, sql) => /SHOW CREATE/.test(sql), resp({ json: { data: [] } })],
    ]);
    app.editor.replaceDocument('keep');
    await app.actions.insertCreate('db.t');
    expect(app.editor.getValue()).toBe('keep');
  });
  it('surfaces a SHOW CREATE failure without changing the editor', async () => {
    const { app } = appFor([
      [(u, sql) => /SHOW CREATE/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"DB::Exception: no table"}' })],
    ]);
    app.editor.replaceDocument('keep');
    await app.actions.insertCreate('db.t');
    expect(app.editor.getValue()).toBe('keep');
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
  it('multi-IdP: login(id) selects that IdP, persists it, and uses its endpoints', async () => {
    const loc = { host: 'ch', origin: 'https://ch', pathname: '/sql', search: '', hash: '', href: 'https://ch/sql' };
    const e = env({
      location: loc,
      sessionStorage: memSession({}),
      fetch: makeFetch([
        [(u) => /config\.json/.test(u), resp({ json: { idps: [
          { id: 'google', issuer: 'https://accounts.google.com', client_id: 'g' },
          { id: 'auth0', issuer: 'https://acme.auth0.com', client_id: 'a' },
        ] } })],
        [(u) => /acme\.auth0\.com\/.well-known/.test(u), resp({ json: { authorization_endpoint: 'https://acme.auth0.com/authorize', token_endpoint: 'https://acme.auth0.com/t' } })],
        [(u) => /accounts\.google\.com\/.well-known/.test(u), resp({ json: { authorization_endpoint: 'https://accounts.google.com/auth', token_endpoint: 'https://t' } })],
      ]),
    });
    const app = createApp(e);
    expect((await app.loadIdps()).idps).toHaveLength(2);
    await app.actions.login('auth0');
    expect(loc.href).toContain('https://acme.auth0.com/authorize?');
    expect(loc.href).toContain('client_id=a');
    expect(e.sessionStorage.getItem('oauth_idp')).toBe('auth0');
    app.signOut();
    expect(e.sessionStorage.getItem('oauth_idp')).toBeNull(); // cleared on sign-out
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
  it('onSignedOut shows the given message, else a session-expired default', async () => {
    const app = createApp(env());
    app.renderApp();
    // authorization denial: CH-supplied message is shown verbatim on the login screen
    app.chCtx.onSignedOut('ClickHouse denied your account (HTTP 403). Server: nope');
    expect(app.root.querySelector('.login-error').textContent).toContain('denied your account');
    // genuine expiry: no detail → the reworded default
    app.chCtx.onSignedOut();
    expect(app.root.querySelector('.login-error').textContent).toContain('session expired');
  });
  it('login(idp, origin) stashes oauth_origin for a cross-origin cluster; sign-out clears it', async () => {
    const loc = { host: 'ch', origin: 'https://ch', pathname: '/sql', search: '', hash: '', href: 'https://ch/sql' };
    const e = env({
      location: loc,
      sessionStorage: memSession({}),
      fetch: makeFetch([
        [(u) => /config\.json/.test(u), resp({ json: { idps: [{ id: 'google', issuer: 'https://accounts.google.com', client_id: 'g' }] } })],
        [(u) => /openid-configuration/.test(u), resp({ json: { authorization_endpoint: 'https://accounts.google.com/auth', token_endpoint: 'https://t' } })],
      ]),
    });
    const app = createApp(e);
    await app.actions.login('google', 'https://antalya.demo.altinity.cloud');
    expect(e.sessionStorage.getItem('oauth_origin')).toBe('https://antalya.demo.altinity.cloud');
    app.signOut();
    expect(e.sessionStorage.getItem('oauth_origin')).toBeNull();
  });
  it('oauth mode posts queries to the stashed oauth_origin (cross-origin)', () => {
    const e = env({ sessionStorage: memSession({ oauth_id_token: validToken, oauth_origin: 'https://antalya.demo.altinity.cloud' }) });
    expect(createApp(e).chCtx.origin).toBe('https://antalya.demo.altinity.cloud');
  });
  it('header shows the picked cluster, not the serving host, for cross-origin oauth', () => {
    // Serving host is ch.example; the picked cluster is antalya on :443 (default
    // https port → URL.host drops it, so the header is the bare cluster hostname).
    const e = env({ sessionStorage: memSession({ oauth_id_token: validToken, oauth_origin: 'https://antalya.demo.altinity.cloud:443' }) });
    expect(createApp(e).host()).toBe('antalya.demo.altinity.cloud');
  });
});

describe('credentials (basic) sign-in', () => {
  const creds = btoa('demo:demo');
  const basicSession = { ch_basic_auth: creds, ch_basic_user: 'demo', ch_basic_origin: 'https://gh.example:8443' };

  it('restores a basic session from sessionStorage', () => {
    const app = createApp(env({ sessionStorage: memSession(basicSession) }));
    expect(app.authMode).toBe('basic');
    expect(app.isSignedIn()).toBe(true);
    expect(app.email()).toBe('demo');
    expect(app.host()).toBe('gh.example:8443');
    expect(app.chCtx.origin).toBe('https://gh.example:8443');
  });
  it('falls back to the serving origin when no stored target is present', () => {
    const app = createApp(env({ sessionStorage: memSession({ ch_basic_auth: creds, ch_basic_user: 'demo' }) }));
    expect(app.chCtx.origin).toBe('https://ch.example');
  });
  it('host falls back to "clickhouse" for an unparseable stored origin', () => {
    const app = createApp(env({ sessionStorage: memSession({ ...basicSession, ch_basic_origin: 'not a url' }) }));
    expect(app.host()).toBe('clickhouse');
  });
  it('basic ctx seams: getToken=creds, authHeader=Basic, refresh=false, ensureConfig=no-op', async () => {
    const app = createApp(env({ sessionStorage: memSession(basicSession) }));
    expect(await app.chCtx.getToken()).toBe(creds);
    expect(app.chCtx.authHeader(creds)).toBe('Basic ' + creds);
    expect(await app.chCtx.refresh()).toBe(false);
    expect(await app.ensureConfig()).toBeNull();
  });
  it('queries carry the Basic header to the target origin', async () => {
    const e = env({
      sessionStorage: memSession(basicSession),
      fetch: makeFetch([[(u, sql) => /version\(\)/.test(sql), resp({ json: { data: [{ v: '26.3.1' }] } })]]),
    });
    const app = createApp(e);
    await app.loadVersion();
    const [url, init] = e.fetch.mock.calls[0];
    expect(url.startsWith('https://gh.example:8443')).toBe(true);
    expect(init.headers.Authorization).toBe('Basic ' + creds);
  });
  it('connect() probes SELECT 1, commits the session, renders the app (blank host → same origin)', async () => {
    const e = env({
      sessionStorage: memSession({}),
      fetch: makeFetch([[(u, sql) => /SELECT 1/.test(sql), resp({ json: { data: [{ '1': 1 }] } })]]),
    });
    const app = createApp(e);
    expect(app.authMode).toBe('oauth');
    await app.actions.connect({ username: 'demo', password: 'demo', host: '' });
    expect(app.authMode).toBe('basic');
    expect(e.sessionStorage.getItem('ch_basic_auth')).toBe(creds);
    expect(e.sessionStorage.getItem('ch_basic_user')).toBe('demo');
    expect(e.sessionStorage.getItem('ch_basic_origin')).toBe('https://ch.example');
    expect(app.chCtx.origin).toBe('https://ch.example');
    expect(app.root.querySelector('.app-header')).not.toBeNull();
    const probe = e.fetch.mock.calls.find(([, init]) => init && init.body === 'SELECT 1');
    expect(probe[1].headers.Authorization).toBe('Basic ' + creds);
  });
  it('connect() targets a custom host via resolveTarget', async () => {
    const e = env({
      sessionStorage: memSession({}),
      fetch: makeFetch([[(u, sql) => /SELECT 1/.test(sql), resp({ json: { data: [] } })]]),
    });
    const app = createApp(e);
    await app.actions.connect({ username: 'u', password: 'p', host: 'other.example:9000' });
    expect(app.chCtx.origin).toBe('https://other.example:9000');
    expect(e.sessionStorage.getItem('ch_basic_origin')).toBe('https://other.example:9000');
  });
  it('connect() rejects on bad credentials without committing a session', async () => {
    const e = env({
      sessionStorage: memSession({}),
      fetch: makeFetch([[(u, sql) => /SELECT 1/.test(sql), resp({ ok: false, status: 403, text: 'Code: 516. Authentication failed' })]]),
    });
    const app = createApp(e);
    await expect(app.actions.connect({ username: 'demo', password: 'wrong', host: '' })).rejects.toThrow();
    expect(app.authMode).toBe('oauth');
    expect(e.sessionStorage.getItem('ch_basic_auth')).toBeNull();
  });
  it('signing out of a basic session resets mode, origin, and stored creds', () => {
    const e = env({ sessionStorage: memSession(basicSession) });
    const app = createApp(e);
    app.renderApp();
    app.signOut();
    expect(app.authMode).toBe('oauth');
    expect(app.chCtx.origin).toBe('https://ch.example');
    expect(e.sessionStorage.getItem('ch_basic_auth')).toBeNull();
    expect(app.root.querySelector('.login-screen')).not.toBeNull();
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
  it('save opens a name popover; Save commits, links the tab, and the button reads "Saved"', () => {
    const app = createApp(env());
    app.renderApp();
    app.activeTab().sql = 'SELECT 42';
    app.actions.save();
    const pop = document.querySelector('.save-popover');
    expect(pop).not.toBeNull();
    expect(pop.querySelector('.sp-input').value).toBe('SELECT 42'); // inferred name
    pop.querySelector('.sp-input').value = 'My fave';
    pop.querySelector('.sp-save').dispatchEvent(new Event('click'));
    expect(app.state.savedQueries).toHaveLength(1);
    expect(app.state.savedQueries[0]).toMatchObject({ name: 'My fave', sql: 'SELECT 42' });
    expect(app.activeTab().savedId).toBe(app.state.savedQueries[0].id);
    expect(app.dom.saveBtn.classList.contains('saved')).toBe(true);
    expect(app.dom.saveBtn.textContent).toContain('Saved');
    expect(document.querySelector('.save-popover')).toBeNull(); // closed
  });
  it('save popover: re-opening is idempotent, Esc closes, dirty edit flips "Saved"→"Save"', () => {
    const app = createApp(env());
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    app.actions.save();
    app.actions.save(); // second call no-ops while open
    expect(document.querySelectorAll('.save-popover')).toHaveLength(1);
    document.querySelector('.save-popover .sp-input').value = 'Q';
    document.querySelector('.save-popover .sp-save').dispatchEvent(new Event('click'));
    expect(app.dom.saveBtn.textContent).toContain('Saved');
    // edit → button reverts to "Save"
    app.activeTab().sql = 'SELECT 2';
    app.updateSaveBtn();
    expect(app.dom.saveBtn.classList.contains('saved')).toBe(false);
    expect(app.dom.saveBtn.textContent).toContain('Save');
    // re-open then Escape closes without saving
    app.actions.save();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.save-popover')).toBeNull();
  });
  it('save is a no-op (toast) for empty SQL', () => {
    const app = createApp(env());
    app.renderApp();
    app.activeTab().sql = '   ';
    app.actions.save();
    expect(document.querySelector('.save-popover')).toBeNull();
    expect(document.querySelector('.share-toast').textContent).toBe('Nothing to save');
  });
  it('save popover closes on click outside', () => {
    const app = createApp(env());
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    app.actions.save();
    expect(document.querySelector('.save-popover')).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.querySelector('.save-popover')).toBeNull();
  });
  it('restoring a saved query links the tab → Save button reads "Saved"', () => {
    const app = createApp(env());
    app.renderApp();
    app.state.savedQueries = [{ id: 's9', name: 'Fav', sql: 'SELECT 9', favorite: false }];
    app.actions.loadIntoNewTab('Fav', 'SELECT 9', 's9');
    expect(app.activeTab().savedId).toBe('s9');
    expect(app.dom.saveBtn.classList.contains('saved')).toBe(true);
    expect(app.dom.saveBtn.textContent).toContain('Saved');
  });
  it('save popover: prefills the linked query description; ⌘Enter on the textarea commits', () => {
    const app = createApp(env());
    app.renderApp();
    app.state.savedQueries = [{ id: 's9', name: 'Fav', sql: 'SELECT 9', favorite: false, description: 'why' }];
    app.actions.loadIntoNewTab('Fav', 'SELECT 9', 's9');
    app.actions.save();
    const desc = document.querySelector('.save-popover .sp-desc');
    expect(desc.value).toBe('why'); // prefilled from the linked entry
    desc.value = 'updated reason';
    desc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    expect(document.querySelector('.save-popover')).toBeNull(); // committed + closed
    expect(app.state.savedQueries[0].description).toBe('updated reason');
  });
  it('loadColumns fills the target table by reference, leaving siblings untouched', async () => {
    const e = env({ fetch: makeFetch([[(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [{ name: 'id', type: 'UInt64', comment: '' }] } })]]) });
    const app = createApp(e); // no renderApp → loadSchema can't clobber our seeded schema
    // Two dbs / two tables so the immutable replace exercises both ternary arms
    // (non-target db kept, non-target table kept).
    app.state.schema.value = [
      { db: 'other', tables: [{ name: 'x', columns: null }] },
      { db: 'd', tables: [{ name: 's', columns: null }, { name: 't', columns: null }] },
    ];
    await app.actions.loadColumns('d', 't');
    expect(app.state.schema.value[1].tables[1].columns).toEqual([{ name: 'id', type: 'UInt64', comment: '' }]);
    expect(app.state.schema.value[0].tables[0].columns).toBe(null); // other db untouched
    expect(app.state.schema.value[1].tables[0].columns).toBe(null); // sibling table untouched
  });
  it('loadColumns falls back to [] on error', async () => {
    const e = env({ fetch: makeFetch([[(u, sql) => /system\.columns/.test(sql), resp({ ok: false, status: 500, text: 'x' })]]) });
    const app = createApp(e);
    app.state.schema.value = [{ db: 'd', tables: [{ name: 't', columns: null }] }];
    await app.actions.loadColumns('d', 't');
    expect(app.state.schema.value[0].tables[0].columns).toEqual([]);
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
    app.root.querySelector('.hd-btn[title^="Keyboard"]').dispatchEvent(new Event('click')); // shortcuts
    app.activeTab().sql = 'SELECT 1'; // set sql on the now-active tab
    app.dom.saveBtn.dispatchEvent(new Event('click')); // open save popover
    document.querySelector('.save-popover .sp-input').value = 'Q';
    document.querySelector('.save-popover .sp-save').dispatchEvent(new Event('click')); // commit
    app.dom.shareBtn.dispatchEvent(new Event('click')); // share
    expect(app.state.tabs.value.length).toBeGreaterThan(1);
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
    // sideRow must resize the schema pane itself, not whichever element happens
    // to be the sidebar's first child (the mobile segmented control sits before
    // it in the DOM for #126) — regression guard, live bug found post-#126.
    const schemaPane = app.root.querySelector('.schema-pane');
    expect(schemaPane.style.height).toBe(app.state.sideSplitPct + '%');
    expect(app.root.querySelector('.mobile-segmented').style.height).toBe('');
  });

  it('run(): network error → "Network error"', async () => {
    const e = env({ fetch: vi.fn(async () => { throw new TypeError('net down'); }) });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run();
    expect(app.activeTab().result.error).toBe('Network error');
  });
  it('run(): AbortError marks the result cancelled (keeps partial rows, no error)', async () => {
    const e = env({ fetch: vi.fn(async () => { const err = new Error('x'); err.name = 'AbortError'; throw err; }) });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run();
    expect(app.activeTab().result.cancelled).toBe(true);
    expect(app.activeTab().result.error).toBeNull();
    expect(app.state.history.length).toBe(0); // cancelled runs are not recorded
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
    app.updateSaveBtn(); // guard: no starBtn

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
    app.state.tabs.value.push({ id: 'tx', name: 'X', sql: '', dirty: false, result: null, savedId: null });
    app.actions.selectTab('tx');
    app.actions.insertAtCursor('zz');
    app.actions.replaceEditor('SELECT 9');
    app.actions.loadIntoNewTab('n', 'SELECT 2');
    app.actions.rerenderTabs();
    app.actions.rerenderResults();
    app.actions.updateSaveBtn();
    app.actions.closeTab(app.state.activeTabId.value);
    expect(app.state.tabs.value.length).toBeGreaterThan(0);
  });

  it('share / toggleSaved tolerate empty SQL; share with no navigator at all', () => {
    const e = env({ window: { history: { replaceState: vi.fn() }, navigator: undefined }, navigator: undefined });
    const app = createApp(e);
    app.renderApp();
    app.activeTab().sql = ''; // empty
    app.actions.share(); // returns at !sql (covers the `|| ''` empty branch)
    app.actions.save(); // empty sql → toast, no popover
    app.activeTab().sql = 'SELECT 1';
    app.actions.share(); // no clipboard anywhere → manual toast
    expect(document.querySelector('.share-toast')).not.toBeNull();
  });

  it('schemaError stringifies a non-Error rejection', async () => {
    const e = env({ fetch: vi.fn(async () => { throw 'rawfail'; }) });
    const app = createApp(e);
    app.renderApp();
    await new Promise((r) => setTimeout(r));
    expect(app.state.schemaError.value).toBe('rawfail');
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

  it('ch_auth=basic with basic_user_claim maps the Basic username to that claim', async () => {
    const tok = jwt({ email: 'me@example.com', nickname: 'BorisT', exp: Math.floor(Date.now() / 1000) + 3600 });
    const e = env({
      window: fakeWin(),
      sessionStorage: memSession({ oauth_id_token: tok }),
      fetch: makeFetch([
        [(u) => /config\.json/.test(u), resp({ json: { issuer: 'https://accounts.google.com', client_id: 'cid', ch_auth: 'basic', basic_user_claim: 'nickname' } })],
        [(u) => /openid-configuration/.test(u), resp({ json: { authorization_endpoint: 'https://a', token_endpoint: 'https://t' } })],
        [(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"row":{}}\n']) })],
      ]),
    });
    const app = createApp(e);
    app.renderApp();
    await app.ensureConfig();
    expect(app.basicUserClaim).toBe('nickname');
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run();
    const q = e.fetch.mock.calls.find((c) => c[1] && c[1].body === 'SELECT 1');
    const auth = q[1].headers.Authorization;
    // username segment is the nickname claim, not the email
    expect(decodeURIComponent(escape(atob(auth.slice(6))))).toMatch(/^BorisT:/);
    // the header identity matches the CH user (nickname), not the email claim
    expect(app.email()).toBe('BorisT');
  });

  it('copyResult: TSV for structured, rawText as-is, nothing-to-copy when empty', async () => {
    const writeText = vi.fn(async () => {});
    const app = createApp(env({ window: fakeWin(), navigator: { clipboard: { writeText } } }));
    app.renderApp();
    app.activeTab().result = { error: null, rawText: null, columns: [{ name: 'a' }, { name: 'b' }], rows: [['1', 'x']] };
    app.actions.copyResult();
    await new Promise((r) => setTimeout(r));
    expect(writeText).toHaveBeenCalledWith('a\tb\n1\tx');
    expect(document.querySelector('.share-toast').textContent).toBe('Copied to clipboard');
    app.activeTab().result = { rawText: 'raw\tdata', rows: [] };
    app.actions.copyResult();
    expect(writeText).toHaveBeenLastCalledWith('raw\tdata');
    app.activeTab().result = null;
    app.actions.copyResult();
    expect(document.querySelector('.share-toast').textContent).toBe('Nothing to copy');
  });
  it('copyResult: no clipboard → not-supported; rejection → failed', async () => {
    const app = createApp(env({ window: fakeWin(), navigator: {} }));
    app.renderApp();
    app.activeTab().result = { columns: [{ name: 'a' }], rows: [['1']] };
    app.actions.copyResult();
    expect(document.querySelector('.share-toast').textContent).toBe('Copy not supported');
    const app2 = createApp(env({ window: fakeWin(), navigator: { clipboard: { writeText: vi.fn(async () => { throw new Error('x'); }) } } }));
    app2.renderApp();
    app2.activeTab().result = { columns: [{ name: 'a' }], rows: [['1']] };
    app2.actions.copyResult();
    await new Promise((r) => setTimeout(r));
    expect(document.querySelector('.share-toast').textContent).toBe('Copy failed');
  });
  it('downloadFile: injected env.download wins; native path uses Blob + createObjectURL + revoke', () => {
    // file-menu.js is the only remaining caller of app.downloadFile; exercise
    // both branches directly since neither is a UI-clickable action anymore.
    const download = vi.fn();
    const app = createApp(env({ window: fakeWin(), download }));
    app.renderApp();
    app.downloadFile('result.tsv', 'text/tab-separated-values', 'a\tb');
    expect(download).toHaveBeenCalledWith('result.tsv', 'text/tab-separated-values', 'a\tb');
    const createObjectURL = vi.fn(() => 'blob:u');
    const revokeObjectURL = vi.fn();
    const app2 = createApp(env({ window: { ...fakeWin(), URL: { createObjectURL, revokeObjectURL }, Blob: class { constructor(p) { this.p = p; } } } }));
    app2.renderApp();
    app2.downloadFile('result.csv', 'text/csv', 'a,b');
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:u');
  });

  it('shows and dismisses the auth-failure banner', () => {
    const app = createApp(env());
    app.renderApp();
    app.updateBanner();
    expect(app.dom.banner.style.display).toBe('none'); // no error → hidden
    app.state.schemaError.value = 'Token authentication is not configured';
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
    app.state.sidePanel.value = 'history';
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run();
    expect(app.state.history.length).toBe(1);
  });
});

describe('streaming export (issue #87)', () => {
  const TAG = 'abcdef0123456789';
  const fakeWin = () => ({ history: { replaceState: vi.fn() }, navigator: {} });

  it('canExport resolves from the injected seams; the toolbar button reflects it', () => {
    const disabled = createApp(env({ window: fakeWin() }));
    disabled.renderApp();
    expect(disabled.canExport()).toBe(false);
    expect(disabled.dom.exportBtn.classList.contains('is-disabled')).toBe(true);
    expect(disabled.dom.exportBtn.getAttribute('aria-disabled')).toBe('true');
    expect(disabled.dom.exportBtn.title).toMatch(/Chrome\/Edge/);

    const enabled = createApp(env({ window: fakeWin(), showSaveFilePicker: vi.fn(), isSecureContext: true }));
    enabled.renderApp();
    expect(enabled.canExport()).toBe(true);
    expect(enabled.dom.exportBtn.classList.contains('is-disabled')).toBe(false);
    expect(enabled.dom.exportBtn.getAttribute('aria-disabled')).toBeNull();
  });

  it('is a no-op when export is unavailable, or when one is already running', async () => {
    const showSaveFilePicker1 = vi.fn();
    const unavailable = createApp(env({ window: fakeWin(), showSaveFilePicker: null, isSecureContext: false }));
    unavailable.renderApp();
    unavailable.activeTab().sql = 'SELECT 1';
    await unavailable.actions.exportEntry();
    expect(showSaveFilePicker1).not.toHaveBeenCalled();

    const showSaveFilePicker2 = vi.fn();
    const busy = createApp(env({ window: fakeWin(), showSaveFilePicker: showSaveFilePicker2, isSecureContext: true }));
    busy.renderApp();
    busy.activeTab().sql = 'SELECT 1';
    busy.state.exporting.value = true;
    await busy.actions.exportEntry();
    expect(showSaveFilePicker2).not.toHaveBeenCalled();
  });

  it('"Nothing to export" toast when the editor is empty', async () => {
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker: vi.fn(), isSecureContext: true }));
    app.renderApp();
    app.activeTab().sql = '   ';
    await app.actions.exportEntry();
    expect(document.querySelector('.share-toast').textContent).toBe('Nothing to export');
  });

  it('query variables (#134): export is blocked when a variable is unfilled', async () => {
    const showSaveFilePicker = vi.fn();
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, isSecureContext: true }));
    app.renderApp();
    app.activeTab().sql = 'SELECT {database:String}';
    await app.actions.exportEntry();
    expect(showSaveFilePicker).not.toHaveBeenCalled();
    expect(document.querySelector('.share-toast').textContent).toContain('database');
  });

  it('query variables (#134): export sends native param_<name> args for a filled query', async () => {
    const { handle } = fakeFileHandle();
    const showSaveFilePicker = vi.fn(async () => handle);
    const EXPORT_SQL = 'SELECT {database:String}\nFORMAT TabSeparatedWithNames';
    const fetch = makeFetch([[(u, sql) => sql === EXPORT_SQL, () => resp({ body: streamBody(['x']) })]]);
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = 'SELECT {database:String}';
    app.state.varValues = { database: 'default' };
    await app.actions.exportEntry();
    const exportCall = fetch.mock.calls.find((c) => c[1] && c[1].body === EXPORT_SQL);
    expect(exportCall[0]).toMatch(/param_database=default/);
  });

  it('picker AbortError (user dismissed the dialog) is a silent no-op', async () => {
    const showSaveFilePicker = vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); });
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, isSecureContext: true }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    await app.actions.exportEntry();
    expect(document.querySelector('.share-toast')).toBeNull();
    expect(app.state.exporting.value).toBe(false);
  });

  it('a non-abort picker failure toasts "Save dialog failed"', async () => {
    const showSaveFilePicker = vi.fn(async () => { throw new Error('disk full'); });
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, isSecureContext: true }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    await app.actions.exportEntry();
    expect(document.querySelector('.share-toast').textContent).toBe('Save dialog failed: disk full');
  });

  it('signed out (no token): the picker still opens (transient activation preserved), but no query runs', async () => {
    const { handle } = fakeFileHandle();
    const showSaveFilePicker = vi.fn(async () => handle);
    const fetch = vi.fn(async () => resp({ json: { data: [] } })); // only the config-doc load, if anything
    const app = createApp(env({
      window: fakeWin(), showSaveFilePicker, isSecureContext: true, fetch, sessionStorage: memSession({}),
    }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    await app.actions.exportEntry();
    expect(showSaveFilePicker).toHaveBeenCalledTimes(1);
    expect(handle.createWritable).not.toHaveBeenCalled(); // never reached the streaming step
    expect(app.state.exporting.value).toBe(false);
  });

  it('streams a clean result to disk (default TSV) and reports completion', async () => {
    const { handle, writable, chunks } = fakeFileHandle();
    const showSaveFilePicker = vi.fn(async (opts) => { showSaveFilePicker.opts = opts; return handle; });
    const EXPORT_SQL = 'SELECT 1\nFORMAT TabSeparatedWithNames';
    const fetch = makeFetch([[(u, sql) => sql === EXPORT_SQL, () => resp({ body: streamBody(['a'.repeat(100)]) })]]);
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().name = 'My Query!';
    app.activeTab().sql = 'SELECT 1';
    await app.actions.exportEntry();
    expect(showSaveFilePicker.opts.suggestedName).toBe('My_Query.tsv');
    expect(writtenText(chunks)).toBe('a'.repeat(100));
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(writable.abort).not.toHaveBeenCalled();
    expect(document.querySelector('.share-toast').textContent).toBe('Export complete');
    expect(app.state.exporting.value).toBe(false);
    const exportCall = fetch.mock.calls.find((c) => c[1] && c[1].body === EXPORT_SQL);
    expect(exportCall[0]).toContain('default_format=TabSeparatedWithNames');
  });

  it('honors an explicit FORMAT in the query for the picker + the request', async () => {
    const { handle } = fakeFileHandle();
    const showSaveFilePicker = vi.fn(async (opts) => { showSaveFilePicker.opts = opts; return handle; });
    const EXPORT_SQL = 'SELECT 1 FORMAT JSON';
    const fetch = makeFetch([[(u, sql) => sql === EXPORT_SQL, () => resp({ body: streamBody(['[]']) })]]);
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = EXPORT_SQL;
    await app.actions.exportEntry();
    expect(showSaveFilePicker.opts.suggestedName).toMatch(/\.json$/);
    expect(showSaveFilePicker.opts.types[0].accept).toEqual({ 'application/json': ['.json'] });
    expect(fetch.mock.calls.some((c) => c[1] && c[1].body === EXPORT_SQL)).toBe(true);
  });

  it('holds back the trailing 32 KiB and streams the rest incrementally (no full buffering)', async () => {
    const { handle, writable, chunks } = fakeFileHandle();
    const showSaveFilePicker = vi.fn(async () => handle);
    const big = 'a'.repeat(40960); // > HOLDBACK (32 KiB) in a single chunk
    const EXPORT_SQL = 'SELECT 1\nFORMAT TabSeparatedWithNames';
    const fetch = makeFetch([[(u, sql) => sql === EXPORT_SQL, () => resp({ body: streamBody([big]) })]]);
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    await app.actions.exportEntry();
    // mid-loop commit (8192 = 40960 - 32768 HOLDBACK) then the EOF flush of the held-back tail.
    expect(writable.write.mock.calls.map((c) => c[0].length)).toEqual([8192, 32768]);
    expect(writtenText(chunks)).toBe(big);
    expect(writable.close).toHaveBeenCalledTimes(1);
  });

  it('excises a mid-stream exception frame — only clean bytes reach the file; reports "incomplete"', async () => {
    const { handle, writable, chunks } = fakeFileHandle();
    const showSaveFilePicker = vi.fn(async () => handle);
    const clean = 'x'.repeat(40);
    const frame = exceptionFrame(TAG, 'DB::Exception: Memory limit (total) exceeded');
    const EXPORT_SQL = 'SELECT 1\nFORMAT TabSeparatedWithNames';
    const fetch = makeFetch([[(u, sql) => sql === EXPORT_SQL,
      () => resp({ body: streamBody([clean, frame]), headers: { 'X-ClickHouse-Exception-Tag': TAG } })]]);
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    await app.actions.exportEntry();
    expect(writtenText(chunks)).toBe(clean); // the exception frame never reaches the file
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(writable.abort).not.toHaveBeenCalled();
    expect(document.querySelector('.share-toast').textContent)
      .toBe('Export incomplete — server error mid-stream: DB::Exception: Memory limit (total) exceeded');
  });

  it('a stream read failure mid-export closes (not aborts) the writable and renames it .partial', async () => {
    const { handle, writable } = fakeFileHandle('My_Query.tsv');
    const showSaveFilePicker = vi.fn(async () => handle);
    const EXPORT_SQL = 'SELECT 1\nFORMAT TabSeparatedWithNames';
    let reads = 0;
    const body = {
      getReader: () => ({
        read: async () => {
          reads += 1;
          if (reads === 1) return { done: false, value: new TextEncoder().encode('partial') };
          throw new Error('network drop');
        },
        releaseLock: () => {},
      }),
    };
    const fetch = makeFetch([[(u, sql) => sql === EXPORT_SQL, () => resp({ body })]]);
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    await app.actions.exportEntry();
    // close (not abort), so the already-committed bytes materialize under the
    // target handle instead of a hidden 0-byte .crswap orphan being left behind.
    expect(writable.abort).not.toHaveBeenCalled();
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(handle.move).toHaveBeenCalledWith('My_Query.tsv.partial');
    expect(document.querySelector('.share-toast').textContent).toBe('Export failed: network drop');
    expect(app.state.exporting.value).toBe(false);
  });

  it('falls back to leaving the plain (non-renamed) file when the handle has no move() (no File System Access API move support)', async () => {
    const { handle, writable } = fakeFileHandle();
    delete handle.move;
    const showSaveFilePicker = vi.fn(async () => handle);
    const EXPORT_SQL = 'SELECT 1\nFORMAT TabSeparatedWithNames';
    const fetch = makeFetch([[(u, sql) => sql === EXPORT_SQL, () => resp({ body: throwingBody('network drop') })]]);
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    await app.actions.exportEntry();
    expect(writable.abort).not.toHaveBeenCalled();
    expect(writable.close).toHaveBeenCalledTimes(1);
    // No TypeError from calling a missing move() — the guard held, and the
    // original "network drop" error (not a broken-guard error) is what surfaces.
    expect(document.querySelector('.share-toast').textContent).toBe('Export failed: network drop');
  });

  it('a failed move() (e.g. name collision) is swallowed — the plain file is still recoverable', async () => {
    const { handle, writable } = fakeFileHandle();
    handle.move = vi.fn(async () => { throw new Error('collision'); });
    const showSaveFilePicker = vi.fn(async () => handle);
    const EXPORT_SQL = 'SELECT 1\nFORMAT TabSeparatedWithNames';
    const fetch = makeFetch([[(u, sql) => sql === EXPORT_SQL, () => resp({ body: throwingBody('network drop') })]]);
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    await app.actions.exportEntry();
    expect(writable.abort).not.toHaveBeenCalled();
    expect(handle.move).toHaveBeenCalledTimes(1);
    // move()'s rejection is swallowed, not propagated in place of the original error.
    expect(document.querySelector('.share-toast').textContent).toBe('Export failed: network drop');
  });

  it('a pre-header (non-OK) failure toasts "Export failed" without ever opening the writable', async () => {
    const { handle } = fakeFileHandle();
    const showSaveFilePicker = vi.fn(async () => handle);
    const EXPORT_SQL = 'SELECT 1\nFORMAT TabSeparatedWithNames';
    const fetch = makeFetch([[(u, sql) => sql === EXPORT_SQL,
      () => resp({ ok: false, status: 500, text: '{"exception":"DB::Exception: nope"}' })]]);
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    await app.actions.exportEntry();
    expect(document.querySelector('.share-toast').textContent).toBe('Export failed: DB::Exception: nope');
    expect(handle.createWritable).not.toHaveBeenCalled();
    expect(app.state.exporting.value).toBe(false);
  });

  it('exporting.value is true for the duration of the run; cancel aborts the export\'s own signal + issues its own KILL QUERY', async () => {
    const EXPORT_BODY = 'SELECT 1\nFORMAT TabSeparatedWithNames';
    let resolveExportFetch;
    const fetch = vi.fn((url, init) => (init && init.body === EXPORT_BODY
      ? new Promise((res) => { resolveExportFetch = res; })
      : Promise.resolve(resp({ json: { data: [] } }))));
    const { handle } = fakeFileHandle();
    const showSaveFilePicker = vi.fn(async () => handle);
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    const pending = app.actions.exportEntry();
    await new Promise((r) => setTimeout(r)); // let the picker + export request kick off
    expect(app.state.exporting.value).toBe(true);
    const exportCall = fetch.mock.calls.find((c) => c[1] && c[1].body === EXPORT_BODY);
    expect(exportCall[1].signal.aborted).toBe(false);

    app.actions.cancelExport(); // grid run's runQueryId/abortController is untouched — this is the export's own
    expect(exportCall[1].signal.aborted).toBe(true);
    resolveExportFetch(Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    await pending;

    expect(app.state.exporting.value).toBe(false);
    expect(document.querySelector('.share-toast')).toBeNull(); // AbortError → silent
    expect(fetch.mock.calls.some((c) => c[1] && /KILL QUERY WHERE query_id = 'export-/.test(c[1].body))).toBe(true);
  });

  it('attaches the tab session_id when the tab already has an open session (e.g. after a TEMPORARY TABLE run)', async () => {
    const { handle } = fakeFileHandle();
    const showSaveFilePicker = vi.fn(async () => handle);
    const EXPORT_SQL = 'SELECT * FROM t\nFORMAT TabSeparatedWithNames';
    const fetch = makeFetch([[(u, sql) => sql === EXPORT_SQL, () => resp({ body: streamBody(['x']) })]]);
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, isSecureContext: true, fetch }));
    app.renderApp();
    const tab = app.activeTab();
    tab.chSession = 'sess-abc';
    tab.sql = 'SELECT * FROM t';
    await app.actions.exportEntry();
    const exportCall = fetch.mock.calls.find((c) => c[1] && c[1].body === EXPORT_SQL);
    expect(exportCall[0]).toContain('session_id=sess-abc');
  });

  it('suppresses the "Export failed" toast when the underlying error is "signed out" (onSignedOut already showed the login screen)', async () => {
    const { handle } = fakeFileHandle();
    const showSaveFilePicker = vi.fn(async () => handle);
    const EXPORT_SQL = 'SELECT 1\nFORMAT TabSeparatedWithNames';
    const fetch = makeFetch([[(u, sql) => sql === EXPORT_SQL, () => { throw new Error('signed out'); }]]);
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    await app.actions.exportEntry();
    expect(document.querySelector('.share-toast')).toBeNull();
    expect(app.state.exporting.value).toBe(false);
  });

  it('a second click while the save-file picker is still open is blocked (exporting flips true before the picker await)', async () => {
    let rejectPicker;
    const showSaveFilePicker = vi.fn(() => new Promise((_res, rej) => { rejectPicker = rej; }));
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, isSecureContext: true }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    const first = app.actions.exportEntry();
    await new Promise((r) => setTimeout(r)); // let the first call reach the picker await
    expect(app.state.exporting.value).toBe(true);
    await app.actions.exportEntry(); // second click: blocked by the re-entrance guard
    expect(showSaveFilePicker).toHaveBeenCalledTimes(1); // only the first call opened a picker
    rejectPicker(Object.assign(new Error('x'), { name: 'AbortError' }));
    await first;
    expect(app.state.exporting.value).toBe(false);
  });

  it('setExportBtn reflects the exporting state on the toolbar button, blocking a second click visually too', () => {
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker: vi.fn(), isSecureContext: true }));
    app.renderApp();
    expect(app.dom.exportBtn.classList.contains('is-disabled')).toBe(false);
    expect(app.dom.exportBtn.getAttribute('aria-disabled')).toBeNull();
    app.state.exporting.value = true;
    expect(app.dom.exportBtn.classList.contains('is-disabled')).toBe(true);
    expect(app.dom.exportBtn.getAttribute('aria-disabled')).toBe('true');
    expect(app.dom.exportBtn.title).toBe('Export in progress…');
    app.state.exporting.value = false;
    expect(app.dom.exportBtn.classList.contains('is-disabled')).toBe(false);
    expect(app.dom.exportBtn.getAttribute('aria-disabled')).toBeNull();
  });
});

describe('script export (issue #99)', () => {
  const TAG = 'abcdef0123456789';
  const fakeWin = () => ({ history: { replaceState: vi.fn() }, navigator: {} });

  // A fake FileSystemDirectoryHandle: getFileHandle(name) hands back a fresh
  // fakeFileHandle() and remembers it (keyed by name) for write assertions.
  function fakeDirHandle() {
    const written = new Map();
    const dir = {
      getFileHandle: vi.fn(async (name) => {
        const f = fakeFileHandle();
        written.set(name, f);
        return f.handle;
      }),
    };
    return { dir, written };
  }

  it('exportEntry dispatches by statement count: 1 → the single-file picker, N → the directory picker', async () => {
    const showSaveFilePicker = vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); });
    const showDirectoryPicker = vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); });
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, showDirectoryPicker, isSecureContext: true }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1';
    await app.actions.exportEntry();
    expect(showSaveFilePicker).toHaveBeenCalledTimes(1);
    expect(showDirectoryPicker).not.toHaveBeenCalled();

    app.activeTab().sql = 'SELECT 1;\nSELECT 2;';
    await app.actions.exportEntry();
    expect(showDirectoryPicker).toHaveBeenCalledTimes(1);
  });

  it('exportEntry exports the editor selection when non-empty, not the whole tab', async () => {
    const showSaveFilePicker = vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); });
    const showDirectoryPicker = vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); });
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker, showDirectoryPicker, isSecureContext: true }));
    app.renderApp();
    app.editor.replaceDocument('SELECT 1; SELECT 2');
    app.dom.editorView.dispatch({ selection: { anchor: 0, head: 8 } }); // "SELECT 1" — a single statement
    await app.actions.exportEntry();
    expect(showSaveFilePicker).toHaveBeenCalledTimes(1); // one selected statement → single-file path
    expect(showDirectoryPicker).not.toHaveBeenCalled();
  });

  it('exportDirect itself guards against empty input (defensive — exportEntry never sends it empty)', async () => {
    const app = createApp(env({ window: fakeWin(), showSaveFilePicker: vi.fn(), isSecureContext: true }));
    app.renderApp();
    await app.actions.exportDirect('   ');
    expect(document.querySelector('.share-toast').textContent).toBe('Nothing to export');
  });

  it('canExportScript resolves from the showDirectoryPicker seam + secure context', () => {
    const withPicker = createApp(env({ window: fakeWin(), showDirectoryPicker: vi.fn(), isSecureContext: true }));
    expect(withPicker.canExportScript()).toBe(true);
    const noPicker = createApp(env({ window: fakeWin(), showDirectoryPicker: null, isSecureContext: true }));
    expect(noPicker.canExportScript()).toBe(false);
    const insecure = createApp(env({ window: fakeWin(), showDirectoryPicker: vi.fn(), isSecureContext: false }));
    expect(insecure.canExportScript()).toBe(false);
  });

  it('toasts and never opens the directory picker when canExportScript is false', async () => {
    const app = createApp(env({ window: fakeWin(), showDirectoryPicker: null, isSecureContext: true }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1;\nSELECT 2;';
    await app.actions.exportEntry();
    expect(document.querySelector('.share-toast').textContent)
      .toBe('Script export requires Chrome/Edge directory access over HTTPS');
    expect(app.state.exporting.value).toBe(false);
  });

  it('a script with no row-returning statements toasts and never prompts for a directory', async () => {
    const showDirectoryPicker = vi.fn();
    const app = createApp(env({ window: fakeWin(), showDirectoryPicker, isSecureContext: true }));
    app.renderApp();
    app.activeTab().sql = 'CREATE TABLE t (a Int8);\nINSERT INTO t VALUES (1);';
    await app.actions.exportEntry();
    expect(showDirectoryPicker).not.toHaveBeenCalled();
    expect(document.querySelector('.share-toast').textContent)
      .toBe('Nothing to export — script has no result-producing statements.');
  });

  it('dismissing the directory picker (AbortError) is a silent no-op', async () => {
    const showDirectoryPicker = vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); });
    const app = createApp(env({ window: fakeWin(), showDirectoryPicker, isSecureContext: true }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1;\nSELECT 2;';
    await app.actions.exportEntry();
    expect(document.querySelector('.share-toast')).toBeNull();
    expect(app.state.exporting.value).toBe(false);
  });

  it('a non-abort directory picker failure toasts "Folder dialog failed"', async () => {
    const showDirectoryPicker = vi.fn(async () => { throw new Error('denied'); });
    const app = createApp(env({ window: fakeWin(), showDirectoryPicker, isSecureContext: true }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1;\nSELECT 2;';
    await app.actions.exportEntry();
    expect(document.querySelector('.share-toast').textContent).toBe('Folder dialog failed: denied');
  });

  it('the directory picker opens before ensureConfig/getToken; a signed-out tab never runs the script', async () => {
    const { dir } = fakeDirHandle();
    const showDirectoryPicker = vi.fn(async () => dir);
    const app = createApp(env({
      window: fakeWin(), showDirectoryPicker, isSecureContext: true, sessionStorage: memSession({}),
    }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1;\nSELECT 2;';
    await app.actions.exportEntry();
    expect(showDirectoryPicker).toHaveBeenCalledTimes(1); // opened despite no token
    expect(dir.getFileHandle).not.toHaveBeenCalled(); // never reached the run loop
    expect(app.state.exporting.value).toBe(false);
  });

  it('a second click while the directory picker is still open is blocked (exporting flips true before the picker await, like exportDirect)', async () => {
    let rejectPicker;
    const showDirectoryPicker = vi.fn(() => new Promise((_res, rej) => { rejectPicker = rej; }));
    const app = createApp(env({ window: fakeWin(), showDirectoryPicker, isSecureContext: true }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1;\nSELECT 2;';
    const first = app.actions.exportEntry();
    await new Promise((r) => setTimeout(r)); // let the first call reach the picker await
    expect(app.state.exporting.value).toBe(true);
    await app.actions.exportEntry(); // second click: blocked by the re-entrance guard
    expect(showDirectoryPicker).toHaveBeenCalledTimes(1); // only the first call opened a picker
    rejectPicker(Object.assign(new Error('x'), { name: 'AbortError' }));
    await first;
    expect(app.state.exporting.value).toBe(false);
  });

  it('runs statements sequentially in one shared session, effect statements logged ok with no file, rows streamed to their own file', async () => {
    const { dir, written } = fakeDirHandle();
    const showDirectoryPicker = vi.fn(async () => dir);
    const SCRIPT = 'CREATE TEMPORARY TABLE t (a Int8);\nINSERT INTO t VALUES (1);\nSELECT * FROM t';
    const fetch = makeFetch([
      [(u, sql) => sql === 'CREATE TEMPORARY TABLE t (a Int8)', () => resp({ text: '' })],
      [(u, sql) => sql === 'INSERT INTO t VALUES (1)', () => resp({ text: '' })],
      [(u, sql) => sql === 'SELECT * FROM t\nFORMAT TabSeparatedWithNames', () => resp({ body: streamBody(['1\n']) })],
    ]);
    const app = createApp(env({ window: fakeWin(), showDirectoryPicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = SCRIPT;
    await app.actions.exportEntry();
    const SCRIPT_SQLS = ['CREATE TEMPORARY TABLE t (a Int8)', 'INSERT INTO t VALUES (1)', 'SELECT * FROM t\nFORMAT TabSeparatedWithNames'];
    // renderApp's mount also fires a version/schema fetch — filter to this script's own requests.
    const calls = fetch.mock.calls.filter((c) => c[1] && SCRIPT_SQLS.includes(c[1].body));
    expect(calls.map((c) => c[1].body)).toEqual(SCRIPT_SQLS); // sequential, in order
    const sid = /session_id=([^&]+)/.exec(calls[0][0])[1];
    expect(sid).toBeTruthy();
    calls.forEach((c) => expect(c[0]).toContain('session_id=' + sid)); // one shared session

    const entries = app.activeTab().result.scriptExport;
    expect(entries.map((e) => e.status)).toEqual(['ok', 'ok', 'ok']);
    expect(entries[0].file).toBeNull();
    expect(entries[1].file).toBeNull();
    expect(entries[2].file).toBe('003-t.tsv');
    expect(dir.getFileHandle).toHaveBeenCalledTimes(1); // only the row-returning statement
    expect(written.get('003-t.tsv').writable.close).toHaveBeenCalledTimes(1);

    // metadata only — never the exported rows.
    expect(app.activeTab().result.rows).toBeUndefined();
    expect(app.activeTab().result.rawText).toBeUndefined();
    expect(app.state.exporting.value).toBe(false);
  });

  it('row-returning statements get distinct, deterministic file names', async () => {
    const { dir } = fakeDirHandle();
    const showDirectoryPicker = vi.fn(async () => dir);
    const fetch = makeFetch([
      [(u, sql) => sql === 'SELECT 1\nFORMAT TabSeparatedWithNames', () => resp({ body: streamBody(['a']) })],
      [(u, sql) => sql === 'SELECT 2\nFORMAT TabSeparatedWithNames', () => resp({ body: streamBody(['b']) })],
    ]);
    const app = createApp(env({ window: fakeWin(), showDirectoryPicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1;\nSELECT 2;';
    await app.actions.exportEntry();
    const entries = app.activeTab().result.scriptExport;
    expect(entries[0].file).toBe('001-select-1.tsv');
    expect(entries[1].file).toBe('002-select-2.tsv');
  });

  it('respects an explicit trailing FORMAT per statement', async () => {
    const { dir } = fakeDirHandle();
    const showDirectoryPicker = vi.fn(async () => dir);
    const fetch = makeFetch([
      [(u, sql) => sql === 'SELECT 1 FORMAT JSON', () => resp({ body: streamBody(['[]']) })],
      [(u, sql) => sql === 'SELECT 2\nFORMAT TabSeparatedWithNames', () => resp({ body: streamBody(['x']) })],
    ]);
    const app = createApp(env({ window: fakeWin(), showDirectoryPicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1 FORMAT JSON;\nSELECT 2;';
    await app.actions.exportEntry();
    const entries = app.activeTab().result.scriptExport;
    expect(entries[0].file).toBe('001-select-1-format-json.json');
    expect(entries[1].file).toBe('002-select-2.tsv');
  });

  it('a non-row statement error marks it failed with no file and stops the script; the rest are skipped', async () => {
    const { dir } = fakeDirHandle();
    const showDirectoryPicker = vi.fn(async () => dir);
    const fetch = makeFetch([
      [(u, sql) => sql === 'CREATE TABLE bad', () => resp({ ok: false, status: 500, text: '{"exception":"DB::Exception: table exists"}' })],
    ]);
    const app = createApp(env({ window: fakeWin(), showDirectoryPicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = 'CREATE TABLE bad;\nSELECT 1;';
    await app.actions.exportEntry();
    const entries = app.activeTab().result.scriptExport;
    expect(entries[0].status).toBe('failed');
    expect(entries[0].error).toBe('DB::Exception: table exists');
    expect(entries[0].file).toBeNull();
    expect(entries[1].status).toBe('skipped');
    expect(dir.getFileHandle).not.toHaveBeenCalled();
  });

  it('a pre-header (non-OK) export failure marks the row failed and stops; the rest are skipped', async () => {
    const { dir } = fakeDirHandle();
    const showDirectoryPicker = vi.fn(async () => dir);
    const fetch = makeFetch([
      [(u, sql) => sql === 'SELECT 1\nFORMAT TabSeparatedWithNames',
        () => resp({ ok: false, status: 500, text: '{"exception":"DB::Exception: nope"}' })],
    ]);
    const app = createApp(env({ window: fakeWin(), showDirectoryPicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1;\nSELECT 2;';
    await app.actions.exportEntry();
    const entries = app.activeTab().result.scriptExport;
    expect(entries[0].status).toBe('failed');
    expect(entries[0].error).toBe('DB::Exception: nope');
    expect(entries[1].status).toBe('skipped');
  });

  it('a mid-stream exception marks the row failed/incomplete and stops the script (regression: streamToFile\'s return must not be ignored)', async () => {
    const { dir, written } = fakeDirHandle();
    const showDirectoryPicker = vi.fn(async () => dir);
    const clean = 'x'.repeat(10);
    const frame = exceptionFrame(TAG, 'DB::Exception: Memory limit (total) exceeded');
    const fetch = makeFetch([
      [(u, sql) => sql === 'SELECT 1\nFORMAT TabSeparatedWithNames',
        () => resp({ body: streamBody([clean, frame]), headers: { 'X-ClickHouse-Exception-Tag': TAG } })],
    ]);
    const app = createApp(env({ window: fakeWin(), showDirectoryPicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1;\nSELECT 2;';
    await app.actions.exportEntry();
    const entries = app.activeTab().result.scriptExport;
    expect(entries[0].status).toBe('failed');
    expect(entries[0].error).toBe('File may be incomplete; server failed after streaming started. DB::Exception: Memory limit (total) exceeded');
    expect(writtenText(written.get('001-select-1.tsv').chunks)).toBe(clean); // the exception frame never reaches the file
    expect(entries[1].status).toBe('skipped');
  });

  it('never retries — a transient SESSION_IS_LOCKED failure is reported like any other error', async () => {
    const { dir } = fakeDirHandle();
    const showDirectoryPicker = vi.fn(async () => dir);
    const fetch = makeFetch([
      [(u, sql) => sql === 'INSERT INTO t VALUES (1)',
        () => resp({ ok: false, status: 500, text: '{"exception":"Code: 373. DB::Exception: SESSION_IS_LOCKED"}' })],
    ]);
    const app = createApp(env({ window: fakeWin(), showDirectoryPicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = 'INSERT INTO t VALUES (1);\nSELECT 1;';
    await app.actions.exportEntry();
    const insertCalls = fetch.mock.calls.filter((c) => c[1] && c[1].body === 'INSERT INTO t VALUES (1)');
    expect(insertCalls).toHaveLength(1); // no retry
    expect(app.activeTab().result.scriptExport[0].status).toBe('failed');
  });

  it('cancel aborts the active row, marks it cancelled, skips the rest, kills the active query, and keeps completed files', async () => {
    const { dir, written } = fakeDirHandle();
    const showDirectoryPicker = vi.fn(async () => dir);
    let resolveSecond;
    const fetch = makeFetch([
      [(u, sql) => sql === 'SELECT 1\nFORMAT TabSeparatedWithNames', () => resp({ body: streamBody(['a']) })],
      [(u, sql) => sql === 'SELECT 2\nFORMAT TabSeparatedWithNames', () => new Promise((res) => { resolveSecond = res; })],
    ]);
    const app = createApp(env({ window: fakeWin(), showDirectoryPicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = 'SELECT 1;\nSELECT 2;\nSELECT 3;';
    const pending = app.actions.exportEntry();
    await new Promise((r) => setTimeout(r)); // let stmt1 finish and stmt2's request kick off
    const entries = app.activeTab().result.scriptExport;
    expect(entries[0].status).toBe('ok');
    expect(entries[1].status).toBe('exporting');

    app.actions.cancelExportScript();
    resolveSecond(Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    await pending;

    expect(entries[1].status).toBe('cancelled');
    expect(entries[2].status).toBe('skipped');
    expect(fetch.mock.calls.some((c) => c[1] && /KILL QUERY WHERE query_id = 'export-/.test(c[1].body))).toBe(true);
    expect(written.get('001-select-1.tsv').writable.close).toHaveBeenCalledTimes(1); // completed file kept
    expect(app.state.exporting.value).toBe(false);
  });

  it('a cancel that arrives just after a statement completed cleanly still skips the remaining statements', async () => {
    const { dir } = fakeDirHandle();
    const showDirectoryPicker = vi.fn(async () => dir);
    let resolveFirst;
    const fetch = makeFetch([
      [(u, sql) => sql === 'CREATE TABLE t (a Int8)', () => new Promise((res) => { resolveFirst = res; })],
    ]);
    const app = createApp(env({ window: fakeWin(), showDirectoryPicker, isSecureContext: true, fetch }));
    app.renderApp();
    app.activeTab().sql = 'CREATE TABLE t (a Int8);\nSELECT 1;';
    const pending = app.actions.exportEntry();
    await new Promise((r) => setTimeout(r)); // let it reach the pending fetch for stmt1
    app.actions.cancelExportScript(); // cancel arrives while stmt1 is still in flight...
    resolveFirst(resp({ text: '' })); // ...but the request completes cleanly anyway
    await pending;
    const entries = app.activeTab().result.scriptExport;
    expect(entries[0].status).toBe('ok'); // completed before the cancel could affect it
    expect(entries[1].status).toBe('skipped'); // caught at the top of stmt2's iteration
  });

  it('refreshes the schema when an effect statement that actually ran is schema-mutating', async () => {
    const { dir } = fakeDirHandle();
    const showDirectoryPicker = vi.fn(async () => dir);
    const fetch = makeFetch([
      [(u, sql) => sql === 'CREATE TABLE t (a Int8)', () => resp({ text: '' })],
      [(u, sql) => sql === 'SELECT 1\nFORMAT TabSeparatedWithNames', () => resp({ body: streamBody(['x']) })],
    ]);
    const app = createApp(env({ window: fakeWin(), showDirectoryPicker, isSecureContext: true, fetch }));
    app.renderApp();
    await new Promise((r) => setTimeout(r)); // let the initial-mount loadSchema settle
    const spy = vi.spyOn(app, 'loadSchema');
    app.activeTab().sql = 'CREATE TABLE t (a Int8);\nSELECT 1;';
    await app.actions.exportEntry();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not refresh the schema when no statement that ran was schema-mutating', async () => {
    const { dir } = fakeDirHandle();
    const showDirectoryPicker = vi.fn(async () => dir);
    const fetch = makeFetch([
      [(u, sql) => sql === 'SELECT 1\nFORMAT TabSeparatedWithNames', () => resp({ body: streamBody(['x']) })],
      [(u, sql) => sql === 'SELECT 2\nFORMAT TabSeparatedWithNames', () => resp({ body: streamBody(['y']) })],
    ]);
    const app = createApp(env({ window: fakeWin(), showDirectoryPicker, isSecureContext: true, fetch }));
    app.renderApp();
    await new Promise((r) => setTimeout(r));
    const spy = vi.spyOn(app, 'loadSchema');
    app.activeTab().sql = 'SELECT 1;\nSELECT 2;';
    await app.actions.exportEntry();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('schema lineage graph (drag a db/table onto the results pane)', () => {
  const lineageRoutes = [
    [(u, sql) => /EXPLAIN AST/.test(sql), resp({ json: { data: [{ explain: '      TableIdentifier lin.events (alias e)' }] } })],
    [(u, sql) => /system\.dictionaries/.test(sql), resp({ json: { data: [] } })],
    [(u, sql) => /system\.tables/.test(sql), resp({ json: { data: [
      { database: 'lin', name: 'events', engine: 'MergeTree', engine_full: '', create_table_query: '', as_select: '', uuid: '', dependencies_database: ['lin'], dependencies_table: ['mv'], loading_dependencies_database: [], loading_dependencies_table: [] },
      { database: 'lin', name: 'mv', engine: 'MaterializedView', engine_full: '', create_table_query: 'CREATE MATERIALIZED VIEW lin.mv TO lin.dst AS SELECT 1 FROM lin.events', as_select: 'SELECT 1 FROM lin.events', uuid: '', dependencies_database: [], dependencies_table: [], loading_dependencies_database: [], loading_dependencies_table: [] },
      { database: 'lin', name: 'dst', engine: 'MergeTree', engine_full: '', create_table_query: '', as_select: '', uuid: '', dependencies_database: [], dependencies_table: [], loading_dependencies_database: [], loading_dependencies_table: [] },
    ] } })],
  ];
  function appForRun(routes, over) {
    const e = env({ fetch: makeFetch(routes), ...over });
    const app = createApp(e);
    app.renderApp();
    return { app, e };
  }

  it('showSchemaGraph queries system.* and sets a schemaGraph result', async () => {
    const { app } = appForRun(lineageRoutes);
    await app.actions.showSchemaGraph({ kind: 'db', db: 'lin' });
    const sg = app.activeTab().result.schemaGraph;
    expect(sg.focus).toEqual({ kind: 'db', db: 'lin' });
    const E = new Set(sg.edges.map((x) => `${x.from}>${x.to}:${x.kind}`));
    expect(E.has('lin.events>lin.mv:feeds')).toBe(true);
    expect(E.has('lin.mv>lin.dst:writes')).toBe(true);
  });

  it('a drop on the results region with the schema-graph MIME triggers showSchemaGraph', () => {
    const { app } = appForRun(lineageRoutes);
    app.actions.showSchemaGraph = vi.fn();
    const e = new Event('drop', { cancelable: true });
    e.dataTransfer = { getData: (m) => (m === 'application/x-asb-schema-graph' ? '{"kind":"table","db":"lin","table":"events"}' : '') };
    app.dom.resultsRegion.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(app.actions.showSchemaGraph).toHaveBeenCalledWith({ kind: 'table', db: 'lin', table: 'events' });
  });

  it('surfaces a load error in the results panel', async () => {
    const { app } = appForRun([[(u, sql) => /system\.tables/.test(sql), resp({ ok: false, status: 500, text: '{"exception":"DB::Exception: nope"}' })]]);
    await app.actions.showSchemaGraph({ kind: 'db', db: 'lin' });
    expect(app.activeTab().result.error).toContain('nope');
  });

  it('expandSchemaGraph loads the enriched dataset and opens a rich-card fullscreen overlay', async () => {
    const routes = [
      ...lineageRoutes,
      [(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [
        { database: 'lin', table: 'events', name: 'id', type: 'UInt64', is_in_primary_key: 1, position: 1 },
      ] } })],
      [(u, sql) => /data_skipping_indices/.test(sql), resp({ json: { data: [] } })],
    ];
    const { app } = appForRun(routes, { openWindow: () => null }); // force the in-app overlay fallback
    await app.actions.expandSchemaGraph({ kind: 'db', db: 'lin' });
    const overlay = document.body.querySelector('.graph-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector('g.eg-card')).not.toBeNull();
    expect(overlay.querySelector('text.eg-card-header').textContent).toMatch(/rows/);
    overlay.remove();
  });

  it('expandSchemaGraph guards: no db, signed-out, and a lineage failure open no overlay', async () => {
    // no focus.db → early return
    const { app } = appForRun(lineageRoutes);
    await app.actions.expandSchemaGraph({ kind: 'db' });
    expect(document.body.querySelector('.graph-overlay')).toBeNull();
    // signed out (empty session → null token) → onSignedOut + return
    const { app: app2 } = appForRun(lineageRoutes, { sessionStorage: memSession({}) });
    await app2.actions.expandSchemaGraph({ kind: 'db', db: 'lin' });
    expect(document.body.querySelector('.graph-overlay')).toBeNull();
    // lineage load fails → caught, no overlay (the inline graph would still be on screen)
    const { app: app3 } = appForRun([[(u, sql) => /system\.tables/.test(sql), resp({ ok: false, status: 500, text: 'boom' })]]);
    await app3.actions.expandSchemaGraph({ kind: 'db', db: 'lin' });
    expect(document.body.querySelector('.graph-overlay')).toBeNull();
  });

  it('openNodeDetail mounts the detail pane in the open overlay (and guards an incomplete node)', async () => {
    const { app } = appForRun(lineageRoutes, { openWindow: () => null }); // overlay fallback
    await app.actions.expandSchemaGraph({ kind: 'db', db: 'lin' });
    expect(document.body.querySelector('.graph-overlay')).not.toBeNull();
    await app.actions.openNodeDetail({ db: 'lin', name: 'events', kind: 'table' });
    expect(document.body.querySelector('.schema-detail')).not.toBeNull();
    await app.actions.openNodeDetail({ db: 'lin' }); // no name → guard returns, no throw
    document.body.querySelector('.graph-overlay').remove();
  });

  it('openNodeDetail shows a spinner immediately, then the loaded detail once the fetch resolves', async () => {
    const { app } = appForRun(lineageRoutes, { openWindow: () => null });
    await app.actions.expandSchemaGraph({ kind: 'db', db: 'lin' });
    const pending = app.actions.openNodeDetail({ db: 'lin', name: 'events', kind: 'table' });
    expect(document.body.querySelector('.schema-detail .placeholder.starting')).not.toBeNull();
    await pending;
    expect(document.body.querySelector('.schema-detail .placeholder.starting')).toBeNull();
    expect(document.body.querySelector('.schema-detail-cols')).not.toBeNull();
    document.body.querySelector('.graph-overlay').remove();
  });

  it('a stale detail fetch does not clobber a newer pane — last-clicked wins, not last-resolved (#97)', async () => {
    let resolveEvents;
    const eventsColumns = new Promise((r) => { resolveEvents = r; });
    const routes = [
      ...lineageRoutes,
      [(u, sql) => /system\.columns/.test(sql) && /table = 'events'/.test(sql), () => eventsColumns],
      [(u, sql) => /system\.columns/.test(sql) && /table = 'mv'/.test(sql), resp({ json: { data: [{ name: 'x', type: 'Int32', position: 1 }] } })],
      [(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [] } })], // card-load query (expandSchemaGraph)
      [(u, sql) => /system\.parts/.test(sql), resp({ json: { data: [] } })],
      [(u, sql) => /data_skipping_indices/.test(sql), resp({ json: { data: [] } })],
    ];
    const { app } = appForRun(routes, { openWindow: () => null });
    await app.actions.expandSchemaGraph({ kind: 'db', db: 'lin' });

    // Click table A (events) — its columns fetch hangs — then quickly click table B
    // (mv) before A resolves. B's fetch is immediate and mounts first.
    const first = app.actions.openNodeDetail({ db: 'lin', name: 'events', kind: 'table', id: 'lin.events' });
    const second = app.actions.openNodeDetail({ db: 'lin', name: 'mv', kind: 'table', id: 'lin.mv' });
    await second;
    expect(document.body.querySelector('.schema-detail-head b').textContent).toBe('lin.mv');

    // A resolves last — its stale pane mount must be dropped, not replace B's.
    resolveEvents(resp({ json: { data: [] } }));
    await first;
    expect(document.body.querySelector('.schema-detail-head b').textContent).toBe('lin.mv');
    document.body.querySelector('.graph-overlay').remove();
  });

  it('attaches a per-result savedPositions map and reuses it when the same result is re-opened', async () => {
    const routes = [
      ...lineageRoutes,
      [(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [] } })],
      [(u, sql) => /data_skipping_indices/.test(sql), resp({ json: { data: [] } })],
    ];
    const { app } = appForRun(routes, { openWindow: () => null });
    await app.actions.showSchemaGraph({ kind: 'db', db: 'lin' }); // sets result.schemaGraph
    await app.actions.expandSchemaGraph({ kind: 'db', db: 'lin' });
    const positions = app.activeTab().result.schemaGraph.savedPositions;
    expect(positions).toBeTypeOf('object');
    document.body.querySelector('.graph-overlay').remove();
    await app.actions.expandSchemaGraph({ kind: 'db', db: 'lin' });
    expect(app.activeTab().result.schemaGraph.savedPositions).toBe(positions); // same map reused
    document.body.querySelector('.graph-overlay').remove();
  });

  // #124 — stale-write race, cancellation, progressive draw.
  // Local variant of makeFetch that forwards `init` to a function route, so a
  // route can be signal-aware (reject when the request's own AbortController
  // fires) — the shared makeFetch above only ever calls `r()` with no args.
  function makeSignalFetch(routes) {
    return vi.fn(async (url, init) => {
      const sql = init && init.body;
      for (const [test, r] of routes) if (test(url, sql)) return typeof r === 'function' ? r(url, init) : r;
      return resp({ json: { data: [] } });
    });
  }
  const hangsUntilAborted = (url, init) => new Promise((resolve, reject) => {
    const abort = () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
    // Real fetch rejects immediately for an already-aborted signal — mirror that
    // (a bare addEventListener would miss an abort that fired before this request
    // was even dispatched, since the event has already come and gone).
    if (init.signal.aborted) abort();
    else init.signal.addEventListener('abort', abort);
  });
  // showSchemaGraph awaits ensureConfig()/getToken() before setting the initial
  // placeholder — poll (bounded, no real timer) rather than guessing a fixed
  // microtask-tick count.
  async function untilResult(app) {
    for (let i = 0; i < 50 && app.activeTab().result == null; i++) await Promise.resolve();
  }
  // showSchemaGraph's Phase-A/Phase-B split only engages at/above
  // AST_PROGRESSIVE_THRESHOLD view/MV objects (#124 — below it, a single-step
  // draw avoids flicker on small schemas) — pad a fixture's table list with
  // throwaway views so a specific scenario's real object(s) can still exercise
  // the two-phase path under the real (non-test-overridden) default.
  // 'SELECT pad…' (not just 'SELECT …') so a route matching a specific real
  // object's exact EXPLAIN AST text (e.g. /EXPLAIN AST SELECT 1/) never
  // accidentally also matches a padding row's.
  const paddingViews = (n) => Array.from({ length: n }, (_, i) => (
    { database: 'lin', name: 'pad' + i, engine: 'View', as_select: 'SELECT pad' + i }
  ));

  it('run() while a lineage fetch is in flight does not corrupt the query result (regression for #124)', async () => {
    let resolveTables;
    const tablesPending = new Promise((r) => { resolveTables = r; });
    const { app } = appForRun([
      [(u, sql) => /system\.tables/.test(sql), () => tablesPending],
      [(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })],
    ]);
    const graphPromise = app.actions.showSchemaGraph({ kind: 'db', db: 'lin' }); // hangs on system.tables
    await untilResult(app); // let the pre-Phase-A loading placeholder land
    expect(app.activeTab().result.schemaGraph.loading).toBe(true);
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run();
    expect(app.activeTab().result.rows).toEqual([['1']]);
    expect(app.activeTab().result.schemaGraph).toBeUndefined();
    // the stale lineage fetch resolving afterward must not clobber run()'s result
    resolveTables(resp({ json: { data: [] } }));
    await graphPromise;
    expect(app.activeTab().result.rows).toEqual([['1']]);
    expect(app.activeTab().result.schemaGraph).toBeUndefined();
  });

  it('runScript() while a lineage fetch is in flight does not corrupt the query result (regression for #124)', async () => {
    let resolveTables;
    const tablesPending = new Promise((r) => { resolveTables = r; });
    const { app } = appForRun([
      [(u, sql) => /system\.tables/.test(sql), () => tablesPending],
      [(u, sql) => /SELECT 1/.test(sql), resp({ text: JSON.stringify({ meta: [{ name: 'a', type: 'UInt8' }], data: [['1']] }) })],
    ]);
    const graphPromise = app.actions.showSchemaGraph({ kind: 'db', db: 'lin' });
    await untilResult(app);
    expect(app.activeTab().result.schemaGraph.loading).toBe(true);
    app.activeTab().sql = 'SELECT 1;\nSELECT 1'; // >1 statement → runScript path
    await app.actions.run();
    expect(app.activeTab().result.script).toBeDefined();
    expect(app.activeTab().result.schemaGraph).toBeUndefined();
    resolveTables(resp({ json: { data: [] } }));
    await graphPromise;
    expect(app.activeTab().result.script).toBeDefined();
    expect(app.activeTab().result.schemaGraph).toBeUndefined();
  });

  it('a second showSchemaGraph before the first resolves shows the second graph only — last-triggered wins, not last-resolved', async () => {
    let resolveFirst;
    const firstPending = new Promise((r) => { resolveFirst = r; });
    const { app } = appForRun([
      [(u, sql) => /system\.tables/.test(sql) && /database = 'a'/.test(sql), () => firstPending],
      [(u, sql) => /system\.tables/.test(sql) && /database = 'b'/.test(sql), resp({ json: { data: [
        { database: 'b', name: 't', engine: 'MergeTree', as_select: '' },
      ] } })],
    ]);
    const first = app.actions.showSchemaGraph({ kind: 'db', db: 'a' });
    await untilResult(app);
    const second = app.actions.showSchemaGraph({ kind: 'db', db: 'b' });
    await second;
    expect(app.activeTab().result.schemaGraph.focus.db).toBe('b');
    resolveFirst(resp({ json: { data: [{ database: 'a', name: 'x', engine: 'MergeTree', as_select: '' }] } }));
    await first;
    expect(app.activeTab().result.schemaGraph.focus.db).toBe('b'); // unchanged — a's stale resolution was dropped
  });

  it('cancelSchemaGraph aborts the in-flight fetch; Starting Run cancels it automatically with no unhandled rejection', async () => {
    const fetchImpl = makeSignalFetch([
      [(u, sql) => /system\.tables/.test(sql), hangsUntilAborted],
      [(u, sql) => /SELECT 1/.test(sql), () => resp({ body: streamBody(['{"row":{}}\n']) })],
    ]);
    const app = createApp(env({ fetch: fetchImpl }));
    app.renderApp();
    app.actions.showSchemaGraph({ kind: 'db', db: 'lin' });
    await untilResult(app);
    expect(app.activeTab().result.schemaGraph.loading).toBe(true);
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run(); // aborts the pending lineage fetch via cancelSchemaGraph() at its top
    expect(app.activeTab().result.schemaGraph).toBeUndefined(); // run()'s own result, not clobbered
  });

  it('a manual cancel keeps the Phase-A graph, marked partial, once Phase A has already drawn it', async () => {
    // Padded to AST_PROGRESSIVE_THRESHOLD objects so the two-phase path actually
    // engages under the real default (see paddingViews).
    const tables = [
      { database: 'lin', name: 'mv', engine: 'MaterializedView', as_select: 'SELECT 1 FROM lin.events', create_table_query: '' },
      ...paddingViews(AST_PROGRESSIVE_THRESHOLD - 1),
    ];
    const fetchImpl = makeSignalFetch([
      [(u, sql) => /system\.dictionaries/.test(sql), () => resp({ json: { data: [] } })],
      [(u, sql) => /system\.tables/.test(sql), () => resp({ json: { data: tables } })],
      [(u, sql) => /EXPLAIN AST/.test(sql), hangsUntilAborted],
    ]);
    const app = createApp(env({ fetch: fetchImpl }));
    app.renderApp();
    const pending = app.actions.showSchemaGraph({ kind: 'db', db: 'lin' });
    // Let Phase A land (tableCount known) while Phase B (EXPLAIN AST) hangs.
    await untilResult(app);
    for (let i = 0; i < 50 && app.activeTab().result.schemaGraph.tableCount == null; i++) await Promise.resolve();
    expect(app.activeTab().result.schemaGraph.tableCount).not.toBeNull();
    expect(app.activeTab().result.schemaGraph.nodes.length).toBeGreaterThan(0);
    app.actions.cancelSchemaGraph({ clearResult: true });
    const sg = app.activeTab().result.schemaGraph;
    expect(sg.loading).toBe(false);
    expect(sg.partial).toBe(true);
    expect(sg.nodes.length).toBeGreaterThan(0); // kept on screen, not cleared
    await pending; // the aborted EXPLAIN AST rejecting afterward must not resurrect `loading`
    expect(app.activeTab().result.schemaGraph.loading).toBe(false);
    expect(app.activeTab().result.schemaGraph.partial).toBe(true);
  });

  it('a manual cancel before Phase A has drawn anything clears the result to the empty placeholder', async () => {
    const fetchImpl = makeSignalFetch([
      [(u, sql) => /system\.tables/.test(sql), hangsUntilAborted],
    ]);
    const app = createApp(env({ fetch: fetchImpl }));
    app.renderApp();
    const pending = app.actions.showSchemaGraph({ kind: 'db', db: 'lin' });
    await untilResult(app);
    expect(app.activeTab().result.schemaGraph.loading).toBe(true);
    expect(app.activeTab().result.schemaGraph.nodes).toEqual([]);
    app.actions.cancelSchemaGraph({ clearResult: true });
    expect(app.activeTab().result).toBeNull();
    await pending;
    expect(app.activeTab().result).toBeNull(); // stays cleared — no stray write from the aborted fetch
  });

  it('draws the Phase-A graph (free edges) before EXPLAIN AST resolves, then merges in the view/MV source edges', async () => {
    let resolveAst;
    // Every EXPLAIN AST call (the real mv's and all padding views') shares this
    // one pending promise, so resolving it once releases all of them together —
    // the padding views picking up a spurious astTables entry from the shared
    // response doesn't affect the specific edges asserted below (Set#has checks).
    const astPending = new Promise((r) => { resolveAst = r; });
    const { app } = appForRun([
      [(u, sql) => /EXPLAIN AST/.test(sql), () => astPending],
      [(u, sql) => /system\.dictionaries/.test(sql), resp({ json: { data: [] } })],
      [(u, sql) => /system\.tables/.test(sql), resp({ json: { data: [
        { database: 'lin', name: 'events', engine: 'MergeTree', as_select: '' },
        { database: 'lin', name: 'mv', engine: 'MaterializedView', as_select: 'SELECT 1 FROM lin.events', create_table_query: 'CREATE MATERIALIZED VIEW lin.mv TO lin.dst AS SELECT 1 FROM lin.events' },
        { database: 'lin', name: 'dst', engine: 'MergeTree', as_select: '' },
        ...paddingViews(AST_PROGRESSIVE_THRESHOLD - 1),
      ] } })],
    ]);
    const pending = app.actions.showSchemaGraph({ kind: 'db', db: 'lin' });
    await untilResult(app);
    for (let i = 0; i < 50 && app.activeTab().result.schemaGraph.tableCount == null; i++) await Promise.resolve();
    const phaseA = app.activeTab().result.schemaGraph;
    expect(phaseA.loading).toBe(true);
    expect(phaseA.tableCount).toBe(3 + AST_PROGRESSIVE_THRESHOLD - 1);
    // Phase A already has the MV → dst "writes" edge (free, parsed from create_table_query)
    // but not yet the events → mv "feeds" edge (needs EXPLAIN AST — still pending).
    const phaseAEdges = new Set(phaseA.edges.map((e) => `${e.from}>${e.to}:${e.kind}`));
    expect(phaseAEdges.has('lin.mv>lin.dst:writes')).toBe(true);
    expect(phaseAEdges.has('lin.events>lin.mv:feeds')).toBe(false);
    resolveAst(resp({ json: { data: [{ explain: '      TableIdentifier lin.events (alias e)' }] } }));
    await pending;
    const finalSg = app.activeTab().result.schemaGraph;
    expect(finalSg.loading).toBeUndefined();
    const finalEdges = new Set(finalSg.edges.map((e) => `${e.from}>${e.to}:${e.kind}`));
    expect(finalEdges.has('lin.events>lin.mv:feeds')).toBe(true);
    expect(finalEdges.has('lin.mv>lin.dst:writes')).toBe(true);
  });

  it('reports EXPLAIN AST resolution progress on the schemaGraph as each view/MV settles', async () => {
    let resolveAstV2;
    const astV2Pending = new Promise((r) => { resolveAstV2 = r; });
    // v1 + all padding views resolve immediately; v2 alone hangs — so progress
    // should land at (padding+1)/total without waiting for the whole fetch.
    const { app } = appForRun([
      [(u, sql) => /EXPLAIN AST SELECT 2/.test(sql), () => astV2Pending],
      [(u, sql) => /EXPLAIN AST/.test(sql), resp({ json: { data: [{ explain: '' }] } })],
      [(u, sql) => /system\.dictionaries/.test(sql), resp({ json: { data: [] } })],
      [(u, sql) => /system\.tables/.test(sql), resp({ json: { data: [
        { database: 'lin', name: 'v1', engine: 'View', as_select: 'SELECT 1' },
        { database: 'lin', name: 'v2', engine: 'View', as_select: 'SELECT 2' },
        ...paddingViews(AST_PROGRESSIVE_THRESHOLD - 2),
      ] } })],
    ]);
    const pending = app.actions.showSchemaGraph({ kind: 'db', db: 'lin' });
    await untilResult(app);
    for (let i = 0; i < 50 && !app.activeTab().result.schemaGraph.progress; i++) await Promise.resolve();
    const progress = app.activeTab().result.schemaGraph.progress;
    expect(progress.total).toBe(AST_PROGRESSIVE_THRESHOLD);
    expect(progress.done).toBeGreaterThanOrEqual(1);
    expect(progress.done).toBeLessThan(AST_PROGRESSIVE_THRESHOLD); // v2 hasn't settled yet
    expect(app.activeTab().result.schemaGraph.loading).toBe(true);
    resolveAstV2(resp({ json: { data: [{ explain: '' }] } }));
    await pending;
    expect(app.activeTab().result.schemaGraph.loading).toBeUndefined();
  });
});

describe('schema graph drop edge cases', () => {
  function mk() { const app = createApp(env({ fetch: makeFetch([]) })); app.renderApp(); return app; }
  it('dragover accepts only the schema-graph MIME', () => {
    const app = mk();
    const a = new Event('dragover', { cancelable: true });
    a.dataTransfer = { types: ['application/x-asb-schema-graph'] };
    app.dom.resultsRegion.dispatchEvent(a);
    expect(a.defaultPrevented).toBe(true);
    const b = new Event('dragover', { cancelable: true });
    b.dataTransfer = { types: ['text/plain'] };
    app.dom.resultsRegion.dispatchEvent(b);
    expect(b.defaultPrevented).toBe(false);
  });
  it('drop ignores a non-schema payload and tolerates malformed JSON', () => {
    const app = mk();
    app.actions.showSchemaGraph = vi.fn();
    const none = new Event('drop', { cancelable: true });
    none.dataTransfer = { getData: () => '' };
    app.dom.resultsRegion.dispatchEvent(none);
    expect(none.defaultPrevented).toBe(false);
    const bad = new Event('drop', { cancelable: true });
    bad.dataTransfer = { getData: (m) => (m === 'application/x-asb-schema-graph' ? 'not json' : '') };
    expect(() => app.dom.resultsRegion.dispatchEvent(bad)).not.toThrow();
    expect(bad.defaultPrevented).toBe(true);
    expect(app.actions.showSchemaGraph).not.toHaveBeenCalled();
  });
});

describe('mobile best-effort mode (#126)', () => {
  // A controllable MediaQueryList stub so a test can seed `matches` and later
  // fire a `change` (simulating crossing the breakpoint / a device rotation).
  function fakeMQL(matches) {
    const listeners = [];
    return {
      matches,
      addEventListener: (_type, fn) => listeners.push(fn),
      emit(next) { this.matches = next; for (const fn of listeners) fn({ matches: next }); },
    };
  }
  function mobileApp(matches = true, routes = []) {
    const mql = fakeMQL(matches);
    const app = createApp(env({ matchMedia: () => mql, fetch: makeFetch(routes) }));
    app.renderApp();
    return { app, mql };
  }
  const nav = (app, view) => app.root.querySelector('.mobile-nav-btn[data-view="' + view + '"]');

  it('seeds isMobile and mounts the bottom nav + Tables segmented, defaulting to the Editor view', () => {
    const { app } = mobileApp(true);
    expect(app.state.isMobile.value).toBe(true);
    expect(app.root.querySelectorAll('.mobile-nav-btn')).toHaveLength(3);
    expect(app.root.querySelector('.mobile-segmented')).not.toBeNull();
    expect(app.root.querySelector('.main-row').dataset.mobileView).toBe('editor');
    expect(app.root.querySelector('.sidebar').dataset.mobileTab).toBe('schema');
  });

  it('a breakpoint change flips isMobile', () => {
    const { app, mql } = mobileApp(true);
    mql.emit(false);
    expect(app.state.isMobile.value).toBe(false);
    mql.emit(true);
    expect(app.state.isMobile.value).toBe(true);
  });

  it('bottom-nav buttons switch the full-screen view (data-mobile-view)', () => {
    const { app } = mobileApp(true);
    const mainRow = app.root.querySelector('.main-row');
    nav(app, 'tables').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.state.mobileView.value).toBe('tables');
    expect(mainRow.dataset.mobileView).toBe('tables');
    nav(app, 'results').dispatchEvent(new Event('click', { bubbles: true }));
    expect(mainRow.dataset.mobileView).toBe('results');
  });

  it('the Schema | Library segmented switches the sidebar pane (data-mobile-tab)', () => {
    const { app } = mobileApp(true);
    const sidebar = app.root.querySelector('.sidebar');
    app.root.querySelector('.mseg-btn[data-seg="library"]').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.state.mobileTab.value).toBe('library');
    expect(sidebar.dataset.mobileTab).toBe('library');
    app.root.querySelector('.mseg-btn[data-seg="schema"]').dispatchEvent(new Event('click', { bubbles: true }));
    expect(sidebar.dataset.mobileTab).toBe('schema');
  });

  it('auto-navigates: inserting into the editor → Editor, running → Results', async () => {
    const routes = [[(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })]];
    const { app } = mobileApp(true, routes);
    app.state.mobileView.value = 'tables';
    app.actions.insertAtCursor('foo');
    expect(app.state.mobileView.value).toBe('editor'); // insert jumped to Editor
    app.activeTab().sql = 'SELECT 1';
    await app.actions.run();
    expect(app.state.mobileView.value).toBe('results'); // run jumped to Results
  });

  it('loading a saved query into a tab jumps to the Editor view', () => {
    const { app } = mobileApp(true);
    app.state.mobileView.value = 'tables';
    app.actions.loadIntoNewTab('q', 'SELECT 2', null, null);
    expect(app.state.mobileView.value).toBe('editor');
  });

  it('the Results nav badge shows ● while running and the row count when idle', () => {
    const { app } = mobileApp(true);
    app.activeTab().result = { rawText: null, rows: [['1']], columns: [{ name: 'a', type: 'UInt8' }], progress: { rows: 15, bytes: 0, elapsed_ns: 0 } };
    app.state.running.value = true;
    expect(app.dom.mobileBadge.textContent).toBe('●');
    app.state.running.value = false;
    expect(app.dom.mobileBadge.textContent).toBe('15');
  });

  it('anchored popovers center horizontally on mobile instead of anchoring off-screen', () => {
    const { app } = mobileApp(true);
    app.activeTab().sql = 'SELECT 1'; // openSavePopover no-ops on empty SQL
    app.actions.save();
    const pop = document.querySelector('.save-popover');
    expect(pop).not.toBeNull();
    expect(pop.style.left).toBe('50%');
    expect(pop.style.transform).toBe('translateX(-50%)');
    expect(pop.style.right).toBe(''); // not right-anchored to the (scrolled) button
  });

  it('the results-pane schema-graph drop target is inert on mobile (drop + dragover no-op)', () => {
    const { app } = mobileApp(true);
    app.actions.showSchemaGraph = vi.fn();
    const drop = new Event('drop', { cancelable: true });
    drop.dataTransfer = { getData: () => '{"kind":"db","db":"d"}' };
    app.dom.resultsRegion.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
    expect(app.actions.showSchemaGraph).not.toHaveBeenCalled();
    const over = new Event('dragover', { cancelable: true });
    over.dataTransfer = { types: ['application/x-asb-schema-graph'] };
    app.dom.resultsRegion.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false); // guard returns before preventDefault
  });
});
