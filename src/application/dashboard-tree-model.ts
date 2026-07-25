// The Dashboard hierarchy tree's pure derivation (#426): Dashboard → Filters →
// Panels, projected from the committed workspace aggregate plus main-surface
// navigation state. No DOM, no persistence, no globals.
//
// Lives in `src/application/` (not `src/core/` or `src/dashboard/`) for the same
// reason `main-surface.ts` does: it resolves against the workspace aggregate AND
// reads `MainSurfaceState`, and the dependency direction is
// `workspace <- application <- UI` (`build/check-boundaries.mjs` forbids
// `src/dashboard/**` from importing `src/application/**`).
//
// It emits a FLAT list of already-ordered, already-filtered VISIBLE rows, each
// carrying everything the view needs — level, parent, expansion, match state,
// invalid annotation, and the row's own ACTION SET. That is deliberate: it gives
// `ui/dashboard-tree.ts` one generic dispatch path instead of a per-kind gesture
// switch, which is what keeps that module inside the per-file coverage gate. The
// view renders this list 1:1 and never re-derives structure.
//
// This is a READ-ONLY projection. It never clones, repairs, rejects or rewrites a
// reference, and it never throws — see "Defensive rendering" below.

import type { DashboardFocusTarget, MainSurfaceState } from './main-surface.js';
import type { DashboardTreeGroup, DashboardTreeUiState } from './dashboard-tree-ui-state.js';
import { groupStateKey } from './dashboard-tree-ui-state.js';

// ── Deliberately loosened input shapes ──────────────────────────────────────
// The persisted-workspace validator normally rejects broken references, but the
// tree must stay robust while data is stale, imported, or concurrently changed —
// so the collections the generated schema types mark REQUIRED are optional here.
// Every guard this buys has a malformed fixture in the spec that reaches it; none
// is unreachable defensive padding (which the coverage config forbids).
// A real `StoredWorkspaceV3` / `DashboardDocumentV1` / `SavedQueryV2` satisfies
// these structurally, with no cast at the call site.

export interface TreeQuery {
  id: string;
  spec?: { name?: string; description?: string } | null;
}

export interface TreeTile {
  id: string;
  queryId?: string | null;
  title?: string;
  description?: string;
}

export interface TreeFilter {
  id: string;
  parameter?: string;
  label?: string;
  sourceQueryId?: string | null;
}

export interface TreeDashboard {
  id: string;
  title?: string;
  description?: string;
  filters?: readonly TreeFilter[] | null;
  tiles?: readonly TreeTile[] | null;
}

export interface TreeWorkspace {
  /** `StoredWorkspaceV3.id` — the immutable opaque identity, never the URL key. */
  id: string;
  dashboards?: readonly TreeDashboard[] | null;
  queries?: readonly TreeQuery[] | null;
}

// ── Output ──────────────────────────────────────────────────────────────────

export type DashboardTreeRowKind = 'dashboard' | 'group' | 'filter' | 'panel';

/** Why a row cannot open a query. `null` covers both "it can" and the
 *  TRANSITIONAL source-less filter, which is not an error: before #427 a curated
 *  filter legitimately has no `sourceQueryId`. */
export type DashboardTreeInvalid = 'unresolved-query' | 'unresolved-source' | null;

/** Every operation any row can offer. The view owns ONE dispatcher over these
 *  ids, so the model stays pure (no injected `app`, no closures) and the view
 *  keeps a single covered code path. */
export type DashboardTreeActionId =
  | 'toggle'
  | 'open-query'
  | 'open-view'
  | 'open-edit'
  | 'focus-view'
  | 'focus-edit';

export interface DashboardTreeAction {
  id: DashboardTreeActionId;
  label: string;
  enabled: boolean;
}

export interface DashboardTreeRow {
  /** Stable identity: `<workspaceId>:<dashboardId>` plus, for a group,
   *  `:group:filters|panels`, and for a member `:filter:<id>` / `:tile:<id>`.
   *  Never derived from an array index, a title, a query id or a label. */
  key: string;
  kind: DashboardTreeRowKind;
  /** 1-based, for `aria-level`. */
  level: number;
  parentKey: string | null;
  label: string;
  /** An inline count rendered right after the label (`Filters · 3`), matching the
   *  lower switcher's `.side-count` treatment. */
  count: number | null;
  /** Right-aligned trailing text — the Dashboard row's panel count. */
  meta: string;
  expandable: boolean;
  expanded: boolean;
  /** This row itself matched the active search (for match styling). */
  matched: boolean;
  /** The open Dashboard, or the member most recently navigated to inside it. */
  current: boolean;
  invalid: DashboardTreeInvalid;
  /** Accessible description for an invalid row; `null` otherwise. */
  diagnostic: string | null;
  dashboardId: string;
  /** The member this row addresses, by Dashboard-local id — never by query id. */
  member: DashboardFocusTarget | null;
  /** The query a primary click would open, when one resolves. */
  queryId: string | null;
  group: DashboardTreeGroup | null;
  single: DashboardTreeActionId | null;
  double: DashboardTreeActionId | null;
  shift: DashboardTreeActionId | null;
  menu: readonly DashboardTreeAction[];
}

export interface DashboardTree {
  rows: readonly DashboardTreeRow[];
  /** What to show INSTEAD of rows when there are none. */
  empty: 'no-dashboards' | 'no-matches' | null;
  /** The Dashboards tab's count — the whole collection, never the filtered view. */
  dashboardCount: number;
}

export interface DashboardTreeInput {
  workspace: TreeWorkspace | null;
  surface: MainSurfaceState;
  ui: DashboardTreeUiState;
}

export const UNTITLED_DASHBOARD = 'Untitled dashboard';
export const UNTITLED_FILTER = 'Untitled filter';
export const UNTITLED_PANEL = 'Untitled panel';
const MISSING_QUERY_DIAGNOSTIC = 'This panel\'s query is not in this workspace, so it cannot be opened.';
const MISSING_SOURCE_DIAGNOSTIC = 'This filter\'s option-source query is not in this workspace, so it cannot be opened.';

const trimmed = (value: string | undefined): string => (typeof value === 'string' ? value.trim() : '');
const specName = (query: TreeQuery | null): string => trimmed(query?.spec?.name ?? undefined);
const specDescription = (query: TreeQuery | null): string => trimmed(query?.spec?.description ?? undefined);

/** One member's resolved facts, computed once and used for the label, the search
 *  haystack, the invalid annotation and the action set alike. */
interface MemberFacts {
  label: string;
  haystack: readonly string[];
  invalid: DashboardTreeInvalid;
  queryId: string | null;
}

function tileFacts(tile: TreeTile, queries: ReadonlyMap<string, TreeQuery>): MemberFacts {
  // An imported compatibility override wins; otherwise the resolved query's own
  // name. Existing tile-title display semantics are preserved — this never
  // creates or erases an override.
  const override = trimmed(tile.title);
  const queryId = typeof tile.queryId === 'string' ? tile.queryId : null;
  const query = queryId === null ? null : queries.get(queryId) ?? null;
  const name = specName(query);
  return {
    label: override || name || UNTITLED_PANEL,
    haystack: [override, trimmed(tile.description), name, specDescription(query)],
    invalid: query === null ? 'unresolved-query' : null,
    queryId: query === null ? null : queryId,
  };
}

function filterFacts(filter: TreeFilter, queries: ReadonlyMap<string, TreeQuery>): MemberFacts {
  const label = trimmed(filter.label);
  const parameter = trimmed(filter.parameter);
  // ABSENT is the transitional case (#427 gives curated filters a dedicated
  // filter-role query); PRESENT-but-unresolved is a genuine broken reference.
  // They must not be conflated: only the second is a diagnostic.
  const sourceId = typeof filter.sourceQueryId === 'string' ? filter.sourceQueryId : null;
  const source = sourceId === null ? null : queries.get(sourceId) ?? null;
  const name = specName(source);
  return {
    label: label || name || parameter || UNTITLED_FILTER,
    haystack: [label, parameter, name, specDescription(source)],
    invalid: sourceId !== null && source === null ? 'unresolved-source' : null,
    queryId: source === null ? null : sourceId,
  };
}

const MEMBER_MENU_LABELS: Record<'panel' | 'filter', Record<'open' | 'view' | 'edit', string>> = {
  panel: {
    open: 'Open query',
    view: 'Open Dashboard in View and focus panel',
    edit: 'Open Dashboard in Edit and focus panel',
  },
  filter: {
    open: 'Open source query',
    view: 'Open Dashboard in View and focus filter',
    edit: 'Open Dashboard in Edit and focus filter',
  },
};

export function deriveDashboardTree(
  { workspace, surface, ui }: DashboardTreeInput,
): DashboardTree {
  const dashboards = workspace?.dashboards ?? [];
  const queries = new Map<string, TreeQuery>();
  for (const query of workspace?.queries ?? []) queries.set(query.id, query);

  const search = ui.searchText.trim().toLowerCase();
  const hits = (haystack: readonly string[]): boolean =>
    haystack.some((text) => text.toLowerCase().includes(search));

  const selectedId = surface.kind === 'dashboard' ? surface.dashboardId : null;
  const currentMember = surface.kind === 'dashboard' ? surface.currentMember : null;
  const workspaceId = workspace?.id ?? '';

  const rows: DashboardTreeRow[] = [];

  for (const dashboard of dashboards) {
    const dashboardKey = workspaceId + ':' + dashboard.id;
    const title = trimmed(dashboard.title);
    const description = trimmed(dashboard.description);
    const dashboardMatched = search !== '' && hits([title, description]);

    const filters = dashboard.filters ?? [];
    const tiles = dashboard.tiles ?? [];
    const filterEntries = filters.map((filter) => ({ filter, facts: filterFacts(filter, queries) }));
    const tileEntries = tiles.map((tile) => ({ tile, facts: tileFacts(tile, queries) }));

    // A direct Dashboard match shows its COMPLETE hierarchy for context (#426
    // permits this); otherwise only the members that matched are shown.
    const showAll = search === '' || dashboardMatched;
    const shownFilters = showAll ? filterEntries : filterEntries.filter((e) => hits(e.facts.haystack));
    const shownTiles = showAll ? tileEntries : tileEntries.filter((e) => hits(e.facts.haystack));

    if (search !== '' && !dashboardMatched && shownFilters.length === 0 && shownTiles.length === 0) continue;

    // A search EXPOSES matching paths at presentation time; it never writes the
    // user's expansion sets, so clearing it restores exactly what was open.
    const dashboardExpanded = search !== '' || ui.expandedDashboardIds.has(dashboard.id);
    const isCurrentDashboard = selectedId === dashboard.id;

    rows.push({
      key: dashboardKey,
      kind: 'dashboard',
      level: 1,
      parentKey: null,
      label: title || UNTITLED_DASHBOARD,
      count: null,
      // Filters are Dashboard-level controls and are deliberately NOT counted here.
      meta: String(tiles.length),
      expandable: true,
      expanded: dashboardExpanded,
      matched: dashboardMatched,
      current: isCurrentDashboard,
      invalid: null,
      diagnostic: null,
      dashboardId: dashboard.id,
      member: null,
      queryId: null,
      group: null,
      single: 'toggle',
      double: 'open-view',
      shift: 'open-edit',
      menu: [
        { id: 'open-view', label: 'Open in View', enabled: true },
        { id: 'open-edit', label: 'Open in Edit', enabled: true },
      ],
    });

    if (!dashboardExpanded) continue;

    // Filters ALWAYS precedes Panels, and both group rows stay visible while the
    // Dashboard is expanded — including when empty, because #428 will use them as
    // stable drop targets.
    const groups: readonly { group: DashboardTreeGroup; label: string; total: number; shown: readonly { facts: MemberFacts; member: DashboardFocusTarget }[] }[] = [
      {
        group: 'filters',
        label: 'Filters',
        total: filters.length,
        shown: shownFilters.map((e) => ({ facts: e.facts, member: { kind: 'filter' as const, id: e.filter.id } })),
      },
      {
        group: 'panels',
        label: 'Panels',
        total: tiles.length,
        shown: shownTiles.map((e) => ({ facts: e.facts, member: { kind: 'tile' as const, id: e.tile.id } })),
      },
    ];

    for (const { group, label, total, shown } of groups) {
      const groupKey = dashboardKey + ':group:' + group;
      // While searching, a group opens when it actually has something to show.
      const groupExpanded = search !== ''
        ? shown.length > 0
        : ui.expandedGroups.has(groupStateKey(dashboard.id, group));
      rows.push({
        key: groupKey,
        kind: 'group',
        level: 2,
        parentKey: dashboardKey,
        label,
        count: total,
        meta: '',
        expandable: true,
        expanded: groupExpanded,
        matched: false,
        current: false,
        invalid: null,
        diagnostic: null,
        dashboardId: dashboard.id,
        member: null,
        queryId: null,
        group,
        // A group row has no double or Shift action, so its expansion needs no
        // arbitration and the view toggles it immediately.
        single: 'toggle',
        double: null,
        shift: null,
        menu: [],
      });
      if (!groupExpanded) continue;

      for (const { facts, member } of shown) {
        const kind = member.kind === 'tile' ? 'panel' : 'filter';
        const labels = MEMBER_MENU_LABELS[kind];
        // Before #427 one query can back several members, so this is one row PER
        // MEMBER — never merged by query id or label.
        const canOpenQuery = facts.queryId !== null;
        rows.push({
          key: dashboardKey + ':' + member.kind + ':' + member.id,
          kind,
          level: 3,
          parentKey: groupKey,
          label: facts.label,
          count: null,
          meta: '',
          expandable: false,
          expanded: false,
          matched: search !== '' && hits(facts.haystack),
          current: isCurrentDashboard && currentMember !== null
            && currentMember.kind === member.kind && currentMember.id === member.id,
          invalid: facts.invalid,
          diagnostic: facts.invalid === null
            ? null
            : facts.invalid === 'unresolved-query' ? MISSING_QUERY_DIAGNOSTIC : MISSING_SOURCE_DIAGNOSTIC,
          dashboardId: dashboard.id,
          member,
          queryId: facts.queryId,
          group,
          // Only the query-open action is withheld: Dashboard View/Edit focus
          // navigation stays available so a broken member's diagnostics remain
          // reachable.
          single: canOpenQuery ? 'open-query' : null,
          double: 'focus-view',
          shift: 'focus-edit',
          menu: [
            { id: 'open-query', label: labels.open, enabled: canOpenQuery },
            { id: 'focus-view', label: labels.view, enabled: true },
            { id: 'focus-edit', label: labels.edit, enabled: true },
          ],
        });
      }
    }
  }

  return {
    rows,
    empty: rows.length > 0 ? null : dashboards.length === 0 ? 'no-dashboards' : 'no-matches',
    dashboardCount: dashboards.length,
  };
}
