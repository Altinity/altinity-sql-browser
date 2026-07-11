// Pure syntactic heuristic for #172 v2 (schema-cache inference, workbench
// only): which column is each `{name:Type}` parameter directly compared to?
// Conservative by design — only a bare `col = {p}` / `{p} = col` equality
// counts (qualified/aliased forms included, e.g. `t.col` / `alias.col`); an
// expression around the column (`lower(col) = {p}`), `IN`/`BETWEEN`, or a
// param compared to two DIFFERENT columns anywhere in the SQL all yield no
// match. This module only finds the SYNTACTIC reference (a raw qualifier +
// column name, plus the param occurrence's own char offset so a caller can
// run its own per-statement FROM-scope resolution); it does not touch the
// schema cache or from-scope.js itself — see `from-scope.js`'s
// `resolveComparisonColumnType`, the next (also pure) step that turns this
// into an actual cached column type.
//
// Bidirectional `=` (both `col = {p}` and `{p} = col`) is supported — the
// issue's spec writes the `col = {p}` shape to describe the *kind* of
// comparison (a direct equality, not IN/BETWEEN/an expression), not a
// left-to-right requirement, and ClickHouse SQL allows either order.
//
// Deliberately does NOT special-case a 3-level `db.table.col` qualifier (only
// one dot is consumed) — from-scope.js's own resolution is per-statement
// alias/table matching, so a rarer 3-level form just doesn't resolve rather
// than mis-resolving; not exercised by any known caller today.

import { tokenize } from './sql-highlight.js';
import { unquoteIdent } from './format.js';
import { scanParamOccurrences } from './param-scan.js';

// Arithmetic/comparison chars the plain tokenizer emits as their own 'op'
// token per character — relied on below only implicitly: requiring the ident
// (or qualifier.ident pair) to sit IMMEDIATELY next to the '=' token is what
// makes `!=`/`<=`/`>=` (extra 'op' tokens between them) and a function call's
// closing `)` (between the inner column and the outer `=`) fail to match, with
// no separate check needed.

// Tokenize `text` into significant (non-ws/comment) tokens, each param
// occurrence collapsed into ONE synthetic `{type:'param', name, start, end}`
// token so its own internal tokens (an Enum's `'a' = 1` — a real `=` op token
// inside the type text) can never be mistaken for a comparison in the outer
// SQL. Every other token keeps its char `start`/`end`.
function significantTokensWithParams(text, occurrences) {
  const toks = [];
  let off = 0;
  for (const [type, t] of tokenize(text)) {
    toks.push({ type, text: t, start: off, end: off + t.length });
    off += t.length;
  }
  const out = [];
  let oi = 0;
  let i = 0;
  while (i < toks.length) {
    const occ = occurrences[oi];
    if (occ && toks[i].start >= occ.start && toks[i].start < occ.end) {
      out.push({ type: 'param', name: occ.name, start: occ.start, end: occ.end });
      while (i < toks.length && toks[i].start < occ.end) i += 1;
      oi += 1;
      continue;
    }
    const t = toks[i];
    if (t.type !== 'ws' && t.type !== 'comment') out.push(t);
    i += 1;
  }
  return out;
}

const isOp = (t, text) => !!t && t.type === 'op' && t.text === text;
const isIdent = (t) => !!t && t.type === 'ident';
const isParam = (t) => !!t && t.type === 'param';

// A bare column reference starting at `sig[idx]`: `ident` or `ident '.' ident`
// (qualifier.column). Rejects when the ref would immediately continue into a
// function call (`col(` — a call, not a value). Returns `{qualifier, column,
// next}` (`next` = the index just past what was consumed) or `null`.
function parseColumnRefForward(sig, idx) {
  const a = sig[idx];
  if (!isIdent(a)) return null;
  let qualifier = null;
  let columnTok = a;
  let next = idx + 1;
  if (isOp(sig[next], '.') && isIdent(sig[next + 1])) {
    qualifier = unquoteIdent(a.text);
    columnTok = sig[next + 1];
    next += 2;
  }
  if (isOp(sig[next], '(')) return null; // a function call, not a bare column
  return { qualifier, column: unquoteIdent(columnTok.text), next };
}

// The mirror of `parseColumnRefForward`, ending exactly at `sig[idx]` (the
// token immediately before a comparison `=`): `ident` or `ident '.' ident`.
function parseColumnRefBackward(sig, idx) {
  const c = sig[idx];
  if (!isIdent(c)) return null;
  let qualifier = null;
  if (isOp(sig[idx - 1], '.') && isIdent(sig[idx - 2])) {
    qualifier = unquoteIdent(sig[idx - 2].text);
  }
  return { qualifier, column: unquoteIdent(c.text) };
}

/**
 * For every `{name:Type}` parameter in `sql`, the single column it is
 * directly compared to — `{qualifier: string|null, column: string, pos:
 * number}` (`pos` is the param occurrence's own char offset, for a caller's
 * own per-statement FROM-scope resolution) — or absent from the returned
 * object when there's no confident single match: no direct-equality
 * occurrence at all, an expression/IN/BETWEEN around the column, or two
 * occurrences of the same param name resolving to different columns. Pure.
 * @param {string} sql
 * @returns {Object<string, {qualifier: string|null, column: string, pos: number}>}
 */
export function paramComparisonColumns(sql) {
  const text = String(sql || '');
  const occurrences = scanParamOccurrences(text);
  if (!occurrences.length) return {};
  const sig = significantTokensWithParams(text, occurrences);
  const found = {}; // name -> ref | 'CONFLICT'
  for (let k = 0; k < sig.length; k++) {
    if (!isOp(sig[k], '=')) continue;
    if (isParam(sig[k - 1])) {
      const ref = parseColumnRefForward(sig, k + 1);
      if (ref) record(found, sig[k - 1].name, { qualifier: ref.qualifier, column: ref.column, pos: sig[k - 1].start });
    }
    if (isParam(sig[k + 1])) {
      const ref = parseColumnRefBackward(sig, k - 1);
      if (ref) record(found, sig[k + 1].name, { qualifier: ref.qualifier, column: ref.column, pos: sig[k + 1].start });
    }
  }
  const out = {};
  for (const [name, v] of Object.entries(found)) {
    if (v !== 'CONFLICT') out[name] = v;
  }
  return out;
}

function record(found, name, ref) {
  if (!(name in found)) { found[name] = ref; return; }
  const cur = found[name];
  if (cur === 'CONFLICT') return;
  if (cur.qualifier !== ref.qualifier || cur.column !== ref.column) found[name] = 'CONFLICT';
}
