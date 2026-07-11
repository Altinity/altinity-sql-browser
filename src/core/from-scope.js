// FROM/JOIN scope resolution for FROM-aware autocompletion (#84). Pure: no DOM,
// no globals. Given editor text + a caret offset, `fromScopeAt` returns the base
// tables in scope for the statement the caret sits in — each `{db, table, alias}`
// — so completion can (1) resolve an alias (`e.` → `events`), (2) scope
// unqualified column suggestions to the statement's FROM/JOIN tables, and (3)
// drive the debounced lazy-load of those tables' columns.
//
// It reuses the shared SQL tokenizer (sql-highlight.js `tokenize`) so a `FROM`
// inside a string/comment, or a `;` inside a literal, never fools the parse:
// the tokenizer already classifies strings/comments/backtick-idents, and a
// top-level `;` is always a bare `op` token.
//
// Non-goals (v1, per the issue): CTE / subquery-derived column scopes,
// `USING`/correlated-subquery resolution, `SELECT *` expansion, table functions
// (`FROM numbers(…)`). Those are skipped, not resolved — only real base tables
// named in FROM/JOIN are returned.

import { tokenize } from './sql-highlight.js';
import { unquoteIdent } from './format.js';

// Bare words that must never be read as a table alias but aren't in
// SQL_KEYWORDS (so the tokenizer types them as `ident`, not `keyword`).
// SQL_KEYWORDS members are already `keyword`-typed and rejected for free.
const NON_ALIAS = new Set(['USING', 'WINDOW', 'QUALIFY']);

// Tokenize `text` (or reuse a caller's `tokenize` output) and annotate each
// token with its end offset — `tokenize` covers every character exactly once,
// so a running length is enough to map a token to the caret. Only `end` is
// needed (statement selection); the start is never read.
function withOffsets(text, toks) {
  const out = [];
  let off = 0;
  for (const [type, t] of toks || tokenize(text)) {
    off += t.length;
    out.push({ type, text: t, end: off });
  }
  return out;
}

// The tokens of the statement containing `pos`, split on top-level `;` (a bare
// `op` `;` token — literals/comments are their own token types, so their `;`
// never reaches here). `pos` picks the first statement whose text extends to or
// past it; a `pos` sitting in the gap left by a `;` falls to the next statement.
function statementTokensAt(toks, pos) {
  const groups = [];
  let cur = [];
  for (const t of toks) {
    if (t.type === 'op' && t.text === ';') { groups.push(cur); cur = []; continue; }
    cur.push(t);
  }
  groups.push(cur);
  for (const g of groups) {
    if (g.length && g[g.length - 1].end >= pos) return g;
  }
  return groups[groups.length - 1];
}

const isDot = (t) => t && t.type === 'op' && t.text === '.';
const isComma = (t) => t && t.type === 'op' && t.text === ',';
const isOpenParen = (t) => t && t.type === 'op' && t.text === '(';
const isIdent = (t) => t && t.type === 'ident';
const isKeyword = (t, kw) => t && t.type === 'keyword' && t.text.toUpperCase() === kw;

// Parse a single table reference starting at `i` in the significant-token list,
// pushing `{db, table, alias}` to `refs` when it names a real base table.
// Returns the index just past what it consumed. Bails (adds nothing) on a `(`
// (subquery / table function) — those are non-goals.
function parseTableRef(sig, i, refs) {
  const t = sig[i];
  if (!isIdent(t)) return i;
  let db = null;
  let table = unquoteIdent(t.text);
  let j = i + 1;
  if (isDot(sig[j]) && isIdent(sig[j + 1])) {
    db = table;
    table = unquoteIdent(sig[j + 1].text);
    j += 2;
  }
  if (isOpenParen(sig[j])) return j; // table function / subquery alias form — skip
  let alias = null;
  if (isKeyword(sig[j], 'AS') && isIdent(sig[j + 1])) {
    alias = unquoteIdent(sig[j + 1].text);
    j += 2;
  } else if (isIdent(sig[j]) && !NON_ALIAS.has(sig[j].text.toUpperCase())) {
    alias = unquoteIdent(sig[j].text);
    j += 1;
  }
  refs.push({ db, table, alias });
  return j;
}

// Parse a comma-separated list of table refs (the FROM list) starting at `i`.
function parseFromList(sig, i, refs) {
  let j = parseTableRef(sig, i, refs);
  while (isComma(sig[j])) j = parseTableRef(sig, j + 1, refs);
  return j;
}

/**
 * The base tables in scope for the statement containing `pos`: an array of
 * `{db, table, alias}` (db/alias null when absent), in source order, deduped.
 * Handles `db.table`, `table alias`, `table AS alias`, comma joins and `JOIN`s;
 * a table function or a subquery in FROM position (`FROM (…) x`) contributes no
 * ref. Not paren-aware: a subquery elsewhere (`WHERE id IN (SELECT … FROM b)`)
 * still adds its base table `b` — a v1 over-approximation (it over-includes,
 * never wrong-suppresses), since subquery-derived scoping is a non-goal.
 * Returns `[]` when the statement has no FROM. `toks` optionally supplies a
 * pre-computed `tokenize(text)` so the completion path lexes once. Pure.
 */
export function fromScopeAt(text, pos, toks) {
  const s = String(text || '');
  const p = Math.max(0, Math.min(pos | 0, s.length));
  const stmt = statementTokensAt(withOffsets(s, toks), p);
  const sig = stmt.filter((t) => t.type !== 'ws' && t.type !== 'comment');
  const refs = [];
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    if (t.type !== 'keyword') continue;
    const kw = t.text.toUpperCase();
    if (kw === 'FROM') {
      i = parseFromList(sig, i + 1, refs) - 1;
    } else if (kw === 'JOIN' && !isKeyword(sig[i - 1], 'ARRAY')) {
      // `ARRAY JOIN arr` unnests an array column, not a table — don't scope it.
      i = parseTableRef(sig, i + 1, refs) - 1;
    }
  }
  return dedupe(refs);
}

// Drop duplicate refs (self-joins, repeated names) by db+table+alias identity.
// JSON.stringify keys the tuple unambiguously — identifiers may contain spaces
// (backtick-quoted), so a plain-delimiter key could collide.
function dedupe(refs) {
  const seen = new Set();
  const out = [];
  for (const r of refs) {
    const key = JSON.stringify([r.db, r.table, r.alias]);
    if (!seen.has(key)) { seen.add(key); out.push(r); }
  }
  return out;
}

/**
 * #172 v2: resolve a `paramComparisonColumns` (param-comparison.js) syntactic
 * `{qualifier, column}` reference against the FROM scope at `pos` and the
 * loaded `schema` — the referenced column's cached type string, or `null`
 * when it can't be resolved with confidence:
 *   - the qualifier doesn't match exactly one in-scope table (no match, or an
 *     ambiguous one — ties aren't guessed at);
 *   - unqualified, when the statement's scope has anything other than
 *     exactly one table (an unqualified column is only unambiguous in a
 *     single-table query);
 *   - the column isn't loaded (yet) on that table, or (rare) resolves to
 *     conflicting types across more than one same-named table.
 * When `ref` carries `refs` (several distinct qualifier spellings of the same
 * column name — `e.status` and bare `status`), conflict is decided on
 * RESOLVED identity, not qualifier text: every ref must resolve (each at its
 * own `pos`, per the rules above) to the SAME table, else `null` — so an
 * alias-qualified + unqualified pair in a single-table query matches, while
 * the two sides of a JOIN (or anything ambiguous) never does.
 * Matches `pendingColumnLoads`'s own db-qualified-or-not lookup rule. Zero
 * network — only reads what `schema` already holds. Pure.
 * @param {string} text the workbench SQL
 * @param {number} pos the param occurrence's char offset (paramComparisonColumns's `pos`)
 * @param {{qualifier: string|null, column: string,
 *          refs?: {qualifier: string|null, column: string, pos: number}[]}} ref
 * @param {{db: string, tables: {name: string, columns?: any}[]}[]} schema
 * @returns {string|null}
 */
export function resolveComparisonColumnType(text, pos, ref, schema) {
  const refs = ref.refs || [{ qualifier: ref.qualifier, column: ref.column, pos }];
  let target = null; // the single {db, table} every reference must agree on
  for (const r of refs) {
    const scope = fromScopeAt(text, r.pos);
    const candidates = scope.filter((s) => r.qualifier == null || s.alias === r.qualifier || s.table === r.qualifier);
    if (candidates.length !== 1) return null;
    const key = JSON.stringify([candidates[0].db, candidates[0].table]);
    if (target != null && target.key !== key) return null; // refs name different tables
    target = { key, db: candidates[0].db, table: candidates[0].table };
  }
  const { db, table } = target;
  let found = null;
  for (const d of schema || []) {
    if (db != null && d.db !== db) continue;
    for (const tb of d.tables || []) {
      if (tb.name !== table || !Array.isArray(tb.columns)) continue;
      const col = tb.columns.find((c) => c.name === ref.column);
      if (!col) continue;
      if (found != null && found !== col.type) return null; // conflicting types across same-named tables
      found = col.type;
    }
  }
  return found;
}

/**
 * Which of the scope's tables still need their columns fetched: the `{db, table}`
 * entries present in `schema` whose `columns` are neither loaded (an array) nor
 * in-flight (`'loading'`). Matched by db when the ref is db-qualified, else
 * across every db that has a table of that name. Deduped by db+table. Feeds the
 * editor's debounced idle-tick column loader (never the keystroke path). Pure.
 */
export function pendingColumnLoads(scope, schema) {
  const out = [];
  const seen = new Set();
  for (const ref of scope || []) {
    if (!ref.table) continue;
    for (const d of schema || []) {
      if (ref.db != null && d.db !== ref.db) continue;
      for (const tb of d.tables || []) {
        if (tb.name !== ref.table) continue;
        if (Array.isArray(tb.columns) || tb.columns === 'loading') continue;
        const key = JSON.stringify([d.db, tb.name]);
        if (!seen.has(key)) { seen.add(key); out.push({ db: d.db, table: tb.name }); }
      }
    }
  }
  return out;
}
