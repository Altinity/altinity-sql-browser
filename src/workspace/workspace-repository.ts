// Multi-workspace repository (#406). The repository owns validation, canonical
// encoding, collection policy, and translation of store outcomes into
// application-facing diagnostics. IndexedDB remains behind WorkspaceStore.

import {
  decodeStoredWorkspaceJson, encodeStoredWorkspaceJson,
} from './stored-workspace.js';
import type {
  WorkspaceStore, WorkspaceStoreCreateResult, WorkspaceStoreRecord,
  WorkspaceStoreReplaceResult,
} from './workspace-store.types.js';
import { diagnostic } from '../dashboard/model/workspace-diagnostics.js';
import type { WorkspaceDiagnostic } from '../dashboard/model/workspace-diagnostics.js';
import type { JsonSchemaValidationService } from '../core/json-schema-validation.js';
import { normalizeWorkspaceKeyLookup } from '../core/workspace-key.js';
import type { StoredWorkspaceV2 } from '../generated/json-schema.types.js';

export interface WorkspaceSummary {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly queryCount: number;
  readonly hasDashboard: boolean;
  readonly lastOpenedAt: number | null;
}

export interface CorruptWorkspaceRecord {
  readonly id: string;
  readonly key: string;
  readonly diagnostics: WorkspaceDiagnostic[];
}

export interface WorkspaceListResult {
  readonly summaries: WorkspaceSummary[];
  readonly corrupt: CorruptWorkspaceRecord[];
}

/** Explicit keyed loads never silently select a different workspace. */
export type WorkspaceLoadResult =
  | { readonly status: 'empty' }
  | { readonly status: 'ok'; readonly workspace: StoredWorkspaceV2 }
  | {
    readonly status: 'corrupt';
    /** Record identity stays available for targeted reset/recovery. */
    readonly id: string;
    readonly key: string;
    readonly diagnostics: WorkspaceDiagnostic[];
  };

export type WorkspaceCommitResult =
  | {
    readonly ok: true;
    readonly workspace: StoredWorkspaceV2;
    readonly dashboardRevision: number | null;
  }
  | { readonly ok: false; readonly diagnostics: WorkspaceDiagnostic[] };

export type WorkspaceDeleteResult =
  | { readonly ok: true; readonly deleted: boolean }
  | { readonly ok: false; readonly diagnostics: WorkspaceDiagnostic[] };

export type WorkspaceMarkOpenedResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly diagnostics: WorkspaceDiagnostic[] };

export interface WorkspaceRepository {
  list(): Promise<WorkspaceListResult>;
  loadById(id: string): Promise<WorkspaceLoadResult>;
  loadByKey(key: string): Promise<WorkspaceLoadResult>;
  create(workspace: StoredWorkspaceV2): Promise<WorkspaceCommitResult>;
  commit(workspace: StoredWorkspaceV2): Promise<WorkspaceCommitResult>;
  /** Idempotent: an unknown ID succeeds with `deleted: false`. */
  delete(id: string): Promise<WorkspaceDeleteResult>;
  /** Resolve startup's implicit workspace; explicit URL-key loads use loadByKey. */
  resolveImplicit(): Promise<WorkspaceLoadResult>;
  /** Stamp a workspace only after the application has opened it successfully. */
  markOpened(key: string): Promise<WorkspaceMarkOpenedResult>;
}

export interface WorkspaceRepositoryDeps {
  readonly store: WorkspaceStore;
  readonly validationService?: JsonSchemaValidationService;
  /** Injected because opening metadata must be deterministic in tests. */
  readonly now?: () => number;
}

const errorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error));

const repositoryDiagnostic = (
  code: string, message: string, path: readonly (string | number)[] = [],
): WorkspaceDiagnostic => diagnostic([...path], code, message);

const persistenceFailure = (verb: string, error: unknown): WorkspaceCommitResult => ({
  ok: false,
  diagnostics: [repositoryDiagnostic(
    'workspace-persist-failed', `${verb} failed: ${errorMessage(error)}`,
  )],
});

const published = (encoded: string): Extract<WorkspaceCommitResult, { ok: true }> => {
  const workspace = JSON.parse(encoded) as StoredWorkspaceV2;
  return {
    ok: true,
    workspace,
    dashboardRevision: workspace.dashboard === null ? null : workspace.dashboard.revision,
  };
};

const summary = (
  workspace: StoredWorkspaceV2, lastOpenedAt: number | null,
): WorkspaceSummary => ({
  id: workspace.id,
  key: workspace.key,
  name: workspace.name,
  queryCount: workspace.queries.length,
  hasDashboard: workspace.dashboard !== null,
  lastOpenedAt,
});

function storeCreateFailure(result: Exclude<WorkspaceStoreCreateResult, { status: 'created' }>) {
  return result.status === 'duplicate-id'
    ? repositoryDiagnostic('workspace-duplicate-id', 'A workspace with this ID already exists', ['id'])
    : repositoryDiagnostic('workspace-duplicate-key', 'A workspace with this key already exists', ['key']);
}

function storeReplaceFailure(result: Exclude<WorkspaceStoreReplaceResult, { status: 'replaced' }>) {
  return result.status === 'not-found'
    ? repositoryDiagnostic('workspace-not-found', 'The workspace no longer exists', ['id'])
    : repositoryDiagnostic('workspace-key-immutable', 'A workspace key cannot be changed', ['key']);
}

/** Build a collection repository. Construction itself performs no I/O. */
export function createWorkspaceRepository(deps: WorkspaceRepositoryDeps): WorkspaceRepository {
  const { store, validationService, now = Date.now } = deps;
  const codecOptions = validationService ? { validationService } : {};

  const decodeRecord = (record: WorkspaceStoreRecord): WorkspaceLoadResult => {
    const decoded = decodeStoredWorkspaceJson(record.text, codecOptions);
    if (!decoded.ok) {
      return {
        status: 'corrupt', id: record.id, key: record.key, diagnostics: decoded.diagnostics,
      };
    }
    if (decoded.value.id !== record.id || decoded.value.key !== record.key) {
      return {
        status: 'corrupt',
        id: record.id,
        key: record.key,
        diagnostics: [repositoryDiagnostic(
          'workspace-record-identity-mismatch',
          'Stored workspace identity does not match its record key',
        )],
      };
    }
    return { status: 'ok', workspace: decoded.value };
  };

  async function list(): Promise<WorkspaceListResult> {
    const records = await store.list();
    const summaries: WorkspaceSummary[] = [];
    const corrupt: CorruptWorkspaceRecord[] = [];
    for (const record of records) {
      const decoded = decodeRecord(record);
      if (decoded.status === 'ok') {
        summaries.push(summary(decoded.workspace, record.lastOpenedAt));
      } else if (decoded.status === 'corrupt') {
        corrupt.push({ id: record.id, key: record.key, diagnostics: decoded.diagnostics });
      }
    }
    summaries.sort((a, b) => a.key.localeCompare(b.key));
    corrupt.sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
    return { summaries, corrupt };
  }

  async function loadById(id: string): Promise<WorkspaceLoadResult> {
    const record = await store.readById(id);
    return record === null ? { status: 'empty' } : decodeRecord(record);
  }

  async function loadByKey(key: string): Promise<WorkspaceLoadResult> {
    const record = await store.readByKey(normalizeWorkspaceKeyLookup(key));
    return record === null ? { status: 'empty' } : decodeRecord(record);
  }

  async function create(workspace: StoredWorkspaceV2): Promise<WorkspaceCommitResult> {
    const encoded = encodeStoredWorkspaceJson(workspace, codecOptions);
    if (!encoded.ok) return { ok: false, diagnostics: encoded.diagnostics };
    try {
      const result = await store.create({
        id: workspace.id, key: workspace.key, text: encoded.value, lastOpenedAt: null,
      });
      return result.status === 'created'
        ? published(encoded.value)
        : { ok: false, diagnostics: [storeCreateFailure(result)] };
    } catch (error) {
      return persistenceFailure('Creating the workspace', error);
    }
  }

  async function commit(workspace: StoredWorkspaceV2): Promise<WorkspaceCommitResult> {
    const encoded = encodeStoredWorkspaceJson(workspace, codecOptions);
    if (!encoded.ok) return { ok: false, diagnostics: encoded.diagnostics };
    try {
      // Store.replace enforces existence/key immutability and preserves its
      // store-owned lastOpenedAt metadata in the same transaction.
      const result = await store.replace({
        id: workspace.id,
        key: workspace.key,
        text: encoded.value,
        lastOpenedAt: null,
      });
      return result.status === 'replaced'
        ? published(encoded.value)
        : { ok: false, diagnostics: [storeReplaceFailure(result)] };
    } catch (error) {
      return persistenceFailure('Persisting the workspace', error);
    }
  }

  async function deleteWorkspace(id: string): Promise<WorkspaceDeleteResult> {
    try {
      return { ok: true, deleted: await store.delete(id) };
    } catch (error) {
      return {
        ok: false,
        diagnostics: [repositoryDiagnostic(
          'workspace-delete-failed', `Deleting the workspace failed: ${errorMessage(error)}`,
        )],
      };
    }
  }

  async function resolveImplicit(): Promise<WorkspaceLoadResult> {
    const preferredKey = await store.getLastUsedKey();
    if (preferredKey !== null) {
      const preferred = await loadByKey(preferredKey);
      if (preferred.status === 'ok') return preferred;
      await store.clearLastUsedKey();
    }

    const records = await store.list();
    const ranked = records.map((record) => {
      const decoded = decodeRecord(record);
      return { record, decoded };
    });
    ranked.sort((a, b) => {
      const aOpened = a.record.lastOpenedAt;
      const bOpened = b.record.lastOpenedAt;
      if (aOpened !== null || bOpened !== null) {
        if (aOpened === null) return 1;
        if (bOpened === null) return -1;
        if (aOpened !== bOpened) return bOpened - aOpened;
      }
      return a.record.key.localeCompare(b.record.key) || a.record.id.localeCompare(b.record.id);
    });
    const valid = ranked.find(({ decoded }) => decoded.status === 'ok');
    if (valid?.decoded.status === 'ok') return valid.decoded;
    const corrupt = ranked.find(({ decoded }) => decoded.status === 'corrupt');
    return corrupt?.decoded ?? { status: 'empty' };
  }

  async function markOpened(key: string): Promise<WorkspaceMarkOpenedResult> {
    try {
      const result = await store.markOpened(normalizeWorkspaceKeyLookup(key), now());
      return result.status === 'opened'
        ? { ok: true }
        : {
          ok: false,
          diagnostics: [repositoryDiagnostic(
            'workspace-not-found', 'The workspace no longer exists', ['key'],
          )],
        };
    } catch (error) {
      return {
        ok: false,
        diagnostics: [repositoryDiagnostic(
          'workspace-mark-opened-failed',
          `Recording the opened workspace failed: ${errorMessage(error)}`,
        )],
      };
    }
  }

  return {
    list, loadById, loadByKey, create, commit,
    delete: deleteWorkspace, resolveImplicit, markOpened,
  };
}
