import { describe, it, expect } from 'vitest';
import {
  objectKind, parseAstTables, parseMvTarget, parseDictSource, parseEngineRef, buildSchemaGraph,
  expandLineage, externalDbs,
} from '../../src/core/schema-graph.js';

// Fixtures are the *actual* outputs captured from ClickHouse 26.5.1 (Docker) for a
// lineage schema: an MV with explicit TO, an implicit MV (.inner storage), a JOIN
// view, a dictionary, and Distributed/Buffer/Merge tables.

describe('objectKind', () => {
  it('maps engines to node kinds', () => {
    expect(objectKind('MaterializedView')).toBe('mv');
    expect(objectKind('View')).toBe('view');
    expect(objectKind('Dictionary')).toBe('dictionary');
    expect(objectKind('Distributed')).toBe('distributed');
    expect(objectKind('Buffer')).toBe('buffer');
    expect(objectKind('Merge')).toBe('merge');
    expect(objectKind('ReplicatedMergeTree')).toBe('table');
    expect(objectKind('')).toBe('table');
  });
});

describe('parseAstTables', () => {
  it('extracts TableIdentifier names across a JOIN (real EXPLAIN AST)', () => {
    const ast = [
      '      TablesInSelectQuery (children 2)',
      '       TableExpression (children 1)',
      '        TableIdentifier lin.events (alias e)',
      '        TableIdentifier lin.dim (alias d)',
      '      Function equals (children 1)',
    ].join('\n');
    expect(parseAstTables(ast)).toEqual(['lin.events', 'lin.dim']);
  });
  it('tolerates empty/nullish', () => {
    expect(parseAstTables('')).toEqual([]);
    expect(parseAstTables(null)).toEqual([]);
  });
});

describe('parseMvTarget', () => {
  it('reads the explicit TO target before the SELECT body as {db, table}', () => {
    expect(parseMvTarget('CREATE MATERIALIZED VIEW lin.events_mv TO lin.events_daily (`day` Date) AS SELECT toDate(ts) AS day FROM lin.events GROUP BY day')).toEqual({ db: 'lin', table: 'events_daily' });
  });
  it('strips backticks from a dotted/backticked TO target (real CH create query)', () => {
    // CH backtick-quotes non-bare names in create_table_query.
    expect(parseMvTarget('CREATE MATERIALIZED VIEW target_all.`mv-1` TO target_all.`agg.out.parquet` (`id` UInt64) AS SELECT id, count() AS c FROM target_all.`part-0.snappy.parquet` GROUP BY id'))
      .toEqual({ db: 'target_all', table: 'agg.out.parquet' });
  });
  it('returns a single {table} when the TO target is unqualified', () => {
    expect(parseMvTarget('CREATE MATERIALIZED VIEW lin.mv TO `weird.dst` AS SELECT 1')).toEqual({ table: 'weird.dst' });
  });
  it('returns null for an implicit MV (ENGINE = …, no TO)', () => {
    expect(parseMvTarget('CREATE MATERIALIZED VIEW lin.events_mv2 (`day` Date) ENGINE = SummingMergeTree ORDER BY day AS SELECT toDate(ts) AS day FROM lin.events GROUP BY day')).toBeNull();
  });
  it('does not treat a stray " TO " in the column list/comment as a target', () => {
    // implicit MV — the only TO is inside a column COMMENT, after the '(' → ignored
    expect(parseMvTarget("CREATE MATERIALIZED VIEW lin.mv (`x` String COMMENT 'route TO sink') ENGINE = SummingMergeTree ORDER BY x AS SELECT x FROM s")).toBeNull();
  });
});

describe('parseDictSource', () => {
  it('parses the loaded ClickHouse source string', () => {
    expect(parseDictSource('ClickHouse: lin.dim')).toEqual({ db: 'lin', table: 'dim' });
  });
  it('falls back to SOURCE(CLICKHOUSE(…)) in the CREATE when source is empty', () => {
    expect(parseDictSource('', "CREATE DICTIONARY lin.dim_dict (`id` UInt64) PRIMARY KEY id SOURCE(CLICKHOUSE(TABLE 'dim' DB 'lin')) LIFETIME(MIN 0 MAX 0) LAYOUT(HASHED())")).toEqual({ db: 'lin', table: 'dim' });
  });
  it('reports a non-ClickHouse source as external', () => {
    expect(parseDictSource('MySQL: host=db user=x')).toEqual({ external: 'MySQL' });
    expect(parseDictSource('', '')).toBeNull();
  });
});

describe('parseEngineRef', () => {
  it('parses Distributed / Buffer / Merge engine_full', () => {
    expect(parseEngineRef('Distributed', "Distributed('default', 'lin', 'events', rand())")).toEqual({ kind: 'distributed', cluster: 'default', db: 'lin', table: 'events' });
    expect(parseEngineRef('Buffer', "Buffer('lin', 'events', 1, 10, 100, 10000, 1000000, 10000000, 100000000)")).toEqual({ kind: 'buffer', db: 'lin', table: 'events' });
    expect(parseEngineRef('Merge', "Merge('lin', '^events$')")).toEqual({ kind: 'merge', db: 'lin', regex: '^events$' });
    expect(parseEngineRef('MergeTree', 'MergeTree')).toBeNull();
  });
});

// ---- whole-graph assembly against the captured `lin` schema ----
const UUID = '79c63514-8064-4314-b6eb-e12147f0b28b';
const T = (database, name, engine, over = {}) => ({
  database, name, engine, engine_full: '', create_table_query: '', as_select: '', uuid: '',
  dependencies_database: [], dependencies_table: [], loading_dependencies_database: [], loading_dependencies_table: [], ...over,
});
const ROWS = {
  tables: [
    T('lin', 'dim', 'MergeTree'),
    T('lin', 'events', 'MergeTree', { dependencies_database: ['lin', 'lin'], dependencies_table: ['events_mv2', 'events_mv'] }),
    T('lin', 'events_daily', 'SummingMergeTree'),
    T('lin', 'events_mv', 'MaterializedView', { create_table_query: 'CREATE MATERIALIZED VIEW lin.events_mv TO lin.events_daily (`day` Date) AS SELECT toDate(ts) AS day FROM lin.events GROUP BY day' }),
    T('lin', 'events_mv2', 'MaterializedView', { uuid: UUID, create_table_query: 'CREATE MATERIALIZED VIEW lin.events_mv2 (`day` Date) ENGINE = SummingMergeTree ORDER BY day AS SELECT toDate(ts) AS day FROM lin.events GROUP BY day' }),
    T('lin', '.inner_id.' + UUID, 'SummingMergeTree'),
    T('lin', 'events_view', 'View', { astTables: ['lin.events', 'lin.dim', 'lin.cte_not_real'] }),
    T('lin', 'dim_dict', 'Dictionary', { loading_dependencies_database: ['lin'], loading_dependencies_table: ['dim'] }),
    T('lin', 'events_buf', 'Buffer', { engine_full: "Buffer('lin', 'events', 1, 10, 100, 10000, 1000000, 10000000, 100000000)" }),
    T('lin', 'events_all', 'Merge', { engine_full: "Merge('lin', '^events$')" }),
    T('lin', 'events_dist', 'Distributed', { engine_full: "Distributed('default', 'lin', 'events', rand())" }),
  ],
  dictionaries: [{ database: 'lin', name: 'dim_dict', source: 'ClickHouse: lin.dim' }],
};
const eset = (g) => new Set(g.edges.map((e) => `${e.from}>${e.to}:${e.kind}`));

describe('buildSchemaGraph', () => {
  it('derives every CH relationship type for the whole DB', () => {
    const g = buildSchemaGraph(ROWS, { kind: 'db', db: 'lin' });
    const E = eset(g);
    expect(E.has('lin.events>lin.events_mv:feeds')).toBe(true);     // dependencies_table
    expect(E.has('lin.events>lin.events_mv2:feeds')).toBe(true);
    expect(E.has('lin.events_mv>lin.events_daily:writes')).toBe(true); // TO target
    expect(E.has('lin.events_mv2>lin..inner_id.' + UUID + ':writes')).toBe(true); // implicit → inner
    expect(E.has('lin.events>lin.events_view:reads')).toBe(true);   // AST source
    expect(E.has('lin.dim>lin.events_view:reads')).toBe(true);
    expect(E.has('lin.dim>lin.dim_dict:dict')).toBe(true);          // loading_dependencies
    expect(E.has('lin.events>lin.events_dist:shard')).toBe(true);   // engine_full
    expect(E.has('lin.events>lin.events_buf:buffer')).toBe(true);
    expect(E.has('lin.events>lin.events_all:merge')).toBe(true);    // Merge regex match
    // the CTE/alias name in the AST is NOT a real object → no phantom node/edge
    expect(g.nodes.some((n) => n.id === 'lin.cte_not_real')).toBe(false);
    // node kinds carried through
    expect(g.nodes.find((n) => n.id === 'lin.events_mv').kind).toBe('mv');
    expect(g.nodes.find((n) => n.id === 'lin.dim_dict').kind).toBe('dictionary');
  });

  it('falls back to AST feeds for an MV when dependencies_table is empty', () => {
    const rows = { tables: [
      T('lin', 'src', 'MergeTree'),
      T('lin', 'mv', 'MaterializedView', { astTables: ['lin.src'], create_table_query: 'CREATE MATERIALIZED VIEW lin.mv TO lin.dst AS SELECT 1 FROM lin.src' }),
      T('lin', 'dst', 'MergeTree'),
    ], dictionaries: [] };
    const E = eset(buildSchemaGraph(rows, { kind: 'db', db: 'lin' }));
    expect(E.has('lin.src>lin.mv:feeds')).toBe(true);
    expect(E.has('lin.mv>lin.dst:writes')).toBe(true);
  });

  it('parses an external dictionary source as a leaf', () => {
    const rows = { tables: [T('lin', 'd', 'Dictionary', { create_table_query: "CREATE DICTIONARY lin.d (id UInt64) PRIMARY KEY id SOURCE(HTTP(url 'http://x')) LAYOUT(FLAT())" })], dictionaries: [{ database: 'lin', name: 'd', source: 'HTTP: http://x' }] };
    const g = buildSchemaGraph(rows, { kind: 'db', db: 'lin' });
    expect(g.nodes.some((n) => n.kind === 'external' && n.label === 'HTTP')).toBe(true);
    expect(eset(g).has('ext:HTTP>lin.d:dict')).toBe(true);
  });

  it('table focus keeps only the table and its 1-hop neighbours', () => {
    const g = buildSchemaGraph(ROWS, { kind: 'table', db: 'lin', table: 'events' });
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.has('lin.events')).toBe(true);
    expect(ids.has('lin.events_mv')).toBe(true);  // direct neighbour
    expect(ids.has('lin.events_view')).toBe(true);
    expect(ids.has('lin.dim')).toBe(false);       // only connects via events_view, not to events
    expect(ids.has('lin.events_daily')).toBe(false); // connects via events_mv, not events
  });

  it('creates leaf nodes (kind table) for cross-database references', () => {
    const rows = { tables: [
      T('lin', 'mv', 'MaterializedView', { create_table_query: 'CREATE MATERIALIZED VIEW lin.mv TO other.dst AS SELECT 1 FROM lin.src' }),
      T('lin', 'src', 'MergeTree', { dependencies_database: ['other'], dependencies_table: ['xmv'] }),
      T('lin', 'dist', 'Distributed', { engine_full: "Distributed('c', 'other', 'remote')" }),
      T('lin', 'd', 'Dictionary', { loading_dependencies_database: ['other'], loading_dependencies_table: ['dsrc'] }),
    ], dictionaries: [] };
    const g = buildSchemaGraph(rows, { kind: 'db', db: 'lin' });
    const kindOf = (id) => (g.nodes.find((n) => n.id === id) || {}).kind;
    expect(kindOf('other.dst')).toBe('table'); // unknown target → leaf
    expect(kindOf('other.xmv')).toBe('table');
    expect(kindOf('other.remote')).toBe('table');
    expect(kindOf('other.dsrc')).toBe('table');
    const E = eset(g);
    expect(E.has('lin.mv>other.dst:writes')).toBe(true);
    expect(E.has('lin.src>other.xmv:feeds')).toBe(true);
    expect(E.has('other.remote>lin.dist:shard')).toBe(true);
    expect(E.has('other.dsrc>lin.d:dict')).toBe(true);
  });

  it('table focus keeps incoming neighbours too', () => {
    const g = buildSchemaGraph(ROWS, { kind: 'table', db: 'lin', table: 'events_mv' });
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.has('lin.events')).toBe(true);       // events → events_mv (incoming, to===center)
    expect(ids.has('lin.events_daily')).toBe(true); // events_mv → events_daily (outgoing)
  });

  it('keeps isolated tables in a whole-DB graph even when there is lineage', () => {
    // A whole-DB view shows ALL objects: the lineage chain AND the unlinked tables
    // alongside it (the lineage edges are still drawn between the linked ones).
    const rows = { tables: [
      T('lin', 'src', 'MergeTree'),
      T('lin', 'mv', 'MaterializedView', { astTables: ['lin.src'], create_table_query: 'CREATE MATERIALIZED VIEW lin.mv TO lin.dst AS SELECT 1 FROM lin.src' }),
      T('lin', 'dst', 'MergeTree'),
      T('lin', 'orphan', 'MergeTree'), // unlinked — still drawn
    ], dictionaries: [] };
    const g = buildSchemaGraph(rows, { kind: 'db', db: 'lin' });
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.has('lin.src')).toBe(true);
    expect(ids.has('lin.orphan')).toBe(true);   // isolated, but kept
    expect(eset(g).has('lin.src>lin.mv:feeds')).toBe(true); // lineage edges still present
  });

  it('strips the focus-db prefix from same-db node labels but keeps it cross-db', () => {
    const rows = { tables: [
      T('lin', 'events', 'MergeTree'), // same db, isolated
      T('lin', 'dist', 'Distributed', { engine_full: "Distributed('cl', 'other', 'remote_tbl')" }),
    ], dictionaries: [] };
    const byId = Object.fromEntries(buildSchemaGraph(rows, { kind: 'db', db: 'lin' }).nodes.map((n) => [n.id, n]));
    expect(byId['lin.events'].label).toBe('events');                 // same db → bare table name
    expect(byId['lin.dist'].label).toBe('dist');                     // same db → bare table name
    expect(byId['other.remote_tbl'].label).toBe('other.remote_tbl'); // another db → stays qualified
  });

  it('keeps every table as a standalone node when a whole-DB graph has no relationships', () => {
    // A DB of unrelated tables (e.g. all URL engine) still renders its tables —
    // showing the objects beats an empty "no relationships" screen, even though
    // there are no edges to draw between them.
    const tables = Array.from({ length: 50 }, (_, i) => T('lin', 'url_' + i, 'URL'));
    const g = buildSchemaGraph({ tables, dictionaries: [] }, { kind: 'db', db: 'lin' });
    expect(g.nodes).toHaveLength(50);
    expect(g.edges).toEqual([]);
  });

  it('never throws on a malformed Merge regex (keeps the no-throw contract)', () => {
    const rows = { tables: [
      T('lin', 'm', 'Merge', { engine_full: "Merge('lin', '([')" }), // invalid regex
      T('lin', 'events', 'MergeTree'),
    ], dictionaries: [] };
    expect(() => buildSchemaGraph(rows, { kind: 'db', db: 'lin' })).not.toThrow();
  });

  it('links an MV to a backticked/dotted TO target and a dotted AST source (CH 26.5 fixtures)', () => {
    // Captured from Docker CH 26.5.1: create_table_query backtick-quotes the TO
    // target; EXPLAIN AST prints the source unquoted (here UNqualified + dotted).
    const rows = { tables: [
      T('target_all', 'part-0.snappy.parquet', 'MergeTree'),
      T('target_all', 'agg.out.parquet', 'SummingMergeTree'),
      T('target_all', 'mv-1', 'MaterializedView', {
        astTables: ['part-0.snappy.parquet'], // unqualified, dotted (default-db ref)
        create_table_query: 'CREATE MATERIALIZED VIEW target_all.`mv-1` TO target_all.`agg.out.parquet` (`id` UInt64) AS SELECT id, count() AS c FROM target_all.`part-0.snappy.parquet` GROUP BY id',
      }),
    ], dictionaries: [] };
    const g = buildSchemaGraph(rows, { kind: 'db', db: 'target_all' });
    const E = eset(g);
    expect(E.has('target_all.part-0.snappy.parquet>target_all.mv-1:feeds')).toBe(true); // AST source resolved
    expect(E.has('target_all.mv-1>target_all.agg.out.parquet:writes')).toBe(true);      // backticked TO target
    expect(g.nodes.some((n) => n.id === 'target_all.target_all')).toBe(false);           // no phantom from the old bug
  });

  it('resolves a fully-qualified dotted AST source (CH prints db.table unquoted)', () => {
    const rows = { tables: [
      T('target_all', 'part-0.snappy.parquet', 'MergeTree'),
      T('target_all', 'v', 'View', { astTables: ['target_all.part-0.snappy.parquet'] }),
    ], dictionaries: [] };
    expect(eset(buildSchemaGraph(rows, { kind: 'db', db: 'target_all' })).has('target_all.part-0.snappy.parquet>target_all.v:reads')).toBe(true);
  });

  it('table-focus on a dotted-name table keeps the center + its 1-hop (not empty)', () => {
    const rows = { tables: [
      T('target_all', 'part-0.snappy.parquet', 'MergeTree', { dependencies_database: ['target_all'], dependencies_table: ['v_over_parquet'] }),
      T('target_all', 'v_over_parquet', 'View'),
      T('target_all', 'unrelated', 'MergeTree'),
    ], dictionaries: [] };
    const g = buildSchemaGraph(rows, { kind: 'table', db: 'target_all', table: 'part-0.snappy.parquet' });
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.has('target_all.part-0.snappy.parquet')).toBe(true); // center kept its db prefix
    expect(ids.has('target_all.v_over_parquet')).toBe(true);        // 1-hop neighbour
    expect(ids.has('target_all.unrelated')).toBe(false);
  });

  it('keeps the db prefix for a dependency whose table name contains dots', () => {
    // dependencies_* carry the db separately, so a dotted table name (a parquet
    // file table) must still join to db.<name>, not be mistaken for db-qualified.
    const rows = { tables: [
      T('target_all', 'part-0.snappy.parquet', 'MergeTree', { dependencies_database: ['target_all'], dependencies_table: ['v_over_parquet'] }),
      T('target_all', 'v_over_parquet', 'View'),
    ], dictionaries: [] };
    const g = buildSchemaGraph(rows, { kind: 'db', db: 'target_all' });
    expect(eset(g).has('target_all.part-0.snappy.parquet>target_all.v_over_parquet:feeds')).toBe(true);
  });

  it('tolerates empty input', () => {
    expect(buildSchemaGraph(null, { kind: 'db', db: 'x' })).toEqual({ nodes: [], edges: [] });
    expect(buildSchemaGraph({}, null)).toEqual({ nodes: [], edges: [] });
  });

  it('keeps a dotted DATABASE name intact as node.db (not the first segment)', () => {
    const rows = { tables: [
      T('my.db', 'tbl', 'MergeTree', { dependencies_database: ['my.db'], dependencies_table: ['mv'] }),
      T('my.db', 'mv', 'MaterializedView'),
    ], dictionaries: [] };
    const tbl = buildSchemaGraph(rows, { kind: 'db', db: 'my.db' }).nodes.find((n) => n.id === 'my.db.tbl');
    expect(tbl.db).toBe('my.db');   // not 'my'
    expect(tbl.name).toBe('tbl');   // not 'db.tbl'
  });
});

describe('externalDbs', () => {
  it('lists referenced dbs not yet loaded, skipping ext: leaves', () => {
    const g = { nodes: [{ id: 'a.x', db: 'a' }, { id: 'b.y', db: 'b' }, { id: 'a.z', db: 'a' }, { id: 'ext:HTTP', db: '' }] };
    expect(externalDbs(g, ['a']).sort()).toEqual(['b']);
    expect(externalDbs(g, []).sort()).toEqual(['a', 'b']);
    expect(externalDbs(null, ['a'])).toEqual([]);
  });
});

describe('expandLineage', () => {
  const G = {
    nodes: [
      { id: 'a.t1', db: 'a' }, { id: 'a.t2', db: 'a' },
      { id: 'b.u', db: 'b' }, { id: 'c.w', db: 'c' }, { id: 'd.iso', db: 'd' },
    ],
    edges: [
      { from: 'a.t1', to: 'b.u', kind: 'feeds' },  // a → b (1 hop)
      { from: 'b.u', to: 'c.w', kind: 'writes' },  // b → c (transitive)
    ],
  };
  it('seeds the whole seed db and walks transitively across db boundaries, tagging external', () => {
    const out = expandLineage(G, 'a');
    const ids = new Set(out.nodes.map((n) => n.id));
    expect(ids.has('a.t1')).toBe(true);
    expect(ids.has('a.t2')).toBe(true);  // seeded even though isolated within 'a'
    expect(ids.has('b.u')).toBe(true);   // 1 hop
    expect(ids.has('c.w')).toBe(true);   // transitive 2 hops
    expect(ids.has('d.iso')).toBe(false); // unreached
    expect(out.nodes.find((n) => n.id === 'a.t1').external).toBe(false);
    expect(out.nodes.find((n) => n.id === 'b.u').external).toBe(true);
    expect(out.edges).toHaveLength(2);
    expect(out.truncated).toBe(false);
  });
  it('walks both directions — a reverse edge into the seed pulls its source in', () => {
    const g = { nodes: [{ id: 'a.t', db: 'a' }, { id: 'b.s', db: 'b' }], edges: [{ from: 'b.s', to: 'a.t', kind: 'feeds' }] };
    expect(new Set(expandLineage(g, 'a').nodes.map((n) => n.id)).has('b.s')).toBe(true);
  });
  it('caps the cross-db expansion and flags truncated', () => {
    const nodes = [{ id: 'a.seed', db: 'a' }];
    const edges = [];
    let prev = 'a.seed';
    for (let i = 0; i < 10; i++) { const id = 'x.n' + i; nodes.push({ id, db: 'x' }); edges.push({ from: prev, to: id, kind: 'feeds' }); prev = id; }
    const out = expandLineage({ nodes, edges }, 'a', { cap: 5 });
    expect(out.truncated).toBe(true);
    expect(out.nodes.length).toBeLessThanOrEqual(5);
  });
  it('ignores edges whose endpoints are not real nodes, and tolerates a null graph', () => {
    const g = { nodes: [{ id: 'a.t', db: 'a' }], edges: [{ from: 'a.t', to: 'ghost', kind: 'feeds' }] };
    const out = expandLineage(g, 'a');
    expect(out.nodes.map((n) => n.id)).toEqual(['a.t']);
    expect(out.edges).toEqual([]);
    expect(expandLineage(null, 'a')).toEqual({ nodes: [], edges: [], truncated: false });
  });
});
