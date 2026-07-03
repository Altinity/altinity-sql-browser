import { describe, it, expect } from 'vitest';
import { tokenize, SQL_KEYWORDS, SQL_FUNCS } from '../../src/core/sql-highlight.js';

const types = (sql) => tokenize(sql).map((t) => t[0]);
const text = (sql) => tokenize(sql).map((t) => t[1]).join('');

describe('tokenize', () => {
  it('round-trips the source text exactly', () => {
    const sql = "SELECT count(*) -- c\nFROM t WHERE x = 'a''b' /* blk */ LIMIT 10;";
    expect(text(sql)).toBe(sql);
  });
  it('classifies keywords, funcs, idents', () => {
    const toks = tokenize('SELECT count(x) FROM tbl');
    expect(toks).toContainEqual(['keyword', 'SELECT']);
    expect(toks).toContainEqual(['func', 'count']);
    expect(toks).toContainEqual(['ident', 'x']);
    expect(toks).toContainEqual(['ident', 'tbl']);
  });
  it('line comments run to newline', () => {
    expect(tokenize('-- hi\nSELECT')).toContainEqual(['comment', '-- hi']);
  });
  it('block comments span to */ (and to EOF when unterminated)', () => {
    expect(tokenize('/* a */x')).toContainEqual(['comment', '/* a */']);
    expect(tokenize('/* unterminated')).toContainEqual(['comment', '/* unterminated']);
  });
  it('handles single, double and backtick strings', () => {
    expect(tokenize("'s'")).toContainEqual(['string', "'s'"]);
    expect(tokenize('"d"')).toContainEqual(['string', '"d"']);
    expect(tokenize('`id`')).toContainEqual(['ident', '`id`']);
  });
  it('handles escaped quote inside a string', () => {
    expect(tokenize("'a\\'b'")).toContainEqual(['string', "'a\\'b'"]);
  });
  it('unterminated string runs to EOF', () => {
    expect(tokenize("'abc")).toContainEqual(['string', "'abc"]);
  });
  it('parses numbers incl. scientific, stops at trailing sign', () => {
    expect(tokenize('1.5e3')).toContainEqual(['number', '1.5e3']);
    // `1-2` => number 1, op -, number 2 (sign not consumed without an exponent)
    expect(types('1-2')).toEqual(['number', 'op', 'number']);
  });
  it('emits operators and whitespace', () => {
    expect(tokenize('a = b')).toEqual([
      ['ident', 'a'], ['ws', ' '], ['op', '='], ['ws', ' '], ['ident', 'b'],
    ]);
  });
  it('emits "other" for unknown single chars', () => {
    expect(tokenize('@')).toEqual([['other', '@']]);
  });
  it('accepts dynamic keyword/func sets, overriding the built-ins (#25)', () => {
    const keywords = new Set(['FOO']);
    const funcs = new Set(['bar']);
    const toks = tokenize('FOO bar SELECT count', { keywords, funcs });
    expect(toks).toContainEqual(['keyword', 'FOO']); // keyword match is case-insensitive
    expect(toks).toContainEqual(['func', 'bar']);
    // built-ins no longer classify once overridden
    expect(toks).toContainEqual(['ident', 'SELECT']);
    expect(toks).toContainEqual(['ident', 'count']);
  });
});

describe('keyword/func sets', () => {
  it('expose the expected members', () => {
    expect(SQL_KEYWORDS.has('SELECT')).toBe(true);
    expect(SQL_FUNCS.has('count')).toBe(true);
  });
});
