import { describe, it, expect } from 'vitest';
import { scanSpans } from '../../src/core/sql-spans.js';

// Reconstruct the classified spans as `[kind, source]` pairs for easy assertion,
// and verify they tile the input exactly (contiguous, gap-free, cover-once).
function spans(text) {
  const list = [...scanSpans(text)];
  const s = String(text || '');
  let cursor = 0;
  for (const { start, end } of list) {
    expect(start).toBe(cursor); // contiguous, no gaps or overlaps
    expect(end).toBeGreaterThanOrEqual(start);
    cursor = end;
  }
  expect(cursor).toBe(s.length); // covers every character
  return list.map(({ kind, start, end }) => [kind, s.slice(start, end)]);
}

describe('scanSpans', () => {
  it('yields nothing for empty / nullish input', () => {
    expect(spans('')).toEqual([]);
    expect(spans(null)).toEqual([]);
    expect(spans(undefined)).toEqual([]);
  });

  it('treats plain SQL as a single code span', () => {
    expect(spans('SELECT 1')).toEqual([['code', 'SELECT 1']]);
  });

  it('separates a single-quoted literal from the surrounding code', () => {
    expect(spans("SELECT 'a;b' FROM t")).toEqual([
      ['code', 'SELECT '],
      ['string', "'a;b'"],
      ['code', ' FROM t'],
    ]);
  });

  it('handles a literal at the very start (no leading code span)', () => {
    expect(spans("'x' , 1")).toEqual([
      ['string', "'x'"],
      ['code', ' , 1'],
    ]);
  });

  it('recognizes double-quoted and backtick identifiers as string spans', () => {
    expect(spans('SELECT "c1", `c2`')).toEqual([
      ['code', 'SELECT '],
      ['string', '"c1"'],
      ['code', ', '],
      ['string', '`c2`'],
    ]);
  });

  it('honors backslash escapes inside a literal', () => {
    expect(spans("'it\\'s'")).toEqual([['string', "'it\\'s'"]]);
  });

  it('honors doubled-quote escapes inside a literal', () => {
    expect(spans("'it''s'")).toEqual([['string', "'it''s'"]]);
  });

  it('runs an unterminated literal to EOF', () => {
    expect(spans("SELECT 'oops")).toEqual([
      ['code', 'SELECT '],
      ['string', "'oops"],
    ]);
  });

  it('clamps a trailing backslash at EOF to the end of input', () => {
    expect(spans("'a\\")).toEqual([['string', "'a\\"]]);
  });

  it('captures -- line comments up to (but not including) the newline', () => {
    expect(spans('SELECT 1 -- note;here\n, 2')).toEqual([
      ['code', 'SELECT 1 '],
      ['comment', '-- note;here'],
      ['code', '\n, 2'],
    ]);
  });

  it('captures # line comments', () => {
    expect(spans('SELECT 1 # note\n, 2')).toEqual([
      ['code', 'SELECT 1 '],
      ['comment', '# note'],
      ['code', '\n, 2'],
    ]);
  });

  it('runs a line comment to EOF when there is no newline', () => {
    expect(spans('SELECT 1 -- trailing')).toEqual([
      ['code', 'SELECT 1 '],
      ['comment', '-- trailing'],
    ]);
  });

  it('captures a /* */ block comment including the closer', () => {
    expect(spans('SELECT /* a;b */ 1')).toEqual([
      ['code', 'SELECT '],
      ['comment', '/* a;b */'],
      ['code', ' 1'],
    ]);
  });

  it('runs an unterminated block comment to EOF', () => {
    expect(spans('SELECT /* oops')).toEqual([
      ['code', 'SELECT '],
      ['comment', '/* oops'],
    ]);
  });

  it('does not treat a lone - or / as a comment opener', () => {
    expect(spans('SELECT a - b / c')).toEqual([['code', 'SELECT a - b / c']]);
  });

  it('scans a mixed script into ordered code/comment/string spans', () => {
    expect(spans("-- h\nSELECT '{x}' /* c */ # z")).toEqual([
      ['comment', '-- h'],
      ['code', '\nSELECT '],
      ['string', "'{x}'"],
      ['code', ' '],
      ['comment', '/* c */'],
      ['code', ' '],
      ['comment', '# z'],
    ]);
  });
});
