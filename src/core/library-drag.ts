// The Library→Dashboard assignment drag payload (#428). Pure — no DOM, no
// `dataTransfer`, no knowledge of who reads it.
//
// A Library row publishes TWO independent payloads on one drag:
//
//   SUBQUERY_MIME       the SQL snapshot the main editor inserts as `( … )` (PR #40)
//   LIBRARY_QUERY_MIME  the identity below, which only Dashboard targets read
//
// The same gesture therefore means different things to different targets: the
// editor consumes TEXT, Dashboard destinations consume IDENTITY. That split is
// the point. Dashboard assignment must never trust SQL — or a whole serialized
// saved-query object — off `dataTransfer`, because a drag can outlive the state
// it started from: the workspace may have been committed to several times, the
// source may have been edited, deleted, or become Dashboard-owned. Carrying only
// `(workspaceId, queryId)` forces the drop handler to re-resolve committed truth
// inside `mutateWorkspace`, which is the only place that can be authoritative.
//
// `workspaceId` rides along so a drop that lands after a workspace SWITCH can be
// rejected outright rather than resolving a same-looking id in the wrong
// document. Ids are workspace-scoped; nothing else here is.

/** What a Library row hands to a Dashboard drop target. Deliberately the
 *  smallest thing that can be re-resolved — never SQL, never a saved query. */
export interface LibraryQueryDragPayload {
  kind: 'library-query';
  workspaceId: string;
  queryId: string;
}

/** Where an accepted drop would write. Resolved by the tree MODEL (every row's
 *  structural decision belongs there), carried on the row, and handed straight
 *  to the matching application command — so the view never re-derives it and
 *  the two can never disagree. */
export type LibraryDropTarget =
  | { kind: 'panel'; dashboardId: string }
  | { kind: 'variable'; dashboardId: string; variableName: string };

export function encodeLibraryQueryPayload(payload: LibraryQueryDragPayload): string {
  return JSON.stringify(payload);
}

/**
 * Parse a `LIBRARY_QUERY_MIME` payload, or `null` for anything that is not one.
 *
 * Fail-closed and total: `dataTransfer.getData` answers `''` for an absent type
 * rather than throwing, a foreign application can put arbitrary bytes on a drag,
 * and `JSON.parse` throws on both. Every rejection returns `null` so the drop
 * handler has exactly one "not our drag" branch instead of a parse guard at each
 * call site.
 *
 * The `kind` tag is checked, not assumed: it is what distinguishes our payload
 * from any other well-formed JSON that happens to arrive on this MIME type.
 */
export function decodeLibraryQueryPayload(
  text: string | null | undefined,
): LibraryQueryDragPayload | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Partial<LibraryQueryDragPayload>;
  if (candidate.kind !== 'library-query') return null;
  if (typeof candidate.workspaceId !== 'string' || candidate.workspaceId === '') return null;
  if (typeof candidate.queryId !== 'string' || candidate.queryId === '') return null;
  return { kind: 'library-query', workspaceId: candidate.workspaceId, queryId: candidate.queryId };
}
