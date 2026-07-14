import { describe, expect, it } from 'vitest';
import {
  CURRENT_LIBRARY_VERSION, CURRENT_SPEC_VERSION, LIBRARY_FORMAT, LIBRARY_V2_SCHEMA_ID,
  MAX_LIBRARY_QUERIES, QUERY_SPEC_V1_SCHEMA_ID, SAVED_QUERY_V2_SCHEMA_ID,
  decodeLibraryDocument, decodeLibraryJson, decodeStoredSavedQueries, encodeLibraryDocument,
  encodeLibraryJson, getCurrentLibraryVersion, getCurrentSpecVersion, getSchema,
  jsonSchemaValidationService, migrateLibraryDocument, migrateSavedQuerySpec, parseJsonDocument,
  throwingValue, validateLibraryDocument, validateSavedQueryDocument,
} from '../../src/core/library-codec.js';

const query = (id = 'q', spec = {}) => ({ id, sql: 'SELECT 1', specVersion: 1, spec });
const library = (queries = [query()], over = {}) => ({
  format: LIBRARY_FORMAT, version: 2, exportedAt: '2026-07-14T00:00:00.000Z', queries, ...over,
});

describe('Library schema registry', () => {
  it('exposes independent current versions and canonical schemas', () => {
    expect(getCurrentLibraryVersion()).toBe(CURRENT_LIBRARY_VERSION);
    expect(getCurrentSpecVersion()).toBe(CURRENT_SPEC_VERSION);
    expect(getSchema('query-spec', 1).$id).toBe(QUERY_SPEC_V1_SCHEMA_ID);
    expect(getSchema('saved-query', 2).$id).toBe(SAVED_QUERY_V2_SCHEMA_ID);
    expect(getSchema('library', 2).$id).toBe(LIBRARY_V2_SCHEMA_ID);
    expect(getSchema('missing', 1)).toBeUndefined();
    expect(jsonSchemaValidationService.getSchema(LIBRARY_V2_SCHEMA_ID).$id).toBe(LIBRARY_V2_SCHEMA_ID);
  });
});

describe('parsing and complete validation', () => {
  it('parses JSON only and returns a stable syntax diagnostic', () => {
    expect(parseJsonDocument('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonDocument('{bad')).toEqual({
      ok: false,
      diagnostics: [{ path: [], severity: 'error', code: 'json-syntax', message: 'Not a valid JSON file' }],
    });
  });

  it('validates valid documents with and without compatibility exportedAt/schema hints', () => {
    expect(validateLibraryDocument(library())).toEqual([]);
    const compatible = library();
    delete compatible.exportedAt;
    expect(validateLibraryDocument(compatible)).toEqual([]);
    expect(validateLibraryDocument({ ...compatible, $schema: LIBRARY_V2_SCHEMA_ID })).toEqual([]);
    expect(validateSavedQueryDocument(query())).toEqual([]);
  });

  it('returns exact root-relative paths for envelope and nested Spec failures', () => {
    const cases = [
      [null, [], 'library-invalid-root'],
      [{ format: 'other' }, ['format'], 'library-invalid-format'],
      [{ format: LIBRARY_FORMAT }, ['version'], 'library-version-missing'],
      [{ format: LIBRARY_FORMAT, version: '2' }, ['version'], 'library-version-invalid'],
      [{ format: LIBRARY_FORMAT, version: 3 }, ['version'], 'library-version-unsupported'],
      [library([], { extra: true }), ['extra'], 'schema-unknown-property'],
      [library([], { exportedAt: 'yesterday' }), ['exportedAt'], 'schema-invalid-format'],
      [library([query('q', { panel: { fieldConfig: { columns: { 'latency.p95': { decimals: '2' } } } } })]),
        ['queries', 0, 'spec', 'panel', 'fieldConfig', 'columns', 'latency.p95', 'decimals'], 'schema-invalid-type'],
    ];
    for (const [document, path, code] of cases) {
      expect(validateLibraryDocument(document)[0]).toMatchObject({ path, code });
    }
  });

  it('collects independent safe diagnostics while pruning unsupported-branch noise', () => {
    const diagnostics = validateLibraryDocument(library([
      { ...query('same'), specVersion: 9 },
      { ...query('same'), sql: 1 },
    ], { extra: true }));
    expect(diagnostics.map((item) => [item.path, item.code])).toEqual(expect.arrayContaining([
      [['queries', 0, 'specVersion'], 'spec-version-unsupported'],
      [['queries', 1, 'sql'], 'schema-invalid-type'],
      [['queries', 1, 'id'], 'library-duplicate-query-id'],
      [['extra'], 'schema-unknown-property'],
    ]));
    expect(diagnostics.filter((item) => item.path[0] === 'queries' && item.path[1] === 0)).toHaveLength(1);
  });

  it('rejects closed saved-query roots, blank ids, unsupported Specs, duplicates, and oversized input', () => {
    expect(validateSavedQueryDocument({ ...query(), extra: true })[0]).toMatchObject({
      path: ['extra'], code: 'schema-unknown-property',
    });
    expect(validateSavedQueryDocument(query(' '))[0]).toMatchObject({ path: ['id'], code: 'schema-invalid-string' });
    expect(validateSavedQueryDocument({ ...query(), specVersion: 2 })[0]).toMatchObject({
      path: ['specVersion'], code: 'spec-version-unsupported',
    });
    expect(validateLibraryDocument(library([query('same'), query('same')]))[0]).toMatchObject({
      path: ['queries', 1, 'id'], code: 'library-duplicate-query-id',
    });
    const many = Array.from({ length: MAX_LIBRARY_QUERIES + 1 }, (_, index) => query(String(index)));
    expect(validateLibraryDocument(library(many))[0]).toMatchObject({ path: ['queries'], code: 'schema-array-size' });
    expect(validateLibraryDocument({ format: LIBRARY_FORMAT, version: 1, queries: many })[0])
      .toMatchObject({ path: ['queries'], code: 'schema-array-size' });
  });

  it('attributes nested diagnostics to the schema that owns the failing value', () => {
    expect(validateLibraryDocument(library([query('q', { favorite: 'yes' })]))[0]).toMatchObject({
      path: ['queries', 0, 'spec', 'favorite'], schemaId: QUERY_SPEC_V1_SCHEMA_ID,
    });
    expect(validateLibraryDocument(library([{ ...query(), sql: 1 }]))[0]).toMatchObject({
      path: ['queries', 0, 'sql'], schemaId: SAVED_QUERY_V2_SCHEMA_ID,
    });
    expect(validateLibraryDocument(library([], { extra: true }))[0]).toMatchObject({
      path: ['extra'], schemaId: LIBRARY_V2_SCHEMA_ID,
    });
  });

  it('accepts exactly 1000 minimal queries in linear semantic validation', () => {
    const queries = Array.from({ length: MAX_LIBRARY_QUERIES }, (_, index) => query(String(index)));
    expect(validateLibraryDocument(library(queries))).toEqual([]);
  });
});

describe('decoding and migrations', () => {
  it('decodes v2 metadata and deep-clones complete extension data', () => {
    const source = library([query('q', { extension: { nested: [1] } })], { $schema: LIBRARY_V2_SCHEMA_ID });
    const result = decodeLibraryDocument(source);
    expect(result).toMatchObject({ ok: true, value: {
      libraryVersion: 2, format: LIBRARY_FORMAT, exportedAt: source.exportedAt,
      schema: LIBRARY_V2_SCHEMA_ID, queries: source.queries,
    } });
    expect(result.value.queries).not.toBe(source.queries);
    expect(result.value.queries[0].spec.extension).not.toBe(source.queries[0].spec.extension);
  });

  it('migrates forgiving v1 input sequentially and validates canonical output', () => {
    const source = { format: LIBRARY_FORMAT, version: 1, queries: [
      { id: 'old', name: 'Old', sql: '1', chart: { cfg: { type: 'pie', x: 0, y: [1] } } },
      { sql: '2' }, null,
    ] };
    const result = decodeLibraryDocument(source, {
      nowISO: '2026-07-14T01:00:00.000Z', generateId: (index) => `g${index}`,
    });
    expect(result.ok).toBe(true);
    expect(result.value.queries.map((item) => item.id)).toEqual(['old', 'g1']);
    expect(result.value.queries[0].spec.panel.cfg.type).toBe('pie');
    expect(result.value.exportedAt).toBe('2026-07-14T01:00:00.000Z');
    expect(source.version).toBe(1);
    expect(migrateLibraryDocument(source, 1)).toEqual({ ok: true, value: source });
    expect(migrateLibraryDocument(source, 0).diagnostics[0].code).toBe('migration-downgrade');
  });

  it('decodes JSON failures and future versions without mutation', () => {
    expect(decodeLibraryJson('{bad').diagnostics[0].code).toBe('json-syntax');
    expect(decodeLibraryJson(JSON.stringify({ format: LIBRARY_FORMAT, version: 9, queries: [] }))
      .diagnostics[0].code).toBe('library-version-unsupported');
    expect(decodeLibraryJson(JSON.stringify(library([{ ...query(), specVersion: 9 }])))
      .diagnostics[0].code).toBe('spec-version-unsupported');
  });

  it('validates same-version Spec migration and rejects unsupported targets', () => {
    const source = query('q', { extension: { x: 1 } });
    const same = migrateSavedQuerySpec(source, 1);
    expect(same).toEqual({ ok: true, value: source });
    expect(same.value.spec).not.toBe(source.spec);
    expect(migrateSavedQuerySpec(source, 2).diagnostics[0].code).toBe('migration-missing-step');
    expect(migrateSavedQuerySpec({ ...source, extra: 'would be lost' }, 1).diagnostics[0])
      .toMatchObject({ path: ['extra'], code: 'schema-unknown-property' });
  });
});

describe('encoding', () => {
  it('emits and validates canonical output with an optional instance hint', () => {
    const source = query('q', { extension: { nested: [1] } });
    const encoded = encodeLibraryDocument([source], { nowISO: '2026-07-14T02:00:00.000Z' });
    expect(encoded).toMatchObject({ ok: true, value: {
      $schema: LIBRARY_V2_SCHEMA_ID, format: LIBRARY_FORMAT, version: 2,
      exportedAt: '2026-07-14T02:00:00.000Z', queries: [source],
    } });
    expect(encoded.value.queries[0].spec).not.toBe(source.spec);
    const withoutHint = encodeLibraryDocument([source], {
      nowISO: '2026-07-14T02:00:00.000Z', includeSchemaHint: false,
    });
    expect(withoutHint.value).not.toHaveProperty('$schema');
    expect(JSON.parse(encodeLibraryJson([source], { nowISO: '2026-07-14T02:00:00.000Z' }).value))
      .toEqual(encoded.value);
    expect(encodeLibraryDocument([{ id: 'old', name: 'Legacy', sql: 'SELECT 2' }], {
      nowISO: '2026-07-14T02:00:00.000Z',
    }).value.queries[0]).toMatchObject({
      id: 'old', sql: 'SELECT 2', specVersion: 1, spec: { name: 'Legacy', favorite: false },
    });
  });

  it('rejects invalid output, duplicate ids, and non-array input', () => {
    expect(encodeLibraryDocument([query()]).diagnostics[0]).toMatchObject({
      path: ['exportedAt'], code: 'schema-required',
    });
    expect(encodeLibraryDocument([query()], { nowISO: 'bad' }).diagnostics[0].code).toBe('schema-invalid-format');
    expect(encodeLibraryDocument([query('x'), query('x')], { nowISO: '2026-07-14T00:00:00Z' })
      .diagnostics[0].code).toBe('library-duplicate-query-id');
    expect(encodeLibraryDocument({}, { nowISO: '2026-07-14T00:00:00Z' }).diagnostics[0].code)
      .toBe('schema-invalid-type');
    expect(encodeLibraryJson([query()], { nowISO: 'bad' }).ok).toBe(false);
  });
});

describe('historical localStorage ingress', () => {
  it('decodes legacy/current rows, repairs historical ids, and never aliases input', () => {
    const source = [
      { name: 'Legacy', sql: '1' },
      { id: 'same', sql: '2', specVersion: 1, spec: { name: 'A' } },
      { id: 'same', sql: '3', specVersion: 1, spec: { name: 'B', extension: { x: 1 } } },
      { sql: '4', specVersion: 1, spec: { name: 'Previously persisted without id' } },
    ];
    const result = decodeStoredSavedQueries(source, { generateId: (index, attempt) => `g-${index}-${attempt}` });
    expect(result.ok).toBe(true);
    expect(result.value.map((item) => item.id)).toEqual(['g-0-0', 'same', 'g-2-0', 'g-3-0']);
    expect(result.value[2].spec).not.toBe(source[2].spec);
    expect(source[0]).not.toHaveProperty('spec');
  });

  it('fails closed without mutating corrupt/future storage', () => {
    const future = [{ id: 'q', sql: '1', specVersion: 9, spec: {} }];
    const result = decodeStoredSavedQueries(future);
    expect(result).toMatchObject({ ok: false, value: [], diagnostics: [{
      path: [0, 'specVersion'], code: 'spec-version-unsupported',
    }] });
    expect(future[0].specVersion).toBe(9);
    expect(decodeStoredSavedQueries({}).diagnostics[0].code).toBe('storage-invalid-root');
    expect(decodeStoredSavedQueries(Array(MAX_LIBRARY_QUERIES + 1).fill(null)).diagnostics[0].code)
      .toBe('storage-array-size');
    expect(decodeStoredSavedQueries([{ id: 'q', sql: 1, specVersion: 1, spec: {} }]).ok).toBe(false);
  });

  it('retains __proto__ as ordinary JSON data and protects the prototype', () => {
    const parsed = JSON.parse('[{"id":"q","sql":"1","specVersion":1,"spec":{"__proto__":{"polluted":true}}}]');
    const result = decodeStoredSavedQueries(parsed);
    expect(result.ok).toBe(true);
    expect(Object.hasOwn(result.value[0].spec, '__proto__')).toBe(true);
    expect({}.polluted).toBeUndefined();
  });

  it('surfaces an impossible id policy and supports throwing adapters', () => {
    expect(() => decodeStoredSavedQueries([{ name: 'x', sql: '1' }], { generateId: () => '' }))
      .toThrow('Unable to generate a unique stored saved-query id');
    expect(throwingValue({ ok: true, value: 1 })).toBe(1);
    expect(() => throwingValue({ ok: false, diagnostics: [] })).toThrow('Invalid document');
    try {
      throwingValue({ ok: false, diagnostics: [{ path: [], code: 'x', severity: 'error', message: 'no' }] });
    } catch (error) {
      expect(error.message).toBe('no');
      expect(error.diagnostics).toHaveLength(1);
    }
  });
});
