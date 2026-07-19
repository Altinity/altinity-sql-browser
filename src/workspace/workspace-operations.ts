// Pure workspace-operation semantics (#280 "Workspace operation semantics",
// Phase 2 of #280 / issue #284). These build the NEXT candidate
// StoredWorkspaceV1; the repository (workspace-repository.ts) is what commits
// one atomically. The file-menu UI and the transactional bundle import planner
// are Phase 5 (#287) — this module is only the repository-level candidate
// construction + workspace ID generation those UIs will drive.
//
// Pure: no DOM, no storage, no crypto import — the ID generator is injected so
// the same call is deterministic in tests and unguessable in production.

import type { SavedQueryV2, StoredWorkspaceV1 } from '../generated/json-schema.types.js';

export const CURRENT_STORAGE_VERSION = 1 as const;

/** Fallback workspace name when none is supplied. Mirrors state.ts's
 *  `DEFAULT_LIBRARY_NAME` by value (state.ts is a forbidden import for the
 *  workspace layer, so the constant is duplicated deliberately, not shared). */
export const DEFAULT_WORKSPACE_NAME = 'SQL Library';

/** A workspace-ID minter — injected so production wires it to
 *  `crypto.randomUUID()` (unguessable) and tests pass a counter (deterministic).
 *  Called once per operation that needs a fresh identity. */
export type WorkspaceIdGen = () => string;

const normalizeName = (name: unknown): string =>
  (typeof name === 'string' && name.trim() ? name : DEFAULT_WORKSPACE_NAME);

/** Generate a fresh workspace ID. Two imported files with the same name still
 *  produce distinct IDs because identity always comes from a fresh `genId()`
 *  call, never from the file's name (#280). */
export const generateWorkspaceId = (genId: WorkspaceIdGen): string => genId();

/** Rename the workspace: changes `name` only. It never renames the Dashboard —
 *  the Dashboard keeps its own `title` (#280 "Rename workspace changes
 *  workspace.name; it does not automatically rename an existing Dashboard"). */
export function renameWorkspace(workspace: StoredWorkspaceV1, name: unknown): StoredWorkspaceV1 {
  return { ...workspace, name: normalizeName(name) };
}

/** Create a brand-new empty workspace: a fresh generated ID, the given name,
 *  no queries, and no Dashboard. The caller confirms any data-loss replacement
 *  of the current workspace before committing this (#280). */
export function createNewWorkspace(genId: WorkspaceIdGen, name?: unknown): StoredWorkspaceV1 {
  return {
    storageVersion: CURRENT_STORAGE_VERSION,
    id: genId(),
    name: normalizeName(name),
    queries: [],
    dashboard: null,
  };
}

/** Import a query collection into the workspace: modifies `queries` ONLY, at
 *  THIS layer — the Dashboard passed through is byte-for-byte unchanged here.
 *  (#280's original rule — "imported favorite flags do not add Dashboard
 *  tiles" — turned out to be a bug, not a decision: a fresh workspace's
 *  Dashboard is `null` and `toggleTileMembership` also returned `null` for
 *  it, so a favorited panel-role query could never get a tile through EITHER
 *  path. #307 fixes both; for imports the fix is one layer up, in
 *  `import-planner.ts`'s `planImportQueries`, which calls
 *  `syncFavoriteTileMembership` on this function's result before returning
 *  its plan — kept there, not here, so this repository-level primitive stays
 *  a pure "assemble the candidate" step with no Dashboard-semantics
 *  knowledge.) The incoming collection replaces the workspace's queries;
 *  conflict resolution (use-existing/copy/replace/skip) and ID remapping are
 *  the Phase-5 import planner's job, applied before a candidate reaches
 *  here. */
export function importQueries(
  workspace: StoredWorkspaceV1, queries: readonly SavedQueryV2[],
): StoredWorkspaceV1 {
  return { ...workspace, queries: [...queries], dashboard: workspace.dashboard };
}

/** Replace the workspace's queries AND Dashboard atomically while preserving
 *  its identity (`id`/`name`) — the repository-level primitive behind "Replace
 *  from bundle" and "Replace workspace" (#280). The parsing/validation of an
 *  external bundle and the dependency-closure/ID-remapping that select the
 *  `queries`/`dashboard` passed here are the Phase-5 import planner's job; this
 *  only assembles the candidate the repository then commits in one transaction. */
export function replaceWorkspaceContents(
  workspace: StoredWorkspaceV1,
  contents: { queries: readonly SavedQueryV2[]; dashboard: StoredWorkspaceV1['dashboard'] },
): StoredWorkspaceV1 {
  return {
    ...workspace,
    queries: [...contents.queries],
    dashboard: contents.dashboard,
  };
}
