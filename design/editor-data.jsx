// editor-data.jsx — reference data for autocomplete, hover docs, signature help
//
// In production this is loaded ONCE per connection (the "keystroke rule" —
// never run SQL on the keystroke path) from ClickHouse system tables:
//   • system.keywords      → dynamic keyword list (feeds the tokenizer too)
//   • system.functions     → names + (where available) signatures
//   • system.completions   → context/belongs-aware completion candidates
//   • system.documentation → hover docs / descriptions (Phase 2c, lazy)
// then cached in memory for the session. Here we hardcode a representative
// slice so the design is concrete and the UX is exercisable offline.

// Keyword list (a superset of the tokenizer's built-in set). The tokenizer
// now accepts these dynamically: tokenize(sql, { keywords, funcs }).
const REF_KEYWORDS = [
  'SELECT','FROM','WHERE','AND','OR','NOT','IN','BETWEEN','LIKE','ILIKE','IS','NULL',
  'GROUP BY','ORDER BY','HAVING','LIMIT','OFFSET','AS','ON','USING','JOIN','INNER',
  'LEFT','RIGHT','OUTER','FULL','CROSS','UNION','ALL','DISTINCT','CASE','WHEN',
  'THEN','ELSE','END','WITH','INSERT','INTO','VALUES','UPDATE','SET','DELETE',
  'CREATE','TABLE','VIEW','MATERIALIZED','INDEX','DROP','ALTER','SHOW','DESCRIBE',
  'EXPLAIN','USE','SETTINGS','FORMAT','PREWHERE','FINAL','SAMPLE','ARRAY JOIN',
  'TOP','ANTI','SEMI','ANY','ASOF','GLOBAL','INTERVAL','TTL','PARTITION BY',
];

// Function reference: name → { sig, ret, desc, kind }
// kind drives the icon/category in the autocomplete dropdown.
const REF_FUNCTIONS = {
  count:          { sig: 'count([x])', ret: 'UInt64', kind: 'agg', desc: 'Counts rows or non-NULL values of x.' },
  sum:            { sig: 'sum(x)', ret: 'numeric', kind: 'agg', desc: 'Sum of values across the group.' },
  avg:            { sig: 'avg(x)', ret: 'Float64', kind: 'agg', desc: 'Arithmetic mean across the group.' },
  min:            { sig: 'min(x)', ret: 'same as x', kind: 'agg', desc: 'Minimum value across the group.' },
  max:            { sig: 'max(x)', ret: 'same as x', kind: 'agg', desc: 'Maximum value across the group.' },
  uniq:           { sig: 'uniq(x, …)', ret: 'UInt64', kind: 'agg', desc: 'Approximate number of distinct values (adaptive HLL).' },
  uniqExact:      { sig: 'uniqExact(x)', ret: 'UInt64', kind: 'agg', desc: 'Exact number of distinct values. Uses more memory than uniq.' },
  quantile:       { sig: 'quantile(level)(x)', ret: 'Float64', kind: 'agg', desc: 'Approximate quantile at level∈[0,1] over x (reservoir sampling).' },
  groupArray:     { sig: 'groupArray([max])(x)', ret: 'Array', kind: 'agg', desc: 'Collects values of x into an array.' },
  any:            { sig: 'any(x)', ret: 'same as x', kind: 'agg', desc: 'Returns the first value encountered in the group.' },
  round:          { sig: 'round(x[, N])', ret: 'numeric', kind: 'fn', desc: 'Rounds x to N decimal places (banker’s rounding).' },
  floor:          { sig: 'floor(x[, N])', ret: 'numeric', kind: 'fn', desc: 'Rounds x down toward negative infinity.' },
  ceil:           { sig: 'ceil(x[, N])', ret: 'numeric', kind: 'fn', desc: 'Rounds x up toward positive infinity.' },
  abs:            { sig: 'abs(x)', ret: 'numeric', kind: 'fn', desc: 'Absolute value of x.' },
  length:         { sig: 'length(x)', ret: 'UInt64', kind: 'fn', desc: 'Number of bytes in a string, or elements in an array.' },
  lower:          { sig: 'lower(s)', ret: 'String', kind: 'fn', desc: 'Lowercases an ASCII string.' },
  upper:          { sig: 'upper(s)', ret: 'String', kind: 'fn', desc: 'Uppercases an ASCII string.' },
  concat:         { sig: 'concat(s1, s2, …)', ret: 'String', kind: 'fn', desc: 'Concatenates the string arguments.' },
  substring:      { sig: 'substring(s, off[, len])', ret: 'String', kind: 'fn', desc: 'Substring starting at 1-based offset.' },
  splitByChar:    { sig: 'splitByChar(sep, s)', ret: 'Array(String)', kind: 'fn', desc: 'Splits s by a single-character separator.' },
  toString:       { sig: 'toString(x)', ret: 'String', kind: 'cast', desc: 'Converts any value to its String representation.' },
  toDate:         { sig: 'toDate(x)', ret: 'Date', kind: 'cast', desc: 'Converts a value or string to a Date.' },
  toDateTime:     { sig: 'toDateTime(x)', ret: 'DateTime', kind: 'cast', desc: 'Converts a value or string to a DateTime.' },
  toUInt32:       { sig: 'toUInt32(x)', ret: 'UInt32', kind: 'cast', desc: 'Casts x to UInt32 (throws on overflow).' },
  toFloat64:      { sig: 'toFloat64(x)', ret: 'Float64', kind: 'cast', desc: 'Casts x to Float64.' },
  toStartOfMonth: { sig: 'toStartOfMonth(d)', ret: 'Date', kind: 'fn', desc: 'Rounds a date/datetime down to the first day of its month.' },
  toStartOfWeek:  { sig: 'toStartOfWeek(d[, mode])', ret: 'Date', kind: 'fn', desc: 'Rounds a date down to the start of its week.' },
  toStartOfDay:   { sig: 'toStartOfDay(d)', ret: 'DateTime', kind: 'fn', desc: 'Rounds a datetime down to 00:00:00 of its day.' },
  formatDateTime: { sig: 'formatDateTime(t, fmt)', ret: 'String', kind: 'fn', desc: 'Formats a datetime using a strftime-like pattern.' },
  now:            { sig: 'now()', ret: 'DateTime', kind: 'fn', desc: 'Current server date and time.' },
  today:          { sig: 'today()', ret: 'Date', kind: 'fn', desc: 'Current server date.' },
  if:             { sig: 'if(cond, then, else)', ret: 'inferred', kind: 'fn', desc: 'Branchless ternary; returns then when cond is non-zero.' },
  multiIf:        { sig: 'multiIf(c1, v1, …, else)', ret: 'inferred', kind: 'fn', desc: 'Chained conditionals — like CASE WHEN, as a function.' },
  coalesce:       { sig: 'coalesce(x, …)', ret: 'inferred', kind: 'fn', desc: 'First non-NULL argument, or NULL if all are NULL.' },
  isNull:         { sig: 'isNull(x)', ret: 'UInt8', kind: 'fn', desc: 'Returns 1 if x is NULL, else 0.' },
  greatest:       { sig: 'greatest(a, b, …)', ret: 'inferred', kind: 'fn', desc: 'Largest of the arguments.' },
  least:          { sig: 'least(a, b, …)', ret: 'inferred', kind: 'fn', desc: 'Smallest of the arguments.' },
  arrayJoin:      { sig: 'arrayJoin(arr)', ret: 'rows', kind: 'fn', desc: 'Unfolds an array, emitting one row per element.' },
};

// Short docs for a few keywords (hover docs, Phase 2c).
const REF_KEYWORD_DOCS = {
  PREWHERE: 'ClickHouse-specific filter applied before reading other columns — an optimization over WHERE for selective predicates.',
  FINAL: 'Forces merge of rows with the same key at read time (ReplacingMergeTree etc.). Expensive; avoid on hot paths.',
  SAMPLE: 'Reads a deterministic fraction of data for approximate results. Requires a SAMPLE BY key on the table.',
  'ARRAY JOIN': 'Joins each row with the elements of one of its array columns, multiplying rows.',
  LIMIT: 'Caps the number of returned rows. LIMIT n BY expr limits per group.',
  SETTINGS: 'Per-query settings override, e.g. SETTINGS max_threads = 4.',
};

// Build the completion candidate list. In production this merges
// system.completions with the loaded schema; here we assemble from
// REF_KEYWORDS + REF_FUNCTIONS + the in-memory SCHEMA (databases, tables,
// and ONLY already-loaded columns — no on-demand column fetch).
function buildCompletions(schema) {
  const items = [];
  REF_KEYWORDS.forEach((k) => items.push({ label: k, kind: 'keyword', insert: k, detail: 'keyword' }));
  Object.entries(REF_FUNCTIONS).forEach(([name, m]) =>
    items.push({ label: name, kind: m.kind === 'agg' ? 'agg' : m.kind === 'cast' ? 'cast' : 'fn',
      insert: name + '(', detail: m.sig, doc: m.desc, ret: m.ret }));
  (schema || []).forEach((db) => {
    items.push({ label: db.name, kind: 'db', insert: db.name, detail: 'database' });
    (db.children || []).forEach((tb) => {
      items.push({ label: tb.name, kind: 'table', insert: tb.name, detail: `table · ${tb.rows} rows` });
      // Only already-loaded columns (table.columns !== null) — matches the
      // resolved decision in #25/#26.
      (tb.columns || []).forEach((c) =>
        items.push({ label: c.name, kind: 'column', insert: c.name, detail: c.type, parent: tb.name }));
    });
  });
  return items;
}

Object.assign(window, {
  REF_KEYWORDS, REF_FUNCTIONS, REF_KEYWORD_DOCS, buildCompletions,
});
