import { describe, expect, it } from 'vitest';
import {
  comparePathSegments, comparePaths, compareDiagnostics, diagnostic, sortDiagnostics,
} from '../../src/dashboard/model/workspace-diagnostics.js';
import type { WorkspaceDiagnostic } from '../../src/dashboard/model/workspace-diagnostics.js';

const d = (over: Partial<WorkspaceDiagnostic> = {}): WorkspaceDiagnostic => ({
  path: [], severity: 'error', code: 'c', message: 'm', ...over,
});

describe('diagnostic factory', () => {
  it('builds error diagnostics with and without a resource id', () => {
    expect(diagnostic(['a', 0], 'code-x', 'boom')).toEqual({
      path: ['a', 0], severity: 'error', code: 'code-x', message: 'boom',
    });
    expect(diagnostic([], 'code-x', 'boom', 'q1')).toEqual({
      path: [], severity: 'error', code: 'code-x', message: 'boom', resource: 'q1',
    });
  });
});

describe('numeric-aware path comparison', () => {
  it('compares numeric segments numerically, before string segments', () => {
    expect(comparePathSegments(2, 10)).toBeLessThan(0);
    expect(comparePathSegments(10, 2)).toBeGreaterThan(0);
    expect(comparePathSegments(2, 2)).toBe(0);
    expect(comparePathSegments('2', '10')).toBeLessThan(0); // digit strings are numeric
    expect(comparePathSegments(3, 'alpha')).toBeLessThan(0);
    expect(comparePathSegments('alpha', 3)).toBeGreaterThan(0);
    expect(comparePathSegments('alpha', 'beta')).toBeLessThan(0);
    expect(comparePathSegments('beta', 'alpha')).toBeGreaterThan(0);
    expect(comparePathSegments('alpha', 'alpha')).toBe(0);
  });

  it('compares full paths segment-wise with prefixes first', () => {
    expect(comparePaths(['tiles'], ['tiles', 0])).toBeLessThan(0);
    expect(comparePaths(['tiles', 2], ['tiles', 10])).toBeLessThan(0);
    expect(comparePaths(['tiles', 10], ['tiles', 2, 'id'])).toBeGreaterThan(0);
    expect(comparePaths([], [])).toBe(0);
  });
});

describe('deterministic diagnostic sorter', () => {
  it('orders by severity, numeric-aware path, code, resource id, then message', () => {
    const sorted = sortDiagnostics([
      d({ severity: 'information', message: 'info' }),
      d({ severity: 'warning', message: 'warn' }),
      d({ path: ['queries', 10], message: 'ten' }),
      d({ path: ['queries', 2], message: 'two' }),
      d({ path: ['queries', 2], code: 'a-code', message: 'two-a' }),
      d({ path: ['queries', 2], code: 'a-code', resource: 'r2', message: 'r2' }),
      d({ path: ['queries', 2], code: 'a-code', resource: 'r1', message: 'r1' }),
      d({ path: ['queries', 2], code: 'a-code', resource: 'r1', message: 'a-first' }),
      d({ severity: 'error', message: 'root' }),
    ]);
    expect(sorted.map((item) => item.message)).toEqual([
      'root', 'two-a', 'a-first', 'r1', 'r2', 'two', 'ten', 'warn', 'info',
    ]);
  });

  it('is deterministic for shuffled equivalent inputs and never mutates its input', () => {
    const items = [
      d({ path: ['b'] }), d({ path: [1] }), d({ path: ['a', 2] }), d({ path: ['a', '10'] }),
      d({ severity: 'warning' }), d({ severity: 'information' }),
    ];
    const reversed = [...items].reverse();
    expect(sortDiagnostics(items)).toEqual(sortDiagnostics(reversed));
    expect(sortDiagnostics(items).map((item) => item.path)).toEqual([
      [1], ['a', 2], ['a', '10'], ['b'], [], [],
    ]);
    expect(items[0].path).toEqual(['b']); // input untouched
  });

  it('breaks resource ties with a missing resource sorting first', () => {
    expect(compareDiagnostics(d({}), d({ resource: 'x' }))).toBeLessThan(0);
    expect(compareDiagnostics(d({ resource: 'x' }), d({}))).toBeGreaterThan(0);
  });
});
