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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function decodeExample(text, name) {
  const result = decodePortableBundleJson(text);
  expect(result.ok, result.ok ? name : name + ': ' + result.diagnostics.map((d) => d.message).join('; ')).toBe(true);
  if (!result.ok) throw new Error(name);
  return result.value;
}

describe('schema artifacts and examples', () => {
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
