import { describe, expect, it } from 'vitest';
import { normalizeLegacyLibraryToBundle } from '../../src/dashboard/model/legacy-bundle.js';
import { LIBRARY_FORMAT } from '../../src/core/library-codec.js';
import { PORTABLE_BUNDLE_FORMAT, PORTABLE_BUNDLE_V1_SCHEMA_ID } from '../../src/dashboard/model/portable-bundle-codec.js';

const query = (id = 'q', spec: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id, sql: 'SELECT 1', specVersion: 1, spec });

const libraryV2 = (queries: unknown[] = [query()], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: LIBRARY_FORMAT, version: 2, exportedAt: '2026-07-14T00:00:00.000Z', queries, ...over,
});

describe('normalizeLegacyLibraryToBundle', () => {
  it('normalizes a valid Library v2 document into a bundle with dashboards:[] and preserved queries', () => {
    const source = libraryV2([query('q1', { extension: { nested: [1] } })]);
    const result = normalizeLegacyLibraryToBundle(JSON.stringify(source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.format).toBe(PORTABLE_BUNDLE_FORMAT);
    expect(result.value.$schema).toBe(PORTABLE_BUNDLE_V1_SCHEMA_ID);
    expect(result.value.version).toBe(1);
    expect(result.value.exportedAt).toBe('2026-07-14T00:00:00.000Z');
    expect(result.value.dashboards).toEqual([]);
    expect(result.value.queries).toHaveLength(1);
    expect(result.value.queries[0].id).toBe('q1');
    // Deep-cloned, not aliased to the source document.
    expect(result.value.queries).not.toBe(source.queries);
  });

  it('migrates a legacy Library v1 document, minting ids and falling back to the injected clock', () => {
    const source = {
      format: LIBRARY_FORMAT, version: 1, queries: [
        { id: 'old', name: 'Old', sql: '1', chart: { cfg: { type: 'pie', x: 0, y: [1] } } },
        { sql: '2' },
      ],
    };
    const result = normalizeLegacyLibraryToBundle(JSON.stringify(source), {
      nowISO: '2026-07-18T00:00:00.000Z', generateId: (index: number) => `g${index}`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exportedAt).toBe('2026-07-18T00:00:00.000Z');
    expect(result.value.dashboards).toEqual([]);
    expect(result.value.queries.map((item) => item.id)).toEqual(['old', 'g1']);
  });

  it('rejects malformed JSON without producing a partial bundle', () => {
    const result = normalizeLegacyLibraryToBundle('{not json');
    expect(result).toEqual({
      ok: false,
      diagnostics: [{ path: [], severity: 'error', code: 'json-syntax', message: 'Not a valid JSON file' }],
    });
  });

  it('rejects a Library document that fails codec decoding (e.g. unsupported version) with mapped diagnostics', () => {
    const source = { format: LIBRARY_FORMAT, version: 9, queries: [] };
    const result = normalizeLegacyLibraryToBundle(JSON.stringify(source));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      { path: ['version'], severity: 'error', code: 'library-version-unsupported', message: 'Unsupported Library version 9' },
    ]);
  });

  it('rejects input over the byte limit before parsing, with no partial import', () => {
    const source = libraryV2([query('q1')]);
    const text = JSON.stringify(source);
    const result = normalizeLegacyLibraryToBundle(text, { maxBytes: 4 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      { path: [], severity: 'error', code: 'limit-json-bytes', message: expect.stringContaining('maximum is 4') },
    ]);
  });

  it('rejects input over the depth limit before parsing', () => {
    const nested = '['.repeat(70) + ']'.repeat(70);
    const result = normalizeLegacyLibraryToBundle(nested, { maxDepth: 64 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0].code).toBe('limit-json-depth');
  });

  it('rejects a decoded Library whose wrapped bundle fails portable-bundle validation, without partial import', () => {
    // A v2 document with no `exportedAt` of its own, decoded with no injected
    // `nowISO` fallback, produces a structurally-valid decoded Library but an
    // exportedAt-less wrapped bundle — the final re-validation against
    // PortableBundleV1 (which requires exportedAt) must still catch this,
    // proving the wrap step is genuinely re-validated rather than trusted.
    const source = libraryV2([query('q1')]);
    delete source.exportedAt;
    const result = normalizeLegacyLibraryToBundle(JSON.stringify(source));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((item) => item.path[0] === 'exportedAt')).toBe(true);
  });

  it('passes the validation service through to both the Library decode and bundle re-validation steps', () => {
    const calls: string[] = [];
    const validationService = {
      validate: (schemaId: string, value: unknown) => {
        calls.push(schemaId);
        return [];
      },
      getSchema: () => ({}),
    };
    const source = libraryV2([query('q1')]);
    const result = normalizeLegacyLibraryToBundle(JSON.stringify(source), { validationService });
    expect(result.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });
});
