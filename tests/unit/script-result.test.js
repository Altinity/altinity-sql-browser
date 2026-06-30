import { describe, it, expect } from 'vitest';
import { parseSelectResult, firstRowPreview } from '../../src/core/script-result.js';

describe('parseSelectResult', () => {
  it('parses a JSONCompact body into columns + rows', () => {
    const body = JSON.stringify({
      meta: [{ name: 'count()', type: 'UInt64' }],
      data: [['42']],
    });
    expect(parseSelectResult(body)).toEqual({
      columns: [{ name: 'count()', type: 'UInt64' }],
      rows: [['42']],
      truncated: false,
    });
  });

  it('returns an empty result for a blank / nullish body', () => {
    for (const v of ['', '   ', null, undefined]) {
      expect(parseSelectResult(v)).toEqual({ columns: [], rows: [], truncated: false });
    }
  });

  it('returns an empty result for a non-JSON body', () => {
    expect(parseSelectResult('not json')).toEqual({ columns: [], rows: [], truncated: false });
  });

  it('tolerates a body missing meta / data', () => {
    expect(parseSelectResult('{}')).toEqual({ columns: [], rows: [], truncated: false });
  });

  it('caps rows and flags truncation', () => {
    const data = Array.from({ length: 105 }, (_, i) => [String(i)]);
    const out = parseSelectResult(JSON.stringify({ meta: [{ name: 'n', type: 'Int' }], data }), 100);
    expect(out.rows).toHaveLength(100);
    expect(out.truncated).toBe(true);
  });

  it('does not flag truncation at exactly the cap', () => {
    const data = Array.from({ length: 100 }, (_, i) => [String(i)]);
    const out = parseSelectResult(JSON.stringify({ meta: [{ name: 'n', type: 'Int' }], data }), 100);
    expect(out.rows).toHaveLength(100);
    expect(out.truncated).toBe(false);
  });
});

describe('firstRowPreview', () => {
  it('joins the first row with commas', () => {
    expect(firstRowPreview([['42']])).toBe('42');
    expect(firstRowPreview([['a', '1', 'x'], ['b']])).toBe('a, 1, x');
  });
  it('renders NULLs as empty', () => {
    expect(firstRowPreview([['a', null, 'c']])).toBe('a, , c');
  });
  it('returns "" with no rows', () => {
    expect(firstRowPreview([])).toBe('');
    expect(firstRowPreview(null)).toBe('');
  });
  it('truncates past max with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const out = firstRowPreview([[long]], 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith('…')).toBe(true);
  });
});
