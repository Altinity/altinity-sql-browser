// Pure completion logic for the SQL editor (#25/#26). No DOM, no globals.
//
// Reference data (keywords + function metadata) is loaded once per connection
// from ClickHouse system tables (see net/ch-client.js loadReferenceData) and
// assembled here into the in-memory shape the editor reads on the keystroke
// path — never a query per keystroke. `assembleReferenceData` falls back to the
// built-in tokenizer sets when the server didn't supply them.

import { SQL_KEYWORDS, SQL_FUNCS } from './sql-highlight.js';

const BUILTIN_KEYWORDS = [...SQL_KEYWORDS];
const BUILTIN_FUNCS = [...SQL_FUNCS];

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
 *     keywordSet: Set<UPPER>,        // tokenizer highlight lookup
 *     funcSet: Set<name> }           // tokenizer highlight lookup
 * Missing pieces fall back to the built-in sets so highlighting + keyword/
 * function completion still work offline / on older ClickHouse.
 */
export function assembleReferenceData(loaded) {
  const keywords = loaded && loaded.keywords && loaded.keywords.length
    ? loaded.keywords
    : BUILTIN_KEYWORDS;
  const functions = loaded && loaded.functions && Object.keys(loaded.functions).length
    ? loaded.functions
    : Object.fromEntries(BUILTIN_FUNCS.map((name) => [name, { kind: 'fn', sig: name + '()', ret: '', desc: '' }]));
  return {
    keywords,
    functions,
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
    items.push({ label: name, kind, insert: name + '(', detail: paren >= 0 ? sig.slice(paren) : sig, doc: m.desc || '', ret: m.ret || '' });
  }
  for (const db of schema || []) {
    items.push({ label: db.db, kind: 'db', insert: db.db, detail: 'database' });
    for (const tb of db.tables || []) {
      items.push({ label: tb.name, kind: 'table', insert: tb.name, detail: 'table', parent: db.db });
      if (Array.isArray(tb.columns)) {
        for (const c of tb.columns) {
          items.push({ label: c.name, kind: 'column', insert: c.name, detail: c.type, parent: tb.name });
        }
      }
    }
  }
  return items;
}

/**
 * The word being typed at the caret, and whether it is qualified (after a dot —
 * `table.` → that table's columns). Returns {word, from, to, qualified, parent}.
 */
export function completionContext(value, pos) {
  let s = pos;
  while (s > 0 && /[A-Za-z0-9_]/.test(value[s - 1])) s--;
  const word = value.slice(s, pos);
  let qualified = false;
  let parent = null;
  if (value[s - 1] === '.') {
    let p = s - 1;
    while (p > 0 && /[A-Za-z0-9_]/.test(value[p - 1])) p--;
    const name = value.slice(p, s - 1);
    // Only qualified when a real identifier precedes the dot. A bare '.' after a
    // non-identifier (`.col`, `).c`, `count().c`) would otherwise yield parent=''
    // and an empty dropdown — fall back to normal completion instead (#4 review).
    if (name) { qualified = true; parent = name; }
  }
  return { word, from: s, to: pos, qualified, parent };
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
  if (!w) {
    return items.filter((it) => it.kind === 'keyword' || it.kind === 'table').slice(0, 40);
  }
  const scored = [];
  for (const it of items) {
    const l = it.label.toLowerCase();
    const idx = l.indexOf(w);
    if (idx === -1) continue;
    let score = idx === 0 ? 0 : 100 + idx;              // prefix beats substring
    if (it.kind === 'column' || it.kind === 'table') score -= 10; // boost schema
    if (it.kind === 'keyword') score += 5;
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

/**
 * If `pos` is inside a function call `name(… )`, return {name, argIdx} — the
 * enclosing function and which argument the caret is on (commas counted at
 * depth 0). Used by signature help (#27). Returns null outside a call; a `;` or
 * newline at depth 0 ends the search (don't cross statements/lines).
 */
export function signatureContext(value, pos) {
  let depth = 0;
  let argIdx = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const c = value[i];
    if (c === ')') depth++;
    else if (c === '(') {
      if (depth === 0) {
        let e = i;
        while (e > 0 && /[A-Za-z0-9_]/.test(value[e - 1])) e--;
        const name = value.slice(e, i);
        return name ? { name, argIdx } : null;
      }
      depth--;
    } else if (c === ',' && depth === 0) argIdx++;
    else if ((c === ';' || c === '\n') && depth === 0) return null;
  }
  return null;
}
