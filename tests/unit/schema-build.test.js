import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  assertDraftIdentities, generatedSources, loadRecords,
} from '../../build/compile-json-schemas.mjs';
import { ANNOTATION_KEYWORDS, SCHEMA_MANIFEST } from '../../build/schema-manifest.mjs';
import { buildSchemaTypes } from '../../build/emit-schema-types.mjs';

const root = resolve(process.cwd());

describe('multi-schema build', () => {
  it('uses only the explicit canonical manifest and derives catalog headers', async () => {
    expect(SCHEMA_MANIFEST.map((entry) => entry.path)).toEqual([
      'schemas/query-spec-v1.schema.json',
      'schemas/saved-query-v2.schema.json',
      'schemas/library-v2.schema.json',
      'schemas/dashboard-layout-flow-v1.schema.json',
      'schemas/dashboard-layout-grafana-grid-v1.schema.json',
      'schemas/dashboard-v1.schema.json',
      'schemas/stored-workspace-v1.schema.json',
      'schemas/portable-bundle-v1.schema.json',
    ]);
    const KINDS = [
      ['query-spec', 1], ['saved-query', 2], ['library', 2],
      ['dashboard-layout-flow', 1], ['dashboard-layout-grafana-grid', 1],
      ['dashboard', 1], ['stored-workspace', 1], ['portable-bundle', 1],
    ];
    const records = await loadRecords();
    expect(records.map(({ schema }) => [schema['x-altinity-kind'], schema['x-altinity-version']]))
      .toEqual(KINDS);
    const catalog = JSON.parse(readFileSync(resolve(root, 'schemas/generated/schema-catalog.json'), 'utf8'));
    expect(catalog.schemas.map(({ kind, version }) => [kind, version])).toEqual(KINDS);
    expect(catalog.schemas[2].bundlePath).toBe('library-v2.bundle.schema.json');
  });

  it('keeps the offline bundle self-contained and usable without network resolution', () => {
    const bundle = JSON.parse(readFileSync(resolve(root, 'schemas/generated/library-v2.bundle.schema.json'), 'utf8'));
    expect(bundle.$ref).toBe('https://altinity.com/schemas/altinity-sql-browser/library-v2.schema.json');
    expect(Object.values(bundle.$defs).map((schema) => schema.$id)).toEqual([
      'https://altinity.com/schemas/altinity-sql-browser/query-spec-v1.schema.json',
      'https://altinity.com/schemas/altinity-sql-browser/saved-query-v2.schema.json',
      'https://altinity.com/schemas/altinity-sql-browser/library-v2.schema.json',
      'https://altinity.com/schemas/altinity-sql-browser/dashboard-layout-flow-v1.schema.json',
      'https://altinity.com/schemas/altinity-sql-browser/dashboard-layout-grafana-grid-v1.schema.json',
      'https://altinity.com/schemas/altinity-sql-browser/dashboard-v1.schema.json',
      'https://altinity.com/schemas/altinity-sql-browser/stored-workspace-v1.schema.json',
      'https://altinity.com/schemas/altinity-sql-browser/portable-bundle-v1.schema.json',
    ]);
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    for (const keyword of ANNOTATION_KEYWORDS) ajv.addKeyword({ keyword, schemaType: ['string', 'number', 'object', 'array', 'boolean'] });
    const validate = ajv.compile(bundle);
    expect(validate({
      format: 'altinity-sql-browser/saved-queries', version: 2,
      exportedAt: '2026-07-14T00:00:00.000Z',
      queries: [{ id: 'q', sql: 'SELECT 1', specVersion: 1, spec: {} }],
    })).toBe(true);
  });

  it('generates deterministic artifacts and standalone code without Ajv runtime imports', async () => {
    const first = await generatedSources();
    const second = await generatedSources();
    expect(first).toEqual(second);
    expect(Object.keys(first)).toHaveLength(5);
    const validator = Object.entries(first).find(([path]) => path.endsWith('json-schema-validators.js'))[1];
    expect(validator).toContain('validateLibraryV2');
    expect(validator).not.toContain("from 'ajv");
    expect(validator).not.toContain('new Ajv');
    expect(validator).not.toContain('Ajv2020');
  });

  it('rejects duplicate canonical ids, missing headers, and unresolved refs', async () => {
    await expect(loadRecords({ ...SCHEMA_MANIFEST })).rejects.toThrow();
    await expect(loadRecords([SCHEMA_MANIFEST[0], { ...SCHEMA_MANIFEST[0], path: SCHEMA_MANIFEST[0].path }]))
      .rejects.toThrow('Duplicate schema $id');

    const dir = await mkdtemp(join(tmpdir(), 'asb-schema-'));
    const noHeader = join(dir, 'no-header.schema.json');
    await writeFile(noHeader, JSON.stringify({ $id: 'https://example.test/no-header', type: 'object' }));
    await expect(loadRecords([{ path: noHeader, schemaExport: 'x', validatorExport: 'validateX' }]))
      .rejects.toThrow('canonical kind/version header');

    const unresolved = join(dir, 'unresolved.schema.json');
    await writeFile(unresolved, JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.test/unresolved',
      'x-altinity-kind': 'test', 'x-altinity-version': 1,
      $ref: 'https://example.test/missing',
    }));
    await expect(generatedSources({ manifest: [{
      path: unresolved, schemaExport: 'unresolvedSchema', validatorExport: 'validateUnresolved', typeExport: 'Unresolved', bundle: true,
    }] })).rejects.toThrow();
  });

  it('emits the committed TypeScript artifact with pinned names, openness, and closedness', async () => {
    expect(SCHEMA_MANIFEST.map((entry) => entry.typeExport)).toEqual([
      'QuerySpecV1', 'SavedQueryV2', 'LibraryV2',
      'FlowLayoutV1', 'GrafanaGridLayoutV1', 'DashboardDocumentV1', 'StoredWorkspaceV1', 'PortableBundleV1',
    ]);
    const sources = await generatedSources();
    const types = Object.entries(sources).find(([path]) => path.endsWith('json-schema.types.ts'))[1];
    expect(types.startsWith('// Generated by build/compile-json-schemas.mjs. Do not edit.\n')).toBe(true);
    expect(types).toContain('export interface QuerySpecV1');
    expect(types).toContain('export interface SavedQueryV2');
    expect(types).toContain('export interface LibraryV2');
    expect(types).toContain('export type PanelCfg');
    expect(types).toContain('FuturePanelCfg');
    expect(types).toContain('string & {}');
    const block = (name) => types.match(new RegExp(`export interface ${name}[^{]*\\{[\\s\\S]*?\\n\\}`))[0];
    expect(block('LibraryV2')).not.toContain('[k: string]');
    expect(block('SavedQueryV2')).not.toContain('[k: string]');
    expect(block('QuerySpecV1')).toContain('[k: string]: unknown;');
    // The single saved-query oneOf branch merges into one closed interface.
    expect(block('SavedQueryV2')).toContain('specVersion: 1;');
    expect(block('SavedQueryV2')).toContain('spec: QuerySpecV1;');
    expect(block('LibraryV2')).toContain('queries: SavedQueryV2[];');
    // The composition-only styledChartCfg helper never becomes a public type.
    expect(types).not.toContain('StyledChartCfg');
    expect(types).toContain('export interface BarPanelCfg extends ChartCfg {');
    // Dashboard v1 contracts (#283): pinned roots, the fallback alias, and
    // the closed flow@1 placement.
    expect(types).toContain('export interface DashboardDocumentV1');
    expect(types).toContain('export interface StoredWorkspaceV1');
    expect(types).toContain('export interface PortableBundleV1');
    expect(types).toContain('export type DashboardLayoutFallbackV1 = FlowLayoutV1;');
    expect(types).toContain('export type QueryPresentationPatchV1 = Record<string, unknown>;');
    expect(types).toContain('export interface GrafanaGridLayoutV1');
    expect(block('FlowTilePlacementV1')).not.toContain('[k: string]');
    expect(block('GrafanaGridTilePlacementV1')).not.toContain('[k: string]');
    expect(block('DashboardDocumentV1')).not.toContain('[k: string]');
    expect(block('PortableBundleV1')).toContain('dashboards: DashboardDocumentV1[];');
    expect(block('StoredWorkspaceV1')).toContain('dashboard: DashboardDocumentV1 | null;');
    expect(block('QueryDashboardPresentationV1')).toContain('variants?: Record<string, QueryPresentationPatchV1>;');
  });

  it('validates manifest typeExport pins', async () => {
    await expect(loadRecords([{ ...SCHEMA_MANIFEST[0], typeExport: 'notPascal' }]))
      .rejects.toThrow('PascalCase typeExport');
    await expect(loadRecords([{ ...SCHEMA_MANIFEST[0], typeExport: undefined }]))
      .rejects.toThrow('PascalCase typeExport');
    await expect(loadRecords([SCHEMA_MANIFEST[0], { ...SCHEMA_MANIFEST[1], typeExport: 'QuerySpecV1' }]))
      .rejects.toThrow('Duplicate typeExport');
  });

  it('fails loudly on inconsistent discriminators, name collisions, and unknown shape keywords', async () => {
    const record = (schema) => ({
      typeExport: 'Test',
      relativePath: 'test.schema.json',
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: 'https://example.test/test',
        'x-altinity-kind': 'test',
        'x-altinity-version': 1,
        ...schema,
      },
    });
    const mismatchedDiscriminator = {
      type: 'object',
      required: ['type'],
      additionalProperties: true,
      properties: { type: { type: 'string' } },
      'x-altinity-discriminator': 'type',
      oneOf: [
        { properties: { type: { const: 'a' } }, required: ['type'], additionalProperties: true },
        { properties: { type: { type: 'string', not: { enum: ['a', 'b'] } } }, required: ['type'], additionalProperties: true },
      ],
    };
    expect(() => buildSchemaTypes([record(mismatchedDiscriminator)]))
      .toThrow('does not match sibling discriminator consts');
    expect(() => buildSchemaTypes([record({
      type: 'object',
      additionalProperties: true,
      properties: { test: { $ref: '#/$defs/test' } },
      $defs: { test: { type: 'string' } },
    })])).toThrow('Duplicate emitted type name');
    expect(() => buildSchemaTypes([record({
      type: 'object',
      additionalProperties: true,
      properties: { x: { type: 'object', patternProperties: { '^a': { type: 'string' } } } },
    })])).toThrow('Unhandled JSON-Schema keyword "patternProperties"');
    // `required` on a properties-less object has no Record<> representation —
    // the emitter must fail loud instead of silently dropping the constraint.
    expect(() => buildSchemaTypes([record({
      type: 'object',
      additionalProperties: true,
      properties: {
        x: { type: 'object', required: ['k'], additionalProperties: { type: 'string' } },
      },
    })])).toThrow('"required" on a properties-less object');

    // The same guard fires through the full pipeline on a temp-file schema.
    const dir = await mkdtemp(join(tmpdir(), 'asb-schema-'));
    const disc = join(dir, 'disc.schema.json');
    await writeFile(disc, JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.test/disc',
      'x-altinity-kind': 'disc',
      'x-altinity-version': 1,
      ...mismatchedDiscriminator,
    }));
    await expect(generatedSources({ manifest: [{
      path: disc, schemaExport: 'discSchema', validatorExport: 'validateDisc', typeExport: 'Disc', bundle: true,
    }] })).rejects.toThrow('does not match sibling discriminator consts');
  });

  it('keeps drafts out of production and rejects bad or duplicate draft identities', async () => {
    const records = await loadRecords();
    const draft = (id, name = 'draft') => ({ schema: { $id: id }, name });
    expect(() => assertDraftIdentities(records, [draft('https://example.test/drafts/one')])).not.toThrow();
    expect(() => assertDraftIdentities(records, [draft(QUERY_ID)])).toThrow('reuses canonical $id');
    expect(() => assertDraftIdentities(records, [draft('https://example.test/not-a-draft')]))
      .toThrow('must use a /drafts/ $id');
    expect(() => assertDraftIdentities(records, [
      draft('https://example.test/drafts/same', 'one'), draft('https://example.test/drafts/same', 'two'),
    ])).toThrow('Duplicate experimental schema $id');
    const sources = await generatedSources();
    expect(JSON.stringify(sources)).not.toContain('query-presentation-spec-next');
  });
});

const QUERY_ID = 'https://altinity.com/schemas/altinity-sql-browser/query-spec-v1.schema.json';
