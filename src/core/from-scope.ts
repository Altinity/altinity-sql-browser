// FROM/JOIN scope resolution for FROM-aware autocompletion (#84). Pure: no DOM,
// no globals. Given editor text + a caret offset, `fromScopeAt` returns the base
// tables in scope for the statement the caret sits in — each `{db, table, alias}`
// — so completion can (1) resolve an alias (`e.` → `events`), (2) scope
// unqualified column suggestions to the statement's FROM/JOIN tables, and (3)
// drive the debounced lazy-load of those tables' columns.
//
// It reuses the shared structural lexer (sql-lex.js `lexSql`) so a `FROM` inside
// a string/comment, or a `;` inside a literal, never fools the parse: the lexer
// classifies strings/heredocs/comments/quoted-idents as opaque tokens, and a
// top-level `;` is always a bare `punct` token with direct source offsets.
//
// Non-goals (v1, per the issue): CTE / subquery-derived column scopes,
// `USING`/correlated-subquery resolution, `SELECT *` expansion, table functions
// (`FROM numbers(…)`). Those are skipped, not resolved — only real base tables
// named in FROM/JOIN are returned.

import { lexSql, isWord, unquoteIdent, tokenText } from './sql-lex.js';
import type { Token } from './sql-lex.js';
import { SQL_KEYWORDS } from './sql-reference.js';

// Bare words that must never be read as a table alias but aren't in
// SQL_KEYWORDS.
const NON_ALIAS = new Set(['USING', 'WINDOW', 'QUALIFY']);
// Implicit-alias stop set: the uppercased fallback SQL keyword set unioned with
// NON_ALIAS. The old tokenizer prevented keywords from becoming implicit aliases
// by typing them `keyword`; now every bare token is `word`, so this preserves
// that behavior explicitly (#182). Only consulted for an *implicit* alias — an
// explicit `AS x` accepts any word or quoted identifier (server grammar).
const ALIAS_STOP = new Set<string>([...SQL_KEYWORDS, ...NON_ALIAS]);

/** One resolved FROM/JOIN base-table reference — `db`/`alias` are `null` when
 *  absent from the SQL. */
export interface TableRef {
  db: string | null;
  table: string;
  alias: string | null;
}

/** One db's cached schema entry, as `from-scope.js`'s consumers (the schema
 *  panel/completion cache — `app.js`'s `schema` signal) hold it: `tb.columns`
 *  starts absent/`null`, becomes `'loading'` mid-fetch, then a real array. */
export interface SchemaColumn {
  name: string;
  type: string;
  [k: string]: unknown;
}
export interface SchemaTable {
  name: string;
  columns?: SchemaColumn[] | 'loading' | null;
}
export interface SchemaDb {
  db: string;
  tables?: SchemaTable[];
}

/** The looser schema shape `pendingColumnLoads` reads — it only ever checks
 *  whether `tb.columns` is an array/`'loading'`/absent, never a column's own
 *  fields, so (unlike `SchemaDb` above) a table's columns need no particular
 *  element shape. */
export interface PendingLoadTable {
  name: string;
  columns?: unknown[] | 'loading' | null;
}
export interface PendingLoadDb {
  db: string;
  tables?: PendingLoadTable[];
}

// The tokens of the statement containing `pos`, selected by semicolon offsets
// (`;` is a bare `punct` token — literals/comments are opaque, so their `;`
// never reaches here). Whitespace before a `;` (and the caret exactly at the
// `;` start) belongs to the preceding statement; the caret at the `;` end
// offset (and whitespace after it) belongs to the following statement; a caret
// beyond the final token stays in the final statement (#182).
function statementTokensAt(s: string, toks: Token[], pos: number): Token[] {
  let cur: Token[] = [];
  for (const t of toks) {
    if (t.kind === 'punct' && s[t.start] === ';') {
      if (pos <= t.start) return cur; // caret is before/at this `;`
      cur = []; // caret is past this `;` — start the next statement
      continue;
    }
    cur.push(t);
  }
  return cur; // caret is in the final statement (beyond the last `;`)
}

const isDot = (s: string, t: Token | undefined): boolean => !!t && t.kind === 'punct' && s[t.start] === '.';
const isComma = (s: string, t: Token | undefined): boolean => !!t && t.kind === 'punct' && s[t.start] === ',';
const isOpenParen = (s: string, t: Token | undefined): boolean => !!t && t.kind === 'punct' && s[t.start] === '(';
const isIdent = (t: Token | undefined): boolean => !!t && (t.kind === 'word' || t.kind === 'quoted-ident');
// A bare `word` in the fallback keyword/NON_ALIAS set is a clause keyword, not
// an implicit alias. A `quoted-ident` is always a valid alias (backtick-quoted).
const isAliasStop = (s: string, t: Token): boolean => t.kind === 'word' && ALIAS_STOP.has(tokenText(s, t).toUpperCase());

// Parse a single table reference starting at `i` in the significant-token list,
// pushing `{db, table, alias}` to `refs` when it names a real base table.
// Returns the index just past what it consumed. Bails (adds nothing) on a `(`
// (subquery / table function) — those are non-goals.
function parseTableRef(s: string, sig: Token[], i: number, refs: TableRef[]): number {
  const t = sig[i];
  if (!isIdent(t)) return i;
  let db: string | null = null;
  let table = unquoteIdent(s, t);
  let j = i + 1;
  if (isDot(s, sig[j]) && isIdent(sig[j + 1])) {
    db = table;
    table = unquoteIdent(s, sig[j + 1]);
    j += 2;
  }
  if (isOpenParen(s, sig[j])) return j; // table function / subquery alias form — skip
  let alias: string | null = null;
  if (isWord(s, sig[j], 'AS') && isIdent(sig[j + 1])) {
    alias = unquoteIdent(s, sig[j + 1]);
    j += 2;
  } else if (isIdent(sig[j]) && !isAliasStop(s, sig[j])) {
    alias = unquoteIdent(s, sig[j]);
    j += 1;
  }
  refs.push({ db, table, alias });
  return j;
}

// Parse a comma-separated list of table refs (the FROM list) starting at `i`.
function parseFromList(s: string, sig: Token[], i: number, refs: TableRef[]): number {
  let j = parseTableRef(s, sig, i, refs);
  while (isComma(s, sig[j])) j = parseTableRef(s, sig, j + 1, refs);
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
 * pre-computed `lexSql(text)` so the completion path lexes once. Pure.
 */
export function fromScopeAt(text: string | null | undefined, pos: number, toks?: Token[]): TableRef[] {
  const s = String(text || '');
  const p = Math.max(0, Math.min(pos | 0, s.length));
  const stmt = statementTokensAt(s, toks || lexSql(s), p);
  // Comments and opaque strings/heredocs can't supply FROM/JOIN or punctuation;
  // quoted identifiers stay (a table/alias can be backtick-quoted).
  const sig = stmt.filter((t) => t.kind !== 'comment' && t.kind !== 'string');
  const refs: TableRef[] = [];
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    if (isWord(s, t, 'FROM')) {
      i = parseFromList(s, sig, i + 1, refs) - 1;
    } else if (isWord(s, t, 'JOIN') && !isWord(s, sig[i - 1], 'ARRAY')) {
      // `ARRAY JOIN arr` unnests an array column, not a table — don't scope it.
      i = parseTableRef(s, sig, i + 1, refs) - 1;
    }
  }
  return dedupe(refs);
}

// Drop duplicate refs (self-joins, repeated names) by db+table+alias identity.
// JSON.stringify keys the tuple unambiguously — identifiers may contain spaces
// (backtick-quoted), so a plain-delimiter key could collide.
function dedupe(refs: TableRef[]): TableRef[] {
  const seen = new Set<string>();
  const out: TableRef[] = [];
  for (const r of refs) {
    const key = JSON.stringify([r.db, r.table, r.alias]);
    if (!seen.has(key)) { seen.add(key); out.push(r); }
  }
  return out;
}

/** One syntactic param↔column comparison reference (`param-comparison.js`'s
 *  `paramComparisonColumns` shape) — the input `resolveComparisonColumnType`
 *  resolves against the FROM scope + schema cache. */
export interface ComparisonRef {
  qualifier: string | null;
  column: string;
  refs?: { qualifier: string | null; column: string; pos: number }[];
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
 * @param text the workbench SQL
 * @param pos the param occurrence's char offset (paramComparisonColumns's `pos`)
 * @param ref
 * @param schema
 */
export function resolveComparisonColumnType(
  text: string, pos: number, ref: ComparisonRef, schema: SchemaDb[] | null | undefined,
): string | null {
  const refs = ref.refs || [{ qualifier: ref.qualifier, column: ref.column, pos }];
  let target: { key: string; db: string | null; table: string } | null = null; // the single {db, table} every reference must agree on
  for (const r of refs) {
    const scope = fromScopeAt(text, r.pos);
    const candidates = scope.filter((s) => r.qualifier == null || s.alias === r.qualifier || s.table === r.qualifier);
    if (candidates.length !== 1) return null;
    const key = JSON.stringify([candidates[0].db, candidates[0].table]);
    if (target != null && target.key !== key) return null; // refs name different tables
    target = { key, db: candidates[0].db, table: candidates[0].table };
  }
  // `!`: the loop above always runs at least once (refs has >= 1 entry — either
  // ref.refs or the single-element fallback array) and returns early whenever a
  // candidate check fails, so reaching here means `target` was assigned.
  const { db, table } = target!;
  let found: string | null = null;
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
export function pendingColumnLoads(
  scope: { db?: string | null; table: string | null }[] | null | undefined,
  schema: PendingLoadDb[] | null | undefined,
): { db: string; table: string }[] {
  const out: { db: string; table: string }[] = [];
  const seen = new Set<string>();
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
