// Shared, kind-neutral documentation contracts (#313). Pure types only — no
// runtime code, no DOM, no globals. `DocKind` is a plain string union so later
// phases (formats/engines/types — #315+) can widen it without touching every
// consumer's shape.

/** The kind of catalog entity a documentation lookup targets. Widens in later
 *  phases (settings, table functions, codecs, …). #314 (Phase 2) adds the four
 *  structured-source kinds: `format` (`system.formats`), `table-engine`
 *  (`system.table_engines`), `database-engine` (`system.database_engines`),
 *  `data-type` (`system.data_type_families`). #315 (Phase 3) adds the broad
 *  `system.documentation` kinds — every current known server `type` label
 *  (`docKindFromServerType`, doc-documentation.ts) maps to one of these, plus
 *  `'unknown'` for a label this build doesn't recognize yet (the original
 *  label is preserved on the entry's `serverTypeLabel`, never discarded).
 *  `'codec'`/`'metric'`/`'system-table'` have no current server `type` label
 *  to map from (26.6.1's 15-value enum lacks them) — they exist so the
 *  classifier/normalization code is forward-compatible the moment a server
 *  adds one, per #315's "no closed enum" policy; until then a lookup for one
 *  of these kinds simply resolves `missing`. */
export type DocKind =
  | 'function'
  | 'aggregate-function'
  | 'format'
  | 'table-engine'
  | 'database-engine'
  | 'data-type'
  | 'table-function'
  | 'dictionary-layout'
  | 'dictionary-source'
  | 'aggregate-combinator'
  | 'skipping-index'
  | 'disk-type'
  | 'setting'
  | 'mergetree-setting'
  | 'server-setting'
  | 'codec'
  | 'metric'
  | 'system-table'
  | 'unknown';

/** One documentation target: what kind of entity, and its name as written in
 *  SQL (case as typed — lookups match case-insensitively, see doc-capability.ts). */
export interface DocTarget {
  kind: DocKind;
  name: string;
}

/** The outcome of a documentation lookup.
 *  - `found`: a value was resolved (cacheable).
 *  - `missing`: the lookup ran successfully but found no match (a successful
 *    no-match — cacheable).
 *  - `unavailable`: the capability (table/columns) isn't available or is
 *    denied on this connection (cacheable).
 *  A transient failure (network/auth) is NOT one of these — the caller keeps
 *  no durable entry and retries. */
export type DocLookup<T> =
  | { status: 'found'; value: T }
  | { status: 'missing' }
  | { status: 'unavailable' };

/** The compact projection shown in the CM6 hover tooltip and completion info. */
export interface DocSummary {
  target: DocTarget;
  title: string;
  signature: string;
  summary: string;
  introducedIn?: string;
  aliasTo?: string;
}

/** The full documentation entry rendered in the persistent reference pane. */
export interface DocEntry extends DocSummary {
  description?: string;
  arguments?: string;
  parameters?: string;
  returnedValue?: string;
  examples?: string;
  categories: string[];
  deterministic?: boolean | null;
  higherOrder?: boolean | null;
  /** The full multi-line syntax block, when the source exposes one (#314 —
   *  `system.table_engines`/`system.database_engines`/`system.data_type_families`'
   *  `syntax` column). `signature` always stays just the first line; this
   *  carries the whole block for a caller that wants to render it verbatim
   *  (e.g. a syntax-highlighted code block in the reference pane).
   *  `system.formats` has no `syntax` column — format entries never set this. */
  syntaxFull?: string;
  /** Related entity names (#314 structured sources' `related` column). A
   *  same-kind `target` is attached whenever the source's `related` column
   *  is confirmed and the name is non-blank — the UI resolves it through the
   *  normal `docEntry` lookup (getting `missing` if the name doesn't actually
   *  exist). Pure normalizers have no way to know a related name belongs to a
   *  DIFFERENT kind, so there is no cross-kind resolution here — see #314's
   *  "Normalization" section ("same-kind target is the safe default"). */
  related?: { target?: DocTarget; label: string }[];
  /** Human-readable capability facts (#314 — `system.formats`' and
   *  `system.table_engines`' boolean capability columns), derived only from
   *  columns actually confirmed present AND non-null on the row. */
  facts?: { label: string; value: string }[];
  /** #315 — which normalizer produced this entry: absent/`'structured'` for
   *  every #313/#314 structured-source entry (those normalizers never set
   *  this field — least-churn design, so existing structured entries and
   *  their tests are untouched); `'markdown-subset'` for an entry resolved
   *  from `system.documentation` (either `docEntry`'s own fallback for a
   *  kind with no structured loader / an unavailable structured source, or
   *  a `MarkdownDocEntry` projected down to this shape). When this is
   *  `'markdown-subset'`, `markdown`/`serverTypeLabel` are always set and
   *  `source`/`oversized` may be. Markdown PARSING/RENDERING (the bounded
   *  AST -> DOM pipeline) is a later commit — for now the raw Markdown
   *  string lives untouched in both `description` and `markdown`. */
  renderMode?: 'structured' | 'markdown-subset';
  /** #315 — the full, unparsed Markdown body. Only set when
   *  `renderMode === 'markdown-subset'` (mirrors `description` verbatim —
   *  kept as its own field so a future Markdown-view consumer has an
   *  unambiguous "this is Markdown, not the structured plain-text
   *  `description`" signal without re-checking `renderMode` at every call
   *  site). */
  markdown?: string;
  /** #315 — `system.documentation`'s OPTIONAL repository-relative `source`
   *  column (real 26.6.1 servers may omit it entirely — see
   *  doc-documentation.ts's capability policy). Only set when the column was
   *  confirmed present AND non-blank on the row. Informational only — never
   *  turned into a public URL automatically. */
  source?: string;
  /** #315 — the raw `system.documentation` `type` label as the server sent
   *  it (e.g. `'MergeTree Setting'`), preserved verbatim for display even
   *  though `target.kind` is the normalized, stable `DocKind`. Only set on a
   *  `renderMode: 'markdown-subset'` entry. */
  serverTypeLabel?: string;
  /** #315 — the `description` was longer than `MAX_DOC_MARKDOWN_BYTES` and
   *  was truncated to that bound; `markdown`/`description` hold the
   *  truncated prefix, not the full body. Only ever `true` (never `false`);
   *  absent means not oversized. */
  oversized?: true;
  /** #315 — which source table supplied this entry: `'structured'` for a
   *  #313/#314 normalizer (or a `docEntry` result that resolved via the
   *  structured path), `'documentation'` for a `system.documentation`
   *  fallback/lookup. Absent on entries from before this field existed —
   *  callers should treat an absent value as `'structured'` (every
   *  pre-#315 normalizer only ever produced structured entries). */
  sourceTable?: 'structured' | 'documentation';
}

/** The `system.documentation` (#315, ClickHouse 26.6+) projection: a broad,
 *  version-exact fallback/coverage source for entity kinds the structured
 *  loaders (#313/#314) don't fully handle (settings, table functions,
 *  dictionary layouts/sources, …). Distinct from `DocEntry` (extends
 *  `DocSummary` directly, not `DocEntry`) because Markdown
 *  parsing/rendering — turning `markdown` into a bounded pure AST and safe
 *  DOM — is a LATER commit; for now `markdown` carries the raw, unparsed
 *  Markdown body and the pane has nothing yet to render it with beyond
 *  plain text. `docMarkdown` (schema-catalog-service.ts) returns this shape
 *  for an explicit full-Markdown-depth request; `docEntry`'s own fallback
 *  path projects the same normalized row down to `DocEntry` (via the
 *  `renderMode`/`markdown`/`source`/`serverTypeLabel` fields added there)
 *  instead, so a single `docEntry` caller never needs to know which source
 *  answered. */
export interface MarkdownDocEntry extends DocSummary {
  renderMode: 'markdown-subset';
  markdown: string;
  source?: string;
  serverTypeLabel: string;
  /** #315 — see `DocEntry.oversized`: the `description` exceeded
   *  `MAX_DOC_MARKDOWN_BYTES` and `markdown` holds a truncated prefix, not
   *  the full body. An addition beyond the issue's literal interface
   *  sketch — additive/optional, so it doesn't change any consumer that
   *  ignores it. */
  oversized?: true;
}
