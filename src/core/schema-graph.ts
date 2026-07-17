// Pure assembly of a ClickHouse object-lineage graph from system.* rows. No DOM,
// no globals, no fetch — the queries live in src/net/ch-client.js (loadSchemaLineage)
// and the SVG drawing in src/ui (reusing the dagre graph renderer). Mirrors the
// load→assemble pattern of src/core/completions.js.
//
// Discovery is structured-first, parse-fallback (see the plan): structured columns
// (dependencies_table, loading_dependencies_*, dictionaries.source) when populated,
// else parse — EXPLAIN AST `TableIdentifier`s for query sources (attached as
// row.astTables by the loader), create_table_query `TO`/`.inner` for the MV target,
// engine_full for Distributed/Buffer/Merge. All best-effort: a miss yields a node
// with no edge, never a throw.

import { decodeQuotedIdent } from './sql-lex.js';

/** One `system.tables` row as `buildSchemaGraph` reads it — `astTables` (EXPLAIN
 *  AST source names) is attached by the loader (net/ch-client.ts), not a real
 *  ClickHouse column. No index signature: net/ch-client.ts's own `LineageTableRow`
 *  (the real loader's row shape) must keep satisfying this without declaring one. */
export interface SchemaGraphTableRow {
  database: string;
  name: string;
  engine: string;
  engine_full?: string;
  create_table_query?: string;
  as_select?: string;
  uuid?: string;
  comment?: string;
  dependencies_database?: (string | null | undefined)[];
  dependencies_table?: string[];
  loading_dependencies_database?: (string | null | undefined)[];
  loading_dependencies_table?: string[];
  astTables?: string[];
}

/** One `system.dictionaries` row as `buildSchemaGraph` reads it. No index
 *  signature — see `SchemaGraphTableRow`'s note (net/ch-client.ts's
 *  `DictionaryRow` must keep satisfying this too). */
export interface SchemaGraphDictRow {
  database: string;
  name: string;
  source?: string;
}

/** `buildSchemaGraph`'s input rows: the whole-DB/table-focus system.* scan. */
export interface SchemaGraphRows {
  tables?: SchemaGraphTableRow[];
  dictionaries?: SchemaGraphDictRow[];
}

/** Scopes `buildSchemaGraph`'s result — a whole-DB lineage view, or a single
 *  table plus its 1-hop neighbours. Deliberately NOT a discriminated union on
 *  `kind` (every field stays optional/a plain `string`): net/ch-client.ts's own
 *  `LineageFocus` (the real drag-payload/loader shape, `{kind?: string; db?:
 *  string; table?: string}`) must keep satisfying this parameter type as-is. */
export interface SchemaGraphFocus {
  kind?: string;
  db?: string;
  table?: string;
}

/** One lineage-graph node. `db`/`name` are '' for the synthetic `external:`
 *  (non-ClickHouse dictionary source) leaf, which carries no real db/table. */
export interface SchemaGraphNode {
  id: string;
  label: string;
  kind: string;
  db: string;
  name: string;
  comment: string;
}

/** One lineage-graph edge (`kind` — 'feeds'/'writes'/'reads'/'dict'/'shard'/'buffer'/'merge'). */
export interface SchemaGraphEdge {
  from: string;
  to: string;
  kind: string;
}

/** `buildSchemaGraph`'s return shape. */
export interface SchemaGraph {
  nodes: SchemaGraphNode[];
  edges: SchemaGraphEdge[];
}

/** Map a ClickHouse engine name to a node kind. */
export function objectKind(engine?: string | null): string {
  const e = String(engine || '');
  if (e === 'MaterializedView') return 'mv';
  if (e === 'View' || e === 'LiveView' || e === 'WindowView') return 'view';
  if (e === 'Dictionary') return 'dictionary';
  if (e === 'Distributed') return 'distributed';
  if (e === 'Buffer') return 'buffer';
  if (e === 'Merge') return 'merge';
  return 'table';
}

/** Table names from `EXPLAIN AST` text — the `TableIdentifier <name> (alias …)` lines. */
export function parseAstTables(astText?: string | null): string[] {
  const out: string[] = [];
  const re = /^\s*TableIdentifier\s+([^\s(]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(astText || '')))) out.push(m[1]);
  return out;
}

// One ClickHouse identifier part: a backtick-quoted run (with `\`` / `\\`
// backslash escapes AND doubled-backtick `` `` `` escapes — so a name like
// ``a``b`` is captured whole, not truncated at the first inner backtick, #182)
// or a bare identifier. Used to parse names out of create_table_query, where CH
// backtick-quotes non-bare names (e.g. TO target_all.`agg.out.parquet`).
const IDENT_PART = '(?:`(?:[^`\\\\]|\\\\.|``)*`|[A-Za-z_][A-Za-z0-9_]*)';
const TO_RE = new RegExp('\\sTO\\s+(' + IDENT_PART + ')(?:\\.(' + IDENT_PART + '))?');

/** `parseMvTarget`'s result: an explicit `TO [db.]table`. */
export interface MvTarget {
  db?: string;
  table: string;
}

/**
 * The explicit `TO [db.]table` target of a materialized view as `{ db?, table }`
 * (raw, backticks stripped — so it matches the row ids), or null for an implicit
 * (`.inner.*`) MV. Handles backtick-quoted, dotted names.
 */
export function parseMvTarget(createTableQuery?: string | null): MvTarget | null {
  const s = String(createTableQuery || '');
  // The optional TO clause sits between the view name and the column list / AS
  // SELECT, so only scan up to the first '(' (and before any AS SELECT). This
  // keeps a stray " TO " inside a column comment or the SELECT body from being
  // mistaken for the target (which would also suppress the real .inner edge).
  const head = s.split(/\sAS\s+SELECT/i)[0].split('(')[0];
  const m = TO_RE.exec(head);
  if (!m) return null;
  // The regex captures complete quoted identifiers, so decode with closed=true.
  return m[2] ? { db: decodeQuotedIdent(m[1], true), table: decodeQuotedIdent(m[2], true) } : { table: decodeQuotedIdent(m[1], true) };
}

/** `parseDictSource`'s result: either a ClickHouse-hosted `{db?, table}` source
 *  or an `{external}` (non-ClickHouse) one — never both. */
export interface DictSource {
  db?: string | null;
  table?: string;
  external?: string;
}

/** A dictionary's source as `{ db, table }` (ClickHouse source) or `{ external }`. */
export function parseDictSource(source?: string | null, createTableQuery?: string | null): DictSource | null {
  const src = String(source || '');
  const m = /^ClickHouse:\s*([\w]+)\.([\w]+)/i.exec(src);
  if (m) return { db: m[1], table: m[2] };
  // pre-load `source` can be empty — fall back to the CREATE's SOURCE(CLICKHOUSE(…)).
  const cq = String(createTableQuery || '');
  if (/SOURCE\s*\(\s*CLICKHOUSE/i.test(cq)) {
    const t = /\bTABLE\s+'([^']+)'/i.exec(cq);
    const d = /\bDB\s+'([^']+)'/i.exec(cq);
    if (t) return { db: d ? d[1] : null, table: t[1] };
  }
  if (src) return { external: src.split(':')[0].trim() };
  return null;
}

/** `parseEngineRef`'s result — the engine-specific fields it fills in vary by
 *  `kind`, but every branch always sets `table` or `regex`, never both. */
export interface EngineRef {
  kind: 'distributed' | 'buffer' | 'merge';
  cluster?: string;
  db?: string;
  table?: string;
  regex?: string;
}

/** Engine-arg reference for Distributed/Buffer/Merge from `engine_full`. */
export function parseEngineRef(engine?: string | null, engineFull?: string | null): EngineRef | null {
  const s = String(engineFull || '');
  if (engine === 'Distributed') {
    const m = /Distributed\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'/.exec(s);
    if (m) return { kind: 'distributed', cluster: m[1], db: m[2], table: m[3] };
  } else if (engine === 'Buffer') {
    const m = /Buffer\(\s*'([^']*)'\s*,\s*'([^']*)'/.exec(s);
    if (m) return { kind: 'buffer', db: m[1], table: m[2] };
  } else if (engine === 'Merge') {
    const m = /Merge\(\s*'([^']*)'\s*,\s*'([^']*)'/.exec(s);
    if (m) return { kind: 'merge', db: m[1], regex: m[2] };
  }
  return null;
}

// A reference whose db is always supplied separately (dependencies_*, engine
// args, table-focus center) — join unconditionally so a dotted table name
// (`…snappy.parquet`) keeps its db prefix instead of being mistaken for an
// already-qualified ref. Always emits a dot (like rowId) so node() can split it.
const joinId = (db: string, name: string): string => db + '.' + name;
const rowId = (r: SchemaGraphTableRow): string => r.database + '.' + r.name;

/**
 * Build `{ nodes:[{id,label,kind}], edges:[{from,to,kind}] }` from system.* rows.
 * `rows = { tables:[…], dictionaries:[…] }`; each table row may carry `astTables`
 * (EXPLAIN AST sources). `focus = { kind:'db'|'table', db, table? }` scopes the
 * result (table focus → the table + its 1-hop neighbours).
 */
export function buildSchemaGraph(
  rows: SchemaGraphRows | null | undefined, focus: SchemaGraphFocus | null | undefined,
): SchemaGraph {
  const tables = (rows && rows.tables) || [];
  const dicts = (rows && rows.dictionaries) || [];
  const nodes = new Map<string, SchemaGraphNode>();
  const byId = new Map<string, SchemaGraphTableRow>(); // id → table row, for lookups
  const innerByUuid = new Map<string, string>(); // implicit-MV inner storage, keyed by owner uuid

  // Every creation passes explicit db/name (callers build the id via joinId/rowId,
  // so they always know the parts) — keeping a dotted *database* correct, not just a
  // dotted table. The db/name args are ignored when the node already exists.
  // `comment` is only known for a real system.tables row (the first pass below);
  // a node first reached as a bare dependency reference gets '' and is never
  // overwritten once created — the owning row's own node() call always runs in
  // that same first pass, before any dependency processing.
  const node = (id: string, kind: string, db?: string, name?: string, comment?: string): SchemaGraphNode => {
    if (!nodes.has(id)) {
      // `!`: every call site that can reach a not-yet-registered id passes real
      // `db`/`name` strings (see the invariant above) — the one caller that
      // omits them (the implicit `.inner` MV target) always targets an id the
      // first pass already registered, so this branch never sees them absent.
      // The original .js used the bare shorthand `db, name` here.
      nodes.set(id, { id, label: id, kind, db: db!, name: name!, comment: (comment || '').trim() });
    }
    // `!`: the branch above guarantees `id` is present either way (just-created
    // or already there).
    return nodes.get(id)!;
  };
  // external (non-CH dictionary source) leaf — no comment concept, but carries
  // the same '' default as every other node so all node objects share one shape.
  const external = (label: string): string => {
    const id = 'ext:' + label;
    if (!nodes.has(id)) nodes.set(id, { id, label, kind: 'external', db: '', name: label, comment: '' });
    return id;
  };
  // The kind of an already-registered node, or 'table' for a not-yet-seen
  // dependency reference — `byId`/`nodes` are always populated together (the
  // first pass below sets both for every table row), so `byId.has(nid)`
  // guarantees `nodes.has(nid)` too.
  const kindOf = (nid: string): string => (byId.has(nid) ? nodes.get(nid)!.kind : 'table');

  for (const t of tables) {
    const id = rowId(t);
    byId.set(id, t);
    if (/^\.inner/.test(t.name)) {
      const uuid = t.name.replace(/^\.inner(_id)?\./, '');
      innerByUuid.set(uuid, id);
    }
    node(id, objectKind(t.engine), t.database, t.name, t.comment);
  }
  // friendlier labels for inner storage tables
  for (const id of innerByUuid.values()) {
    const n = nodes.get(id);
    if (n) n.label = '·inner';
  }

  const edges: SchemaGraphEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (from: string | null | undefined, to: string | null | undefined, kind: string): void => {
    if (!from || !to || from === to) return;
    if (!nodes.has(from) || !nodes.has(to)) return; // both endpoints must be real nodes
    const k = JSON.stringify([from, to, kind]);
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ from, to, kind });
  };
  const zip = (
    dbs: (string | null | undefined)[] | undefined, names: string[] | undefined,
  ): { id: string; db: string; name: string }[] => (names || []).map((nm, i) => {
    const d = (dbs && dbs[i]) || '';
    return { id: joinId(d, nm), db: d, name: nm };
  });

  for (const t of tables) {
    const id = rowId(t);
    const kind = kindOf(id);
    // source → MV/View (structured dependents on the source side)
    for (const dep of zip(t.dependencies_database, t.dependencies_table)) {
      node(dep.id, kindOf(dep.id), dep.db, dep.name);
      addEdge(id, dep.id, 'feeds');
    }
    // fallback: EXPLAIN AST sources of a view/MV → source → this object. EXPLAIN
    // AST prints names unquoted, qualified-or-bare — so resolve against the known
    // ids both ways (as-is, then db-qualified). A name that matches no real object
    // (a CTE/alias) is dropped; a CTE that shadows a real same-db table will still
    // resolve to that table (we can't tell them apart from the name alone).
    if ((kind === 'mv' || kind === 'view') && Array.isArray(t.astTables)) {
      for (const src of t.astTables) {
        const qid = joinId(t.database, src);
        const sid = byId.has(src) ? src : (byId.has(qid) ? qid : null);
        if (sid) addEdge(sid, id, kind === 'mv' ? 'feeds' : 'reads');
      }
    }
    if (kind === 'mv') {
      const target = parseMvTarget(t.create_table_query);
      const targetId = target ? joinId(target.db || t.database, target.table) : innerByUuid.get(String(t.uuid || ''));
      if (targetId) {
        // For an implicit (.inner) target the node already exists with correct
        // parts (created in the first pass), so db/name here are only used for the
        // explicit-TO case.
        node(targetId, kindOf(targetId), target ? (target.db || t.database) : undefined, target ? target.table : undefined);
        addEdge(id, targetId, 'writes');
      }
    } else if (kind === 'distributed' || kind === 'buffer' || kind === 'merge') {
      const ref = parseEngineRef(t.engine, t.engine_full);
      if (ref && ref.table) {
        const refId = joinId(ref.db || t.database, ref.table);
        node(refId, kindOf(refId), ref.db || t.database, ref.table);
        addEdge(refId, id, ref.kind === 'buffer' ? 'buffer' : 'shard');
      } else if (ref && ref.regex) {
        let rx: RegExp | null = null;
        try { rx = new RegExp(ref.regex); } catch { /* keep the no-throw contract */ }
        for (const cand of rx ? tables : []) {
          // `!`: this loop only ever iterates when `rx` is truthy (the ternary
          // just above), so `rx` is guaranteed non-null for every `cand`.
          if (cand.database === (ref.db || t.database) && cand.name !== t.name && rx!.test(cand.name)) {
            addEdge(rowId(cand), id, 'merge');
          }
        }
      }
    }
  }

  // dictionaries: prefer loading_dependencies (structured) else parse source/CREATE.
  // Index system.dictionaries by db.name once (O(1) source lookup, not O(D) per dict).
  const dictByid = new Map<string, SchemaGraphDictRow>(dicts.map((d): [string, SchemaGraphDictRow] => [d.database + '.' + d.name, d]));
  for (const t of tables) {
    const id = rowId(t);
    // `!`: id was registered for every table row in the first pass above.
    if (nodes.get(id)!.kind !== 'dictionary') continue;
    const ld = zip(t.loading_dependencies_database, t.loading_dependencies_table);
    const d = dictByid.get(id);
    if (ld.length) {
      for (const src of ld) { node(src.id, kindOf(src.id), src.db, src.name); addEdge(src.id, id, 'dict'); }
    } else {
      const s = parseDictSource(d && d.source, t.create_table_query);
      if (s && s.table) { const sid = joinId(s.db || t.database, s.table); node(sid, 'table', s.db || t.database, s.table); addEdge(sid, id, 'dict'); }
      else if (s && s.external) addEdge(external(s.external), id, 'dict');
    }
  }

  let outNodes = [...nodes.values()];
  let outEdges = edges;
  if (focus && focus.kind === 'table') {
    // focus.table is always a bare name (db is separate in the drag payload), so
    // join unconditionally — a dotted table name (`…snappy.parquet`) must keep its
    // db prefix to match the rowId-built node ids, or the 1-hop filter finds nothing.
    // `!`: a table-focus request always supplies both `db` and `table` (the
    // schema panel's drag payload / every table-focus caller); `SchemaGraphFocus`
    // keeps them optional only to match net/ch-client.ts's looser `LineageFocus`.
    const center = joinId(focus.db!, focus.table!);
    const keep = new Set([center]);
    for (const e of edges) { if (e.from === center) keep.add(e.to); if (e.to === center) keep.add(e.from); }
    outNodes = outNodes.filter((n) => keep.has(n.id));
    outEdges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  }
  // Whole-DB lineage: keep EVERY table as a node, linked or not. A database view
  // should show all of its objects — with lineage edges drawn where they exist —
  // rather than hiding the unlinked tables behind the relationships. (Cross-DB
  // scoping in the full view is handled afterwards by expandLineage, which seeds
  // the focus DB and BFS-walks only the connected nodes of other databases.)

  // Display label: inside the focused database the "<db>." prefix is redundant, so
  // show just the table name; a node from another database keeps its qualified id
  // so its cross-DB origin stays visible. Only the untouched id is rewritten — the
  // friendly ·inner and external-source labels are left alone — and ids/edges
  // (which key everything, incl. click-to-SHOW-CREATE) are unaffected.
  const curDb = focus && focus.db;
  if (curDb) for (const n of outNodes) { if (n.db === curDb && n.name && n.label === n.id) n.label = n.name; }
  return { nodes: outNodes, edges: outEdges };
}

/**
 * The databases referenced by `graph`'s nodes that aren't in `loadedDbs` — the
 * next databases to fetch to extend a transitive cross-DB lineage. External
 * (non-CH `ext:`) leaves carry an empty db and are skipped. Pure.
 */
export function externalDbs(
  graph: { nodes?: { db: string }[] } | null | undefined, loadedDbs?: Iterable<string> | null,
): string[] {
  const loaded = new Set(loadedDbs || []);
  const out = new Set<string>();
  for (const n of (graph && graph.nodes) || []) {
    if (n.db && !loaded.has(n.db)) out.add(n.db);
  }
  return [...out];
}

/** One node as `expandLineage` reads/returns it — the minimal `{id, db}` shape
 *  plus whatever else the caller's node objects carry (a real `SchemaGraphNode`,
 *  or a bare test fixture). */
export interface ExpandLineageNode {
  id: string;
  db: string;
  [k: string]: unknown;
}

/** One edge as `expandLineage` reads it. */
export interface ExpandLineageEdge {
  from: string;
  to: string;
  kind: string;
}

/** `expandLineage`'s input graph. */
export interface ExpandLineageGraph {
  nodes?: ExpandLineageNode[];
  edges?: ExpandLineageEdge[];
}

/** `expandLineage`'s options — `cap` bounds the cross-db BFS expansion (default 600). */
export interface ExpandLineageOptions {
  cap?: number;
}

/** `expandLineage`'s result: the reached nodes (each tagged `external`), the
 *  edges between them, and whether the cross-db expansion hit `cap`. */
export interface ExpandedLineage {
  nodes: (ExpandLineageNode & { external: boolean })[];
  edges: ExpandLineageEdge[];
  truncated: boolean;
}

/**
 * Transitive closure of `graph` around every node in `seedDb`: an undirected BFS
 * over the edges in BOTH directions across database boundaries, until the frontier
 * empties or `cap` nodes are reached (then `truncated`). Returns `{ nodes, edges,
 * truncated }` with each node tagged `external = (n.db !== seedDb)` and only the
 * reached nodes/edges kept. All of `seedDb` is seeded unconditionally; the cap
 * bounds only the cross-DB expansion (a pathologically interconnected cluster
 * can't freeze the view). Pure — the loader decides which DBs to fetch.
 */
export function expandLineage(
  graph: ExpandLineageGraph | null | undefined, seedDb: string, opts: ExpandLineageOptions = {},
): ExpandedLineage {
  const cap = opts.cap != null ? opts.cap : 600;
  const allNodes = (graph && graph.nodes) || [];
  const edges = (graph && graph.edges) || [];
  const byId = new Map(allNodes.map((n): [string, ExpandLineageNode] => [n.id, n]));
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string): void => { const l = adj.get(a); if (l) l.push(b); else adj.set(a, [b]); };
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    link(e.from, e.to); link(e.to, e.from);
  }
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const n of allNodes) if (n.db === seedDb) { visited.add(n.id); queue.push(n.id); }
  let truncated = false;
  while (queue.length && !truncated) {
    // `!`: the `while` guard above guarantees `queue` is non-empty here, so this
    // one `shift()` per outer iteration always returns a real id.
    for (const nb of adj.get(queue.shift()!) || []) {
      if (visited.has(nb)) continue;
      if (visited.size >= cap) { truncated = true; break; }
      visited.add(nb); queue.push(nb);
    }
  }
  // `!`: every id in `visited` came either from `allNodes` (the seed loop above)
  // or from `link()`, which only ever runs for edge endpoints already confirmed
  // present in `byId` — so every visited id resolves here.
  const nodes = [...visited].map((id) => ({ ...byId.get(id)!, external: byId.get(id)!.db !== seedDb }));
  const outEdges = edges.filter((e) => visited.has(e.from) && visited.has(e.to));
  return { nodes, edges: outEdges, truncated };
}
