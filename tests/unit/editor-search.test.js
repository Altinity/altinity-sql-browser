import { describe, it, expect } from 'vitest';
import { findMatches, validRegex } from '../../src/core/editor-search.js';

describe('findMatches', () => {
  it('returns [] for an empty query', () => {
    expect(findMatches('abc', '')).toEqual([]);
  });
  it('finds plain matches, case-insensitive by default', () => {
    expect(findMatches('aAbA', 'a')).toEqual([
      { start: 0, end: 1 }, { start: 1, end: 2 }, { start: 3, end: 4 },
    ]);
  });
  it('honors caseSensitive', () => {
    expect(findMatches('aA', 'a', { caseSensitive: true })).toEqual([{ start: 0, end: 1 }]);
  });
  it('escapes regex metacharacters in plain mode', () => {
    expect(findMatches('a.b a.b', 'a.b')).toHaveLength(2);
    expect(findMatches('axb', 'a.b')).toEqual([]); // '.' is a literal dot
  });
  it('wholeWord fences with boundaries', () => {
    expect(findMatches('cat category', 'cat', { wholeWord: true })).toEqual([{ start: 0, end: 3 }]);
  });
  it('regex mode compiles the pattern', () => {
    expect(findMatches('a1b2', '\\d', { regex: true })).toEqual([{ start: 1, end: 2 }, { start: 3, end: 4 }]);
  });
  it('regex mode honors caseSensitive', () => {
    expect(findMatches('aA', 'a', { regex: true, caseSensitive: true })).toEqual([{ start: 0, end: 1 }]);
  });
  it('an invalid regex yields []', () => {
    expect(findMatches('abc', '(', { regex: true })).toEqual([]);
  });
  it('advances past zero-width matches instead of looping forever', () => {
    const m = findMatches('ab', 'x*', { regex: true });
    expect(m.length).toBeGreaterThan(0);
    expect(m.every((r) => r.start === r.end)).toBe(true);
  });
  it('caps the match count to guard the keystroke path', () => {
    expect(findMatches('a'.repeat(20000), 'a').length).toBe(10001);
  });
});

describe('validRegex', () => {
  it('is true when not in regex mode (even for a bad pattern)', () => {
    expect(validRegex('(', false)).toBe(true);
  });
  it('is true for an empty query', () => {
    expect(validRegex('', true)).toBe(true);
  });
  it('is true for a valid pattern, false for an invalid one', () => {
    expect(validRegex('a+', true)).toBe(true);
    expect(validRegex('(', true)).toBe(false);
  });
});
