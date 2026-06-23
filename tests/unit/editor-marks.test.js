import { describe, it, expect } from 'vitest';
import { buildMarkSegments } from '../../src/core/editor-marks.js';

describe('buildMarkSegments', () => {
  it('returns a single plain segment when there are no marks', () => {
    expect(buildMarkSegments('hello', [])).toEqual([{ text: 'hello', cls: null }]);
  });
  it('splits text around a single mark', () => {
    expect(buildMarkSegments('hello', [{ start: 1, end: 3, cls: 'match' }])).toEqual([
      { text: 'h', cls: null }, { text: 'el', cls: 'match' }, { text: 'lo', cls: null },
    ]);
  });
  it('needs no empty leading/trailing segment for a full-width mark', () => {
    expect(buildMarkSegments('ab', [{ start: 0, end: 2, cls: 'match' }])).toEqual([{ text: 'ab', cls: 'match' }]);
  });
  it('prioritizes active > match on overlap', () => {
    const segs = buildMarkSegments('abcd', [
      { start: 0, end: 3, cls: 'match' }, { start: 1, end: 2, cls: 'active' },
    ]);
    expect(segs.find((s) => s.text === 'a').cls).toBe('match');
    expect(segs.find((s) => s.text === 'b').cls).toBe('active');
    expect(segs.find((s) => s.text === 'c').cls).toBe('match');
    expect(segs.find((s) => s.text === 'd').cls).toBe(null);
  });
  it('falls back to the first cls (e.g. bracket) when neither active nor match', () => {
    expect(buildMarkSegments('()', [
      { start: 0, end: 1, cls: 'bracket' }, { start: 1, end: 2, cls: 'bracket' },
    ])).toEqual([{ text: '(', cls: 'bracket' }, { text: ')', cls: 'bracket' }]);
  });
  it('leaves the gap between separated marks unmarked', () => {
    expect(buildMarkSegments('a b c', [
      { start: 0, end: 1, cls: 'match' }, { start: 4, end: 5, cls: 'match' },
    ])).toContainEqual({ text: ' b ', cls: null });
  });
});
