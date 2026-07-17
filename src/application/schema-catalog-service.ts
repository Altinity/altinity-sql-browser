// #276 Phase 4A's SchemaCatalogService — the server-metadata/reference
// lifecycle (server version probe, schema-tree load, lazy per-table column
// load, editor reference data + completion candidates, hover-doc cache)
// extracted from app.ts (see that file's history around `loadVersion`/
// `loadSchema`/`loadColumns`/`loadReference`/`rebuildCompletions`/`entityDoc`,
// formerly inline in `createApp`) so it's constructible without App/AppState/
// DOM (issue #276 §6). This is a byte-for-byte port: every body below matches
// the pre-extraction code verbatim, including the exact error handling
// (loadSchema's catch → `schemaError`), the version-string handling, and the
// completions-rebuild trigger points. No imports from `src/ui/**` or
// `src/editor/**` (a pretest check enforces this) — DOM (`setConn`'s
// `app.dom.connStatus` write, the schemaError-driven banner effect) stays in
// app.ts, driven by the same signals/hooks as today.

import { batch } from '@preact/signals-core';
import type { Signal } from '@preact/signals-core';
import { assembleReferenceData, buildCompletions } from '../core/completions.js';
import type { AssembledReference, CompletionItem } from '../core/completions.js';
import type { SchemaDb, SchemaTable, SchemaColumn } from '../core/from-scope.js';
import type { ChCtx } from '../net/ch-client.js';
import type {
  loadServerVersion, loadSchema, loadColumns, loadReferenceData, loadEntityDoc,
} from '../net/ch-client.js';

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
  loadEntityDoc: typeof loadEntityDoc;
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
  /** SQL-string-quoting function `loadColumns`/`loadEntityDoc` need to build
   *  their literals (matches `core/format.js`'s `sqlString`). */
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
  /** Resolves to `null` on a failed fetch (not cached; retried next call). */
  entityDoc(name: string): Promise<string | null>;
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
  /** A pending fetch while in flight; the resolved doc string once settled (a
   *  failed fetch, `null`, is dropped rather than cached — see `entityDoc`). */
  readonly docCache: Map<string, string | Promise<string | null>>;
  /** Clears the reference/completions/hover-doc caches back to the built-in
   *  fallback (issue #276 §6). Nothing in the pre-extraction app.ts cleared
   *  `docCache`/`refData` outside of `loadReference` itself (which already
   *  clears `docCache` and rebuilds `refData` from a fresh fetch) — this is a
   *  NEW capability, not wired to any call site yet. Phase 5 is expected to
   *  call it on a connection change (sign-out/reconnect); calling it here
   *  would change today's behavior, so this extraction does not. */
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
  // `app.catalog.refData`/`app.catalog.completions` (and app.ts's mirrored
  // `app.refData`/`app.completions`) read them via the getters above/below,
  // always the CURRENT value.
  let refData: AssembledReference = assembleReferenceData(null); // built-in fallback until loaded
  let completions: CompletionItem[] = buildCompletions(refData, state.schema.value as SchemaDb[] | null);

  function rebuildCompletions(): void {
    completions = buildCompletions(refData, state.schema.value as SchemaDb[] | null);
  }

  // Hover docs (#27) are fetched on demand per entity and cached for reuse —
  // descriptions are large, so they stay out of the bulk reference load. The
  // cache holds the resolved string (incl. '' for no-doc / error) so each
  // entity is queried at most once per connection; an in-flight promise is
  // cached too to dedupe concurrent hovers of the same word.
  const docCache = new Map<string, string | Promise<string | null>>();
  function entityDoc(name: string): Promise<string | null> {
    if (docCache.has(name)) return Promise.resolve(docCache.get(name)!);
    const p = deps.ensureConfig().then(() => deps.loadEntityDoc(deps.ctx(), name, deps.sqlString));
    docCache.set(name, p); // dedupe concurrent hovers of the same name
    p.then((doc) => {
      // Cache a resolved doc ('' included = genuinely no doc), but DROP a
      // failed fetch (null) so a transient error doesn't suppress it for the
      // session (#8).
      if (doc === null) docCache.delete(name);
      else docCache.set(name, doc);
    });
    return p;
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
    await deps.ensureConfig();
    refData = assembleReferenceData(await deps.loadReferenceData(deps.ctx()));
    docCache.clear(); // re-fetch hover docs against the (possibly new) connection
    rebuildCompletions();
    hooks.refreshEditorReference(); // re-highlight with server keywords
  }

  function invalidate(): void {
    docCache.clear();
    refData = assembleReferenceData(null);
    rebuildCompletions();
  }

  return {
    loadVersion,
    loadSchema: loadSchemaImpl,
    loadColumns: loadColumnsImpl,
    loadReference: loadReferenceImpl,
    rebuildCompletions,
    entityDoc,
    get refData() { return refData; },
    set refData(v: AssembledReference) { refData = v; },
    get completions() { return completions; },
    set completions(v: CompletionItem[]) { completions = v; },
    get docCache() { return docCache; },
    invalidate,
  };
}
