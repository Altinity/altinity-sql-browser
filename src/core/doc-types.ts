// Shared, kind-neutral documentation contracts (#313). Pure types only — no
// runtime code, no DOM, no globals. `DocKind` is a plain string union so later
// phases (formats/engines/types — #315+) can widen it without touching every
// consumer's shape.

/** The kind of catalog entity a documentation lookup targets. Widens in later
 *  phases (formats, engines, data types, settings, table functions, …). */
export type DocKind = 'function' | 'aggregate-function';

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
}
