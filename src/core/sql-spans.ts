// Canonical lexical span scanner for ClickHouse SQL text (#182). This is the
// single authoritative core implementation of SQL lexical boundaries used by
// *string-based application analysis* — statement splitting, parameter
// detection, optional-block/format handling, type display, and (via the
// structural lexer sql-lex.js layered on top) completion and FROM/JOIN scope.
//
// It is deliberately independent of CodeMirror. Core analysis also runs on
// inactive tabs, saved queries, partially written SQL, and raw test strings
// that never had an EditorState, so it cannot depend on Lezer trees. CM6 owns
// editor behavior (highlighting, bracket/quote guards, hover); this scanner
// owns application logic. The two are allowed to differ in the documented
// approximation areas (see codemirror-adapter.js).
//
// Verified against ClickHouse 26.3.13 and the upstream lexer:
//   - `--` opens a line comment (no following-char restriction);
//   - `//` opens a line comment (no restriction, including glued `6//2`; longer
//     runs like `////` are the same form — there is no `//` operator);
//   - `#` opens a line comment ONLY when the next char is ASCII space (0x20) or
//     `!`; `#x`, a bare `#` at EOF, `#\t`, and `##x` are NOT comments;
//   - a line comment runs to (not including) the next `\n`; a preceding `\r`
//     (CRLF) stays part of the comment, matching the server;
//   - `/* */` block comments NEST — the scanner tracks depth and is quote-blind;
//   - single-quoted strings and quoted identifiers honor `\` backslash escapes
//     and doubled-delimiter escapes (`''`, `` `` ``, `""`);
//   - both backtick and double-quoted identifiers are `quoted-ident` (double
//     quote is an identifier delimiter in ClickHouse, not a string);
//   - `$$…$$` / `$tag$…$tag$` heredocs are opaque string literals whose tag is
//     `[A-Za-z0-9_]*` (empty and digit-leading tags valid); the closer must
//     match the opener exactly, and quotes/comments/braces/semicolons inside the
//     body are inert. A heredoc opens only when its `$` starts a token, so
//     `foo$tag$x$tag$` is one bare-word run, not an embedded heredoc.
//
// Intentional client-side recovery policy for PARTIAL input: an unterminated
// single-quoted string, quoted identifier, block comment, or a valid heredoc
// opener with no matching closer runs to EOF with `closed: false`. This is a
// deliberate difference from the server, which for an unterminated heredoc
// opener may fall back to ordinary dollar/bare-word tokenization — e.g. the
// client treats `$foo$bar` as an open heredoc while the server may lex it as a
// bare identifier. The trade-off keeps live editor input safe to analyze.

import { scanDelimited } from './quoted-span.js';

/** One lexical span's classification — see `scanSpans`' doc comment below. */
export type SpanKind = 'code' | 'string' | 'quoted-ident' | 'comment';

/** One lexical span `scanSpans` yields — see its doc comment for field
 *  semantics. */
export interface Span {
  kind: SpanKind;
  start: number;
  end: number;
  closed: boolean;
}

// A heredoc/identifier tag character: ASCII word char (no punctuation tags —
// pre-25.8 punctuation/whitespace tags are intentionally unsupported).
const isWordChar = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_';

// From a `$` at `i`, the end offset (exclusive) of a valid `$[A-Za-z0-9_]*$`
// heredoc opener, or -1 when the tag is non-word / there is no second `$`. A
// non-word tag falls through to code and must not consume to EOF (rule 8).
function heredocOpenerEnd(s: string, i: number, n: number): number {
  let j = i + 1;
  while (j < n && isWordChar(s[j])) j += 1;
  return s[j] === '$' ? j + 1 : -1;
}

// The opener classification for a potential span start — `null` when `c` is
// ordinary code.
type OpenKind = 'line' | 'block' | 'string' | 'quoted-ident' | 'heredoc' | null;

/**
 * Scan `text` into consecutive, non-overlapping lexical spans, in order,
 * covering every source character exactly once. Each span is
 * `{ kind, start, end, closed }` where `text.slice(start, end)` is its source:
 *   - `'code'`        — everything not consumed by an opaque form; `closed` is
 *                       always `true`.
 *   - `'string'`      — a single-quoted string or a `$tag$…$tag$` heredoc
 *                       (delimiters retained). `closed` reports whether the
 *                       required closer was found.
 *   - `'quoted-ident'`— a `` `…` `` / `"…"` quoted identifier (delimiter
 *                       retained; backslash + doubled-delimiter escapes honored).
 *                       `closed` reports whether the closer was found.
 *   - `'comment'`     — a `--` / restricted `#` / `//` line comment, or a nested
 *                       `/* *​/` block comment. Line comments are always
 *                       `closed: true`; a block comment's `closed` reports
 *                       whether nesting returned to depth zero.
 * No zero-length spans are emitted. Pure generator.
 */
export function* scanSpans(text?: string | null): Generator<Span> {
  const s = String(text || '');
  const n = s.length;
  let i = 0;
  let codeStart = 0; // start of the code run preceding the current position
  while (i < n) {
    const c = s[i];
    const c2 = s[i + 1];
    // Classify a potential opener at `i`. `open` is one of the opaque forms, or
    // null when `c` is ordinary code.
    let open: OpenKind = null;
    if (c === '-' && c2 === '-') open = 'line';
    else if (c === '/' && c2 === '/') open = 'line';
    else if (c === '/' && c2 === '*') open = 'block';
    else if (c === '#' && (c2 === ' ' || c2 === '!')) open = 'line';
    else if (c === "'") open = 'string';
    else if (c === '"' || c === '`') open = 'quoted-ident';
    else if (
      c === '$' &&
      // A heredoc opens only when its `$` starts a token: at the start of the
      // current code run, or after a non-bare-word, non-`$` char (rule 6). An
      // intervening opaque span/comment resets codeStart, so `'x'$t$…$t$` opens.
      !(i > codeStart && (isWordChar(s[i - 1]) || s[i - 1] === '$'))
    ) {
      open = 'heredoc';
    }
    if (open === null) { i += 1; continue; }

    let end: number;
    let closed = true;
    let kind: SpanKind;
    if (open === 'heredoc') {
      const oe = heredocOpenerEnd(s, i, n);
      if (oe < 0) { i += 1; continue; } // non-word tag → ordinary code
      const opener = s.slice(i, oe);
      const close = s.indexOf(opener, oe);
      end = close < 0 ? n : close + opener.length;
      closed = close >= 0;
      kind = 'string';
    } else if (open === 'line') {
      let j = i + 1;
      while (j < n && s[j] !== '\n') j += 1;
      end = j;
      kind = 'comment';
    } else if (open === 'block') {
      let j = i + 2;
      let depth = 1;
      while (j < n && depth > 0) {
        if (s[j] === '/' && s[j + 1] === '*') { depth += 1; j += 2; continue; }
        if (s[j] === '*' && s[j + 1] === '/') { depth -= 1; j += 2; continue; }
        j += 1;
      }
      end = Math.min(j, n);
      closed = depth === 0;
      kind = 'comment';
    } else {
      // 'string' (single quote) and 'quoted-ident' share the delimiter scan.
      const r = scanDelimited(s, i, c);
      end = r.end;
      closed = r.closed;
      kind = open === 'string' ? 'string' : 'quoted-ident';
    }

    // The opener ends the code run that preceded it (if any), then the opaque
    // span is emitted and the next code run starts after it.
    if (i > codeStart) yield { kind: 'code', start: codeStart, end: i, closed: true };
    yield { kind, start: i, end, closed };
    i = end;
    codeStart = i;
  }
  if (n > codeStart) yield { kind: 'code', start: codeStart, end: n, closed: true };
}
