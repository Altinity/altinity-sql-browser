// ClickHouse HTTP client. The app talks to ClickHouse same-origin: queries are
// POSTed to `/` with the OAuth bearer in the Authorization header, and CH
// validates the JWT via its token_processor (or a delegated verifier).
//
// All side effects are injected through a `ctx`:
//   { fetch, origin, getToken(): Promise<string|null>, refresh(): Promise<bool>,
//     onSignedOut() }
// so the whole module is unit-testable with plain stubs.

import { parseExceptionText, isAuthExpiredBody, authDeniedMessage } from '../core/stream.js';
import type { StreamLine } from '../core/stream.js';
import { parseAstTables, buildSchemaGraph, externalDbs } from '../core/schema-graph.js';
import type { SchemaGraphTableRow, SchemaGraphDictRow } from '../core/schema-graph.js';
import { sqlString, isBinaryFormat } from '../core/format.js';

// ── Injected ctx seam ────────────────────────────────────────────────────────

/** The injected side-effect seam every function in this module takes as its
 * first argument. `fetch`/`getToken`/`refresh`/`onSignedOut` are the app's
 * real implementations in production, plain stubs in tests. `authConfirmed`
 * and `dataLakeCatalogSettingUnsupported` are one-shot-then-remember latches
 * `authedFetch`/`querySystemAware` set on `ctx` itself (see their docstrings)
 * — optional here because they start unset. */
export interface ChCtx {
  fetch: typeof fetch;
  origin: string;
  getToken(): Promise<string | null>;
  refresh(): Promise<boolean>;
  onSignedOut(detail?: string): void;
  /** Picks the Authorization scheme (Bearer vs Basic); defaults to Bearer
   * inside `authedFetch` when absent. */
  authHeader?: (token: string) => string;
  authConfirmed?: boolean;
  dataLakeCatalogSettingUnsupported?: boolean;
}

/** The injected SQL-string-quoting function a few call sites take as a
 * parameter (matching core/format.js's `sqlString`) instead of using the
 * module-level import directly. */
type SqlStringFn = (s: unknown) => string;

// ── Small error-narrowing helpers (catch clauses are `unknown` under strict) ─

// True when `e` is the AbortError produced by a caller-supplied `signal` that
// is itself aborted — matching every `e.name === 'AbortError'` check below,
// now that a caught value's static type is `unknown`.
function isAbort(e: unknown, signal: AbortSignal | undefined): boolean {
  // Duck-typed on purpose (`e && e.name`, not `instanceof Error`): the fetch
  // seam is injected, and a shim's abort rejection may be a plain object.
  return !!(signal && signal.aborted && (e as { name?: unknown } | null)?.name === 'AbortError');
}
// `e.message` when present, else the value's stringification — the exact
// duck-typed `(e && e.message) || e` fallback of the original .js (a plain
// non-Error rejection carrying `message` must keep matching the /Unknown
// setting/ compat check below).
function errMessage(e: unknown): string {
  const message = (e as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message : String(e);
}

/** Generic ClickHouse `FORMAT JSON` response shape — only `.data` is ever
 * read here; every other field (meta, statistics, rows_before_limit_at_least…)
 * is ignored by this module. */
export interface ChJsonResult<T = Record<string, unknown>> {
  data?: T[];
}

/** `chUrl`'s query-string options. */
export interface ChUrlOpts {
  format?: string;
  extra?: Record<string, string | number>;
  params?: Record<string, string | number>;
}

/** Build a ClickHouse HTTP URL with query-string options. Pure. */
export function chUrl(origin: string, opts: ChUrlOpts = {}): string {
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
export async function authedFetch(ctx: ChCtx, url: string, sql: string, signal?: AbortSignal): Promise<Response> {
  const token = await ctx.getToken();
  if (!token) {
    ctx.onSignedOut();
    throw new Error('not signed in');
  }
  let bearer = token;
  let attempt = 0;
  // ctx.authHeader(token) lets the app pick the scheme (Bearer vs Basic);
  // default to Bearer so the seam stays optional.
  const authHeader = ctx.authHeader || ((t: string) => 'Bearer ' + t);
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
        // A successful refresh always yields a fresh, usable token — the
        // refresh() contract this seam relies on.
        bearer = (await ctx.getToken())!;
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
export async function queryJson<T = Record<string, unknown>>(
  ctx: ChCtx,
  sql: string,
  signal?: AbortSignal,
  extra?: Record<string, string | number>,
  params?: Record<string, string | number>,
): Promise<ChJsonResult<T>> {
  const resp = await authedFetch(ctx, chUrl(ctx.origin, { format: 'JSON', extra, params }), sql, signal);
  if (!resp.ok) throw new Error(parseExceptionText(await resp.text()));
  return resp.json();
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
async function querySystemAware<T = Record<string, unknown>>(ctx: ChCtx, sqlBody: string, signal?: AbortSignal): Promise<ChJsonResult<T>> {
  const plain = () => queryJson<T>(ctx, sqlBody + '\nFORMAT JSON', signal);
  if (ctx.dataLakeCatalogSettingUnsupported) return plain();
  try {
    return await queryJson<T>(ctx, sqlBody + '\nSETTINGS show_data_lake_catalogs_in_system_tables = 1\nFORMAT JSON', signal);
  } catch (e) {
    if (isAbort(e, signal)) throw e;
    if (errMessage(e) === 'not signed in' || errMessage(e) === 'signed out') throw e;
    if (!/Unknown setting/i.test(errMessage(e))) throw e;
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
async function loadDataLakeCatalogTableNames(ctx: ChCtx, db: string): Promise<string[]> {
  try {
    const json = await querySystemAware<{ name: string }>(ctx, `SELECT database, name FROM system.tables WHERE database = ${sqlString(db)}`);
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
export async function killQuery(ctx: ChCtx, queryId: string | null | undefined, sqlString: SqlStringFn): Promise<void> {
  if (!queryId) return;
  try {
    await queryJson(ctx, 'KILL QUERY WHERE query_id = ' + sqlString(queryId) + ' ASYNC');
  } catch { /* best-effort */ }
}

/** Fetch `version()` + `uptime()`. Returns the version string ('' on shape miss). */
export async function loadServerVersion(ctx: ChCtx): Promise<string> {
  const json = await queryJson<{ v?: string; u?: number }>(ctx, 'SELECT version() AS v, uptime() AS u FORMAT JSON');
  const row = (json.data && json.data[0]) || {};
  return row.v || '';
}

/** `startsWith('_')`-then-name ordering, matching the `system.tables` `ORDER BY`. Pure. */
export function byUnderscoreThenName(a: string, b: string): number {
  const au = a.startsWith('_');
  const bu = b.startsWith('_');
  if (au !== bu) return au ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One table entry in a `loadSchema` database group. */
export interface SchemaTable {
  name: string;
  total_rows: number | string;
  total_bytes: number | string;
  comment: string;
  columns: null;
}

/** One database group in `loadSchema`'s result. */
export interface SchemaDb {
  db: string;
  comment: string;
  expanded: boolean;
  tables: SchemaTable[];
}

interface DbRow { name: string; comment?: string; engine?: string }
interface TableStatsRow { database: string; name: string; total_rows: number | string; total_bytes: number | string; comment?: string }

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
export async function loadSchema(ctx: ChCtx): Promise<SchemaDb[]> {
  const dbJson = await queryJson<DbRow>(ctx,
    "SELECT name, comment, engine FROM system.databases\n" +
    "WHERE name NOT IN ('INFORMATION_SCHEMA','information_schema')\n" +
    'ORDER BY name\n' +
    'FORMAT JSON');
  const dbRows = dbJson.data || [];
  const catalogDbs = dbRows.filter((r) => r.engine === 'DataLakeCatalog').map((r) => r.name);
  const exclude = ['INFORMATION_SCHEMA', 'information_schema', ...catalogDbs].map(sqlString).join(', ');

  const [tblJson, catalogTables] = await Promise.all([
    queryJson<TableStatsRow>(ctx,
      'SELECT database, name, toUInt64(total_rows) AS total_rows, ' +
      'toUInt64(total_bytes) AS total_bytes, comment\n' +
      'FROM system.tables\n' +
      `WHERE database NOT IN (${exclude})\n` +
      "ORDER BY database, startsWith(name, '_'), name\n" +
      'FORMAT JSON'),
    Promise.all(catalogDbs.map(async (db) => ({ db, names: await loadDataLakeCatalogTableNames(ctx, db) }))),
  ]);
  const byDb = new Map<string, { comment: string; tables: SchemaTable[] }>();
  for (const r of dbRows) byDb.set(r.name, { comment: r.comment || '', tables: [] });
  for (const r of tblJson.data || []) {
    if (!byDb.has(r.database)) byDb.set(r.database, { comment: '', tables: [] });
    byDb.get(r.database)!.tables.push({
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
    const entry = byDb.get(db)!;
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

/** A schema-entity reference scoping a lineage load: `loadSchemaLineage`/
 * `loadLineageTransitive` only ever read `.db` here. */
export interface LineageFocus {
  kind?: string;
  db?: string;
  table?: string;
}

/** One `system.tables` row as read for lineage assembly, plus the
 * `EXPLAIN AST`-derived source list `loadSchemaLineage` attaches for
 * views/MVs. Extends `core/schema-graph.js`'s `SchemaGraphTableRow` (the
 * shape `buildSchemaGraph` consumes) with the columns this loader selects
 * that the graph builder itself ignores (card metadata) — narrowing the
 * inherited optional fields to required, since this query always selects
 * them. */
export interface LineageTableRow extends SchemaGraphTableRow {
  engine_full: string;
  create_table_query: string;
  as_select: string;
  uuid: string;
  dependencies_database: string[];
  dependencies_table: string[];
  loading_dependencies_database: string[];
  loading_dependencies_table: string[];
  comment: string;
  // Card metadata (ignored by the inline graph; used by the rich fullscreen cards).
  total_rows: number | string;
  total_bytes: number | string;
  partition_key: string;
  sorting_key: string;
  primary_key: string;
  sampling_key: string;
  astTables?: string[];
}

/** One `system.dictionaries` row — extends `SchemaGraphDictRow`, narrowing
 * `source` to required since this query always selects it. */
export interface DictionaryRow extends SchemaGraphDictRow {
  source: string;
}

/** `loadSchemaLineage`/`loadLineageTransitive`'s merged result. */
export interface LineageResult {
  tables: LineageTableRow[];
  dictionaries: DictionaryRow[];
}

/** `loadSchemaLineage`'s progressive-draw + cancellation options. */
export interface LoadSchemaLineageOpts {
  signal?: AbortSignal;
  onBase?: (base: LineageResult) => void;
  onProgress?: (done: number, total: number) => void;
  progressiveThreshold?: number;
}

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
export async function loadSchemaLineage(ctx: ChCtx, focus: LineageFocus | null | undefined, opts: LoadSchemaLineageOpts = {}): Promise<LineageResult> {
  const { signal, onBase, onProgress, progressiveThreshold = AST_PROGRESSIVE_THRESHOLD } = opts;
  const db = (focus && focus.db) || '';
  const cols = 'database, name, engine, engine_full, create_table_query, as_select, '
    + 'toString(uuid) AS uuid, dependencies_database, dependencies_table, '
    + 'loading_dependencies_database, loading_dependencies_table, comment, '
    // Card metadata (ignored by the inline graph; used by the rich fullscreen cards).
    + 'toUInt64(ifNull(total_rows, 0)) AS total_rows, toUInt64(ifNull(total_bytes, 0)) AS total_bytes, '
    + 'partition_key, sorting_key, primary_key, sampling_key';
  const tablesJson = await querySystemAware<LineageTableRow>(ctx, `SELECT ${cols} FROM system.tables WHERE database = ${sqlString(db)} ORDER BY startsWith(name, '_'), name`, signal);
  const tables = tablesJson.data || [];
  // Best-effort: a denied/missing system.dictionaries (low-priv users lack
  // SELECT on it) must degrade to no dictionary edges, never abort the graph —
  // but a genuine cancellation must still propagate (tryQueryData rethrows it).
  const dictionaries = (await tryQueryData<DictionaryRow>(ctx, `SELECT database, name, source FROM system.dictionaries WHERE database = ${sqlString(db)}`, signal)) || [];
  // Robust source extraction for views/MVs: let ClickHouse parse the SELECT.
  const astTargets = tables.filter((t) => t.as_select && (t.engine === 'View' || t.engine === 'MaterializedView'));
  const total = astTargets.length;
  const progressive = total >= progressiveThreshold;
  if (progressive && onBase) onBase({ tables, dictionaries });
  let done = 0;
  await Promise.all(astTargets.map(async (t) => {
    try {
      const ast = await queryJson<{ explain: string }>(ctx, 'EXPLAIN AST ' + t.as_select, signal);
      t.astTables = parseAstTables((ast.data || []).map((r) => r.explain).join('\n'));
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      /* best-effort — leave astTables undefined */
    } finally {
      done++;
      if (progressive && onProgress) onProgress(done, total);
    }
  }));
  return { tables, dictionaries };
}

/** Load the columns of one table. Returns [{name,type,comment}]. */
export async function loadColumns(ctx: ChCtx, db: string, table: string, sqlString: SqlStringFn): Promise<{ name: string; type: string; comment: string }[]> {
  const sql =
    'SELECT name, type, comment FROM system.columns ' +
    'WHERE database = ' + sqlString(db) + ' AND table = ' + sqlString(table) + ' ' +
    'ORDER BY position';
  const json = await querySystemAware<{ name: string; type: string; comment?: string }>(ctx, sql);
  return (json.data || []).map((r) => ({ name: r.name, type: r.type, comment: r.comment || '' }));
}

/** One `system.columns` row as read for the schema-graph rich cards. */
export interface CardColumnRow {
  database: string;
  table: string;
  name: string;
  type: string;
  is_in_partition_key?: number;
  is_in_sorting_key?: number;
  is_in_primary_key?: number;
  is_in_sampling_key?: number;
  compression_codec?: string;
  position?: number;
}

/** `loadSchemaCards`'s result. */
export interface SchemaCardsResult {
  columnsByKey: Record<string, CardColumnRow[]>;
}

/**
 * Load the rich-card metadata (columns with key-role flags) for a set of
 * databases, keyed by `db.table`. Best-effort via trySystemAwareQueryData: a
 * missing system table or denied SELECT degrades to an empty map (cards then
 * show just the engine/rows/bytes header — no badges), never a query error.
 * Returns `{ columnsByKey }`. Data-skipping indexes are no longer fetched here
 * (#179) — they're detail-drawer metadata (ch.loadTableDetail), not card
 * geometry, so pulling them on graph load was a dead read.
 */
export async function loadSchemaCards(ctx: ChCtx, dbs: readonly string[] | null | undefined): Promise<SchemaCardsResult> {
  const columnsByKey: Record<string, CardColumnRow[]> = {};
  const list = (dbs || []).map((d) => sqlString(d)).join(', ');
  if (!list) return { columnsByKey };
  const colRows = await trySystemAwareQueryData<CardColumnRow>(ctx,
    'SELECT database, table, name, type, is_in_partition_key, is_in_sorting_key, '
    + 'is_in_primary_key, is_in_sampling_key, compression_codec, position '
    + 'FROM system.columns WHERE database IN (' + list + ') ORDER BY database, table, position');
  for (const r of colRows || []) {
    const key = r.database + '.' + r.table;
    (columnsByKey[key] = columnsByKey[key] || []).push(r);
  }
  return { columnsByKey };
}

/** `loadLineageTransitive`'s caps. */
export interface LoadLineageTransitiveOpts {
  nodeCap?: number;
  dbCap?: number;
}

/** `loadLineageTransitive`'s result. */
export interface LineageTransitiveResult {
  rows: LineageResult;
  truncated: boolean;
}

/**
 * Load lineage rows transitively across database boundaries: start at `focus.db`,
 * then BFS into every database referenced by the graph built so far, merging rows,
 * until no new database is referenced or a cap is hit. `opts.dbCap` bounds the
 * number of databases fetched and `opts.nodeCap` the graph size — either tripping
 * sets `truncated` (the caller shows a banner). Returns `{ rows, truncated }`;
 * `rows` is the merged `{ tables, dictionaries }` for buildSchemaGraph + expandLineage.
 */
export async function loadLineageTransitive(ctx: ChCtx, focus: LineageFocus | null | undefined, opts: LoadLineageTransitiveOpts = {}): Promise<LineageTransitiveResult> {
  const nodeCap = opts.nodeCap != null ? opts.nodeCap : 600;
  const dbCap = opts.dbCap != null ? opts.dbCap : 8;
  const seed = (focus && focus.db) || '';
  const loaded = new Set<string>();
  let frontier: string[] = seed ? [seed] : [];
  let tables: LineageTableRow[] = [];
  let dictionaries: DictionaryRow[] = [];
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
    const graph = buildSchemaGraph({ tables, dictionaries }, undefined);
    // Cap on the *lineage* size — count only nodes that participate in an edge.
    // Standalone tables are cheap to render and never drive cross-DB expansion, so
    // they must not trip the cap (a single big DB of mostly-unrelated tables would
    // otherwise truncate on the first round, before its few links are followed).
    const linked = new Set<string>();
    for (const e of graph.edges) { linked.add(e.from); linked.add(e.to); }
    if (linked.size >= nodeCap) { truncated = true; break; }
    frontier = externalDbs(graph, [...loaded]);
  }
  return { rows: { tables, dictionaries }, truncated };
}

/** One `system.columns` row as read for the node-detail drawer. */
export interface ColumnDetailRow {
  name: string;
  type: string;
  codec?: string;
  comment?: string;
  is_in_partition_key?: number;
  is_in_sorting_key?: number;
  is_in_primary_key?: number;
  is_in_sampling_key?: number;
  compressed?: number;
  uncompressed?: number;
  marks?: number;
  position?: number;
}

/** One `system.data_skipping_indices` row. */
export interface IndexDetailRow {
  name: string;
  expr: string;
  type: string;
  type_full: string;
  granularity: number;
  compressed: number;
  uncompressed: number;
  marks: number;
}

/** One `system.parts` per-partition aggregate row. */
export interface PartitionDetailRow {
  partition: string;
  parts: number;
  rows: number;
  bytes: number;
}

/** `loadTableDetail`'s result. */
export interface TableDetail {
  columns: ColumnDetailRow[];
  indexes: IndexDetailRow[];
  partitions: PartitionDetailRow[];
  ddl: string;
  comment: string;
}

/**
 * Per-table detail for the node detail pane: full columns (with key-role flags,
 * per-column comments + compression sizes), data-skipping indexes, per-partition
 * part/row/byte sums, the table's own comment, and the DDL. All reads are
 * best-effort (a denied/missing system table degrades to empty, never an error);
 * the system.columns/system.tables reads also see DataLakeCatalog-backed tables
 * (#122) via trySystemAwareQueryData. Returns `{ columns, indexes, partitions,
 * ddl, comment }`.
 *
 * The index rows are fetched here — in this same parallel batch, one read per
 * detail-open — rather than reused from the schema-graph payload (#179): that
 * payload only carries name/type/expr and can't reach the drawer's click handler
 * without threading arrays through the dagre layout (worse coupling), and the
 * drawer needs `type_full` + `granularity` besides. `data_skipping_indices` is a
 * MergeTree-only view (no DataLakeCatalog tables), so the plain client suffices.
 */
export async function loadTableDetail(ctx: ChCtx, db: string, table: string): Promise<TableDetail> {
  const byCol = 'database = ' + sqlString(db) + ' AND table = ' + sqlString(table);
  const byName = 'database = ' + sqlString(db) + ' AND name = ' + sqlString(table);
  const [columns, indexes, partitions, tableRows] = await Promise.all([
    trySystemAwareQueryData<ColumnDetailRow>(ctx,
      'SELECT name, type, compression_codec AS codec, comment, '
      + 'is_in_partition_key, is_in_sorting_key, is_in_primary_key, is_in_sampling_key, '
      + 'toUInt64(data_compressed_bytes) AS compressed, toUInt64(data_uncompressed_bytes) AS uncompressed, '
      + 'toUInt64(marks_bytes) AS marks, position '
      + 'FROM system.columns WHERE ' + byCol + ' ORDER BY position'),
    tryQueryData<IndexDetailRow>(ctx,
      'SELECT name, expr, type, type_full, granularity, '
      + 'toUInt64(data_compressed_bytes) AS compressed, toUInt64(data_uncompressed_bytes) AS uncompressed, '
      + 'toUInt64(marks_bytes) AS marks '
      + 'FROM system.data_skipping_indices WHERE ' + byCol + ' ORDER BY name FORMAT JSON'),
    tryQueryData<PartitionDetailRow>(ctx,
      'SELECT partition, count() AS parts, sum(rows) AS rows, sum(bytes_on_disk) AS bytes '
      + 'FROM system.parts WHERE ' + byCol + ' AND active GROUP BY partition ORDER BY partition FORMAT JSON'),
    trySystemAwareQueryData<{ ddl?: string; comment?: string }>(ctx, 'SELECT create_table_query AS ddl, comment FROM system.tables WHERE ' + byName),
  ]);
  return {
    columns: columns || [],
    indexes: indexes || [],
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
async function tryRun<T>(
  runner: (ctx: ChCtx, sql: string, signal?: AbortSignal) => Promise<ChJsonResult<T>>,
  ctx: ChCtx, sql: string, signal?: AbortSignal,
): Promise<T[] | null> {
  try {
    const json = await runner(ctx, sql, signal);
    return json.data || [];
  } catch (e) {
    if (isAbort(e, signal)) throw e;
    return null;
  }
}

function tryQueryData<T>(ctx: ChCtx, sql: string, signal?: AbortSignal): Promise<T[] | null> {
  return tryRun<T>((c, s, sig) => queryJson<T>(c, s, sig), ctx, sql, signal);
}

// Same contract as tryQueryData, but via querySystemAware for best-effort
// system.tables/system.columns reads that must also see DataLakeCatalog-backed
// databases (#122).
function trySystemAwareQueryData<T>(ctx: ChCtx, sqlBody: string, signal?: AbortSignal): Promise<T[] | null> {
  return tryRun<T>((c, s, sig) => querySystemAware<T>(c, s, sig), ctx, sqlBody, signal);
}

// First non-empty line of a (possibly multi-line / Markdown) cell, trimmed.
// ClickHouse doc cells (system.functions.syntax/description) frequently begin
// with a blank line, so skip leading empties and return the first line that
// actually has content — taking the literal first line yields '' for them.
function firstLine(s: unknown): string {
  if (!s) return '';
  for (const line of String(s).split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

/** One `system.functions` entry, as `loadReferenceData` assembles it for the
 * editor's highlighting/autocomplete/signature-help data. */
export interface RefFunctionEntry {
  kind: 'agg' | 'fn';
  sig: string;
  ret: string;
  desc: string;
}

/** `loadReferenceData`'s result — each field is `null` when its source
 * system table is missing/denied (the caller falls back to a built-in set). */
export interface ReferenceData {
  keywords: string[] | null;
  functions: Record<string, RefFunctionEntry> | null;
  formats: string[] | null;
}

interface KeywordRow { keyword: string }
interface FunctionRow { name: string; is_aggregate?: number; syntax?: string }
interface FormatRow { name: string }

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
export async function loadReferenceData(ctx: ChCtx): Promise<ReferenceData> {
  const kw = await tryQueryData<KeywordRow>(ctx, 'SELECT keyword FROM system.keywords FORMAT JSON');
  const keywords = kw ? kw.map((r) => r.keyword) : null;
  // Prefer the `syntax` column (modern ClickHouse) for signature help; fall back
  // to the minimal shape when it doesn't exist (older servers) so we still get
  // names for highlighting + completion.
  const fn = await tryQueryData<FunctionRow>(ctx, 'SELECT name, is_aggregate, syntax FROM system.functions FORMAT JSON')
    || await tryQueryData<FunctionRow>(ctx, 'SELECT name, is_aggregate FROM system.functions FORMAT JSON');
  let functions: Record<string, RefFunctionEntry> | null = null;
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
  const fmts = await tryQueryData<FormatRow>(ctx, 'SELECT name FROM system.formats WHERE is_output ORDER BY name FORMAT JSON');
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
export async function loadEntityDoc(ctx: ChCtx, name: string, sqlString: SqlStringFn): Promise<string | null> {
  const rows = await tryQueryData<{ description?: string }>(
    ctx,
    'SELECT description FROM system.functions WHERE name = ' + sqlString(name) + ' LIMIT 1 FORMAT JSON',
  );
  if (rows === null) return null;                  // query failed → retryable, don't cache
  return rows[0] ? firstLine(rows[0].description) : ''; // succeeded → '' means genuinely no doc
}

/** `exportQuery`'s options. */
export interface ExportQueryOptions {
  queryId?: string;
  signal?: AbortSignal;
  format?: string;
  params?: Record<string, string | number>;
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
export async function exportQuery(ctx: ChCtx, sql: string, opts: ExportQueryOptions = {}): Promise<Response> {
  const { queryId, signal, format, params } = opts;
  const url = chUrl(ctx.origin, {
    format: format || 'TabSeparatedWithNames',
    params: { ...(queryId ? { query_id: queryId } : {}), ...(params || {}) },
  });
  const resp = await authedFetch(ctx, url, sql, signal);
  if (!resp.ok) throw new Error(parseExceptionText(await resp.text()));
  return resp;
}

/** `runQuery`'s options.
 * @param format  output format (default 'Table')
 * @param signal  aborts the request
 * @param resultRowLimit  caps a normal result server-side (max_result_rows +
 *   result_overflow_mode); 0/absent = uncapped
 * @param queryId  tags the request so Cancel can KILL QUERY it
 * @param params  extra query-string options that ride alongside query_id
 *   (e.g. multiquery SELECTs pass their own cap + session_id)
 * @param onLine  called per parsed stream object in streaming mode
 * @param onChunk  called once per read chunk in streaming mode
 * @param onRaw  unused by `runQuery` itself — the caller reads `.raw` off the
 *   returned result instead; kept for parity with the original docstring
 */
export interface RunQueryOptions {
  format?: string;
  signal?: AbortSignal;
  resultRowLimit?: number;
  queryId?: string;
  params?: Record<string, string | number>;
  onLine?: (line: StreamLine) => void;
  onChunk?: () => void;
  onRaw?: (text: string) => void;
}

/** `runQuery`'s result: a query error, a raw-mode body, or a completed stream. */
export interface RunQueryResult {
  error?: string;
  raw?: string;
  streamed?: boolean;
  /** A raw-mode `FORMAT PNG` (or other binary format) body, read as bytes
   *  rather than decoded as text (#307). `contentType` is normalized to
   *  `image/png` regardless of what the server's response header says —
   *  never base64-encoded. */
  binary?: { bytes: Uint8Array; contentType: string };
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
export async function runQuery(ctx: ChCtx, sql: string, o: RunQueryOptions = {}): Promise<RunQueryResult> {
  const fmt = o.format || 'Table';
  const isStreaming = fmt === 'Table' || fmt === 'KPI' || fmt === 'Filter';
  // Streaming gets the progress-bearing JSON; raw mode sends the requested format
  // verbatim as default_format (a real ClickHouse format name from a FORMAT clause
  // or an implicit EXPLAIN). 'TSV' keeps its with-names-and-types expansion.
  const fmtParam = isStreaming
    ? (fmt === 'KPI' || fmt === 'Filter' ? 'JSONEachRowWithProgress' : 'JSONStringsEachRowWithProgress')
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
  const cap: Record<string, string | number> = (o.resultRowLimit ?? 0) > 0
    ? { max_result_rows: o.resultRowLimit!, result_overflow_mode: 'break' }
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
    if (isBinaryFormat(fmt)) {
      const buf = await resp.arrayBuffer();
      return { binary: { bytes: new Uint8Array(buf), contentType: 'image/png' } };
    }
    return { raw: await resp.text() };
  }
  const reader = resp.body!.getReader();
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
      let json: StreamLine;
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
