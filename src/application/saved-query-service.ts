// #276 Phase 4C's SavedQueryService — the saved-query create/commit policy,
// history recording, and share-URL building extracted from app.ts (issue
// #276 §8, plan-review rulings): wraps state.ts's own `createSavedQuery`/
// `commitSavedQuery`/`recordHistory` (already narrowed to exactly the
// `AppState` fields each reads — see state.ts) plus `core/share.js`'s
// `encodeShare`. Constructible without App/AppState/DOM, like
// `query-document-session.ts` alongside it.
//
// Deliberately NOT included (plan-review rulings):
//   - This service never calls `QueryDocumentSession` — `commit`/
//     `buildShareUrl` both take an ALREADY-EVALUATED Spec (`{parsed,
//     diagnostics}`, the exact shape `evaluateSpecText`/
//     `QueryDocumentSession.evaluateSpecDraft` produce) as an input
//     parameter. The SHELL (app.ts) sequences evaluate → commit/share itself;
//     no service-to-service dependency exists in either direction.
//   - The post-commit cascade (`revalidateSpecDrafts` →
//     `specEditor.syncFromState` → `updateSaveBtn` → `rerenderTabs` →
//     `renderSavedHistory` → [`renderResults`] → `updateEditorModeUi`) stays a
//     SHELL convention — app.ts's `commitLinkedQuery`/`openSavePopover`'s
//     commit closure keep their exact call sequences, driven off this
//     service's typed result. This service never imports `ui/results.js`,
//     `ui/saved-history.js`, or any editor port.
//   - Clipboard/location writes stay shell — `buildShareUrl` only builds the
//     URL string; app.ts's own `share()` performs `history.replaceState` and
//     the clipboard write off the returned value.
//   - `savedForTab`/`tabPanel`-based gates that don't touch persistence
//     (`saveActiveQuery`'s linked-tab check, `openSavePopover`'s own
//     "Nothing to save" pre-check before a popover even opens) stay app.ts —
//     they never call into this service.

import {
  createSavedQuery, commitSavedQuery, recordHistory as stateRecordHistory,
} from '../state.js';
import type {
  QueryTab, AppState, SaveJSON, SpecValidationService, HistoryResultSnapshot, QuerySpecDraft, MutateWorkspace,
} from '../state.js';
import { hasBlockingSpecErrors } from '../core/spec-draft.js';
import type { SpecValidationDiagnostic } from '../core/spec-draft.js';
import { queryPanel, withQuerySpec } from '../core/saved-query.js';
import { isQuerylessPanel } from '../core/panel-cfg.js';
import { encodeShare } from '../core/share.js';
import type { SavedQueryV2 } from '../generated/json-schema.types.js';
import type { WorkspaceDiagnostic } from '../dashboard/model/workspace-diagnostics.js';
import type { QueryTimeRangeInferenceDiagnostic } from '../core/query-time-range.js';

// ── Construction deps ────────────────────────────────────────────────────────

/** Live accessors onto `app.state` — a structural `Pick`, not a snapshot:
 *  production passes `app.state` itself (satisfies this directly), mirroring
 *  every other #276 session's own deps convention. Exactly the fields
 *  `createSavedQuery`/`commitSavedQuery`/`recordHistory` (state.ts, all three
 *  narrowed to their own exact reads) need between them. */
export interface SavedQueryServiceDeps {
  state: Pick<AppState,
    'savedQueries' | 'resultView' | 'libraryDirty' | 'history' | 'libraryName'
    | 'workspaceId' | 'workspaceKey' | 'dashboard'>;
  saveJSON: SaveJSON;
  /** `createSavedQuery`'s minting timestamp — a genuine wall-clock read
   *  (production wires this to `() => Date.now()`, called at the exact
   *  moment a query is created), NOT app.ts's own `now`/`wallNow` seams
   *  (unrelated clocks — see app.ts's own construction comments): this keeps
   *  `createSavedQuery`'s minted ids byte-identical to the pre-extraction
   *  inline `Date.now()` call while still giving tests an injectable seam. */
  now(): number;
  /** The app-owned Spec validation service (core/spec-draft.js's `.validate`
   *  surface — state.ts's own narrower `SpecValidationService`, not the
   *  fuller `QuerySpecValidationService` `QueryDocumentSession` needs;
   *  `createSavedQuery`/`commitSavedQuery` only ever call `.validate`).
   *  Production passes `app.specValidators` (structurally assignable). */
  specValidators: SpecValidationService;
  /** The shared read-before-write mutation primitive (#343) `createSavedQuery`/
   *  `commitSavedQuery` run their candidate-building transform through, instead
   *  of the old raw `commit(candidate)` callback that let a candidate be built
   *  from stale `AppState`. Production passes `app.mutateWorkspace`
   *  (structurally `MutateWorkspace`): it reads the latest committed aggregate
   *  at dequeue time, commits, projects, and notifies other tabs. */
  mutateWorkspace: MutateWorkspace;
}

// ── Result types ─────────────────────────────────────────────────────────────

export type CreateSavedResult =
  | { ok: true; entry: SavedQueryV2; diagnostics?: QueryTimeRangeInferenceDiagnostic[] }
  /** `createSavedQuery` itself rejected the entry — either a pre-commit
   *  compute guard (still-linked tab, blank SQL on a non-text panel, blank
   *  name, or a blocking validation diagnostic — the pre-#287 inline code
   *  never distinguished a reason here either, so neither does this result;
   *  `diagnostics` absent), or the aggregate strictly rejected the whole-
   *  workspace commit (#287 W4 — `diagnostics` present, straight from
   *  `WorkspaceRepository.commit`; nothing was mutated). */
  | { ok: false; diagnostics?: WorkspaceDiagnostic[] };

export type CommitLinkedResult =
  | { ok: true; entry: SavedQueryV2; diagnostics?: QueryTimeRangeInferenceDiagnostic[] }
  | {
    ok: false;
    reason:
    /** The evaluated Spec has no parsed draft, or a blocking diagnostic. */
    | 'invalid-spec'
    /** Blank SQL on a panel type that isn't SQL-optional (#166's text panel). */
    | 'empty'
    /** `commitSavedQuery` itself rejected the commit — either its own
     *  defensive re-check against the normalized Spec (tab no longer linked —
     *  the pre-#287 inline code never toasted this either, `diagnostics`
     *  absent), or the aggregate strictly rejected the whole-workspace commit
     *  (#287 W4 — `diagnostics` present; nothing was mutated). */
    | 'rejected'
    /** The linked query was deleted in another tab (#343): the transform found
     *  no entry with the tab's `savedId` in the latest committed workspace and
     *  aborted without recreating it. The caller must refresh the tab
     *  association (the tab becomes an unsaved draft / detaches). */
    | 'deleted';
    diagnostics?: WorkspaceDiagnostic[];
  };

export type ShareResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'invalid-spec' | 'empty' };

/** `buildShareUrl`'s input: the exact fields it reads off the tab, the
 *  already-evaluated Spec (see this module's header comment on why this
 *  service never evaluates one itself), and the three `location` parts the
 *  encoded fragment is appended to (app.ts supplies `loc.origin`/
 *  `loc.pathname`/`loc.search` — this service never touches `location`
 *  itself, matching the "clipboard/location writes stay shell" ruling). */
export interface ShareUrlInput {
  tab: Pick<QueryTab, 'sqlDraft' | 'savedId'>;
  evaluated: { parsed: unknown; diagnostics: SpecValidationDiagnostic[] };
  origin: string;
  pathname: string;
  search: string;
}

// ── The service ──────────────────────────────────────────────────────────────

export interface SavedQueryService {
  /** Creation-only path (app.ts's Save-popover commit): mint a brand-new
   *  saved query from an unsaved or dangling-linked tab's current
   *  `sqlDraft`/`specParsed` plus `name`/`description`. Rejects (silently —
   *  see `CreateSavedResult`) a tab whose saved link still resolves. */
  create(tab: QueryTab, name: unknown, description: unknown): Promise<CreateSavedResult>;
  /** Update-in-place path (app.ts's `commitLinkedQuery`, the "Save" button on
   *  an already-linked tab): persist `evaluated` as the linked saved query's
   *  new Spec. Takes the Spec evaluation as an input (see this module's
   *  header comment) rather than evaluating it itself. */
  commit(tab: QueryTab, evaluated: { parsed: unknown; diagnostics: SpecValidationDiagnostic[] }): Promise<CommitLinkedResult>;
  /** Record a successful run in history (state.ts's own `recordHistory`) —
   *  never touches rendering; app.ts's own `app.recordHistory` delegate
   *  conditionally repaints the History side panel itself after calling
   *  this. */
  recordHistory(tab: QueryTab, sqlText?: string): void;
  /** Build the shareable URL for an already-evaluated Spec, or a typed
   *  rejection reason — never writes `location`/clipboard itself. */
  buildShareUrl(input: ShareUrlInput): ShareResult;
}

/** Build a `SavedQueryService` bound to `deps`. Trivial constructor — no
 *  validation, no defaulting; the caller supplies every field exactly as it
 *  wants it used. */
export function createSavedQueryService(deps: SavedQueryServiceDeps): SavedQueryService {
  async function create(tab: QueryTab, name: unknown, description: unknown): Promise<CreateSavedResult> {
    const result = await createSavedQuery(
      deps.state, tab, name, description, deps.mutateWorkspace, deps.now(), deps.specValidators,
    );
    return result.ok
      ? { ok: true, entry: result.entry, ...(result.diagnostics?.length ? { diagnostics: result.diagnostics } : {}) }
      : { ok: false, diagnostics: result.diagnostics };
  }

  async function commit(
    tab: QueryTab, evaluated: { parsed: unknown; diagnostics: SpecValidationDiagnostic[] },
  ): Promise<CommitLinkedResult> {
    if (!evaluated.parsed || hasBlockingSpecErrors(evaluated.diagnostics)) {
      return { ok: false, reason: 'invalid-spec' };
    }
    const panel = queryPanel({ spec: evaluated.parsed });
    if (!String(tab.sqlDraft || '').trim() && !isQuerylessPanel(panel)) {
      return { ok: false, reason: 'empty' };
    }
    const result = await commitSavedQuery(
      deps.state, tab, evaluated.parsed as QuerySpecDraft | null, deps.mutateWorkspace, deps.specValidators,
    );
    if (result.ok) return {
      ok: true, entry: result.entry,
      ...(result.diagnostics?.length ? { diagnostics: result.diagnostics } : {}),
    };
    return result.deletedExternally
      ? { ok: false, reason: 'deleted' }
      : { ok: false, reason: 'rejected', diagnostics: result.diagnostics };
  }

  function recordHistoryFn(tab: QueryTab, sqlText?: string): void {
    // `tab.result` is state.ts's deliberately opaque `Record<string,unknown> |
    // null` — by the time this is ever called (only after a successful run),
    // it already holds a real `QueryResult`-shaped value (rawText/rows/
    // progress.elapsed_ns), the exact fields `HistoryResultSnapshot` pins.
    const result = (tab.result as HistoryResultSnapshot | null)!;
    // `now` deliberately omitted (`undefined`) — matches the pre-extraction
    // inline call exactly: `recordHistory`'s own default (`Date.now()`) mints
    // the entry's timestamp, independent of this service's own injected
    // `deps.now` (which only feeds `createSavedQuery`'s id).
    stateRecordHistory(deps.state, { sqlDraft: tab.sqlDraft, result }, deps.saveJSON, undefined, sqlText);
  }

  function buildShareUrl(input: ShareUrlInput): ShareResult {
    const { tab, evaluated } = input;
    if (!evaluated.parsed || hasBlockingSpecErrors(evaluated.diagnostics)) {
      return { ok: false, reason: 'invalid-spec' };
    }
    const sql = String(tab.sqlDraft || '');
    const panel = queryPanel({ spec: evaluated.parsed });
    if (!sql.trim() && !isQuerylessPanel(panel)) return { ok: false, reason: 'empty' };
    const query = withQuerySpec({ id: tab.savedId, sql }, evaluated.parsed);
    const url = input.origin + input.pathname + input.search + '#' + encodeShare(query);
    return { ok: true, url };
  }

  return { create, commit, recordHistory: recordHistoryFn, buildShareUrl };
}
