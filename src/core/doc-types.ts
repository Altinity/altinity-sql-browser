// Shared, kind-neutral documentation contracts (#313). Pure types only — no
// runtime code, no DOM, no globals. `DocKind` is a plain string union so later
// phases (formats/engines/types — #315+) can widen it without touching every
// consumer's shape.

/** The kind of catalog entity a documentation lookup targets. Widens in later
 *  phases (settings, table functions, codecs, …). #314 (Phase 2) adds the four
 *  structured-source kinds: `format` (`system.formats`), `table-engine`
 *  (`system.table_engines`), `database-engine` (`system.database_engines`),
 *  `data-type` (`system.data_type_families`). */
export type DocKind =
  | 'function'
  | 'aggregate-function'
  | 'format'
  | 'table-engine'
  | 'database-engine'
  | 'data-type';

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
}
