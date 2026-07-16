import { describe, expect, it } from 'vitest';
import { hasFieldValueFormat, resolveFieldConfig } from '../../src/core/field-config.js';

describe('resolveFieldConfig', () => {
  it('merges defaults before exact column overrides without mutating either layer', () => {
    const fieldConfig = {
      defaults: { decimals: 2, unit: ' ms', noValue: 'n/a', future: { source: 'default' }, delta: { unit: ' pp', show: true } },
      columns: { latency: { displayName: 'p95 latency', decimals: 1, description: '95th percentile.', future: { source: 'column' }, delta: { show: false } } },
    };
    const out = resolveFieldConfig(fieldConfig, 'latency');
    expect(out).toEqual({
      displayName: 'p95 latency', description: '95th percentile.', unit: ' ms', decimals: 1,
      color: null, noValue: 'n/a', hidden: false, future: { source: 'column' },
      delta: { unit: ' pp', show: false },
    });
    out.future.source = 'changed';
    out.delta.show = true;
    expect(fieldConfig.columns.latency.future.source).toBe('column');
    expect(fieldConfig.columns.latency.delta.show).toBe(false);
  });

  it('matches column names exactly and supplies renderer fallbacks', () => {
    const config = { columns: { CPU: { unit: '%' } } };
    expect(resolveFieldConfig(config, 'cpu')).toEqual({
      displayName: 'cpu', description: null, unit: '', decimals: null,
      color: null, noValue: '—', hidden: false,
    });
    expect(resolveFieldConfig(null, 'value')).toEqual({
      displayName: 'value', description: null, unit: '', decimals: null,
      color: null, noValue: '—', hidden: false,
    });
  });

  it('ignores invalid known overrides in favor of valid defaults, then fallbacks', () => {
    const out = resolveFieldConfig({
      defaults: { displayName: 'Default', unit: '%', decimals: 2, hidden: true, noValue: 'none', color: '#fff', description: 'default' },
      columns: { value: { displayName: 1, unit: null, decimals: 21, hidden: 'yes', noValue: false, color: '', description: {} } },
    }, 'value');
    expect(out).toMatchObject({
      displayName: 'Default', unit: '%', decimals: 2, hidden: true,
      noValue: 'none', color: '#fff', description: 'default',
    });
    expect(resolveFieldConfig({ defaults: { decimals: -1 }, columns: { value: { hidden: 1 } } }, 'value'))
      .toMatchObject({ decimals: null, hidden: false });
  });
});

describe('hasFieldValueFormat', () => {
  it('recognizes valid defaults and exact column value formats only', () => {
    expect(hasFieldValueFormat(null, 'value')).toBe(false);
    expect(hasFieldValueFormat({ defaults: [] }, 'value')).toBe(false);
    expect(hasFieldValueFormat({ defaults: { unit: '' }, columns: [] }, 'value')).toBe(false);
    expect(hasFieldValueFormat({ defaults: { decimals: 2 } }, 'value')).toBe(true);
    expect(hasFieldValueFormat({ columns: { value: { unit: '%' } } }, 'value')).toBe(true);
    expect(hasFieldValueFormat({ columns: { value: { noValue: 'n/a' } } }, 'value')).toBe(true);
    expect(hasFieldValueFormat({ columns: { Value: { unit: '%' }, value: 2 } }, 'value')).toBe(false);
    expect(hasFieldValueFormat({ defaults: { decimals: 21 } }, 'value')).toBe(false);
  });
});
