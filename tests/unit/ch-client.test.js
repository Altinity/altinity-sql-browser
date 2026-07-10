import { describe, it, expect, vi } from 'vitest';
import {
  chUrl, authedFetch, queryJson, queryDashboardTile, loadServerVersion, loadSchema, loadColumns, loadReferenceData, loadEntityDoc, runQuery, killQuery, exportQuery, loadSchemaLineage, loadSchemaCards, loadLineageTransitive, loadTableDetail, AST_PROGRESSIVE_THRESHOLD, byUnderscoreThenName,
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

describe('queryDashboardTile', () => {
  it('runs read-only (readonly=2) + FORMAT JSON and returns parsed JSON', async () => {
    const ctx = ctxWith(async () => jsonResp({ meta: [{ name: 'n', type: 'UInt64' }], data: [{ n: 1 }] }));
    const out = await queryDashboardTile(ctx, 'SELECT 1 AS n\nFORMAT JSON');
    expect(out.data).toEqual([{ n: 1 }]);
    const url = ctx.fetch.mock.calls[0][0];
    expect(url).toContain('default_format=JSON');
    expect(url).toContain('readonly=2');
  });
  it('throws CH reason on a non-ok response', async () => {
    const ctx = ctxWith(async () => textResp('Code: 164. DB::Exception: Cannot execute query in readonly mode', false, 500));
    await expect(queryDashboardTile(ctx, 'DROP TABLE t')).rejects.toThrow(/readonly mode/);
  });
  it('forwards params as param_<name> query-string args (#149 D3)', async () => {
    const ctx = ctxWith(async () => jsonResp({ meta: [], data: [] }));
    await queryDashboardTile(ctx, 'SELECT {year:UInt16}\nFORMAT JSON', undefined, { param_year: '2024' });
    const url = ctx.fetch.mock.calls[0][0];
    expect(url).toContain('param_year=2024');
  });
  it('omits params entirely when not passed (backward compatible)', async () => {
    const ctx = ctxWith(async () => jsonResp({ meta: [], data: [] }));
    await queryDashboardTile(ctx, 'SELECT 1\nFORMAT JSON');
    const url = ctx.fetch.mock.calls[0][0];
    expect(url).not.toContain('param_');
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
  it('forwards params as param_<name> query-string args, omitted when absent', async () => {
    const ctx = ctxWith(async () => jsonResp({ data: [] }));
    await queryJson(ctx, 'SELECT {id:UInt32}', undefined, undefined, { param_id: '5' });
    expect(ctx.fetch.mock.calls[0][0]).toContain('param_id=5');
    await queryJson(ctx, 'SELECT 1');
    expect(ctx.fetch.mock.calls[1][0]).not.toContain('param_');
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

describe('byUnderscoreThenName', () => {
  it('sorts underscore-prefixed names after regular ones, either argument order', () => {
    expect(byUnderscoreThenName('_hidden', 'orders')).toBe(1);
    expect(byUnderscoreThenName('orders', '_hidden')).toBe(-1);
  });
  it('sorts two regular (or two underscore) names lexically, including equal', () => {
    expect(byUnderscoreThenName('a', 'b')).toBe(-1);
    expect(byUnderscoreThenName('b', 'a')).toBe(1);
    expect(byUnderscoreThenName('a', 'a')).toBe(0);
  });
});

describe('loadSchema', () => {
  it('groups tables by db, all collapsed, defaults comment; includes empty databases', async () => {
    const ctx = ctxWith(async (url, o) => (
      o.body.includes('FROM system.databases')
        ? jsonResp({ data: [{ name: 'a' }, { name: 'b' }, { name: 'empty' }] })
        : jsonResp({
          data: [
            { database: 'a', name: 't1', total_rows: '1', total_bytes: '2', comment: 'c' },
            { database: 'a', name: 't2', total_rows: '3', total_bytes: '4' },
            { database: 'b', name: 't3', total_rows: '5', total_bytes: '6', comment: '' },
          ],
        })
    ));
    const schema = await loadSchema(ctx);
    expect(schema).toHaveLength(3);
    expect(schema[0]).toMatchObject({ db: 'a', expanded: false });
    expect(schema[1]).toMatchObject({ db: 'b', expanded: false });
    expect(schema[2]).toEqual({ db: 'empty', expanded: false, comment: '', tables: [] });
    expect(schema[0].tables[0]).toEqual({ name: 't1', total_rows: '1', total_bytes: '2', comment: 'c', columns: null });
    expect(schema[0].tables[1].comment).toBe('');
  });
  it('sorts underscore-prefixed tables after regular ones, in both queries', async () => {
    const seen = [];
    const ctx = ctxWith(async (url, o) => {
      seen.push(o.body);
      return o.body.includes('FROM system.databases')
        ? jsonResp({ data: [] })
        : jsonResp({ data: [] });
    });
    await loadSchema(ctx);
    const tablesSql = seen.find((s) => s.includes('FROM system.tables'));
    expect(tablesSql).toMatch(/ORDER BY database, startsWith\(name, '_'\), name/);
  });
  it('handles a table whose database is missing from system.databases', async () => {
    const ctx = ctxWith(async (url, o) => (
      o.body.includes('FROM system.databases')
        ? jsonResp({ data: [] })
        : jsonResp({ data: [{ database: 'orphan', name: 't1', total_rows: '1', total_bytes: '2', comment: '' }] })
    ));
    const schema = await loadSchema(ctx);
    expect(schema).toEqual([{ db: 'orphan', comment: '', expanded: false, tables: [{ name: 't1', total_rows: '1', total_bytes: '2', comment: '', columns: null }] }]);
  });
  it('surfaces a database comment, defaulting to "" when absent', async () => {
    const ctx = ctxWith(async (url, o) => (
      o.body.includes('FROM system.databases')
        ? jsonResp({ data: [{ name: 'a', comment: 'analytics db' }, { name: 'b' }] })
        : jsonResp({ data: [] })
    ));
    const schema = await loadSchema(ctx);
    expect(schema[0]).toMatchObject({ db: 'a', comment: 'analytics db' });
    expect(schema[1]).toMatchObject({ db: 'b', comment: '' });
  });
  it('handles an empty table list', async () => {
    const ctx = ctxWith(async () => jsonResp({}));
    expect(await loadSchema(ctx)).toEqual([]);
  });
  it('excludes DataLakeCatalog databases from the main system.tables query, querying each separately (#162)', async () => {
    const seen = [];
    const ctx = ctxWith(async (url, o) => {
      seen.push(o.body);
      if (o.body.includes('FROM system.databases')) {
        return jsonResp({ data: [{ name: 'default' }, { name: 'ice', engine: 'DataLakeCatalog' }] });
      }
      if (o.body.includes("database = 'ice'")) return jsonResp({ data: [{ database: 'ice', name: 'orders' }] });
      return jsonResp({ data: [] });
    });
    const schema = await loadSchema(ctx);
    const mainTablesSql = seen.find((s) => s.includes('FROM system.tables') && !s.includes("database = 'ice'"));
    expect(mainTablesSql).toContain("WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema', 'ice')");
    expect(mainTablesSql).not.toContain('show_data_lake_catalogs_in_system_tables');
    const catalogSql = seen.find((s) => s.includes("database = 'ice'"));
    expect(catalogSql).toBe("SELECT database, name FROM system.tables WHERE database = 'ice'\nSETTINGS show_data_lake_catalogs_in_system_tables = 1\nFORMAT JSON");
    expect(schema.find((d) => d.db === 'ice').tables).toEqual([{ name: 'orders', total_rows: 0, total_bytes: 0, comment: '', columns: null }]);
  });
  it('zero-fills stats for catalog tables and sorts them underscore-last (#162 — stats aren\'t fetchable without risking the abort)', async () => {
    const ctx = ctxWith(async (url, o) => {
      if (o.body.includes('FROM system.databases')) return jsonResp({ data: [{ name: 'ice', engine: 'DataLakeCatalog' }] });
      if (o.body.includes('FROM system.tables') && o.body.includes("database = 'ice'")) {
        return jsonResp({ data: [{ database: 'ice', name: '_hidden' }, { database: 'ice', name: 'orders' }, { database: 'ice', name: 'logs.cold_logs' }] });
      }
      return jsonResp({ data: [] });
    });
    const schema = await loadSchema(ctx);
    expect(schema).toEqual([{
      db: 'ice', comment: '', expanded: false,
      tables: [
        { name: 'logs.cold_logs', total_rows: 0, total_bytes: 0, comment: '', columns: null },
        { name: 'orders', total_rows: 0, total_bytes: 0, comment: '', columns: null },
        { name: '_hidden', total_rows: 0, total_bytes: 0, comment: '', columns: null },
      ],
    }]);
  });
  it('falls back to the plain per-catalog query when an older ClickHouse rejects the setting', async () => {
    const ctx = ctxWith(async (url, o) => {
      if (o.body.includes('FROM system.databases')) return jsonResp({ data: [{ name: 'ice', engine: 'DataLakeCatalog' }] });
      if (o.body.includes('SETTINGS show_data_lake_catalogs_in_system_tables')) {
        return textResp('Code: 115. DB::Exception: Unknown setting show_data_lake_catalogs_in_system_tables', false, 500);
      }
      if (o.body.includes("database = 'ice'")) return jsonResp({ data: [{ database: 'ice', name: 'orders' }] });
      return jsonResp({ data: [] });
    });
    const schema = await loadSchema(ctx);
    expect(schema).toEqual([{
      db: 'ice', comment: '', expanded: false,
      tables: [{ name: 'orders', total_rows: 0, total_bytes: 0, comment: '', columns: null }],
    }]);
  });
  it('treats a shape-miss (no data field) catalog response as zero tables', async () => {
    const ctx = ctxWith(async (url, o) => {
      if (o.body.includes('FROM system.databases')) return jsonResp({ data: [{ name: 'ice', engine: 'DataLakeCatalog' }] });
      if (o.body.includes("database = 'ice'")) return jsonResp({});
      return jsonResp({ data: [] });
    });
    const schema = await loadSchema(ctx);
    expect(schema).toEqual([{ db: 'ice', comment: '', expanded: false, tables: [] }]);
  });
  it('shows one broken catalog database as empty without disabling or failing any other database (#162/ClickHouse#110032)', async () => {
    const ctx = ctxWith(async (url, o) => {
      if (o.body.includes('FROM system.databases')) {
        return jsonResp({ data: [{ name: 'default' }, { name: 'broken', engine: 'DataLakeCatalog' }, { name: 'healthy', engine: 'DataLakeCatalog' }] });
      }
      if (o.body.includes("database = 'broken'")) {
        return textResp('Code: 36. DB::Exception: Received error 36 while fetching table metadata for existing table \'broken.bad\'. (BAD_ARGUMENTS)', false, 500);
      }
      if (o.body.includes("database = 'healthy'")) return jsonResp({ data: [{ database: 'healthy', name: 't1' }] });
      return jsonResp({ data: [{ database: 'default', name: 't0', total_rows: '1', total_bytes: '2', comment: '' }] });
    });
    const schema = await loadSchema(ctx);
    expect(schema.find((d) => d.db === 'default').tables).toEqual([{ name: 't0', total_rows: '1', total_bytes: '2', comment: '', columns: null }]);
    expect(schema.find((d) => d.db === 'broken').tables).toEqual([]);
    expect(schema.find((d) => d.db === 'healthy').tables).toEqual([{ name: 't1', total_rows: 0, total_bytes: 0, comment: '', columns: null }]);
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
  it('falls back to the plain query when an older ClickHouse rejects the data-lake-catalog setting (#122)', async () => {
    const ctx = ctxWith(async (url, o) => (
      o.body.includes('SETTINGS show_data_lake_catalogs_in_system_tables')
        ? textResp('Unknown setting show_data_lake_catalogs_in_system_tables', false, 500)
        : jsonResp({ data: [{ name: 'c1', type: 'Int64', comment: '' }] })
    ));
    expect(await loadColumns(ctx, 'ice', 'orders', sqlString)).toEqual([{ name: 'c1', type: 'Int64', comment: '' }]);
  });
  it('remembers an unsupported data-lake-catalog setting for the rest of the session (no repeated doomed round trip)', async () => {
    let settingsAttempts = 0;
    const ctx = ctxWith(async (url, o) => {
      if (o.body.includes('SETTINGS show_data_lake_catalogs_in_system_tables')) {
        settingsAttempts++;
        return textResp('Unknown setting show_data_lake_catalogs_in_system_tables', false, 500);
      }
      return jsonResp({ data: [{ name: 'c1', type: 'Int64', comment: '' }] });
    });
    await loadColumns(ctx, 'ice', 'orders', sqlString);
    await loadColumns(ctx, 'ice', 'orders2', sqlString);
    expect(settingsAttempts).toBe(1);
    expect(ctx.dataLakeCatalogSettingUnsupported).toBe(true);
  });
  it('does not retry (and does not double sign out) when the token is missing', async () => {
    const ctx = ctxWith(async () => jsonResp({}), { getToken: vi.fn(async () => null) });
    await expect(loadColumns(ctx, 'db', 't', sqlString)).rejects.toThrow('not signed in');
    expect(ctx.onSignedOut).toHaveBeenCalledTimes(1);
    expect(ctx.getToken).toHaveBeenCalledTimes(1);
  });
  it('does not retry (and does not double sign out) when the server rejects the token outright (403)', async () => {
    const ctx = ctxWith(async () => textResp('Code: 516. DB::Exception: Authentication failed', false, 403),
      { refresh: vi.fn(async () => false) });
    await expect(loadColumns(ctx, 'db', 't', sqlString)).rejects.toThrow('signed out');
    expect(ctx.onSignedOut).toHaveBeenCalledTimes(1);
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
  it('passes caller params (e.g. result caps) alongside query_id', async () => {
    const ctx = ctxWith(async () => textResp('{"meta":[],"data":[]}'));
    await runQuery(ctx, 'x', { format: 'JSONCompact', queryId: 'q1', params: { max_result_rows: 100, result_overflow_mode: 'break' } });
    const url = ctx.fetch.mock.calls[0][0];
    expect(url).toContain('query_id=q1');
    expect(url).toContain('max_result_rows=100');
    expect(url).toContain('result_overflow_mode=break');
  });
  it('streams without wait_end_of_query; raw modes keep it for clean error status', async () => {
    const s = ctxWith(async () => streamResp(['{"row":{}}\n']));
    await runQuery(s, 'x', { format: 'Table' });
    expect(s.fetch.mock.calls[0][0]).not.toContain('wait_end_of_query'); // progressive first rows
    const raw = ctxWith(async () => textResp('a\tb'));
    await runQuery(raw, 'x', { format: 'TSV' });
    expect(raw.fetch.mock.calls[0][0]).toContain('wait_end_of_query=1');
  });
  it('adds the server-side row cap when resultRowLimit is set; omits it otherwise', async () => {
    const capped = ctxWith(async () => streamResp(['{"row":{}}\n']));
    await runQuery(capped, 'x', { format: 'Table', resultRowLimit: 500 });
    const url = capped.fetch.mock.calls[0][0];
    expect(url).toContain('max_result_rows=500');
    expect(url).toContain('result_overflow_mode=break');
    const uncapped = ctxWith(async () => streamResp(['{"row":{}}\n']));
    await runQuery(uncapped, 'x', { format: 'Table' }); // no limit → no cap params
    expect(uncapped.fetch.mock.calls[0][0]).not.toContain('max_result_rows');
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

describe('exportQuery', () => {
  it('sets query_id + default_format, passes the signal, and returns the raw Response', async () => {
    const signal = {};
    const stream = streamResp(['a\tb\n1\tx\n']);
    const ctx = ctxWith(async () => stream);
    const resp = await exportQuery(ctx, 'SELECT 1 FORMAT TabSeparatedWithNames', {
      queryId: 'export-abc', signal, format: 'TabSeparatedWithNames',
    });
    expect(resp).toBe(stream);
    const [url, init] = ctx.fetch.mock.calls[0];
    expect(url).toContain('default_format=TabSeparatedWithNames');
    expect(url).toContain('query_id=export-abc');
    expect(init.signal).toBe(signal);
    expect(init.body).toBe('SELECT 1 FORMAT TabSeparatedWithNames');
  });
  it('defaults to TabSeparatedWithNames and omits query_id when absent', async () => {
    const ctx = ctxWith(async () => streamResp(['x']));
    await exportQuery(ctx, 'SELECT 1');
    const url = ctx.fetch.mock.calls[0][0];
    expect(url).toContain('default_format=TabSeparatedWithNames');
    expect(url).not.toContain('query_id');
  });
  it('throws the parsed CH exception on a non-OK (pre-header) response', async () => {
    const ctx = ctxWith(async () => textResp('{"exception":"DB::Exception: nope"}', false));
    await expect(exportQuery(ctx, 'SELECT 1', { format: 'CSV' })).rejects.toThrow('DB::Exception: nope');
  });
  it('forwards caller params (e.g. session_id) alongside query_id (#99: script export)', async () => {
    const ctx = ctxWith(async () => streamResp(['x']));
    await exportQuery(ctx, 'SELECT 1', { queryId: 'export-abc', params: { session_id: 'sess-1' } });
    const url = ctx.fetch.mock.calls[0][0];
    expect(url).toContain('query_id=export-abc');
    expect(url).toContain('session_id=sess-1');
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
  it('tolerates a denied system.dictionaries (degrades to no dictionary edges, graph still loads)', async () => {
    const ctx = ctxWith((url, init) => {
      const sql = init.body;
      // Low-priv users (e.g. the demo role) lack SELECT on system.dictionaries.
      if (/system\.dictionaries/.test(sql)) return jsonResp('DB::Exception: demo: Not enough privileges. ... grant SELECT ON system.dictionaries. (ACCESS_DENIED)', false, 500);
      return jsonResp({ data: [{ database: 'lin', name: 'events', engine: 'MergeTree', as_select: '' }] });
    });
    const out = await loadSchemaLineage(ctx, { kind: 'db', db: 'lin' });
    expect(out.tables).toHaveLength(1);
    expect(out.dictionaries).toEqual([]);
  });
  it('includes the card metadata columns in the scoped tables query', async () => {
    const seen = [];
    const ctx = ctxWith((url, init) => {
      seen.push(init.body);
      if (/system\.dictionaries/.test(init.body)) return jsonResp({ data: [] });
      return jsonResp({ data: [{ database: 'lin', name: 't', engine: 'MergeTree', as_select: '' }] });
    });
    await loadSchemaLineage(ctx, { kind: 'db', db: 'lin' });
    const tablesSql = seen.find((s) => /FROM system\.tables/.test(s));
    expect(tablesSql).toMatch(/total_rows/);
    expect(tablesSql).toMatch(/total_bytes/);
    expect(tablesSql).toMatch(/partition_key/);
    expect(tablesSql).toMatch(/sampling_key/);
    expect(tablesSql).toMatch(/\bcomment\b/);
  });
  it('sorts underscore-prefixed tables after regular ones', async () => {
    const seen = [];
    const ctx = ctxWith((url, init) => {
      seen.push(init.body);
      if (/system\.dictionaries/.test(init.body)) return jsonResp({ data: [] });
      return jsonResp({ data: [] });
    });
    await loadSchemaLineage(ctx, { kind: 'db', db: 'lin' });
    const tablesSql = seen.find((s) => /FROM system\.tables/.test(s));
    expect(tablesSql).toMatch(/ORDER BY startsWith\(name, '_'\), name/);
  });

  // #124 — progressive draw + cancellation.
  it('calls onBase with the free-edges data before any EXPLAIN AST resolves', async () => {
    let resolveAst;
    const astPending = new Promise((r) => { resolveAst = r; });
    const ctx = ctxWith((url, init) => {
      const sql = init.body;
      if (/EXPLAIN AST/.test(sql)) return astPending;
      if (/system\.dictionaries/.test(sql)) return jsonResp({ data: [] });
      return jsonResp({ data: [
        { database: 'lin', name: 'events', engine: 'MergeTree', as_select: '' },
        { database: 'lin', name: 'mv', engine: 'MaterializedView', as_select: 'SELECT 1 FROM lin.events', create_table_query: '' },
      ] });
    });
    let resolveBaseSeen;
    const baseSeen = new Promise((r) => { resolveBaseSeen = r; });
    // progressiveThreshold: 1 forces the two-phase path with this tiny (1-astTarget)
    // fixture — production leaves it at the AST_PROGRESSIVE_THRESHOLD default.
    const pending = loadSchemaLineage(ctx, { kind: 'db', db: 'lin' }, { onBase: resolveBaseSeen, progressiveThreshold: 1 });
    const base = await baseSeen; // resolves exactly when onBase fires — deterministic, no microtask counting
    expect(base.tables).toHaveLength(2);
    resolveAst(jsonResp({ data: [{ explain: '' }] }));
    await pending;
  });
  it('calls onProgress as each EXPLAIN AST settles, with a done/total count', async () => {
    const ctx = ctxWith((url, init) => {
      const sql = init.body;
      if (/EXPLAIN AST/.test(sql)) return jsonResp({ data: [{ explain: '' }] });
      if (/system\.dictionaries/.test(sql)) return jsonResp({ data: [] });
      return jsonResp({ data: [
        { database: 'lin', name: 'v1', engine: 'View', as_select: 'SELECT 1' },
        { database: 'lin', name: 'v2', engine: 'View', as_select: 'SELECT 2' },
      ] });
    });
    const progress = [];
    await loadSchemaLineage(ctx, { kind: 'db', db: 'lin' },
      { onProgress: (done, total) => progress.push([done, total]), progressiveThreshold: 1 });
    expect(progress).toHaveLength(2);
    expect(progress.every(([, total]) => total === 2)).toBe(true);
    expect(progress.map(([done]) => done).sort()).toEqual([1, 2]);
  });
  it('skips onBase/onProgress below the progressive threshold (small schemas draw in one step, no flicker)', async () => {
    let resolveAst;
    const astPending = new Promise((r) => { resolveAst = r; });
    const ctx = ctxWith((url, init) => {
      const sql = init.body;
      if (/EXPLAIN AST/.test(sql)) return astPending;
      if (/system\.dictionaries/.test(sql)) return jsonResp({ data: [] });
      return jsonResp({ data: [{ database: 'lin', name: 'v', engine: 'View', as_select: 'SELECT 1' }] });
    });
    const onBase = vi.fn();
    const onProgress = vi.fn();
    // 1 astTarget is far below the default threshold — onBase must NOT fire even
    // though the free-edges data (tables/dictionaries) is known well before the
    // single EXPLAIN AST resolves.
    const pending = loadSchemaLineage(ctx, { kind: 'db', db: 'lin' }, { onBase, onProgress });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(onBase).not.toHaveBeenCalled();
    resolveAst(jsonResp({ data: [{ explain: '' }] }));
    await pending;
    expect(onBase).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });
  it('calls onBase/onProgress at exactly the threshold (>= is progressive, not just >)', async () => {
    const views = Array.from({ length: AST_PROGRESSIVE_THRESHOLD }, (_, i) => ({
      database: 'lin', name: 'v' + i, engine: 'View', as_select: 'SELECT ' + i,
    }));
    const ctx = ctxWith((url, init) => {
      const sql = init.body;
      if (/EXPLAIN AST/.test(sql)) return jsonResp({ data: [{ explain: '' }] });
      if (/system\.dictionaries/.test(sql)) return jsonResp({ data: [] });
      return jsonResp({ data: views });
    });
    const onBase = vi.fn();
    await loadSchemaLineage(ctx, { kind: 'db', db: 'lin' }, { onBase });
    expect(onBase).toHaveBeenCalledTimes(1);
  });
  it('threads an aborted signal through to fetch (network layer sees it)', async () => {
    const controller = new AbortController();
    const seenSignals = [];
    const ctx = ctxWith((url, init) => {
      seenSignals.push(init.signal);
      if (/system\.dictionaries/.test(init.body)) return jsonResp({ data: [] });
      return jsonResp({ data: [] });
    });
    await loadSchemaLineage(ctx, { kind: 'db', db: 'lin' }, { signal: controller.signal });
    expect(seenSignals.every((s) => s === controller.signal)).toBe(true);
  });
  it('propagates a cancellation during the best-effort system.dictionaries read instead of degrading to no dictionaries', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = ctxWith((url, init) => {
      const sql = init.body;
      if (/system\.dictionaries/.test(sql)) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      return jsonResp({ data: [{ database: 'lin', name: 'events', engine: 'MergeTree', as_select: '' }] });
    });
    await expect(loadSchemaLineage(ctx, { kind: 'db', db: 'lin' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('propagates a cancellation during a per-view EXPLAIN AST instead of degrading to no astTables', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = ctxWith((url, init) => {
      const sql = init.body;
      if (/EXPLAIN AST/.test(sql)) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      if (/system\.dictionaries/.test(sql)) return jsonResp({ data: [] });
      return jsonResp({ data: [{ database: 'lin', name: 'v', engine: 'View', as_select: 'SELECT 1' }] });
    });
    await expect(loadSchemaLineage(ctx, { kind: 'db', db: 'lin' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('does NOT rethrow an AbortError-shaped error from a call that never passed a signal (unrelated best-effort reads stay unaffected)', async () => {
    const ctx = ctxWith(() => { const e = new Error('boom'); e.name = 'AbortError'; throw e; });
    // loadReferenceData's underlying tryQueryData calls never pass a signal — an
    // AbortError there (e.g. a coincidental fetch abort unrelated to #124's
    // cancellation) must still degrade gracefully, not surface as a rejection.
    const out = await loadReferenceData(ctx);
    expect(out).toEqual({ keywords: null, functions: null, formats: null });
  });
  it('requests data-lake-catalog visibility on the scoped system.tables query (#122 — Iceberg/Glue/Unity tables hidden by default)', async () => {
    const seen = [];
    const ctx = ctxWith((url, init) => {
      seen.push(init.body);
      if (/system\.dictionaries/.test(init.body)) return jsonResp({ data: [] });
      return jsonResp({ data: [] });
    });
    await loadSchemaLineage(ctx, { kind: 'db', db: 'lin' });
    const tablesSql = seen.find((s) => /FROM system\.tables/.test(s));
    expect(tablesSql).toContain('SETTINGS show_data_lake_catalogs_in_system_tables = 1');
  });
  it('falls back to the plain system.tables query when an older ClickHouse rejects the setting', async () => {
    const ctx = ctxWith((url, init) => {
      const sql = init.body;
      if (/system\.dictionaries/.test(sql)) return jsonResp({ data: [] });
      if (sql.includes('SETTINGS show_data_lake_catalogs_in_system_tables')) {
        return textResp('Unknown setting show_data_lake_catalogs_in_system_tables', false, 500);
      }
      return jsonResp({ data: [{ database: 'lin', name: 'events', engine: 'MergeTree', as_select: '' }] });
    });
    const out = await loadSchemaLineage(ctx, { kind: 'db', db: 'lin' });
    expect(out.tables).toHaveLength(1);
  });
  it('does not retry system.tables after a cancellation (propagates instead of falling back)', async () => {
    const controller = new AbortController();
    controller.abort();
    let tablesCalls = 0;
    const ctx = ctxWith((url, init) => {
      const sql = init.body;
      if (/system\.dictionaries/.test(sql)) return jsonResp({ data: [] });
      tablesCalls++;
      const e = new Error('aborted'); e.name = 'AbortError'; throw e;
    });
    await expect(loadSchemaLineage(ctx, { kind: 'db', db: 'lin' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(tablesCalls).toBe(1);
  });
});

describe('loadSchemaCards', () => {
  it('keys columns + skip indices by db.table and scopes via IN (…)', async () => {
    const seen = [];
    const ctx = ctxWith((url, init) => {
      const sql = init.body; seen.push(sql);
      if (/system\.data_skipping_indices/.test(sql)) {
        return jsonResp({ data: [{ database: 'lin', table: 'events', name: 'idx_d', type: 'minmax', expr: 'd' }] });
      }
      return jsonResp({ data: [
        { database: 'lin', table: 'events', name: 'id', type: 'UInt64', is_in_primary_key: 1, position: 1 },
        { database: 'lin', table: 'events', name: 'd', type: 'Date', is_in_partition_key: 1, position: 2 },
        { database: 'lin', table: 'other', name: 'x', type: 'String', position: 1 },
      ] });
    });
    const out = await loadSchemaCards(ctx, ['lin']);
    expect(out.columnsByKey['lin.events']).toHaveLength(2);
    expect(out.columnsByKey['lin.other']).toHaveLength(1);
    expect(out.skipByKey['lin.events']).toEqual([{ database: 'lin', table: 'events', name: 'idx_d', type: 'minmax', expr: 'd' }]);
    expect(seen.some((s) => /system\.columns/.test(s) && /database IN \('lin'\)/.test(s))).toBe(true);
    expect(seen.some((s) => /data_skipping_indices/.test(s) && /database IN \('lin'\)/.test(s))).toBe(true);
  });
  it('degrades to empty maps when the system tables are denied (no throw)', async () => {
    const ctx = ctxWith(() => jsonResp('Code: 497 ACCESS_DENIED', false, 500));
    expect(await loadSchemaCards(ctx, ['lin', 'other'])).toEqual({ columnsByKey: {}, skipByKey: {} });
  });
  it('issues no query for an empty database list', async () => {
    const ctx = ctxWith(() => { throw new Error('should not fetch'); });
    expect(await loadSchemaCards(ctx, [])).toEqual({ columnsByKey: {}, skipByKey: {} });
    expect(ctx.fetch).not.toHaveBeenCalled();
  });
  it('requests data-lake-catalog visibility on the system.columns query (#122)', async () => {
    const seen = [];
    const ctx = ctxWith((url, init) => {
      seen.push(init.body);
      return jsonResp({ data: [] });
    });
    await loadSchemaCards(ctx, ['ice']);
    const colSql = seen.find((s) => /FROM system\.columns/.test(s));
    expect(colSql).toContain('SETTINGS show_data_lake_catalogs_in_system_tables = 1');
  });
  it('falls back to the plain system.columns query when an older ClickHouse rejects the setting', async () => {
    const ctx = ctxWith((url, init) => {
      const sql = init.body;
      if (/data_skipping_indices/.test(sql)) return jsonResp({ data: [] });
      if (sql.includes('SETTINGS show_data_lake_catalogs_in_system_tables')) return textResp('Unknown setting', false, 500);
      return jsonResp({ data: [{ database: 'ice', table: 'orders', name: 'id', type: 'Int64', position: 1 }] });
    });
    const out = await loadSchemaCards(ctx, ['ice']);
    expect(out.columnsByKey['ice.orders']).toHaveLength(1);
  });
});

describe('loadLineageTransitive', () => {
  // 'a.t' depends on 'b.mv' (cross-DB), so the walk should pull in database 'b'.
  const tbl = (database, name, engine, over = {}) => ({
    database, name, engine, engine_full: '', create_table_query: '', as_select: '', uuid: '',
    dependencies_database: [], dependencies_table: [], loading_dependencies_database: [], loading_dependencies_table: [], ...over,
  });
  const lineageCtx = (extra = {}) => ctxWith((url, init) => {
    const sql = init.body;
    if (/EXPLAIN AST/.test(sql)) return jsonResp({ data: [] });
    if (/system\.dictionaries/.test(sql)) return jsonResp({ data: [] });
    if (/database = 'a'/.test(sql)) return jsonResp({ data: [tbl('a', 't', 'MergeTree', { dependencies_database: ['b'], dependencies_table: ['mv'] })] });
    if (/database = 'b'/.test(sql)) return jsonResp({ data: [tbl('b', 'mv', 'MaterializedView', extra.b || {})] });
    if (/database = 'c'/.test(sql)) return jsonResp({ data: [tbl('c', 'x', 'MergeTree')] });
    return jsonResp({ data: [] });
  });

  it('walks across DB boundaries and merges rows from both databases', async () => {
    const out = await loadLineageTransitive(lineageCtx(), { db: 'a' });
    const dbs = new Set(out.rows.tables.map((t) => t.database));
    expect(dbs.has('a')).toBe(true);
    expect(dbs.has('b')).toBe(true); // pulled in transitively
    expect(out.truncated).toBe(false);
  });

  it('flags truncated when the database cap is hit', async () => {
    // a → b → c; dbCap 2 stops before loading c.
    const ctx = ctxWith((url, init) => {
      const sql = init.body;
      if (/EXPLAIN AST/.test(sql) || /system\.dictionaries/.test(sql)) return jsonResp({ data: [] });
      if (/database = 'a'/.test(sql)) return jsonResp({ data: [tbl('a', 't', 'MergeTree', { dependencies_database: ['b'], dependencies_table: ['u'] })] });
      if (/database = 'b'/.test(sql)) return jsonResp({ data: [tbl('b', 'u', 'MergeTree', { dependencies_database: ['c'], dependencies_table: ['w'] })] });
      return jsonResp({ data: [] });
    });
    const out = await loadLineageTransitive(ctx, { db: 'a' }, { dbCap: 2 });
    expect(out.truncated).toBe(true);
    expect(new Set(out.rows.tables.map((t) => t.database)).has('c')).toBe(false);
  });

  it('flags truncated when the node cap is hit', async () => {
    const out = await loadLineageTransitive(lineageCtx(), { db: 'a' }, { nodeCap: 1 });
    expect(out.truncated).toBe(true);
  });

  it('counts only linked nodes toward the cap — standalone tables do not truncate the cross-DB walk', async () => {
    // 'a' has one cross-DB link (a.t → b.mv) plus 4 standalone tables: 6 total nodes
    // after round 1, but only 2 linked. nodeCap 3 must NOT truncate, and 'b' must load.
    const ctx = ctxWith((url, init) => {
      const sql = init.body;
      if (/EXPLAIN AST/.test(sql) || /system\.dictionaries/.test(sql)) return jsonResp({ data: [] });
      if (/database = 'a'/.test(sql)) return jsonResp({ data: [
        tbl('a', 't', 'MergeTree', { dependencies_database: ['b'], dependencies_table: ['mv'] }),
        tbl('a', 's1', 'MergeTree'), tbl('a', 's2', 'MergeTree'),
        tbl('a', 's3', 'MergeTree'), tbl('a', 's4', 'MergeTree'),
      ] });
      if (/database = 'b'/.test(sql)) return jsonResp({ data: [tbl('b', 'mv', 'MaterializedView')] });
      return jsonResp({ data: [] });
    });
    const out = await loadLineageTransitive(ctx, { db: 'a' }, { nodeCap: 3 });
    expect(out.truncated).toBe(false);                                            // 2 linked < cap 3
    expect(new Set(out.rows.tables.map((t) => t.database)).has('b')).toBe(true);  // cross-DB walk reached b
  });

  it('loads a multi-database frontier concurrently in one round', async () => {
    const ctx = ctxWith((url, init) => {
      const sql = init.body;
      if (/EXPLAIN AST/.test(sql) || /system\.dictionaries/.test(sql)) return jsonResp({ data: [] });
      if (/database = 'a'/.test(sql)) return jsonResp({ data: [tbl('a', 't', 'MergeTree', { dependencies_database: ['b', 'c'], dependencies_table: ['mb', 'mc'] })] });
      if (/database = 'b'/.test(sql)) return jsonResp({ data: [tbl('b', 'mb', 'MergeTree')] });
      if (/database = 'c'/.test(sql)) return jsonResp({ data: [tbl('c', 'mc', 'MergeTree')] });
      return jsonResp({ data: [] });
    });
    const out = await loadLineageTransitive(ctx, { db: 'a' });
    const dbs = new Set(out.rows.tables.map((t) => t.database));
    expect(dbs.has('b') && dbs.has('c')).toBe(true); // both external dbs pulled in
    expect(out.truncated).toBe(false);
  });

  it('returns empty rows for a missing focus db', async () => {
    const ctx = ctxWith(() => { throw new Error('should not fetch'); });
    expect(await loadLineageTransitive(ctx, {})).toEqual({ rows: { tables: [], dictionaries: [] }, truncated: false });
  });
});

describe('loadTableDetail', () => {
  it('returns columns (with comments), per-partition sums, DDL, and the table comment (best-effort)', async () => {
    const ctx = ctxWith((url, init) => {
      const sql = init.body;
      if (/system\.parts/.test(sql)) return jsonResp({ data: [{ partition: '2024', parts: 3, rows: 100, bytes: 5000 }] });
      if (/create_table_query/.test(sql)) return jsonResp({ data: [{ ddl: 'CREATE TABLE a.t (id UInt64) ENGINE = MergeTree', comment: 'ids table' }] });
      return jsonResp({ data: [{ name: 'id', type: 'UInt64', comment: 'the id', is_in_primary_key: 1, position: 1 }] });
    });
    const d = await loadTableDetail(ctx, 'a', 't');
    expect(d.columns).toHaveLength(1);
    expect(d.columns[0].comment).toBe('the id');
    expect(d.partitions[0].partition).toBe('2024');
    expect(d.ddl).toContain('CREATE TABLE');
    expect(d.comment).toBe('ids table');
  });
  it('degrades to empty arrays + empty DDL/comment when the system tables are denied', async () => {
    const ctx = ctxWith(() => jsonResp('Code: 497', false, 500));
    expect(await loadTableDetail(ctx, 'a', 't')).toEqual({ columns: [], partitions: [], ddl: '', comment: '' });
  });
  it('requests data-lake-catalog visibility on system.columns/system.tables (#122 — Iceberg tables\' columns/DDL otherwise hidden)', async () => {
    const seen = [];
    const ctx = ctxWith((url, init) => {
      seen.push(init.body);
      return jsonResp({ data: [] });
    });
    await loadTableDetail(ctx, 'ice', 'orders');
    const colSql = seen.find((s) => /FROM system\.columns/.test(s));
    const ddlSql = seen.find((s) => /create_table_query/.test(s));
    expect(colSql).toContain('SETTINGS show_data_lake_catalogs_in_system_tables = 1');
    expect(ddlSql).toContain('SETTINGS show_data_lake_catalogs_in_system_tables = 1');
  });
  it('falls back to the plain system.columns/system.tables queries when an older ClickHouse rejects the setting', async () => {
    const ctx = ctxWith((url, init) => {
      const sql = init.body;
      if (/system\.parts/.test(sql)) return jsonResp({ data: [] });
      if (sql.includes('SETTINGS show_data_lake_catalogs_in_system_tables')) return textResp('Unknown setting', false, 500);
      if (/create_table_query/.test(sql)) return jsonResp({ data: [{ ddl: 'CREATE TABLE ice.orders ...', comment: '' }] });
      return jsonResp({ data: [{ name: 'id', type: 'Int64', comment: '' }] });
    });
    const d = await loadTableDetail(ctx, 'ice', 'orders');
    expect(d.columns).toHaveLength(1);
    expect(d.ddl).toContain('CREATE TABLE');
  });
});
