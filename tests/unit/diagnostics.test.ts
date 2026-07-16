import { describe, expect, it } from 'vitest';
import { diagnostic } from '../../src/core/diagnostics.js';

describe('diagnostic factory (#236)', () => {
  it('builds the {severity, code, message} shape with no extra', () => {
    expect(diagnostic('error', 'x-code', 'Something failed.')).toEqual({
      severity: 'error', code: 'x-code', message: 'Something failed.',
    });
  });

  it('merges extra fields onto the diagnostic', () => {
    expect(diagnostic('warning', 'y-code', 'Heads up.', { helperName: 'origin', optionIndex: 3 })).toEqual({
      severity: 'warning', code: 'y-code', message: 'Heads up.', helperName: 'origin', optionIndex: 3,
    });
  });

  it('lets extra override nothing core but adds a path (Filter contract shape)', () => {
    expect(diagnostic('error', 'filter-sql-empty', 'Empty.', { path: ['dashboard', 'role'] })).toEqual({
      severity: 'error', code: 'filter-sql-empty', message: 'Empty.', path: ['dashboard', 'role'],
    });
  });
});
