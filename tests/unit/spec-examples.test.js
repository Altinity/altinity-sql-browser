import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidExampleBundle } from '../../examples/mjs/example-bundle.mjs';
import { decodePortableBundleJson } from '../../src/dashboard/model/portable-bundle-codec.js';
import { querySpecSchemaService } from '../../src/core/spec-schema.js';
import { filterExecution } from '../../src/core/filter-execution.js';
import { effectiveDashboardRole } from '../../src/core/result-choice.js';
import { analyzeParameterizedSources } from '../../src/core/param-pipeline.js';
import { migrateStoredWorkspaceV3ToV4 } from '../../src/workspace/stored-workspace-ownership.js';
import { validateStoredWorkspaceDocument } from '../../src/workspace/stored-workspace.js';
import { buildQueryOwnershipIndex } from '../../src/dashboard/model/query-ownership.js';
import { mergeDashboardFilterHelpers } from '../../src/core/dashboard-filters.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function decodeExample(text, name) {
  const result = decodePortableBundleJson(text);
  expect(result.ok, result.ok ? name : name + ': ' + result.diagnostics.map((d) => d.message).join('; ')).toBe(true);
  if (!result.ok) throw new Error(name);
  return result.value;
}

describe('schema artifacts and examples', () => {
  // #427 — the shipped bundles ARE the migration's acceptance test. Each becomes a
  // V3 workspace, is migrated, and must come out with no diagnostics at all.
  //
  // `clickhouse-operations.json` is the case that matters: one filter-role query
  // ("Grafana port filters") supplies SIX option columns and SIX curated filters
  // reference it. Cloning it per filter produced six identical sources, so every
  // helper column had six providers and `mergeDashboardFilterHelpers` rejected all
  // of them (`filter-duplicate-provider`) — every filter on the dashboard errored,
  // and the query ran six times per load. One copy per DASHBOARD is why it works.
  it('migrates every shipped example bundle to a valid V4 workspace', () => {
    const examples = resolve(root, 'examples');
    const names = readdirSync(examples).filter((item) => item.endsWith('.json')).sort();
    for (const name of names) {
      const bundle = decodeExample(readFileSync(resolve(examples, name), 'utf8'), name);
      const migrated = migrateStoredWorkspaceV3ToV4({
        storageVersion: 3, id: 'w', key: 'w', name: 'W',
        queries: bundle.queries, dashboards: bundle.dashboards,
      });
      expect(validateStoredWorkspaceDocument(migrated), name).toEqual([]);
      const index = buildQueryOwnershipIndex(migrated);
      // Every original survives as a Library query…
      for (const query of bundle.queries) {
        expect(index.libraryQueryIds.has(query.id), name + ': ' + query.id).toBe(true);
      }
      // …and no curated filter shares a copy across Dashboards.
      for (const dashboard of migrated.dashboards) {
        for (const filter of dashboard.filters) {
          if (!filter.sourceQueryId) continue;
          const owners = index.ownersByQueryId.get(filter.sourceQueryId);
          expect(owners.every((owner) => owner.dashboardId === dashboard.id), name).toBe(true);
        }
      }
    }
  });

  it('gives clickhouse-operations ONE filter-source copy, with no duplicate providers', () => {
    const bundle = decodeExample(
      readFileSync(resolve(root, 'examples/clickhouse-operations.json'), 'utf8'), 'operations',
    );
    const migrated = migrateStoredWorkspaceV3ToV4({
      storageVersion: 3, id: 'w', key: 'w', name: 'W',
      queries: bundle.queries, dashboards: bundle.dashboards,
    });
    const [dashboard] = migrated.dashboards;
    const sources = dashboard.filters.map((filter) => filter.sourceQueryId).filter(Boolean);
    expect(sources.length).toBe(6);
    expect(new Set(sources).size).toBe(1);
    // The runtime consequence: ONE provider for that source, so each of its helper
    // columns has exactly one provider and the merge reports no duplicate.
    const source = migrated.queries.find((query) => query.id === sources[0]);
    const helpers = ['user', 'query_kind', 'exception_code', 'query_hash', 'metric', 'is_initial_query']
      .map((columnName) => ({ name: columnName, options: [{ value: 'x', label: 'x' }] }));
    const merged = mergeDashboardFilterHelpers({
      providers: [{ sourceId: source.id, sourceName: 'Grafana port filters', helpers }],
      controls: helpers.map((helper) => ({ name: helper.name, type: 'String', optional: false })),
    });
    expect(merged.diagnostics.filter((d) => d.code === 'filter-duplicate-provider')).toEqual([]);
    expect(Object.keys(merged.fields).sort()).toEqual(
      ['exception_code', 'is_initial_query', 'metric', 'query_hash', 'query_kind', 'user'],
    );
  });

  it('keeps generated schema artifacts deterministic and current', () => {
    expect(() => execFileSync(process.execPath, ['build/compile-json-schemas.mjs', '--check'], {
      cwd: root, stdio: 'pipe',
    })).not.toThrow();
  });

  it('keeps every checked-in JSON example on portable bundle v1 with explicit Dashboard v1 documents', () => {
    const examples = resolve(root, 'examples');
    const names = readdirSync(examples).filter((item) => item.endsWith('.json')).sort();
    expect(names.filter((name) => !name.startsWith('iceberg'))).toEqual([
      'clickhouse-operations.json', 'ontime-charts.json', 'shop-charts.json',
    ]);
    for (const name of names) {
      const text = readFileSync(resolve(examples, name), 'utf8');
      const bundle = decodeExample(text, name);
      expect(bundle.format, name).toBe('altinity-sql-browser/portable-bundle');
      expect(bundle.version, name).toBe(1);
      expect(bundle.queries.length, name).toBeGreaterThan(0);
      expect(() => assertValidExampleBundle(bundle), name).not.toThrow();
      for (const dashboard of bundle.dashboards) {
        expect(dashboard.documentVersion, name).toBe(1);
        expect(['flow', 'grafana-grid'], name).toContain(dashboard.layout.type);
        expect(dashboard.tiles.length, name).toBeGreaterThan(0);
        const tileIds = new Set(dashboard.tiles.map((tile) => tile.id));
        const queryIds = new Set(bundle.queries.map((query) => query.id));
        for (const tile of dashboard.tiles) expect(queryIds.has(tile.queryId), `${name}:${tile.id}`).toBe(true);
        for (const filter of dashboard.filters) {
          if (filter.sourceQueryId) expect(queryIds.has(filter.sourceQueryId), `${name}:${filter.id}`).toBe(true);
          for (const target of filter.targets || []) expect(tileIds.has(target), `${name}:${filter.id}`).toBe(true);
        }
        if (dashboard.layout.type === 'grafana-grid') {
          expect(dashboard.layout.fallback?.type, name).toBe('flow');
          expect(dashboard.layout.fallback?.version, name).toBe(1);
          expect(Object.keys(dashboard.layout.items).sort(), name).toEqual([...tileIds].sort());
          expect(Object.keys(dashboard.layout.fallback.items).sort(), name).toEqual([...tileIds].sort());
        }
      }
    }
    expect(() => execFileSync(process.execPath, ['examples/mjs/normalize-examples.mjs', '--check'], {
      cwd: root, stdio: 'pipe',
    })).not.toThrow();
  });

  it('keeps every flagship dimensional filter on one inferred multiselect Array(T) contract', () => {
    const expected = {
      'ontime-charts.json': { carrier: 'Array(String)', origin: 'Array(String)' },
      'shop-charts.json': { country: 'Array(String)', category: 'Array(String)' },
      'clickhouse-operations.json': {
        user: 'Array(String)', query_kind: 'Array(String)',
        exception_code: 'Array(Int32)', query_hash: 'Array(UInt64)',
      },
    };
    for (const [name, contracts] of Object.entries(expected)) {
      const bundle = decodeExample(readFileSync(resolve(root, 'examples', name), 'utf8'), name);
      const dashboard = bundle.dashboards[0];
      const queryById = new Map(bundle.queries.map((query) => [query.id, query]));
      for (const [parameter, type] of Object.entries(contracts)) {
        const filter = dashboard.filters.find((item) => item.parameter === parameter);
        expect(filter?.sourceQueryId, `${name}:${parameter}`).toBeTruthy();
        expect(filter?.selection, `${name}:${parameter}`).toBeUndefined();
        const targetIds = filter.targets || dashboard.tiles.map((tile) => tile.id);
        const sources = targetIds.map((tileId) => {
          const tile = dashboard.tiles.find((item) => item.id === tileId);
          const query = tile && queryById.get(tile.queryId);
          return query ? { id: tileId, sql: query.sql, bindPolicy: 'row-returning' } : null;
        }).filter(Boolean);
        const analysis = analyzeParameterizedSources(sources);
        const declarations = analysis.fields[parameter]?.declarations.filter((item) => item.bound) || [];
        expect(declarations.length, `${name}:${parameter}`).toBeGreaterThan(0);
        expect([...new Set(declarations.map((item) => item.type))], `${name}:${parameter}`).toEqual([type]);
      }
    }
  });

  it('keeps authored analytical chart encodings pinned to result schema keys', () => {
    for (const name of ['ontime-charts.json', 'shop-charts.json']) {
      const bundle = decodeExample(readFileSync(resolve(root, 'examples', name), 'utf8'), name);
      const visible = new Set(bundle.dashboards[0].tiles.map((tile) => tile.queryId));
      for (const query of bundle.queries) {
        if (!visible.has(query.id) || query.spec.panel?.cfg?.type === 'kpi') continue;
        expect(query.spec.panel?.key, `${name}:${query.id}`).toMatch(/^[^:]+:.+/);
      }
    }
  });

  it('validates the generated Iceberg drilldown portable-bundle template', () => {
    const template = readFileSync(resolve(root, 'examples/iceberg-templates/ice_meta_drilldown.json.tmpl'), 'utf8')
      .replaceAll('__CATALOG__', 'demo');
    const bundle = decodeExample(template, 'ice_meta_drilldown.json.tmpl');
    expect(bundle.dashboards).toHaveLength(1);
    expect(bundle.dashboards[0].tiles.length).toBeGreaterThan(0);
  });

  it('every Filter-role example query is a valid Filter source', () => {
    const examples = resolve(root, 'examples');
    for (const name of readdirSync(examples).filter((item) => item.endsWith('.json'))) {
      const bundle = decodeExample(readFileSync(resolve(examples, name), 'utf8'), name);
      for (const query of bundle.queries) {
        if (effectiveDashboardRole(query.spec) !== 'filter') continue;
        expect(filterExecution(query.sql).diagnostics, name + ':' + query.id).toEqual([]);
      }
    }
  });

  it('validates every JSON Spec example used by the authoring documentation', () => {
    for (const name of ['saved-query-spec-json-schema.md', 'visualization-spec-authoring-guide.md']) {
      const source = readFileSync(resolve(root, 'docs/drafts', name), 'utf8');
      const snippets = [...source.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]));
      expect(snippets.length, name).toBeGreaterThan(0);
      for (const spec of snippets) expect(querySpecSchemaService.validate(spec), name).toEqual([]);
    }
  });

  it('makes example validation fail before an invalid document can be written', () => {
    const valid = {
      $schema: 'https://altinity.com/schemas/altinity-sql-browser/portable-bundle-v1.schema.json',
      format: 'altinity-sql-browser/portable-bundle', version: 1,
      exportedAt: '2026-07-14T00:00:00.000Z', dashboards: [],
      queries: [{ id: 'q', sql: 'SELECT 1', specVersion: 1, spec: { panel: { cfg: { type: 'table' } } } }],
    };
    expect(assertValidExampleBundle(valid).queries).toHaveLength(1);
    valid.queries[0].spec.panel = {};
    expect(() => assertValidExampleBundle(valid)).toThrow('panel requires cfg.type');
  });
});
