import { describe, it, expect } from 'vitest';
import { sortRows } from '../../src/core/sort.js';

describe('sortRows', () => {
  const rows = [['b', '2'], ['a', '10'], ['c', '1']];

  it('returns the input untouched when col is null', () => {
    expect(sortRows(rows, null)).toBe(rows);
  });
  it('sorts numerically when both cells are numbers', () => {
    expect(sortRows(rows, 1, 'asc').map((r) => r[1])).toEqual(['1', '2', '10']);
    expect(sortRows(rows, 1, 'desc').map((r) => r[1])).toEqual(['10', '2', '1']);
  });
  it('sorts lexicographically for non-numeric cells', () => {
    expect(sortRows(rows, 0, 'asc').map((r) => r[0])).toEqual(['a', 'b', 'c']);
    expect(sortRows(rows, 0, 'desc').map((r) => r[0])).toEqual(['c', 'b', 'a']);
  });
  it('defaults dir to asc', () => {
    expect(sortRows(rows, 0).map((r) => r[0])).toEqual(['a', 'b', 'c']);
  });
  it('does not mutate the input', () => {
    const copy = JSON.parse(JSON.stringify(rows));
    sortRows(rows, 1, 'desc');
    expect(rows).toEqual(copy);
  });
  it('numeric pairs compare as numbers even with a non-numeric present', () => {
    const mixed = [['10'], ['9'], ['x']];
    // '9' < '10' numerically; 'x' is non-numeric and sorts after.
    expect(sortRows(mixed, 0, 'asc').map((r) => r[0])).toEqual(['9', '10', 'x']);
  });
});
