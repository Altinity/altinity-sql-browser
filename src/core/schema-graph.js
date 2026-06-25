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

/** The explicit `TO db.table` target of a materialized view, or null. */
export function parseMvTarget(createTableQuery) {
  const s = String(createTableQuery || '');
  const head = s.split(/\sAS\s+SELECT/i)[0]; // only look before the SELECT body
  const m = /\sTO\s+([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?)/.exec(head);
  return m ? m[1] : null;
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

// A *reference* may already be `db.table` or a bare `table`; an actual row's id is
// always `database.name` (table names like `.inner_id.<uuid>` contain dots).
const qualify = (db, name) => (name && name.includes('.') ? name : db + '.' + name);
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
  const zip = (dbs, names) => (names || []).map((nm, i) => qualify((dbs && dbs[i]) || '', nm));

  for (const t of tables) {
    const id = rowId(t);
    const kind = nodes.get(id).kind;
    // source → MV/View (structured dependents on the source side)
    for (const dep of zip(t.dependencies_database, t.dependencies_table)) {
      node(dep, byId.has(dep) ? nodes.get(dep).kind : 'table');
      addEdge(id, dep, 'feeds');
    }
    // fallback: EXPLAIN AST sources of a view/MV → source → this object. Only real
    // (in-scope) objects count, so CTE/alias names from the AST are dropped.
    if ((kind === 'mv' || kind === 'view') && Array.isArray(t.astTables)) {
      for (const src of t.astTables) {
        const sid = qualify(t.database, src);
        if (byId.has(sid)) addEdge(sid, id, kind === 'mv' ? 'feeds' : 'reads');
      }
    }
    if (kind === 'mv') {
      const target = parseMvTarget(t.create_table_query);
      const targetId = target ? qualify(t.database, target) : innerByUuid.get(String(t.uuid || ''));
      if (targetId) { node(targetId, byId.has(targetId) ? nodes.get(targetId).kind : 'table'); addEdge(id, targetId, 'writes'); }
    } else if (kind === 'distributed' || kind === 'buffer' || kind === 'merge') {
      const ref = parseEngineRef(t.engine, t.engine_full);
      if (ref && ref.table) {
        const refId = qualify(ref.db || t.database, ref.table);
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
      if (s && s.table) { const sid = qualify(s.db || t.database, s.table); node(sid, 'table'); addEdge(sid, id, 'dict'); }
      else if (s && s.external) addEdge(external(s.external), id, 'dict');
    }
  }

  let outNodes = [...nodes.values()];
  let outEdges = edges;
  if (focus && focus.kind === 'table') {
    const center = qualify(focus.db, focus.table);
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
