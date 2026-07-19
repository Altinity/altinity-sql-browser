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

import type { DocEntry, DocSummary } from './doc-types.js';

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
// ClickHouse doc cells (system.functions.description/syntax) frequently begin
// with a leading blank line, so skip leading empties and return the first
// line that actually has content. Mirrors ch-client.ts's `firstLine()`.
function firstLine(s: RawCell): string {
  if (!s) return '';
  for (const line of String(s).split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

// Trimmed non-empty string, or undefined when absent/blank. Used for the
// simple pass-through text fields (arguments/parameters/returned_value/examples).
function trimmedOrUndefined(s: RawCell): string | undefined {
  const t = s == null ? '' : String(s).trim();
  return t ? t : undefined;
}

// Trimmed full body (may be multi-line Markdown — passed through untouched;
// rendering/sanitizing is a UI concern). undefined when absent/blank.
function trimmedBody(s: RawCell): string | undefined {
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
  const summary = cap.description ? firstLine(row.description) : '';
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
