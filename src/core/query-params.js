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
//     -- / # / block comments (via the shared sql-spans.js scanner, also used by
//     sql-split.js), so `SELECT '{x:String}'` is a string constant, not a
//     parameter.
//   * Only row-returning statements substitute (readStatementParams / paramArgs
//     gate on isRowReturning), so a `CREATE VIEW … {x:String} …` keeps its
//     placeholder verbatim — which is exactly how ClickHouse parameterized
//     views work.

import { splitStatements, isRowReturning } from './sql-split.js';
import { scanParamDeclarations } from './param-scan.js';

/**
 * Detect ClickHouse `{name:Type}` parameters in `sql`, in first-appearance
 * order, unique by name (the first type seen wins). Placeholders inside
 * string / backtick literals and -- / # / block comments are skipped. A
 * compatibility wrapper over `scanParamDeclarations` (param-scan.js, #173),
 * which is the all-occurrences primitive the parameter pipeline's conflict
 * detection is built on. Pure.
 * @param {string} sql
 * @returns {{name: string, type: string}[]}
 */
export function detectParams(sql) {
  const out = [];
  const seen = new Set();
  for (const p of scanParamDeclarations(sql)) {
    if (!seen.has(p.name)) {
      seen.add(p.name);
      out.push(p);
    }
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
