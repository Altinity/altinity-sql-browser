import { describe, it, expect, vi, beforeEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import dagre from '@dagrejs/dagre';
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
    Dagre: dagre,
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
  it('reads the ?host= URL param into app.hostHint (empty when absent)', () => {
    expect(createApp(env()).hostHint).toBe('');
    const app = createApp(env({ location: { host: 'h', origin: 'https://h', pathname: '/sql', search: '?host=antalya.demo:9000' } }));
    expect(app.hostHint).toBe('antalya.demo:9000');
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
    // user control shows the short name (local-part) + full email on hover
    expect(app.dom.userBtn.querySelector('.user-short').textContent).toBe('me');
    expect(app.dom.userBtn.getAttribute('title')).toBe('me@example.com');
    await Promise.resolve();
  });
  it('toggles theme via the header button', () => {
    const { app } = rendered();
    app.dom.themeBtn.dispatchEvent(new Event('click'));
    expect(app.state.theme).toBe('light');
    expect(app.savePref).toBeUndefined; // savePref is internal; theme attr set
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
  it('user menu: open → Log out clears tokens and shows login', () => {
    const { app, e } = rendered();
    app.dom.userBtn.dispatchEvent(new Event('click'));
    const menu = document.querySelector('.user-menu');
    expect(menu).not.toBeNull();
    expect(menu.querySelector('.um-id').textContent).toBe('me@example.com');
    menu.querySelector('.um-item.danger').dispatchEvent(new Event('click', { bubbles: true }));
    expect(app.token).toBeNull();
    expect(e.sessionStorage.getItem('oauth_id_token')).toBeNull();
    expect(app.root.querySelector('.login-screen')).not.toBeNull();
    expect(document.querySelector('.user-menu')).toBeNull(); // closed
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
    app.state.schema = [{ db: 'd', tables: [{ name: 't', columns: [{ name: 'c', type: 'UInt8' }] }] }];
    app.rebuildCompletions();
    expect(app.completions.some((c) => c.kind === 'column' && c.label === 'c' && c.parent === 't')).toBe(true);
  });
  it('loadReference tolerates being called before the editor mounts', async () => {
    const app = createApp(env()); // no renderApp → no app.dom.editorSync
    await expect(app.loadReference()).resolves.toBeUndefined();
    expect(app.refData).toBeTruthy();
  });
  it('loadColumns folds the newly-loaded columns into the completion list (#26)', async () => {
    const e = env({ fetch: makeFetch([
      [(u, sql) => /system\.columns/.test(sql), resp({ json: { data: [{ name: 'id', type: 'UInt64', comment: '' }] } })],
    ]) });
    const app = createApp(e); // no renderApp → loadSchema can't clobber our schema mid-test
    app.state.schema = [{ db: 'd', expanded: true, tables: [{ name: 't', columns: null }] }];
    await app.actions.loadColumns('d', 't', app.state.schema[0].tables[0]);
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
  });
  it('keeps the current result view on a plain re-run, and restores a remembered view when opened (#34)', async () => {
    const routes = [[(u, sql) => /SELECT 1/.test(sql), resp({ body: streamBody(['{"meta":[{"name":"a","type":"UInt8"}]}\n', '{"row":{"a":"1"}}\n']) })]];
    const { app } = appForRun(routes, { Chart: class { destroy() {} } }); // Chart seam so the chart view renders
    app.activeTab().sql = 'SELECT 1';
    app.state.resultView = 'chart';
    await app.actions.run();                  // no opts → keep the current (chart) tab
    expect(app.state.resultView).toBe('chart');
    await app.actions.run({ view: 'json' });  // saved-query open restores its view
    expect(app.state.resultView).toBe('json');
    await app.actions.run({ view: 'table' });
    expect(app.state.resultView).toBe('table');
    await app.actions.run({ view: 'chart' });
    expect(app.state.resultView).toBe('chart');
    await app.actions.run({ view: 'bogus' }); // unknown view → keep current (chart)
    expect(app.state.resultView).toBe('chart');
  });
  it('no-ops on empty SQL', async () => {
    const { app } = appForRun([]);
    app.activeTab().sql = '   ';
    await app.actions.run();
    expect(app.activeTab().result).toBeNull();
  });
  it('run() while already running is a no-op (cancel is separate)', async () => {
    const { app } = appForRun([]);
    app.state.running = true;
    const ac = { abort: vi.fn() };
    app.state.abortController = ac;
    await app.actions.run();
    expect(ac.abort).not.toHaveBeenCalled(); // re-running no longer aborts
    expect(app.state.running).toBe(true);
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
    app.state.running = true;
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
  it('an explicit FORMAT on an EXPLAIN still wins over the raw default', async () => {
    const { app } = appForRun([
      [(u, sql) => /EXPLAIN/.test(sql), resp({ text: '{"plan":[]}' })],
    ]);
    app.activeTab().sql = 'EXPLAIN SELECT 1 FORMAT JSON';
    await app.actions.run();
    expect(app.activeTab().result.rawFormat).toBe('JSON'); // FORMAT clause, not the EXPLAIN default
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
    expect(app.dom.editorTextarea.value).toBe('SELECT\n  1\n');
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
    app.dom.editorTextarea.value = 'select x BEWEEN 2';
    await app.actions.formatQuery();
    expect(app.dom.editorTextarea.value).toBe('select x BEWEEN 2'); // editor unchanged
    const err = app.root.querySelector('.results-error');
    expect(err).not.toBeNull();
    expect(err.textContent).toContain('Code: 62. DB::Exception: Syntax error: failed at position 8 (BEWEEN): BEWEEN 2. Expected one of: BETWEEN, …. (SYNTAX_ERROR)'); // full original message, untruncated
    expect(app.dom.editorTextarea.selectionStart).toBe(7); // caret jumped to the offending token (pos 8 → offset 7)
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
    app.root.querySelector('.hd-btn[title^="Keyboard"]').dispatchEvent(new Event('click')); // shortcuts
    app.activeTab().sql = 'SELECT 1'; // set sql on the now-active tab
    app.dom.saveBtn.dispatchEvent(new Event('click')); // open save popover
    document.querySelector('.save-popover .sp-input').value = 'Q';
    document.querySelector('.save-popover .sp-save').dispatchEvent(new Event('click')); // commit
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
    app.state.tabs.push({ id: 'tx', name: 'X', sql: '', dirty: false, result: null, savedId: null });
    app.actions.selectTab('tx');
    app.actions.insertAtCursor('zz');
    app.actions.replaceEditor('SELECT 9');
    app.actions.loadIntoNewTab('n', 'SELECT 2');
    app.actions.rerenderTabs();
    app.actions.rerenderResults();
    app.actions.updateSaveBtn();
    app.actions.closeTab(app.state.activeTabId);
    expect(app.state.tabs.length).toBeGreaterThan(0);
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
  it('exportResult: CSV for structured (name sanitized), JSON for raw, nothing when empty', () => {
    const download = vi.fn();
    const app = createApp(env({ window: fakeWin(), download }));
    app.renderApp();
    app.activeTab().name = 'My Query!';
    app.activeTab().result = { columns: [{ name: 'a' }, { name: 'b' }], rows: [['1', 'x']] };
    app.actions.exportResult();
    expect(download).toHaveBeenCalledWith('My_Query.csv', 'text/csv', 'a,b\n1,x');
    app.activeTab().result = { rawText: '[{"a":1}]', rawFormat: 'JSON', rows: [] };
    app.actions.exportResult();
    expect(download).toHaveBeenLastCalledWith(expect.stringMatching(/\.json$/), 'application/json', '[{"a":1}]');
    app.activeTab().result = null;
    app.actions.exportResult();
    expect(document.querySelector('.share-toast').textContent).toBe('Nothing to export');
  });
  it('exportResult: raw TSV + junk tab name falls back to result.tsv; native Blob path revokes the URL', () => {
    const download = vi.fn();
    const app = createApp(env({ window: fakeWin(), download }));
    app.renderApp();
    app.activeTab().name = '!!!';
    app.activeTab().result = { rawText: 'a\tb', rawFormat: 'TSV', rows: [] };
    app.actions.exportResult();
    expect(download).toHaveBeenCalledWith('result.tsv', 'text/tab-separated-values', 'a\tb');
    // native path (no env.download): exercises Blob + createObjectURL + revoke
    const createObjectURL = vi.fn(() => 'blob:u');
    const revokeObjectURL = vi.fn();
    const app2 = createApp(env({ window: { ...fakeWin(), URL: { createObjectURL, revokeObjectURL }, Blob: class { constructor(p) { this.p = p; } } } }));
    app2.renderApp();
    app2.activeTab().result = { columns: [{ name: 'a' }], rows: [['1']] };
    app2.actions.exportResult();
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:u');
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
    const { app } = appForRun(routes);
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
    const { app } = appForRun(lineageRoutes);
    await app.actions.expandSchemaGraph({ kind: 'db', db: 'lin' });
    expect(document.body.querySelector('.graph-overlay')).not.toBeNull();
    await app.actions.openNodeDetail({ db: 'lin', name: 'events', kind: 'table' });
    expect(document.body.querySelector('.schema-detail')).not.toBeNull();
    await app.actions.openNodeDetail({ db: 'lin' }); // no name → guard returns, no throw
    document.body.querySelector('.graph-overlay').remove();
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
