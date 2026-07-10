// ClickHouse HTTP client. The app talks to ClickHouse same-origin: queries are
// POSTed to `/` with the OAuth bearer in the Authorization header, and CH
// validates the JWT via its token_processor (or a delegated verifier).
//
// All side effects are injected through a `ctx`:
//   { fetch, origin, getToken(): Promise<string|null>, refresh(): Promise<bool>,
//     onSignedOut() }
// so the whole module is unit-testable with plain stubs.

import { parseExceptionText, isAuthExpiredBody, authDeniedMessage } from '../core/stream.js';
import { parseAstTables, buildSchemaGraph, externalDbs } from '../core/schema-graph.js';
import { sqlString } from '../core/format.js';

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

/**
 * Run a query and return parsed JSON (FORMAT JSON). Throws on CH error. `signal`
 * (optional) aborts the request. `extra` (optional) adds HTTP query-string
 * settings (e.g. `{ readonly: 2 }` for a read-only tile). `params` (optional)
 * adds `param_<name>` query-string args for native ClickHouse query parameters
 * (#134) — omitted for every existing call site, so this is backward compatible.
 */
export async function queryJson(ctx, sql, signal, extra, params) {
  const resp = await authedFetch(ctx, chUrl(ctx.origin, { format: 'JSON', extra, params }), sql, signal);
  if (!resp.ok) throw new Error(parseExceptionText(await resp.text()));
  return resp.json();
}

/**
 * Run a favorite's SQL for a read-only dashboard tile (#149): `FORMAT JSON` plus
 * the `readonly=2` HTTP setting, so a favorite that happens to contain a write
 * (INSERT / ALTER / DROP / …) is rejected server-side rather than executed when
 * the dashboard opens or refreshes — level 2 still permits SELECT and
 * query-level `SETTINGS`. `params` (optional, #149 D3) forwards `param_<name>`
 * args for the dashboard's global filter bar. Returns parsed JSON; throws CH's
 * reason on error.
 */
export function queryDashboardTile(ctx, sql, signal, params) {
  return queryJson(ctx, sql, signal, { readonly: 2 }, params);
}

/**
 * Run a `system.tables`/`system.columns` query (`sqlBody`, without its FORMAT
 * clause) with data-lake-catalog visibility enabled, falling back to the plain
 * query only when the setting itself is unsupported. ClickHouse >=25.8 hides
 * DataLakeCatalog-backed databases (Iceberg/Glue/Unity/HMS/REST catalogs) from
 * `system.tables` and `system.columns` unless
 * `show_data_lake_catalogs_in_system_tables = 1` is set (renamed to
 * `show_remote_databases_in_system_tables` in 26.6, old name kept as an
 * alias) — so without this, the schema browser and table browser silently show
 * zero rows for those databases (#122). Servers older than 25.8 don't have the
 * setting and throw "Unknown setting"; the fallback keeps them working exactly
 * as before. Once that fallback happens, `ctx.dataLakeCatalogSettingUnsupported`
 * latches so every later call on this connection (schema loads, table
 * expands, lineage BFS) goes straight to the plain query instead of paying a
 * doomed extra round trip forever — the same one-shot-then-remember shape as
 * `ctx.authConfirmed` in `authedFetch`.
 *
 * Any OTHER error (e.g. a per-table Iceberg/Glue metadata failure inside the
 * catalog itself — ClickHouse's `system.tables` aborts the whole query for a
 * catalog database the instant any column beyond `database`/`name` surfaces
 * one unresolvable table; see ClickHouse/ClickHouse#110032 and #162) is
 * rethrown, never latched: it says nothing about whether the *setting* is
 * supported, and latching on it would incorrectly disable catalog visibility
 * for every other (unrelated, healthy) catalog for the rest of the session.
 * Callers that query a single data-lake-catalog database (`loadSchema`) treat
 * that rethrown error as a per-database, best-effort failure instead.
 *
 * Two error classes are rethrown immediately, before that check: a
 * caller-aborted signal (matching `tryQueryData`'s cancellation contract), and
 * 'not signed in' / 'signed out' — `authedFetch` has already exhausted its own
 * retry and called `ctx.onSignedOut()` for those, so retrying here would just
 * repeat the whole token/refresh/sign-out handshake (and its side effects) a
 * second time for no benefit.
 */
async function querySystemAware(ctx, sqlBody, signal) {
  const plain = () => queryJson(ctx, sqlBody + '\nFORMAT JSON', signal);
  if (ctx.dataLakeCatalogSettingUnsupported) return plain();
  try {
    return await queryJson(ctx, sqlBody + '\nSETTINGS show_data_lake_catalogs_in_system_tables = 1\nFORMAT JSON', signal);
  } catch (e) {
    if (signal && signal.aborted && e && e.name === 'AbortError') throw e;
    if (e && (e.message === 'not signed in' || e.message === 'signed out')) throw e;
    if (!(e && /Unknown setting/i.test(e.message))) throw e;
    ctx.dataLakeCatalogSettingUnsupported = true;
    return plain();
  }
}

/**
 * List table names for one `DataLakeCatalog`-engine database (Iceberg/Glue/…),
 * requesting only `database, name`. ClickHouse's `system.tables` has a fast
 * path for exactly those two columns that never opens each table's storage
 * object — so, unlike any query that also asks for `total_rows`/`total_bytes`/
 * `comment`, one broken/unresolvable table in the catalog can't abort or
 * silently truncate the listing (ClickHouse/ClickHouse#110032, found via #162:
 * an unrelated bad table hid a perfectly healthy catalog's tables entirely).
 * Row/byte stats and comments genuinely aren't available this way for
 * data-lake-catalog tables — `loadSchema` fills those in as zero/empty rather
 * than trying to fetch them.
 *
 * Best-effort: a failure here (e.g. a wholly unreachable catalog endpoint, or
 * — pre-25.8 — a rejected `show_data_lake_catalogs_in_system_tables` setting
 * that isn't itself the "unknown setting" case `querySystemAware` already
 * handles) shows this one database as empty rather than failing the whole
 * schema load or, via `ctx.dataLakeCatalogSettingUnsupported`, hiding every
 * other catalog too.
 */
async function loadDataLakeCatalogTableNames(ctx, db) {
  try {
    const json = await querySystemAware(ctx, `SELECT database, name FROM system.tables WHERE database = ${sqlString(db)}`);
    return (json.data || []).map((r) => r.name);
  } catch {
    return [];
  }
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

/** `startsWith('_')`-then-name ordering, matching the `system.tables` `ORDER BY`. Pure. */
export function byUnderscoreThenName(a, b) {
  const au = a.startsWith('_');
  const bu = b.startsWith('_');
  if (au !== bu) return au ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Load the table list grouped by database. `system` is included (handy for
 * dashboards/diagnostics); the redundant INFORMATION_SCHEMA views stay filtered.
 * Databases are enumerated from `system.databases` (not derived from
 * `system.tables`) so a freshly created, still-empty database shows up too.
 *
 * `DataLakeCatalog`-engine databases (Iceberg/Glue/Unity/HMS/REST catalogs) are
 * queried separately from everything else, one request per catalog database,
 * via `loadDataLakeCatalogTableNames` — seeing #162/ClickHouse#110032's
 * docstrings for why: a single query across every database, once any catalog
 * table is broken, either aborts entirely or silently drops tables depending
 * on `database_datalake_require_metadata_access`. Their `total_rows`/
 * `total_bytes`/`comment` are zero/empty rather than fetched — not available
 * without hitting that failure mode.
 *
 * Returns [{ db, comment, expanded, tables: [{name,total_rows,total_bytes,comment,columns:null}] }].
 */
export async function loadSchema(ctx) {
  const dbJson = await queryJson(ctx,
    "SELECT name, comment, engine FROM system.databases\n" +
    "WHERE name NOT IN ('INFORMATION_SCHEMA','information_schema')\n" +
    'ORDER BY name\n' +
    'FORMAT JSON');
  const dbRows = dbJson.data || [];
  const catalogDbs = dbRows.filter((r) => r.engine === 'DataLakeCatalog').map((r) => r.name);
  const exclude = ['INFORMATION_SCHEMA', 'information_schema', ...catalogDbs].map(sqlString).join(', ');

  const [tblJson, catalogTables] = await Promise.all([
    queryJson(ctx,
      'SELECT database, name, toUInt64(total_rows) AS total_rows, ' +
      'toUInt64(total_bytes) AS total_bytes, comment\n' +
      'FROM system.tables\n' +
      `WHERE database NOT IN (${exclude})\n` +
      "ORDER BY database, startsWith(name, '_'), name\n" +
      'FORMAT JSON'),
    Promise.all(catalogDbs.map(async (db) => ({ db, names: await loadDataLakeCatalogTableNames(ctx, db) }))),
  ]);
  const byDb = new Map();
  for (const r of dbRows) byDb.set(r.name, { comment: r.comment || '', tables: [] });
  for (const r of tblJson.data || []) {
    if (!byDb.has(r.database)) byDb.set(r.database, { comment: '', tables: [] });
    byDb.get(r.database).tables.push({
      name: r.name,
      total_rows: r.total_rows,
      total_bytes: r.total_bytes,
      comment: r.comment || '',
      columns: null,
    });
  }
  for (const { db, names } of catalogTables) {
    // db is always already a byDb key here: catalogDbs (and so catalogTables'
    // db) comes from dbRows itself, unlike r.database above — that one comes
    // from system.tables, which can legitimately name a database
    // system.databases doesn't list.
    const entry = byDb.get(db);
    for (const name of [...names].sort(byUnderscoreThenName)) {
      entry.tables.push({ name, total_rows: 0, total_bytes: 0, comment: '', columns: null });
    }
  }
  return [...byDb.entries()].map(([db, v]) => ({ db, comment: v.comment, expanded: false, tables: v.tables }));
}

// Below this many view/MV objects needing `EXPLAIN AST`, a visible free-edges-
// first paint is just flicker — the fan-out settles fast enough on a small
// schema that nobody perceives two draws, only a redraw. `loadSchemaLineage`
// skips `onBase`/`onProgress` entirely below the threshold so the caller does
// one single, final draw instead (matching the pre-progressive-draw behavior).
export const AST_PROGRESSIVE_THRESHOLD = 50;

/**
 * Load object-lineage rows for a database: the `system.tables` columns the graph
 * builder needs + `system.dictionaries` sources, and (for views/MVs) the
 * `EXPLAIN AST` source tables attached as `row.astTables`. `target_database`/
 * `target_table` are intentionally not selected — they're a ClickHouse-Cloud-only
 * column (absent on OSS/Altinity builds), so the MV target is parsed from
 * `create_table_query` in `buildSchemaGraph`. Returns `{ tables, dictionaries }`.
 *
 * `opts.signal` cancels every underlying request (including the best-effort
 * `system.dictionaries` read — an abort there propagates as a rejection of the
 * whole call, not a silent "no dictionaries"; see `tryQueryData`).
 * `opts.onBase({tables, dictionaries})` fires as soon as the free data (no
 * `EXPLAIN AST` needed) is known — the caller can draw a first-pass graph from
 * it (issue #124's progressive draw) before the per-view/MV source resolution
 * below even starts. `opts.onProgress(done, total)` fires as each `EXPLAIN AST`
 * settles (success or best-effort failure), for a "resolving N/M…" indicator.
 * Both are skipped when fewer than `opts.progressiveThreshold` (default
 * `AST_PROGRESSIVE_THRESHOLD`) objects need `EXPLAIN AST` — see the constant's
 * comment.
 */
export async function loadSchemaLineage(ctx, focus, opts = {}) {
  const { signal, onBase, onProgress, progressiveThreshold = AST_PROGRESSIVE_THRESHOLD } = opts;
  const db = (focus && focus.db) || '';
  const cols = 'database, name, engine, engine_full, create_table_query, as_select, '
    + 'toString(uuid) AS uuid, dependencies_database, dependencies_table, '
    + 'loading_dependencies_database, loading_dependencies_table, comment, '
    // Card metadata (ignored by the inline graph; used by the rich fullscreen cards).
    + 'toUInt64(ifNull(total_rows, 0)) AS total_rows, toUInt64(ifNull(total_bytes, 0)) AS total_bytes, '
    + 'partition_key, sorting_key, primary_key, sampling_key';
  const tablesJson = await querySystemAware(ctx, `SELECT ${cols} FROM system.tables WHERE database = ${sqlString(db)} ORDER BY startsWith(name, '_'), name`, signal);
  const tables = tablesJson.data || [];
  // Best-effort: a denied/missing system.dictionaries (low-priv users lack
  // SELECT on it) must degrade to no dictionary edges, never abort the graph —
  // but a genuine cancellation must still propagate (tryQueryData rethrows it).
  const dictionaries = await tryQueryData(ctx, `SELECT database, name, source FROM system.dictionaries WHERE database = ${sqlString(db)}`, signal) || [];
  // Robust source extraction for views/MVs: let ClickHouse parse the SELECT.
  const astTargets = tables.filter((t) => t.as_select && (t.engine === 'View' || t.engine === 'MaterializedView'));
  const total = astTargets.length;
  const progressive = total >= progressiveThreshold;
  if (progressive && onBase) onBase({ tables, dictionaries });
  let done = 0;
  await Promise.all(astTargets.map(async (t) => {
    try {
      const ast = await queryJson(ctx, 'EXPLAIN AST ' + t.as_select, signal);
      t.astTables = parseAstTables((ast.data || []).map((r) => r.explain).join('\n'));
    } catch (e) {
      if (signal && signal.aborted && e && e.name === 'AbortError') throw e;
      /* best-effort — leave astTables undefined */
    } finally {
      done++;
      if (progressive && onProgress) onProgress(done, total);
    }
  }));
  return { tables, dictionaries };
}

/** Load the columns of one table. Returns [{name,type,comment}]. */
export async function loadColumns(ctx, db, table, sqlString) {
  const sql =
    'SELECT name, type, comment FROM system.columns ' +
    'WHERE database = ' + sqlString(db) + ' AND table = ' + sqlString(table) + ' ' +
    'ORDER BY position';
  const json = await querySystemAware(ctx, sql);
  return (json.data || []).map((r) => ({ name: r.name, type: r.type, comment: r.comment || '' }));
}

/**
 * Load the rich-card metadata (columns with key-role flags + skip indices) for a
 * set of databases, keyed by `db.table`. Best-effort via tryQueryData: a missing
 * system table or denied SELECT degrades to an empty map (cards then show just the
 * engine/rows/bytes header — no badges/skip line), never a query error. Returns
 * `{ columnsByKey, skipByKey }`.
 */
export async function loadSchemaCards(ctx, dbs) {
  const columnsByKey = {};
  const skipByKey = {};
  const list = (dbs || []).map((d) => sqlString(d)).join(', ');
  if (!list) return { columnsByKey, skipByKey };
  // The two reads are independent — run them concurrently (one server round-trip
  // of wall-clock instead of two).
  const [colRows, idxRows] = await Promise.all([
    trySystemAwareQueryData(ctx,
      'SELECT database, table, name, type, is_in_partition_key, is_in_sorting_key, '
      + 'is_in_primary_key, is_in_sampling_key, compression_codec, position '
      + 'FROM system.columns WHERE database IN (' + list + ') ORDER BY database, table, position'),
    tryQueryData(ctx,
      'SELECT database, table, name, type, expr FROM system.data_skipping_indices '
      + 'WHERE database IN (' + list + ') FORMAT JSON'),
  ]);
  for (const r of colRows || []) {
    const key = r.database + '.' + r.table;
    (columnsByKey[key] = columnsByKey[key] || []).push(r);
  }
  for (const r of idxRows || []) {
    const key = r.database + '.' + r.table;
    (skipByKey[key] = skipByKey[key] || []).push(r);
  }
  return { columnsByKey, skipByKey };
}

/**
 * Load lineage rows transitively across database boundaries: start at `focus.db`,
 * then BFS into every database referenced by the graph built so far, merging rows,
 * until no new database is referenced or a cap is hit. `opts.dbCap` bounds the
 * number of databases fetched and `opts.nodeCap` the graph size — either tripping
 * sets `truncated` (the caller shows a banner). Returns `{ rows, truncated }`;
 * `rows` is the merged `{ tables, dictionaries }` for buildSchemaGraph + expandLineage.
 */
export async function loadLineageTransitive(ctx, focus, opts = {}) {
  const nodeCap = opts.nodeCap != null ? opts.nodeCap : 600;
  const dbCap = opts.dbCap != null ? opts.dbCap : 8;
  const seed = (focus && focus.db) || '';
  const loaded = new Set();
  let frontier = seed ? [seed] : [];
  let tables = [];
  let dictionaries = [];
  let truncated = false;
  while (frontier.length) {
    if (loaded.size >= dbCap) { truncated = true; break; }
    // Load the whole frontier concurrently (bounded by the remaining db budget),
    // rebuild the graph once per round, then take its newly-referenced dbs as the
    // next frontier. Far fewer round-trips than fetching one db at a time.
    const batch = frontier.slice(0, dbCap - loaded.size);
    batch.forEach((db) => loaded.add(db));
    const parts = await Promise.all(batch.map((db) => loadSchemaLineage(ctx, { db })));
    for (const part of parts) {
      tables = tables.concat(part.tables);
      dictionaries = dictionaries.concat(part.dictionaries);
    }
    const graph = buildSchemaGraph({ tables, dictionaries });
    // Cap on the *lineage* size — count only nodes that participate in an edge.
    // Standalone tables are cheap to render and never drive cross-DB expansion, so
    // they must not trip the cap (a single big DB of mostly-unrelated tables would
    // otherwise truncate on the first round, before its few links are followed).
    const linked = new Set();
    for (const e of graph.edges) { linked.add(e.from); linked.add(e.to); }
    if (linked.size >= nodeCap) { truncated = true; break; }
    frontier = externalDbs(graph, loaded);
  }
  return { rows: { tables, dictionaries }, truncated };
}

/**
 * Per-table detail for the node detail pane: full columns (with key-role flags,
 * per-column comments + compression sizes), per-partition part/row/byte sums, the
 * table's own comment, and the DDL. All reads are best-effort (a denied/missing
 * system table degrades to empty, never an error); the system.columns/system.tables
 * reads also see DataLakeCatalog-backed tables (#122) via trySystemAwareQueryData.
 * Returns `{ columns, partitions, ddl, comment }`.
 */
export async function loadTableDetail(ctx, db, table) {
  const byCol = 'database = ' + sqlString(db) + ' AND table = ' + sqlString(table);
  const byName = 'database = ' + sqlString(db) + ' AND name = ' + sqlString(table);
  const [columns, partitions, tableRows] = await Promise.all([
    trySystemAwareQueryData(ctx,
      'SELECT name, type, compression_codec AS codec, comment, '
      + 'is_in_partition_key, is_in_sorting_key, is_in_primary_key, is_in_sampling_key, '
      + 'toUInt64(data_compressed_bytes) AS compressed, toUInt64(data_uncompressed_bytes) AS uncompressed, '
      + 'toUInt64(marks_bytes) AS marks, position '
      + 'FROM system.columns WHERE ' + byCol + ' ORDER BY position'),
    tryQueryData(ctx,
      'SELECT partition, count() AS parts, sum(rows) AS rows, sum(bytes_on_disk) AS bytes '
      + 'FROM system.parts WHERE ' + byCol + ' AND active GROUP BY partition ORDER BY partition FORMAT JSON'),
    trySystemAwareQueryData(ctx, 'SELECT create_table_query AS ddl, comment FROM system.tables WHERE ' + byName),
  ]);
  return {
    columns: columns || [],
    partitions: partitions || [],
    ddl: (tableRows && tableRows[0] && tableRows[0].ddl) || '',
    comment: (tableRows && tableRows[0] && tableRows[0].comment) || '',
  };
}

// Run `runner(ctx, sql, signal)` for its `data` rows, returning null on ANY
// error EXCEPT a cancellation of a caller-supplied signal. Editor reference
// data / schema-lineage best-effort reads are meant to degrade gracefully on
// a missing system table or a denied SELECT — but when the caller passed a
// `signal` and aborted it, that means the caller's whole operation was
// cancelled, not that this particular sub-query failed, so it must propagate
// rather than be swallowed into "no data, continue" (#124). Gated on
// `signal.aborted` (not just the error's name) so a caller that never passed
// a signal — every site except `loadSchemaLineage` — keeps today's
// unconditional swallow, even if the underlying fetch happens to throw an
// AbortError-shaped error for some unrelated reason.
async function tryRun(runner, ctx, sql, signal) {
  try {
    const json = await runner(ctx, sql, signal);
    return json.data || [];
  } catch (e) {
    if (signal && signal.aborted && e && e.name === 'AbortError') throw e;
    return null;
  }
}

function tryQueryData(ctx, sql, signal) {
  return tryRun(queryJson, ctx, sql, signal);
}

// Same contract as tryQueryData, but via querySystemAware for best-effort
// system.tables/system.columns reads that must also see DataLakeCatalog-backed
// databases (#122).
function trySystemAwareQueryData(ctx, sqlBody, signal) {
  return tryRun(querySystemAware, ctx, sqlBody, signal);
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
 * Issue an uncapped export query and return the raw streaming Response so the
 * caller can pipe `resp.body` straight to disk (issue #87). `format` (from
 * `prepareExportSql` — the query's own FORMAT, or TSV) is set as
 * `default_format`; the SQL's own FORMAT clause wins when present, so this only
 * matters when the caller appended one. `queryId` tags the request so cancel
 * can KILL QUERY it. No `wait_end_of_query`: that buffers the whole response
 * server-side and would defeat the point of streaming to disk (see the comment
 * on `runQuery`'s `extra` above) — a failure *after* headers is instead
 * detected by the caller from the response body (findExceptionFrame) plus the
 * `X-ClickHouse-Exception-Tag` header. A failure *before* headers throws the
 * parsed CH exception, same as `queryJson`. `params` rides alongside query_id
 * (the caller passes the tab's `sessionParamsFor` so an export that depends on
 * an earlier `CREATE TEMPORARY TABLE` / session `SET` in the same tab sees it —
 * same as `runQuery`).
 */
export async function exportQuery(ctx, sql, { queryId, signal, format, params } = {}) {
  const url = chUrl(ctx.origin, {
    format: format || 'TabSeparatedWithNames',
    params: { ...(queryId ? { query_id: queryId } : {}), ...(params || {}) },
  });
  const resp = await authedFetch(ctx, url, sql, signal);
  if (!resp.ok) throw new Error(parseExceptionText(await resp.text()));
  return resp;
}

/**
 * Run a query in streaming mode (JSONStringsEachRowWithProgress) or raw mode
 * (TSV/JSON). `onLine(parsedObj)` is called per stream object in streaming
 * mode; `onRaw(text)` once for raw mode. Returns { error } or { raw } shape via
 * the result object the caller passes in `apply`.
 *
 * @param ctx
 * @param sql
 * @param o  { format, signal, resultRowLimit, params, onLine(json), onChunk(), onRaw(text) }
 *           `resultRowLimit` caps a normal result server-side (max_result_rows +
 *           result_overflow_mode); `params` are extra query-string options that ride
 *           alongside query_id (e.g. multiquery SELECTs pass their own cap + session_id).
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
  // Cap a normal result query server-side: max_result_rows stops the read at N
  // and result_overflow_mode='break' makes ClickHouse stop cleanly at a block
  // boundary (no error, no further data pulled) rather than throwing. The caller
  // decides scope — it passes resultRowLimit for normal SELECTs (Table + explicit
  // FORMAT) and 0 for EXPLAIN/PIPELINE/ESTIMATE (which also run as 'Table', so the
  // exemption can't be told apart by format here). `break` can overshoot by up to
  // a block on the streaming path, which the applyStreamLine guard trims.
  const cap = o.resultRowLimit > 0
    ? { max_result_rows: o.resultRowLimit, result_overflow_mode: 'break' }
    : {};
  const url = chUrl(ctx.origin, {
    format: fmtParam,
    // wait_end_of_query buffers the whole response server-side so the HTTP
    // status reflects errors — but it defeats progressive streaming (first rows
    // wait for the query to finish: ~16s vs ~0.5s on a 1.3M-row scan). Keep it
    // only for raw modes (read whole anyway); the streaming Table path drops it
    // and surfaces mid-stream errors via the in-band `exception` line instead.
    extra: { ...(isStreaming ? {} : { wait_end_of_query: 1 }), ...cap, add_http_cors_header: 1 },
    // Tagging the request with a query_id lets Cancel issue KILL QUERY for it.
    // Caller-supplied params (o.params) ride alongside — e.g. multiquery SELECTs
    // add max_result_rows / result_overflow_mode to cap the result server-side.
    params: { ...(o.queryId ? { query_id: o.queryId } : {}), ...(o.params || {}) },
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
