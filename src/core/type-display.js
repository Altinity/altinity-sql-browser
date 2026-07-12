// Compact display form of a ClickHouse column type for width-constrained UI
// surfaces (#177): the schema tree's row metadata, the schema-detail type cell,
// completion `detail`, and the schema graph cards. A declared type is unbounded
// — Enum members, Tuple fields, Variant alternatives — so rendering it raw lets
// one column consume the row, and a blind character cut leaves low-value
// fragments like `Enum16('Close' = -11, 'Err…`. compactType() instead collapses
// the unbounded declaration bodies to summaries (`Enum16(41 values)`,
// `Tuple(12 fields)`) while preserving the outer wrapper structure
// (`Array(Tuple(12 fields))`). Display-only: callers keep the full original
// type in schema/completion data and expose it via a hover/detail affordance.
//
// Pure, no DOM, no ClickHouse type AST. One quote-aware balanced-parenthesis
// scan (ClickHouse string escapes: `\` and doubled `''`, same rules as
// sql-spans.js); only the wrapper heads recurse, depth-capped, so total work
// stays effectively linear in the type length. Anything malformed (unbalanced
// parens, trailing garbage, unexpected tokens) falls back to format.js
// truncate() on the raw string — never an exception.

import { truncate } from './format.js';

// The shared display budget for a type rendered inline in a row-shaped surface
// (the schema tree's meta column and the completion dropdown's detail column
// use the same visual density) — wider surfaces pass their own budget.
export const INLINE_TYPE_MAX = 30;

// Heads whose declaration body is an unbounded list → collapse to a count.
const COUNT_HEADS = { Enum8: 'values', Enum16: 'values', Enum: 'values', Tuple: 'fields', Nested: 'fields', Variant: 'types' };
// Heads whose arguments are themselves types → keep the structure, recurse.
const WRAP_HEADS = new Set(['Nullable', 'LowCardinality', 'Array', 'Map']);
// Wrapper nesting deeper than any sane declared type — beyond it, give up and
// let the generic truncation handle it (bounds re-scanning to a constant
// number of passes, keeping the whole scan effectively linear).
const MAX_DEPTH = 8;

const isWordChar = (ch) => {
  const c = ch.charCodeAt(0);
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95;
};

// Skip a quoted run starting at s[i] === quote (a '…' string literal or a
// `…`/"…" quoted identifier — a named Tuple/Nested field can carry any of
// them): `\` escapes the next char, a doubled quote is an escaped quote (same
// rules as sql-spans.js). Returns the index just past the closing quote, or
// -1 when the run reaches EOF unterminated.
function skipQuoted(s, i, quote) {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === quote) {
      if (s[j + 1] === quote) { j += 2; continue; }
      return j + 1;
    }
    j += 1;
  }
  return -1;
}

// Scan a parenthesised body whose '(' sits at s[open], splitting it into
// top-level argument ranges `{from, to}` (commas inside strings or nested
// brackets don't split — `[…]`/`{…}` also nest, so an array-literal aggregate
// parameter like `sumMapFiltered([1, 2])` counts as one entry). Returns
// { args, end } with `end` just past the ')', or null when the body is
// unbalanced / a string in it is unterminated.
function scanBody(s, open) {
  const args = [];
  let depth = 1;
  let argStart = open + 1;
  let i = open + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '`' || c === '"') {
      i = skipQuoted(s, i, c);
      if (i < 0) return null;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') { depth += 1; i += 1; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 1) {
        if (c !== ')') return null; // the body must close with ')'
        args.push({ from: argStart, to: i });
        return { args, end: i + 1 };
      }
      depth -= 1;
      i += 1;
      continue;
    }
    if (c === ',' && depth === 1) {
      args.push({ from: argStart, to: i });
      argStart = i + 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return null;
}

// Trim a range to its non-whitespace extent; from >= to means it was blank.
const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r';
function trimRange(s, r) {
  let f = r.from;
  let t = r.to;
  while (f < t && isSpace(s[f])) f += 1;
  while (t > f && isSpace(s[t - 1])) t -= 1;
  return { from: f, to: t };
}

// The top-level entry count of a declaration body, or null when it can't be
// counted confidently (a blank entry — `Enum8('a'=1,,)` — means the split
// doesn't reflect real members). `()` counts as 0.
function countArgs(s, args) {
  const first = trimRange(s, args[0]);
  if (args.length === 1 && first.from >= first.to) return 0;
  for (const r of args) {
    const t = trimRange(s, r);
    if (t.from >= t.to) return null;
  }
  return args.length;
}

// Compact the type occupying exactly s[from..to). Returns the compact display
// string, or null when the slice isn't a recognizable type shape (the caller
// then falls back to generic truncation of the raw string).
function compactOne(s, from, to, depth) {
  let i = from;
  while (i < to && isWordChar(s[i])) i += 1;
  const head = s.slice(from, i);
  if (i >= to) return head || null; // bare type name (empty → not a type)
  if (s[i] !== '(' || !head) return null; // unexpected token where a declaration should be
  const noun = COUNT_HEADS[head];
  const body = scanBody(s, i);
  if (!body) {
    // Unbalanced / unterminated body. For a collapse head the summary is still
    // better than a raw fragment — the "can't count confidently" form.
    return noun ? head + '(… ' + noun + ')' : null;
  }
  if (body.end !== to) return null; // trailing garbage after the closing paren
  if (noun) {
    const n = countArgs(s, body.args);
    // The nouns all pluralize with a plain trailing 's' — drop it at exactly 1.
    return head + '(' + (n == null ? '… ' + noun : n + ' ' + (n === 1 ? noun.slice(0, -1) : noun)) + ')';
  }
  if (head === 'AggregateFunction' || head === 'SimpleAggregateFunction') {
    // First entry is the aggregate function (possibly parameterized —
    // `quantiles(0.5, 0.9)` → keep just the name); the rest are its argument
    // types, summarised as a count.
    const first = trimRange(s, body.args[0]);
    let j = first.from;
    while (j < first.to && isWordChar(s[j])) j += 1;
    const fn = s.slice(first.from, j);
    if (!fn) return null;
    const n = body.args.length - 1;
    return head + '(' + fn + ', ' + n + ' arg' + (n === 1 ? '' : 's') + ')';
  }
  if (head === 'JSON') return 'JSON(configured)';
  if (WRAP_HEADS.has(head) && depth < MAX_DEPTH) {
    const parts = [];
    for (const r of body.args) {
      const t = trimRange(s, r);
      const inner = compactOne(s, t.from, t.to, depth + 1);
      if (inner == null) return null;
      parts.push(inner);
    }
    return head + '(' + parts.join(', ') + ')';
  }
  // Unrecognized (or too-deep) parameterized head — DateTime64(3, 'UTC'),
  // Decimal(38, 10), FixedString(16), … — the body is bounded in practice;
  // keep it verbatim and let the final length check truncate if needed.
  return s.slice(from, to);
}

/**
 * Compact `type` for inline display within `maxLen` characters. A type that
 * already fits is returned unchanged; otherwise unbounded declaration bodies
 * collapse to summaries (`Enum16(41 values)`, `Tuple(12 fields)`,
 * `Variant(4 types)`, `AggregateFunction(quantiles, 1 arg)`,
 * `JSON(configured)`) with outer wrappers preserved
 * (`Array(Tuple(12 fields))`). Malformed input — or a compacted form still
 * over budget — degrades to format.js truncate(). Display-only: never use the
 * result in SQL; the caller keeps the original type for that.
 * @param {*} type - the declared ClickHouse type (nullish → '')
 * @param {number} maxLen - the display budget in characters
 * @returns {string}
 */
export function compactType(type, maxLen) {
  const s = type == null ? '' : String(type);
  if (s.length <= maxLen) return s;
  const compacted = compactOne(s, 0, s.length, 0);
  const out = compacted == null ? s : compacted;
  return out.length <= maxLen ? out : truncate(out, maxLen);
}
