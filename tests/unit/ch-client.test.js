import { describe, it, expect, vi } from 'vitest';
import {
  chUrl, authedFetch, queryJson, loadServerVersion, loadSchema, loadColumns, loadReferenceData, loadEntityDoc, runQuery, killQuery, loadSchemaLineage,
} from '../../src/net/ch-client.js';
import { sqlString } from '../../src/core/format.js';

// --- Response stubs -------------------------------------------------------
function jsonResp(body, ok = true, status = ok ? 200 : 500) {
  return {
    ok, status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    clone() { return this; },
  };
}
function textResp(text, ok = true, status = ok ? 200 : 500) {
  return { ok, status, text: async () => text, clone() { return this; } };
}
function streamResp(chunks, ok = true) {
  let i = 0;
  return {
    ok, status: ok ? 200 : 500,
    text: async () => chunks.join(''),
    clone() { return this; },
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: new TextEncoder().encode(chunks[i++]) }
            : { done: true },
      }),
    },
  };
}

function ctxWith(fetchImpl, over = {}) {
  return {
    fetch: vi.fn(fetchImpl),
    origin: 'https://ch.example',
    getToken: vi.fn(async () => 'tok'),
    refresh: vi.fn(async () => false),
    onSignedOut: vi.fn(),
    ...over,
  };
}

describe('chUrl', () => {
  it('uses default format and compression', () => {
    expect(chUrl('https://o')).toBe('https://o?default_format=JSONStringsEachRowWithProgress&enable_http_compression=1');
  });
  it('applies format, extra and params', () => {
    const url = chUrl('https://o', { format: 'JSON', extra: { wait_end_of_query: 1 }, params: { x: 'a b' } });
    expect(url).toContain('default_format=JSON');
    expect(url).toContain('wait_end_of_query=1');
    expect(url).toContain('x=a%20b');
  });
});

describe('authedFetch', () => {
  it('throws + signals out when no token', async () => {
    const ctx = ctxWith(() => jsonResp({}), { getToken: async () => null });
    await expect(authedFetch(ctx, 'u', 'sql')).rejects.toThrow('not signed in');
    expect(ctx.onSignedOut).toHaveBeenCalled();
  });
  it('returns the response on success', async () => {
    const ctx = ctxWith(async () => jsonResp({ ok: 1 }));
    const r = await authedFetch(ctx, 'u', 'sql');
    expect(r.ok).toBe(true);
    expect(ctx.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });
  it('refreshes once on 401 then retries', async () => {
    let n = 0;
    const ctx = ctxWith(async () => (n++ === 0 ? jsonResp({}, false, 401) : jsonResp({ ok: 1 })), {
      refresh: vi.fn(async () => true),
      getToken: vi.fn(async () => (n === 0 ? 'old' : 'new')),
    });
    const r = await authedFetch(ctx, 'u', 'sql');
    expect(r.ok).toBe(true);
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
  });
  it('signs out with an authorization message + server reason when CH rejects a valid token (403)', async () => {
    const ctx = ctxWith(
      async () => textResp('Code: 516. DB::Exception: Authentication failed', false, 403),
      { refresh: async () => false },
    );
    await expect(authedFetch(ctx, 'u', 'sql')).rejects.toThrow('signed out');
    expect(ctx.onSignedOut).toHaveBeenCalledTimes(1);
    const msg = ctx.onSignedOut.mock.calls[0][0];
    expect(msg).toContain('HTTP 403');
    expect(msg).toContain('not authorizing you');
    expect(msg).toContain('Server: Code: 516. DB::Exception: Authentication failed');
  });
  it('marks the ctx authenticated on a successful response', async () => {
    const ctx = ctxWith(async () => jsonResp({ ok: 1 }));
    await authedFetch(ctx, 'u', 'sql');
    expect(ctx.authConfirmed).toBe(true);
  });
  it('once authenticated, a later 403 is returned as a query error (no sign-out)', async () => {
    // e.g. SHOW CREATE USER <missing> → HTTP 403 / UNKNOWN_USER, mid-session.
    const ctx = ctxWith(async () => textResp('Code: 192. DB::Exception: There is no user x', false, 403),
      { authConfirmed: true });
    const resp = await authedFetch(ctx, 'u', 'sql');
    expect(resp.status).toBe(403);
    expect(ctx.onSignedOut).not.toHaveBeenCalled();
    expect(ctx.refresh).not.toHaveBeenCalled();
  });
  it('treats a token_verification body as auth-expired', async () => {
    let n = 0;
    const ctx = ctxWith(
      async () => (n++ === 0 ? textResp('jwt::token_verification_exception', false, 500) : jsonResp({ ok: 1 })),
      { refresh: vi.fn(async () => true) },
    );
    const r = await authedFetch(ctx, 'u', 'sql');
    expect(r.ok).toBe(true);
  });
  it('returns a non-auth error response unchanged', async () => {
    const ctx = ctxWith(async () => textResp('syntax error', false, 400));
    const r = await authedFetch(ctx, 'u', 'sql');
    expect(r.status).toBe(400);
  });
  it('uses a provided authHeader (e.g. Basic) instead of Bearer', async () => {
    const ctx = ctxWith(async () => jsonResp({ ok: 1 }), {
      authHeader: (t) => 'Basic ' + t.toUpperCase(),
    });
    await authedFetch(ctx, 'u', 'sql');
    expect(ctx.fetch.mock.calls[0][1].headers.Authorization).toBe('Basic TOK');
  });
});

describe('queryJson', () => {
  it('returns parsed JSON on success', async () => {
    const ctx = ctxWith(async () => jsonResp({ data: [{ a: 1 }] }));
    expect(await queryJson(ctx, 'SELECT 1')).toEqual({ data: [{ a: 1 }] });
  });
  it('throws the CH exception on error', async () => {
    const ctx = ctxWith(async () => textResp('{"exception":"DB::Exception: x"}', false, 500));
    await expect(queryJson(ctx, 'bad')).rejects.toThrow('DB::Exception: x');
  });
});

describe('loadServerVersion', () => {
  it('returns the version string', async () => {
    const ctx = ctxWith(async () => jsonResp({ data: [{ v: '26.3.1', u: 1 }] }));
    expect(await loadServerVersion(ctx)).toBe('26.3.1');
  });
  it('returns empty string when row/shape missing', async () => {
    const ctx = ctxWith(async () => jsonResp({ data: [] }));
    expect(await loadServerVersion(ctx)).toBe('');
  });
});

describe('loadSchema', () => {
  it('groups tables by db, all collapsed, defaults comment', async () => {
    const ctx = ctxWith(async () => jsonResp({
      data: [
        { database: 'a', name: 't1', total_rows: '1', total_bytes: '2', comment: 'c' },
        { database: 'a', name: 't2', total_rows: '3', total_bytes: '4' },
        { database: 'b', name: 't3', total_rows: '5', total_bytes: '6', comment: '' },
      ],
    }));
    const schema = await loadSchema(ctx);
    expect(schema).toHaveLength(2);
    expect(schema[0]).toMatchObject({ db: 'a', expanded: false });
    expect(schema[1]).toMatchObject({ db: 'b', expanded: false });
    expect(schema[0].tables[0]).toEqual({ name: 't1', total_rows: '1', total_bytes: '2', comment: 'c', columns: null });
    expect(schema[0].tables[1].comment).toBe('');
  });
  it('handles an empty table list', async () => {
    const ctx = ctxWith(async () => jsonResp({}));
    expect(await loadSchema(ctx)).toEqual([]);
  });
});

describe('loadColumns', () => {
  it('maps columns and defaults comment', async () => {
    const ctx = ctxWith(async () => jsonResp({ data: [{ name: 'c1', type: 'UInt8', comment: 'x' }, { name: 'c2', type: 'String' }] }));
    expect(await loadColumns(ctx, 'db', 't', sqlString)).toEqual([
      { name: 'c1', type: 'UInt8', comment: 'x' },
      { name: 'c2', type: 'String', comment: '' },
    ]);
    expect(ctx.fetch.mock.calls[0][1].body).toContain("database = 'db'");
  });
  it('handles missing data', async () => {
    const ctx = ctxWith(async () => jsonResp({}));
    expect(await loadColumns(ctx, 'db', 't', sqlString)).toEqual([]);
  });
});

describe('loadReferenceData', () => {
  it('loads keywords + function metadata from system tables', async () => {
    const ctx = ctxWith(async (url, o) => (
      o.body.includes('system.keywords')
        ? jsonResp({ data: [{ keyword: 'SELECT' }, { keyword: 'PREWHERE' }] })
        : jsonResp({ data: [{ name: 'count', is_aggregate: 1 }, { name: 'toDate', is_aggregate: 0 }] })
    ));
    const ref = await loadReferenceData(ctx);
    expect(ref.keywords).toEqual(['SELECT', 'PREWHERE']);
    expect(ref.functions.count).toEqual({ kind: 'agg', sig: 'count()', ret: '', desc: '' });
    expect(ref.functions.toDate.kind).toBe('fn'); // is_aggregate 0 → plain function
  });
  it('returns null pieces when a system table is missing/denied (best-effort)', async () => {
    const ctx = ctxWith(async () => textResp('Code: 60. DB::Exception: Unknown table', false, 500));
    expect(await loadReferenceData(ctx)).toEqual({ keywords: null, functions: null, formats: null });
  });
  it('tolerates an empty data shape', async () => {
    const ctx = ctxWith(async () => jsonResp({}));
    expect(await loadReferenceData(ctx)).toEqual({ keywords: [], functions: {}, formats: [] });
  });
  it('uses the syntax column for signatures; descriptions are NOT bulk-loaded (lazy, #27)', async () => {
    const ctx = ctxWith(async (url, o) => (
      o.body.includes('system.keywords')
        ? jsonResp({ data: [{ keyword: 'SELECT' }] })
        : jsonResp({ data: [{ name: 'toDate', is_aggregate: 0, syntax: 'toDate(x)' }] })
    ));
    const ref = await loadReferenceData(ctx);
    // desc stays '' here — hover docs are fetched on demand via loadEntityDoc.
    expect(ref.functions.toDate).toEqual({ kind: 'fn', sig: 'toDate(x)', ret: '', desc: '' });
  });
  it('falls back to the minimal function query when the syntax column is absent (older CH)', async () => {
    const ctx = ctxWith(async (url, o) => {
      if (o.body.includes('system.keywords')) return jsonResp({ data: [{ keyword: 'SELECT' }] });
      if (o.body.includes('syntax')) return textResp('Code: 47. DB::Exception: Unknown identifier syntax', false, 500);
      return jsonResp({ data: [{ name: 'now', is_aggregate: 0 }] }); // minimal columns only
    });
    const ref = await loadReferenceData(ctx);
    expect(ref.functions.now).toEqual({ kind: 'fn', sig: 'now()', ret: '', desc: '' });
  });
});

describe('loadEntityDoc (#27 — lazy hover docs)', () => {
  it('returns the first NON-empty line (CH descriptions begin with a blank line)', async () => {
    const ctx = ctxWith(async () => jsonResp({ data: [{ description: '\nCalculates a hash.\nMore detail here.' }] }));
    expect(await loadEntityDoc(ctx, 'BLAKE3', sqlString)).toBe('Calculates a hash.');
  });
  it('escapes the name through sqlString and queries system.functions', async () => {
    const fetchImpl = vi.fn(async () => jsonResp({ data: [{ description: 'doc' }] }));
    const ctx = ctxWith(fetchImpl);
    await loadEntityDoc(ctx, "o'brien", sqlString);
    expect(fetchImpl.mock.calls[0][1].body).toContain("WHERE name = 'o''brien'");
  });
  it('returns "" when the query succeeds but there is no description (unknown name / blank)', async () => {
    expect(await loadEntityDoc(ctxWith(async () => jsonResp({ data: [] })), 'nope', sqlString)).toBe('');
    expect(await loadEntityDoc(ctxWith(async () => jsonResp({ data: [{ description: '\n   \n' }] })), 'blank', sqlString)).toBe('');
  });
  it('returns null when the query FAILS, so the caller can retry rather than cache it (#8 review)', async () => {
    expect(await loadEntityDoc(ctxWith(async () => textResp('boom', false, 500)), 'x', sqlString)).toBeNull();
  });
});

describe('runQuery', () => {
  it('streams lines and reports an error result on !ok', async () => {
    const ctx = ctxWith(async () => textResp('{"exception":"boom"}', false, 500));
    const out = await runQuery(ctx, 'bad', { format: 'Table' });
    expect(out).toEqual({ error: 'boom' });
  });
  it('parses a streaming body, calling onLine + onChunk', async () => {
    const lines = [
      '{"meta":[{"name":"a","type":"UInt8"}]}\n',
      // blank line between objects exercises the `if (!line) continue` guard
      '{"row":{"a":"1"}}\n\n{"progress":{"read_rows":"1"}}\n',
      '{"row":{"a":"2"}}', // trailing, no newline
    ];
    const ctx = ctxWith(async () => streamResp(lines));
    const got = [];
    const out = await runQuery(ctx, 'SELECT a', { format: 'Table', onLine: (j) => got.push(j), onChunk: () => {} });
    expect(out).toEqual({ streamed: true });
    expect(got.filter((j) => j.row)).toHaveLength(2);
    expect(got.some((j) => j.meta)).toBe(true);
  });
  it('skips malformed lines and a malformed trailing buffer', async () => {
    const ctx = ctxWith(async () => streamResp(['not json\n', '{bad trailing']));
    const got = [];
    const out = await runQuery(ctx, 'x', { onLine: (j) => got.push(j) });
    expect(out).toEqual({ streamed: true });
    expect(got).toEqual([]);
  });
  it('defaults format to Table (streaming)', async () => {
    const ctx = ctxWith(async () => streamResp(['{"row":{}}\n']));
    const out = await runQuery(ctx, 'x', {});
    expect(out).toEqual({ streamed: true });
  });
  it('TSV raw mode returns the text body', async () => {
    const ctx = ctxWith(async () => textResp('a\tb\n1\t2'));
    expect(await runQuery(ctx, 'x', { format: 'TSV' })).toEqual({ raw: 'a\tb\n1\t2' });
  });
  it('JSON raw mode returns the text body', async () => {
    const ctx = ctxWith(async () => textResp('{"x":1}'));
    expect(await runQuery(ctx, 'x', { format: 'JSON' })).toEqual({ raw: '{"x":1}' });
  });
  it('passes the abort signal through', async () => {
    const ctx = ctxWith(async () => streamResp(['{"row":{}}\n']));
    const signal = { aborted: false };
    await runQuery(ctx, 'x', { signal });
    expect(ctx.fetch.mock.calls[0][1].signal).toBe(signal);
  });
  it('tags the run request with query_id when given', async () => {
    const ctx = ctxWith(async () => streamResp(['{"row":{}}\n']));
    await runQuery(ctx, 'x', { queryId: 'abc-123' });
    expect(ctx.fetch.mock.calls[0][0]).toContain('query_id=abc-123');
  });
  it('streams without wait_end_of_query; raw modes keep it for clean error status', async () => {
    const s = ctxWith(async () => streamResp(['{"row":{}}\n']));
    await runQuery(s, 'x', { format: 'Table' });
    expect(s.fetch.mock.calls[0][0]).not.toContain('wait_end_of_query'); // progressive first rows
    const raw = ctxWith(async () => textResp('a\tb'));
    await runQuery(raw, 'x', { format: 'TSV' });
    expect(raw.fetch.mock.calls[0][0]).toContain('wait_end_of_query=1');
  });
});

describe('killQuery', () => {
  it('POSTs KILL QUERY for the query_id', async () => {
    const ctx = ctxWith(async () => jsonResp({ data: [] }));
    await killQuery(ctx, 'abc-123', sqlString);
    expect(ctx.fetch.mock.calls[0][1].body).toBe("KILL QUERY WHERE query_id = 'abc-123' ASYNC");
  });
  it('no-ops without a query_id', async () => {
    const ctx = ctxWith(async () => jsonResp({ data: [] }));
    await killQuery(ctx, null, sqlString);
    expect(ctx.fetch).not.toHaveBeenCalled();
  });
  it('swallows errors (cancellation must never throw)', async () => {
    const ctx = ctxWith(async () => { throw new Error('boom'); });
    await expect(killQuery(ctx, 'q', sqlString)).resolves.toBeUndefined();
  });
});

describe('loadSchemaLineage', () => {
  it('fetches scoped system.tables + dictionaries and attaches EXPLAIN AST sources', async () => {
    const seen = [];
    const ctx = ctxWith((url, init) => {
      const sql = init.body;
      seen.push(sql);
      if (/EXPLAIN AST/.test(sql)) return jsonResp({ data: [{ explain: '      TableIdentifier lin.events (alias e)' }] });
      if (/system\.dictionaries/.test(sql)) return jsonResp({ data: [{ database: 'lin', name: 'd', source: 'ClickHouse: lin.dim' }] });
      // system.tables scope query
      return jsonResp({ data: [
        { database: 'lin', name: 'events', engine: 'MergeTree', as_select: '' },
        { database: 'lin', name: 'mv', engine: 'MaterializedView', as_select: 'SELECT 1 FROM lin.events', create_table_query: 'CREATE MATERIALIZED VIEW lin.mv TO lin.dst AS SELECT 1 FROM lin.events' },
      ] });
    });
    const out = await loadSchemaLineage(ctx, { kind: 'db', db: 'lin' });
    expect(out.tables).toHaveLength(2);
    expect(out.dictionaries).toEqual([{ database: 'lin', name: 'd', source: 'ClickHouse: lin.dim' }]);
    // the MV (non-empty as_select) got EXPLAIN AST sources; the plain table did not
    expect(out.tables.find((t) => t.name === 'mv').astTables).toEqual(['lin.events']);
    expect(out.tables.find((t) => t.name === 'events').astTables).toBeUndefined();
    // scoped to the database, and target_* never requested (OSS-portable)
    expect(seen.some((s) => /WHERE database = 'lin'/.test(s))).toBe(true);
    expect(seen.some((s) => /target_database/.test(s))).toBe(false);
  });
  it('tolerates an EXPLAIN AST failure (leaves astTables undefined)', async () => {
    const ctx = ctxWith((url, init) => {
      const sql = init.body;
      if (/EXPLAIN AST/.test(sql)) return jsonResp('parse error', false, 500);
      if (/system\.dictionaries/.test(sql)) return jsonResp({ data: [] });
      return jsonResp({ data: [{ database: 'lin', name: 'v', engine: 'View', as_select: 'SELECT bad' }] });
    });
    const out = await loadSchemaLineage(ctx, { kind: 'db', db: 'lin' });
    expect(out.tables[0].astTables).toBeUndefined();
  });
});
