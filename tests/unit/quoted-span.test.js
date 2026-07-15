import { describe, expect, it } from 'vitest';
import { scanDelimited } from '../../src/core/quoted-span.js';
import { scanSpans } from '../../src/core/sql-spans.js';

// Construct fixtures programmatically so JS source escaping never obscures
// the actual character sequence under test (issue #241's own suggestion).
const quoted = (quote, slashCount, suffix = '') =>
  quote + 'a' + '\\'.repeat(slashCount) + quote + suffix;

describe('scanDelimited — backslash-run regression matrix', () => {
  // | backslash count | required interpretation                       |
  // |---:|---|
  // | 0 | delimiter closes                                            |
  // | 1 | delimiter is escaped                                        |
  // | 2 | one literal backslash; delimiter closes                     |
  // | 3 | one literal backslash plus escaped delimiter                |
  // | 4 | two literal backslashes; delimiter closes                   |
  for (const quote of ["'", '`', '"']) {
    describe(`delimiter ${JSON.stringify(quote)}`, () => {
      it('0 backslashes: the delimiter closes immediately', () => {
        const text = quoted(quote, 0);
        const r = scanDelimited(text, 0, quote);
        expect(r).toEqual({ end: text.length, closed: true });
      });

      it('1 backslash: the delimiter is escaped, scanning continues past it', () => {
        // No later terminator at all → unclosed, runs to end of text.
        const text = quoted(quote, 1);
        const r = scanDelimited(text, 0, quote);
        expect(r).toEqual({ end: text.length, closed: false });
      });

      it('1 backslash with a later real terminator: closes there, not at the escaped one', () => {
        const text = quoted(quote, 1, quote); // e.g. 'a\'' -> the trailing quote closes it
        const r = scanDelimited(text, 0, quote);
        expect(r).toEqual({ end: text.length, closed: true });
        expect(text.slice(0, r.end)).toBe(text);
      });

      it('2 backslashes: one literal backslash; the delimiter closes', () => {
        const text = quoted(quote, 2);
        const r = scanDelimited(text, 0, quote);
        expect(r).toEqual({ end: text.length, closed: true });
      });

      it('3 backslashes: one literal backslash plus an escaped delimiter, unclosed with no later terminator', () => {
        const text = quoted(quote, 3);
        const r = scanDelimited(text, 0, quote);
        expect(r).toEqual({ end: text.length, closed: false });
      });

      it('4 backslashes: two literal backslashes; the delimiter closes', () => {
        const text = quoted(quote, 4);
        const r = scanDelimited(text, 0, quote);
        expect(r).toEqual({ end: text.length, closed: true });
      });

      it('structural text after the token is preserved (not absorbed)', () => {
        const text = quoted(quote, 2, ' = 1, next');
        const r = scanDelimited(text, 0, quote);
        expect(r.closed).toBe(true);
        expect(text.slice(r.end)).toBe(' = 1, next');
      });

      it('a doubled delimiter is content, not a terminator', () => {
        const text = `${quote}a${quote}${quote}b${quote}`; // e.g. 'a''b'
        const r = scanDelimited(text, 0, quote);
        expect(r).toEqual({ end: text.length, closed: true });
      });

      it('unterminated (no closing delimiter at all)', () => {
        const text = `${quote}abc`;
        const r = scanDelimited(text, 0, quote);
        expect(r).toEqual({ end: text.length, closed: false });
      });
    });
  }

  it('token offsets and raw source text remain exact for a span starting mid-string', () => {
    const text = `prefix 'a\\\\' suffix`;
    const start = text.indexOf("'");
    const r = scanDelimited(text, start, "'");
    expect(r.closed).toBe(true);
    expect(text.slice(start, r.end)).toBe("'a\\\\'");
    expect(text.slice(r.end)).toBe(' suffix');
  });
});

describe('scanDelimited — shared-scanner consistency with scanSpans', () => {
  // Both sql-spans.js and clickhouse-type.js delegate to this one primitive;
  // this guards against either one drifting onto an independent
  // implementation in the future. For a fixture whose ENTIRE text is one
  // quoted span, scanSpans (SQL lexical spans) and a direct scanDelimited
  // call must agree exactly on closing offset, `closed`, and raw text.
  const fixtures = [
    ["'a\\\\'", "'"],   // even backslash run, single quote
    ["'a\\'b'", "'"],   // odd backslash run then a later real closer
    ["'a''b'", "'"],    // doubled delimiter
    ['`a\\\\`', '`'],   // even backslash run, backtick
    ['`a``b`', '`'],    // doubled backtick
    ['"a\\\\"', '"'],   // even backslash run, double quote
    ['"a""b"', '"'],    // doubled double-quote
    ["'unterminated", "'"],
  ];
  for (const [text, quote] of fixtures) {
    it(`agrees for ${JSON.stringify(text)}`, () => {
      const direct = scanDelimited(text, 0, quote);
      const spans = [...scanSpans(text)];
      const span = spans[0];
      expect(span.start).toBe(0);
      expect(span.end).toBe(direct.end);
      expect(span.closed).toBe(direct.closed);
      expect(text.slice(span.start, span.end)).toBe(text.slice(0, direct.end));
    });
  }
});
