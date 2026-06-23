import { describe, it, expect } from 'vitest';
import { caretLineCol, caretXY } from '../../src/core/editor-geometry.js';

describe('caretLineCol', () => {
  it('computes line/col on the first line', () => {
    expect(caretLineCol('select a', 3)).toEqual({ line: 0, col: 3 });
  });
  it('computes line/col after newlines', () => {
    expect(caretLineCol('ab\ncd\nef', 7)).toEqual({ line: 2, col: 1 });
  });
});

describe('caretXY', () => {
  const m = { charWidth: 8, lhPx: 22, padX: 14, padY: 12, scrollTop: 0, scrollLeft: 0 };
  it('offsets by padding + column/line', () => {
    expect(caretXY('abcd', 2, m)).toEqual({ x: 14 + 2 * 8, y: 12 });
  });
  it('subtracts scroll when present', () => {
    expect(caretXY('a\nb', 3, { ...m, scrollTop: 5, scrollLeft: 3 }))
      .toEqual({ x: 14 + 8 - 3, y: 12 + 22 - 5 });
  });
  it('treats missing scroll as 0', () => {
    expect(caretXY('ab', 1, { charWidth: 8, lhPx: 22, padX: 14, padY: 12 }))
      .toEqual({ x: 22, y: 12 });
  });
});
