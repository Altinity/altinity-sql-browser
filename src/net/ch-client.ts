// ClickHouse HTTP client. The app talks to ClickHouse same-origin: queries are
// POSTed to `/` with the OAuth bearer in the Authorization header, and CH
// validates the JWT via its token_processor (or a delegated verifier).
//
// All side effects are injected through a `ctx`:
//   { fetch, origin, getToken(): Promise<string|null>, refresh(): Promise<bool>,
//     onSignedOut() }
// so the whole module is unit-testable with plain stubs.

import { parseAstTables, buildSchemaGraph, externalDbs } from '../core/schema-graph.js';
import type { SchemaGraphTableRow, SchemaGraphDictRow } from '../core/schema-graph.js';
// Issue #585 Phase 1 — the transport seam. `chUrl` moved verbatim to
// `clickhouse-http-transport.ts`; re-exported here (with its `ChUrlOpts`
// parameter type) so every existing importer — including
// `tests/spike/clickhouse-client/current-adapter.ts` — keeps resolving. The
// generic request-construction/fetch mechanics lived in `createHttpTransport`;
// at the time this module kept every auth/epoch/retry policy, product
// operation, and `ChCtx` exactly as before, delegating through the transport
// instead of calling `chUrl`/`ctx.fetch` directly (the auth/epoch/retry
// policy itself later moved out — see the Phase 6 note below; the transport
// itself is deleted — see the Phase 7 note below).
//
// Issue #630 Phase 2 — `chUrl` now comes from `@altinity/clickhouse-http`
// (the package is the ONE serializer implementation, contract A5); this
// module's re-export below keeps every existing importer (including the
// historical official-client spike, `tests/spike/clickhouse-client/current-
// adapter.ts`) resolving unchanged.
//
// Issue #630 Phase 3 — the progress-stream read loop and the HTTP
// exception-text/late-exception-frame parser are also package-owned now
// (`streamLines`/`parseExceptionText`/`findExceptionFrame`, plus the
// canonical `StreamLine`/`StreamCallbacks` wire types).
// `parseExceptionText`/`findExceptionFrame`/`StreamLine`/`StreamCallbacks`
// are re-exported below as zero-logic migration plumbing: `src/application/**`
// cannot import the package directly (Rule D — its language-export allowlist
// is for the SQL Browser layers that consume generic ClickHouse
// quoting/type-grammar directly, not a general escape hatch), so
// `export-service.ts`'s `findExceptionFrame` use resolves through this one
// gateway instead.
//
// Issue #630 Phase 5 — `sqlString` now comes from the package too (the ONE
// quoting implementation, `sql-quote.ts`); this module is itself under
// `src/net/**`, the one layer Rule D always allows to import the package's
// full surface (transport APIs and language exports alike), so it imports
// `sqlString` directly rather than through `../core/format.js` (which no
// longer declares it at all).
//
// Issue #630 Phase 6 — the normal-request auth/epoch/refresh/lifecycle
// policy that used to live here as `authedFetch`/`transportFor(ctx)` MOVED
// to `src/net/authenticated-clickhouse-request.ts` — a real move+delete, not
// an additive layer: both are gone from this file, with no forwarding
// alias, no second retry loop, and no second Authorization constructor.
// `queryJson` below now delegates to that module's `authenticatedJson()`
// (the first real production consumer of the package's response-consumer
// layer). `ChCtx` extends the new module's narrower `AuthenticatedRequestCtx`
// rather than duplicating its fields — `dataLakeCatalogSettingUnsupported`
// is the one field genuinely specific to this product client, so it stays
// declared here, not there.
//
// Issue #630 Phase 7 — the generic, format-agnostic `runQuery`/`exportQuery`
// and the ordinary mutable-context `killQuery` are DELETED, not superseded
// by a forwarding wrapper: their SQL Browser policy (Table/KPI/TSV/raw
// mapping, ordinary row caps, script over-fetch caps, retry/result mapping,
// export UX/streaming/late-exception handling) now lives in
// `src/application/query-execution-service.ts` and
// `src/application/export-service.ts`, driving
// `authenticated-clickhouse-request.ts`'s `authenticatedProgress`/
// `authenticatedText`/`authenticatedResponse` directly (Checkpoints 2A/2B).
// `killQueryWithLease` (below) is REWRITTEN onto the package's own stateless
// `createClickHouseHttpClient(...).killQuery(...)` instead of the retired
// local transport adapter — the package now owns the KILL QUERY SQL and its
// quoting, so this function no longer takes a `sqlString` argument. The
// local compatibility transport (`clickhouse-http-transport.ts`/
// `clickhouse-transport.types.ts`) is deleted in the same change — with
// `killQueryWithLease` off it, this module's last caller is gone, and there
// is exactly one generic ClickHouse HTTP transport implementation left in
// the repository (the package's).
import {
  chUrl, parseExceptionText, findExceptionFrame, sqlString, ClickHouseError,
  createClickHouseHttpClient,
} from '@altinity/clickhouse-http';
import { authenticatedJson } from './authenticated-clickhouse-request.js';
import type { AuthenticatedRequestCtx } from './authenticated-clickhouse-request.js';
export { chUrl, parseExceptionText, findExceptionFrame };
export type { ChUrlOpts, StreamLine, StreamCallbacks } from '@altinity/clickhouse-http';

// ── Injected ctx seam ────────────────────────────────────────────────────────

/** The injected side-effect seam every function in this module takes as its
 * first argument. `fetch`/`getToken`/`refresh`/`onSignedOut` are the app's
 * real implementations in production, plain stubs in tests. `authConfirmed`
 * is a one-shot-then-remember latch `authenticatedRequest`
 * (`authenticated-clickhouse-request.ts`) sets on `ctx` itself;
 * `dataLakeCatalogSettingUnsupported` is `querySystemAware`'s own latch (see
 * their docstrings) — both optional here because they start unset. The
 * epoch/lifecycle hooks are optional too, preserving the smaller seam used
 * by existing callers. `ChCtx` extends `AuthenticatedRequestCtx`
 * (#630 Phase 6) rather than redeclaring its fields: this interface adds
 * only `dataLakeCatalogSettingUnsupported`, the one field genuinely specific
 * to this product client — every other field is the narrower auth seam the
 * new module actually needs. */
export interface ChCtx extends AuthenticatedRequestCtx {
  dataLakeCatalogSettingUnsupported?: boolean;
}

/** Immutable authority retained only long enough to cancel work owned by a
 * closing authenticated execution scope. `authorization` is already complete
 * (scheme + credential): cleanup must never consult mutable auth mode, refresh,
 * token storage, or normal auth-loss callbacks. */
export interface AuthenticatedCancellationLease {
  readonly epoch: number;
  readonly origin: string;
  readonly authorization: string;
  readonly fetch: typeof fetch;
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

/**
 * Run a query and return parsed JSON (FORMAT JSON). Throws on CH error. `signal`
 * (optional) aborts the request. `extra` (optional) adds HTTP query-string
 * settings (e.g. `{ readonly: 2 }` for a read-only tile). `params` (optional)
 * adds `param_<name>` query-string args for native ClickHouse query parameters
 * (#134) — omitted for every existing call site, so this is backward compatible.
 *
 * #630 Phase 6 — delegates to `authenticated-clickhouse-request.ts`'s
 * `authenticatedJson()`, the first real production consumer of the package's
 * JSON response consumer. Preserves this function's own EXISTING outward
 * non-2xx behavior (a plain `Error` carrying CH's parsed exception message)
 * by translating the package's `ClickHouseError` back to that shape —
 * `authenticatedJson`'s `ClickHouseError.message` is itself derived from the
 * same `parseExceptionText`, so the message text is unchanged; only the
 * thrown error's class/identity is translated. Native JSON/body/network/abort
 * errors are never `ClickHouseError` and propagate unchanged. (Phase 7 may
 * later remove this translation as part of its broader consumer cutover.)
 */
export async function queryJson<T = Record<string, unknown>>(
  ctx: ChCtx,
  sql: string,
  signal?: AbortSignal,
  extra?: Record<string, string | number>,
  params?: Record<string, string | number>,
): Promise<ChJsonResult<T>> {
  try {
    return await authenticatedJson<ChJsonResult<T>>(ctx, { sql, defaultFormat: 'JSON', settings: extra, params, signal });
  } catch (e) {
    if (e instanceof ClickHouseError) throw new Error(e.message);
    throw e;
  }
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
 * `ctx.authConfirmed` in `authenticated-clickhouse-request.ts`'s
 * `authenticatedRequest`.
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
 * 'not signed in' / 'signed out' — `authenticatedRequest` (via `queryJson`)
 * has already exhausted its own retry and called `ctx.onSignedOut()` for
 * those, so retrying here would just repeat the whole token/refresh/sign-out
 * handshake (and its side effects) a second time for no benefit.
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
async function loadDataLakeCatalogTableNames(ctx: ChCtx, db: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const json = await querySystemAware<{ name: string }>(ctx, `SELECT database, name FROM system.tables WHERE database = ${sqlString(db)}`, signal);
    return (json.data || []).map((r) => r.name);
  } catch (e) {
    // A catalog database is best-effort, but cancellation belongs to the
    // whole schema load and must stop its sibling fan-out too.
    if (isAbort(e, signal)) throw e;
    return [];
  }
}

/** Best-effort server cancellation through a frozen execution-scope lease.
 * This deliberately bypasses `authenticatedRequest`
 * (`authenticated-clickhouse-request.ts`): no token read, refresh, retry,
 * lifecycle callback, or mutable auth-scheme lookup is allowed while a dead
 * scope is closing. #630 Phase 7 — routes through the package's own
 * stateless `createClickHouseHttpClient(...).killQuery(...)` instead of the
 * retired local transport adapter; the package now owns the KILL QUERY SQL
 * and its quoting (`sqlString`, applied internally), so this function no
 * longer takes a `sqlString` parameter — the ordinary mutable-context
 * `killQuery` this module used to export (which did take one) is deleted
 * outright, not superseded by a forwarding wrapper. */
export async function killQueryWithLease(
  lease: AuthenticatedCancellationLease,
  queryId: string | null | undefined,
): Promise<void> {
  if (!queryId) return;
  try {
    // A one-shot client built directly from the frozen lease — never the
    // mutable-`ChCtx` `authenticatedRequest` — so cleanup reads no mutable
    // auth, token, or refresh state (hard invariant 8/13).
    const client = createClickHouseHttpClient({ fetch: () => lease.fetch, origin: () => lease.origin });
    await client.killQuery({ queryId, authorization: lease.authorization });
  } catch { /* best-effort */ }
}

/** Fetch `version()` + `uptime()`. Returns the version string ('' on shape miss). */
export async function loadServerVersion(ctx: ChCtx, signal?: AbortSignal): Promise<string> {
  const json = await queryJson<{ v?: string; u?: number }>(ctx, 'SELECT version() AS v, uptime() AS u FORMAT JSON', signal);
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
export async function loadSchema(ctx: ChCtx, signal?: AbortSignal): Promise<SchemaDb[]> {
  const dbJson = await queryJson<DbRow>(ctx,
    "SELECT name, comment, engine FROM system.databases\n" +
    "WHERE name NOT IN ('INFORMATION_SCHEMA','information_schema')\n" +
    'ORDER BY name\n' +
    'FORMAT JSON', signal);
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
      'FORMAT JSON', signal),
    Promise.all(catalogDbs.map(async (db) => ({ db, names: await loadDataLakeCatalogTableNames(ctx, db, signal) }))),
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
export async function loadColumns(ctx: ChCtx, db: string, table: string, sqlString: SqlStringFn, signal?: AbortSignal): Promise<{ name: string; type: string; comment: string }[]> {
  const sql =
    'SELECT name, type, comment FROM system.columns ' +
    'WHERE database = ' + sqlString(db) + ' AND table = ' + sqlString(table) + ' ' +
    'ORDER BY position';
  const json = await querySystemAware<{ name: string; type: string; comment?: string }>(ctx, sql, signal);
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
export async function loadSchemaCards(ctx: ChCtx, dbs: readonly string[] | null | undefined, signal?: AbortSignal): Promise<SchemaCardsResult> {
  const columnsByKey: Record<string, CardColumnRow[]> = {};
  const list = (dbs || []).map((d) => sqlString(d)).join(', ');
  if (!list) return { columnsByKey };
  const colRows = await trySystemAwareQueryData<CardColumnRow>(ctx,
    'SELECT database, table, name, type, is_in_partition_key, is_in_sorting_key, '
    + 'is_in_primary_key, is_in_sampling_key, compression_codec, position '
    + 'FROM system.columns WHERE database IN (' + list + ') ORDER BY database, table, position', signal);
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
  /** Cancels the current frontier and prevents a stale traversal from starting
   * another database round under a replacement authentication scope. */
  signal?: AbortSignal;
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
 * sets `truncated` (the caller shows a banner); `opts.signal` cancels every
 * frontier request and prevents a later round. Returns `{ rows, truncated }`;
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
    const parts = await Promise.all(batch.map((db) => loadSchemaLineage(ctx, { db }, { signal: opts.signal })));
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
  /** #314 — the table's raw `system.tables.engine` name (e.g. `MergeTree`,
   *  `ReplicatedMergeTree`), threaded through so the node detail pane
   *  (schema-detail.ts) can offer an `Open engine reference` documentation
   *  action next to it. Best-effort, same degrade-to-empty-string convention
   *  as `ddl`/`comment` above (a denied/missing `system.tables` row leaves
   *  this `''`, never an error). */
  engine: string;
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
export async function loadTableDetail(ctx: ChCtx, db: string, table: string, signal?: AbortSignal): Promise<TableDetail> {
  const byCol = 'database = ' + sqlString(db) + ' AND table = ' + sqlString(table);
  const byName = 'database = ' + sqlString(db) + ' AND name = ' + sqlString(table);
  const [columns, indexes, partitions, tableRows] = await Promise.all([
    trySystemAwareQueryData<ColumnDetailRow>(ctx,
      'SELECT name, type, compression_codec AS codec, comment, '
      + 'is_in_partition_key, is_in_sorting_key, is_in_primary_key, is_in_sampling_key, '
      + 'toUInt64(data_compressed_bytes) AS compressed, toUInt64(data_uncompressed_bytes) AS uncompressed, '
      + 'toUInt64(marks_bytes) AS marks, position '
      + 'FROM system.columns WHERE ' + byCol + ' ORDER BY position', signal),
    tryQueryData<IndexDetailRow>(ctx,
      'SELECT name, expr, type, type_full, granularity, '
      + 'toUInt64(data_compressed_bytes) AS compressed, toUInt64(data_uncompressed_bytes) AS uncompressed, '
      + 'toUInt64(marks_bytes) AS marks '
      + 'FROM system.data_skipping_indices WHERE ' + byCol + ' ORDER BY name FORMAT JSON', signal),
    tryQueryData<PartitionDetailRow>(ctx,
      'SELECT partition, count() AS parts, sum(rows) AS rows, sum(bytes_on_disk) AS bytes '
      + 'FROM system.parts WHERE ' + byCol + ' AND active GROUP BY partition ORDER BY partition FORMAT JSON', signal),
    trySystemAwareQueryData<{ ddl?: string; comment?: string; engine?: string }>(ctx, 'SELECT create_table_query AS ddl, comment, engine FROM system.tables WHERE ' + byName, signal),
  ]);
  return {
    columns: columns || [],
    indexes: indexes || [],
    partitions: partitions || [],
    ddl: (tableRows && tableRows[0] && tableRows[0].ddl) || '',
    comment: (tableRows && tableRows[0] && tableRows[0].comment) || '',
    engine: (tableRows && tableRows[0] && tableRows[0].engine) || '',
  };
}

// Run `runner(ctx, sql, signal)` for its `data` rows, returning null on ANY
// error EXCEPT a cancellation of a caller-supplied signal. Editor reference
// data / schema-lineage best-effort reads are meant to degrade gracefully on
// a missing system table or a denied SELECT — but when the caller passed a
// `signal` and aborted it, that means the caller's whole operation was
// cancelled, not that this particular sub-query failed, so it must propagate
// rather than be swallowed into "no data, continue" (#124). Gated on
// `signal.aborted` (not just the error's name) so any caller that omits the
// optional signal keeps today's unconditional swallow, even if the underlying
// fetch happens to throw an AbortError-shaped error for some unrelated reason.
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
 * and most are never read — they're fetched on demand per target and cached by
 * the catalog's `docSummary`/`docEntry` (schema-catalog-service.ts, #313).
 * Each source is best-effort; a missing/denied system table yields null for
 * that piece and the caller (assembleReferenceData) falls back to the
 * built-in set.
 * Returns { keywords, functions, formats } — each null when its source is
 * missing/denied (the caller falls back to a built-in set).
 */
export async function loadReferenceData(ctx: ChCtx, signal?: AbortSignal): Promise<ReferenceData> {
  const kw = await tryQueryData<KeywordRow>(ctx, 'SELECT keyword FROM system.keywords FORMAT JSON', signal);
  const keywords = kw ? kw.map((r) => r.keyword) : null;
  // Prefer the `syntax` column (modern ClickHouse) for signature help; fall back
  // to the minimal shape when it doesn't exist (older servers) so we still get
  // names for highlighting + completion.
  const fn = await tryQueryData<FunctionRow>(ctx, 'SELECT name, is_aggregate, syntax FROM system.functions FORMAT JSON', signal)
    || await tryQueryData<FunctionRow>(ctx, 'SELECT name, is_aggregate FROM system.functions FORMAT JSON', signal);
  let functions: Record<string, RefFunctionEntry> | null = null;
  if (fn) {
    functions = {};
    for (const r of fn) {
      functions[r.name] = {
        kind: r.is_aggregate ? 'agg' : 'fn',
        sig: firstLine(r.syntax) || r.name + '()',
        ret: '',
        desc: '', // rich docs are fetched lazily per target via the catalog's docSummary/docEntry (#313)
      };
    }
  }
  // Output format names for FORMAT-clause completion (system.formats); a separate
  // catalog from keywords/functions, so it needs its own fetch.
  const fmts = await tryQueryData<FormatRow>(ctx, 'SELECT name FROM system.formats WHERE is_output ORDER BY name FORMAT JSON', signal);
  const formats = fmts ? fmts.map((r) => r.name) : null;
  return { keywords, functions, formats };
}

/**
 * Silent one-time-per-connection capability probe for a documentation source's
 * columns (#313 `system.functions`; #314 generalizes this to the four
 * structured sources too): which columns exist on `table`, read via
 * `system.columns` — a table that ALWAYS exists, so this query only fails on
 * a genuinely transient/denied problem, never because the target table itself
 * is missing (a missing target table just yields zero matching rows here, not
 * an error). `table` is restricted to `DocProbeTable` — a fixed internal
 * allowlist, resolved through `DOC_PROBE_TABLE_NAMES` rather than interpolated
 * directly, so this can never run with an arbitrary caller-supplied FROM/WHERE
 * value even if a caller bypassed the type at the JS boundary. Returns:
 *  - the column-name array (`[]` when the table doesn't exist on this server —
 *    a successful probe with no matching rows — the caller treats this as
 *    capability `unavailable`, cacheable for the connection);
 *  - `null` when the probe query itself failed. `tryQueryData` returns null
 *    on ANY error, so this conflates "denied `system.columns` read" with "a
 *    transient network/auth hiccup" — there is no reliable way to tell them
 *    apart from here. Policy (documented on the caller,
 *    `SchemaCatalogService`): a `null` probe is retryable, but the caller
 *    dedupes so a failed probe is retried at most once per subsequent lookup
 *    batch — never once per individual lookup (no request storm).
 */
export type DocProbeTable =
  | 'functions' | 'formats' | 'table_engines' | 'database_engines' | 'data_type_families'
  // #315 Phase 3 — the broad `system.documentation` fallback/coverage source.
  | 'documentation';

const DOC_PROBE_TABLE_NAMES: Record<DocProbeTable, string> = {
  functions: 'functions',
  formats: 'formats',
  table_engines: 'table_engines',
  database_engines: 'database_engines',
  data_type_families: 'data_type_families',
  documentation: 'documentation',
};

export function loadDocTableColumns(ctx: ChCtx, table: DocProbeTable, signal?: AbortSignal): Promise<string[] | null> {
  const tableName = DOC_PROBE_TABLE_NAMES[table];
  return tryQueryData<{ name: string }>(
    ctx,
    "SELECT name FROM system.columns WHERE database = 'system' AND table = " + sqlString(tableName) + ' FORMAT JSON', signal,
  ).then((rows) => (rows === null ? null : rows.map((r) => r.name)));
}

/**
 * Run a prebuilt documentation-row SELECT (built by `buildFunctionDocSelect`/
 * `buildStructuredDocSelect`, `core/doc-capability.ts`) for one lookup by name
 * (#313 function/aggregate-function; #314 the four structured sources). `null`
 * on failure — transient, the caller must not cache it — the (possibly empty,
 * on no match) row array otherwise.
 */
export function loadDocRow(ctx: ChCtx, sql: string, signal?: AbortSignal): Promise<Record<string, unknown>[] | null> {
  return tryQueryData<Record<string, unknown>>(ctx, sql, signal);
}

/** #313's `system.functions`-specific capability probe — a thin wrapper over
 *  the generalized `loadDocTableColumns` (#314). Kept as its own export so
 *  `SchemaCatalogDeps`/existing call sites and tests don't need to change. */
export function loadFunctionsDocColumns(ctx: ChCtx, signal?: AbortSignal): Promise<string[] | null> {
  return loadDocTableColumns(ctx, 'functions', signal);
}

/** #313's `system.functions`-specific row loader — a thin wrapper over the
 *  generalized `loadDocRow` (#314). Kept as its own export for the same
 *  reason as `loadFunctionsDocColumns` above. */
export function loadFunctionDocRow(ctx: ChCtx, sql: string, signal?: AbortSignal): Promise<Record<string, unknown>[] | null> {
  return loadDocRow(ctx, sql, signal);
}
