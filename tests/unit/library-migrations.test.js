import { describe, expect, it } from 'vitest';
import { migrateLibraryV1ToV2, migrateSequential } from '../../src/core/library-migrations.js';
import { migrateSavedQuerySpec } from '../../src/core/spec-migrations.js';

const valid = () => [];

describe('sequential migrations', () => {
  it('validates every version and applies exactly one step without mutation', () => {
    const input = { version: 1, nested: { value: 1 } };
    const seen = [];
    const codecs = new Map([
      [1, { validateSource: (value) => { seen.push(['v1', value.version]); return valid(); },
        migrateToNext: (value) => ({ ...value, version: 2, nested: { value: value.nested.value + 1 } }) }],
      [2, { validateSource: (value) => { seen.push(['v2', value.version]); return valid(); }, migrateToNext: null }],
    ]);
    const result = migrateSequential({ value: input, fromVersion: 1, toVersion: 2, codecs });
    expect(result).toEqual({ ok: true, value: { version: 2, nested: { value: 2 } } });
    expect(input).toEqual({ version: 1, nested: { value: 1 } });
    expect(result.value.nested).not.toBe(input.nested);
    expect(seen).toEqual([['v1', 1], ['v2', 2]]);
  });

  it('returns stable failures for invalid directions, versions, steps, and validators', () => {
    const codecs = new Map([[1, { validateSource: valid, migrateToNext: null }]]);
    expect(migrateSequential({ value: {}, fromVersion: '1', toVersion: 1, codecs }).diagnostics[0].code)
      .toBe('migration-invalid-version');
    expect(migrateSequential({ value: {}, fromVersion: 2, toVersion: 1, codecs }).diagnostics[0].code)
      .toBe('migration-downgrade');
    expect(migrateSequential({ value: {}, fromVersion: 2, toVersion: 2, codecs }).diagnostics[0].code)
      .toBe('migration-unsupported-version');
    expect(migrateSequential({ value: {}, fromVersion: 1, toVersion: 2, codecs }).diagnostics[0].code)
      .toBe('migration-missing-step');
    const bad = [{ path: ['x'], severity: 'error', code: 'bad', message: 'bad input' }];
    expect(migrateSequential({
      value: {}, fromVersion: 1, toVersion: 1,
      codecs: new Map([[1, { validateSource: () => bad }]]),
    })).toEqual({ ok: false, diagnostics: bad });
  });

  it('rejects an invalid migrated output', () => {
    const bad = [{ path: [], severity: 'error', code: 'bad-output', message: 'bad output' }];
    const result = migrateSequential({
      value: { version: 1 }, fromVersion: 1, toVersion: 2,
      codecs: new Map([
        [1, { validateSource: valid, migrateToNext: () => ({ version: 2 }) }],
        [2, { validateSource: () => bad }],
      ]),
    });
    expect(result).toEqual({ ok: false, diagnostics: bad });
  });
});

describe('Library v1 to v2', () => {
  it('preserves compatibility behavior and produces canonical unique ids', () => {
    const input = {
      format: 'altinity-sql-browser/saved-queries', version: 1, queries: [
        { id: 'same', name: 'Panel', sql: '1', favorite: 1,
          panel: { cfg: { type: 'logs', future: true } }, chart: { cfg: { type: 'pie' } },
          dashboard: { role: 'panel', future: true } },
        { id: 'same', name: 'Text', sql: '', panel: { cfg: { type: 'text', content: 'hello' } } },
        { sql: '2' },
        { sql: 3 },
        null,
      ],
    };
    const output = migrateLibraryV1ToV2(input, {
      nowISO: '2026-07-14T00:00:00.000Z',
      generateId: (index, attempt) => `g-${index}-${attempt}`,
    });
    expect(output).toMatchObject({
      $schema: 'https://altinity.com/schemas/altinity-sql-browser/library-v2.schema.json',
      format: input.format, version: 2, exportedAt: '2026-07-14T00:00:00.000Z',
    });
    expect(output.queries.map((query) => query.id)).toEqual(['same', 'g-1-0', 'g-2-0']);
    expect(output.queries[0].spec).toEqual({
      name: 'Panel', favorite: true,
      panel: { cfg: { type: 'logs', future: true } },
      dashboard: { role: 'panel', future: true },
    });
    expect(output.queries[1].sql).toBe('');
    expect(output.queries[2].spec).toEqual({ name: 'Untitled', favorite: false });
    expect(input.version).toBe(1);
    expect(output.queries[0].spec.panel).not.toBe(input.queries[0].panel);
  });

  it('can omit compatibility metadata and rejects a non-unique id policy', () => {
    const document = { queries: [{ sql: '1' }] };
    const output = migrateLibraryV1ToV2(document, { includeSchemaHint: false });
    expect(output).not.toHaveProperty('$schema');
    expect(output).not.toHaveProperty('exportedAt');
    expect(() => migrateLibraryV1ToV2(document, { generateId: () => '' }))
      .toThrow('Unable to generate a unique legacy saved-query id');
  });
});

describe('Spec migrations', () => {
  it('migrates independently and retains the saved-query envelope', () => {
    const query = { id: 'q', sql: '1', specVersion: 1, spec: { a: { b: 1 } } };
    const result = migrateSavedQuerySpec(query, 1, {
      codecs: new Map([[1, { validateSource: valid, migrateToNext: null }]]),
    });
    expect(result).toEqual({ ok: true, value: query });
    expect(result.value.spec).not.toBe(query.spec);
    expect(migrateSavedQuerySpec(null, 1, { codecs: new Map() }).diagnostics[0].code)
      .toBe('saved-query-invalid');
  });
});
