// Pure StoredWorkspaceV2 operations (#406). Persistence policy, uniqueness,
// and key derivation live outside this module.

import type { SavedQueryV2, StoredWorkspaceV2 } from '../generated/json-schema.types.js';

export const CURRENT_STORAGE_VERSION = 2 as const;
export const DEFAULT_WORKSPACE_NAME = 'SQL Library';

/** Injected in production as crypto.randomUUID and deterministic in tests. */
export type WorkspaceIdGen = () => string;

const normalizeName = (name: unknown): string =>
  (typeof name === 'string' && name.trim() ? name : DEFAULT_WORKSPACE_NAME);

export const generateWorkspaceId = (genId: WorkspaceIdGen): string => genId();

/** Rename display metadata only. Stable ID/key and contents are untouched. */
export function renameWorkspace(
  workspace: StoredWorkspaceV2, name: unknown,
): StoredWorkspaceV2 {
  return { ...workspace, name: normalizeName(name) };
}

/**
 * Construct a new empty V2 workspace from an injected identity and key.
 * The repository validates the key and atomically enforces uniqueness.
 */
export function createNewWorkspace(
  genId: WorkspaceIdGen, key: string, name?: unknown,
): StoredWorkspaceV2 {
  return {
    storageVersion: CURRENT_STORAGE_VERSION,
    id: genId(),
    key,
    name: normalizeName(name),
    queries: [],
    dashboard: null,
  };
}

/** Replace only the active workspace's query collection. */
export function importQueries(
  workspace: StoredWorkspaceV2, queries: readonly SavedQueryV2[],
): StoredWorkspaceV2 {
  return { ...workspace, queries: [...queries], dashboard: workspace.dashboard };
}

/** Replace portable contents while preserving local identity metadata. */
export function replaceWorkspaceContents(
  workspace: StoredWorkspaceV2,
  contents: { queries: readonly SavedQueryV2[]; dashboard: StoredWorkspaceV2['dashboard'] },
): StoredWorkspaceV2 {
  return {
    ...workspace,
    queries: [...contents.queries],
    dashboard: contents.dashboard,
  };
}
