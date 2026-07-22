import { describe, expect, it } from 'vitest';
import { mergeDashboardFilterHelpers } from '../../src/core/dashboard-filters.js';
import type { FilterHelper, FilterHelperOption, FilterProvider } from '../../src/core/dashboard-filters.js';

const helper = (name: string, options: FilterHelperOption[]): FilterHelper =>
  ({ name, sourceType: 'Array(String)', shape: 'array', options, totalOptions: options.length, truncated: false });
// `sourceName` deliberately accepts `null` too — a couple of call sites below
// pass it to exercise the `provider.sourceName || provider.sourceId` fallback
// in the module under test; the cast keeps that exact runtime value while
// satisfying `FilterProvider`'s `sourceName?: string`.
const provider = (sourceId: string, sourceName: string | null, helpers: FilterHelper[]): FilterProvider =>
  ({ sourceId, sourceName: sourceName as string | undefined, helpers });

describe('Dashboard Filter helper merge', () => {
  it('has harmless defaults', () => {
    expect(mergeDashboardFilterHelpers()).toEqual({ fields: {}, diagnostics: [], values: {}, active: {}, changed: [] });
    // A deliberately malformed provider (missing every field) — the module
    // must degrade harmlessly rather than throw.
    expect(mergeDashboardFilterHelpers({ providers: [{}] as FilterProvider[] }).fields).toEqual({});
  });
  it('matches exact consumers and retains healthy siblings', () => {
    const out = mergeDashboardFilterHelpers({
      providers: [provider('a', 'Options', [helper('origin', [{ value: 'ATL', label: 'Atlanta' }]), helper('unused', [])])],
      controls: [{ name: 'origin', type: 'String', optional: true }],
    });
    expect(out.fields.origin).toMatchObject({ declaredType: 'String', sourceId: 'a' });
    expect(out.fields.unused).toBeUndefined();
    expect(out.diagnostics.map((d) => d.code)).toEqual(['filter-helper-unused']);
  });
  it('rejects duplicate providers per helper without affecting other names', () => {
    const out = mergeDashboardFilterHelpers({
      providers: [
        provider('a', 'A', [helper('x', []), helper('aOnly', [])]),
        provider('b', 'B', [helper('x', []), helper('bOnly', [])]),
      ],
      controls: ['x', 'aOnly', 'bOnly'].map((name) => ({ name, type: 'String', optional: false })),
    });
    expect(Object.keys(out.fields)).toEqual(['aOnly', 'bOnly']);
    expect(out.diagnostics[0]).toMatchObject({ code: 'filter-duplicate-provider', helperName: 'x' });
    expect(out.diagnostics[0].message).toContain('A, B');
  });
  it('falls back on consumer conflicts or invalid options', () => {
    const out = mergeDashboardFilterHelpers({
      providers: [provider('p', 'P', [
        helper('conflict', [{ value: '1', label: 'one' }]),
        helper('bad', [{ value: '256', label: 'too large' }]),
      ])],
      controls: [
        { name: 'conflict', type: 'UInt8', optional: false, conflict: ['UInt8', 'String'] },
        { name: 'bad', type: 'UInt8', optional: false },
      ],
    });
    expect(out.fields).toEqual({});
    expect(out.diagnostics.map((d) => d.code)).toEqual(['filter-target-type-conflict', 'filter-option-consumer-invalid']);
  });
  it('reconciles stale active values without replacing dormant values', () => {
    const out = mergeDashboardFilterHelpers({
      providers: [provider('p', 'P', [helper('x', [{ value: 'new', label: 'New' }]), helper('empty', [{ value: '', label: '(empty)' }])])],
      controls: [{ name: 'x', type: 'String', optional: true }, { name: 'empty', type: 'String', optional: true }],
      values: { x: 'stale', empty: '' }, active: { x: true, empty: true },
    });
    expect(out.values).toEqual({ x: 'stale', empty: '' });
    expect(out.active).toEqual({ x: false, empty: true });
    expect(out.changed).toEqual(['x']);
  });
  it('preserves provider diagnostics and is case-sensitive', () => {
    const out = mergeDashboardFilterHelpers({
      providers: [{ ...provider('p', 'P', [helper('Origin', [])]), diagnostics: [{ severity: 'info', code: 'source-info', message: 'i' }] }],
      controls: [{ name: 'origin', type: 'String', optional: false }],
    });
    expect(out.fields).toEqual({});
    expect(out.diagnostics.map((d) => d.code)).toEqual(['source-info', 'filter-helper-unused']);
  });
  // #189: a multiselect (Array-contract) filter's committed value is a real
  // string array — `mergeDashboardFilterHelpers` must reconcile it via
  // `reconcileSelection` (filter-selection.ts), never the scalar
  // `String(...)` comparison above (which would stringify an array and never
  // match any option).
  describe('array (#189 multiselect) reconciliation', () => {
    it('non-empty intersection: stays active, value canonicalizes to fresh option order; a pure reorder is NOT a change', () => {
      const out = mergeDashboardFilterHelpers({
        providers: [provider('p', 'P', [helper('region', [
          { value: 'east', label: 'East' }, { value: 'west', label: 'West' },
        ])])],
        controls: [{ name: 'region', type: 'Array(String)', optional: true }],
        values: { region: ['west', 'east'] }, active: { region: true },
      });
      // Every committed value still present — reorders to the FRESH option
      // order, but that alone is not a change needing a rerun.
      expect(out.values.region).toEqual(['east', 'west']);
      expect(out.active.region).toBe(true);
      expect(out.changed).toEqual([]);
    });

    it('partial removal: narrows to survivors, stays active, and IS a change (joins the affected-panel wave)', () => {
      const out = mergeDashboardFilterHelpers({
        providers: [provider('p', 'P', [helper('region', [{ value: 'east', label: 'East' }])])],
        controls: [{ name: 'region', type: 'Array(String)', optional: true }],
        values: { region: ['east', 'west'] }, active: { region: true },
      });
      expect(out.values.region).toEqual(['east']);
      expect(out.active.region).toBe(true);
      expect(out.changed).toEqual(['region']);
    });

    it('empty intersection: deactivates but keeps the dormant committed array untouched (reactivation policy)', () => {
      const out = mergeDashboardFilterHelpers({
        providers: [provider('p', 'P', [helper('region', [{ value: 'north', label: 'North' }])])],
        controls: [{ name: 'region', type: 'Array(String)', optional: true }],
        values: { region: ['east', 'west'] }, active: { region: true },
      });
      expect(out.active.region).toBe(false);
      // The ORIGINAL committed array is retained verbatim — never emptied or
      // canonicalized — so reactivation restores exactly what was selected.
      expect(out.values.region).toEqual(['east', 'west']);
      expect(out.changed).toEqual(['region']);
    });

    it('an inactive array-valued field is never reconciled (same as today\'s scalar dormant-value policy)', () => {
      const out = mergeDashboardFilterHelpers({
        providers: [provider('p', 'P', [helper('region', [{ value: 'north', label: 'North' }])])],
        controls: [{ name: 'region', type: 'Array(String)', optional: true }],
        values: { region: ['east', 'west'] }, active: { region: false },
      });
      expect(out.values.region).toEqual(['east', 'west']);
      expect(out.active.region).toBe(false);
      expect(out.changed).toEqual([]);
    });
  });

  it('uses a source id in duplicate diagnostics and keeps already-valid active selections', () => {
    const out = mergeDashboardFilterHelpers({
      providers: [provider('a', '', [helper('x', [{ value: '1', label: 'One' }])]), provider('b', null, [helper('x', [])])],
      controls: [{ name: 'x', type: 'UInt8', optional: false }], values: { x: '1' }, active: { x: true },
    });
    expect(out.diagnostics[0].message).toContain('a, b');
    const single = mergeDashboardFilterHelpers({
      providers: [provider('a', 'A', [helper('x', [{ value: '1', label: 'One' }])])],
      controls: [{ name: 'x', type: 'UInt8', optional: false }], values: { x: '1' }, active: { x: true },
    });
    expect(single.active.x).toBe(true);
    expect(single.changed).toEqual([]);
  });
});
