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

import { scanSpans as _scanSpans } from './sql-spans.js';

// `sql-spans.js` is unconverted (checkJs:false) — a thin typed wrapper over
// the exact shape this file reads off each span (same convention
// `optional-blocks.ts` uses for the same scanner).
interface Span {
  kind: 'code' | 'string' | 'quoted-ident' | 'comment';
  start: number;
  end: number;
}
const scanSpans: (text: string) => Iterable<Span> = _scanSpans;

// A parameter name is a bare SQL identifier; the type is a data-type expression
// that starts with a letter (String, Nullable(String), Array(UInt8),
// Map(String, UInt8), Decimal(10, 2), …). Requiring a letter-led type is what
// tells a real `{db:String}` apart from a map literal like `{1:2}` / `{'k':v}`
// (whose right-hand side is a value, not a type name). A type carries no braces
// of its own, so a placeholder is delimited by the next `}` — except one inside
// a quoted portion of the type (e.g. `Enum8('}' = 1)`), which the scanner marks
// opaque so it is skipped.
const PARAM_RE = /^([A-Za-z_]\w*)\s*:\s*([A-Za-z].*)$/;

/** One ClickHouse `{name:Type}` declaration — a name and its declared type
 *  text. The shape every existing caller (query-params.js, param-pipeline.js,
 *  optional-blocks.js, filter-execution.js) relies on. */
export interface ParamDeclaration {
  name: string;
  type: string;
}

/** One `{name:Type}` occurrence — `ParamDeclaration` plus the character
 *  offsets of the WHOLE `{…}` span (`start` at `{`, `end` one past the
 *  matching `}`) — #172 v2's `paramComparisonColumns` needs these to locate
 *  each occurrence's surrounding tokens and, later, its FROM scope. */
export interface ParamOccurrence extends ParamDeclaration {
  start: number;
  end: number;
}

/**
 * Every ClickHouse `{name:Type}` declaration in `sql`, in appearance order,
 * one entry per occurrence (no dedup — a name may repeat, with the same or a
 * conflicting type), with the character offsets of the WHOLE `{…}` span
 * (`start` at `{`, `end` one past the matching `}`) — #172 v2's
 * `paramComparisonColumns` needs these to locate each occurrence's
 * surrounding tokens and, later, its FROM scope. Placeholders inside string /
 * backtick literals and -- / # / block comments are skipped. Pure.
 */
export function scanParamOccurrences(sql?: string | null): ParamOccurrence[] {
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
  const out: ParamOccurrence[] = [];
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
      if (m) out.push({ name: m[1], type: m[2].trim(), start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    // No closing `}` (or a nested `{` first) — step over this brace and go on.
    i += 1;
  }
  return out;
}

/**
 * Every ClickHouse `{name:Type}` declaration in `sql`, in appearance order,
 * one entry per occurrence (no dedup — a name may repeat, with the same or a
 * conflicting type). Placeholders inside string / backtick literals and
 * -- / # / block comments are skipped. A thin wrapper over
 * `scanParamOccurrences` that drops the position fields — the shape every
 * existing caller (query-params.js, param-pipeline.js) already expects. Pure.
 */
export function scanParamDeclarations(sql?: string | null): ParamDeclaration[] {
  return scanParamOccurrences(sql).map(({ name, type }) => ({ name, type }));
}
