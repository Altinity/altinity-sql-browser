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

const root = resolve(process.cwd());

describe('multi-schema build', () => {
  it('uses only the explicit canonical manifest and derives catalog headers', async () => {
    expect(SCHEMA_MANIFEST.map((entry) => entry.path)).toEqual([
      'schemas/query-spec-v1.schema.json',
      'schemas/saved-query-v2.schema.json',
      'schemas/library-v2.schema.json',
    ]);
    const records = await loadRecords();
    expect(records.map(({ schema }) => [schema['x-altinity-kind'], schema['x-altinity-version']]))
      .toEqual([['query-spec', 1], ['saved-query', 2], ['library', 2]]);
    const catalog = JSON.parse(readFileSync(resolve(root, 'schemas/generated/schema-catalog.json'), 'utf8'));
    expect(catalog.schemas.map(({ kind, version }) => [kind, version]))
      .toEqual([['query-spec', 1], ['saved-query', 2], ['library', 2]]);
    expect(catalog.schemas[2].bundlePath).toBe('library-v2.bundle.schema.json');
  });

  it('keeps the offline bundle self-contained and usable without network resolution', () => {
    const bundle = JSON.parse(readFileSync(resolve(root, 'schemas/generated/library-v2.bundle.schema.json'), 'utf8'));
    expect(bundle.$ref).toBe('https://altinity.com/schemas/altinity-sql-browser/library-v2.schema.json');
    expect(Object.values(bundle.$defs).map((schema) => schema.$id)).toEqual([
      'https://altinity.com/schemas/altinity-sql-browser/query-spec-v1.schema.json',
      'https://altinity.com/schemas/altinity-sql-browser/saved-query-v2.schema.json',
      'https://altinity.com/schemas/altinity-sql-browser/library-v2.schema.json',
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
    expect(Object.keys(first)).toHaveLength(4);
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
      path: unresolved, schemaExport: 'unresolvedSchema', validatorExport: 'validateUnresolved', bundle: true,
    }] })).rejects.toThrow();
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
