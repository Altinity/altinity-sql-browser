// Shared pure delimiter-scanning primitive (#241) — the single authoritative
// escape/doubled-delimiter rule for a `'…'`, `` `…` ``, or `"…"` delimited
// span, used by both `sql-spans.js` (SQL lexical spans) and
// `clickhouse-type.js` (the ClickHouse type-expression tokenizer). Neither
// consumer may reimplement this independently — a second, subtly different
// backslash-counting loop is exactly how the two drifted apart before (a
// naive one-character lookback treats ANY backslash immediately before the
// delimiter as escaping it, which is wrong for an even-length backslash run:
// `'a\\'` is one escaped backslash followed by a real, unescaped closer).
//
// Rules:
//   - a backslash consumes itself and the following character as one pair,
//     so backslashes are always counted two at a time, never one;
//   - a doubled delimiter (`''`, `` `` ``, `""`) is literal delimiter
//     content, not a terminator;
//   - an undoubled delimiter not consumed by a preceding backslash pair
//     closes the span;
//   - a trailing unmatched backslash, or no closing delimiter at all, leaves
//     the span unclosed (`closed: false`), running to the end of `text`.
//
// This function does no SQL-comment or heredoc classification — that's each
// caller's own concern layered on top. Pure, allocation-light.

/** `scanDelimited`'s return shape. */
export interface ScanResult {
  end: number;
  closed: boolean;
}

/**
 * @param text
 * @param start index of the OPENING delimiter itself
 * @param quote the delimiter character (`'`, `` ` ``, or `"`)
 * @returns `end` is exclusive — one past the closing delimiter, or
 *   `text.length` when unclosed.
 */
export function scanDelimited(text: string, start: number, quote: string): ScanResult {
  const n = text.length;
  let j = start + 1;
  while (j < n) {
    const c = text[j];
    if (c === '\\') { j += 2; continue; }
    if (c === quote) {
      if (text[j + 1] === quote) { j += 2; continue; }
      return { end: j + 1, closed: true };
    }
    j += 1;
  }
  return { end: n, closed: false };
}
