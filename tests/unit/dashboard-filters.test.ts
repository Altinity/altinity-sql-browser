import { describe, expect, it } from 'vitest';
import { mergeDashboardFilterHelpers } from '../../src/core/dashboard-filters.js';

const helper = (name, options) => ({ name, sourceType: 'Array(String)', shape: 'array', options, totalOptions: options.length, truncated: false });
const provider = (sourceId, sourceName, helpers) => ({ sourceId, sourceName, helpers });

describe('Dashboard Filter helper merge', () => {
  it('has harmless defaults', () => {
    expect(mergeDashboardFilterHelpers()).toEqual({ fields: {}, diagnostics: [], values: {}, active: {}, changed: [] });
    expect(mergeDashboardFilterHelpers({ providers: [{}] }).fields).toEqual({});
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
