// Pure capability decision + query construction + row normalization for
// version-exact `system.functions` documentation (#313). No DOM, no fetch, no
// globals — the caller (SchemaCatalogService, a later commit) owns running the
// SQL and caching; this module only decides *what* SQL to run and how to turn
// a raw FORMAT JSON row into the shared `DocEntry` contract (doc-types.ts).
//
// Version policy (#313): actual column availability on `system.columns` is
// authoritative — there is no `serverVersion >= 26.6` gate. `name` is the only
// required column (its absence, or a missing `system.functions` table
// entirely, makes the whole capability unavailable); every other column is
// tracked individually and degrades field-by-field when absent.

import type { DocEntry, DocSummary, DocTarget } from './doc-types.js';

/** Which optional `system.functions` columns are confirmed present on this
 *  connection, plus whether the capability is usable at all. `available` is
 *  false when `name` itself is missing (no `system.functions`, or a shape so
 *  degenerate it can't be queried) — every other flag is only meaningful when
 *  `available` is true. */
export interface FunctionsDocCapability {
  available: boolean;
  isAggregate: boolean;
  aliasTo: boolean;
  description: boolean;
  syntax: boolean;
  arguments: boolean;
  parameters: boolean;
  returnedValue: boolean;
  examples: boolean;
  introducedIn: boolean;
  categories: boolean;
  deterministic: boolean;
  higherOrder: boolean;
  caseInsensitive: boolean;
  origin: boolean;
}

const UNAVAILABLE: FunctionsDocCapability = {
  available: false,
  isAggregate: false,
  aliasTo: false,
  description: false,
  syntax: false,
  arguments: false,
  parameters: false,
  returnedValue: false,
  examples: false,
  introducedIn: false,
  categories: false,
  deterministic: false,
  higherOrder: false,
  caseInsensitive: false,
  origin: false,
};

/**
 * Decide the `system.functions` documentation capability from the column
 * names actually present on `system.columns` for that table (`cols`, in
 * whatever order the caller's probe returned them). `name` is required —
 * without it the whole capability is `unavailable` (missing table, denied
 * access, or an incompatible shape all surface identically here: the caller
 * simply never obtained a `name` column). Every other column degrades
 * independently. Pure.
 */
export function functionsCapabilityFromColumns(cols: string[]): FunctionsDocCapability {
  const set = new Set(cols);
  if (!set.has('name')) return UNAVAILABLE;
  return {
    available: true,
    isAggregate: set.has('is_aggregate'),
    aliasTo: set.has('alias_to'),
    description: set.has('description'),
    syntax: set.has('syntax'),
    arguments: set.has('arguments'),
    parameters: set.has('parameters'),
    returnedValue: set.has('returned_value'),
    examples: set.has('examples'),
    introducedIn: set.has('introduced_in'),
    categories: set.has('categories'),
    deterministic: set.has('deterministic'),
    higherOrder: set.has('higher_order'),
    caseInsensitive: set.has('case_insensitive'),
    origin: set.has('origin'),
  };
}

// Capability flag -> the actual `system.functions` column name, in the
// (stable, deterministic) order the SELECT list is built.
const COLUMN_ORDER: [keyof FunctionsDocCapability, string][] = [
  ['isAggregate', 'is_aggregate'],
  ['aliasTo', 'alias_to'],
  ['description', 'description'],
  ['syntax', 'syntax'],
  ['arguments', 'arguments'],
  ['parameters', 'parameters'],
  ['returnedValue', 'returned_value'],
  ['examples', 'examples'],
  ['introducedIn', 'introduced_in'],
  ['categories', 'categories'],
  ['deterministic', 'deterministic'],
  ['higherOrder', 'higher_order'],
];

/**
 * Build the `SELECT … FROM system.functions WHERE … LIMIT 1 FORMAT JSON`
 * statement for one function/aggregate lookup by name, listing only columns
 * `cap` confirmed available (`name` first, then any confirmed rich columns in
 * `COLUMN_ORDER`). Matches the name case-insensitively via the exact/lower/upper
 * pattern (`name = X OR lower(name) = lower(X) OR upper(name) = upper(X)`).
 * `escape` is the injected SQL-string-escape seam (the caller passes
 * `core/format.js`'s `sqlString`). Returns `null` when the capability is
 * unavailable — there is nothing to query. Pure.
 */
export function buildFunctionDocSelect(
  cap: FunctionsDocCapability,
  name: string,
  escape: (s: string) => string,
): string | null {
  if (!cap.available) return null;
  const columns = ['name', ...COLUMN_ORDER.filter(([flag]) => cap[flag]).map(([, col]) => col)];
  const x = escape(name);
  return (
    'SELECT ' + columns.join(', ') + ' FROM system.functions' +
    ' WHERE name = ' + x + ' OR lower(name) = lower(' + x + ') OR upper(name) = upper(' + x + ')' +
    ' LIMIT 1 FORMAT JSON'
  );
}

// A raw FORMAT JSON cell for a function-doc row: ClickHouse JSON output
// represents UInt8/Nullable(UInt8) as numbers (or JSON `null`), and every text
// column as a string (absent columns are simply not keys on the row, since the
// SELECT never asked for them).
type RawCell = string | number | boolean | null | undefined;

// First non-empty line of a (possibly multi-line / Markdown) cell, trimmed.
// ClickHouse doc cells (system.functions.description/syntax, and #314's
// structured-source description/syntax columns) frequently begin with a
// leading blank line, so skip leading empties and return the first line that
// actually has content. Mirrors ch-client.ts's `firstLine()`. `unknown` (not
// `RawCell`) so this is shared by both the function normalizer (RawCell rows)
// and the #314 structured-source normalizer (whose `related` column may
// legitimately be an array on the same row shape).
function firstLine(s: unknown): string {
  if (!s) return '';
  for (const line of String(s).split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

// Trimmed line looks like a bare thematic break (`---`/`***`/`___`, 3+ of the
// SAME character, nothing else) — matches the construct `doc-markdown.ts`'s
// own `THEMATIC_BREAK_RE` treats as a block-level `break`, kept intentionally
// simpler here since a summary derivation only needs to SKIP the line, not
// parse it.
const THEMATIC_BREAK_ONLY_RE = /^(-{3,}|\*{3,}|_{3,})$/;

// ATX heading marker (`#` through `######` + a required space) at the start
// of a trimmed line — captures the remaining text after the marker.
const HEADING_MARKER_RE = /^#{1,6}\s+(.*)$/;

/**
 * First line of `s` that carries actual PROSE content — i.e. the first line
 * (after trimming) that survives skipping every line that is purely
 * structural Markdown: blank; a Docusaurus admonition marker (`:::tip`, bare
 * `:::`, etc. — any line starting with `:::`); a table row (starts with
 * `|`); a fenced-code delimiter (starts with ```` ``` ````); or a bare
 * thematic break (`---`/`***`/`___`). An ATX heading line (`# Foo`) is NOT
 * skipped — its `#`+space marker (requires at least one space — a bare `#`
 * with no following space is not recognized as a heading marker and is
 * returned as literal prose) is stripped and the remaining text is used as
 * the candidate line (a heading is often the only prose a cell has). Real
 * doc-source Markdown (system.functions/
 * system.data_type_families/system.documentation descriptions) commonly
 * opens with exactly these structural constructs (#315 follow-up, live-
 * verified against a real 26.6.1 server) — a summary/hover-card/
 * disambiguation-row one-liner must never surface one of them literally.
 * Only STRUCTURAL lines are skipped; inline Markdown (links, emphasis,
 * inline code) on an otherwise-prose line is left completely alone — this is
 * deliberately not an inline parse. Shared by every summary derivation across
 * `doc-capability.ts` and `doc-documentation.ts`; NOT used for signature
 * derivation (a signature's `firstLine(syntax)` is a different concern and
 * stays on the plain `firstLine` above). Pure.
 */
export function firstProseLine(s: unknown): string {
  if (!s) return '';
  for (const rawLine of String(s).split('\n')) {
    const t = rawLine.trim();
    if (!t) continue;
    if (t.startsWith(':::')) continue;
    if (t.startsWith('|')) continue;
    if (t.startsWith('```')) continue;
    if (THEMATIC_BREAK_ONLY_RE.test(t)) continue;
    const heading = HEADING_MARKER_RE.exec(t);
    // A matched ATX marker's captured remainder is never itself blank here:
    // `t` was already outer-trimmed above (no trailing whitespace survives),
    // so `HEADING_MARKER_RE`'s trailing `\s+` can only consume LEADING
    // whitespace after the `#`s, never swallow the whole remainder to blank.
    // A heading's trailing Docusaurus explicit-anchor suffix (`Foo {#foo}`,
    // seen live in 26.6 doc bodies) is display noise in a one-liner — drop it.
    if (heading) return heading[1].replace(/\s*\{#[^}]*\}\s*$/, '');
    return t;
  }
  return '';
}

// Trimmed non-empty string, or undefined when absent/blank. Used for the
// simple pass-through text fields (arguments/parameters/returned_value/examples,
// and #314's introduced_in/examples/alias_to/content_type).
function trimmedOrUndefined(s: unknown): string | undefined {
  const t = s == null ? '' : String(s).trim();
  return t ? t : undefined;
}

// Trimmed full body (may be multi-line Markdown — passed through untouched;
// rendering/sanitizing is a UI concern). undefined when absent/blank.
function trimmedBody(s: unknown): string | undefined {
  return trimmedOrUndefined(s);
}

// Nullable(UInt8) -> tri-state boolean: 1/true -> true, 0/false -> false,
// null -> null, column absent (undefined) -> undefined (never read unless the
// capability confirms the column, but stay defensive against a genuinely
// absent key on the raw row too).
function triState(v: RawCell): boolean | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return !!v;
}

// `categories` arrives as a plain comma-separated String on real servers
// (e.g. "Dates and Times"), not an Array — split, trim, drop empties.
function splitCategories(v: RawCell): string[] {
  if (!v) return [];
  return String(v)
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Normalize one raw `system.functions` FORMAT JSON row into the shared
 * `DocEntry` contract (doc-types.ts). Every field degrades individually when
 * its column wasn't in the SELECT (per `cap` — fields not confirmed available
 * are never read off `row`, even if a stray key happens to be present).
 * Never throws on an unexpected shape. Pure.
 */
export function normalizeFunctionRow(row: Record<string, RawCell>, cap: FunctionsDocCapability): DocEntry {
  const name = String(row.name ?? '');
  const isAggregate = cap.isAggregate && !!row.is_aggregate;
  const signature = cap.syntax ? firstLine(row.syntax) || name + '()' : name + '()';
  const summary = cap.description ? firstProseLine(row.description) : '';
  const description = cap.description ? trimmedBody(row.description) : undefined;
  const aliasTo = cap.aliasTo ? trimmedOrUndefined(row.alias_to) : undefined;
  const introducedIn = cap.introducedIn ? trimmedOrUndefined(row.introduced_in) : undefined;
  const categories = cap.categories ? splitCategories(row.categories) : [];
  const deterministic = cap.deterministic ? triState(row.deterministic) : undefined;
  const higherOrder = cap.higherOrder ? triState(row.higher_order) : undefined;

  const entry: DocEntry = {
    target: { kind: isAggregate ? 'aggregate-function' : 'function', name },
    title: name,
    signature,
    summary,
    categories,
  };
  if (introducedIn !== undefined) entry.introducedIn = introducedIn;
  if (aliasTo !== undefined) entry.aliasTo = aliasTo;
  if (description !== undefined) entry.description = description;
  if (cap.arguments) {
    const v = trimmedOrUndefined(row.arguments);
    if (v !== undefined) entry.arguments = v;
  }
  if (cap.parameters) {
    const v = trimmedOrUndefined(row.parameters);
    if (v !== undefined) entry.parameters = v;
  }
  if (cap.returnedValue) {
    const v = trimmedOrUndefined(row.returned_value);
    if (v !== undefined) entry.returnedValue = v;
  }
  if (cap.examples) {
    const v = trimmedOrUndefined(row.examples);
    if (v !== undefined) entry.examples = v;
  }
  if (deterministic !== undefined) entry.deterministic = deterministic;
  if (higherOrder !== undefined) entry.higherOrder = higherOrder;
  return entry;
}

/** Project a `DocEntry` down to the compact `DocSummary` shown in the CM6
 *  hover tooltip and completion info. Pure. */
export function summaryFromEntry(entry: DocEntry): DocSummary {
  const summary: DocSummary = {
    target: entry.target,
    title: entry.title,
    signature: entry.signature,
    summary: entry.summary,
  };
  if (entry.introducedIn !== undefined) summary.introducedIn = entry.introducedIn;
  if (entry.aliasTo !== undefined) summary.aliasTo = entry.aliasTo;
  return summary;
}

// ─────────────────────────────────────────────────────────────────────────
// #314 Phase 2 — structured non-function sources: `system.formats`,
// `system.table_engines`, `system.database_engines`, `system.data_type_families`.
//
// Version policy is identical to Phase 1's: actual `system.columns` shape is
// authoritative, `name` is the only required column, every other column
// degrades independently — there is no fixed 26.6 gate (#314 "Version and
// capability policy"). Each of the four sources gets its OWN capability
// (probed/cached independently by the caller, schema-catalog-service.ts) —
// this module only decides what SQL to run per source and how to normalize
// its row; it never runs anything itself.
//
// One flat capability struct covers all four sources (rather than one
// interface per source) because the caller needs to hold/reset capability
// state per `StructuredDocKind` uniformly, and every field already maps
// 1:1 to a single column on exactly one or two of the sources — a source
// simply never sets flags for columns it doesn't have (`format` never sets
// `syntax`; the others never set formats' capability-flag columns).

/** The four #314 structured kinds. Was `Exclude<DocKind, 'function' |
 *  'aggregate-function'>` before #315 (Phase 3) widened `DocKind` with a
 *  dozen more kinds that have NO structured `system.*` source of their own
 *  (settings, table functions, dictionary layouts/sources, …) — those fall
 *  through to #315's `system.documentation` broad fallback instead
 *  (`schema-catalog-service.ts`'s `hasStructuredLoader`/`isStructuredKind`),
 *  so this type now names the four kinds explicitly rather than by
 *  exclusion. */
export type StructuredDocKind = 'format' | 'table-engine' | 'database-engine' | 'data-type';

/** Which optional columns are confirmed present for one structured source on
 *  this connection, plus whether the capability is usable at all (`name`
 *  present). Every flag below maps to exactly one column on AT MOST the
 *  sources that actually have it — see `STRUCTURED_SPECS`; a flag a given
 *  kind's source doesn't carry a column for is simply never set true for it. */
export interface StructuredDocCapability {
  available: boolean;
  description: boolean;
  /** `system.formats` has no `syntax` column — NEVER true for `format`
   *  capability (#314: "Never probe, query, or fabricate it"). */
  syntax: boolean;
  examples: boolean;
  introducedIn: boolean;
  related: boolean;
  /** `system.data_type_families.alias_to` only. */
  aliasTo: boolean;
  // `system.formats` capability-flag columns.
  isInput: boolean;
  isOutput: boolean;
  supportsParallelParsing: boolean;
  supportsParallelFormatting: boolean;
  isTtyFriendly: boolean;
  contentType: boolean;
  supportsRandomAccess: boolean;
  hasSchemaInference: boolean;
  hasExternalSchema: boolean;
  prefersLargeBlocks: boolean;
  supportsAppend: boolean;
  supportsSubsetsOfColumns: boolean;
  // `system.table_engines` capability-flag columns.
  supportsSettings: boolean;
  supportsSkippingIndices: boolean;
  supportsProjections: boolean;
  supportsSortOrder: boolean;
  supportsTtl: boolean;
  supportsReplication: boolean;
  supportsDeduplication: boolean;
  supportsParallelInsert: boolean;
}

/** A capability flag other than the `available` gate itself. */
export type StructuredDocFlag = Exclude<keyof StructuredDocCapability, 'available'>;

const UNAVAILABLE_STRUCTURED: StructuredDocCapability = {
  available: false,
  description: false,
  syntax: false,
  examples: false,
  introducedIn: false,
  related: false,
  aliasTo: false,
  isInput: false,
  isOutput: false,
  supportsParallelParsing: false,
  supportsParallelFormatting: false,
  isTtyFriendly: false,
  contentType: false,
  supportsRandomAccess: false,
  hasSchemaInference: false,
  hasExternalSchema: false,
  prefersLargeBlocks: false,
  supportsAppend: false,
  supportsSubsetsOfColumns: false,
  supportsSettings: false,
  supportsSkippingIndices: false,
  supportsProjections: false,
  supportsSortOrder: false,
  supportsTtl: false,
  supportsReplication: false,
  supportsDeduplication: false,
  supportsParallelInsert: false,
};

interface StructuredSourceSpec {
  /** The `system.<table>` this kind reads from. */
  table: string;
  /** Capability flag -> actual column name, in the (stable, deterministic)
   *  order the SELECT list is built — same shape as Phase 1's `COLUMN_ORDER`. */
  columns: [StructuredDocFlag, string][];
}

// `system.formats` — NO `syntax` column, ever (#314's hard rule).
const FORMAT_COLUMNS: [StructuredDocFlag, string][] = [
  ['isInput', 'is_input'],
  ['isOutput', 'is_output'],
  ['supportsParallelParsing', 'supports_parallel_parsing'],
  ['supportsParallelFormatting', 'supports_parallel_formatting'],
  ['isTtyFriendly', 'is_tty_friendly'],
  ['supportsRandomAccess', 'supports_random_access'],
  ['hasSchemaInference', 'has_schema_inference'],
  ['hasExternalSchema', 'has_external_schema'],
  ['prefersLargeBlocks', 'prefers_large_blocks'],
  ['supportsAppend', 'supports_append'],
  ['supportsSubsetsOfColumns', 'supports_subsets_of_columns'],
  ['contentType', 'content_type'],
  ['description', 'description'],
  ['examples', 'examples'],
  ['introducedIn', 'introduced_in'],
  ['related', 'related'],
];

const TABLE_ENGINE_COLUMNS: [StructuredDocFlag, string][] = [
  ['supportsSettings', 'supports_settings'],
  ['supportsSkippingIndices', 'supports_skipping_indices'],
  ['supportsProjections', 'supports_projections'],
  ['supportsSortOrder', 'supports_sort_order'],
  ['supportsTtl', 'supports_ttl'],
  ['supportsReplication', 'supports_replication'],
  ['supportsDeduplication', 'supports_deduplication'],
  ['supportsParallelInsert', 'supports_parallel_insert'],
  ['description', 'description'],
  ['syntax', 'syntax'],
  ['examples', 'examples'],
  ['introducedIn', 'introduced_in'],
  ['related', 'related'],
];

const DATABASE_ENGINE_COLUMNS: [StructuredDocFlag, string][] = [
  ['description', 'description'],
  ['syntax', 'syntax'],
  ['examples', 'examples'],
  ['introducedIn', 'introduced_in'],
  ['related', 'related'],
];

// `case_insensitive` is intentionally never listed — #314: "metadata (not
// displayed — ignore)".
const DATA_TYPE_COLUMNS: [StructuredDocFlag, string][] = [
  ['aliasTo', 'alias_to'],
  ['description', 'description'],
  ['syntax', 'syntax'],
  ['examples', 'examples'],
  ['introducedIn', 'introduced_in'],
  ['related', 'related'],
];

const STRUCTURED_SPECS: Record<StructuredDocKind, StructuredSourceSpec> = {
  format: { table: 'formats', columns: FORMAT_COLUMNS },
  'table-engine': { table: 'table_engines', columns: TABLE_ENGINE_COLUMNS },
  'database-engine': { table: 'database_engines', columns: DATABASE_ENGINE_COLUMNS },
  'data-type': { table: 'data_type_families', columns: DATA_TYPE_COLUMNS },
};

/**
 * Decide one structured source's documentation capability from the column
 * names actually present on `system.columns` for its table. `name` is
 * required — without it the whole capability is `unavailable` (missing
 * table, denied access, or an incompatible shape). Every other column
 * degrades independently, restricted to the columns `kind`'s source actually
 * has (per `STRUCTURED_SPECS`). Pure.
 */
export function structuredCapabilityFromColumns(kind: StructuredDocKind, cols: string[]): StructuredDocCapability {
  const set = new Set(cols);
  if (!set.has('name')) return UNAVAILABLE_STRUCTURED;
  const spec = STRUCTURED_SPECS[kind];
  const cap: StructuredDocCapability = { ...UNAVAILABLE_STRUCTURED, available: true };
  for (const [flag, col] of spec.columns) cap[flag] = set.has(col);
  return cap;
}

/**
 * Build the `SELECT … FROM system.<table> WHERE … LIMIT 1 FORMAT JSON`
 * statement for one structured-source lookup by name, listing only columns
 * `cap` confirmed available (`name` first). Matches the name
 * case-insensitively via the same exact/lower/upper pattern Phase 1 uses
 * (`buildFunctionDocSelect`) — kept deliberately simple (#314: "same
 * name-matching, aliasTo surfaces in the entry" — no separate alias-name
 * WHERE branch). `escape` is the injected SQL-string-escape seam. Returns
 * `null` when the capability is unavailable. Pure.
 */
export function buildStructuredDocSelect(
  kind: StructuredDocKind,
  cap: StructuredDocCapability,
  name: string,
  escape: (s: string) => string,
): string | null {
  if (!cap.available) return null;
  const spec = STRUCTURED_SPECS[kind];
  const columns = ['name', ...spec.columns.filter(([flag]) => cap[flag]).map(([, col]) => col)];
  const x = escape(name);
  return (
    'SELECT ' + columns.join(', ') + ' FROM system.' + spec.table +
    ' WHERE name = ' + x + ' OR lower(name) = lower(' + x + ') OR upper(name) = upper(' + x + ')' +
    ' LIMIT 1 FORMAT JSON'
  );
}

// A raw FORMAT JSON cell for a structured-source doc row: same scalar shape
// as Phase 1's `RawCell`, plus `unknown[]` — some servers may represent
// `related` as a genuine JSON array rather than a comma-separated String
// (#314: "handle both defensively").
type StructuredRawCell = string | number | boolean | null | undefined | unknown[];

// `related` arrives as a comma-separated String on most servers, but
// defensively also accepts a genuine Array. Each item trimmed, blanks
// dropped. Pure.
function relatedNames(v: StructuredRawCell): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((s) => s.length > 0);
  return String(v).split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

// Same-kind `related` chips (#314: "keep it same-kind and label-preserving")
// — every related name gets a same-kind `target` so the pane's normal
// `docEntry` lookup resolves it (getting `missing` if the name doesn't
// actually exist as that kind); there is no cross-kind resolution here.
function buildRelated(kind: StructuredDocKind, v: StructuredRawCell): { target?: DocTarget; label: string }[] {
  return relatedNames(v).map((label) => ({ label, target: { kind, name: label } }));
}

// [capability flag, column name, human-readable fact label].
type FactSpec = [StructuredDocFlag, string, string];

const FORMAT_FACT_SPECS: FactSpec[] = [
  ['isInput', 'is_input', 'Input'],
  ['isOutput', 'is_output', 'Output'],
  ['supportsParallelParsing', 'supports_parallel_parsing', 'Parallel parsing'],
  ['supportsParallelFormatting', 'supports_parallel_formatting', 'Parallel formatting'],
  ['isTtyFriendly', 'is_tty_friendly', 'TTY friendly'],
  ['supportsRandomAccess', 'supports_random_access', 'Random access'],
  ['hasSchemaInference', 'has_schema_inference', 'Schema inference'],
  ['hasExternalSchema', 'has_external_schema', 'External schema'],
  ['prefersLargeBlocks', 'prefers_large_blocks', 'Prefers large blocks'],
  ['supportsAppend', 'supports_append', 'Append'],
  ['supportsSubsetsOfColumns', 'supports_subsets_of_columns', 'Column subsets'],
];

const TABLE_ENGINE_FACT_SPECS: FactSpec[] = [
  ['supportsSettings', 'supports_settings', 'Settings'],
  ['supportsSkippingIndices', 'supports_skipping_indices', 'Skipping indices'],
  ['supportsProjections', 'supports_projections', 'Projections'],
  ['supportsSortOrder', 'supports_sort_order', 'Sort order'],
  ['supportsTtl', 'supports_ttl', 'TTL'],
  ['supportsReplication', 'supports_replication', 'Replication'],
  ['supportsDeduplication', 'supports_deduplication', 'Deduplication'],
  ['supportsParallelInsert', 'supports_parallel_insert', 'Parallel insert'],
];

// Only a column both confirmed present (`cap`) AND non-null on the row
// becomes a fact — never displayed as false-by-default. Pure.
function boolFacts(
  cap: StructuredDocCapability, row: Record<string, StructuredRawCell>, specs: FactSpec[],
): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const [flag, col, label] of specs) {
    if (!cap[flag]) continue;
    const raw = row[col];
    if (raw === undefined || raw === null) continue;
    out.push({ label, value: raw ? 'yes' : 'no' });
  }
  return out;
}

// `system.formats`' boolean capability columns (+ `content_type`) and
// `system.table_engines`' boolean capability columns become `facts` — the
// other two sources have no capability-flag columns to surface this way.
function buildFacts(
  kind: StructuredDocKind, row: Record<string, StructuredRawCell>, cap: StructuredDocCapability,
): { label: string; value: string }[] {
  if (kind === 'format') {
    const facts = boolFacts(cap, row, FORMAT_FACT_SPECS);
    if (cap.contentType) {
      const ct = trimmedOrUndefined(row.content_type);
      if (ct !== undefined) facts.push({ label: 'Content type', value: ct });
    }
    return facts;
  }
  if (kind === 'table-engine') return boolFacts(cap, row, TABLE_ENGINE_FACT_SPECS);
  return [];
}

/**
 * Normalize one raw structured-source FORMAT JSON row into the shared
 * `DocEntry` contract. Every field degrades individually when its column
 * wasn't in the SELECT (per `cap`). `signature` is the syntax block's first
 * non-empty line when `syntax` is confirmed and non-blank, else just `name`
 * (no function-style `()` suffix). Never throws on an unexpected shape. Pure.
 */
export function normalizeStructuredRow(
  kind: StructuredDocKind,
  row: Record<string, StructuredRawCell>,
  cap: StructuredDocCapability,
): DocEntry {
  const name = String(row.name ?? '');
  const syntaxFull = cap.syntax ? trimmedBody(row.syntax) : undefined;
  const signature = syntaxFull ? firstLine(syntaxFull) : name;
  const summary = cap.description ? firstProseLine(row.description) : '';
  const description = cap.description ? trimmedBody(row.description) : undefined;
  const introducedIn = cap.introducedIn ? trimmedOrUndefined(row.introduced_in) : undefined;
  const examples = cap.examples ? trimmedOrUndefined(row.examples) : undefined;
  const aliasTo = cap.aliasTo ? trimmedOrUndefined(row.alias_to) : undefined;
  const related = cap.related ? buildRelated(kind, row.related) : [];
  const facts = buildFacts(kind, row, cap);

  const entry: DocEntry = {
    target: { kind, name },
    title: name,
    signature,
    summary,
    categories: [],
  };
  if (introducedIn !== undefined) entry.introducedIn = introducedIn;
  if (aliasTo !== undefined) entry.aliasTo = aliasTo;
  if (description !== undefined) entry.description = description;
  if (examples !== undefined) entry.examples = examples;
  if (syntaxFull !== undefined) entry.syntaxFull = syntaxFull;
  if (related.length) entry.related = related;
  if (facts.length) entry.facts = facts;
  return entry;
}
