// Editing ONE panel's dedicated owned query metadata — name and description
// only (#494).
//
// A Dashboard panel does not own a title of its own for ordinary authoring:
// what the tile displays comes from the query it owns (`spec.name` /
// `spec.description`), and only an IMPORTED tile carries a local override.
// So the pencil on a Panel row edits the owned QUERY, through the very same
// `renameSaved` path the Library row's pencil uses — which is what keeps a
// linked Query tab in sync (clean tabs adopt the commit, dirty ones are
// conflict-flagged) instead of this growing a second, subtly different
// metadata writer.
//
// What this module adds on top is the part a Library rename does not need:
// PROOF, at dequeue time, that the query still belongs to the tile the dialog
// was opened for. A tree dialog can outlive the row it came from — another tab
// can delete the tile, or #428's assignment can re-point it — and the query id
// alone cannot say which member owns it. The `guard` runs inside the queued
// transform, so the answer comes from committed truth rather than from
// whatever the tree was painting when the pencil was clicked.
//
// Typed against a structural deps bag: `src/application/**` must never import
// `src/ui/**` (build/check-boundaries.mjs).

import { renameSaved } from '../state.js';
import type { AppState, MutateWorkspace, SpecValidationService } from '../state.js';
import { ownersOfQuery } from '../dashboard/model/query-ownership.js';
import type { SavedQueryV2, StoredWorkspaceV5 } from '../generated/json-schema.types.js';

/** Which owned query to edit, addressed the way #430 requires — Dashboard id +
 *  the member's own Dashboard-local id + the query id, never a title, a name
 *  or a collection position. All three are re-resolved at dequeue time. */
export interface PanelMetadataTarget {
  dashboardId: string;
  tileId: string;
  queryId: string;
}

export type PanelMetadataOutcome =
  | { status: 'ok'; entry: SavedQueryV2 }
  /** The tile no longer owns this query (deleted, re-pointed, or now shared),
   *  or the query itself is gone. Nothing was committed, and no retry of the
   *  same edit can succeed. */
  | { status: 'stale' }
  /** A linked tab is holding Spec JSON that does not parse/validate, so the
   *  same patch cannot be applied to both the entry and the draft. Nothing was
   *  committed; the tab is where this gets resolved. */
  | { status: 'invalid-draft' }
  | { status: 'rejected'; message: string };

export interface PanelMetadataDeps {
  state: AppState;
  mutateWorkspace: MutateWorkspace;
  specValidators: SpecValidationService;
  /**
   * Ask every rendered surface to re-read committed truth, so a renamed panel's
   * tile heading and its tree row update without waiting for an unrelated
   * repaint. Declared as a plain notification rather than as
   * `onWorkspaceExternallyChanged` itself: `renameSaved` does not hand back the
   * committed aggregate, and inventing a `workspace: null` for that hook would
   * mean "the record was cleared", which is the opposite of what happened.
   */
  refreshCommittedSurfaces(): void;
}

/**
 * The #427 exactly-one-owner rule, asked about ONE specific member.
 *
 * Exported because the tree model answers the same question when it decides
 * whether to enable the pencil at all — the difference is only WHEN it is
 * asked (paint time there, dequeue time here), and the two must agree.
 */
export function ownedByPanel(
  workspace: StoredWorkspaceV5, target: PanelMetadataTarget,
): boolean {
  const owners = ownersOfQuery(workspace, target.queryId);
  return owners.length === 1
    && owners[0].dashboardId === target.dashboardId
    && owners[0].tileId === target.tileId
    && workspace.queries.some((query) => query.id === target.queryId);
}

/**
 * Commit a panel's owned-query name/description.
 *
 * `renameSaved` does the rest of the work and its rules are inherited
 * deliberately: the name is trimmed and a blank one commits nothing, an empty
 * description CLEARS the field rather than storing `''`, the SQL, the query
 * id, `spec.dashboard.role`, panel configuration, variants, size hints, time
 * ranges and unknown Spec fields are all carried through untouched, and no
 * Dashboard document is read or written — so a metadata-only edit cannot
 * increment a Dashboard revision.
 *
 * A tile-local imported `title`/`description` override is likewise untouched:
 * this writes the QUERY, and the override keeps its established display
 * precedence (the caller is responsible for saying so).
 */
export async function commitPanelQueryMetadata(
  deps: PanelMetadataDeps, target: PanelMetadataTarget, name: string, description: string,
): Promise<PanelMetadataOutcome> {
  const result = await renameSaved(
    deps.state, target.queryId, name, description,
    deps.mutateWorkspace, deps.specValidators,
    (latest) => ownedByPanel(latest, target),
  );
  // `renameSaved` answers `undefined` for a blank name or a query missing from
  // the PROJECTED collection — both mean "nothing was attempted".
  if (result === undefined) return { status: 'stale' };
  if (result.ok) {
    deps.refreshCommittedSurfaces();
    return { status: 'ok', entry: result.entry };
  }
  // `deletedExternally` is deliberately NOT checked alongside this: it means
  // the query was absent from `latest`, and `ownedByPanel` already requires it
  // to be present — `patchSavedSpec` evaluates the guard BEFORE its own
  // deleted-externally test, so a deleted query always refuses here first.
  if (result.guardRefused) return { status: 'stale' };
  if (result.invalidTab !== null) return { status: 'invalid-draft' };
  return {
    status: 'rejected',
    message: result.diagnostics?.[0]?.message || 'Could not save this panel.',
  };
}
