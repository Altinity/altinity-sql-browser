import { describe, it, expect } from 'vitest';
import { buildMarkSegments } from '../../src/core/editor-marks.js';

// Contract: marks are sorted by start and non-overlapping (search matches come
// back ordered + disjoint; the bracket pair is two sorted width-1 ranges and is
// never mixed with search marks).
describe('buildMarkSegments', () => {
  it('returns a single plain segment when there are no marks', () => {
    expect(buildMarkSegments('hello', [])).toEqual([{ text: 'hello', cls: null }]);
  });
  it('handles empty text with no marks', () => {
    expect(buildMarkSegments('', [])).toEqual([{ text: '', cls: null }]);
  });
  it('splits text around a single mark, with a trailing plain segment', () => {
    expect(buildMarkSegments('hello', [{ start: 1, end: 3, cls: 'match' }])).toEqual([
      { text: 'h', cls: null }, { text: 'el', cls: 'match' }, { text: 'lo', cls: null },
    ]);
  });
  it('emits no empty trailing segment for a mark that reaches the end', () => {
    expect(buildMarkSegments('ab', [{ start: 0, end: 2, cls: 'match' }])).toEqual([{ text: 'ab', cls: 'match' }]);
  });
  it('keeps the gap between separated marks unmarked', () => {
    expect(buildMarkSegments('a b c', [
      { start: 0, end: 1, cls: 'match' }, { start: 4, end: 5, cls: 'match' },
    ])).toEqual([
      { text: 'a', cls: 'match' }, { text: ' b ', cls: null }, { text: 'c', cls: 'match' },
    ]);
  });
  it('renders an adjacent (touching) pair with no gap segment, e.g. ()', () => {
    expect(buildMarkSegments('()', [
      { start: 0, end: 1, cls: 'bracket' }, { start: 1, end: 2, cls: 'bracket' },
    ])).toEqual([{ text: '(', cls: 'bracket' }, { text: ')', cls: 'bracket' }]);
  });
});
