// The Dashboard tree's SESSION UI state (#426): expansion, search text, scroll
// position and keyboard row, scoped by workspace identity. Pure — no DOM, no
// persistence, no signals, and no imports at all.
//
// Lives in `src/core/` per CLAUDE.md hard rule 2, alongside the other pure
// domain modules (`core/dashboard.ts`, `core/tile-reorder.ts`,
// `core/dashboard-autoscroll.ts`). It resolves nothing against the workspace
// aggregate — it transforms sets and strings — which is exactly what separates it
// from `application/dashboard-tree-model.ts`, whose placement outside `core/` is
// forced: that one reads `MainSurfaceState`, and `src/core/` may never import
// `src/workspace/` (build/check-boundaries.mjs).
//
// Never exported and never persisted: `StoredWorkspaceV3` carries none of this.
// Keyed by `StoredWorkspaceV3.id` — the immutable opaque application identity
// (#406) — never by the mutable `name` or the rewritable URL `key`.
//
// Deliberately NOT a signal, matching `state.libraryFilter`'s precedent
// (`src/state.ts`): if a repaint effect observed this state, every keystroke in
// the search box and every scroll frame would repaint the tree — losing the caret
// on the first and doing pointless work on the second. The tree's ONE reactive
// input is `state.dashboardTreeRevision` (workspace projection / navigation
// changes); every change to the state below is followed by the view re-rendering
// its own row list directly, exactly as `saved-history.ts` does.
//
// Every function is copy-on-write, so a caller can never observe a half-updated
// value and each returned state is safe to compare by identity.

/**
 * Escape one component before it is joined into a key. Dashboard, tile and filter
 * ids are only schema-constrained to `\S`, so a colon is LEGAL — and an imported
 * bundle preserves whatever ids it carried. Unescaped, a Dashboard literally named
 * `a:tile:b` produces the same row key as tile `b` of Dashboard `a`, which would
 * give two rows `tabindex="0"`, point the view's `focusRow` at the wrong row, and
 * let the click arbiter read clicks on two distinct resources as a double-click.
 * `%` is escaped first, so the escape itself cannot be forged.
 *
 * Lives here rather than in `dashboard-tree-model.ts` so the dependency between the
 * two modules stays one-way (the model already imports `groupStateKey`).
 */
export const encodeKeyPart = (part: string): string => part.replace(/%/g, '%25').replace(/:/g, '%3A');

/** Which of a Dashboard's two groups a group key names. */
export type DashboardTreeGroup = 'filters' | 'panels';

export interface DashboardTreeUiState {
  /** Expanded Dashboards, by stable Dashboard id. */
  readonly expandedDashboardIds: ReadonlySet<string>;
  /** Expanded groups, by `groupStateKey(dashboardId, group)`. */
  readonly expandedGroups: ReadonlySet<string>;
  readonly searchText: string;
  readonly scrollTop: number;
  /**
   * The scroll position from BEFORE a search narrowed the tree, so clearing the
   * search can restore it. A single `scrollTop` cannot do both jobs: it has to
   * track the filtered list while the search is active.
   */
  readonly preSearchScrollTop: number | null;
  /** The row that owns the roving tabindex, by row key. */
  readonly keyboardRowKey: string | null;
}

/** A fresh workspace's tree state: nothing expanded, no search, at the top. */
export const EMPTY_TREE_UI: DashboardTreeUiState = Object.freeze({
  expandedDashboardIds: Object.freeze(new Set<string>()) as ReadonlySet<string>,
  expandedGroups: Object.freeze(new Set<string>()) as ReadonlySet<string>,
  searchText: '',
  scrollTop: 0,
  preSearchScrollTop: null,
  keyboardRowKey: null,
});

/** Group keys are Dashboard-local: the map is already per-workspace. The id is
 *  escaped for the same reason row keys escape theirs — ids may legally contain a
 *  colon, and `pruneTreeUi` below has to split this back apart unambiguously. */
export function groupStateKey(dashboardId: string, group: DashboardTreeGroup): string {
  return encodeKeyPart(dashboardId) + ':' + group;
}

/** This workspace's state, or the empty state when it has none yet. Reading never
 *  creates an entry — a workspace the user has not opened the Dashboards role in
 *  costs nothing. */
export function readTreeUi(
  states: ReadonlyMap<string, DashboardTreeUiState>, workspaceId: string,
): DashboardTreeUiState {
  return states.get(workspaceId) ?? EMPTY_TREE_UI;
}

const withToggled = (set: ReadonlySet<string>, key: string): ReadonlySet<string> => {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
};

export function toggleDashboardExpanded(
  state: DashboardTreeUiState, dashboardId: string,
): DashboardTreeUiState {
  return { ...state, expandedDashboardIds: withToggled(state.expandedDashboardIds, dashboardId) };
}

/** Expand or collapse explicitly, for the keyboard's Right/Left keys — which must
 *  not toggle (Right on an open row moves to its first child instead). */
export function setDashboardExpanded(
  state: DashboardTreeUiState, dashboardId: string, expanded: boolean,
): DashboardTreeUiState {
  if (state.expandedDashboardIds.has(dashboardId) === expanded) return state;
  return toggleDashboardExpanded(state, dashboardId);
}

export function toggleGroupExpanded(
  state: DashboardTreeUiState, dashboardId: string, group: DashboardTreeGroup,
): DashboardTreeUiState {
  return {
    ...state,
    expandedGroups: withToggled(state.expandedGroups, groupStateKey(dashboardId, group)),
  };
}

export function setGroupExpanded(
  state: DashboardTreeUiState, dashboardId: string, group: DashboardTreeGroup, expanded: boolean,
): DashboardTreeUiState {
  if (state.expandedGroups.has(groupStateKey(dashboardId, group)) === expanded) return state;
  return toggleGroupExpanded(state, dashboardId, group);
}

/**
 * Change the search text, preserving the pre-search scroll position across the
 * whole search and restoring it when the search clears. Expansion is untouched:
 * a search exposes matching paths at PRESENTATION time (see
 * `dashboard-tree-model.ts`) rather than writing the user's expansion sets.
 */
export function setTreeSearch(
  state: DashboardTreeUiState, searchText: string,
): DashboardTreeUiState {
  const wasSearching = state.searchText !== '';
  const nowSearching = searchText !== '';
  if (!wasSearching && nowSearching) {
    return { ...state, searchText, preSearchScrollTop: state.scrollTop };
  }
  if (wasSearching && !nowSearching) {
    return {
      ...state,
      searchText,
      scrollTop: state.preSearchScrollTop ?? 0,
      preSearchScrollTop: null,
    };
  }
  return { ...state, searchText };
}

export function setTreeScroll(state: DashboardTreeUiState, scrollTop: number): DashboardTreeUiState {
  if (state.scrollTop === scrollTop) return state;
  return { ...state, scrollTop };
}

export function setKeyboardRow(
  state: DashboardTreeUiState, keyboardRowKey: string | null,
): DashboardTreeUiState {
  if (state.keyboardRowKey === keyboardRowKey) return state;
  return { ...state, keyboardRowKey };
}

/**
 * Drop expansion entries for Dashboards the workspace no longer contains, keeping
 * every surviving id — so an ordinary mutation (renaming a Dashboard, adding a
 * tile) never collapses the tree the user has open. Returns the SAME state when
 * nothing needed pruning, so a caller can skip a pointless store.
 */
export function pruneTreeUi(
  state: DashboardTreeUiState, dashboardIds: Iterable<string>,
): DashboardTreeUiState {
  const alive = new Set(dashboardIds);
  const dashboards = new Set([...state.expandedDashboardIds].filter((id) => alive.has(id)));
  // A group key is `<escaped dashboardId>:<group>`, so the id is everything before
  // the last separator — unambiguous now that the id itself carries no bare colon.
  const escaped = new Set([...alive].map(encodeKeyPart));
  const groups = new Set([...state.expandedGroups].filter(
    (key) => escaped.has(key.slice(0, key.lastIndexOf(':'))),
  ));
  if (dashboards.size === state.expandedDashboardIds.size
    && groups.size === state.expandedGroups.size) return state;
  return { ...state, expandedDashboardIds: dashboards, expandedGroups: groups };
}

/**
 * Keep the roving tabindex on a row that is actually rendered. Called by the view
 * on every paint, because a row can leave the visible set for reasons pruning
 * cannot see — a collapsed ancestor, or a search that filtered it out — and a
 * `tabindex` owner that no longer exists would leave the tree unreachable by
 * keyboard. Falls back to the first visible row.
 */
export function clampKeyboardRow(
  state: DashboardTreeUiState, visibleRowKeys: readonly string[],
): DashboardTreeUiState {
  if (state.keyboardRowKey !== null && visibleRowKeys.includes(state.keyboardRowKey)) return state;
  return setKeyboardRow(state, visibleRowKeys[0] ?? null);
}
