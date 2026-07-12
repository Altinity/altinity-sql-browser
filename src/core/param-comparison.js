// Pure syntactic heuristic for #172 v2 (schema-cache inference, workbench
// only): which column is each `{name:Type}` parameter directly compared to?
// Conservative by design — only a bare `col = {p}` / `{p} = col` equality
// counts (qualified/aliased forms included, e.g. `t.col` / `alias.col`); an
// expression around the column (`lower(col) = {p}`), `IN`/`BETWEEN`, or a
// param compared to two DIFFERENTLY-NAMED columns anywhere in the SQL all
// yield no match. Same-named references that differ only in qualifier text
// (`e.status` vs bare `status`) are returned together for the resolution step
// to compare by resolved identity — see `paramComparisonColumns`'s doc. This
// module only finds the SYNTACTIC references (raw qualifier + column name,
// plus each param occurrence's own char offset so a caller can run its own
// per-statement FROM-scope resolution); it does not touch the schema cache or
// from-scope.js itself — see `from-scope.js`'s `resolveComparisonColumnType`,
// the next (also pure) step that turns this into an actual cached column type.
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

import { lexSql, unquoteIdent } from './sql-lex.js';
import { scanParamOccurrences } from './param-scan.js';

// The structural lexer emits each comparison operator as its own single-char
// `op` token — relied on below only implicitly: requiring the ident (or
// qualifier.ident pair) to sit IMMEDIATELY next to the `=` token is what makes
// `!=`/`<=`/`>=` (extra `op` tokens between them) and a function call's closing
// `)` (between the inner column and the outer `=`) fail to match, with no
// separate check needed.

// Lex `text` into significant (non-comment) tokens, each param occurrence
// collapsed into ONE synthetic `{kind:'param', name, start, end}` token so its
// own internal tokens (an Enum's `'a' = 1` — a real `=` op inside the type
// text) can never be mistaken for a comparison in the outer SQL. Strings,
// heredocs and quoted identifiers stay as single opaque tokens, so an internal
// `=` never counts as an outer comparison. Every other token keeps its offsets.
function significantTokensWithParams(text, occurrences) {
  const toks = lexSql(text);
  const out = [];
  let oi = 0;
  let i = 0;
  while (i < toks.length) {
    const occ = occurrences[oi];
    if (occ && toks[i].start >= occ.start && toks[i].start < occ.end) {
      out.push({ kind: 'param', name: occ.name, start: occ.start, end: occ.end });
      while (i < toks.length && toks[i].start < occ.end) i += 1;
      oi += 1;
      continue;
    }
    const t = toks[i];
    if (t.kind !== 'comment') out.push(t);
    i += 1;
  }
  return out;
}

const isOp = (s, t, ch) => !!t && t.kind === 'op' && s[t.start] === ch;
const isPunct = (s, t, ch) => !!t && t.kind === 'punct' && s[t.start] === ch;
const isIdent = (t) => !!t && (t.kind === 'word' || t.kind === 'quoted-ident');
const isParam = (t) => !!t && t.kind === 'param';

// A bare column reference starting at `sig[idx]`: an identifier (`word` or
// `quoted-ident`) or `ident '.' ident` (qualifier.column). Rejects when the ref
// would immediately continue into a function call (`col(` — a call, not a
// value). Returns `{qualifier, column, next}` (`next` = the index just past
// what was consumed) or `null`. `s` is the source text (for token decoding).
function parseColumnRefForward(s, sig, idx) {
  const a = sig[idx];
  if (!isIdent(a)) return null;
  let qualifier = null;
  let columnTok = a;
  let next = idx + 1;
  if (isPunct(s, sig[next], '.') && isIdent(sig[next + 1])) {
    qualifier = unquoteIdent(s, a);
    columnTok = sig[next + 1];
    next += 2;
  }
  if (isPunct(s, sig[next], '(')) return null; // a function call, not a bare column
  return { qualifier, column: unquoteIdent(s, columnTok), next };
}

// The mirror of `parseColumnRefForward`, ending exactly at `sig[idx]` (the
// token immediately before a comparison `=`): identifier or `ident '.' ident`.
function parseColumnRefBackward(s, sig, idx) {
  const c = sig[idx];
  if (!isIdent(c)) return null;
  let qualifier = null;
  if (isPunct(s, sig[idx - 1], '.') && isIdent(sig[idx - 2])) {
    qualifier = unquoteIdent(s, sig[idx - 2]);
  }
  return { qualifier, column: unquoteIdent(s, c) };
}

/**
 * For every `{name:Type}` parameter in `sql`, the single column it is
 * directly compared to — `{qualifier: string|null, column: string, pos:
 * number}` (`pos` is the param occurrence's own char offset, for a caller's
 * own per-statement FROM-scope resolution) — or absent from the returned
 * object when there's no confident single match: no direct-equality
 * occurrence at all, an expression/IN/BETWEEN around the column, or two
 * occurrences of the same param name compared to different column NAMES.
 *
 * Occurrences that agree on the column name but differ in *qualifier text*
 * (`e.status = {s}` and `status = {s}` in the same query) are NOT a conflict
 * here — raw qualifier spelling is not column identity. The entry then also
 * carries `refs`: every distinct `{qualifier, column, pos}` reference, so the
 * resolution step (`from-scope.js`'s `resolveComparisonColumnType`) can decide
 * on RESOLVED identity — it matches only when every ref resolves to the same
 * table (single-table alias + bare form ⇒ match; two JOIN sides ⇒ no match).
 * The top-level `qualifier`/`column`/`pos` stay the first reference's, and
 * `refs` is omitted for the single-reference common case, so consumers of the
 * simple shape are unchanged. Pure.
 * @param {string} sql
 * @returns {Object<string, {qualifier: string|null, column: string, pos: number,
 *                           refs?: {qualifier: string|null, column: string, pos: number}[]}>}
 */
export function paramComparisonColumns(sql) {
  const text = String(sql || '');
  const occurrences = scanParamOccurrences(text);
  if (!occurrences.length) return {};
  const sig = significantTokensWithParams(text, occurrences);
  const found = {}; // name -> ref | 'CONFLICT'
  for (let k = 0; k < sig.length; k++) {
    if (!isOp(text, sig[k], '=')) continue;
    if (isParam(sig[k - 1])) {
      const ref = parseColumnRefForward(text, sig, k + 1);
      if (ref) record(found, sig[k - 1].name, { qualifier: ref.qualifier, column: ref.column, pos: sig[k - 1].start });
    }
    if (isParam(sig[k + 1])) {
      const ref = parseColumnRefBackward(text, sig, k - 1);
      if (ref) record(found, sig[k + 1].name, { qualifier: ref.qualifier, column: ref.column, pos: sig[k + 1].start });
    }
  }
  const out = {};
  for (const [name, v] of Object.entries(found)) {
    if (v === 'CONFLICT') continue;
    out[name] = v.length === 1 ? v[0] : { ...v[0], refs: v };
  }
  return out;
}

// Accumulate the distinct references for one param name, or mark it CONFLICT.
// Column-NAME disagreement is a conflict outright (two differently-named
// columns are genuinely different columns, whatever they resolve to);
// qualifier-text disagreement over the same column name is kept as a second
// ref for the resolution step to adjudicate (see paramComparisonColumns's doc).
function record(found, name, ref) {
  const cur = found[name];
  if (cur === 'CONFLICT') return;
  if (!cur) { found[name] = [ref]; return; }
  if (cur[0].column !== ref.column) { found[name] = 'CONFLICT'; return; }
  if (!cur.some((r) => r.qualifier === ref.qualifier)) cur.push(ref);
}
