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

/** Map a ClickHouse engine name to a node kind. */
export function objectKind(engine) {
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
export function parseAstTables(astText) {
  const out = [];
  const re = /^\s*TableIdentifier\s+([^\s(]+)/gm;
  let m;
  while ((m = re.exec(String(astText || '')))) out.push(m[1]);
  return out;
}

// One ClickHouse identifier part: a backtick-quoted run (with `\`` / `\\` escapes)
// or a bare identifier. Used to parse names out of create_table_query, where CH
// backtick-quotes non-bare names (e.g. TO target_all.`agg.out.parquet`).
const IDENT_PART = '(?:`(?:[^`\\\\]|\\\\.)*`|[A-Za-z_][A-Za-z0-9_]*)';
const TO_RE = new RegExp('\\sTO\\s+(' + IDENT_PART + ')(?:\\.(' + IDENT_PART + '))?');
/** Strip backticks + unescape a single identifier part to its raw name. */
function unBacktick(part) {
  return part[0] === '`' ? part.slice(1, -1).replace(/\\(.)/g, '$1') : part;
}

/**
 * The explicit `TO [db.]table` target of a materialized view as `{ db?, table }`
 * (raw, backticks stripped — so it matches the row ids), or null for an implicit
 * (`.inner.*`) MV. Handles backtick-quoted, dotted names.
 */
export function parseMvTarget(createTableQuery) {
  const s = String(createTableQuery || '');
  const head = s.split(/\sAS\s+SELECT/i)[0]; // only look before the SELECT body
  const m = TO_RE.exec(head);
  if (!m) return null;
  return m[2] ? { db: unBacktick(m[1]), table: unBacktick(m[2]) } : { table: unBacktick(m[1]) };
}

/** A dictionary's source as `{ db, table }` (ClickHouse source) or `{ external }`. */
export function parseDictSource(source, createTableQuery) {
  const src = String(source || '');
  let m = /^ClickHouse:\s*([\w]+)\.([\w]+)/i.exec(src);
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

/** Engine-arg reference for Distributed/Buffer/Merge from `engine_full`. */
export function parseEngineRef(engine, engineFull) {
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
const joinId = (db, name) => db + '.' + name;
const rowId = (r) => r.database + '.' + r.name;

/**
 * Build `{ nodes:[{id,label,kind}], edges:[{from,to,kind}] }` from system.* rows.
 * `rows = { tables:[…], dictionaries:[…] }`; each table row may carry `astTables`
 * (EXPLAIN AST sources). `focus = { kind:'db'|'table', db, table? }` scopes the
 * result (table focus → the table + its 1-hop neighbours).
 */
export function buildSchemaGraph(rows, focus) {
  const tables = (rows && rows.tables) || [];
  const dicts = (rows && rows.dictionaries) || [];
  const nodes = new Map();
  const byId = new Map(); // id → table row, for lookups
  const innerByUuid = new Map(); // implicit-MV inner storage, keyed by owner uuid

  const node = (id, kind) => {
    if (!nodes.has(id)) {
      const dot = id.indexOf('.');
      nodes.set(id, { id, label: id, kind, db: id.slice(0, dot), name: id.slice(dot + 1) });
    }
    return nodes.get(id);
  };
  // external (non-CH dictionary source) leaf
  const external = (label) => {
    const id = 'ext:' + label;
    if (!nodes.has(id)) nodes.set(id, { id, label, kind: 'external', db: '', name: label });
    return id;
  };

  for (const t of tables) {
    const id = rowId(t);
    byId.set(id, t);
    if (/^\.inner/.test(t.name)) {
      const uuid = t.name.replace(/^\.inner(_id)?\./, '');
      innerByUuid.set(uuid, id);
    }
    node(id, objectKind(t.engine));
  }
  // friendlier labels for inner storage tables
  for (const [uuid, id] of innerByUuid) {
    const n = nodes.get(id);
    if (n) n.label = '·inner';
    void uuid;
  }

  const edges = [];
  const seen = new Set();
  const addEdge = (from, to, kind) => {
    if (!from || !to || from === to) return;
    if (!nodes.has(from) || !nodes.has(to)) return; // both endpoints must be real nodes
    const k = JSON.stringify([from, to, kind]);
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ from, to, kind });
  };
  const zip = (dbs, names) => (names || []).map((nm, i) => joinId((dbs && dbs[i]) || '', nm));

  for (const t of tables) {
    const id = rowId(t);
    const kind = nodes.get(id).kind;
    // source → MV/View (structured dependents on the source side)
    for (const dep of zip(t.dependencies_database, t.dependencies_table)) {
      node(dep, byId.has(dep) ? nodes.get(dep).kind : 'table');
      addEdge(id, dep, 'feeds');
    }
    // fallback: EXPLAIN AST sources of a view/MV → source → this object. EXPLAIN
    // AST prints names unquoted, qualified-or-bare — so resolve against the known
    // ids both ways (as-is, then db-qualified). A miss (CTE/alias name) is dropped.
    if ((kind === 'mv' || kind === 'view') && Array.isArray(t.astTables)) {
      for (const src of t.astTables) {
        const sid = byId.has(src) ? src : (byId.has(joinId(t.database, src)) ? joinId(t.database, src) : null);
        if (sid) addEdge(sid, id, kind === 'mv' ? 'feeds' : 'reads');
      }
    }
    if (kind === 'mv') {
      const target = parseMvTarget(t.create_table_query);
      const targetId = target ? joinId(target.db || t.database, target.table) : innerByUuid.get(String(t.uuid || ''));
      if (targetId) { node(targetId, byId.has(targetId) ? nodes.get(targetId).kind : 'table'); addEdge(id, targetId, 'writes'); }
    } else if (kind === 'distributed' || kind === 'buffer' || kind === 'merge') {
      const ref = parseEngineRef(t.engine, t.engine_full);
      if (ref && ref.table) {
        const refId = joinId(ref.db || t.database, ref.table);
        node(refId, byId.has(refId) ? nodes.get(refId).kind : 'table');
        addEdge(refId, id, ref.kind === 'buffer' ? 'buffer' : 'shard');
      } else if (ref && ref.regex) {
        let rx = null;
        try { rx = new RegExp(ref.regex); } catch { /* keep the no-throw contract */ }
        for (const cand of rx ? tables : []) {
          if (cand.database === (ref.db || t.database) && cand.name !== t.name && rx.test(cand.name)) {
            addEdge(rowId(cand), id, 'merge');
          }
        }
      }
    }
  }

  // dictionaries: prefer loading_dependencies (structured) else parse source/CREATE
  for (const t of tables) {
    if (nodes.get(rowId(t)).kind !== 'dictionary') continue;
    const id = rowId(t);
    const ld = zip(t.loading_dependencies_database, t.loading_dependencies_table);
    const d = dicts.find((x) => x.database === t.database && x.name === t.name);
    if (ld.length) {
      for (const src of ld) { node(src, byId.has(src) ? nodes.get(src).kind : 'table'); addEdge(src, id, 'dict'); }
    } else {
      const s = parseDictSource(d && d.source, t.create_table_query);
      if (s && s.table) { const sid = joinId(s.db || t.database, s.table); node(sid, 'table'); addEdge(sid, id, 'dict'); }
      else if (s && s.external) addEdge(external(s.external), id, 'dict');
    }
  }

  let outNodes = [...nodes.values()];
  let outEdges = edges;
  if (focus && focus.kind === 'table') {
    // focus.table is always a bare name (db is separate in the drag payload), so
    // join unconditionally — a dotted table name (`…snappy.parquet`) must keep its
    // db prefix to match the rowId-built node ids, or the 1-hop filter finds nothing.
    const center = joinId(focus.db, focus.table);
    const keep = new Set([center]);
    for (const e of edges) { if (e.from === center) keep.add(e.to); if (e.to === center) keep.add(e.from); }
    outNodes = outNodes.filter((n) => keep.has(n.id));
    outEdges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  } else if (edges.length) {
    // Whole-DB lineage: drop isolated (degree-0) tables so the relationships are
    // the focus — but only when there ARE relationships, so a DB with no lineage
    // still shows its tables rather than an empty pane.
    const linked = new Set();
    for (const e of edges) { linked.add(e.from); linked.add(e.to); }
    outNodes = outNodes.filter((n) => linked.has(n.id));
  }
  return { nodes: outNodes, edges: outEdges };
}
