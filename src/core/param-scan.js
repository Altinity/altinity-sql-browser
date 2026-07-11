// Pure lexical scan for ClickHouse `{name:Type}` query-parameter declarations
// (#173). This is the all-occurrences primitive under the parameter pipeline:
// unlike `detectParams` (query-params.js), it does NOT dedup by name, so two
// declarations of the same parameter with different types are both visible —
// which is exactly what cross-source type-conflict detection needs. The
// first-wins, deduped `detectParams` remains as a compatibility wrapper over
// this scan.
//
// Scoping matches the #134 product decision: placeholders inside '…' / "…" /
// `…` literals and -- / # / block comments are skipped (via the shared
// sql-spans.js scanner, also used by sql-split.js so tokenizing can't diverge).

import { scanSpans } from './sql-spans.js';

// A parameter name is a bare SQL identifier; the type is a data-type expression
// that starts with a letter (String, Nullable(String), Array(UInt8),
// Map(String, UInt8), Decimal(10, 2), …). Requiring a letter-led type is what
// tells a real `{db:String}` apart from a map literal like `{1:2}` / `{'k':v}`
// (whose right-hand side is a value, not a type name). A type carries no braces
// of its own, so a placeholder is delimited by the next `}` — except one inside
// a quoted portion of the type (e.g. `Enum8('}' = 1)`), which the scanner marks
// opaque so it is skipped.
const PARAM_RE = /^([A-Za-z_]\w*)\s*:\s*([A-Za-z].*)$/;

/**
 * Every ClickHouse `{name:Type}` declaration in `sql`, in appearance order,
 * one entry per occurrence (no dedup — a name may repeat, with the same or a
 * conflicting type). Placeholders inside string / backtick literals and
 * -- / # / block comments are skipped. Pure.
 * @param {string} sql
 * @returns {{name: string, type: string}[]}
 */
export function scanParamDeclarations(sql) {
  const text = String(sql || '');
  const n = text.length;
  // Mark every character that lies inside an opaque '…'/"…"/`…` literal or a
  // comment, using the shared scanner. Placeholders are only recognized in code,
  // and — crucially — a `{`/`}` inside a literal is passthrough, not a delimiter,
  // so a quoted `}` in a type like `Enum8('}' = 1, 'ok' = 2)` no longer closes
  // the placeholder early (#139).
  const opaque = new Uint8Array(n);
  for (const { kind, start, end } of scanSpans(text)) {
    if (kind !== 'code') opaque.fill(1, start, end);
  }
  const out = [];
  let i = 0;
  while (i < n) {
    if (opaque[i] || text[i] !== '{') { i += 1; continue; }
    // Scan to the matching (code, non-opaque) `}`. Chars inside a literal/comment
    // are passthrough content. Stop early on a nested code `{` (e.g. the
    // `{{name}}` composable-query macro, #39) so it never reads as a parameter.
    let j = i + 1;
    while (j < n && !(!opaque[j] && (text[j] === '}' || text[j] === '{'))) j++;
    if (j < n && text[j] === '}') {
      const m = PARAM_RE.exec(text.slice(i + 1, j).trim());
      if (m) out.push({ name: m[1], type: m[2].trim() });
      i = j + 1;
      continue;
    }
    // No closing `}` (or a nested `{` first) — step over this brace and go on.
    i += 1;
  }
  return out;
}
