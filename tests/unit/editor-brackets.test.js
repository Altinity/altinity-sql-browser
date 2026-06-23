import { describe, it, expect } from 'vitest';
import { matchBracketAt, bracketEdit } from '../../src/core/editor-brackets.js';

describe('matchBracketAt', () => {
  it('matches forward from an opener at the caret', () => {
    expect(matchBracketAt('(a)', 0)).toEqual([0, 2]);
  });
  it('matches backward from a closer just before the caret', () => {
    expect(matchBracketAt('(a)', 3)).toEqual([0, 2]);
  });
  it('handles nesting', () => {
    expect(matchBracketAt('(())', 0)).toEqual([0, 3]);
  });
  it('matches braces too (matching spans {} even though auto-close does not)', () => {
    expect(matchBracketAt('{x}', 0)).toEqual([0, 2]);
  });
  it('returns null for an unbalanced opener (and caret 0 has nothing behind it)', () => {
    expect(matchBracketAt('((', 0)).toBeNull();
  });
  it('returns null for an unbalanced closer behind the caret', () => {
    expect(matchBracketAt('a)', 2)).toBeNull();
  });
  it('returns null when the caret is not adjacent to a bracket', () => {
    expect(matchBracketAt('abc', 1)).toBeNull();
  });
});

describe('bracketEdit', () => {
  it('auto-closes an opener with the caret inside', () => {
    expect(bracketEdit('', 0, 0, '(')).toEqual({ value: '()', selStart: 1, selEnd: 1 });
  });
  it('wraps a selection with an opener', () => {
    expect(bracketEdit('abc', 0, 3, '[')).toEqual({ value: '[abc]', selStart: 1, selEnd: 4 });
  });
  it('auto-closes a quote', () => {
    expect(bracketEdit('', 0, 0, "'")).toEqual({ value: "''", selStart: 1, selEnd: 1 });
  });
  it('wraps a selection with a quote', () => {
    expect(bracketEdit('abc', 0, 3, '"')).toEqual({ value: '"abc"', selStart: 1, selEnd: 4 });
  });
  it('types over an existing quote instead of inserting', () => {
    expect(bracketEdit("''", 1, 1, "'")).toEqual({ value: "''", selStart: 2, selEnd: 2 });
  });
  it('types over an existing closer', () => {
    expect(bracketEdit('()', 1, 1, ')')).toEqual({ value: '()', selStart: 2, selEnd: 2 });
  });
  it('returns null for a closer with no matching char ahead', () => {
    expect(bracketEdit('ab', 1, 1, ')')).toBeNull();
  });
  it('Backspace removes both halves of an empty bracket pair', () => {
    expect(bracketEdit('()', 1, 1, 'Backspace')).toEqual({ value: '', selStart: 0, selEnd: 0 });
  });
  it('Backspace removes both halves of an empty quote pair', () => {
    expect(bracketEdit("x''y", 2, 2, 'Backspace')).toEqual({ value: 'xy', selStart: 1, selEnd: 1 });
  });
  it('Backspace not inside a pair → null', () => {
    expect(bracketEdit('ab', 1, 1, 'Backspace')).toBeNull();
    expect(bracketEdit('()', 0, 0, 'Backspace')).toBeNull(); // s = 0 guard
    expect(bracketEdit('()', 0, 2, 'Backspace')).toBeNull(); // selection, not collapsed
  });
  it('{ is excluded from auto-close (Phase 1b), and ordinary keys are no-ops', () => {
    expect(bracketEdit('', 0, 0, '{')).toBeNull();
    expect(bracketEdit('ab', 1, 1, 'x')).toBeNull();
    expect(bracketEdit('ab', 1, 1, 'Tab')).toBeNull();
  });
});
