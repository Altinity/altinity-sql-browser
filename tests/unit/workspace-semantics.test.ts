import { describe, expect, it } from 'vitest';
import {
  isFlowLayout, isSupportedLayout, queryDashboardRole,
  unsupportedDashboardVersionDiagnostics, unsupportedSpecVersionDiagnostics,
  validateDashboardCollectionSemantics, validateDashboardSemantics,
  validateQueryCollectionSemantics,
} from '../../src/dashboard/model/workspace-semantics.js';
import { PORTABLE_LIMITS } from '../../src/dashboard/model/portable-limits.js';
import type { WorkspaceDiagnostic } from '../../src/dashboard/model/workspace-diagnostics.js';

const codes = (diagnostics: WorkspaceDiagnostic[]): string[] => diagnostics.map((d) => d.code);
const has = (diagnostics: WorkspaceDiagnostic[], code: string): boolean => diagnostics.some((d) => d.code === code);

// A panel-role saved query. `role` undefined defaults to panel.
const panelQuery = (id: string, over: Record<string, unknown> = {}, dashboard?: Record<string, unknown>) => ({
  id, sql: 'SELECT 1', specVersion: 1,
  spec: { name: id, panel: { cfg: { type: 'bar', x: 0, y: [1] } }, ...(dashboard ? { dashboard } : {}), ...over },
});
const filterQuery = (id: string, sql = "SELECT ['a','b'] AS country") => ({
  id, sql, specVersion: 1, spec: { name: id, dashboard: { role: 'filter' } },
});
const flowLayout = (items: Record<string, unknown> = {}) => ({ type: 'flow', version: 1, preset: 'report', items });
const gridLayout = (items: Record<string, unknown> = {}) => ({ type: 'grafana-grid', version: 1, items });
const dashboardDoc = (over: Record<string, unknown> = {}) => ({
  documentVersion: 1, id: 'd1', title: 'D', revision: 1,
  layout: flowLayout(), filters: [], tiles: [], ...over,
});
const tile = (id: string, queryId: string, over: Record<string, unknown> = {}) => ({ id, queryId, ...over });

describe('helper predicates', () => {
  it('isSupportedLayout accepts every registered primary engine at its supported version', () => {
    expect(isSupportedLayout('flow', 1)).toBe(true);
    expect(isSupportedLayout('flow', 2)).toBe(false);
    expect(isSupportedLayout('grafana-grid', 1)).toBe(true);
    expect(isSupportedLayout('grafana-grid', 2)).toBe(false);
    expect(isSupportedLayout('grid', 1)).toBe(false);
    expect(isSupportedLayout(null, 1)).toBe(false);
    expect(isSupportedLayout('flow', '1')).toBe(false);
  });

  it('isFlowLayout accepts only flow@1, even for another supported engine', () => {
    expect(isFlowLayout('flow', 1)).toBe(true);
    expect(isFlowLayout('flow', 2)).toBe(false);
    expect(isFlowLayout('grafana-grid', 1)).toBe(false);
  });

  it('queryDashboardRole defaults to panel through every non-role shape', () => {
    expect(queryDashboardRole(null)).toBe('panel');
    expect(queryDashboardRole({ spec: null })).toBe('panel');
    expect(queryDashboardRole({ spec: { dashboard: null } })).toBe('panel');
    expect(queryDashboardRole({ spec: { dashboard: { role: 5 } } })).toBe('panel');
    expect(queryDashboardRole({ spec: { dashboard: { role: 'filter' } } })).toBe('filter');
  });
});

describe('fail-closed version pre-scans', () => {
  it('flags queries with an unsupported specVersion only', () => {
    const diagnostics = unsupportedSpecVersionDiagnostics([
      { id: 'ok', specVersion: 1 }, { id: 'bad', specVersion: 7 }, 'not-object', { specVersion: 1.5 },
    ]);
    expect(codes(diagnostics)).toEqual(['spec-version-unsupported']);
    expect(diagnostics[0].path).toEqual(['queries', 1, 'specVersion']);
    expect(diagnostics[0].resource).toBe('bad');
  });

  it('flags dashboards whose documentVersion is a known integer other than 1', () => {
    const diagnostics = unsupportedDashboardVersionDiagnostics([
      { id: 'ok', documentVersion: 1 }, { id: 'future', documentVersion: 2 }, 'x', { documentVersion: 'nope' },
    ]);
    expect(codes(diagnostics)).toEqual(['dashboard-version-unsupported']);
    expect(diagnostics[0].resource).toBe('future');
  });
});

describe('validateQueryCollectionSemantics', () => {
  it('accepts a clean collection', () => {
    expect(validateQueryCollectionSemantics([panelQuery('q1'), panelQuery('q2')])).toEqual([]);
  });

  it('flags duplicate ids and skips non-object entries', () => {
    const diagnostics = validateQueryCollectionSemantics([panelQuery('dup'), 'nope', panelQuery('dup')]);
    expect(has(diagnostics, 'workspace-duplicate-query-id')).toBe(true);
  });

  it('enforces the collection-count, id, sql, and name length limits', () => {
    expect(has(validateQueryCollectionSemantics(
      Array.from({ length: PORTABLE_LIMITS.maxQueries + 1 }, (_, i) => panelQuery(`q${i}`)),
    ), 'limit-query-count')).toBe(true);
    const long = 'x'.repeat(PORTABLE_LIMITS.maxIdLength + 1);
    expect(has(validateQueryCollectionSemantics([panelQuery(long)]), 'limit-id-length')).toBe(true);
    expect(has(validateQueryCollectionSemantics([
      { id: 'q', sql: 's'.repeat(PORTABLE_LIMITS.maxSqlLength + 1), specVersion: 1, spec: {} },
    ]), 'limit-sql-length')).toBe(true);
    expect(has(validateQueryCollectionSemantics([
      { id: 'q', sql: 'x', specVersion: 1, spec: { name: 'n'.repeat(PORTABLE_LIMITS.maxNameLength + 1) } },
    ]), 'limit-name-length')).toBe(true);
  });

  it('re-checks the query description length at boundary and boundary+1', () => {
    const atLimit = { id: 'q', sql: 'x', specVersion: 1, spec: { name: 'q', description: 'd'.repeat(PORTABLE_LIMITS.maxDescriptionLength) } };
    expect(has(validateQueryCollectionSemantics([atLimit]), 'limit-description-length')).toBe(false);
    const overLimit = { id: 'q', sql: 'x', specVersion: 1, spec: { name: 'q', description: 'd'.repeat(PORTABLE_LIMITS.maxDescriptionLength + 1) } };
    const diagnostics = validateQueryCollectionSemantics([overLimit]);
    expect(has(diagnostics, 'limit-description-length')).toBe(true);
    expect(diagnostics.find((x) => x.code === 'limit-description-length')!.path)
      .toEqual(['queries', 0, 'spec', 'description']);
  });

  it('enforces the serialized-Spec byte limit', () => {
    const big = { id: 'q', sql: 'x', specVersion: 1, spec: { description: 'x'.repeat(PORTABLE_LIMITS.maxSerializedQuerySpecBytes + 10) } };
    expect(has(validateQueryCollectionSemantics([big]), 'limit-spec-bytes')).toBe(true);
  });

  it('skips queries whose spec is not an object', () => {
    expect(validateQueryCollectionSemantics([{ id: 'q', sql: 'x', specVersion: 1, spec: 'no' }])).toEqual([]);
  });

  it('validates variant count, defaultVariant existence, and static renderer-type changes', () => {
    const tooMany: Record<string, unknown> = {};
    for (let i = 0; i <= PORTABLE_LIMITS.maxVariantsPerQuery; i++) tooMany[`v${i}`] = {};
    expect(has(validateQueryCollectionSemantics([panelQuery('q', {}, { variants: tooMany })]), 'limit-variant-count')).toBe(true);

    expect(has(validateQueryCollectionSemantics([panelQuery('q', {}, { defaultVariant: 'missing', variants: { present: {} } })]),
      'query-default-variant-missing')).toBe(true);
    expect(validateQueryCollectionSemantics([panelQuery('q', {}, { defaultVariant: 'present', variants: { present: {} } })]))
      .toEqual([]);

    // A variant whose patch changes cfg.type from the base bar renderer.
    expect(has(validateQueryCollectionSemantics([panelQuery('q', {}, { variants: { alt: { cfg: { type: 'line' } } } })]),
      'presentation-renderer-type-change')).toBe(true);
    // A same-type patch and a patch without a cfg.type are fine.
    expect(validateQueryCollectionSemantics([panelQuery('q', {}, { variants: { same: { cfg: { type: 'bar' } }, nocfg: { title: 't' } } })]))
      .toEqual([]);
  });

  it('ignores a defaultVariant that is not a string', () => {
    expect(validateQueryCollectionSemantics([panelQuery('q', {}, { defaultVariant: 5 })])).toEqual([]);
  });
});

describe('validateDashboardSemantics', () => {
  it('accepts a clean dashboard with resolvable tiles and filters', () => {
    const queries = [panelQuery('p1'), filterQuery('f1')];
    const dashboard = dashboardDoc({
      tiles: [tile('t1', 'p1')],
      layout: flowLayout({ t1: { span: 1, height: 'medium' } }),
      filters: [{ id: 'flt', parameter: 'country', sourceQueryId: 'f1', targets: ['t1'] }],
    });
    // t1's query p1 must declare parameter `country` for the target check.
    queries[0] = panelQuery('p1', {}, undefined);
    queries[0].sql = 'SELECT * WHERE c = {country:String}';
    expect(validateDashboardSemantics(dashboard, { queries })).toEqual([]);
  });

  it('skips malformed query entries while constructing the lookup', () => {
    expect(validateDashboardSemantics(dashboardDoc(), { queries: [null, 'bad', panelQuery('p1')] })).toEqual([]);
  });

  it('returns nothing for a non-object dashboard and fails closed on a bad documentVersion', () => {
    expect(validateDashboardSemantics(null)).toEqual([]);
    const diagnostics = validateDashboardSemantics(dashboardDoc({ documentVersion: 2 }));
    expect(codes(diagnostics)).toEqual(['dashboard-version-unsupported']);
    expect(diagnostics[0].resource).toBe('d1');
  });

  it('enforces tile-count limit, duplicate tile ids, missing queries, and role compatibility', () => {
    const many = dashboardDoc({ tiles: Array.from({ length: PORTABLE_LIMITS.maxTilesPerDashboard + 1 }, (_, i) => tile(`t${i}`, 'p1')) });
    expect(has(validateDashboardSemantics(many, { queries: [panelQuery('p1')] }), 'limit-tile-count')).toBe(true);

    const dup = dashboardDoc({ tiles: [tile('t', 'p1'), tile('t', 'p1')], layout: flowLayout({ t: {} }) });
    expect(has(validateDashboardSemantics(dup, { queries: [panelQuery('p1')] }), 'dashboard-duplicate-tile-id')).toBe(true);

    const missing = dashboardDoc({ tiles: [tile('t1', 'gone')], layout: flowLayout({ t1: {} }) });
    expect(has(validateDashboardSemantics(missing), 'dashboard-tile-query-missing')).toBe(true);

    const setupQ = panelQuery('s1', {}, { role: 'setup' });
    const setupTile = dashboardDoc({ tiles: [tile('t1', 's1')], layout: flowLayout({ t1: {} }) });
    expect(has(validateDashboardSemantics(setupTile, { queries: [setupQ] }), 'dashboard-setup-reference')).toBe(true);

    const filterAsTile = dashboardDoc({ tiles: [tile('t1', 'f1')], layout: flowLayout({ t1: {} }) });
    expect(has(validateDashboardSemantics(filterAsTile, { queries: [filterQuery('f1')] }), 'dashboard-tile-role-incompatible')).toBe(true);
  });

  it('skips non-object tiles and tiles without a queryId', () => {
    const dashboard = dashboardDoc({ tiles: ['x', { id: 't1' }], layout: flowLayout() });
    // No query resolution runs; a tile without queryId still counts for its id.
    expect(validateDashboardSemantics(dashboard)).toEqual([]);
  });

  it('validates selected variant existence and tile override renderer-type changes', () => {
    const q = panelQuery('p1', {}, { variants: { v: {} } });
    const good = dashboardDoc({ tiles: [tile('t1', 'p1', { presentation: { variant: 'v' } })], layout: flowLayout({ t1: {} }) });
    expect(validateDashboardSemantics(good, { queries: [q] })).toEqual([]);
    const bad = dashboardDoc({ tiles: [tile('t1', 'p1', { presentation: { variant: 'nope' } })], layout: flowLayout({ t1: {} }) });
    expect(has(validateDashboardSemantics(bad, { queries: [q] }), 'dashboard-variant-missing')).toBe(true);
    const noVariants = dashboardDoc({ tiles: [tile('t1', 'p1', { presentation: { variant: 'nope' } })], layout: flowLayout({ t1: {} }) });
    expect(has(validateDashboardSemantics(noVariants, { queries: [panelQuery('p1')] }), 'dashboard-variant-missing')).toBe(true);
    const override = dashboardDoc({ tiles: [tile('t1', 'p1', { presentation: { override: { cfg: { type: 'pie' } } } })], layout: flowLayout({ t1: {} }) });
    expect(has(validateDashboardSemantics(override, { queries: [panelQuery('p1')] }), 'presentation-renderer-type-change')).toBe(true);
    // An empty presentation object and an override without a cfg.type are fine.
    const neutral = dashboardDoc({ tiles: [tile('t1', 'p1', { presentation: {} })], layout: flowLayout({ t1: {} }) });
    expect(validateDashboardSemantics(neutral, { queries: [panelQuery('p1')] })).toEqual([]);
  });

  it('enforces layout item limits, orphan placements, and flow@1 schema validity', () => {
    const orphan = dashboardDoc({ tiles: [tile('t1', 'p1')], layout: flowLayout({ ghost: {} }) });
    const d = validateDashboardSemantics(orphan, { queries: [panelQuery('p1')] });
    expect(has(d, 'layout-orphan-placement')).toBe(true);
    expect(has(d, 'layout-items-exceed-tiles')).toBe(false); // 1 item, 1 tile

    const exceed = dashboardDoc({ tiles: [], layout: flowLayout({ a: {}, b: {} }) });
    expect(has(validateDashboardSemantics(exceed), 'layout-items-exceed-tiles')).toBe(true);

    // Invalid flow layout: unknown placement field fails the closed placement schema.
    const badPlacement = dashboardDoc({ tiles: [tile('t1', 'p1')], layout: flowLayout({ t1: { span: 1, bogus: true } }) });
    expect(has(validateDashboardSemantics(badPlacement, { queries: [panelQuery('p1')] }), 'schema-unknown-property')).toBe(true);
  });

  it('requires a valid flow@1 fallback for an unsupported layout', () => {
    const noFallback = dashboardDoc({ tiles: [tile('t1', 'p1')], layout: { type: 'grid', version: 1, items: {} } });
    expect(has(validateDashboardSemantics(noFallback, { queries: [panelQuery('p1')] }), 'layout-unsupported-without-fallback')).toBe(true);

    const nullFallback = dashboardDoc({ tiles: [tile('t1', 'p1')], layout: { type: 'grid', version: 1, items: {}, fallback: null } });
    expect(has(validateDashboardSemantics(nullFallback, { queries: [panelQuery('p1')] }), 'layout-unsupported-without-fallback')).toBe(true);

    const goodFallback = dashboardDoc({
      tiles: [tile('t1', 'p1')],
      layout: { type: 'grid', version: 9, items: {}, fallback: flowLayout({ t1: { span: 2 } }) },
    });
    expect(validateDashboardSemantics(goodFallback, { queries: [panelQuery('p1')] })).toEqual([]);

    const badFallback = dashboardDoc({
      tiles: [tile('t1', 'p1')],
      layout: { type: 'grid', version: 9, items: {}, fallback: { type: 'flow', version: 1, preset: 'nope', items: {} } },
    });
    expect(has(validateDashboardSemantics(badFallback, { queries: [panelQuery('p1')] }), 'schema-invalid-enum')).toBe(true);

    const orphanFallback = dashboardDoc({
      tiles: [tile('t1', 'p1')],
      layout: { type: 'grid', version: 9, items: {}, fallback: flowLayout({ ghost: {} }) },
    });
    expect(has(validateDashboardSemantics(orphanFallback, { queries: [panelQuery('p1')] }), 'layout-orphan-placement')).toBe(true);
  });

  it('validates a grafana-grid@1 primary against its own schema AND still requires a flow@1 fallback (#291)', () => {
    const clean = dashboardDoc({
      tiles: [tile('t1', 'p1')],
      layout: gridLayout({ t1: { span: 6, height: 'medium' } }),
    });
    // A known-but-non-flow primary always needs its own fallback, even when
    // its own items are perfectly valid.
    expect(has(validateDashboardSemantics(clean, { queries: [panelQuery('p1')] }), 'layout-unsupported-without-fallback')).toBe(true);

    const withFallback = dashboardDoc({
      tiles: [tile('t1', 'p1')],
      layout: { ...gridLayout({ t1: { span: 6, height: 'medium' } }), fallback: flowLayout({ t1: { span: 2 } }) },
    });
    expect(validateDashboardSemantics(withFallback, { queries: [panelQuery('p1')] })).toEqual([]);

    // Invalid grid placement (span out of 1..12 range) is validated against
    // grafana-grid's OWN schema, not the flow schema.
    const badGridItems = dashboardDoc({
      tiles: [tile('t1', 'p1')],
      layout: { ...gridLayout({ t1: { span: 13 } }), fallback: flowLayout({ t1: { span: 2 } }) },
    });
    expect(has(validateDashboardSemantics(badGridItems, { queries: [panelQuery('p1')] }), 'schema-number-range')).toBe(true);

    // A bad flow fallback is still reported even when the grid primary itself is fine.
    const badFallback = dashboardDoc({
      tiles: [tile('t1', 'p1')],
      layout: { ...gridLayout({ t1: { span: 6 } }), fallback: { type: 'flow', version: 1, preset: 'nope', items: {} } },
    });
    expect(has(validateDashboardSemantics(badFallback, { queries: [panelQuery('p1')] }), 'schema-invalid-enum')).toBe(true);

    // The grid primary's own schema errors omit `resource` too when the
    // dashboard itself has no id (mirrors the flow/fallback schema-error path).
    const badGridNoId = {
      documentVersion: 1, title: 'T', revision: 1, filters: [],
      tiles: [tile('t1', 'p1')],
      layout: { ...gridLayout({ t1: { span: 13 } }), fallback: flowLayout({ t1: { span: 2 } }) },
    };
    const noIdDiagnostics = validateDashboardSemantics(badGridNoId, { queries: [panelQuery('p1')] });
    expect(noIdDiagnostics.some((d) => d.code === 'schema-number-range' && d.resource === undefined)).toBe(true);
  });

  it('enforces the layout item-count limit independently of the tile count', () => {
    const items: Record<string, unknown> = {};
    const tiles = [];
    for (let i = 0; i <= PORTABLE_LIMITS.maxLayoutItemsPerDashboard; i++) { items[`t${i}`] = {}; tiles.push(tile(`t${i}`, 'p1')); }
    const d = validateDashboardSemantics(dashboardDoc({ tiles, layout: flowLayout(items) }), { queries: [panelQuery('p1')] });
    expect(has(d, 'limit-layout-item-count')).toBe(true);
    expect(has(d, 'layout-items-exceed-tiles')).toBe(false); // items == tiles
  });

  it('enforces the serialized layout-config byte limit', () => {
    const layout = { type: 'flow', version: 1, preset: 'report', items: {}, config: { blob: 'x'.repeat(PORTABLE_LIMITS.maxSerializedLayoutConfigBytes + 10) } };
    expect(has(validateDashboardSemantics(dashboardDoc({ layout })), 'limit-layout-config-bytes')).toBe(true);
  });

  it('skips layout item checks when items is not an object', () => {
    const layout = { type: 'flow', version: 1, preset: 'report' };
    // Missing `items` is a schema error, but checkItems must not throw.
    expect(has(validateDashboardSemantics(dashboardDoc({ layout })), 'schema-required')).toBe(true);
  });

  it('validates filter identity, source role/uniqueness, and target/parameter resolution', () => {
    const queries = [panelQuery('p1'), filterQuery('f1'), filterQuery('f2')];
    queries[0].sql = 'SELECT {country:String}';

    const dupFilter = dashboardDoc({
      tiles: [tile('t1', 'p1')], layout: flowLayout({ t1: {} }),
      filters: [{ id: 'x', parameter: 'country' }, { id: 'x', parameter: 'country' }],
    });
    expect(has(validateDashboardSemantics(dupFilter, { queries }), 'dashboard-duplicate-filter-id')).toBe(true);

    const missingSource = dashboardDoc({ filters: [{ id: 'flt', parameter: 'p', sourceQueryId: 'gone' }] });
    expect(has(validateDashboardSemantics(missingSource, { queries }), 'filter-source-missing')).toBe(true);

    const setupSource = dashboardDoc({ filters: [{ id: 'flt', parameter: 'p', sourceQueryId: 's1' }] });
    expect(has(validateDashboardSemantics(setupSource, { queries: [panelQuery('s1', {}, { role: 'setup' })] }), 'dashboard-setup-reference')).toBe(true);

    const panelSource = dashboardDoc({ filters: [{ id: 'flt', parameter: 'p', sourceQueryId: 'p1' }] });
    expect(has(validateDashboardSemantics(panelSource, { queries }), 'filter-source-role')).toBe(true);

    const sourceIsTile = dashboardDoc({
      tiles: [tile('t1', 'f1')], layout: flowLayout({ t1: {} }),
      filters: [{ id: 'flt', parameter: 'p', sourceQueryId: 'f1' }],
    });
    // f1 is filter-role so it is a role-incompatible tile AND a source-is-tile.
    expect(has(validateDashboardSemantics(sourceIsTile, { queries }), 'filter-source-is-tile')).toBe(true);
  });

  it('checks targets exist and declare the parameter, and detects type conflicts', () => {
    const qString = panelQuery('a'); qString.sql = 'SELECT {country:String}';
    const qInt = panelQuery('b'); qInt.sql = 'SELECT {country:UInt32}';
    const qNone = panelQuery('c'); qNone.sql = 'SELECT 1';
    const dashboard = dashboardDoc({
      tiles: [tile('ta', 'a'), tile('tb', 'b'), tile('tc', 'c')],
      layout: flowLayout({ ta: {}, tb: {}, tc: {} }),
      filters: [{ id: 'flt', parameter: 'country', targets: ['ta', 'tb', 'tc', 'missing'] }],
    });
    const d = validateDashboardSemantics(dashboard, { queries: [qString, qInt, qNone] });
    expect(has(d, 'filter-target-missing')).toBe(true);
    expect(has(d, 'filter-parameter-undeclared')).toBe(true); // tc's query
    expect(has(d, 'filter-parameter-type-conflict')).toBe(true); // String vs UInt32
  });

  // #189/#360 merge-gate follow-up: `validateDashboardSemantics` now runs the
  // SAME `resolveFilterSelection` the viewer session uses, for every
  // SOURCE-BACKED filter, translating its diagnostics to exact dashboard JSON
  // paths (mode-table → `selection.mode`, per-target → `targets[j]`,
  // contract/agreement → `parameter`).
  describe('source-backed filter selection-contract validation (#189/#360)', () => {
    it('selection.mode "multiple" against a scalar-only contract → diagnostic at filters[i].selection.mode', () => {
      const q = panelQuery('p1'); q.sql = 'SELECT {country:String}';
      const dashboard = dashboardDoc({
        tiles: [tile('t1', 'p1')], layout: flowLayout({ t1: {} }),
        filters: [{ id: 'flt', parameter: 'country', sourceQueryId: 'f1', selection: { mode: 'multiple' } }],
      });
      const d = validateDashboardSemantics(dashboard, { queries: [q, filterQuery('f1')] });
      const diag = d.find((x) => x.code === 'filter-selection-mode-requires-array');
      expect(diag).toBeDefined();
      expect(diag!.path).toEqual(['filters', 0, 'selection', 'mode']);
    });

    it('an explicit target not declaring the parameter → diagnostic at filters[i].targets[j]', () => {
      const q = panelQuery('p1'); // default sql 'SELECT 1' — declares nothing
      const dashboard = dashboardDoc({
        tiles: [tile('t1', 'p1')], layout: flowLayout({ t1: {} }),
        filters: [{ id: 'flt', parameter: 'country', sourceQueryId: 'f1', targets: ['t1'] }],
      });
      const d = validateDashboardSemantics(dashboard, { queries: [q, filterQuery('f1')] });
      const diag = d.find((x) => x.code === 'filter-selection-target-missing-declaration');
      expect(diag).toBeDefined();
      expect(diag!.path).toEqual(['filters', 0, 'targets', 0]);
      // The older unbound check is subsumed for a source-backed filter — no
      // duplicate `filter-parameter-undeclared` on top.
      expect(has(d, 'filter-parameter-undeclared')).toBe(false);
    });

    it('implicit targets (none declared) mixing scalar/Array across two tiles → diagnostic at filters[i].parameter', () => {
      const qScalar = panelQuery('a'); qScalar.sql = 'SELECT {country:String}';
      const qArray = panelQuery('b'); qArray.sql = 'SELECT {country:Array(String)}';
      const dashboard = dashboardDoc({
        tiles: [tile('t1', 'a'), tile('t2', 'b')], layout: flowLayout({ t1: {}, t2: {} }),
        filters: [{ id: 'flt', parameter: 'country', sourceQueryId: 'f1' }], // no targets
      });
      const d = validateDashboardSemantics(dashboard, { queries: [qScalar, qArray, filterQuery('f1')] });
      const diag = d.find((x) => x.code === 'filter-selection-mixed-arity');
      expect(diag).toBeDefined();
      expect(diag!.path).toEqual(['filters', 0, 'parameter']);
    });

    it('a nested Array(Array(...)) declaration → diagnostic at filters[i].parameter', () => {
      const q = panelQuery('p1'); q.sql = 'SELECT {country:Array(Array(String))}';
      const dashboard = dashboardDoc({
        tiles: [tile('t1', 'p1')], layout: flowLayout({ t1: {} }),
        filters: [{ id: 'flt', parameter: 'country', sourceQueryId: 'f1' }],
      });
      const d = validateDashboardSemantics(dashboard, { queries: [q, filterQuery('f1')] });
      const diag = d.find((x) => x.code === 'filter-selection-nested-array');
      expect(diag).toBeDefined();
      expect(diag!.path).toEqual(['filters', 0, 'parameter']);
    });

    it('a VALID Array(T) setup produces no selection diagnostics', () => {
      const q = panelQuery('p1'); q.sql = 'SELECT {tags:Array(String)}';
      const dashboard = dashboardDoc({
        tiles: [tile('t1', 'p1')], layout: flowLayout({ t1: {} }),
        filters: [{ id: 'flt', parameter: 'tags', sourceQueryId: 'f1', selection: { mode: 'multiple' } }],
      });
      const d = validateDashboardSemantics(dashboard, { queries: [q, filterQuery('f1')] });
      expect(d.filter((x) => x.code.startsWith('filter-selection-'))).toEqual([]);
    });

    it('a Filter source declaring the SAME parameter (even conflicting) does NOT poison an otherwise-valid contract', () => {
      const q = panelQuery('p1'); q.sql = 'SELECT {shared:String}';
      // f1's own SQL declares {shared:UInt64} — a conflicting type — but f1 is
      // a Filter SOURCE, never a tile, so it is excluded from the tile-side
      // ParameterAnalysis entirely and cannot influence the contract.
      const sourceQuery = filterQuery('f1', 'SELECT {shared:UInt64} AS x');
      const dashboard = dashboardDoc({
        tiles: [tile('t1', 'p1')], layout: flowLayout({ t1: {} }),
        filters: [{ id: 'flt', parameter: 'shared', sourceQueryId: 'f1' }],
      });
      const d = validateDashboardSemantics(dashboard, { queries: [q, sourceQuery] });
      expect(d.filter((x) => x.code.startsWith('filter-selection-'))).toEqual([]);
    });
  });

  it('skips target parameter checks when parameter is absent and tolerates unknown target queries', () => {
    const dashboard = dashboardDoc({
      tiles: [tile('t1', 'gone')], layout: flowLayout({ t1: {} }),
      filters: [{ id: 'flt', targets: ['t1'] }],
    });
    // parameter absent → no undeclared/type check; queryId resolves to a missing
    // query (already reported at the tile), so the target loop `continue`s.
    const d = validateDashboardSemantics(dashboard);
    expect(has(d, 'filter-parameter-undeclared')).toBe(false);
    expect(has(d, 'dashboard-tile-query-missing')).toBe(true);
  });

  it('does not duplicate a missing-query diagnostic during plain-filter declaration checks', () => {
    const dashboard = dashboardDoc({
      tiles: [tile('t1', 'gone')], layout: flowLayout({ t1: {} }),
      filters: [{ id: 'flt', parameter: 'country', targets: ['t1'] }],
    });
    const d = validateDashboardSemantics(dashboard);
    expect(d.filter((x) => x.code === 'dashboard-tile-query-missing')).toHaveLength(1);
    expect(has(d, 'filter-parameter-undeclared')).toBe(false);
  });

  it('enforces filter-count and serialized filter-default byte limits', () => {
    const many = dashboardDoc({ filters: Array.from({ length: PORTABLE_LIMITS.maxFiltersPerDashboard + 1 }, (_, i) => ({ id: `f${i}`, parameter: 'p' })) });
    expect(has(validateDashboardSemantics(many), 'limit-filter-count')).toBe(true);
    const bigDefault = dashboardDoc({ filters: [{ id: 'f', parameter: 'p', defaultValue: 'x'.repeat(PORTABLE_LIMITS.maxSerializedFilterDefaultBytes + 10) }] });
    expect(has(validateDashboardSemantics(bigDefault), 'limit-filter-default-bytes')).toBe(true);
  });

  it('skips non-object filters and non-object dashboards without a layout', () => {
    const noLayout = { documentVersion: 1, id: 'd', title: 'T', revision: 1, filters: ['x'], tiles: [] };
    expect(validateDashboardSemantics(noLayout)).toEqual([]);
  });

  it('omits the resource id when the dashboard has no id (schema errors mapped too)', () => {
    const badPlacement = { documentVersion: 1, title: 'T', revision: 1, tiles: [tile('t1', 'p1')], filters: [], layout: flowLayout({ t1: { bogus: true } }) };
    const d = validateDashboardSemantics(badPlacement, { queries: [panelQuery('p1')] });
    expect(d.some((x) => x.code === 'schema-unknown-property' && x.resource === undefined)).toBe(true);
  });
});

describe('validateDashboardCollectionSemantics', () => {
  it('flags duplicate dashboard ids and the dashboard-count limit', () => {
    const one = dashboardDoc({ id: 'dup', tiles: [], layout: flowLayout() });
    const two = dashboardDoc({ id: 'dup', tiles: [], layout: flowLayout() });
    expect(has(validateDashboardCollectionSemantics([one, two]), 'workspace-duplicate-dashboard-id')).toBe(true);

    const many = Array.from({ length: PORTABLE_LIMITS.maxDashboards + 1 }, (_, i) => dashboardDoc({ id: `d${i}` }));
    expect(has(validateDashboardCollectionSemantics(many), 'limit-dashboard-count')).toBe(true);
  });

  it('tolerates non-object and id-less dashboards', () => {
    expect(validateDashboardCollectionSemantics(['x', dashboardDoc({ id: undefined })])).toEqual([]);
  });
});
