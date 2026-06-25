import { describe, it, expect } from 'vitest';
import {
  objectKind, parseAstTables, parseMvTarget, parseDictSource, parseEngineRef, buildSchemaGraph,
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
  it('reads the explicit TO target before the SELECT body', () => {
    expect(parseMvTarget('CREATE MATERIALIZED VIEW lin.events_mv TO lin.events_daily (`day` Date) AS SELECT toDate(ts) AS day FROM lin.events GROUP BY day')).toBe('lin.events_daily');
  });
  it('returns null for an implicit MV (ENGINE = …, no TO)', () => {
    expect(parseMvTarget('CREATE MATERIALIZED VIEW lin.events_mv2 (`day` Date) ENGINE = SummingMergeTree ORDER BY day AS SELECT toDate(ts) AS day FROM lin.events GROUP BY day')).toBeNull();
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

  it('drops isolated tables from a whole-DB graph when there is lineage', () => {
    const rows = { tables: [
      T('lin', 'src', 'MergeTree'),
      T('lin', 'mv', 'MaterializedView', { astTables: ['lin.src'], create_table_query: 'CREATE MATERIALIZED VIEW lin.mv TO lin.dst AS SELECT 1 FROM lin.src' }),
      T('lin', 'dst', 'MergeTree'),
      T('lin', 'orphan', 'MergeTree'), // no relationships → pruned
    ], dictionaries: [] };
    const ids = new Set(buildSchemaGraph(rows, { kind: 'db', db: 'lin' }).nodes.map((n) => n.id));
    expect(ids.has('lin.src')).toBe(true);
    expect(ids.has('lin.orphan')).toBe(false);
  });

  it('keeps all tables when a DB has no lineage at all', () => {
    const rows = { tables: [T('lin', 'a', 'MergeTree'), T('lin', 'b', 'MergeTree')], dictionaries: [] };
    const ids = new Set(buildSchemaGraph(rows, { kind: 'db', db: 'lin' }).nodes.map((n) => n.id));
    expect(ids.has('lin.a')).toBe(true);
    expect(ids.has('lin.b')).toBe(true);
  });

  it('never throws on a malformed Merge regex (keeps the no-throw contract)', () => {
    const rows = { tables: [
      T('lin', 'm', 'Merge', { engine_full: "Merge('lin', '([')" }), // invalid regex
      T('lin', 'events', 'MergeTree'),
    ], dictionaries: [] };
    expect(() => buildSchemaGraph(rows, { kind: 'db', db: 'lin' })).not.toThrow();
  });

  it('tolerates empty input', () => {
    expect(buildSchemaGraph(null, { kind: 'db', db: 'x' })).toEqual({ nodes: [], edges: [] });
    expect(buildSchemaGraph({}, null)).toEqual({ nodes: [], edges: [] });
  });
});
