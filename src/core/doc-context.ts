// Pure, kind-neutral "what does this word refer to" classifier for the CM6
// documentation feature (#313 Phase 1 — function/aggregate recognition and
// literal suppression; #314 Phase 2 — structured strong-context routing:
// FORMAT clause, table/database ENGINE, and data-type positions). Given a SQL
// string, a caret/hover position, and the currently-loaded reference data,
// resolves at most one `DocTarget` — or `null` when nothing strong resolves
// there.
//
// No DOM, no CM6 syntax tree, no SQL. Caller contract: CM6-level literal
// suppression stays the CALLER's job (codemirror-adapter.ts's `LITERAL_NODE`
// check runs FIRST, and the caller does not call in at all when the position
// sits inside a literal node). The #314 positional contexts additionally lex
// the statement themselves (core/sql-lex.ts), so their own matching already
// distinguishes comment/string/quoted-identifier tokens from bare words —
// belt on top of the caller's braces, not a replacement for them: the Phase 1
// bare-word function lookup below still has no literal awareness of its own. There is deliberately no
// `suppressed` boolean parameter here: threading one through would let a
// caller "ask anyway and get null" for a case it already knows the answer to,
// and it would give this pure module a second responsibility (literal
// awareness) it has no data to honor correctly — the single early-return the
// caller already needs is simpler than a flag it has to remember to pass.
//
// #314 ranking (strongest-first — the first one that matches wins):
//   1. top-level `FORMAT Name` (statement-tail FORMAT clause, either
//      FORMAT/SETTINGS order) — never the `format()`/`formatDateTime()`
//      function calls, because those never place a bare word directly after
//      a bare `FORMAT` word token (a call's next token is always `(`);
//   2. `ENGINE = Name` — 'table-engine', or 'database-engine' when the
//      statement head is `CREATE|ATTACH DATABASE`;
//   3. strong data-type positions — `CAST(expr AS Type)`, `expr::Type`,
//      `{name:Type}` query parameters, and column definitions inside a
//      `CREATE|ATTACH TABLE (...)` column list — nested types resolve
//      whichever type token the caret itself sits on (Array(Tuple(String,
//      UInt64)) with the caret on UInt64 → UInt64), since the region check
//      only asks "is the caret's own word token inside this type-expression
//      span", not "what is the outermost name";
//   4. the Phase 1 function/aggregate lookup, unchanged.
// Engine/type positions are purely POSITIONAL — the server lookup is what
// decides found/missing, so no known-name list is needed for them. FORMAT
// (like the function lookup) is validated against a known-name list when the
// caller supplies one (`options.formats`, e.g. `AssembledReference.formats`)
// so an incidental "FORMAT <word>" fragment that isn't a real format name
// falls through instead of asserting a bogus target; omitting it keeps the
// looser purely-positional check (useful before reference data has loaded).

import { lexSql, tokenText } from './sql-lex.js';
import type { Token } from './sql-lex.js';
import { scanParamOccurrences } from './param-scan.js';
import { SQL_KEYWORDS } from './sql-reference.js';
import type { CompletionFunctionEntry } from './completions.js';
import { wordAt } from './completions.js';
import type { DocKind, DocTarget } from './doc-types.js';

/** One resolved functions-table match: the exact key the lookup matched
 *  under (case may differ from the word as typed — this is the "canonical"
 *  name, e.g. the server's lowercase `system.functions` key) and its entry. */
export interface FunctionMatch {
  key: string;
  entry: CompletionFunctionEntry;
}

// Own properties only: a column/identifier named `constructor` must not
// resolve a phantom `Object.prototype` entry.
function own<T>(m: Record<string, T>, k: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined;
}

/**
 * Case-insensitive functions-table lookup: exact match, then lowercase, then
 * UPPERCASE — SQL function calls are case-insensitive, and this mirrors the
 * server's mostly-canonical-lowercase keys (the old editor-intel `lookupFn`
 * behavior, #27/#313). Returns the matched key alongside the entry so a
 * caller can report the canonical name from the reference data rather than
 * the case the user happened to type.
 */
export function lookupFunctionEntry(
  functions: Record<string, CompletionFunctionEntry>, word: string,
): FunctionMatch | undefined {
  const exact = own(functions, word);
  if (exact) return { key: word, entry: exact };
  const lower = word.toLowerCase();
  const lowerEntry = own(functions, lower);
  if (lowerEntry) return { key: lower, entry: lowerEntry };
  const upper = word.toUpperCase();
  const upperEntry = own(functions, upper);
  if (upperEntry) return { key: upper, entry: upperEntry };
  return undefined;
}

// `system.functions`/the built-in fallback only ever tags an entry 'agg'
// (aggregate) or 'fn'/'cast' (scalar) — see CompletionFunctionEntry's own
// doc comment. The catalog (schema-catalog-service.ts) re-normalizes the
// TRUE kind from the fetched row regardless (its documented kind-mismatch
// policy), so this is only ever a best-effort seed for the request, never
// trusted as the final answer.
function kindFor(entry: CompletionFunctionEntry): DocKind {
  return entry.kind === 'agg' ? 'aggregate-function' : 'function';
}

/** Build the `DocTarget` for an already-matched functions-table entry. */
export function docTargetForMatch(match: FunctionMatch): DocTarget {
  return { kind: kindFor(match.entry), name: match.key };
}

/** Options threaded into `resolveDocTarget` for #314's structured contexts.
 *  Optional and additive — omitting it keeps exact Phase 1 behavior (plus
 *  the purely-positional engine/type contexts, which need no list at all). */
export interface DocContextOptions {
  /** Known output-format names (case-insensitive), e.g.
   *  `AssembledReference.formats` (core/completions.ts) — validates a
   *  FORMAT-clause match the same way the function lookup validates a known
   *  function, so a `FORMAT <word>` fragment whose word isn't a real format
   *  doesn't assert a target. Omit to skip the check (still gated on the
   *  FORMAT-keyword *position*, which is the actual false-positive risk vs.
   *  `format()`/`formatDateTime()`). */
  formats?: string[] | null;
}

// ── Statement scoping ───────────────────────────────────────────────────────

// The [start, end) token-index range (into `toks`) of the statement
// containing `pos` — mirrors `from-scope.ts`'s own `statementTokensAt`
// (semicolon-delimited via the structural lexer's bare `punct` tokens, so a
// `;` inside a string/comment/quoted-ident never splits a statement) but
// keeps indices (not just a token slice) so callers can build a
// statement-local paren/depth map. Whitespace before a `;` (and the caret
// exactly at its start) belongs to the preceding statement; the caret past it
// belongs to the next; a caret beyond the final token stays in the final
// statement.
function statementBoundsAt(text: string, toks: Token[], pos: number): { start: number; end: number } {
  let start = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'punct' && text[t.start] === ';') {
      if (pos <= t.start) return { start, end: i };
      start = i + 1;
    }
  }
  return { start, end: toks.length };
}

// The index of the `word` token (within `toks`) containing `pos`, or -1. `pos`
// at either edge of the token counts (matches `completions.ts`'s `wordAt`
// convention — a caret right after the last character still resolves).
function wordTokenIndexAt(toks: Token[], pos: number): number {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'word' && pos >= t.start && pos <= t.end) return i;
  }
  return -1;
}

// ── FORMAT clause ────────────────────────────────────────────────────────────

// `toks[posIdx]` resolves as a FORMAT-clause target when the token directly
// before it is a bare `word` spelling FORMAT (case-insensitive). This is
// exactly what tells the clause apart from the `format()`/`formatDateTime()`
// calls: a call's next token after the function-name word is always `(`
// (never a second bare word), so `FORMAT Name` (the clause) and `format(...)`
// (the call) never produce the same adjacency. No paren-depth check is
// needed for the same reason. When `formats` is supplied, the resolved name
// must match a known format (case-insensitively) — mirrors the function
// lookup's existence gate.
function formatTarget(text: string, toks: Token[], posIdx: number, formats?: string[] | null): DocTarget | null {
  const prev = toks[posIdx - 1];
  if (!prev || prev.kind !== 'word' || tokenText(text, prev).toUpperCase() !== 'FORMAT') return null;
  const name = tokenText(text, toks[posIdx]);
  if (formats && formats.length && !formats.some((f) => f.toLowerCase() === name.toLowerCase())) return null;
  return { kind: 'format', name };
}

// ── ENGINE = Name (table / database DDL) ────────────────────────────────────

// Index of the statement's structural head: the first non-comment token. A
// header `-- note` / `/* … */` before a DDL statement must not hide its
// CREATE/ATTACH keyword (from-scope.ts filters comments the same way).
// -1 (no non-comment token) just flows into the callers' `!head` bail —
// `stmtToks[-1]` is `undefined`.
const stmtHeadIdx = (stmtToks: Token[]): number => stmtToks.findIndex((t) => t.kind !== 'comment');

// True when the statement's head is `CREATE|ATTACH DATABASE` (scanned up to
// the first `(`/`=` so a database name containing those chars in a quoted
// identifier can't fool it) — the sole thing distinguishing a database engine
// from a table engine, both spelled `ENGINE = Name`.
function isDatabaseDDL(text: string, stmtToks: Token[]): boolean {
  const headIdx = stmtHeadIdx(stmtToks);
  const head = stmtToks[headIdx];
  if (!head || head.kind !== 'word') return false;
  const h = tokenText(text, head).toUpperCase();
  if (h !== 'CREATE' && h !== 'ATTACH') return false;
  for (let i = headIdx + 1; i < stmtToks.length; i++) {
    const t = stmtToks[i];
    if (t.kind === 'word' && tokenText(text, t).toUpperCase() === 'DATABASE') return true;
    // A top-level `(` (a TABLE's column list) or the `=` of `ENGINE = Name`
    // itself both mean "past the point a DATABASE keyword could appear" —
    // stop scanning either way (a plain `break` so both paths share the
    // single trailing `return false` below, rather than each duplicating it).
    if ((t.kind === 'punct' && text[t.start] === '(') || (t.kind === 'op' && text[t.start] === '=')) break;
  }
  return false;
}

// `toks[posIdx]` resolves as an engine target when it is immediately preceded
// by a bare `=` op token, itself immediately preceded by a bare `word`
// spelling ENGINE. Purely positional/adjacent — a parameterized engine's
// arguments (`ReplicatedMergeTree('/path', 'r')`) sit in tokens AFTER the
// name, so a caret there never satisfies this adjacency (the caret's own word
// token, if any, is preceded by `(`/`,`/a string, never directly by `=`).
function engineTarget(text: string, stmtToks: Token[], posIdx: number): DocTarget | null {
  const eq = stmtToks[posIdx - 1];
  if (!eq || eq.kind !== 'op' || text[eq.start] !== '=') return null;
  const kw = stmtToks[posIdx - 2];
  if (!kw || kw.kind !== 'word' || tokenText(text, kw).toUpperCase() !== 'ENGINE') return null;
  const name = tokenText(text, stmtToks[posIdx]);
  return { kind: isDatabaseDDL(text, stmtToks) ? 'database-engine' : 'table-engine', name };
}

// ── Data-type positions ──────────────────────────────────────────────────────

// Paren nesting info over a statement's tokens: `depth[i]` is the number of
// enclosing `(...)` pairs strictly containing token `i` (an opening/closing
// paren token itself takes the depth of the scope it opens/closes FROM, i.e.
// the same depth on both sides of a pair); `matchClose[i]` is the index of
// the `)` matching an `(` at `i`, or -1 when unmatched (a malformed/unclosed
// construct never resolves a type target through it).
interface ParenInfo { depth: number[]; matchClose: number[] }
function parenInfo(text: string, toks: Token[]): ParenInfo {
  const depth: number[] = new Array(toks.length).fill(0);
  const matchClose: number[] = new Array(toks.length).fill(-1);
  const stack: number[] = [];
  let level = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const c = t.kind === 'punct' ? text[t.start] : '';
    if (c === '(') {
      depth[i] = level;
      stack.push(i);
      level += 1;
    } else if (c === ')') {
      level = level > 0 ? level - 1 : 0;
      const openIdx = stack.pop();
      if (openIdx !== undefined) matchClose[openIdx] = i;
      depth[i] = level;
    } else {
      depth[i] = level;
    }
  }
  return { depth, matchClose };
}

// `SQL_KEYWORDS` minus the three that double as type-constructor names
// (`Array(...)`, `Tuple(...)`, `Map(...)` are themselves valid outer type
// names — the FIRST token of a type region legitimately IS one of these, so
// they must never stop the scan) — plus column/DDL modifier keywords that
// must end a type-expression scan even though they aren't in the general
// `SQL_KEYWORDS` fallback set (`col UInt32 DEFAULT 0` must not swallow
// `DEFAULT 0` into the type region).
const TYPE_CONSTRUCTOR_NAMES = new Set(['ARRAY', 'TUPLE', 'MAP']);
const TYPE_STOP_WORDS = new Set([
  ...[...SQL_KEYWORDS].filter((w) => !TYPE_CONSTRUCTOR_NAMES.has(w)),
  'DEFAULT', 'MATERIALIZED', 'ALIAS', 'CODEC', 'COMMENT', 'TTL', 'EPHEMERAL',
]);

// The exclusive end index of the type expression starting at token `start`
// (same statement-local `toks`/`info`): scans forward at `start`'s own paren
// depth, stopping at the first same-depth `,`/`)`/`;`, a shallower depth (the
// enclosing construct closed), or a same-depth stop keyword. A deeper depth
// (nested generic args, e.g. `Array(Tuple(...))`) is part of the expression
// and never stops the scan — this is what lets a caret anywhere inside a
// nested type resolve to its own innermost token, not just the outermost name.
function typeExprEnd(text: string, toks: Token[], info: ParenInfo, start: number): number {
  if (start >= toks.length) return start;
  const baseDepth = info.depth[start];
  let i = start;
  for (; i < toks.length; i++) {
    const t = toks[i];
    const d = info.depth[i];
    if (d < baseDepth) return i;
    if (d === baseDepth) {
      if (t.kind === 'punct') {
        const c = text[t.start];
        if (c === ',' || c === ')' || c === ';') return i;
      }
      if (t.kind === 'word' && TYPE_STOP_WORDS.has(tokenText(text, t).toUpperCase())) return i;
    }
  }
  return i;
}

// True when `posIdx` sits inside some `CAST(expr AS Type)`'s type region —
// scans every `CAST(` call whose parens contain `posIdx`, and within each,
// looks for a same-depth `AS` token; a match requires `posIdx` to come AFTER
// that `AS` (before it is the expr side, not the type). Nested casts
// (`CAST(CAST(y AS Int32) AS String)`) resolve correctly with no extra
// bookkeeping: the inner call's own tokens sit inside the outer's type region
// too, but the inner iteration's own (deeper, correct) `AS` is what actually
// matches when `posIdx` is on the inner type — the outer iteration's check
// against ITS `AS` fails first (`posIdx` is before it, since it's part of the
// outer's expr) and simply continues to the next `CAST(`.
function inCastTypeRegion(text: string, toks: Token[], info: ParenInfo, posIdx: number): boolean {
  for (let i = 0; i < toks.length - 1; i++) {
    if (toks[i].kind !== 'word' || tokenText(text, toks[i]).toUpperCase() !== 'CAST') continue;
    const open = i + 1;
    const openTok = toks[open];
    if (!openTok || openTok.kind !== 'punct' || text[openTok.start] !== '(') continue;
    const close = info.matchClose[open];
    if (close < 0 || !(posIdx > open && posIdx < close)) continue;
    const baseDepth = info.depth[open] + 1;
    let asIdx = -1;
    for (let j = open + 1; j < close; j++) {
      if (info.depth[j] === baseDepth && toks[j].kind === 'word' && tokenText(text, toks[j]).toUpperCase() === 'AS') {
        asIdx = j;
        break;
      }
    }
    if (asIdx < 0 || posIdx <= asIdx) continue;
    const end = typeExprEnd(text, toks, info, asIdx + 1);
    if (posIdx < Math.min(end, close)) return true;
  }
  return false;
}

// True when `posIdx` sits inside some `expr::Type`'s type region — a bare
// `::` is two adjacent single-char `other`-kind tokens (the structural lexer
// has no compound `::` operator), immediately followed by a `word` token
// (the type's first name).
function inDoubleColonTypeRegion(text: string, toks: Token[], info: ParenInfo, posIdx: number): boolean {
  for (let i = 0; i < toks.length - 1; i++) {
    const a = toks[i];
    const b = toks[i + 1];
    if (a.kind !== 'other' || text[a.start] !== ':') continue;
    if (b.kind !== 'other' || text[b.start] !== ':' || b.start !== a.end) continue;
    const typeStart = i + 2;
    if (typeStart >= toks.length || toks[typeStart].kind !== 'word') continue;
    const end = typeExprEnd(text, toks, info, typeStart);
    if (posIdx >= typeStart && posIdx < end) return true;
  }
  return false;
}

// True when `posIdx` sits inside a `{name:Type}` query-parameter's type
// region — reuses `param-scan.ts`'s `scanParamOccurrences` (the same
// detection `query-params.ts` builds on) for the whole `{...}` span, then
// locates the separating `:` by character offset (a param name never
// contains one, so the first `:` after the opening brace is always it).
// Character-offset based (not token-index based, unlike the other three
// checks) — simpler here since the occurrence already carries exact bounds,
// and it composes fine: the caller still requires `posIdx` (a real word
// token) to exist before building a target off this.
function inParamTypeRegion(text: string, pos: number): boolean {
  for (const occ of scanParamOccurrences(text)) {
    const colon = text.indexOf(':', occ.start + 1);
    if (colon < 0 || colon >= occ.end) continue;
    const typeStart = colon + 1;
    const typeEnd = occ.end - 1; // one before the closing '}'
    if (pos >= typeStart && pos <= typeEnd) return true;
  }
  return false;
}

// True when `posIdx` sits inside a column definition's type region within a
// `CREATE|ATTACH TABLE ... (...)` column list: the statement head is
// CREATE/ATTACH, a `TABLE` keyword appears before the list's opening paren,
// that paren is preceded by an identifier (the table name) and sits at
// top level (depth 0), and `posIdx` falls in some entry's post-name span.
function inColumnListTypeRegion(text: string, stmtToks: Token[], info: ParenInfo, posIdx: number): boolean {
  const headIdx = stmtHeadIdx(stmtToks);
  const head = stmtToks[headIdx];
  if (!head || head.kind !== 'word') return false;
  const h = tokenText(text, head).toUpperCase();
  if (h !== 'CREATE' && h !== 'ATTACH') return false;
  let tableIdx = -1;
  for (let i = headIdx + 1; i < stmtToks.length; i++) {
    const t = stmtToks[i];
    if (t.kind === 'punct' && text[t.start] === '(') break; // list starts before any TABLE seen
    if (t.kind === 'word' && tokenText(text, t).toUpperCase() === 'TABLE') { tableIdx = i; break; }
  }
  if (tableIdx < 0) return false;
  for (let i = tableIdx + 1; i < stmtToks.length; i++) {
    const t = stmtToks[i];
    if (t.kind === 'punct' && text[t.start] === '(' && info.depth[i] === 0) {
      const prev = stmtToks[i - 1];
      if (!prev || (prev.kind !== 'word' && prev.kind !== 'quoted-ident')) return false;
      const close = info.matchClose[i];
      if (close < 0) return false;
      return columnEntryMatches(text, stmtToks, info, i, close, posIdx);
    }
  }
  return false;
}

// Non-column entries a column list may also contain — a name here is not a
// column's type, so those entries are skipped entirely.
const NON_COLUMN_ENTRY = new Set(['INDEX', 'CONSTRAINT', 'PROJECTION']);

// Splits the column list `(open, close)` into comma-separated entries (at the
// list's own depth) and checks whether `posIdx` falls in some entry's
// post-name type span (trimmed by `typeExprEnd`, so column modifiers like
// `DEFAULT`/`CODEC` after the type never count).
function columnEntryMatches(text: string, toks: Token[], info: ParenInfo, open: number, close: number, posIdx: number): boolean {
  const baseDepth = info.depth[open] + 1;
  let entryStart = open + 1;
  for (let i = open + 1; i <= close; i++) {
    const atBoundary = i === close || (info.depth[i] === baseDepth && toks[i].kind === 'punct' && text[toks[i].start] === ',');
    if (!atBoundary) continue;
    if (entryStart < i) {
      const first = toks[entryStart];
      const isName = first.kind === 'word' || first.kind === 'quoted-ident';
      const firstWord = first.kind === 'word' ? tokenText(text, first).toUpperCase() : '';
      if (isName && !NON_COLUMN_ENTRY.has(firstWord)) {
        const typeStart = entryStart + 1;
        const end = Math.min(typeExprEnd(text, toks, info, typeStart), i);
        if (posIdx >= typeStart && posIdx < end) return true;
      }
    }
    entryStart = i + 1;
  }
  return false;
}

/**
 * Resolve the documentation target at `pos` in `text`, ranked strongest-first
 * (see the module doc comment): a top-level FORMAT clause, an `ENGINE = Name`
 * (table or database DDL), a strong data-type position, then the Phase 1
 * function/aggregate lookup against `functions` (case-insensitively — see
 * `lookupFunctionEntry`). Returns `null` when nothing strong resolves there —
 * no word at all, or a word that doesn't match any of the above.
 * `text`/`pos` need only cover enough context to contain the word at `pos` —
 * a caller may pass the whole document or just the current line for the
 * Phase 1 function fallback (identifiers never span lines); the structured
 * contexts (FORMAT/ENGINE/data-type) need the surrounding statement, so a
 * caller exercising those passes the whole document, exactly like this
 * module's own tests and `codemirror-adapter.ts`'s F1 command do.
 */
export function resolveDocTarget(
  text: string, pos: number,
  functions: Record<string, CompletionFunctionEntry>,
  options?: DocContextOptions,
): DocTarget | null {
  const allToks = lexSql(text);
  const { start, end } = statementBoundsAt(text, allToks, pos);
  const stmtToks = allToks.slice(start, end);
  const posIdx = wordTokenIndexAt(stmtToks, pos);
  if (posIdx >= 0) {
    const fmt = formatTarget(text, stmtToks, posIdx, options?.formats);
    if (fmt) return fmt;
    const engine = engineTarget(text, stmtToks, posIdx);
    if (engine) return engine;
    const info = parenInfo(text, stmtToks);
    if (
      inCastTypeRegion(text, stmtToks, info, posIdx)
      || inDoubleColonTypeRegion(text, stmtToks, info, posIdx)
      || inColumnListTypeRegion(text, stmtToks, info, posIdx)
    ) {
      return { kind: 'data-type', name: tokenText(text, stmtToks[posIdx]) };
    }
  }
  const w = wordAt(text, pos);
  if (posIdx >= 0 && inParamTypeRegion(text, pos)) {
    return { kind: 'data-type', name: tokenText(text, stmtToks[posIdx]) };
  }
  if (!w) return null;
  const match = lookupFunctionEntry(functions, w.word);
  if (!match) return null;
  return docTargetForMatch(match);
}
