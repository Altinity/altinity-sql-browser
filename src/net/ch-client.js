// ClickHouse HTTP client. The app talks to ClickHouse same-origin: queries are
// POSTed to `/` with the OAuth bearer in the Authorization header, and CH
// validates the JWT via its token_processor (or a delegated verifier).
//
// All side effects are injected through a `ctx`:
//   { fetch, origin, getToken(): Promise<string|null>, refresh(): Promise<bool>,
//     onSignedOut() }
// so the whole module is unit-testable with plain stubs.

import { parseExceptionText, isAuthExpiredBody, authDeniedMessage } from '../core/stream.js';
import { parseAstTables } from '../core/schema-graph.js';

/** Build a ClickHouse HTTP URL with query-string options. Pure. */
export function chUrl(origin, opts = {}) {
  const format = opts.format || 'JSONStringsEachRowWithProgress';
  let url = origin + '?default_format=' + format + '&enable_http_compression=1';
  for (const [k, v] of Object.entries(opts.extra || {})) {
    url += '&' + k + '=' + encodeURIComponent(v);
  }
  for (const [k, v] of Object.entries(opts.params || {})) {
    url += '&' + k + '=' + encodeURIComponent(v);
  }
  return url;
}

/**
 * POST `sql` to ClickHouse with one automatic token-refresh retry. Resolves to
 * the raw Response. Throws Error('signed out') after calling ctx.onSignedOut()
 * when authentication cannot be recovered.
 */
export async function authedFetch(ctx, url, sql, signal) {
  const token = await ctx.getToken();
  if (!token) {
    ctx.onSignedOut();
    throw new Error('not signed in');
  }
  let bearer = token;
  let attempt = 0;
  // ctx.authHeader(token) lets the app pick the scheme (Bearer vs Basic);
  // default to Bearer so the seam stays optional.
  const authHeader = ctx.authHeader || ((t) => 'Bearer ' + t);
  for (;;) {
    const resp = await ctx.fetch(url, {
      method: 'POST',
      body: sql,
      headers: { Authorization: authHeader(bearer) },
      signal,
    });
    // A 2xx confirms the credentials are good for the rest of the session.
    if (resp.ok) ctx.authConfirmed = true;
    let authExpired = resp.status === 401 || resp.status === 403;
    if (!authExpired && !resp.ok) {
      const peek = await resp.clone().text();
      if (isAuthExpiredBody(peek)) authExpired = true;
    }
    if (authExpired) {
      // Once this session has authenticated successfully, the same credentials
      // are still valid — so a later 401/403 is a *query-level* error ClickHouse
      // maps to that HTTP status (ACCESS_DENIED, or UNKNOWN_USER from e.g.
      // `SHOW CREATE USER <missing>`), not a sign-in problem. Return it so the
      // caller shows it as a normal query error instead of force-logging-out.
      if (ctx.authConfirmed) return resp;
      if (attempt === 0 && (await ctx.refresh())) {
        bearer = await ctx.getToken();
        attempt++;
        continue;
      }
      // First-contact 401/403 with a non-expired token: CH rejected the login
      // itself — an authorization/identity problem, not session expiry. Surface
      // CH's own reason so it's diagnosable.
      const reason = parseExceptionText(await resp.clone().text());
      ctx.onSignedOut(authDeniedMessage(resp.status, reason));
      throw new Error('signed out');
    }
    return resp;
  }
}

/** Run a query and return parsed JSON (FORMAT JSON). Throws on CH error. */
export async function queryJson(ctx, sql) {
  const resp = await authedFetch(ctx, chUrl(ctx.origin, { format: 'JSON' }), sql);
  if (!resp.ok) throw new Error(parseExceptionText(await resp.text()));
  return resp.json();
}

/**
 * Best-effort `KILL QUERY` for the given query_id (the client also aborts the
 * stream; this stops the server-side work). Swallows errors — cancellation must
 * never throw at the call site, and the user lacking the privilege is non-fatal.
 */
export async function killQuery(ctx, queryId, sqlString) {
  if (!queryId) return;
  try {
    await queryJson(ctx, 'KILL QUERY WHERE query_id = ' + sqlString(queryId) + ' ASYNC');
  } catch { /* best-effort */ }
}

/** Fetch `version()` + `uptime()`. Returns the version string ('' on shape miss). */
export async function loadServerVersion(ctx) {
  const json = await queryJson(ctx, 'SELECT version() AS v, uptime() AS u FORMAT JSON');
  const row = (json.data && json.data[0]) || {};
  return row.v || '';
}

/**
 * Load the table list grouped by database (excludes system schemas).
 * Returns [{ db, expanded, tables: [{name,total_rows,total_bytes,comment,columns:null}] }].
 */
export async function loadSchema(ctx) {
  const sql =
    'SELECT database, name, toUInt64(total_rows) AS total_rows, ' +
    'toUInt64(total_bytes) AS total_bytes, comment\n' +
    'FROM system.tables\n' +
    "WHERE database NOT IN ('INFORMATION_SCHEMA','information_schema','system')\n" +
    'ORDER BY database, name\n' +
    'FORMAT JSON';
  const json = await queryJson(ctx, sql);
  const byDb = new Map();
  for (const r of json.data || []) {
    if (!byDb.has(r.database)) byDb.set(r.database, []);
    byDb.get(r.database).push({
      name: r.name,
      total_rows: r.total_rows,
      total_bytes: r.total_bytes,
      comment: r.comment || '',
      columns: null,
    });
  }
  return [...byDb.entries()].map(([db, tables]) => ({ db, expanded: false, tables }));
}

/**
 * Load object-lineage rows for a database: the `system.tables` columns the graph
 * builder needs + `system.dictionaries` sources, and (for views/MVs) the
 * `EXPLAIN AST` source tables attached as `row.astTables`. `target_database`/
 * `target_table` are intentionally not selected — they're a ClickHouse-Cloud-only
 * column (absent on OSS/Altinity builds), so the MV target is parsed from
 * `create_table_query` in `buildSchemaGraph`. Returns `{ tables, dictionaries }`.
 */
export async function loadSchemaLineage(ctx, focus) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const db = (focus && focus.db) || '';
  const cols = 'database, name, engine, engine_full, create_table_query, as_select, '
    + 'toString(uuid) AS uuid, dependencies_database, dependencies_table, '
    + 'loading_dependencies_database, loading_dependencies_table';
  const tablesJson = await queryJson(ctx, `SELECT ${cols} FROM system.tables WHERE database = ${q(db)} ORDER BY name`);
  const tables = tablesJson.data || [];
  const dictsJson = await queryJson(ctx, `SELECT database, name, source FROM system.dictionaries WHERE database = ${q(db)}`);
  const dictionaries = dictsJson.data || [];
  // Robust source extraction for views/MVs: let ClickHouse parse the SELECT.
  await Promise.all(tables.map(async (t) => {
    if (!t.as_select || (t.engine !== 'View' && t.engine !== 'MaterializedView')) return;
    try {
      const ast = await queryJson(ctx, 'EXPLAIN AST ' + t.as_select);
      t.astTables = parseAstTables((ast.data || []).map((r) => r.explain).join('\n'));
    } catch { /* best-effort — leave astTables undefined */ }
  }));
  return { tables, dictionaries };
}

/** Load the columns of one table. Returns [{name,type,comment}]. */
export async function loadColumns(ctx, db, table, sqlString) {
  const sql =
    'SELECT name, type, comment FROM system.columns ' +
    'WHERE database = ' + sqlString(db) + ' AND table = ' + sqlString(table) + ' ' +
    'ORDER BY position FORMAT JSON';
  const json = await queryJson(ctx, sql);
  return (json.data || []).map((r) => ({ name: r.name, type: r.type, comment: r.comment || '' }));
}

// Run a query for its `data` rows, returning null on ANY error. Editor
// reference data is best-effort: a missing system table on older ClickHouse (or
// a denied SELECT) must degrade gracefully, never surface as a query error.
async function tryQueryData(ctx, sql) {
  try {
    const json = await queryJson(ctx, sql);
    return json.data || [];
  } catch {
    return null;
  }
}

// First non-empty line of a (possibly multi-line / Markdown) cell, trimmed.
// ClickHouse doc cells (system.functions.syntax/description) frequently begin
// with a blank line, so skip leading empties and return the first line that
// actually has content — taking the literal first line yields '' for them.
function firstLine(s) {
  if (!s) return '';
  for (const line of String(s).split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

/**
 * Load editor reference data once per connection: the server's keyword list and
 * function metadata (name, kind, and — where the server exposes it — the
 * `syntax` signature for signature help, #27), so highlighting + autocomplete +
 * signature help are version-correct. This is the only *bulk* reference fetch;
 * everything then runs off this in-memory data, never a query per keystroke (the
 * keystroke rule, #25). Hover descriptions are NOT loaded here — they are large
 * and most are never read — they're fetched on demand per entity and cached
 * (loadEntityDoc, #27). Each source is best-effort; a missing/denied system
 * table yields null for that piece and the caller (assembleReferenceData) falls
 * back to the built-in set.
 * Returns { keywords, functions, formats } — each null when its source is
 * missing/denied (the caller falls back to a built-in set).
 */
export async function loadReferenceData(ctx) {
  const kw = await tryQueryData(ctx, 'SELECT keyword FROM system.keywords FORMAT JSON');
  const keywords = kw ? kw.map((r) => r.keyword) : null;
  // Prefer the `syntax` column (modern ClickHouse) for signature help; fall back
  // to the minimal shape when it doesn't exist (older servers) so we still get
  // names for highlighting + completion.
  const fn = await tryQueryData(ctx, 'SELECT name, is_aggregate, syntax FROM system.functions FORMAT JSON')
    || await tryQueryData(ctx, 'SELECT name, is_aggregate FROM system.functions FORMAT JSON');
  let functions = null;
  if (fn) {
    functions = {};
    for (const r of fn) {
      functions[r.name] = {
        kind: r.is_aggregate ? 'agg' : 'fn',
        sig: firstLine(r.syntax) || r.name + '()',
        ret: '',
        desc: '', // hover docs are fetched lazily per entity + cached (loadEntityDoc, #27)
      };
    }
  }
  // Output format names for FORMAT-clause completion (system.formats); a separate
  // catalog from keywords/functions, so it needs its own fetch.
  const fmts = await tryQueryData(ctx, 'SELECT name FROM system.formats WHERE is_output ORDER BY name FORMAT JSON');
  const formats = fmts ? fmts.map((r) => r.name) : null;
  return { keywords, functions, formats };
}

/**
 * Fetch one function's documentation on demand for hover docs (#27). Kept OUT of
 * the bulk reference load: descriptions are large and most are never hovered, so
 * loading every one would bloat connect time. The caller (app.entityDoc) caches
 * the result so each entity is queried at most once per connection. Returns the
 * first non-empty line (CH descriptions begin with a blank line), `''` when the
 * query SUCCEEDS but there's no description (unknown name / older server / blank),
 * or `null` when the query itself FAILED — so the caller can cache the former but
 * retry the latter rather than sticking a transient error (#8 review).
 */
export async function loadEntityDoc(ctx, name, sqlString) {
  const rows = await tryQueryData(
    ctx,
    'SELECT description FROM system.functions WHERE name = ' + sqlString(name) + ' LIMIT 1 FORMAT JSON',
  );
  if (rows === null) return null;                  // query failed → retryable, don't cache
  return rows[0] ? firstLine(rows[0].description) : ''; // succeeded → '' means genuinely no doc
}

/**
 * Run a query in streaming mode (JSONStringsEachRowWithProgress) or raw mode
 * (TSV/JSON). `onLine(parsedObj)` is called per stream object in streaming
 * mode; `onRaw(text)` once for raw mode. Returns { error } or { raw } shape via
 * the result object the caller passes in `apply`.
 *
 * @param ctx
 * @param sql
 * @param o  { format, signal, onLine(json), onChunk(), onRaw(text) }
 */
export async function runQuery(ctx, sql, o = {}) {
  const fmt = o.format || 'Table';
  const isStreaming = fmt === 'Table';
  // Streaming gets the progress-bearing JSON; raw mode sends the requested format
  // verbatim as default_format (a real ClickHouse format name from a FORMAT clause
  // or an implicit EXPLAIN). 'TSV' keeps its with-names-and-types expansion.
  const fmtParam = isStreaming
    ? 'JSONStringsEachRowWithProgress'
    : fmt === 'TSV'
      ? 'TabSeparatedWithNamesAndTypes'
      : fmt;
  const url = chUrl(ctx.origin, {
    format: fmtParam,
    // wait_end_of_query buffers the whole response server-side so the HTTP
    // status reflects errors — but it defeats progressive streaming (first rows
    // wait for the query to finish: ~16s vs ~0.5s on a 1.3M-row scan). Keep it
    // only for raw modes (read whole anyway); the streaming Table path drops it
    // and surfaces mid-stream errors via the in-band `exception` line instead.
    extra: { ...(isStreaming ? {} : { wait_end_of_query: 1 }), add_http_cors_header: 1 },
    // Tagging the request with a query_id lets Cancel issue KILL QUERY for it.
    params: o.queryId ? { query_id: o.queryId } : {},
  });
  const resp = await authedFetch(ctx, url, sql, o.signal);

  if (!resp.ok) {
    return { error: parseExceptionText(await resp.text()) };
  }
  if (!isStreaming) {
    return { raw: await resp.text() };
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines[lines.length - 1];
    for (const line of lines.slice(0, -1)) {
      if (!line) continue;
      let json;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      o.onLine && o.onLine(json);
    }
    o.onChunk && o.onChunk();
  }
  if (buffer.trim()) {
    try {
      o.onLine && o.onLine(JSON.parse(buffer));
    } catch {
      /* trailing partial line */
    }
  }
  return { streamed: true };
}
