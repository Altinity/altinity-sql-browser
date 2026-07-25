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

import type { DashboardFocusTarget, MainSurfaceState, OpenDashboardRequest } from './main-surface.js';
import type { DashboardTreeGroup, DashboardTreeUiState } from '../core/dashboard-tree-ui-state.js';
import { encodeKeyPart, groupStateKey } from '../core/dashboard-tree-ui-state.js';

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

/**
 * One fully-resolved operation a row can perform. The model emits the COMMAND,
 * not an id the view has to re-derive arguments for — so the view's dispatcher is
 * three exhaustive branches with no null guards, and every argument
 * (`queryId`, `request.focus`) is non-optional by construction. That is what
 * keeps `ui/dashboard-tree.ts` free of the unreachable defensive branches the
 * coverage config forbids.
 *
 * `toggle` carries no target: the view always has the row in hand.
 */
export type DashboardTreeCommand =
  | { kind: 'toggle' }
  | { kind: 'open-query'; queryId: string }
  | { kind: 'open-dashboard'; request: OpenDashboardRequest };

export interface DashboardTreeMenuItem {
  label: string;
  /** `null` when the operation is unavailable — a source-less or broken member's
   *  query-open. The item still renders, disabled, so the row's full vocabulary
   *  stays discoverable and keyboard-reachable. */
  command: DashboardTreeCommand | null;
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
  /**
   * Whether this row's expansion can be CHANGED right now. False for a row a search
   * is holding open: #426 requires a search to expose paths "without mutating saved
   * expansion state" and to restore the pre-search state when cleared, so a click
   * that silently wrote expansion — invisible until the search cleared, then
   * surprising — would violate both. Such a row keeps `aria-expanded` (it genuinely
   * is open) but offers no toggle.
   */
  toggleable: boolean;
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
  /** Primary click (deferred through the click arbiter for member and Dashboard
   *  rows; run immediately for a group row, which has no competing gesture). */
  single: DashboardTreeCommand | null;
  double: DashboardTreeCommand | null;
  shift: DashboardTreeCommand | null;
  /** The keyboard-reachable equivalent of every gesture this row offers. */
  menu: readonly DashboardTreeMenuItem[];
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

/** A fully-resolved Dashboard-open command. A member target makes it a FOCUS
 *  navigation; omitting one opens the Dashboard row itself. */
const openDashboardCommand = (
  dashboardId: string, mode: 'view' | 'edit', focus?: DashboardFocusTarget,
): DashboardTreeCommand => ({
  kind: 'open-dashboard',
  request: { dashboardId, mode, ...(focus === undefined ? {} : { focus }) },
});

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
    const dashboardKey = encodeKeyPart(workspaceId) + ':' + encodeKeyPart(dashboard.id);
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
    // user's expansion sets, so clearing it restores exactly what was open — which
    // also means a row the search is FORCING open cannot be toggled at all.
    const dashboardForced = search !== '';
    const dashboardExpanded = dashboardForced || ui.expandedDashboardIds.has(dashboard.id);
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
      toggleable: !dashboardForced,
      matched: dashboardMatched,
      current: isCurrentDashboard,
      invalid: null,
      diagnostic: null,
      dashboardId: dashboard.id,
      member: null,
      queryId: null,
      group: null,
      single: dashboardForced ? null : { kind: 'toggle' },
      double: openDashboardCommand(dashboard.id, 'view'),
      shift: openDashboardCommand(dashboard.id, 'edit'),
      menu: [
        { label: 'Open in View', command: openDashboardCommand(dashboard.id, 'view') },
        { label: 'Open in Edit', command: openDashboardCommand(dashboard.id, 'edit') },
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
      // A search FORCES a group open only when it actually has a match to reveal;
      // otherwise the user's own expansion still decides. Mirrors `ui/schema.ts`'s
      // second level, whose forcing term is likewise conditional
      // (`tableCascadeForced`) rather than "any search at all" — with an
      // unconditional override, a group with no matches renders a chevron that
      // cannot open (nothing to show) and cannot stay closed once it does match,
      // and clicking it silently writes expansion that only surfaces later, after
      // the search is cleared.
      const groupForced = search !== '' && shown.length > 0;
      const groupExpanded = ui.expandedGroups.has(groupStateKey(dashboard.id, group)) || groupForced;
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
        toggleable: !groupForced,
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
        single: groupForced ? null : { kind: 'toggle' },
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
        const openQuery: DashboardTreeCommand | null = facts.queryId === null
          ? null
          : { kind: 'open-query', queryId: facts.queryId };
        const focusView = openDashboardCommand(dashboard.id, 'view', member);
        const focusEdit = openDashboardCommand(dashboard.id, 'edit', member);
        rows.push({
          key: dashboardKey + ':' + member.kind + ':' + encodeKeyPart(member.id),
          kind,
          level: 3,
          parentKey: groupKey,
          label: facts.label,
          count: null,
          meta: '',
          expandable: false,
          expanded: false,
          toggleable: false,
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
          single: openQuery,
          double: focusView,
          shift: focusEdit,
          menu: [
            { label: labels.open, command: openQuery },
            { label: labels.view, command: focusView },
            { label: labels.edit, command: focusEdit },
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
