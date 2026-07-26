import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidExampleBundle } from '../../examples/mjs/example-bundle.mjs';
import { decodePortableBundleJson } from '../../src/dashboard/model/portable-bundle-codec.js';
import { querySpecSchemaService } from '../../src/core/spec-schema.js';
import { migrateStoredWorkspaceV3ToV5 } from '../../src/workspace/stored-workspace-ownership.js';
import { validateStoredWorkspaceDocument } from '../../src/workspace/stored-workspace.js';
import { buildQueryOwnershipIndex } from '../../src/dashboard/model/query-ownership.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function decodeExample(text, name) {
  const result = decodePortableBundleJson(text);
  expect(result.ok, result.ok ? name : name + ': ' + result.diagnostics.map((d) => d.message).join('; ')).toBe(true);
  if (!result.ok) throw new Error(name);
  return result.value;
}

describe('schema artifacts and examples', () => {
  // #427/#447 — the shipped bundles ARE the migration's acceptance test. Each
  // becomes a V3 workspace, is migrated straight to V5 (#447 dropped the V4
  // curated-filter-owned intermediate — see stored-workspace-ownership.js),
  // and must come out with no diagnostics at all, with every original query
  // still present as a Library entry.
  it('migrates every shipped example bundle to a valid V5 workspace', () => {
    const examples = resolve(root, 'examples');
    const names = readdirSync(examples).filter((item) => item.endsWith('.json')).sort();
    for (const name of names) {
      const bundle = decodeExample(readFileSync(resolve(examples, name), 'utf8'), name);
      const migrated = migrateStoredWorkspaceV3ToV5({
        storageVersion: 3, id: 'w', key: 'w', name: 'W',
        queries: bundle.queries, dashboards: bundle.dashboards,
      });
      expect(validateStoredWorkspaceDocument(migrated), name).toEqual([]);
      const index = buildQueryOwnershipIndex(migrated);
      // Every original survives as a Library query…
      for (const query of bundle.queries) {
        expect(index.libraryQueryIds.has(query.id), name + ': ' + query.id).toBe(true);
      }
    }
  });

  it('keeps generated schema artifacts deterministic and current', () => {
    expect(() => execFileSync(process.execPath, ['build/compile-json-schemas.mjs', '--check'], {
      cwd: root, stdio: 'pipe',
    })).not.toThrow();
  });

  // Checked against the RAW committed JSON, not the `decodeExample` result:
  // `decodePortableBundleJson` now migrates a v1 bundle straight to v2 on
  // decode (#447 dropped every Dashboard's curated `filters` in that
  // migration), so the decoded value no longer carries `version: 1` /
  // `documentVersion: 1` / `filters` to assert against. Decode SUCCESS for
  // every example is already covered by the "migrates every shipped example
  // bundle" test above; this test is specifically about the shape the files
  // are still committed in.
  it('keeps every checked-in JSON example on portable bundle v1 with explicit Dashboard v1 documents', () => {
    const examples = resolve(root, 'examples');
    const names = readdirSync(examples).filter((item) => item.endsWith('.json')).sort();
    expect(names.filter((name) => !name.startsWith('iceberg'))).toEqual([
      'clickhouse-operations.json', 'ontime-charts.json', 'shop-charts.json',
    ]);
    for (const name of names) {
      const text = readFileSync(resolve(examples, name), 'utf8');
      const raw = JSON.parse(text);
      expect(raw.format, name).toBe('altinity-sql-browser/portable-bundle');
      expect(raw.version, name).toBe(1);
      expect(raw.queries.length, name).toBeGreaterThan(0);
      expect(() => assertValidExampleBundle(raw), name).not.toThrow();
      for (const dashboard of raw.dashboards) {
        expect(dashboard.documentVersion, name).toBe(1);
        expect(['flow', 'grafana-grid'], name).toContain(dashboard.layout.type);
        expect(dashboard.tiles.length, name).toBeGreaterThan(0);
        const tileIds = new Set(dashboard.tiles.map((tile) => tile.id));
        const queryIds = new Set(raw.queries.map((query) => query.id));
        for (const tile of dashboard.tiles) expect(queryIds.has(tile.queryId), `${name}:${tile.id}`).toBe(true);
        for (const filter of dashboard.filters) {
          // `sourceQueryId` is deliberately NOT checked against `queryIds`: the
          // removed Filter role (#447) is what made that id meaningful, and
          // decode drops the whole `filters` array on migration regardless, so
          // a stale reference here is inert legacy data, not a defect.
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
