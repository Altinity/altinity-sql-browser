import { describe, expect, it } from 'vitest';
import { createQueryResolver } from '../../src/dashboard/application/dashboard-query-resolver.js';

const query = (id: string, dashboard?: Record<string, unknown>) => ({
  id, sql: 'SELECT 1', specVersion: 1, spec: { name: id, ...(dashboard ? { dashboard } : {}) },
});

describe('createQueryResolver', () => {
  it('looks up queries and reads role and variants; first duplicate wins', () => {
    const resolver = createQueryResolver([
      query('p', { role: 'panel', variants: { alt: {} } }),
      query('f', { role: 'filter' }),
      { id: 'p', sql: 'x', specVersion: 1, spec: {} }, // duplicate id ignored
      'not-object',
      { sql: 'no id' },
    ]);
    expect(resolver.has('p')).toBe(true);
    expect(resolver.has('missing')).toBe(false);
    expect((resolver.get('p') as { spec: { dashboard: unknown } }).spec.dashboard).toEqual({ role: 'panel', variants: { alt: {} } });
    expect(resolver.get('missing')).toBeUndefined();
    expect(resolver.role('p')).toBe('panel');
    expect(resolver.role('f')).toBe('filter');
    expect(resolver.role('missing')).toBeUndefined();
    expect(resolver.variants('p')).toEqual({ alt: {} });
    expect(resolver.variants('f')).toBeUndefined(); // no variants declared
    expect(resolver.variants('missing')).toBeUndefined();
  });
});
