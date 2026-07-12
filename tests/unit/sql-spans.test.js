import { describe, it, expect } from 'vitest';
import { scanSpans } from '../../src/core/sql-spans.js';

// Reconstruct the classified spans as `[kind, source]` pairs for easy assertion,
// and verify they tile the input exactly (contiguous, gap-free, cover-once) and
// that every span carries a boolean `closed`.
function spans(text) {
  const list = [...scanSpans(text)];
  const s = String(text || '');
  let cursor = 0;
  for (const { start, end, closed } of list) {
    expect(start).toBe(cursor); // contiguous, no gaps or overlaps
    expect(end).toBeGreaterThan(start); // no zero-length spans
    expect(typeof closed).toBe('boolean');
    cursor = end;
  }
  expect(cursor).toBe(s.length); // covers every character
  return list.map(({ kind, start, end }) => [kind, s.slice(start, end)]);
}

// The raw spans with their `closed` flags, for the recovery-policy assertions.
const raw = (text) => [...scanSpans(text)].map(({ kind, closed }) => [kind, closed]);

describe('scanSpans', () => {
  it('yields nothing for empty / nullish input', () => {
    expect(spans('')).toEqual([]);
    expect(spans(null)).toEqual([]);
    expect(spans(undefined)).toEqual([]);
  });

  it('treats plain SQL as a single closed code span', () => {
    expect(spans('SELECT 1')).toEqual([['code', 'SELECT 1']]);
    expect(raw('SELECT 1')).toEqual([['code', true]]);
  });

  describe('single-quoted strings', () => {
    it('separates a literal from surrounding code', () => {
      expect(spans("SELECT 'a;b' FROM t")).toEqual([
        ['code', 'SELECT '],
        ['string', "'a;b'"],
        ['code', ' FROM t'],
      ]);
    });

    it('handles a literal at the very start (no leading code span)', () => {
      expect(spans("'x' , 1")).toEqual([['string', "'x'"], ['code', ' , 1']]);
    });

    it('honors backslash and doubled-quote escapes', () => {
      expect(spans("'it\\'s'")).toEqual([['string', "'it\\'s'"]]);
      expect(spans("'it''s'")).toEqual([['string', "'it''s'"]]);
    });

    it('runs an unterminated literal to EOF with closed:false', () => {
      expect(spans("SELECT 'oops")).toEqual([['code', 'SELECT '], ['string', "'oops"]]);
      expect(raw("SELECT 'oops")).toEqual([['code', true], ['string', false]]);
    });

    it('clamps a trailing backslash at EOF to the end of input', () => {
      expect(spans("'a\\")).toEqual([['string', "'a\\"]]);
      expect(raw("'a\\")).toEqual([['string', false]]);
    });
  });

  describe('quoted identifiers', () => {
    it('classifies double-quoted and backtick identifiers as quoted-ident', () => {
      expect(spans('SELECT "c1", `c2`')).toEqual([
        ['code', 'SELECT '],
        ['quoted-ident', '"c1"'],
        ['code', ', '],
        ['quoted-ident', '`c2`'],
      ]);
    });

    it('honors backslash and doubled-delimiter escapes for both delimiters', () => {
      expect(spans('`a``b`')).toEqual([['quoted-ident', '`a``b`']]);
      expect(spans('`a\\`b`')).toEqual([['quoted-ident', '`a\\`b`']]);
      expect(spans('"a""b"')).toEqual([['quoted-ident', '"a""b"']]);
      expect(spans('"a\\"b"')).toEqual([['quoted-ident', '"a\\"b"']]);
    });

    it('runs an unterminated quoted identifier to EOF with closed:false', () => {
      expect(raw('`open')).toEqual([['quoted-ident', false]]);
      expect(raw('"open')).toEqual([['quoted-ident', false]]);
    });
  });

  describe('line comments', () => {
    it('captures -- comments up to (not including) the newline', () => {
      expect(spans('SELECT 1 -- note;here\n, 2')).toEqual([
        ['code', 'SELECT 1 '],
        ['comment', '-- note;here'],
        ['code', '\n, 2'],
      ]);
    });

    it('captures // comments with no following-char restriction, incl glued 6//2', () => {
      expect(spans('SELECT 6//2\n, 3')).toEqual([
        ['code', 'SELECT 6'],
        ['comment', '//2'],
        ['code', '\n, 3'],
      ]);
      expect(spans('a ////x')).toEqual([['code', 'a '], ['comment', '////x']]);
    });

    it('opens # only before ASCII space or !', () => {
      expect(spans('SELECT 1 # note\n, 2')).toEqual([
        ['code', 'SELECT 1 '],
        ['comment', '# note'],
        ['code', '\n, 2'],
      ]);
      expect(spans('SELECT 1 #! bang')).toEqual([['code', 'SELECT 1 '], ['comment', '#! bang']]);
    });

    it('does NOT open # before a word char, tab, another #, or at EOF', () => {
      expect(spans('SELECT 1 #x')).toEqual([['code', 'SELECT 1 #x']]);
      expect(spans('SELECT 1 #')).toEqual([['code', 'SELECT 1 #']]);
      expect(spans('SELECT 1 #\tx')).toEqual([['code', 'SELECT 1 #\tx']]);
      expect(spans('SELECT 1 ##x')).toEqual([['code', 'SELECT 1 ##x']]);
    });

    it('keeps a CRLF carriage return inside the comment', () => {
      expect(spans('-- a\r\nx')).toEqual([['comment', '-- a\r'], ['code', '\nx']]);
    });

    it('runs a line comment to EOF (still closed) when there is no newline', () => {
      expect(spans('SELECT 1 -- trailing')).toEqual([['code', 'SELECT 1 '], ['comment', '-- trailing']]);
      expect(raw('-- x')).toEqual([['comment', true]]);
    });

    it('does not treat a lone - or / as a comment opener', () => {
      expect(spans('SELECT a - b / c')).toEqual([['code', 'SELECT a - b / c']]);
    });
  });

  describe('block comments', () => {
    it('captures a /* */ block comment including the closer', () => {
      expect(spans('SELECT /* a;b */ 1')).toEqual([
        ['code', 'SELECT '],
        ['comment', '/* a;b */'],
        ['code', ' 1'],
      ]);
    });

    it('nests: an inner /* */ does not close the outer comment', () => {
      expect(spans('a /* x /* y */ z */ b')).toEqual([
        ['code', 'a '],
        ['comment', '/* x /* y */ z */'],
        ['code', ' b'],
      ]);
      expect(raw('a /* x /* y */ z */ b')).toEqual([['code', true], ['comment', true], ['code', true]]);
    });

    it('runs an unterminated (or under-closed nested) block comment to EOF with closed:false', () => {
      expect(spans('SELECT /* oops')).toEqual([['code', 'SELECT '], ['comment', '/* oops']]);
      expect(raw('SELECT /* oops')).toEqual([['code', true], ['comment', false]]);
      expect(raw('/* a /* b */')).toEqual([['comment', false]]); // depth returns to 1, not 0
    });
  });

  describe('heredocs', () => {
    it('treats $$…$$ and $tag$…$tag$ as opaque string spans', () => {
      expect(spans('SELECT $$a;b$$ x')).toEqual([
        ['code', 'SELECT '],
        ['string', '$$a;b$$'],
        ['code', ' x'],
      ]);
      expect(spans('$tag$ any;/*x*/ $tag$')).toEqual([['string', '$tag$ any;/*x*/ $tag$']]);
    });

    it('accepts digit-leading and underscore tags', () => {
      expect(spans('$1$a$1$')).toEqual([['string', '$1$a$1$']]);
      expect(spans('$_x$a$_x$')).toEqual([['string', '$_x$a$_x$']]);
    });

    it('closes only on the exact opening tag', () => {
      expect(spans('SELECT $tag$a $notthetag$ b$tag$')).toEqual([
        ['code', 'SELECT '],
        ['string', '$tag$a $notthetag$ b$tag$'],
      ]);
    });

    it('falls through to code for a non-word (punctuation) tag, not consuming to EOF', () => {
      expect(spans('SELECT $ta-g$x')).toEqual([['code', 'SELECT $ta-g$x']]);
    });

    it('opens only when the $ starts a token', () => {
      expect(spans('$tag$x$tag$')).toEqual([['string', '$tag$x$tag$']]); // heredoc
      expect(spans('foo$tag$x$tag$')).toEqual([['code', 'foo$tag$x$tag$']]); // bare word, no embedded heredoc
      expect(spans('foo$bar')).toEqual([['code', 'foo$bar']]); // bare word with $
    });

    it('opens a heredoc right after an opaque span (token boundary reset)', () => {
      expect(spans("'x'$t$a$t$")).toEqual([['string', "'x'"], ['string', '$t$a$t$']]);
    });

    it('runs a valid opener with no closer to EOF with closed:false (recovery policy)', () => {
      expect(raw('$tag$abc')).toEqual([['string', false]]);
      // The documented $foo$bar recovery collision: the client treats it as an
      // open heredoc even though the server may lex it as a bare identifier.
      expect(spans('$foo$bar')).toEqual([['string', '$foo$bar']]);
      expect(raw('$foo$bar')).toEqual([['string', false]]);
    });
  });

  it('scans a mixed script into ordered spans', () => {
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
