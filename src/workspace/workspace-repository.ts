// WorkspaceRepository — atomic StoredWorkspaceV1 aggregate persistence (#280
// "WorkspaceRepository", Phase 2 of #280 / issue #284). Sits behind the
// injected `WorkspaceStore` seam (workspace-store.types.ts) so it is pure over
// an in-memory fake in tests and never imports a concrete IndexedDB.
//
// Atomicity + last-commit-wins (#280 "Multi-tab authoring policy"): `commit`
// validates the COMPLETE candidate through the Phase-1 whole-workspace
// pipeline (stored-workspace.ts) BEFORE any write, then does ONE atomic
// `store.write` of the canonical encoding. It is atomic replacement, NOT
// compare-and-swap — the last successful commit wins, and because one write
// replaces the entire record there is no interleaving that could produce a
// partially-mixed workspace. Committed application state is published (the
// returned `workspace`) only after persistence succeeds; a failed write leaves
// the previously stored workspace intact, does not touch the caller's draft,
// and never increments any revision (the repository never mutates revision —
// the authoring session that built the candidate owns that, Phase 3).

import {
  decodeStoredWorkspaceJson, encodeStoredWorkspaceJson,
} from './stored-workspace.js';
import type { WorkspaceStore } from './workspace-store.types.js';
import { diagnostic } from '../dashboard/model/workspace-diagnostics.js';
import type { WorkspaceDiagnostic } from '../dashboard/model/workspace-diagnostics.js';
import type { JsonSchemaValidationService } from '../core/json-schema-validation.js';
import type { StoredWorkspaceV1 } from '../generated/json-schema.types.js';

/** The #280 commit-result union: the published committed workspace and its
 *  Dashboard revision on success, or the sorted validation/persistence
 *  diagnostics on failure. */
export type WorkspaceCommitResult =
  | { ok: true; workspace: StoredWorkspaceV1; dashboardRevision: number | null }
  | { ok: false; diagnostics: WorkspaceDiagnostic[] };

/** The #300 tri-state load result `loadCurrentResult` returns — unlike
 *  `loadCurrent` (below), it distinguishes "no record persisted yet" (`empty`)
 *  from "a record is persisted but doesn't decode/validate" (`corrupt`, with
 *  the codec's diagnostics) from a normal successful load (`ok`). Boot-time
 *  callers that need to surface a corrupt-but-present record to the user
 *  (rather than silently continuing on the legacy projection) use this
 *  instead of `loadCurrent`. */
export type WorkspaceLoadResult =
  | { status: 'empty' }
  | { status: 'ok'; workspace: StoredWorkspaceV1 }
  | { status: 'corrupt'; diagnostics: WorkspaceDiagnostic[] };

/** The #280 repository contract. Every method is async because the backing
 *  store (IndexedDB) is async. */
export interface WorkspaceRepository {
  /** Load the current aggregate, or `null` when none is persisted. A stored
   *  record that no longer validates also reads as `null` (a corrupt aggregate
   *  is not returned as if valid); the migration marker keys on raw record
   *  existence via the store, not on this method, so it never re-runs over a
   *  corrupt-but-present record. */
  loadCurrent(): Promise<StoredWorkspaceV1 | null>;
  /** Like `loadCurrent`, but distinguishes "no record" from "record present
   *  but undecodable" (#300) instead of collapsing both to `null` — see
   *  `WorkspaceLoadResult`. */
  loadCurrentResult(): Promise<WorkspaceLoadResult>;
  /** Validate the complete candidate, then atomically replace the persisted
   *  aggregate. Publishes committed state only after the write succeeds. */
  commit(candidate: StoredWorkspaceV1): Promise<WorkspaceCommitResult>;
  /** Delete the persisted aggregate. */
  clearCurrent(): Promise<void>;
}

export interface WorkspaceRepositoryDeps {
  /** The injected persistence seam (concrete IndexedDB adapter in production,
   *  an in-memory fake in tests). */
  store: WorkspaceStore;
  /** Optional override of the compiled schema-validation service the Phase-1
   *  codec uses (tests inject a stub); production uses the generated default. */
  validationService?: JsonSchemaValidationService;
}

const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error));

/** Build a `WorkspaceRepository` bound to `deps`. Trivial constructor — no I/O
 *  happens until a method is called, so constructing one with a not-yet-usable
 *  store (e.g. a browser without IndexedDB) never throws. */
export function createWorkspaceRepository(deps: WorkspaceRepositoryDeps): WorkspaceRepository {
  const { store, validationService } = deps;
  const codecOptions = validationService ? { validationService } : {};

  async function loadCurrent(): Promise<StoredWorkspaceV1 | null> {
    const text = await store.read();
    if (text === null) return null;
    const decoded = decodeStoredWorkspaceJson(text, codecOptions);
    return decoded.ok ? decoded.value : null;
  }

  async function loadCurrentResult(): Promise<WorkspaceLoadResult> {
    const text = await store.read();
    if (text === null) return { status: 'empty' };
    const decoded = decodeStoredWorkspaceJson(text, codecOptions);
    return decoded.ok
      ? { status: 'ok', workspace: decoded.value }
      : { status: 'corrupt', diagnostics: decoded.diagnostics };
  }

  async function commit(candidate: StoredWorkspaceV1): Promise<WorkspaceCommitResult> {
    // Validate + canonically encode the WHOLE candidate before touching the
    // store; invalid candidates never reach persistence.
    const encoded = encodeStoredWorkspaceJson(candidate, codecOptions);
    if (!encoded.ok) return { ok: false, diagnostics: encoded.diagnostics };
    try {
      await store.write(encoded.value);
    } catch (error) {
      // Failed persistence: the previously stored workspace is untouched, and
      // no revision is incremented. The caller keeps its dirty draft to retry.
      return {
        ok: false,
        diagnostics: [diagnostic([], 'workspace-persist-failed',
          `Persisting the workspace failed: ${message(error)}`)],
      };
    }
    // Publish only after the write succeeds. The canonical text we just wrote
    // is guaranteed valid JSON, so parse it back as the normalized published
    // snapshot rather than re-running validation.
    const workspace = JSON.parse(encoded.value) as StoredWorkspaceV1;
    return {
      ok: true,
      workspace,
      dashboardRevision: workspace.dashboard === null ? null : workspace.dashboard.revision,
    };
  }

  function clearCurrent(): Promise<void> {
    return store.clear();
  }

  return { loadCurrent, loadCurrentResult, commit, clearCurrent };
}
