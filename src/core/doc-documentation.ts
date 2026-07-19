// Pure capability decision + kind mapping + query construction + row
// normalization for the #315 Phase 3 `system.documentation` broad,
// version-exact fallback/coverage source. No DOM, no fetch, no globals other
// than the standard `TextEncoder`/`TextDecoder` (already used the same way by
// `core/pkce.ts`) — the caller (SchemaCatalogService) owns running the SQL,
// reading the server version, and caching; this module only decides *whether*
// a version even permits asking, *what* SQL to run, and how to turn a raw
// FORMAT JSON row into the shared `MarkdownDocEntry`/`DocEntry` contracts
// (doc-types.ts).
//
// Markdown PARSING/RENDERING (the bounded pure AST -> safe DOM pipeline the
// parent issue #315 describes) is explicitly a LATER commit — this module
// only carries the raw Markdown string through untouched.
//
// Version and capability policy (#315, amended in the issue's pinned comment
// after live-verifying a real 26.6.1 server):
//  - `name`/`type`/`description` are REQUIRED — their absence (missing table,
//    denied access, or a shape lacking any of the three) makes the whole
//    capability `unavailable`.
//  - `source` is OPTIONAL — real 26.6.1 servers expose only
//    `name`/`type`/`description`. Its absence does NOT mark the capability
//    unavailable; it just means entries never carry a `source`.
//  - Unlike #313/#314's structured sources (no fixed version gate — actual
//    `system.columns` shape is authoritative on any server), this source has
//    an explicit lower version bound: a parsed version below 26.6 skips the
//    probe/query entirely (`documentationProbePolicy` returns `'skip'`) — a
//    version check is a negative short-circuit / optimization here, not proof
//    of capability on 26.6+ (table presence and column shape stay
//    authoritative there too, exactly like #313/#314).

import type { DocKind, DocEntry, MarkdownDocEntry } from './doc-types.js';
import type { ParsedServerVersion } from './format.js';
import { versionAtLeast } from './format.js';

// ── Kind <-> server `type` label mapping ────────────────────────────────────

// [server `type` label, stable DocKind]. The first 15 are the labels a live
// 26.6.1 server's `type` Enum8 actually carries; `Codec`/`Metric`/
// `System Table` have no current server label (26.6.1's enum lacks them) but
// are mapped anyway per #315's "no closed enum" policy — the classifier and
// normalization stay forward-compatible the moment a server adds one, and
// until then a lookup for `codec`/`metric`/`system-table` simply resolves
// `missing` (no matching `type` value exists to query by).
const LABEL_TO_KIND: [string, DocKind][] = [
  ['Function', 'function'],
  ['Aggregate Function', 'aggregate-function'],
  ['Table Function', 'table-function'],
  ['Table Engine', 'table-engine'],
  ['Database Engine', 'database-engine'],
  ['Data Type', 'data-type'],
  ['Dictionary Layout', 'dictionary-layout'],
  ['Dictionary Source', 'dictionary-source'],
  ['Aggregate Function Combinator', 'aggregate-combinator'],
  ['Data Skipping Index', 'skipping-index'],
  ['Disk Type', 'disk-type'],
  ['Setting', 'setting'],
  ['MergeTree Setting', 'mergetree-setting'],
  ['Server Setting', 'server-setting'],
  ['Format', 'format'],
  ['Codec', 'codec'],
  ['Metric', 'metric'],
  ['System Table', 'system-table'],
];

const KIND_BY_LABEL: Map<string, DocKind> = new Map(LABEL_TO_KIND);
const LABEL_BY_KIND: Map<DocKind, string> = new Map(LABEL_TO_KIND.map(([label, kind]) => [kind, label]));

/**
 * Map a raw `system.documentation` `type` label (e.g. `'MergeTree Setting'`)
 * to a stable `DocKind`. An unrecognized label maps to `'unknown'` — the
 * ORIGINAL label is never discarded by this function; the caller preserves it
 * separately (`normalizeDocumentationRow` puts it on `serverTypeLabel`). Pure.
 */
export function docKindFromServerType(label: string): DocKind {
  return KIND_BY_LABEL.get(label) ?? 'unknown';
}

/**
 * The reverse of `docKindFromServerType`: the server `type` label a known
 * `DocKind` queries by, or `null` when `kind` has no current server label to
 * query by (`'unknown'`, or one of the forward-compatible
 * `'codec'`/`'metric'`/`'system-table'` kinds no live server emits yet).
 * Pure.
 */
export function docKindToServerType(kind: DocKind): string | null {
  return LABEL_BY_KIND.get(kind) ?? null;
}

// ── Capability ───────────────────────────────────────────────────────────────

/** Which of `system.documentation`'s columns are confirmed present on this
 *  connection, plus whether the capability is usable at all. `available` is
 *  false when `name`/`type`/`description` aren't ALL present (missing table,
 *  denied access, or an incompatible shape) — `source` is optional and never
 *  gates `available`. */
export interface DocumentationCapability {
  available: boolean;
  source: boolean;
}

const UNAVAILABLE_DOCUMENTATION: DocumentationCapability = { available: false, source: false };

/**
 * Decide the `system.documentation` capability from the column names actually
 * present on `system.columns` for that table. `name`/`type`/`description` are
 * ALL required — missing any one of them makes the whole capability
 * `unavailable`. `source` is optional and degrades independently (a real
 * 26.6.1 server's `system.documentation` has no `source` column at all — this
 * must NOT disable the capability). Pure.
 */
export function documentationCapabilityFromColumns(cols: string[]): DocumentationCapability {
  const set = new Set(cols);
  if (!set.has('name') || !set.has('type') || !set.has('description')) return UNAVAILABLE_DOCUMENTATION;
  return { available: true, source: set.has('source') };
}

/**
 * Decide whether the capability probe should even run, from the current
 * server version (`core/format.js`'s `parseServerVersion`), per #315's
 * "Version and capability policy":
 *  - a version parsed as BELOW 26.6 -> `'skip'` — mark unavailable WITHOUT
 *    issuing any query or `system.columns` probe;
 *  - a version parsed as 26.6 or later -> `'probe'` — table/column shape
 *    stays authoritative even on a version that supports the feature;
 *  - `null` (version not yet known, or unparsable) -> `'probe'` — one silent
 *    probe rather than assuming either support or non-support.
 * A version check is a negative short-circuit / optimization, never proof of
 * capability. Pure.
 */
export function documentationProbePolicy(parsed: ParsedServerVersion | null): 'skip' | 'probe' {
  if (parsed === null) return 'probe';
  return versionAtLeast(parsed, 26, 6) ? 'probe' : 'skip';
}

// ── SQL construction ─────────────────────────────────────────────────────────

// `system.documentation`'s decoded columns, in the (stable, deterministic)
// order the SELECT list is built — `name`/`type`/`description` always;
// `source` only when `cap.source` confirms the column exists. These four are
// the ONLY columns this module ever decodes (#315 acceptance criterion).
function selectColumns(cap: DocumentationCapability): string[] {
  const columns = ['name', 'type', 'description'];
  if (cap.source) columns.push('source');
  return columns;
}

// Case-insensitive name match, matching the exact/lower/upper pattern
// #313/#314's `buildFunctionDocSelect`/`buildStructuredDocSelect` already use.
function nameMatch(name: string, escape: (s: string) => string): string {
  const x = escape(name);
  return 'name = ' + x + ' OR lower(name) = lower(' + x + ') OR upper(name) = upper(' + x + ')';
}

/** A sane upper bound on rows returned by the name-only disambiguation query
 *  (#315: "enforce row and byte limits") — generous enough to show every
 *  same-name kind a real server could plausibly carry, small enough to never
 *  be a meaningful payload. */
export const DOCUMENTATION_DISAMBIGUATION_LIMIT = 20;

/**
 * Build the `SELECT … FROM system.documentation WHERE type = … AND (name = …
 * OR …) LIMIT 1 FORMAT JSON` statement for one lookup by (kind, name), when
 * `kind` maps to a known server `type` label (`docKindToServerType`). Returns
 * `null` when the capability is unavailable OR `kind` has no known server
 * label to query by (the caller falls back to `buildDocumentationNameSelect`
 * for disambiguation in that case, or simply has nothing to ask). `escape` is
 * the injected SQL-string-escape seam (`core/format.js`'s `sqlString`). Pure.
 */
export function buildDocumentationSelect(
  cap: DocumentationCapability,
  kind: DocKind,
  name: string,
  escape: (s: string) => string,
): string | null {
  if (!cap.available) return null;
  const label = docKindToServerType(kind);
  if (label === null) return null;
  const columns = selectColumns(cap);
  return (
    'SELECT ' + columns.join(', ') + ' FROM system.documentation' +
    ' WHERE type = ' + escape(label) + ' AND (' + nameMatch(name, escape) + ')' +
    ' LIMIT 1 FORMAT JSON'
  );
}

/**
 * Build the name-only disambiguation `SELECT … FROM system.documentation
 * WHERE name = … OR … LIMIT ${DOCUMENTATION_DISAMBIGUATION_LIMIT} FORMAT
 * JSON` statement — no `type` filter, so it returns every kind sharing this
 * name (a caller then normalizes each row and lets the user choose). Returns
 * `null` only when the capability is unavailable. Pure.
 */
export function buildDocumentationNameSelect(
  cap: DocumentationCapability,
  name: string,
  escape: (s: string) => string,
): string | null {
  if (!cap.available) return null;
  const columns = selectColumns(cap);
  return (
    'SELECT ' + columns.join(', ') + ' FROM system.documentation' +
    ' WHERE ' + nameMatch(name, escape) +
    ' LIMIT ' + DOCUMENTATION_DISAMBIGUATION_LIMIT + ' FORMAT JSON'
  );
}

// ── Normalization ────────────────────────────────────────────────────────────

// A raw FORMAT JSON cell for a `system.documentation` row: every decoded
// column (`name`/`type`/`description`/`source`) is a plain String on the
// server, but stay defensive against a genuinely absent/null key.
type RawCell = string | number | boolean | null | undefined;

// First non-empty line of a (possibly multi-line Markdown) cell, trimmed —
// mirrors `doc-capability.ts`'s own `firstLine` (kept as a small local copy
// rather than importing a private helper across files, since the caller of
// each is exercising a different row shape).
function firstLine(s: unknown): string {
  if (!s) return '';
  for (const line of String(s).split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

function trimmedOrUndefined(s: unknown): string | undefined {
  const t = s == null ? '' : String(s).trim();
  return t ? t : undefined;
}

/** The row/byte guard #315 requires ("enforce row and byte limits"): a
 *  `description` body longer than this many UTF-8 bytes gets truncated to
 *  this bound (`normalizeDocumentationRow` sets `oversized: true` when it
 *  does) rather than either being rejected outright or kept unbounded in
 *  memory. Shared with the future `core/doc-markdown.ts` parser's own byte
 *  bound (the issue's "Safety and limits" `MAX_DOC_MARKDOWN_BYTES`) — this
 *  is the single source of truth for that constant so the parser (a later
 *  commit) reuses it rather than re-declaring it. */
export const MAX_DOC_MARKDOWN_BYTES = 1_000_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

// Truncate `raw` to at most `maxBytes` UTF-8 bytes, decoding defensively (a
// cut mid-multi-byte-sequence decodes with the replacement character rather
// than throwing). Pure (no I/O — `TextEncoder`/`TextDecoder` are plain
// value-transform globals, same precedent as `core/pkce.ts`).
function boundMarkdown(raw: string, maxBytes: number): { text: string; oversized: boolean } {
  const bytes = encoder.encode(raw);
  if (bytes.length <= maxBytes) return { text: raw, oversized: false };
  return { text: decoder.decode(bytes.slice(0, maxBytes)), oversized: true };
}

/**
 * Normalize one raw `system.documentation` FORMAT JSON row into the shared
 * `MarkdownDocEntry` contract (doc-types.ts). `target.kind` comes from
 * mapping the row's OWN `type` label (`docKindFromServerType`), not the kind
 * that was requested — mirrors #313/#314's "the fetched row is the truth"
 * policy (a case- or kind-mismatched lookup still normalizes to what the
 * server actually returned). `source` is only set when `cap.source` confirms
 * the column exists AND the cell is non-blank. `markdown`/`description`'s
 * `oversized` truncation guard (`MAX_DOC_MARKDOWN_BYTES`) applies here — the
 * NORMALIZER is the single place a caller can rely on the byte bound, not
 * just the SQL layer (a server could in principle return an oversized row
 * regardless of how the SELECT was built). Never throws on an unexpected
 * shape. Pure.
 */
export function normalizeDocumentationRow(row: Record<string, RawCell>, cap: DocumentationCapability): MarkdownDocEntry {
  const name = String(row.name ?? '');
  const serverTypeLabel = String(row.type ?? '');
  const kind = docKindFromServerType(serverTypeLabel);
  const rawDescription = row.description == null ? '' : String(row.description);
  const { text: markdown, oversized } = boundMarkdown(rawDescription, MAX_DOC_MARKDOWN_BYTES);
  const summary = firstLine(markdown);
  const source = cap.source ? trimmedOrUndefined(row.source) : undefined;

  const entry: MarkdownDocEntry = {
    target: { kind, name },
    title: name,
    signature: name,
    summary,
    renderMode: 'markdown-subset',
    markdown,
    serverTypeLabel,
  };
  if (source !== undefined) entry.source = source;
  if (oversized) entry.oversized = true;
  return entry;
}

/** Project a `MarkdownDocEntry` down to the shared `DocEntry` contract, for
 *  `docEntry`'s own fallback path (a kind with no structured loader, or an
 *  unavailable structured source) — so a `docEntry` caller gets one uniform
 *  shape regardless of which source actually answered. Carries `description`
 *  === `markdown` verbatim (Markdown PARSING/RENDERING is a later commit —
 *  today `description` and `markdown` are the same unparsed string), plus
 *  `renderMode`/`source`/`serverTypeLabel`/`oversized` and `sourceTable:
 *  'documentation'` so the caller can tell which source supplied it. `target`
 *  is the entry's OWN normalized target — never the originally-requested one
 *  (mirrors #313/#314's kind-mismatch policy). Pure. */
export function documentationEntryToDocEntry(entry: MarkdownDocEntry): DocEntry {
  const out: DocEntry = {
    target: entry.target,
    title: entry.title,
    signature: entry.signature,
    summary: entry.summary,
    categories: [],
    description: entry.markdown,
    renderMode: 'markdown-subset',
    markdown: entry.markdown,
    serverTypeLabel: entry.serverTypeLabel,
    sourceTable: 'documentation',
  };
  if (entry.source !== undefined) out.source = entry.source;
  if (entry.oversized) out.oversized = true;
  return out;
}
