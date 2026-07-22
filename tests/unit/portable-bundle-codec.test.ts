import { describe, expect, it } from 'vitest';
import {
  CURRENT_PORTABLE_BUNDLE_VERSION, PORTABLE_BUNDLE_FORMAT, PORTABLE_BUNDLE_V1_SCHEMA_ID,
  decodePortableBundleJson, encodePortableBundleJson, validatePortableBundleDocument,
} from '../../src/dashboard/model/portable-bundle-codec.js';
import type { WorkspaceDiagnostic } from '../../src/dashboard/model/workspace-diagnostics.js';

const codes = (d: WorkspaceDiagnostic[]): string[] => d.map((x) => x.code);
const has = (d: WorkspaceDiagnostic[], code: string): boolean => d.some((x) => x.code === code);

const panelQuery = (id: string) => ({ id, sql: 'SELECT 1', specVersion: 1, spec: { name: id, panel: { cfg: { type: 'bar', x: 0, y: [1] } } } });
const dashboardDoc = (over: Record<string, unknown> = {}) => ({
  documentVersion: 1, id: 'd1', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} }, filters: [], tiles: [], ...over,
});
const bundle = (over: Record<string, unknown> = {}) => ({
  format: PORTABLE_BUNDLE_FORMAT, version: 1, exportedAt: '2026-07-17T00:00:00.000Z',
  queries: [], dashboards: [], ...over,
});

describe('validatePortableBundleDocument', () => {
  it('accepts an empty but well-formed bundle and a bundle with a resolvable dashboard', () => {
    expect(validatePortableBundleDocument(bundle())).toEqual([]);
    const full = bundle({
      queries: [panelQuery('p1')],
      dashboards: [dashboardDoc({ tiles: [{ id: 't1', queryId: 'p1' }], layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } } })],
    });
    expect(validatePortableBundleDocument(full)).toEqual([]);
  });

  it('fails closed on identity problems', () => {
    expect(codes(validatePortableBundleDocument(null))).toEqual(['bundle-invalid-root']);
    expect(codes(validatePortableBundleDocument({ format: 'x' }))).toEqual(['bundle-invalid-format']);
    expect(codes(validatePortableBundleDocument({ format: PORTABLE_BUNDLE_FORMAT }))).toEqual(['bundle-version-missing']);
    expect(codes(validatePortableBundleDocument({ format: PORTABLE_BUNDLE_FORMAT, version: 1.5 }))).toEqual(['bundle-version-invalid']);
    expect(codes(validatePortableBundleDocument({ format: PORTABLE_BUNDLE_FORMAT, version: 2 }))).toEqual(['bundle-version-unsupported']);
  });

  it('reports structural schema errors, e.g. a missing required array', () => {
    const d = validatePortableBundleDocument({ format: PORTABLE_BUNDLE_FORMAT, version: 1, exportedAt: '2026-07-17T00:00:00.000Z', queries: [] });
    expect(has(d, 'schema-required')).toBe(true); // dashboards required even when empty
  });

  it('fails closed on unknown resource versions and suppresses schema noise for them', () => {
    const d = validatePortableBundleDocument(bundle({
      queries: [{ id: 'q', sql: 'x', specVersion: 9, spec: {} }],
      dashboards: [dashboardDoc({ documentVersion: 5 })],
    }));
    expect(has(d, 'spec-version-unsupported')).toBe(true);
    expect(has(d, 'dashboard-version-unsupported')).toBe(true);
  });

  it('runs cross-resource semantics once the document is structurally valid', () => {
    const d = validatePortableBundleDocument(bundle({
      queries: [panelQuery('dup'), panelQuery('dup')],
    }));
    expect(has(d, 'workspace-duplicate-query-id')).toBe(true);
  });

  it('validates dashboard filter selection-mode overrides (#189)', () => {
    const withSelection = (selection: unknown) => bundle({
      dashboards: [dashboardDoc({
        filters: [{ id: 'flt', parameter: 'p', selection }],
      })],
    });
    expect(validatePortableBundleDocument(withSelection({ mode: 'single' }))).toEqual([]);
    expect(validatePortableBundleDocument(withSelection({ mode: 'multiple' }))).toEqual([]);
    expect(validatePortableBundleDocument(withSelection({}))).toEqual([]);

    const badMode = validatePortableBundleDocument(withSelection({ mode: 'bogus' }));
    expect(has(badMode, 'schema-invalid-enum')).toBe(true);

    const unknownProp = validatePortableBundleDocument(withSelection({ mode: 'single', extra: true }));
    expect(has(unknownProp, 'schema-unknown-property')).toBe(true);
  });
});

describe('decodePortableBundleJson', () => {
  it('parses, validates, and returns the typed value', () => {
    const result = decodePortableBundleJson(JSON.stringify(bundle()));
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.format).toBe(PORTABLE_BUNDLE_FORMAT);
  });

  it('propagates codec-guard failures and validation failures', () => {
    expect(decodePortableBundleJson('{bad').ok).toBe(false);
    const tooDeep = decodePortableBundleJson('['.repeat(70) + ']'.repeat(70), { maxDepth: 64 });
    expect(tooDeep.ok).toBe(false);
    expect(!tooDeep.ok && tooDeep.diagnostics[0].code).toBe('limit-json-depth');
    const invalid = decodePortableBundleJson(JSON.stringify({ format: 'nope' }));
    expect(!invalid.ok && invalid.diagnostics[0].code).toBe('bundle-invalid-format');
  });
});

describe('encodePortableBundleJson', () => {
  it('builds, validates, and canonically encodes a bundle with a schema hint and metadata', () => {
    const result = encodePortableBundleJson({
      queries: [panelQuery('p1')], dashboards: [], metadata: { name: 'n' }, nowISO: '2026-07-17T00:00:00.000Z',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.value);
    expect(parsed.$schema).toBe(PORTABLE_BUNDLE_V1_SCHEMA_ID);
    expect(parsed.version).toBe(CURRENT_PORTABLE_BUNDLE_VERSION);
    // Canonical key order: $schema first, queries before dashboards.
    expect(result.value.indexOf('"$schema"')).toBeLessThan(result.value.indexOf('"format"'));
    expect(result.value.indexOf('"queries"')).toBeLessThan(result.value.indexOf('"dashboards"'));
  });

  it('omits the schema hint when asked and omits metadata when absent', () => {
    const result = encodePortableBundleJson({
      queries: [], dashboards: [], nowISO: '2026-07-17T00:00:00.000Z', includeSchemaHint: false,
    });
    expect(result.ok && !result.value.includes('$schema')).toBe(true);
    expect(result.ok && !result.value.includes('metadata')).toBe(true);
  });

  it('rejects non-array inputs and a missing timestamp', () => {
    expect(!encodePortableBundleJson({ queries: 'x' as unknown as unknown[], dashboards: [], nowISO: 'x' }).ok).toBe(true);
    expect(!encodePortableBundleJson({ queries: [], dashboards: 'x' as unknown as unknown[], nowISO: 'x' }).ok).toBe(true);
    const noStamp = encodePortableBundleJson({ queries: [], dashboards: [], nowISO: '' });
    expect(!noStamp.ok && noStamp.diagnostics[0].code).toBe('schema-required');
  });

  it('fails when the built bundle is semantically invalid', () => {
    const result = encodePortableBundleJson({
      queries: [panelQuery('dup'), panelQuery('dup')], dashboards: [], nowISO: '2026-07-17T00:00:00.000Z',
    });
    expect(!result.ok && has(result.diagnostics, 'workspace-duplicate-query-id')).toBe(true);
  });

  it('rejects an encoded document larger than the decoded-JSON byte cap', () => {
    // Each spec stays just under the 1 MiB per-spec limit but eleven of them
    // sum past the 10 MiB whole-document cap.
    // An arbitrary extension field (query-spec is open) inflates each spec to
    // just under the 1 MiB per-spec cap; eleven sum past the 10 MiB document cap.
    const chunk = 'x'.repeat(1_000_000);
    const queries = Array.from({ length: 11 }, (_, i) => ({
      id: `q${i}`, sql: 'SELECT 1', specVersion: 1, spec: { name: `q${i}`, ext: chunk },
    }));
    const result = encodePortableBundleJson({ queries, dashboards: [], nowISO: '2026-07-17T00:00:00.000Z' });
    expect(!result.ok && result.diagnostics[0].code).toBe('limit-json-bytes');
  });
});
