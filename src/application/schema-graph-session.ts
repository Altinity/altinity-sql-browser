// #276 Phase 4D's SchemaGraphSession — the inline schema-lineage drawer
// (issue #124's two-phase progressive draw) and the rich fullscreen
// expand/detail flow, extracted from app.ts (see that file's history around
// `cancelSchemaGraph`/`showSchemaGraph`/`expandSchemaGraph`/`openNodeDetail`,
// formerly inline in `createApp`) so it's constructible without App/AppState/
// DOM (issue #276 §9). Byte-for-byte port of the async control flow: the
// tab.result / tab.result.schemaGraph in-place mutation, the reference-
// identity stale-write guard (mirrors #97's shape, same as WorkbenchSession's
// own run() guard — deliberately NOT a generation counter), and the
// last-clicked-wins node-detail WeakMap all move verbatim. No imports from
// `src/ui/**` or `src/editor/**` (a pretest check enforces this) — DOM stays
// in app.ts: `openSchemaView`'s view object is opened synchronously by the
// shell BEFORE the awaited `expand()` call (so it survives the click gesture)
// and the shell alone calls `view.render`/`view.fail` — this session never
// sees the view object. Likewise `openDetailPane` (the loading-placeholder +
// final mount) stays shell-side; this session only resolves the detail data
// (or `null` when a later click superseded this one).
//
// Deviation (recorded for review): `expand()`'s auth-failure path is
// distinguished from a generic fetch failure via a thrown
// `SchemaGraphAuthRequiredError` (carrying the exact user-facing message) —
// the session has no `view` to call `.fail(...)` on directly, so the shell
// catches this specific error type to choose between "Sign in to view the
// schema graph." and the generic "Could not load the schema graph.".

import type { ChCtx } from '../net/ch-client.js';
import type {
  loadSchemaLineage, loadLineageTransitive, loadSchemaCards, loadTableDetail, CardColumnRow, TableDetail,
} from '../net/ch-client.js';
import { buildSchemaGraph, expandLineage } from '../core/schema-graph.js';
import type { SchemaGraphNode, SchemaGraphEdge } from '../core/schema-graph.js';
import { buildCardGraph } from '../core/schema-cards.js';
import type { CardGraphNode, CardGraphEdge, CardModel, SchemaCardColumnRow } from '../core/schema-cards.js';
import type { PositionMap } from '../core/graph-layout.js';
import { newResult } from '../core/stream.js';
import type { StreamResult } from '../core/stream.js';

// ── Shapes redeclared locally rather than imported across the
// application→ui boundary (rule 1) ──────────────────────────────────────────

/** A schema entity reference — structurally the same shape as app.types.ts's
 *  own `SchemaFocus` (three real runtime shapes share it there: the drag/click
 *  FOCUS payload, and a resolved lineage-graph NODE for `loadNodeDetail`) —
 *  redeclared here rather than imported, the same convention app.types.ts's
 *  own `ChCtx` doc comment documents for the opposite direction ("src/ui/**
 *  may depend on src/application/**, never the reverse"). */
export interface SchemaGraphFocus {
  db?: string;
  name?: string;
  table?: string;
  kind?: string;
  id?: string;
}

/** The progressive-load schema-lineage data this session writes into
 *  `tab.result.schemaGraph` — mirrors ui/results.ts's `ResultSchemaGraph`
 *  (itself extending explain-graph.ts's `SchemaLineageGraph`) field-for-field
 *  without importing either (rule 1): this session and those ui readers
 *  independently describe the same runtime shape. `savedPositions` is never
 *  written by this session's own `show()`/`cancel()` — only `expand()`
 *  populates it, in place, on whichever schemaGraph object is live when
 *  Expand is clicked. */
export interface SchemaGraphInlineData {
  focus?: SchemaGraphFocus;
  nodes: SchemaGraphNode[];
  edges: SchemaGraphEdge[];
  tableCount?: number;
  loading?: boolean;
  progress?: { done: number; total: number };
  partial?: boolean;
  savedPositions?: PositionMap;
}

/** `tab.result` widened just enough to read/write the inline schema-graph
 *  slice above — state.ts's own `QueryTab.result` is deliberately opaque
 *  (`Record<string, unknown> | null`); this session (like app.ts before it)
 *  reads/writes through its OWN cast of that same opaque field, never a
 *  shared declared type. */
type SchemaGraphResult = StreamResult & { schemaGraph?: SchemaGraphInlineData };

/** The tab slice this session reads/writes — Pick-shaped, structurally
 *  satisfied by the real `QueryTab` (state.ts), same convention as
 *  `workbench-session.ts`'s own state-slice interfaces. */
export interface SchemaGraphTab {
  result: Record<string, unknown> | null;
}

/** `expand()`'s resolved data — the rich (card) fullscreen dataset. The shell
 *  reasserts `id`/`label` non-optional (explain-graph.ts's `SchemaLineageNode`
 *  requires them, same as the pre-extraction code did) and calls
 *  `view.render(...)`; this session never constructs or sees that ui shape. */
export interface SchemaGraphExpandData {
  nodes: (CardGraphNode & { card: CardModel })[];
  edges: CardGraphEdge[];
  focus: SchemaGraphFocus;
  truncated: boolean;
  savedPositions: PositionMap;
}

/** Thrown by `expand()` when the caller is signed out / unrefreshable — the
 *  session has no `view` to fail directly (rule 4), so it carries the exact
 *  user-facing message the shell should show via `view.fail(err.message)`,
 *  distinct from the generic catch-all for any other failure. */
export class SchemaGraphAuthRequiredError extends Error {}

// ── Injected DOM/render hooks ────────────────────────────────────────────────

export interface SchemaGraphHooks {
  /** Per-phase (show) results-pane repaint. */
  renderResults(): void;
  /** Fired when `deps.getToken()` resolves null (signed out / unrefreshable)
   *  in `show()` — restores the ported code's original
   *  `chCtx.onSignedOut(); return;` behavior without this session knowing
   *  about `chCtx`/`ConnectionSession` (matches `WorkbenchHooks.onAuthFailed`'s
   *  own doc comment). `expand()` fires this too, alongside its own thrown
   *  `SchemaGraphAuthRequiredError` (the shell needs both: the hook to sign
   *  out, the error to pick `view.fail`'s message). */
  onAuthFailed(): void;
  /** Frees a discarded result's own Image (PNG) object URL (#307) — called
   *  by `show()` right before it overwrites `tab.result` wholesale with the
   *  fresh loading placeholder. A no-op for every non-image result (matches
   *  `WorkbenchHooks.revokeResultImage`'s own doc comment — same seam shape,
   *  same convention: the session stays ignorant of `app.revokeObjectUrl`/
   *  results.ts's URL cache), so this call site can invoke it unconditionally. */
  revokeResultImage(result: unknown): void;
}

// ── Construction deps ────────────────────────────────────────────────────────

export interface SchemaGraphDeps {
  ensureConfig(): Promise<unknown>;
  getToken(): Promise<string | null>;
  /** The live ClickHouse auth context — a *provider*, not a value (matches
   *  `schema-catalog-service.ts`'s own `ctx` seam). */
  ctx(): ChCtx;
  loadSchemaLineage: typeof loadSchemaLineage;
  loadLineageTransitive: typeof loadLineageTransitive;
  loadSchemaCards: typeof loadSchemaCards;
  loadTableDetail: typeof loadTableDetail;
  activeTab(): SchemaGraphTab;
  hooks: SchemaGraphHooks;
}

// ── The service ──────────────────────────────────────────────────────────────

export interface SchemaGraphSession {
  /** Render the ClickHouse object-lineage graph for a dropped/clicked
   *  database/table into the data pane (issue #124's two-phase draw). */
  show(focus: SchemaGraphFocus): Promise<void>;
  /** Abort any in-flight inline-pane fetch. `clearResult: true` (a manual
   *  Cancel) additionally settles the visible result: keeps a Phase-A graph
   *  (marked `partial`) if one had already drawn, else drops back to the
   *  empty placeholder. */
  cancel(opts?: { clearResult?: boolean }): void;
  /** Load the enriched rich-card dataset for the fullscreen expand view.
   *  Throws `SchemaGraphAuthRequiredError` when signed out/unrefreshable;
   *  any other failure (a lineage/cards fetch, a graph-build throw) just
   *  propagates — the shell's catch-all maps both to `view.fail(...)`. */
  expand(focus: SchemaGraphFocus): Promise<SchemaGraphExpandData>;
  /** Resolve one clicked node's detail data, or `null` when a later click on
   *  `token` superseded this one before the fetch resolved (last-clicked
   *  wins, not last-resolved — #97). `token` keys the last-clicked-wins
   *  bookkeeping per overlay surface (the shell passes its detached-view
   *  `Document`) — an opaque object identity, not documented as `Document`
   *  here since this session has no other reason to know about DOM. */
  loadNodeDetail(node: SchemaGraphFocus, token: object): Promise<TableDetail | null>;
}

/** Build a `SchemaGraphSession` bound to `deps`. Trivial constructor — no
 *  validation, no defaulting; the caller supplies every field of `deps`
 *  exactly as it wants it used. */
export function createSchemaGraphSession(deps: SchemaGraphDeps): SchemaGraphSession {
  // The inline pane's in-flight fetch controller — PRIVATE session state
  // (formerly `app.state.schemaGraphAbortController`), same "cancellation
  // state lives in its owner" shape as WorkbenchSession's own
  // `abortController`.
  let abortController: AbortController | null = null;

  // Last-clicked-wins bookkeeping for the node-detail pane (#97) — keyed by
  // the shell's opaque per-overlay token (a `Document` in production), so a
  // slow fetch for an earlier click can't clobber a newer pane once it
  // resolves.
  const latestDetailRequest = new WeakMap<object, SchemaGraphFocus>();

  function cancel({ clearResult = false }: { clearResult?: boolean } = {}): void {
    if (abortController) abortController.abort();
    abortController = null;
    if (!clearResult) return;
    const tab = deps.activeTab();
    const result = tab.result as SchemaGraphResult | null;
    const sg = result?.schemaGraph;
    if (!sg || !sg.loading) return;
    if (sg.nodes && sg.nodes.length) {
      sg.loading = false;
      sg.partial = true;
    } else {
      tab.result = null;
    }
    deps.hooks.renderResults();
  }

  async function show(focus: SchemaGraphFocus): Promise<void> {
    if (!focus || !focus.db) return;
    await deps.ensureConfig();
    if (!(await deps.getToken())) { deps.hooks.onAuthFailed(); return; }
    cancel(); // a new click/drag replaces whatever graph was in flight
    const tab = deps.activeTab();
    // Show a loading placeholder first — even Phase A (system.tables +
    // system.dictionaries) is a network round trip.
    const result: SchemaGraphResult = newResult('Table');
    result.schemaGraph = { focus, loading: true, nodes: [], edges: [] };
    deps.hooks.revokeResultImage(tab.result); // #307: free a displayed image's URL before it's overwritten
    Object.assign(tab, { result });
    // `result` is the stale-write guard (mirrors #97's identity-guard shape,
    // and WorkbenchSession's own run() guard): captured once, checked before
    // every later write, so a second graph request (or the shell's own
    // Run/Explain replacing tab.result) that replaces tab.result mid-fetch
    // can never have this call's (Phase A or Phase B) result land on the new
    // tab.result. `tab.result`'s declared type (state.ts's opaque
    // `Record<string,unknown> | null`) has no overlap with our own
    // `SchemaGraphResult` for a direct `!==` — widen `result` to `unknown`
    // (not a further cast to another concrete type) for the comparison only;
    // the identity check itself is unaffected.
    const superseded = (): boolean => tab.result !== (result as unknown);
    deps.hooks.renderResults();
    const controller = new AbortController();
    abortController = controller;
    try {
      const lineage = await deps.loadSchemaLineage(deps.ctx(), focus, {
        signal: controller.signal,
        onBase: (base) => {
          if (superseded()) return; // superseded before Phase A even landed
          const g = buildSchemaGraph(base, focus);
          result.schemaGraph = { focus, nodes: g.nodes, edges: g.edges, tableCount: (base.tables || []).length, loading: true };
          deps.hooks.renderResults();
        },
        onProgress: (done, total) => {
          if (superseded() || !result.schemaGraph || !result.schemaGraph.loading) return;
          result.schemaGraph.progress = { done, total };
          deps.hooks.renderResults();
        },
      });
      if (superseded()) return; // superseded while Phase B was resolving
      const g = buildSchemaGraph(lineage, focus);
      // tableCount lets the renderer explain an empty result ("N tables, none linked").
      result.schemaGraph = { focus, nodes: g.nodes, edges: g.edges, tableCount: (lineage.tables || []).length };
    } catch (e) {
      // AbortError means cancel() already left the pane in a clean state
      // (partial graph or the empty placeholder) — nothing more to do.
      if (e instanceof Error && e.name === 'AbortError') return;
      if (superseded()) return;
      const errorResult: SchemaGraphResult = newResult('Table');
      errorResult.error = String((e instanceof Error && e.message) || e);
      Object.assign(tab, { result: errorResult });
    } finally {
      if (abortController === controller) abortController = null;
    }
    deps.hooks.renderResults();
  }

  // `ch.CardColumnRow` (the real loader shape) has no index signature;
  // `core/schema-cards.ts`'s `SchemaCardColumnRow` (the shape `buildCardGraph`
  // needs) does — reconstructing each row as a fresh object literal satisfies
  // it directly (every field the card model reads is already there; nothing
  // here changes what's read or its values).
  const toCardColumns = (byKey: Record<string, CardColumnRow[]>): Record<string, SchemaCardColumnRow[]> => {
    const out: Record<string, SchemaCardColumnRow[]> = {};
    for (const [key, rows] of Object.entries(byKey)) out[key] = rows.map((row) => ({ ...row }));
    return out;
  };

  async function expand(focus: SchemaGraphFocus): Promise<SchemaGraphExpandData> {
    // Pin the result whose Expand was clicked NOW, before any await: a tab
    // switch during the fetch must not redirect the saved-positions map to a
    // different tab's result (mirrors show()'s own captured-before-any-await
    // tab reference).
    const clickedTab = deps.activeTab();
    const clickedResult = clickedTab.result as SchemaGraphResult | null;
    const sg = clickedResult?.schemaGraph || null;
    await deps.ensureConfig();
    if (!(await deps.getToken())) {
      deps.hooks.onAuthFailed();
      throw new SchemaGraphAuthRequiredError('Sign in to view the schema graph.');
    }
    // Walk lineage transitively across DB boundaries (soft-capped) — pulls in
    // objects an other database references, instead of dead-ending at the edge.
    const lineage = await deps.loadLineageTransitive(deps.ctx(), focus);
    const g = buildSchemaGraph(lineage.rows, focus);
    // Fresh node/edge literals (`{...n}`): `SchemaGraphNode` (buildSchemaGraph's
    // fixed-field output) has no index signature; `ExpandLineageNode` (what
    // expandLineage's graph needs) does — every field it reads is already there.
    const ex = expandLineage({ nodes: g.nodes.map((n) => ({ ...n })), edges: g.edges }, focus.db || ''); // closure around focus.db, tags external nodes
    // Card metadata for every database the expansion reached (external nodes too).
    const dbs = [...new Set(ex.nodes.map((n) => n.db).filter(Boolean))];
    const cards = await deps.loadSchemaCards(deps.ctx(), dbs);
    const cardGraph = buildCardGraph({ nodes: ex.nodes, edges: ex.edges },
      { tables: lineage.rows.tables, columnsByKey: toCardColumns(cards.columnsByKey) });
    // Persist manually-moved node positions per result: the map hangs off the
    // live schemaGraph result (captured above) so re-opening keeps the layout.
    const positions: PositionMap = (sg && sg.savedPositions) || {};
    if (sg) sg.savedPositions = positions;
    return {
      nodes: cardGraph.nodes,
      edges: cardGraph.edges,
      focus,
      truncated: lineage.truncated || ex.truncated,
      savedPositions: positions,
    };
  }

  async function loadNodeDetail(node: SchemaGraphFocus, token: object): Promise<TableDetail | null> {
    if (!node || !node.db || !node.name) return null;
    latestDetailRequest.set(token, node);
    const detail = await deps.loadTableDetail(deps.ctx(), node.db, node.name);
    if (latestDetailRequest.get(token) !== node) return null; // superseded by a later click
    return detail;
  }

  return { show, cancel, expand, loadNodeDetail };
}
