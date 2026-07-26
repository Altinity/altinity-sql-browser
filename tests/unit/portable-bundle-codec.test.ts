import { describe, expect, it } from 'vitest';
import {
  CURRENT_PORTABLE_BUNDLE_VERSION, LEGACY_PORTABLE_BUNDLE_VERSIONS, PORTABLE_BUNDLE_FORMAT,
  PORTABLE_BUNDLE_V1_SCHEMA_ID, PORTABLE_BUNDLE_V2_SCHEMA_ID,
  decodePortableBundleJson, encodePortableBundleJson, migratePortableBundleV1ToV2,
  validatePortableBundleDocument,
} from '../../src/dashboard/model/portable-bundle-codec.js';
import type { WorkspaceDiagnostic } from '../../src/dashboard/model/workspace-diagnostics.js';

const codes = (d: WorkspaceDiagnostic[]): string[] => d.map((x) => x.code);
const has = (d: WorkspaceDiagnostic[], code: string): boolean => d.some((x) => x.code === code);

const panelQuery = (id: string) => ({ id, sql: 'SELECT 1', specVersion: 1, spec: { name: id, panel: { cfg: { type: 'bar', x: 0, y: [1] } } } });
// Current (document v2) Dashboard — no curated filters (#447).
const dashboardDoc = (over: Record<string, unknown> = {}) => ({
  documentVersion: 2, id: 'd1', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} }, tiles: [], ...over,
});
// Legacy (document v1) Dashboard — curated filters, used only for the pre-#447
// bundle fixtures the codec must still read.
const dashboardDocV1 = (over: Record<string, unknown> = {}) => ({
  documentVersion: 1, id: 'd1', title: 'D', revision: 1,
  layout: { type: 'flow', version: 1, preset: 'report', items: {} }, filters: [], tiles: [], ...over,
});
const bundle = (over: Record<string, unknown> = {}) => ({
  format: PORTABLE_BUNDLE_FORMAT, version: 2, exportedAt: '2026-07-17T00:00:00.000Z',
  queries: [], dashboards: [], ...over,
});
/** A bundle persisted before #447 — pins document-v1 Dashboards. Still readable. */
const legacyBundle = (over: Record<string, unknown> = {}) => ({
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

  it('fails closed on identity problems, and is strict about the V2 version', () => {
    expect(codes(validatePortableBundleDocument(null))).toEqual(['bundle-invalid-root']);
    expect(codes(validatePortableBundleDocument({ format: 'x' }))).toEqual(['bundle-invalid-format']);
    expect(codes(validatePortableBundleDocument({ format: PORTABLE_BUNDLE_FORMAT }))).toEqual(['bundle-version-missing']);
    expect(codes(validatePortableBundleDocument({ format: PORTABLE_BUNDLE_FORMAT, version: 1.5 }))).toEqual(['bundle-version-invalid']);
    expect(codes(validatePortableBundleDocument({ format: PORTABLE_BUNDLE_FORMAT, version: 3 }))).toEqual(['bundle-version-unsupported']);
    // A legacy v1 document is not a valid CANDIDATE — only the decoder reads v1.
    expect(codes(validatePortableBundleDocument(legacyBundle()))).toEqual(['bundle-version-unsupported']);
  });

  it('reports structural schema errors, e.g. a missing required array', () => {
    const d = validatePortableBundleDocument({ format: PORTABLE_BUNDLE_FORMAT, version: 2, exportedAt: '2026-07-17T00:00:00.000Z', queries: [] });
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
});

describe('migratePortableBundleV1ToV2', () => {
  it('drops curated filters from every Dashboard, carrying queries through untouched', () => {
    const dashboard = dashboardDocV1({
      tiles: [{ id: 't1', queryId: 'p1' }],
      filters: [{ id: 'flt', parameter: 'country', sourceQueryId: 'p2' }],
      layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
    });
    const source = legacyBundle({ queries: [panelQuery('p1'), panelQuery('p2')], dashboards: [dashboard] });
    const migrated = migratePortableBundleV1ToV2(source as never);
    expect(migrated.version).toBe(2);
    expect(migrated.$schema).toBe(PORTABLE_BUNDLE_V2_SCHEMA_ID);
    expect(migrated.dashboards[0].documentVersion).toBe(2);
    expect(migrated.dashboards[0]).not.toHaveProperty('filters');
    expect(migrated.dashboards[0].tiles).toEqual([{ id: 't1', queryId: 'p1' }]);
    // Queries are untouched — including the one only a dropped filter referenced.
    expect(migrated.queries.map((q) => q.id)).toEqual(['p1', 'p2']);
  });
});

describe('decodePortableBundleJson', () => {
  it('parses, validates, and returns the typed value', () => {
    const result = decodePortableBundleJson(JSON.stringify(bundle()));
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.format).toBe(PORTABLE_BUNDLE_FORMAT);
    expect(result.ok && result.value.version).toBe(CURRENT_PORTABLE_BUNDLE_VERSION);
  });

  it('reads a persisted v1 bundle through the v1 -> v2 migration', () => {
    const dashboard = dashboardDocV1({
      tiles: [{ id: 't1', queryId: 'p1' }],
      layout: { type: 'flow', version: 1, preset: 'report', items: { t1: {} } },
    });
    const result = decodePortableBundleJson(JSON.stringify(
      legacyBundle({ queries: [panelQuery('p1')], dashboards: [dashboard] }),
    ));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(2);
    expect(result.value.dashboards[0].documentVersion).toBe(2);
    expect(result.value.dashboards[0]).not.toHaveProperty('filters');
    expect([...LEGACY_PORTABLE_BUNDLE_VERSIONS]).toEqual([1]);
  });

  it("reports a legacy bundle's own structural problems at its own paths", () => {
    const bad = decodePortableBundleJson(JSON.stringify(
      legacyBundle({ dashboards: [dashboardDocV1({ documentVersion: 4 })] }),
    ));
    expect(!bad.ok && bad.diagnostics.some((d) => d.code === 'dashboard-version-unsupported')).toBe(true);
  });

  it('propagates codec-guard failures and validation failures', () => {
    expect(decodePortableBundleJson('{bad').ok).toBe(false);
    const tooDeep = decodePortableBundleJson('['.repeat(70) + ']'.repeat(70), { maxDepth: 64 });
    expect(tooDeep.ok).toBe(false);
    expect(!tooDeep.ok && tooDeep.diagnostics[0].code).toBe('limit-json-depth');
    const invalid = decodePortableBundleJson(JSON.stringify({ format: 'nope' }));
    expect(!invalid.ok && invalid.diagnostics[0].code).toBe('bundle-invalid-format');
    const futureVersion = decodePortableBundleJson(JSON.stringify(bundle({ version: 3 })));
    expect(!futureVersion.ok && futureVersion.diagnostics[0].code).toBe('bundle-version-unsupported');
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
    expect(parsed.$schema).toBe(PORTABLE_BUNDLE_V2_SCHEMA_ID);
    expect(parsed.version).toBe(CURRENT_PORTABLE_BUNDLE_VERSION);
    // Canonical key order: $schema first, queries before dashboards.
    expect(result.value.indexOf('"$schema"')).toBeLessThan(result.value.indexOf('"format"'));
    expect(result.value.indexOf('"queries"')).toBeLessThan(result.value.indexOf('"dashboards"'));
    // Reference schema ids stay exported: v2 for writes, v1 for legacy reads.
    expect(PORTABLE_BUNDLE_V2_SCHEMA_ID).toContain('portable-bundle-v2');
    expect(PORTABLE_BUNDLE_V1_SCHEMA_ID).toContain('portable-bundle-v1');
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
    // An arbitrary extension field (query-spec is open) inflates each spec to just
    // under the 1 MiB per-spec cap; twenty-one sum past the 20 MiB whole-document
    // cap (#427 doubled it so the ownership migration, which adds a copy per
    // Dashboard member, cannot leave a workspace permanently un-committable).
    const chunk = 'x'.repeat(1_000_000);
    const queries = Array.from({ length: 21 }, (_, i) => ({
      id: `q${i}`, sql: 'SELECT 1', specVersion: 1, spec: { name: `q${i}`, ext: chunk },
    }));
    const result = encodePortableBundleJson({ queries, dashboards: [], nowISO: '2026-07-17T00:00:00.000Z' });
    expect(!result.ok && result.diagnostics[0].code).toBe('limit-json-bytes');
  });
});
