// Structural lexer for ClickHouse SQL text (#182), layered on top of the
// canonical boundary scanner (sql-spans.js). It turns a SQL string into a flat
// array of offset-bearing tokens for the structural consumers — completion
// (completions.js), FROM/JOIN scope analysis (from-scope.js), and
// parameter-comparison inference (param-comparison.js).
//
// This is NOT a full ClickHouse parser and holds no keyword/function catalog:
// bare words are all `word`, and consumers compare contextually with isWord().
// Code spans are classified only as far as those structural consumers require;
// numeric edge cases and full operator grammar are intentionally out of scope.
//
// Contract:
//   - there are NO whitespace tokens; whitespace is the gap between tokens;
//   - every non-whitespace source character belongs to exactly one token;
//   - each non-code span (string / quoted-ident / comment) maps one-to-one to a
//     token of that kind, carrying its `closed` flag unchanged;
//   - consumers use `token.start` / `token.end` directly and must never
//     reconstruct positions by summing token text lengths.

import { scanSpans } from './sql-spans.js';

// Code-span punctuation that structure depends on (dotted names, arg lists,
// statement terminators) — each its own single-character `punct` token.
const PUNCT = new Set(['.', ',', ';', '(', ')']);
// Single-character operators. `=` is the one param-comparison keys on; keeping
// every operator one char wide is what makes `!=` / `<=` / `>=` read as two
// adjacent op tokens and therefore *not* a bare `col = {p}` comparison.
const OP = new Set(['=', '<', '>', '!', '+', '-', '*', '/', '%']);

const isDigit = (c) => c >= '0' && c <= '9';
const isWordStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
// A `$` is ordinary identifier content mid-word (a heredoc never opens in the
// middle of a bare-word run — see sql-spans.js rule 6), so `foo$bar` is one word.
const isWordPart = (c) => isWordStart(c) || isDigit(c) || c === '$';
const isNumPart = (c) => isDigit(c) || c === '.' || c === 'e' || c === 'E' || c === '+' || c === '-';
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

// Classify one code span [start, end) into word / number / punct / op / other
// tokens, skipping whitespace, pushing onto `out` with absolute offsets.
function lexCode(s, start, end, out) {
  let i = start;
  while (i < end) {
    const c = s[i];
    if (isSpace(c)) { i += 1; continue; } // no whitespace tokens
    if (isWordStart(c)) {
      let j = i + 1;
      while (j < end && isWordPart(s[j])) j += 1;
      out.push({ kind: 'word', start: i, end: j, closed: true });
      i = j;
      continue;
    }
    if (isDigit(c)) {
      // Shallow decimal/scientific run — a `+`/`-` continues the number only
      // right after an exponent marker (`1e-9`), else it's a separate operator.
      let j = i + 1;
      while (j < end && isNumPart(s[j])) {
        if ((s[j] === '+' || s[j] === '-') && !(s[j - 1] === 'e' || s[j - 1] === 'E')) break;
        j += 1;
      }
      out.push({ kind: 'number', start: i, end: j, closed: true });
      i = j;
      continue;
    }
    const kind = PUNCT.has(c) ? 'punct' : OP.has(c) ? 'op' : 'other';
    out.push({ kind, start: i, end: i + 1, closed: true });
    i += 1;
  }
}

/**
 * Lex `sql` into a flat `Token[]` with direct source offsets and no whitespace
 * tokens. Each token is `{ kind, start, end, closed }` where `kind` is one of
 * `word` | `quoted-ident` | `string` | `comment` | `number` | `op` | `punct` |
 * `other`. String / heredoc, quoted-identifier and comment spans map one-to-one
 * (carrying `closed`); code spans are split into word / number / punctuation /
 * single-char operator / `other` tokens (all `closed: true`). Pure.
 * @param {string} sql
 * @returns {{kind: string, start: number, end: number, closed: boolean}[]}
 */
export function lexSql(sql) {
  const s = String(sql || '');
  const out = [];
  for (const span of scanSpans(s)) {
    if (span.kind === 'code') { lexCode(s, span.start, span.end, out); continue; }
    // string (incl. heredoc), quoted-ident, comment → one token, closed as-is.
    out.push({ kind: span.kind, start: span.start, end: span.end, closed: span.closed });
  }
  return out;
}

/** The source text of `token` in `sql` (`sql.slice(start, end)`). Pure. */
export function tokenText(sql, token) {
  return String(sql).slice(token.start, token.end);
}

/** True when `token` is a bare `word` whose text equals `word`, case-insensitively. Pure. */
export function isWord(sql, token, word) {
  return !!token && token.kind === 'word' && tokenText(sql, token).toUpperCase() === String(word).toUpperCase();
}

/**
 * Decode a raw identifier string (needed where the identifier comes from a
 * regex capture, not a token — e.g. schema-graph.js). Rules (#182):
 *   1. bare input passes through unchanged;
 *   2. backtick / double-quoted input loses its opening delimiter;
 *   3. the final delimiter is removed only when `closed` is true AND the raw
 *      text actually ends with that delimiter;
 *   4. a malformed / unterminated identifier never loses its final content char;
 *   5. `\x` decodes to `x`;
 *   6. a doubled delimiter decodes to one delimiter.
 * Pure.
 * @param {string} raw
 * @param {boolean} [closed=true]
 */
export function decodeQuotedIdent(raw, closed = true) {
  const s = String(raw);
  const q = s[0];
  if (q !== '`' && q !== '"') return s; // bare identifier
  const end = closed && s.length > 1 && s[s.length - 1] === q ? s.length - 1 : s.length;
  let out = '';
  for (let i = 1; i < end; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < end) { out += s[i + 1]; i += 1; continue; }
    if (c === q && s[i + 1] === q && i + 1 < end) { out += q; i += 1; continue; }
    out += c;
  }
  return out;
}

/**
 * Decode an identifier `token`: a `quoted-ident` is unquoted/unescaped via
 * `decodeQuotedIdent` honoring its `closed` flag; any other token (a bare
 * `word`) returns its source text verbatim. Supersedes format.js::unquoteIdent
 * for token consumers. Pure.
 */
export function unquoteIdent(sql, token) {
  const raw = tokenText(sql, token);
  return token && token.kind === 'quoted-ident' ? decodeQuotedIdent(raw, token.closed) : raw;
}
