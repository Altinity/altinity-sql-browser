// DashboardAuthoringSession (#280 "Fallible, atomic authoring commands",
// "Revision semantics", "DashboardAuthoringSession"). Owns ONE editable
// Dashboard draft (a signal), its in-memory `draftVersion`, dirty/selection
// state, the atomic command executor, and commit/export. Every membership and
// placement change goes through a typed command — nothing mutates the draft
// signal or the document object directly, so Workbench UI and future AI/MCP
// callers share one path.
//
// Atomic command algorithm (per command):
//   clone draft -> apply to isolated candidate -> normalize through the active
//   layout plugin -> validate structure/references/roles + resolve & validate
//   presentations (whole candidate workspace) -> sort diagnostics -> replace
//   the draft ONLY when valid. On failure the previous draft is byte-for-byte
//   unchanged (the candidate is a clone; the draft signal's document reference
//   never changes on a failed command).
//
// draftVersion vs revision: `draftVersion` is the in-memory counter that
// increments by exactly one per successful command and guards stale async
// commands. `revision` is the PERSISTED Dashboard revision — it changes only
// on a successful repository commit (once per commit, regardless of how many
// draft changes it batches), never on a command, preview, or export.

import { signal, batch } from '@preact/signals-core';
import type { ReadonlySignal, Signal } from '@preact/signals-core';
import { cloneJson } from '../../core/saved-query.js';
import type { JsonSchemaValidationService } from '../../core/json-schema-validation.js';
import type { SpecSchemaService } from '../../core/spec-schema.js';
import { diagnostic, sortDiagnostics } from '../model/workspace-diagnostics.js';
import type { WorkspaceDiagnostic } from '../model/workspace-diagnostics.js';
import { resolveDashboardPresentations } from '../model/presentation-resolver.js';
import { buildDashboardExportBundle } from '../model/dashboard-export.js';
import { defaultLayoutRegistry } from '../layouts/layout-registry.js';
import { applyCommand } from './dashboard-commands.js';
import type { DashboardCommand, DashboardCommandResult } from './dashboard-commands.js';
import { createEmptyDashboard } from './empty-dashboard.js';
import { createQueryResolver } from './dashboard-query-resolver.js';
import { validateStoredWorkspaceDocument } from '../../workspace/stored-workspace.js';
import type { WorkspaceRepository, WorkspaceCommitResult } from '../../workspace/workspace-repository.js';
import type {
  DashboardDocumentV1, PortableBundleV1, SavedQueryV2, StoredWorkspaceV1,
} from '../../generated/json-schema.types.js';

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** The observable authoring state. `document` is the current draft. */
export interface DashboardAuthoringState {
  document: DashboardDocumentV1;
  draftVersion: number;
  dirty: boolean;
  selectedTileId: string | null;
  /** Diagnostics from the most recent command (empty after a success). */
  diagnostics: WorkspaceDiagnostic[];
}

export interface DashboardAuthoringSession {
  readonly state: ReadonlySignal<DashboardAuthoringState>;
  execute<T = unknown>(
    command: DashboardCommand, options?: { expectedDraftVersion?: number },
  ): Promise<DashboardCommandResult<T>>;
  /** Star rewire: add/remove one default tile for `queryId` through
   *  `add-query`/`remove-tile`, then dual-write `spec.favorite` on the
   *  session's query snapshot to match membership (the documented Phase-4
   *  removal path flips reads). */
  toggleMembership(
    queryId: string, options?: { expectedDraftVersion?: number },
  ): Promise<DashboardCommandResult<unknown>>;
  setSelectedTile(tileId: string | null): void;
  commit(): Promise<WorkspaceCommitResult>;
  createPortableBundle(): PortableBundleV1;
  destroy(): void;
}

export interface DashboardAuthoringSessionDeps {
  /** The current workspace. Its Dashboard becomes the initial draft; a `null`
   *  Dashboard starts an empty flow@1 Dashboard at revision 1. */
  workspace: StoredWorkspaceV1;
  repository: WorkspaceRepository;
  /** Mints tile IDs (and the new Dashboard ID when the workspace has none). */
  genId: () => string;
  validationService?: JsonSchemaValidationService;
  schemaService?: SpecSchemaService;
  /** Export timestamp source (defaults to `new Date().toISOString()`). */
  nowISO?: () => string;
}

/** Build a `DashboardAuthoringSession` bound to `deps`. */
export function createDashboardAuthoringSession(
  deps: DashboardAuthoringSessionDeps,
): DashboardAuthoringSession {
  const { workspace, repository, genId, validationService, schemaService } = deps;
  const nowISO = deps.nowISO ?? (() => new Date().toISOString());
  const codecOptions = validationService ? { validationService } : {};

  const workspaceId = workspace.id;
  const workspaceName = workspace.name;
  // A mutable clone of the query collection — the favorite dual-write edits it.
  let queries: SavedQueryV2[] = cloneJson(workspace.queries);
  // The last persisted Dashboard revision (0 when never committed).
  let committedRevision = workspace.dashboard ? workspace.dashboard.revision : 0;
  let destroyed = false;

  const initialDocument = workspace.dashboard ? cloneJson(workspace.dashboard) : createEmptyDashboard(genId());
  const stateSignal: Signal<DashboardAuthoringState> = signal<DashboardAuthoringState>({
    document: initialDocument, draftVersion: 0, dirty: false, selectedTileId: null, diagnostics: [],
  });

  /** Validate a candidate dashboard as part of a complete candidate workspace:
   *  structure + references/roles/limits (stored-workspace pipeline), then —
   *  only when that passes — resolve and validate every panel presentation. */
  function validateCandidate(dashboard: DashboardDocumentV1): WorkspaceDiagnostic[] {
    const candidate: StoredWorkspaceV1 = {
      storageVersion: 1, id: workspaceId, name: workspaceName, queries, dashboard,
    };
    const structural = validateStoredWorkspaceDocument(candidate, codecOptions);
    if (structural.length) return structural;
    return resolveDashboardPresentations({ dashboard, queries, schemaService, path: ['dashboard'] });
  }

  function returnFail<T>(diagnostics: WorkspaceDiagnostic[], draftVersion: number): DashboardCommandResult<T> {
    const sorted = sortDiagnostics(diagnostics);
    // Record the diagnostics WITHOUT touching the draft document/version/dirty.
    stateSignal.value = { ...stateSignal.value, diagnostics: sorted };
    return { ok: false, diagnostics: sorted, draftVersion };
  }

  async function execute<T = unknown>(
    command: DashboardCommand, options?: { expectedDraftVersion?: number },
  ): Promise<DashboardCommandResult<T>> {
    const current = stateSignal.value;
    const baseVersion = current.draftVersion;
    if (destroyed) {
      return returnFail<T>([diagnostic([], 'dashboard-session-destroyed',
        'This authoring session has been destroyed')], baseVersion);
    }
    if (options?.expectedDraftVersion !== undefined && options.expectedDraftVersion !== baseVersion) {
      return returnFail<T>([diagnostic([], 'dashboard-command-stale',
        `Command expected draft version ${options.expectedDraftVersion} but the draft is at ${baseVersion}`)], baseVersion);
    }

    // Resolve the active layout plugin through the full registry (#291: the
    // grafana-grid@1 engine, not just flow@1) — for change-layout, the NEW
    // layout; for every other command, the document's CURRENTLY active
    // layout, so `update-placement`/`add-query` seeding and validation route
    // through whichever engine (grid or flow) is actually active.
    const layoutForPlugin = command.type === 'change-layout' ? command.layout : current.document.layout;
    const resolved = await defaultLayoutRegistry.resolve(layoutForPlugin);
    if (!resolved.ok) return returnFail<T>(resolved.diagnostics, baseVersion);

    const resolver = createQueryResolver(queries);
    const applied = applyCommand(current.document, command, { resolver, genTileId: genId, plugin: resolved.plugin });
    if (!applied.ok) return returnFail<T>(applied.diagnostics, baseVersion);

    const normalized = resolved.plugin.normalize(applied.dashboard);
    const diagnostics = validateCandidate(normalized);
    if (diagnostics.length) return returnFail<T>(diagnostics, baseVersion);

    const draftVersion = baseVersion + 1;
    batch(() => {
      stateSignal.value = {
        document: normalized, draftVersion, dirty: true,
        selectedTileId: current.selectedTileId, diagnostics: [],
      };
    });
    return { ok: true, value: applied.value as T, document: normalized, draftVersion };
  }

  async function toggleMembership(
    queryId: string, options?: { expectedDraftVersion?: number },
  ): Promise<DashboardCommandResult<unknown>> {
    const existing = stateSignal.value.document.tiles.find(
      (tile) => isObject(tile) && tile.queryId === queryId,
    );
    const command: DashboardCommand = existing
      ? { type: 'remove-tile', tileId: existing.id }
      : { type: 'add-query', queryId };
    const result = await execute(command, options);
    if (result.ok) {
      // Dual-write spec.favorite to reflect post-command membership.
      const member = result.document.tiles.some((tile) => isObject(tile) && tile.queryId === queryId);
      queries = queries.map((query) => {
        if (!isObject(query) || query.id !== queryId) return query;
        const clone = cloneJson(query);
        clone.spec = { ...(isObject(clone.spec) ? clone.spec : {}), favorite: member };
        return clone;
      });
    }
    return result;
  }

  function setSelectedTile(tileId: string | null): void {
    stateSignal.value = { ...stateSignal.value, selectedTileId: tileId };
  }

  async function commit(): Promise<WorkspaceCommitResult> {
    const current = stateSignal.value;
    if (destroyed) {
      return { ok: false, diagnostics: [diagnostic([], 'dashboard-session-destroyed',
        'This authoring session has been destroyed')] };
    }
    // One successful commit increments the persisted revision exactly once,
    // regardless of how many draft changes it batches.
    const candidateDashboard: DashboardDocumentV1 = {
      ...cloneJson(current.document), revision: committedRevision + 1,
    };
    const candidate: StoredWorkspaceV1 = {
      storageVersion: 1, id: workspaceId, name: workspaceName,
      queries: cloneJson(queries), dashboard: candidateDashboard,
    };
    const result = await repository.commit(candidate);
    if (result.ok) {
      // The persisted dashboard is `candidateDashboard` (the repository re-parses
      // the identical canonical text); adopt it as the clean draft and record
      // its revision as the new committed revision.
      committedRevision = candidateDashboard.revision;
      batch(() => {
        stateSignal.value = { ...stateSignal.value, document: candidateDashboard, dirty: false, diagnostics: [] };
      });
    }
    // A failed commit leaves the draft dirty and the revision unchanged.
    return result;
  }

  function createPortableBundle(): PortableBundleV1 {
    // Export never mutates workspace identity or revision — nothing here
    // touches `committedRevision` or the draft; the builder deep-clones.
    return buildDashboardExportBundle(stateSignal.value.document, queries, nowISO());
  }

  function destroy(): void {
    destroyed = true;
    stateSignal.value = { ...stateSignal.value, selectedTileId: null, diagnostics: [] };
  }

  return {
    state: stateSignal as ReadonlySignal<DashboardAuthoringState>,
    execute, toggleMembership, setSelectedTile, commit, createPortableBundle, destroy,
  };
}
