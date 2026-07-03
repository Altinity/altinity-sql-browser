// Shared lexical span scanner for ClickHouse SQL text.
//
// The script splitter (sql-split.js) and the query-parameter detector
// (query-params.js) both need to know which stretches of a query are *code*
// versus an opaque '…' / "…" / `…` string literal or a -- / # / block comment —
// so a `;` (statement separator) or `{…}` (parameter placeholder) inside a
// literal or comment is never mistaken for the real thing. Keeping one scanner
// here means ClickHouse's tokenizing rules — `\` backslash and `''` doubled-quote
// escapes, non-nesting `/* */` block comments — live in one place for those two
// consumers rather than being copied into each.
//
// This yields coarse *spans* (code / string / comment), not fine tokens. The
// editor highlighter (sql-highlight.js `tokenize`) is a separate, finer lexer
// that also classifies keywords / numbers / operators and produces a per-char
// literal mask (`maskLiterals`) — query-params.js deliberately does NOT reuse
// that mask, because it conflates strings with comments (splitStatements needs
// them apart: a comment is not runnable text, a literal is) and its escape rules
// differ. Don't fold these together without preserving the code-vs-comment-vs-
// string distinction. (The remaining lexer duplication with the highlighter is
// tracked separately in #141.)

/**
 * Scan `text` into consecutive lexical spans, in order, covering every
 * character exactly once. Each span is `{ kind, start, end }` where `kind` is:
 *   - `'string'`  — a `'…'` / `"…"` / `` `…` `` literal (quotes included);
 *                   `\` escapes the next char and a doubled quote (`''`) is an
 *                   escaped quote, not a terminator; an unterminated literal
 *                   runs to EOF.
 *   - `'comment'` — a `--` / `#` line comment (to end of line, excluding the
 *                   newline) or a `/* *​/` block comment (non-nesting, matching
 *                   ClickHouse; an unterminated one runs to EOF).
 *   - `'code'`    — everything else (runnable SQL).
 * `text.slice(start, end)` is the span's source. Pure generator.
 * @param {string} text
 * @returns {Generator<{kind: 'code'|'string'|'comment', start: number, end: number}>}
 */
export function* scanSpans(text) {
  const s = String(text || '');
  const n = s.length;
  let i = 0;
  let codeStart = 0; // start of the code run preceding the current position
  while (i < n) {
    const c = s[i];
    const c2 = s[i + 1];
    const isLineComment = (c === '-' && c2 === '-') || c === '#';
    const isBlockComment = c === '/' && c2 === '*';
    const isQuote = c === "'" || c === '"' || c === '`';
    if (!isLineComment && !isBlockComment && !isQuote) { i += 1; continue; }
    // An opener ends the code run that preceded it (if any).
    if (i > codeStart) yield { kind: 'code', start: codeStart, end: i };
    if (isLineComment) {
      let j = i + 1;
      while (j < n && s[j] !== '\n') j++;
      yield { kind: 'comment', start: i, end: j };
      i = j;
    } else if (isBlockComment) {
      let j = i + 2;
      while (j < n && !(s[j] === '*' && s[j + 1] === '/')) j++;
      j = Math.min(n, j + 2); // include the closing */ (or run to EOF if unterminated)
      yield { kind: 'comment', start: i, end: j };
      i = j;
    } else {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        const d = s[j];
        if (d === '\\') { j += 2; continue; }
        if (d === quote) {
          if (s[j + 1] === quote) { j += 2; continue; }
          j += 1;
          break;
        }
        j += 1;
      }
      j = Math.min(j, n); // a trailing `\` could overshoot past EOF
      yield { kind: 'string', start: i, end: j };
      i = j;
    }
    codeStart = i;
  }
  if (n > codeStart) yield { kind: 'code', start: codeStart, end: n };
}
