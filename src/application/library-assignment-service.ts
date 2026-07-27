// Committing a Library→Dashboard assignment (#428) — the async `mutateWorkspace`
// plumbing around the pure transforms in
// `dashboard/application/library-assignment.ts`, split along the same layer
// boundary `application/dashboard-variable-config.ts` uses:
//
//   - the PURE semantic transform lives beside the other Dashboard writers;
//   - the read-latest-at-dequeue commit, the ids, and the dirty-draft gate are here.
//
// Typed against structural deps rather than `App`: `src/application/**` must
// never import `src/ui/**` (build/check-boundaries.mjs), and a real `App`
// satisfies the shape below directly.

import { findVariableTab, tabSaveDirty } from '../state.js';
import type {
  MutateWorkspace, QueryTab, WorkspaceExternallyChangedInfo, WorkspaceMutationOutcome,
} from '../state.js';
import {
  copyLibraryQueryToPanel, copyLibraryQuerySqlToVariable,
} from '../dashboard/application/library-assignment.js';
import type { LibraryAssignmentAbort } from '../dashboard/application/library-assignment.js';
import type { LibraryQueryDragPayload } from '../core/library-drag.js';

/**
 * Why an assignment committed nothing, threaded back through `mutateWorkspace`'s
 * `data` channel. The transform's own aborts, plus one this layer owns:
 * `variable-tab-dirty`, which is about editor state the pure transform cannot
 * see.
 *
 * Kept distinct from a bare `aborted` outcome for the reason
 * `dashboard-variable-config.ts` documents: every OTHER `aborted` comes from the
 * primitive (the route moved on, the record vanished), and at least one of those
 * keeps a durable write. Collapsing them into one boolean reports several of them
 * wrongly.
 */
export type LibraryAssignmentDecline = LibraryAssignmentAbort | 'variable-tab-dirty';

export interface PanelAssignmentData {
  status: 'ok';
  queryId: string;
  tileId: string;
}

export interface VariableAssignmentData {
  status: 'ok';
  /** Exactly the SQL that was committed. Reported rather than left for the
   *  caller to re-derive from the projection: a caller that re-ran inference
   *  would be correct only for as long as `applyCommittedWorkspace` keeps landing
   *  before this promise resolves, and if that ordering ever changed it would
   *  silently reconcile an open variable tab to the PREVIOUS value. */
  sql: string;
  /**
   * The commit landed, but the matching variable tab holds an unsaved draft that
   * disagrees with what was just written.
   *
   * Only reachable through the commit-window race the function's own doc
   * describes: the in-transform gate refuses a tab that is already dirty, so this
   * means the user typed while persistence was in flight. The assignment is
   * durable and the draft is untouched — but they now disagree, and the caller
   * must tell the user rather than reporting a clean success.
   */
  draftDiverged: boolean;
}

export type AssignmentDeclined = { status: 'declined'; reason: LibraryAssignmentDecline };

export type PanelAssignmentOutcome =
  WorkspaceMutationOutcome<PanelAssignmentData | AssignmentDeclined>;
export type VariableAssignmentOutcome =
  WorkspaceMutationOutcome<VariableAssignmentData | AssignmentDeclined>;

/** The narrow slice of the app an assignment needs. */
export interface LibraryAssignmentDeps {
  /** The serialized, read-latest-at-dequeue write primitive every workspace
   *  producer commits through. */
  mutateWorkspace: MutateWorkspace;
  /** "Re-read the committed workspace": a rendered Dashboard reads
   *  `variableConfigs` only at construction, and a panel assignment changes the
   *  tile set, so both destinations need the surface rebuilt from committed
   *  truth. */
  onWorkspaceExternallyChanged(info: WorkspaceExternallyChangedInfo): void;
  /** The injected `crypto.randomUUID` seam — see the pure module's header for
   *  why assignment mints ids here instead of deriving them. */
  genId(): string;
  /**
   * The open tabs, read LIVE at commit time rather than captured at drop time.
   * A function, not an array, precisely so the dirty check below re-reads them
   * inside the transform.
   */
  readTabs(): readonly QueryTab[];
}

const declined = (reason: LibraryAssignmentDecline): { candidate: null; data: AssignmentDeclined } =>
  ({ candidate: null, data: { status: 'declined', reason } });

/**
 * Copy a Library query into a Dashboard as a new panel.
 *
 * Both ids are minted OUTSIDE the transform, once per call rather than once per
 * dequeue: a retry of the same drop must not silently become a second panel.
 */
export async function assignLibraryQueryToPanel(
  deps: LibraryAssignmentDeps,
  payload: LibraryQueryDragPayload,
  dashboardId: string,
): Promise<PanelAssignmentOutcome> {
  const newQueryId = deps.genId();
  const newTileId = deps.genId();
  const outcome = await deps.mutateWorkspace<PanelAssignmentData | AssignmentDeclined>((latest) => {
    if (latest === null) return declined('workspace-mismatch');
    const result = copyLibraryQueryToPanel({
      latest,
      workspaceId: payload.workspaceId,
      sourceQueryId: payload.queryId,
      dashboardId,
      newQueryId,
      newTileId,
    });
    if (!result.ok) return declined(result.reason);
    return { candidate: result.workspace, data: { status: 'ok', ...result.data } };
  });
  // `queriesChanged: true` is a fact, not a default: this write appends a
  // dedicated owned copy, which moves nothing out of the Library but does change
  // the collection every projection reads.
  if (outcome.ok) deps.onWorkspaceExternallyChanged({ workspace: outcome.workspace, queriesChanged: true });
  return outcome;
}

/**
 * Copy a Library query's SQL into one Dashboard variable's option-SQL slot.
 *
 * **The dirty-draft gate runs INSIDE the transform.** #428 requires that a drop
 * never silently overwrite an unsaved variable-tab draft, and a check made before
 * dispatch is a snapshot, not a gate: `mutateWorkspace` queues behind
 * `serializeWrite` and then awaits `workspace.loadById`, so a keystroke landing in
 * that window would flip the tab dirty after the check and before the commit.
 *
 * What makes that worse than an ordinary race is that nothing downstream would
 * notice: a variable tab has `savedId === null`, so #343's linked-tab reconciler
 * skips it entirely and there is no external-change marker for a
 * `dashboard-variable` document. The user would be left holding a diverged draft
 * over freshly-assigned committed SQL, with the next Save silently reverting the
 * assignment.
 *
 * `readTabs` is therefore called here, at dequeue time, not captured by the
 * caller. (The caller may still check first as a cheap fast path — that is an
 * optimisation, not the gate.)
 *
 * **The gate is not, and cannot be, the whole story.** It runs inside the
 * transform, but `mutateWorkspace` then awaits `workspace.commit(candidate)`, and
 * a keystroke landing in THAT window passes the gate and diverges anyway — a
 * blocked or slow IndexedDB transaction makes the window materially wider. No
 * check can close it: the commit is the repository's atomic write and UI state
 * cannot be held still across it. So the outcome reports `draftDiverged`, read
 * after the commit resolves, and the caller is expected to surface it rather than
 * treat the assignment as quietly complete. Refusing to adopt while saying
 * nothing is exactly the silent divergence this issue exists to prevent.
 */
export async function assignLibraryQuerySqlToVariable(
  deps: LibraryAssignmentDeps,
  payload: LibraryQueryDragPayload,
  dashboardId: string,
  variableName: string,
): Promise<VariableAssignmentOutcome> {
  const outcome = await deps.mutateWorkspace<VariableAssignmentData | AssignmentDeclined>((latest) => {
    if (latest === null) return declined('workspace-mismatch');
    if (tabSaveDirty(findVariableTab(deps.readTabs(), dashboardId, variableName))) {
      return declined('variable-tab-dirty');
    }
    const result = copyLibraryQuerySqlToVariable({
      latest,
      workspaceId: payload.workspaceId,
      sourceQueryId: payload.queryId,
      dashboardId,
      variableName,
    });
    if (!result.ok) return declined(result.reason);
    // `draftDiverged` is provisional here — the commit has not run yet. It is
    // re-read below, once it has.
    return {
      candidate: result.workspace,
      data: { status: 'ok', sql: result.data.sql, draftDiverged: false },
    };
  });
  // `queriesChanged: false`: this write touches exactly one Dashboard's
  // `variableConfigs` and can never add, remove or edit a query.
  if (!outcome.ok) return outcome;
  deps.onWorkspaceExternallyChanged({ workspace: outcome.workspace, queriesChanged: false });
  // Re-read AFTER the commit resolved. `true` means the durable write landed but
  // the open tab now holds a draft that disagrees with it — the caller must say
  // so, because the next Save on that tab would silently revert the assignment.
  const data = outcome.data as VariableAssignmentData;
  return {
    ...outcome,
    data: {
      ...data,
      draftDiverged: tabSaveDirty(findVariableTab(deps.readTabs(), dashboardId, variableName)),
    },
  };
}

const DECLINE_MESSAGES: Record<LibraryAssignmentDecline, string> = {
  'workspace-mismatch': 'That query belongs to a different workspace — nothing was assigned',
  'source-missing': 'That query was deleted — nothing was assigned',
  'source-not-library': 'That query already belongs to a dashboard — nothing was assigned',
  'dashboard-missing': 'That dashboard is no longer available — nothing was assigned',
  'dashboard-ambiguous': 'That dashboard is no longer available — nothing was assigned',
  'id-collision': 'Could not assign this query — please try again',
  'variable-not-inferred': 'No panel on that dashboard declares this variable any more',
  'blank-sql': 'That query is empty. To remove option SQL, clear it in the variable tab and save',
  'variable-tab-dirty': 'This variable has unsaved changes — nothing was assigned',
};

/**
 * The user-facing sentence for an assignment outcome, or `null` when there is
 * nothing to say (it succeeded, or the route simply moved on while the write was
 * in flight — which is not something the user did and not something to report).
 *
 * Lives here rather than in the drop handler so the eight decline reasons and the
 * three outcome shapes are one tested table instead of a dozen branches inside
 * `ui/dashboard-tree.ts`, which is held at a 100/100/95/90 per-file gate.
 */
export function libraryAssignmentMessage(
  outcome: PanelAssignmentOutcome | VariableAssignmentOutcome,
): string | null {
  if (outcome.ok) return null;
  if (!outcome.aborted) return 'Could not save this assignment — the dashboard was rejected';
  const data = outcome.data;
  if (!data || data.status !== 'declined') return null;
  return DECLINE_MESSAGES[data.reason];
}
