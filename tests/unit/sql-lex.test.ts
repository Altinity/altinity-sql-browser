import { describe, it, expect } from 'vitest';
import { lexSql, tokenText, isWord, decodeQuotedIdent, unquoteIdent } from '../../src/core/sql-lex.js';

// [kind, text] view + structural invariants: no whitespace tokens, every
// non-whitespace char covered exactly once, gaps are whitespace only.
function lex(sql?: string | null): [string, string][] {
  const toks = lexSql(sql);
  const s = String(sql || '');
  let cursor = 0;
  for (const t of toks) {
    expect(t.end).toBeGreaterThan(t.start);
    expect(typeof t.closed).toBe('boolean');
    // the gap before this token is whitespace only
    expect(s.slice(cursor, t.start)).toMatch(/^\s*$/);
    cursor = t.end;
  }
  expect(s.slice(cursor)).toMatch(/^\s*$/); // trailing gap is whitespace only
  return toks.map((t): [string, string] => [t.kind, s.slice(t.start, t.end)]);
}

describe('lexSql', () => {
  it('returns [] for empty / nullish input', () => {
    expect(lexSql('')).toEqual([]);
    expect(lexSql(null)).toEqual([]);
    expect(lexSql(undefined)).toEqual([]);
  });

  it('emits direct offsets (start/end), no whitespace tokens', () => {
    const toks = lexSql('  a   b ');
    expect(toks).toEqual([
      { kind: 'word', start: 2, end: 3, closed: true },
      { kind: 'word', start: 6, end: 7, closed: true },
    ]);
  });

  it('splits punctuation and single-character operators', () => {
    expect(lex('a.b, c(d); e = f')).toEqual([
      ['word', 'a'], ['punct', '.'], ['word', 'b'], ['punct', ','],
      ['word', 'c'], ['punct', '('], ['word', 'd'], ['punct', ')'], ['punct', ';'],
      ['word', 'e'], ['op', '='], ['word', 'f'],
    ]);
  });

  it('keeps multi-char comparisons as adjacent single-char op tokens', () => {
    expect(lex('a != b <= c >= d')).toEqual([
      ['word', 'a'], ['op', '!'], ['op', '='], ['word', 'b'],
      ['op', '<'], ['op', '='], ['word', 'c'],
      ['op', '>'], ['op', '='], ['word', 'd'],
    ]);
  });

  it('lexes a bare word containing $ as one word (no heredoc opened)', () => {
    expect(lex('SELECT foo$bar FROM t')).toEqual([
      ['word', 'SELECT'], ['word', 'foo$bar'], ['word', 'FROM'], ['word', 't'],
    ]);
  });

  it('lexes shallow decimal / scientific numbers', () => {
    expect(lex('1 3.14 1e-9 2E+3')).toEqual([
      ['number', '1'], ['number', '3.14'], ['number', '1e-9'], ['number', '2E+3'],
    ]);
    // a `+`/`-` not after an exponent is a separate operator
    expect(lex('2+3')).toEqual([['number', '2'], ['op', '+'], ['number', '3']]);
  });

  it('maps each non-code span to exactly one token, carrying closed', () => {
    expect(lexSql("'s' `q` \"d\" -- c")).toEqual([
      { kind: 'string', start: 0, end: 3, closed: true },
      { kind: 'quoted-ident', start: 4, end: 7, closed: true },
      { kind: 'quoted-ident', start: 8, end: 11, closed: true },
      { kind: 'comment', start: 12, end: 16, closed: true },
    ]);
    expect(lexSql("'open")).toEqual([{ kind: 'string', start: 0, end: 5, closed: false }]);
    expect(lexSql('`open')).toEqual([{ kind: 'quoted-ident', start: 0, end: 5, closed: false }]);
  });

  it('falls back to `other` for characters outside word/number/punct/op', () => {
    expect(lex('a @ [1]')).toEqual([
      ['word', 'a'], ['other', '@'], ['other', '['], ['number', '1'], ['other', ']'],
    ]);
  });

  it('does not classify keywords or functions — every bare word is `word`', () => {
    expect(lexSql('SELECT count').every((t) => (t.kind as string) !== 'keyword' && (t.kind as string) !== 'func')).toBe(true);
    expect(lex('SELECT count')).toEqual([['word', 'SELECT'], ['word', 'count']]);
  });
});

describe('tokenText / isWord', () => {
  const sql = 'SELECT x';
  const toks = lexSql(sql);
  it('tokenText slices the token source', () => {
    expect(tokenText(sql, toks[0])).toBe('SELECT');
    expect(tokenText(sql, toks[1])).toBe('x');
  });
  it('isWord compares a `word` token case-insensitively', () => {
    expect(isWord(sql, toks[0], 'select')).toBe(true);
    expect(isWord(sql, toks[0], 'FROM')).toBe(false);
    expect(isWord(sql, null, 'select')).toBe(false);
    const [op] = lexSql('=');
    expect(isWord('=', op, '=')).toBe(false); // not a `word` token
  });
});

describe('decodeQuotedIdent', () => {
  it('passes a bare identifier through unchanged', () => {
    expect(decodeQuotedIdent('foo')).toBe('foo');
  });
  it('decodes doubled and backslash escapes for both delimiters', () => {
    expect(decodeQuotedIdent('`my``col`')).toBe('my`col');
    expect(decodeQuotedIdent('`my\\`col`')).toBe('my`col');
    expect(decodeQuotedIdent('"my""col"')).toBe('my"col');
    expect(decodeQuotedIdent('"my\\"col"')).toBe('my"col');
  });
  it('never drops the final content char of an unterminated identifier', () => {
    expect(decodeQuotedIdent('`open', false)).toBe('open');
    // closed:true but the raw does not actually end with the delimiter (rule 3)
    expect(decodeQuotedIdent('`abc', true)).toBe('abc');
  });
});

describe('unquoteIdent', () => {
  it('decodes a quoted-ident token honoring its closed flag', () => {
    const sql = 'SELECT `a``b`';
    const toks = lexSql(sql);
    expect(unquoteIdent(sql, toks[1])).toBe('a`b');
  });
  it('returns a bare word token verbatim', () => {
    const sql = 'events';
    const toks = lexSql(sql);
    expect(unquoteIdent(sql, toks[0])).toBe('events');
  });
  it('decodes an unterminated quoted-ident token to its content', () => {
    const sql = '`open';
    const toks = lexSql(sql);
    expect(unquoteIdent(sql, toks[0])).toBe('open');
  });
});
