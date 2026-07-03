// Pure completion logic for the SQL editor (#25/#26). No DOM, no globals.
//
// Reference data (keywords + function metadata) is loaded once per connection
// from ClickHouse system tables (see net/ch-client.js loadReferenceData) and
// assembled here into the in-memory shape the editor reads on the keystroke
// path — never a query per keystroke. `assembleReferenceData` falls back to the
// built-in tokenizer sets when the server didn't supply them.

import { SQL_KEYWORDS, SQL_FUNCS, tokenize } from './sql-highlight.js';
import { quoteIdent, unquoteIdent } from './format.js';

const BUILTIN_KEYWORDS = [...SQL_KEYWORDS];
const BUILTIN_FUNCS = [...SQL_FUNCS];

// Common ClickHouse output formats — the fallback for FORMAT-clause completion
// when system.formats isn't available (offline / old server / denied). The live
// set (all is_output formats) replaces this once a connection loads.
const BUILTIN_FORMATS = [
  'CSV', 'CSVWithNames', 'JSON', 'JSONCompact', 'JSONEachRow', 'Markdown', 'Null',
  'Parquet', 'Pretty', 'PrettyCompact', 'TabSeparated', 'TabSeparatedWithNames',
  'TSV', 'TSVWithNames', 'Values', 'Vertical', 'XML',
];

// Clause keywords that share a name with an obscure function — typing the prefix
// almost always means the clause, so let the keyword win that tie once the user
// has typed enough to mean it. Deliberately tiny: most keyword/function name
// clashes (min, max, replace, left, in, like, …) should keep favoring the
// function, so only FORMAT (clause vs the rarely-used format() function) is here.
const PREFER_KEYWORD = new Set(['FORMAT']);

// Built-in hover docs for a few ClickHouse-specific keywords (#27). There's no
// server table for keyword docs, so this static set covers the high-value ones;
// function docs come from system.functions (loaded per connection).
const KEYWORD_DOCS = {
  PREWHERE: 'ClickHouse filter applied before reading other columns — an optimization over WHERE for selective predicates.',
  FINAL: 'Merges rows with the same key at read time (ReplacingMergeTree etc.). Expensive; avoid on hot paths.',
  SAMPLE: 'Reads a deterministic fraction of data for approximate results. Requires a SAMPLE BY key on the table.',
  LIMIT: 'Caps the number of returned rows. LIMIT n BY expr limits per group.',
  SETTINGS: 'Per-query settings override, e.g. SETTINGS max_threads = 4.',
  FORMAT: 'Sets the output format of the query, e.g. FORMAT JSONEachRow.',
};

/**
 * Turn a loaded reference payload (or null) into the editor's in-memory shape:
 *   { keywords: string[],            // completion candidates
 *     functions: { name: {kind,sig,ret,desc} },
 *     formats: string[],             // output formats for FORMAT-clause completion
 *     keywordDocs: { KW: doc },      // static hover docs
 *     keywordSet: Set<UPPER>,        // tokenizer highlight lookup
 *     funcSet: Set<name> }           // tokenizer highlight lookup
 * Missing pieces fall back to the built-in sets so highlighting + keyword/
 * function/format completion still work offline / on older ClickHouse.
 */
export function assembleReferenceData(loaded) {
  const keywords = loaded && loaded.keywords && loaded.keywords.length
    ? loaded.keywords
    : BUILTIN_KEYWORDS;
  const functions = loaded && loaded.functions && Object.keys(loaded.functions).length
    ? loaded.functions
    : Object.fromEntries(BUILTIN_FUNCS.map((name) => [name, { kind: 'fn', sig: name + '()', ret: '', desc: '' }]));
  const formats = loaded && loaded.formats && loaded.formats.length ? loaded.formats : BUILTIN_FORMATS;
  return {
    keywords,
    functions,
    formats,
    keywordDocs: KEYWORD_DOCS, // for hover docs (#27); static built-in set
    keywordSet: new Set(keywords.map((k) => k.toUpperCase())),
    funcSet: new Set(Object.keys(functions)),
  };
}

/**
 * Build the flat completion candidate list from reference data + the in-memory
 * schema. Schema is the repo shape ([{db, tables:[{name, columns}]}]); only
 * already-loaded columns are included (`tb.columns` is an array, not null /
 * 'loading') — no on-demand column fetch from the completion path (#25/#26).
 */
export function buildCompletions(ref, schema) {
  const items = [];
  for (const k of ref.keywords) {
    items.push({ label: k, kind: 'keyword', insert: k, detail: 'keyword' });
  }
  for (const [name, m] of Object.entries(ref.functions)) {
    const kind = m.kind === 'agg' ? 'agg' : m.kind === 'cast' ? 'cast' : 'fn';
    // The label already shows the function name, so the detail column shows only
    // the parenthesised params — `(s, offset[, …])`, not `substring(s, …)` (#26).
    const sig = m.sig || name + '()';
    const paren = sig.indexOf('(');
    // Insert `name()` and (via caretBack) leave the caret between the parens — a
    // matched pair like typing `(` gives, so accepting never strands a lone `(`.
    items.push({ label: name, kind, insert: name + '()', caretBack: 1, detail: paren >= 0 ? sig.slice(paren) : sig, doc: m.desc || '', ret: m.ret || '' });
  }
  for (const name of ref.formats || []) {
    items.push({ label: name, kind: 'format', insert: name, detail: 'format' });
  }
  for (const db of schema || []) {
    // `label` shows the bare name; `insert` is the SQL-safe (backtick-quoted when
    // needed) identifier so a `…snappy.parquet` table inserts as valid SQL.
    items.push({ label: db.db, kind: 'db', insert: quoteIdent(db.db), detail: 'database' });
    for (const tb of db.tables || []) {
      items.push({ label: tb.name, kind: 'table', insert: quoteIdent(tb.name), detail: 'table', parent: db.db });
      if (Array.isArray(tb.columns)) {
        for (const c of tb.columns) {
          items.push({ label: c.name, kind: 'column', insert: quoteIdent(c.name), detail: c.type, parent: tb.name });
        }
      }
    }
  }
  return items;
}

/**
 * The word being typed at the caret, whether it is qualified (after a dot —
 * `table.` → that table's columns), and whether it sits inside a FORMAT clause
 * (`afterFormat` — the preceding token is FORMAT → complete output-format names).
 * Returns {word, from, to, qualified, parent, afterFormat}.
 */
export function completionContext(value, pos) {
  // The word being typed is either inside an OPEN backtick-quoted identifier (a
  // `non-bare-name… still being typed) or a bare [A-Za-z0-9_] run. We use the SQL
  // tokenizer to find an open backtick so a backtick inside a string/comment (or
  // an escaped `\`` in a closed name) can't fool us. `from` is where an accepted
  // candidate replaces to — the opening backtick in the quoted case, so accepting
  // never doubles the backtick.
  const open = openBacktickStart(value, pos);
  let from;
  let word;
  if (open >= 0) {
    from = open;
    word = value.slice(from + 1, pos); // partial name, unquoted
  } else {
    from = pos;
    while (from > 0 && /[A-Za-z0-9_]/.test(value[from - 1])) from--;
    word = value.slice(from, pos);
  }
  // Inside a FORMAT clause? (the identifier just before the word is `FORMAT`) →
  // complete output-format names instead of the general candidate set.
  let b = from;
  while (b > 0 && /\s/.test(value[b - 1])) b--;
  let pf = b;
  while (pf > 0 && /[A-Za-z0-9_]/.test(value[pf - 1])) pf--;
  const afterFormat = value.slice(pf, b).toUpperCase() === 'FORMAT';
  // Qualified? An identifier (bare OR backtick-quoted) then a dot immediately
  // before the word. parent is the unquoted table name, matched against item.parent.
  let qualified = false;
  let parent = null;
  if (value[from - 1] === '.') {
    // Only qualified when a real identifier precedes the dot. A bare '.' after a
    // non-identifier (`.col`, `).c`, `count().c`) yields '' → normal completion.
    const name = identBefore(value, from - 1);
    if (name) { qualified = true; parent = name; }
  }
  return { word, from, to: pos, qualified, parent, afterFormat };
}

// The start index of an OPEN (still-being-typed) backtick-quoted identifier that
// contains the caret, or -1. Uses the tokenizer so a backtick inside a string or
// comment isn't mistaken for an identifier quote, and an escaped `\`` inside a
// closed name doesn't desync a naive parity count.
function openBacktickStart(value, pos) {
  let off = 0;
  for (const [type, text] of tokenize(value)) {
    const end = off + text.length;
    if (off < pos && pos <= end && type === 'ident' && text[0] === '`') {
      // open = the caret is inside the run before any closing backtick (an
      // unterminated `name… token, or the caret sits before its trailing `).
      const closedAtEnd = pos === end && text.length > 1 && text[text.length - 1] === '`';
      if (!closedAtEnd) return off;
    }
    off = end;
  }
  return -1;
}

// The identifier ending at index `end` (exclusive): a backtick-quoted run
// (returned unquoted/unescaped) or a bare [A-Za-z0-9_] run. '' if neither.
function identBefore(value, end) {
  if (value[end - 1] === '`') {
    const open = value.lastIndexOf('`', end - 2);
    if (open >= 0) return unquoteIdent(value.slice(open, end));
  }
  let p = end;
  while (p > 0 && /[A-Za-z0-9_]/.test(value[p - 1])) p--;
  return value.slice(p, end);
}

/**
 * Rank candidates for `ctx`. Qualified → only that table's columns. Otherwise
 * prefix matches before substring; columns/tables boosted over keywords once
 * ≥1 char is typed. Empty word (and not qualified) → keywords + tables only.
 * Capped for a tight dropdown.
 */
export function rankCompletions(items, ctx) {
  const w = ctx.word.toLowerCase();
  if (ctx.qualified) {
    const cols = items.filter((it) => it.kind === 'column' && it.parent === ctx.parent);
    return (w ? cols.filter((c) => c.label.toLowerCase().includes(w)) : cols).slice(0, 50);
  }
  if (ctx.afterFormat) {
    // FORMAT clause: only output-format names, prefix matches first.
    const fmts = items.filter((it) => it.kind === 'format' && (!w || it.label.toLowerCase().includes(w)));
    if (w) fmts.sort((a, b) => a.label.toLowerCase().indexOf(w) - b.label.toLowerCase().indexOf(w) || a.label.localeCompare(b.label));
    return fmts.slice(0, 50);
  }
  if (!w) {
    return items.filter((it) => it.kind === 'keyword' || it.kind === 'table').slice(0, 40);
  }
  const scored = [];
  for (const it of items) {
    if (it.kind === 'format') continue; // formats only inside a FORMAT clause
    const l = it.label.toLowerCase();
    const idx = l.indexOf(w);
    if (idx === -1) continue;
    let score = idx === 0 ? 0 : 100 + idx;              // prefix beats substring
    if (it.kind === 'column' || it.kind === 'table') score -= 10; // boost schema
    if (it.kind === 'keyword') {
      // A clause keyword sharing a name with an obscure function wins the tie
      // once enough of it is typed (≥3 chars, prefix) — e.g. `for` → FORMAT, not
      // the format() function or formatDateTime; shorter prefixes stay neutral.
      score += (idx === 0 && w.length >= 3 && PREFER_KEYWORD.has(it.label.toUpperCase())) ? -50 : 5;
    }
    score += (l.length - w.length) * 0.1;               // prefer closer length
    scored.push({ it, score });
  }
  scored.sort((a, b) => a.score - b.score || a.it.label.localeCompare(b.it.label));
  return scored.slice(0, 50).map((s) => s.it);
}

/**
 * The identifier word containing `pos` (expands in both directions). Used by
 * hover docs (#27) to find the token under the mouse. Returns {word, from, to}
 * or null when `pos` isn't inside a word.
 */
export function wordAt(value, pos) {
  let s = pos;
  let e = pos;
  while (s > 0 && /[A-Za-z0-9_]/.test(value[s - 1])) s--;
  while (e < value.length && /[A-Za-z0-9_]/.test(value[e])) e++;
  if (s === e) return null;
  return { word: value.slice(s, e), from: s, to: e };
}
