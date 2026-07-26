// Pure StoredWorkspaceV5 operations (#406; Dashboard collection, #424).
// Persistence policy, uniqueness, and key derivation live outside this module;
// ID-addressed Dashboard access lives in workspace-dashboards.ts.

import type {
  DashboardDocumentV2, SavedQueryV2, StoredWorkspaceV5,
} from '../generated/json-schema.types.js';

export const CURRENT_STORAGE_VERSION = 5 as const;
export const DEFAULT_WORKSPACE_NAME = 'SQL Library';

/** Injected in production as crypto.randomUUID and deterministic in tests. */
export type WorkspaceIdGen = () => string;

const normalizeName = (name: unknown): string =>
  (typeof name === 'string' && name.trim() ? name : DEFAULT_WORKSPACE_NAME);

export const generateWorkspaceId = (genId: WorkspaceIdGen): string => genId();

/** Rename display metadata only. Stable ID/key and contents are untouched —
 *  including every Dashboard, which keeps its own title and revision. */
export function renameWorkspace(
  workspace: StoredWorkspaceV5, name: unknown,
): StoredWorkspaceV5 {
  return { ...workspace, name: normalizeName(name) };
}

/**
 * Construct a new empty V3 workspace from an injected identity and key.
 * The repository validates the key and atomically enforces uniqueness.
 */
export function createNewWorkspace(
  genId: WorkspaceIdGen, key: string, name?: unknown,
): StoredWorkspaceV5 {
  return {
    storageVersion: CURRENT_STORAGE_VERSION,
    id: genId(),
    key,
    name: normalizeName(name),
    queries: [],
    dashboards: [],
  };
}

/** Replace only the active workspace's query collection — every Dashboard is
 *  carried through untouched. */
export function importQueries(
  workspace: StoredWorkspaceV5, queries: readonly SavedQueryV2[],
): StoredWorkspaceV5 {
  return { ...workspace, queries: [...queries], dashboards: [...workspace.dashboards] };
}

/** Replace portable contents while preserving local identity metadata. The
 *  incoming `dashboards` order IS the destination order. */
export function replaceWorkspaceContents(
  workspace: StoredWorkspaceV5,
  contents: { queries: readonly SavedQueryV2[]; dashboards: readonly DashboardDocumentV2[] },
): StoredWorkspaceV5 {
  return {
    ...workspace,
    queries: [...contents.queries],
    dashboards: [...contents.dashboards],
  };
}
