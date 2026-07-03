// Pure detection + substitution planning for ClickHouse query parameters
// (`{name:Type}`).
//
// ClickHouse's native "query parameters" feature lets a query reference a typed
// placeholder — `SELECT {id:UInt32}` — and have the *server* substitute a value
// passed as the `param_<name>` HTTP query-string argument, parsed per the
// declared type. That is injection-safe and type-correct (Identifier, DateTime,
// Array(...), Map(...), …), so we never rewrite the SQL text here: this module
// only *finds* placeholders (to render inputs) and *builds the param_ args* to
// ride alongside the request. ClickHouse does the substitution.
//
// Two scoping rules match the product decision (#134):
//   * Detection ignores placeholders inside '…' / "…" / `…` literals and
//     -- / # / block comments (same lexer shape as sql-split.js), so
//     `SELECT '{x:String}'` is a string constant, not a parameter.
//   * Only row-returning statements substitute (readStatementParams / paramArgs
//     gate on isRowReturning), so a `CREATE VIEW … {x:String} …` keeps its
//     placeholder verbatim — which is exactly how ClickHouse parameterized
//     views work.

import { splitStatements, isRowReturning } from './sql-split.js';

// A parameter name is a bare SQL identifier; the type is a data-type expression
// that starts with a letter (String, Nullable(String), Array(UInt8),
// Map(String, UInt8), Decimal(10, 2), …). Requiring a letter-led type is what
// tells a real `{db:String}` apart from a map literal like `{1:2}` / `{'k':v}`
// (whose right-hand side is a value, not a type name). Types never contain
// braces, so a placeholder is delimited by the next `}`.
const PARAM_RE = /^([A-Za-z_]\w*)\s*:\s*([A-Za-z].*)$/;

/**
 * Detect ClickHouse `{name:Type}` parameters in `sql`, in first-appearance
 * order, unique by name (the first type seen wins). Placeholders inside
 * string / backtick literals and -- / # / block comments are skipped. Pure.
 * @param {string} sql
 * @returns {{name: string, type: string}[]}
 */
export function detectParams(sql) {
  const text = String(sql || '');
  const n = text.length;
  const out = [];
  const seen = new Set();
  let i = 0;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    // -- and # line comments: skip to end of line.
    if ((c === '-' && c2 === '-') || c === '#') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      i = j;
      continue;
    }
    // /* */ block comment (non-nesting, matching ClickHouse).
    if (c === '/' && c2 === '*') {
      let j = i + 2;
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
      i = Math.min(n, j + 2); // past the closing */ (or run to EOF if unterminated)
      continue;
    }
    // '…' string, "…" / `…` quoted identifier. Backslash escapes the next char;
    // a doubled quote (`''`) is an escaped quote, not a terminator.
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        const d = text[j];
        if (d === '\\') { j += 2; continue; }
        if (d === quote) {
          if (text[j + 1] === quote) { j += 2; continue; }
          j += 1;
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    if (c === '{') {
      // Scan to the closing `}`. Stop early on a nested `{` (e.g. the `{{name}}`
      // composable-query macro, #39) so it never reads as a typed parameter.
      let j = i + 1;
      while (j < n && text[j] !== '}' && text[j] !== '{') j++;
      if (j < n && text[j] === '}') {
        const m = PARAM_RE.exec(text.slice(i + 1, j).trim());
        if (m && !seen.has(m[1])) {
          seen.add(m[1]);
          out.push({ name: m[1], type: m[2].trim() });
        }
        i = j + 1;
        continue;
      }
      // No closing `}` (or a nested `{` first) — step over this brace and go on.
      i += 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * The parameters to expose as inputs for `sql`: the union (unique by name,
 * ordered) of `detectParams` over the row-returning statements only. A
 * placeholder that appears solely inside a non-read statement (e.g. a
 * `CREATE VIEW` definition) is intentionally omitted — it is not substituted.
 * Pure.
 * @returns {{name: string, type: string}[]}
 */
export function readStatementParams(sql) {
  const out = [];
  const seen = new Set();
  for (const stmt of splitStatements(sql)) {
    if (!isRowReturning(stmt)) continue;
    for (const p of detectParams(stmt)) {
      if (!seen.has(p.name)) {
        seen.add(p.name);
        out.push(p);
      }
    }
  }
  return out;
}

/**
 * Build the `param_<name>` query-string args for a single statement `stmt`,
 * drawing values from `values` (a `{ name: value }` map). Returns `{}` for a
 * non-row-returning statement (so CREATE VIEW / INSERT / DDL are sent
 * unchanged). An absent or empty value is skipped — the run gate
 * (`unfilledParams`) prevents executing while any required value is empty. Pure.
 * @returns {Object<string,string>}
 */
export function paramArgs(stmt, values) {
  if (!isRowReturning(stmt)) return {};
  const out = {};
  for (const { name } of detectParams(stmt)) {
    const v = values && values[name];
    if (v != null && v !== '') out['param_' + name] = v;
  }
  return out;
}

/**
 * The names among an already-detected parameter list `params` that have no value
 * yet in `values` (absent or empty string). Pure — lets a caller that already
 * holds the detected list (e.g. the variable strip) compute the missing set
 * without re-lexing the SQL.
 * @returns {string[]}
 */
export function missingValues(params, values) {
  return params
    .filter((p) => {
      const v = values && values[p.name];
      return v == null || v === '';
    })
    .map((p) => p.name);
}

/**
 * The names of parameters `sql` requires (its read statements) that have no
 * value yet in `values`. Empty when nothing is missing — the Run gate uses this
 * to block execution until every detected variable is filled. Pure.
 * @returns {string[]}
 */
export function unfilledParams(sql, values) {
  return missingValues(readStatementParams(sql), values);
}
