// #276 Phase 4A's SchemaCatalogService — the server-metadata/reference
// lifecycle (server version probe, schema-tree load, lazy per-table column
// load, editor reference data + completion candidates, target-aware
// documentation lookups) extracted from app.ts (see that file's history
// around `loadVersion`/`loadSchema`/`loadColumns`/`loadReference`/
// `rebuildCompletions`, formerly inline in `createApp`) so it's constructible
// without App/AppState/DOM (issue #276 §6). This is a byte-for-byte port:
// every body below matches the pre-extraction code verbatim, including the
// exact error handling (loadSchema's catch → `schemaError`), the
// version-string handling, and the completions-rebuild trigger points. No
// imports from `src/ui/**` or `src/editor/**` (a pretest check enforces
// this) — DOM (`setConn`'s `app.dom.connStatus` write, the schemaError-driven
// banner effect) stays in app.ts, driven by the same signals/hooks as today.
//
// #313 Phase 1 deleted the old function-name-only `entityDoc(name)` hover-doc
// seam (and its `docCache`) once the CM6 adapter's last caller moved onto the
// target-aware `docSummary`/`docEntry` lookups below — there is no longer a
// second, parallel documentation cache to keep in sync.

import { batch } from '@preact/signals-core';
import type { Signal } from '@preact/signals-core';
import { assembleReferenceData, buildCompletions } from '../core/completions.js';
import type { AssembledReference, CompletionItem } from '../core/completions.js';
import type { SchemaDb, SchemaTable, SchemaColumn } from '../core/from-scope.js';
import {
  functionsCapabilityFromColumns, buildFunctionDocSelect, normalizeFunctionRow, summaryFromEntry,
  structuredCapabilityFromColumns, buildStructuredDocSelect, normalizeStructuredRow,
} from '../core/doc-capability.js';
import type { FunctionsDocCapability, StructuredDocCapability, StructuredDocKind } from '../core/doc-capability.js';
import type { DocTarget, DocLookup, DocSummary, DocEntry, DocKind, MarkdownDocEntry } from '../core/doc-types.js';
import {
  documentationCapabilityFromColumns, documentationProbePolicy, buildDocumentationSelect,
  buildDocumentationNameSelect, normalizeDocumentationRow, documentationEntryToDocEntry,
} from '../core/doc-documentation.js';
import type { DocumentationCapability } from '../core/doc-documentation.js';
import { parseServerVersion } from '../core/format.js';
import type { ChCtx, DocProbeTable } from '../net/ch-client.js';
import type {
  loadServerVersion, loadSchema, loadColumns, loadReferenceData,
  loadFunctionsDocColumns, loadFunctionDocRow, loadDocTableColumns, loadDocRow,
} from '../net/ch-client.js';

// #314 Phase 2 — which `system.columns` probe table backs each structured
// kind's INDEPENDENT capability (see `ensureStructuredCapability` below).
const STRUCTURED_PROBE_TABLE: Record<StructuredDocKind, DocProbeTable> = {
  format: 'formats',
  'table-engine': 'table_engines',
  'database-engine': 'database_engines',
  'data-type': 'data_type_families',
};

const STRUCTURED_KINDS = new Set<DocKind>(Object.keys(STRUCTURED_PROBE_TABLE) as StructuredDocKind[]);

// The #314 four structured-source kinds — exactly `STRUCTURED_PROBE_TABLE`'s
// keys, NOT (as pre-#315) "every kind but the two function kinds": #315
// widened `DocKind` with a dozen kinds (settings, table functions, …) that
// have no `system.*` structured source at all and go straight to #315's
// `system.documentation` fallback (see `hasStructuredLoader` below).
function isStructuredKind(kind: DocTarget['kind']): kind is StructuredDocKind {
  return STRUCTURED_KINDS.has(kind);
}

// Every kind #313/#314 already have a dedicated `system.*` loader for —
// `function`/`aggregate-function` (`system.functions`) plus the four
// structured kinds above. #315's source-preference policy ("structured
// loader from #313/#314 when supported; system.documentation when no
// structured loader exists, the structured source is unavailable, or full
// Markdown depth is requested") is keyed off exactly this set.
function hasStructuredLoader(kind: DocKind): boolean {
  return kind === 'function' || kind === 'aggregate-function' || STRUCTURED_KINDS.has(kind);
}

// ── The state slice this service reads/writes ───────────────────────────────
// Pick-shaped, structurally satisfied by the real `AppState` (state.ts) — a
// production caller passes `app.state` directly, no adapter needed. Mirrors
// `workbench-session.ts`'s own `WorkbenchStateSlice` convention.

export interface SchemaCatalogStateSlice {
  /** The schema tree; `unknown[]` matches `AppState.schema`'s own declared
   *  signal type verbatim — this service casts to `SchemaDb[]`/`SchemaTable[]`
   *  at the same call sites the pre-extraction code did (loadColumns only
   *  ever fires from a click on an already-rendered schema-tree row, i.e.
   *  after the schema itself has loaded). */
  schema: Signal<unknown[] | null>;
  schemaError: Signal<string | null>;
  /** Reassigned wholesale by loadVersion — a plain settable property, not a
   *  signal (matches `AppState.serverVersion`). */
  serverVersion: string | null;
}

// ── Injected DOM/render hooks (used INSIDE the moved bodies) ────────────────

export interface SchemaCatalogHooks {
  /** Fired synchronously right after loadVersion's probe settles (success or
   *  failure) — the shell's own `setConn(online)` DOM update (app.ts,
   *  NOT moved here: it touches `app.dom.connStatus`/`app.state.serverVersion`
   *  display formatting, not the catalog). Optional so a caller that doesn't
   *  care about connection-status chrome (e.g. a test harness) can omit it. */
  onConnStatusChanged?(online: boolean): void;
  /** loadColumns' completion hook — app.ts's `app.renderVarStrip()` (the #172
   *  v2 upgrade path: a newly-loaded column may resolve a String var's
   *  schema-cache-inferred enum suggestion; renderVarStrip's own signature
   *  guard skips the actual DOM rebuild when nothing changed). */
  renderVarStrip(): void;
  /** loadReference's completion hook — app.ts's
   *  `app.sqlEditor.refreshReference()` (re-highlight with server keywords). */
  refreshEditorReference(): void;
}

// ── Construction deps ────────────────────────────────────────────────────────

/** Every side effect this service needs, injected as a narrow bag — mirrors
 *  `query-execution-service.ts`'s own `QueryExecutionDeps` seam (the ch.*
 *  functions it actually calls, imported type-only so `typeof` names their
 *  exact signature without a runtime import). */
export interface SchemaCatalogDeps {
  loadServerVersion: typeof loadServerVersion;
  loadSchema: typeof loadSchema;
  loadColumns: typeof loadColumns;
  loadReferenceData: typeof loadReferenceData;
  /** #313 — the silent per-connection `system.functions` documentation
   *  capability probe and the per-lookup row fetch (see `docSummary`/
   *  `docEntry` below). */
  loadFunctionsDocColumns: typeof loadFunctionsDocColumns;
  loadFunctionDocRow: typeof loadFunctionDocRow;
  /** #314 — the generalized structured-source (format/table-engine/
   *  database-engine/data-type) capability probe and row fetch, each source
   *  probed/cached INDEPENDENTLY (see `ensureStructuredCapability` below). */
  loadDocTableColumns: typeof loadDocTableColumns;
  loadDocRow: typeof loadDocRow;
  /** The live ClickHouse auth context — a *provider*, not a value: the caller
   *  may rebuild it between calls, so the service always reads the current
   *  one rather than closing over a stale snapshot (matches `exec`'s own
   *  `ctx` seam). */
  ctx: () => ChCtx;
  /** Resolves (and applies) the IdP/CH-auth config before every server call —
   *  matches app.ts's own `conn.ensureConfig`. Loosely typed (`Promise<unknown>`,
   *  matching `workbench-session.ts`'s own `ensureConfig` seam) — this service
   *  never reads the resolved config, only awaits it. */
  ensureConfig(): Promise<unknown>;
  /** SQL-string-quoting function `loadColumns` needs to build its literals
   *  (matches `core/format.js`'s `sqlString`). */
  sqlString: (s: unknown) => string;
  state: SchemaCatalogStateSlice;
  hooks: SchemaCatalogHooks;
}

// ── The service ──────────────────────────────────────────────────────────────

/** The service surface `app.catalog` will hold. */
export interface SchemaCatalogService {
  loadVersion(): Promise<void>;
  loadSchema(): Promise<void>;
  loadColumns(db: string, table: string): Promise<void>;
  loadReference(): Promise<void>;
  rebuildCompletions(): void;
  /** #313 — target-aware, kind-cache-keyed, connection-generation-safe
   *  documentation lookups for the CM6 hover/F1/reference-pane feature. Both
   *  share ONE fetch: `docSummary` is `summaryFromEntry` projected over the
   *  same entry cache `docEntry` populates — a lookup never runs the SQL
   *  twice for the same target. See `resolveDocEntry`'s comment for the full
   *  capability-probe / cache / generation-safety semantics. */
  docSummary(target: DocTarget): Promise<DocLookup<DocSummary>>;
  docEntry(target: DocTarget): Promise<DocLookup<DocEntry>>;
  /** #315 — explicit full-Markdown-depth lookup, ALWAYS `system.documentation`
   *  regardless of the #313/#314 structured-source preference `docEntry`
   *  applies (the pane's future "Full reference" section). Same dedupe/
   *  cache/generation-safety semantics as `docEntry`, in a separate cache
   *  keyed the same `kind:name` way (the value type differs). */
  docMarkdown(target: DocTarget): Promise<DocLookup<MarkdownDocEntry>>;
  /** #315 — name-only disambiguation across ALL kinds sharing this name
   *  (bounded by `DOCUMENTATION_DISAMBIGUATION_LIMIT`, doc-documentation.ts).
   *  `system.documentation`-only (no structured-source counterpart — the
   *  structured sources are already kind-scoped by construction, so there is
   *  nothing to disambiguate there). Dedupes concurrent calls for the SAME
   *  name; not a durable cache (see `docDisambiguate`'s own comment). */
  docDisambiguate(name: string): Promise<DocLookup<DocSummary[]>>;
  /** #314 — SYNCHRONOUS read of the current capability state for `kind`,
   *  never triggering a probe: `true`/`false` once `ensureCapability`/
   *  `ensureStructuredCapability` has durably settled (including a durably-
   *  unavailable result), `null` when nothing has resolved yet — either the
   *  capability was never probed (no `docSummary`/`docEntry` lookup has run
   *  for this connection/kind) or the last probe attempt was transient and
   *  hasn't been retried. Schema-surface actions (#314 "Unavailable docs hide
   *  or disable the action without a toast") render whenever this is NOT
   *  `false` — `null` (unknown) counts as available, and a lookup that then
   *  fails surfaces the pane's existing quiet `unavailable` state rather than
   *  a toast. */
  docKindAvailable(kind: DocKind): boolean | null;
  /** The editor reference data (keywords/functions/…) — a get/set ACCESSOR
   *  (not a plain field) so `app.catalog.refData` always reads the CURRENT
   *  value after a `loadReference()`/`invalidate()` rebuild, without app.ts
   *  needing to re-mirror it onto itself on every rebuild (see app.ts's
   *  exposure decision, documented there). The setter exists for the exact
   *  same reason the pre-extraction code kept `refData`/`completions` as
   *  plain reassignable `App` properties: a caller (a test, or a future
   *  feature) can overwrite the live value directly — e.g.
   *  `tests/e2e/editor-cm6.spec.js` does `app.completions =
   *  app.completions.concat([...])` to seed synthetic candidates — and that
   *  override sticks until the next real rebuild (`rebuildCompletions`/
   *  `loadReference`/`loadSchema`/`loadColumns`) recomputes it from scratch,
   *  exactly as it did when this was `Object.assign(app, {refData})`. */
  refData: AssembledReference;
  /** The flat completion candidate list built from `refData` + the live
   *  schema — same live get/set-accessor reasoning as `refData` above. */
  completions: CompletionItem[];
  /** Clears the reference/completions/documentation caches back to the
   *  built-in fallback (issue #276 §6). Nothing in the pre-extraction app.ts
   *  cleared `refData` outside of `loadReference` itself (which already
   *  rebuilds `refData` from a fresh fetch) — this is a NEW capability, not
   *  wired to any call site yet. Phase 5 is expected to call it on a
   *  connection change (sign-out/reconnect); calling it here would change
   *  today's behavior, so this extraction does not.
   *  #313 additionally clears the `docSummary`/`docEntry` state: the
   *  capability probe/result, the entry cache, and bumps the doc generation
   *  so any lookup already in flight resolves `unavailable` rather than
   *  repopulating the (now-reset) cache. `loadReference()` does the same
   *  reset — it is the real per-connection reset and can run without an
   *  intervening `invalidate()` call. */
  invalidate(): void;
}

/** Build a `SchemaCatalogService` bound to `deps`. Trivial constructor — no
 *  validation, no defaulting; the caller supplies every field of `deps`
 *  exactly as it wants it used. */
export function createSchemaCatalogService(deps: SchemaCatalogDeps): SchemaCatalogService {
  const { state, hooks } = deps;

  // Editor reference data + autocomplete candidates. Loaded once per
  // connection (the keystroke rule, #25): keywords/functions drive both
  // version-correct highlighting and the autocomplete list; completion then
  // runs client-side. `refData`/`completions` are private closure state —
  // `app.catalog.refData`/`app.catalog.completions` (#276 Phase 5 deleted the
  // flat `App.refData`/`App.completions` delegates app.ts used to mirror them
  // onto) read them via the getters above/below, always the CURRENT value.
  let refData: AssembledReference = assembleReferenceData(null); // built-in fallback until loaded
  let completions: CompletionItem[] = buildCompletions(refData, state.schema.value as SchemaDb[] | null);

  function rebuildCompletions(): void {
    completions = buildCompletions(refData, state.schema.value as SchemaDb[] | null);
  }

  // ── #313 target-aware documentation (docSummary/docEntry) ──────────────────
  //
  // Connection-scoped state, reset by `resetDocsState()` (called from both
  // `invalidate()` and the top of `loadReferenceImpl` — see those functions):
  //  - `docGeneration` — bumped on every reset; a lookup captures the
  //    generation it started under and, if that generation has moved on by
  //    the time its async result settles, drops the result silently: no
  //    cache write, no map entry left behind, and the caller gets
  //    `{status:'unavailable'}` (never a rejection — CM6 info callbacks hold
  //    these promises and must not see them reject).
  //  - `capability`/`capabilityProbe` — the lazy, once-per-connection,
  //    deduped `system.functions` capability probe. `capability` is the
  //    durable, cached result once known (including a durably-`unavailable`
  //    one — `functionsCapabilityFromColumns([]).available === false`).
  //    `capabilityProbe` is the in-flight promise while a probe is running;
  //    concurrent `docSummary`/`docEntry` calls share it. A probe that comes
  //    back `null` (see `loadFunctionsDocColumns`'s ch-client.ts doc comment:
  //    `tryQueryData` conflates "denied `system.columns` read" with "a
  //    transient network hiccup", so this can't tell them apart) is NOT
  //    cached into `capability` — `capabilityProbe` is cleared so the NEXT
  //    lookup batch re-probes, but a probe already in flight is still shared
  //    by every concurrent caller (no request storm: at most one retry per
  //    batch of concurrent lookups, never one probe per lookup).
  //  - `entryCache` — keyed by `target.kind + ':' + target.name` (the raw
  //    requested name, NOT lowercased — case-insensitivity lives in the SQL
  //    built by `buildFunctionDocSelect`). Holds either the settled
  //    `DocLookup<DocEntry>` or the in-flight promise (a settled/pending map
  //    entry dedupes concurrent lookups the same way the old `entityDoc`
  //    hover-doc cache did). `docSummary` never queries directly — it awaits
  //    the SAME entry the `docEntry` cache holds and projects it down with
  //    `summaryFromEntry`, so one fetch always serves both.
  //
  // Kind-mismatch policy (#313): `system.functions` carries `is_aggregate`,
  // so a lookup requested as `{kind:'function', name:'quantile'}` fetches a
  // row that `normalizeFunctionRow` correctly normalizes to
  // `kind:'aggregate-function'` — the fetched row is the truth, callers
  // display the normalized kind. That is NOT a kind mismatch → 'missing':
  // hover/F1 callers can't know aggregateness up front. The found result is
  // cached under BOTH the requested key and the normalized `kind:name` key,
  // so a later lookup under either kind is served from cache without a
  // second fetch.
  let docGeneration = 0;
  let capability: FunctionsDocCapability | null = null;
  let capabilityProbe: Promise<FunctionsDocCapability | null> | null = null;
  // #314 — each of the four structured kinds gets its OWN capability/in-flight
  // probe slot, keyed by kind: a denied/missing source (e.g. `system.formats`
  // access denied) is durably `unavailable` for THAT kind only, and never
  // affects the other three kinds or the function capability above (#314
  // "Cache and lifecycle": "Capability state is independent per source").
  const structuredCapability = new Map<StructuredDocKind, StructuredDocCapability | null>();
  const structuredCapabilityProbe = new Map<StructuredDocKind, Promise<StructuredDocCapability | null> | null>();
  const entryCache = new Map<string, DocLookup<DocEntry> | Promise<DocLookup<DocEntry>>>();
  // #315 — `system.documentation`'s own capability/in-flight-probe slot,
  // parallel to `capability`/`structuredCapability` above. `documentationCache`
  // holds `docMarkdown`'s full-Markdown-depth results (same `kind:name` key
  // shape as `entryCache`) — a SEPARATE map from `entryCache` because
  // `docMarkdown` returns `MarkdownDocEntry`, not `DocEntry` (the two never
  // collide on the same key/value type, so keeping them separate is simpler
  // than a union-valued shared map).
  let docsCapability: DocumentationCapability | null = null;
  let docsCapabilityProbe: Promise<DocumentationCapability | null> | null = null;
  const documentationCache = new Map<string, DocLookup<MarkdownDocEntry> | Promise<DocLookup<MarkdownDocEntry>>>();

  function resetDocsState(): void {
    docGeneration++;
    capability = null;
    capabilityProbe = null;
    structuredCapability.clear();
    structuredCapabilityProbe.clear();
    entryCache.clear();
    docsCapability = null;
    docsCapabilityProbe = null;
    documentationCache.clear();
  }

  function ensureCapability(): Promise<FunctionsDocCapability | null> {
    if (capability) return Promise.resolve(capability);
    if (capabilityProbe) return capabilityProbe; // dedupe concurrent probes
    const gen = docGeneration;
    const probe = (async (): Promise<FunctionsDocCapability | null> => {
      await deps.ensureConfig();
      const cols = await deps.loadFunctionsDocColumns(deps.ctx());
      if (gen !== docGeneration) return null; // superseded by invalidate/reconnect — never write shared capability state
      capabilityProbe = null; // settle: clears the in-flight slot so a `null` result below lets the next lookup batch retry
      if (cols === null) return null; // transient/denied probe failure — NOT cached into `capability`
      capability = functionsCapabilityFromColumns(cols); // durable, including a durably-unavailable result ([] columns)
      return capability;
    })();
    capabilityProbe = probe;
    return probe;
  }

  // #314 — same lazy/dedupe/generation-safety shape as `ensureCapability`
  // above, but keyed per structured kind so e.g. a denied `system.formats`
  // probe never blocks or disables `table-engine`/`database-engine`/
  // `data-type` lookups on the same connection.
  function ensureStructuredCapability(kind: StructuredDocKind): Promise<StructuredDocCapability | null> {
    const cached = structuredCapability.get(kind);
    if (cached) return Promise.resolve(cached);
    const inflight = structuredCapabilityProbe.get(kind);
    if (inflight) return inflight; // dedupe concurrent probes for the SAME kind
    const gen = docGeneration;
    const probe = (async (): Promise<StructuredDocCapability | null> => {
      await deps.ensureConfig();
      const cols = await deps.loadDocTableColumns(deps.ctx(), STRUCTURED_PROBE_TABLE[kind]);
      if (gen !== docGeneration) return null; // superseded by invalidate/reconnect — never write shared capability state
      structuredCapabilityProbe.set(kind, null); // settle: clears the in-flight slot so a `null` result lets the next batch retry
      if (cols === null) return null; // transient/denied probe failure — NOT cached
      const cap = structuredCapabilityFromColumns(kind, cols); // durable, including a durably-unavailable result ([] columns)
      structuredCapability.set(kind, cap);
      return cap;
    })();
    structuredCapabilityProbe.set(kind, probe);
    return probe;
  }

  // #315 — the `system.documentation` capability probe. Unlike
  // `ensureCapability`/`ensureStructuredCapability`, this ALSO consults the
  // version-gate policy first (`documentationProbePolicy`, reading the
  // CURRENT `state.serverVersion` — not a value captured once at service
  // construction, since a connection's version is only known after
  // `loadVersion()` resolves, which can happen after this service is built):
  // a parsed pre-26.6 version marks the capability unavailable WITHOUT
  // issuing any `system.columns` probe at all (#315 "Version and capability
  // policy"); a 26.6+/unparsable/unknown version probes exactly like
  // #313/#314's capabilities do.
  //
  // The 'skip' verdict is deliberately NON-durable (returned per-call, never
  // written into `docsCapability`): `loadVersion()`'s network round-trip is
  // not sequenced with `resetDocsState()`, so a lookup racing a reconnect
  // can read the PREVIOUS connection's version — durably caching that
  // verdict would lock documentation off for the whole new session (review
  // finding). Re-evaluating costs zero network (that is the whole point of
  // 'skip'), still satisfies "pre-26.6 servers produce zero requests", and
  // self-heals the moment `state.serverVersion` catches up. Probe RESULTS
  // (including durably-unavailable [] shapes) stay durable as before.
  function ensureDocumentationCapability(): Promise<DocumentationCapability | null> {
    if (docsCapability) return Promise.resolve(docsCapability);
    if (docsCapabilityProbe) return docsCapabilityProbe; // dedupe concurrent probes
    if (documentationProbePolicy(parseServerVersion(state.serverVersion)) === 'skip') {
      return Promise.resolve(null); // unavailable NOW, no query — re-evaluated on the next lookup
    }
    const gen = docGeneration;
    const probe = (async (): Promise<DocumentationCapability | null> => {
      await deps.ensureConfig();
      const cols = await deps.loadDocTableColumns(deps.ctx(), 'documentation');
      if (gen !== docGeneration) return null; // superseded by invalidate/reconnect — never write shared capability state
      docsCapabilityProbe = null; // settle: clears the in-flight slot so a `null` result below lets the next lookup batch retry
      if (cols === null) return null; // transient/denied probe failure — NOT cached into `docsCapability`
      docsCapability = documentationCapabilityFromColumns(cols); // durable, including a durably-unavailable result ([] columns)
      return docsCapability;
    })();
    docsCapabilityProbe = probe;
    return probe;
  }

  interface DocEntryResolution { lookup: DocLookup<DocEntry>; cacheable: boolean }
  interface DocumentationEntryResolution { lookup: DocLookup<MarkdownDocEntry>; cacheable: boolean }

  async function resolveFunctionDocEntry(target: DocTarget, gen: number): Promise<DocEntryResolution> {
    const cap = await ensureCapability();
    if (gen !== docGeneration) return { lookup: { status: 'unavailable' }, cacheable: false };
    if (cap === null) return { lookup: { status: 'unavailable' }, cacheable: false }; // transient capability-probe failure
    if (!cap.available) return { lookup: { status: 'unavailable' }, cacheable: true }; // durably-confirmed absent/denied capability
    // `cap.available` guarantees `buildFunctionDocSelect` returns a SELECT, not null.
    const sql = buildFunctionDocSelect(cap, target.name, deps.sqlString)!;
    await deps.ensureConfig();
    const rows = await deps.loadFunctionDocRow(deps.ctx(), sql);
    if (gen !== docGeneration) return { lookup: { status: 'unavailable' }, cacheable: false };
    if (rows === null) return { lookup: { status: 'unavailable' }, cacheable: false }; // transient row-fetch failure — not cached
    if (rows.length === 0) return { lookup: { status: 'missing' }, cacheable: true };
    const entry = normalizeFunctionRow(rows[0] as Record<string, string | number | boolean | null | undefined>, cap);
    return { lookup: { status: 'found', value: entry }, cacheable: true };
  }

  // #314 — the structured-kind counterpart of `resolveFunctionDocEntry`,
  // identical shape (probe -> SELECT -> row fetch -> normalize), just routed
  // through the structured capability/select/normalize machinery. Every
  // structured normalizer returns `entry.target.kind === kind` (no kind
  // widening like function->aggregate-function), but the NAME can still
  // differ from the requested one: the case-insensitive WHERE match returns
  // the server's canonically-cased name (lookup 'mergetree' -> row
  // 'MergeTree'), so `docEntry`'s generic normKey/key comparison below DOES
  // fire for a case-mismatched lookup and additionally caches the entry
  // under the canonical key — deliberate, matching Phase 1's dual-key
  // behavior.
  async function resolveStructuredDocEntry(target: DocTarget, gen: number): Promise<DocEntryResolution> {
    const kind = target.kind as StructuredDocKind;
    const cap = await ensureStructuredCapability(kind);
    if (gen !== docGeneration) return { lookup: { status: 'unavailable' }, cacheable: false };
    if (cap === null) return { lookup: { status: 'unavailable' }, cacheable: false }; // transient capability-probe failure
    if (!cap.available) return { lookup: { status: 'unavailable' }, cacheable: true }; // durably-confirmed absent/denied capability
    // `cap.available` guarantees `buildStructuredDocSelect` returns a SELECT, not null.
    const sql = buildStructuredDocSelect(kind, cap, target.name, deps.sqlString)!;
    await deps.ensureConfig();
    const rows = await deps.loadDocRow(deps.ctx(), sql);
    if (gen !== docGeneration) return { lookup: { status: 'unavailable' }, cacheable: false };
    if (rows === null) return { lookup: { status: 'unavailable' }, cacheable: false }; // transient row-fetch failure — not cached
    if (rows.length === 0) return { lookup: { status: 'missing' }, cacheable: true };
    const entry = normalizeStructuredRow(kind, rows[0] as Record<string, string | number | boolean | null | undefined | unknown[]>, cap);
    return { lookup: { status: 'found', value: entry }, cacheable: true };
  }

  // #315 — the `system.documentation` counterpart of
  // `resolveFunctionDocEntry`/`resolveStructuredDocEntry`: probe -> SELECT (by
  // type+name, when `target.kind` maps to a known server `type` label) -> row
  // fetch -> normalize. Returns the RAW `MarkdownDocEntry` resolution (not yet
  // projected to `DocEntry`) so `docMarkdown` can use it directly and
  // `resolveDocEntry`'s fallback path can project it. A `target.kind` with no
  // known server `type` label (`docKindToServerType` -> `null`, e.g.
  // `'unknown'`/`'codec'`/`'metric'`/`'system-table'` on a server that
  // doesn't emit that label) resolves `missing` once the capability itself is
  // confirmed available — there is no `type` value to query by, and that is a
  // successful "no such row" outcome, not an error.
  async function resolveDocumentationEntry(target: DocTarget, gen: number): Promise<DocumentationEntryResolution> {
    const cap = await ensureDocumentationCapability();
    if (gen !== docGeneration) return { lookup: { status: 'unavailable' }, cacheable: false };
    if (cap === null) return { lookup: { status: 'unavailable' }, cacheable: false }; // transient capability-probe failure
    if (!cap.available) return { lookup: { status: 'unavailable' }, cacheable: true }; // durably-confirmed absent/denied/pre-26.6
    const sql = buildDocumentationSelect(cap, target.kind, target.name, deps.sqlString);
    if (sql === null) return { lookup: { status: 'missing' }, cacheable: true }; // no server `type` label for this kind
    await deps.ensureConfig();
    const rows = await deps.loadDocRow(deps.ctx(), sql);
    if (gen !== docGeneration) return { lookup: { status: 'unavailable' }, cacheable: false };
    if (rows === null) return { lookup: { status: 'unavailable' }, cacheable: false }; // transient row-fetch failure — not cached
    if (rows.length === 0) return { lookup: { status: 'missing' }, cacheable: true };
    const entry = normalizeDocumentationRow(rows[0] as Record<string, string | number | boolean | null | undefined>, cap);
    return { lookup: { status: 'found', value: entry }, cacheable: true };
  }

  // #315 source preference: a kind with a #313/#314 structured loader
  // (function/aggregate-function/format/table-engine/database-engine/
  // data-type) tries that FIRST; a `found`/`missing` result from it is kept
  // as-is (structured `missing` does NOT fall through to `system.documentation`
  // — a confirmed no-match from the more specific source is the truth). Only
  // a DURABLE `unavailable` (the structured/function capability itself is
  // confirmed absent/denied — `cacheable: true`) falls through to
  // `system.documentation`; a TRANSIENT failure (`cacheable: false`) is
  // returned as-is so the caller retries the structured path rather than
  // silently answering from a different source. A kind with NO structured
  // loader at all (settings, table functions, dictionary layouts/sources, …)
  // goes straight to `system.documentation`.
  async function resolveDocEntry(target: DocTarget, gen: number): Promise<DocEntryResolution> {
    if (hasStructuredLoader(target.kind)) {
      const structured = isStructuredKind(target.kind)
        ? await resolveStructuredDocEntry(target, gen)
        : await resolveFunctionDocEntry(target, gen);
      if (structured.lookup.status !== 'unavailable' || !structured.cacheable) return structured;
      if (gen !== docGeneration) return { lookup: { status: 'unavailable' }, cacheable: false };
      const fallback = await resolveDocumentationEntry(target, gen);
      return projectDocumentationResolution(fallback);
    }
    const result = await resolveDocumentationEntry(target, gen);
    return projectDocumentationResolution(result);
  }

  // Project a `DocumentationEntryResolution` (`DocLookup<MarkdownDocEntry>`)
  // down to a `DocEntryResolution` (`DocLookup<DocEntry>`) — only the `found`
  // arm actually carries a `value` to convert; `missing`/`unavailable` carry
  // no source-specific payload, so they pass through structurally unchanged.
  function projectDocumentationResolution(result: DocumentationEntryResolution): DocEntryResolution {
    if (result.lookup.status !== 'found') return { lookup: result.lookup, cacheable: result.cacheable };
    return { lookup: { status: 'found', value: documentationEntryToDocEntry(result.lookup.value) }, cacheable: result.cacheable };
  }

  function docEntry(target: DocTarget): Promise<DocLookup<DocEntry>> {
    const key = target.kind + ':' + target.name;
    const cached = entryCache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);

    const gen = docGeneration;
    const promise: Promise<DocLookup<DocEntry>> = resolveDocEntry(target, gen).then((result) => {
      // If a reset (invalidate/loadReference) ran while this was in flight,
      // `entryCache` was cleared wholesale and may already hold a NEWER
      // promise for this same key (a fresh lookup that started after the
      // reset) — only touch the map when it still holds exactly the promise
      // we're settling, so a stale response can never clobber a fresh one.
      if (entryCache.get(key) !== promise) return result.lookup;
      if (result.cacheable) {
        entryCache.set(key, result.lookup);
        if (result.lookup.status === 'found') {
          const normKey = result.lookup.value.target.kind + ':' + result.lookup.value.target.name;
          if (normKey !== key) entryCache.set(normKey, result.lookup); // kind-mismatch: cache the normalized truth too
        }
      } else {
        entryCache.delete(key); // transient/stale — no durable entry, next call retries
      }
      return result.lookup;
    });
    entryCache.set(key, promise); // dedupe concurrent lookups of the same key
    return promise;
  }

  // Sync, never probes: `capability`/`structuredCapability` are only ever
  // written by a settled `ensureCapability`/`ensureStructuredCapability` probe
  // (never a transient/superseded one — see those functions' comments), so
  // reading them here can't distinguish "never asked" from "asked and the
  // probe is still in flight/transient-failed" — both correctly read `null`.
  // `null` for a kind with no structured/function loader at all (#315).
  function structuredOrFunctionAvailable(kind: DocKind): boolean | null {
    if (kind === 'function' || kind === 'aggregate-function') return capability ? capability.available : null;
    if (isStructuredKind(kind)) {
      const cap = structuredCapability.get(kind);
      return cap ? cap.available : null;
    }
    return null;
  }

  // #314 — sync, never probes. #315 additionally consults `docsCapability`
  // (also written only by a settled probe, or immediately/durably by a
  // version-gate 'skip' — never a transient one) as the source that may make
  // a BROAD kind available even when it has no structured loader, or when its
  // structured loader is durably absent: "documentation capability may make
  // broad kinds available" — see this method's own interface doc comment.
  function docKindAvailable(kind: DocKind): boolean | null {
    const structuredAvail = structuredOrFunctionAvailable(kind);
    if (structuredAvail === true) return true;
    const docsAvail = docsCapability ? docsCapability.available : null;
    if (structuredAvail === false) {
      // Structured/function loader durably absent for this kind — the
      // documentation capability may still cover it.
      if (docsAvail !== null) return docsAvail;
      return null; // documentation not yet probed — genuinely unknown
    }
    // structuredAvail === null: either not yet probed (a kind WITH a
    // structured/function loader — stay null, matching pre-#315 behavior
    // exactly) or a kind with NO structured/function loader at all (purely
    // the documentation capability).
    if (hasStructuredLoader(kind)) return null;
    return docsAvail;
  }

  async function docSummary(target: DocTarget): Promise<DocLookup<DocSummary>> {
    const result = await docEntry(target);
    if (result.status !== 'found') return result;
    return { status: 'found', value: summaryFromEntry(result.value) };
  }

  // #315 — explicit full-Markdown-depth lookup: ALWAYS `system.documentation`,
  // never the structured preference `docEntry` applies (the pane's future
  // "Full reference" section wants the actual Markdown body regardless of
  // whether a structured entry already answered the compact view). Same
  // dedupe/cache/generation-safety shape as `docEntry` — a separate
  // `documentationCache` (keyed the same `kind:name` way) because the VALUE
  // type differs (`MarkdownDocEntry`, not `DocEntry`).
  function docMarkdown(target: DocTarget): Promise<DocLookup<MarkdownDocEntry>> {
    const key = target.kind + ':' + target.name;
    const cached = documentationCache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);

    const gen = docGeneration;
    const promise: Promise<DocLookup<MarkdownDocEntry>> = resolveDocumentationEntry(target, gen).then((result) => {
      if (documentationCache.get(key) !== promise) return result.lookup;
      if (result.cacheable) {
        documentationCache.set(key, result.lookup);
        if (result.lookup.status === 'found') {
          const normKey = result.lookup.value.target.kind + ':' + result.lookup.value.target.name;
          if (normKey !== key) documentationCache.set(normKey, result.lookup);
        }
      } else {
        documentationCache.delete(key);
      }
      return result.lookup;
    });
    documentationCache.set(key, promise);
    return promise;
  }

  // #315 — name-only disambiguation: no `type` filter, so it returns every
  // kind sharing this name (bounded by `DOCUMENTATION_DISAMBIGUATION_LIMIT`).
  // Dedupes CONCURRENT calls for the same name (an in-flight map, cleared on
  // settle) but is not itself a durable cache — disambiguation results are
  // cheap/rare enough (a user explicitly asking "what else is named X") that
  // there is no lasting cache to invalidate.
  const disambiguateInFlight = new Map<string, Promise<DocLookup<DocSummary[]>>>();

  async function resolveDisambiguate(name: string, gen: number): Promise<DocLookup<DocSummary[]>> {
    const cap = await ensureDocumentationCapability();
    if (gen !== docGeneration) return { status: 'unavailable' };
    if (cap === null) return { status: 'unavailable' }; // transient capability-probe failure
    if (!cap.available) return { status: 'unavailable' }; // durably-confirmed absent/denied/pre-26.6
    // `cap.available` guarantees `buildDocumentationNameSelect` returns a SELECT, not null.
    const sql = buildDocumentationNameSelect(cap, name, deps.sqlString)!;
    await deps.ensureConfig();
    const rows = await deps.loadDocRow(deps.ctx(), sql);
    if (gen !== docGeneration) return { status: 'unavailable' };
    if (rows === null) return { status: 'unavailable' }; // transient row-fetch failure
    if (rows.length === 0) return { status: 'missing' };
    const summaries: DocSummary[] = rows.map((r) => {
      const entry = normalizeDocumentationRow(r as Record<string, string | number | boolean | null | undefined>, cap);
      return { target: entry.target, title: entry.title, signature: entry.signature, summary: entry.summary };
    });
    return { status: 'found', value: summaries };
  }

  function docDisambiguate(name: string): Promise<DocLookup<DocSummary[]>> {
    const inflight = disambiguateInFlight.get(name);
    if (inflight) return inflight;
    const gen = docGeneration;
    const promise = resolveDisambiguate(name, gen).then((result) => {
      disambiguateInFlight.delete(name);
      return result;
    });
    disambiguateInFlight.set(name, promise);
    return promise;
  }

  async function loadVersion(): Promise<void> {
    try {
      await deps.ensureConfig();
      state.serverVersion = await deps.loadServerVersion(deps.ctx());
      hooks.onConnStatusChanged?.(true);
    } catch {
      hooks.onConnStatusChanged?.(false);
    }
  }

  async function loadSchemaImpl(): Promise<void> {
    try {
      await deps.ensureConfig();
      const schema = await deps.loadSchema(deps.ctx());
      // One batched write → one repaint (app.ts's schema effect + banner
      // effect react to these signals; no manual renderSchema/updateBanner
      // needed here).
      batch(() => { state.schema.value = schema; state.schemaError.value = null; });
    } catch (e) {
      state.schemaError.value = String((e instanceof Error && e.message) || e);
    }
    rebuildCompletions();
  }

  // Lazily load a table's columns into the schema signal by REFERENCE (no
  // in-place mutation): replace the target table object with `{...tb, columns}`.
  // 'loading' is written synchronously (before the await) so the schema effect
  // paints the spinner immediately; the result/[] write repaints with the data.
  // `tb.columns` stays the completion cache that buildCompletions reads.
  async function loadColumnsImpl(db: string, table: string): Promise<void> {
    const setCols = (cols: SchemaColumn[] | 'loading'): void => {
      // `.value` is asserted non-null (matches the original untyped behavior
      // verbatim: a null schema here throws, exactly as `null.map(...)` always
      // did) — loadColumns only ever fires from a click on an already-rendered
      // schema-tree row, i.e. after the schema itself has loaded.
      state.schema.value = (state.schema.value as SchemaDb[]).map((d) =>
        (d.db === db
          ? { ...d, tables: (d.tables as SchemaTable[]).map((t): SchemaTable => (t.name === table ? { ...t, columns: cols } : t)) }
          : d));
    };
    setCols('loading');
    try {
      await deps.ensureConfig();
      setCols(await deps.loadColumns(deps.ctx(), db, table, deps.sqlString));
    } catch {
      setCols([]);
    }
    rebuildCompletions(); // newly-loaded columns become completion candidates (#26)
    // #172 v2: a newly-loaded column may now resolve a String var's schema-
    // cache-inferred enum suggestion (paramComparisonColumns +
    // resolveComparisonColumnType) — repaint so it can upgrade from a plain
    // input the moment the idle-tick load lands, not just on the next
    // keystroke/tab-switch. renderVarStrip's own signature guard (which folds
    // in each var's resolved enum options) skips the actual DOM rebuild when
    // nothing changed, so this is a cheap no-op otherwise.
    hooks.renderVarStrip();
  }

  async function loadReferenceImpl(): Promise<void> {
    // #313: this is the REAL per-connection reset (it runs on every new
    // connection, with or without an intervening `invalidate()`/sign-out) —
    // bump the doc generation and clear the capability/entry-cache state
    // before anything else, so a `docSummary`/`docEntry` lookup already in
    // flight against the OLD connection drops its result instead of
    // repopulating the cache for the new one.
    resetDocsState();
    await deps.ensureConfig();
    refData = assembleReferenceData(await deps.loadReferenceData(deps.ctx()));
    rebuildCompletions();
    hooks.refreshEditorReference(); // re-highlight with server keywords
  }

  function invalidate(): void {
    resetDocsState();
    refData = assembleReferenceData(null);
    rebuildCompletions();
  }

  return {
    loadVersion,
    loadSchema: loadSchemaImpl,
    loadColumns: loadColumnsImpl,
    loadReference: loadReferenceImpl,
    rebuildCompletions,
    docSummary,
    docEntry,
    docMarkdown,
    docDisambiguate,
    docKindAvailable,
    get refData() { return refData; },
    set refData(v: AssembledReference) { refData = v; },
    get completions() { return completions; },
    set completions(v: CompletionItem[]) { completions = v; },
    invalidate,
  };
}
