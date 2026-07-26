// The Dashboard hierarchy tree's pure derivation (#426): Dashboard → Variables →
// Panels, projected from the committed workspace aggregate plus main-surface
// navigation state. No DOM, no persistence, no globals.
//
// #447 replaced the Filters subtree with a VARIABLES subtree. A variable is not
// a persisted object with an id: it is inferred from the `{name:Type}`
// placeholders in the queries this Dashboard's panel tiles own, unioned with any
// orphaned `dashboard.variableConfigs` key. All of that aggregation — ordering,
// status, type display and the hover diagnostics — belongs to the pure
// `core/dashboard-variables.ts` service; this module only projects its result
// into rows. It never re-composes a diagnostic string of its own.
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
import { inferDashboardVariables } from '../core/dashboard-variables.js';
import type { DashboardVariable } from '../core/dashboard-variables.js';

// ── Deliberately loosened input shapes ──────────────────────────────────────
// The persisted-workspace validator normally rejects broken references, but the
// tree must stay robust while data is stale, imported, or concurrently changed —
// so the collections the generated schema types mark REQUIRED are optional here.
// Every guard this buys has a malformed fixture in the spec that reaches it; none
// is unreachable defensive padding (which the coverage config forbids).
// A real `StoredWorkspaceV5` / `DashboardDocumentV2` / `SavedQueryV2` satisfies
// these structurally, with no cast at the call site.

export interface TreeQuery {
  id: string;
  /** #447: the SQL the variable inference scans for `{name:Type}` declarations.
   *  Optional here for the same reason the collections are — a real
   *  `SavedQueryV2` always carries it. */
  sql?: string;
  spec?: { name?: string; description?: string } | null;
}

export interface TreeTile {
  id: string;
  queryId?: string | null;
  title?: string;
  description?: string;
}

export interface TreeDashboard {
  id: string;
  title?: string;
  description?: string;
  /** #447: stored Dashboard-local option SQL, keyed by EXACT variable name. The
   *  only persisted variable state there is — every other variable fact is
   *  inferred from the panel queries. */
  variableConfigs?: Record<string, { sql: string; lastKnownType?: string }> | null;
  tiles?: readonly TreeTile[] | null;
}

export interface TreeWorkspace {
  /** `StoredWorkspaceV5.id` — the immutable opaque identity, never the URL key. */
  id: string;
  dashboards?: readonly TreeDashboard[] | null;
  queries?: readonly TreeQuery[] | null;
}

// ── Output ──────────────────────────────────────────────────────────────────

export type DashboardTreeRowKind = 'dashboard' | 'group' | 'variable' | 'panel';

/**
 * What is wrong with a row. `null` means nothing is.
 *
 * #447 widened this beyond "why a row cannot open a query": a variable row's
 * annotation is about the VARIABLE, not about a reference it fails to resolve.
 * The two variable states are deliberately distinct values rather than one
 * shared "bad" marker — they differ in severity, in the word the view renders,
 * and in the accessible label a screen reader announces.
 */
export type DashboardTreeInvalid =
  | 'unresolved-query'
  | 'variable-conflict'
  | 'variable-unused'
  | null;

/**
 * How loudly a row's annotation reads. A conflicted variable is an ERROR — no
 * control can be rendered for it, so a Dashboard is genuinely broken until it is
 * resolved. An orphaned configuration is a WARNING — the Dashboard works, some
 * stored SQL is simply not being executed. The view styles and LABELS the two
 * differently (colour is never the only signal), which a single boolean could
 * not express.
 */
export type DashboardTreeSeverity = 'error' | 'warning' | null;

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
  | { kind: 'open-dashboard'; request: OpenDashboardRequest }
  /** #447: open THIS variable's option SQL. Deliberately not `open-query`: a
   *  variable is not a saved query (an orphan has no declaring panel at all), and
   *  it is addressed by Dashboard id + exact name, which is the only identity a
   *  variable has. #457 made the target a dedicated main-editor tab rather than a
   *  drawer; the command itself is unchanged, since the identity is the same. */
  | { kind: 'open-variable'; dashboardId: string; name: string };

export interface DashboardTreeMenuItem {
  label: string;
  /** `null` when the operation is unavailable — a source-less or broken member's
   *  query-open. The item still renders, disabled, so the row's full vocabulary
   *  stays discoverable and keyboard-reachable. */
  command: DashboardTreeCommand | null;
}

export interface DashboardTreeRow {
  /** Stable identity: `<workspaceId>:<dashboardId>` plus, for a group,
   *  `:group:variables|panels`, and for a member `:variable:<name>` /
   *  `:tile:<id>`. Never derived from an array index, a title, a query id or a
   *  label. */
  key: string;
  kind: DashboardTreeRowKind;
  /** 1-based, for `aria-level`. */
  level: number;
  parentKey: string | null;
  label: string;
  /** An inline count rendered right after the label (`Variables · 3`), matching
   *  the lower switcher's `.side-count` treatment. */
  count: number | null;
  /** Right-aligned trailing text — the Dashboard row's panel count, or a
   *  variable row's type(s) (`String`, `String | UInt64`, or nothing at all for
   *  an orphan with no `lastKnownType`). */
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
  /** How loudly `invalid` reads; `null` exactly when `invalid` is. */
  severity: DashboardTreeSeverity;
  /** Accessible description for an annotated row; `null` otherwise. For a
   *  variable this is the variable's OWN diagnostic, verbatim from
   *  `core/dashboard-variables.ts` — never re-composed here. */
  diagnostic: string | null;
  /** #447: whether this row offers a trailing destructive affordance. True for
   *  an ORPHANED variable only — deleting it drops stored SQL that nothing else
   *  holds. An active or conflicted variable is inferred from the panel queries,
   *  so there is nothing about it a tree row could delete. */
  deletable: boolean;
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
  /** The keyboard-reachable equivalent of every gesture this row offers. EMPTY
   *  for a variable row: #447 forbids the `…` menu there, and a variable row has
   *  no double/Shift gesture for it to expose — its single activation (open the
   *  option-SQL editor) is already reachable with Enter. */
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
export const UNTITLED_PANEL = 'Untitled panel';
const MISSING_QUERY_DIAGNOSTIC = 'This panel\'s query is not in this workspace, so it cannot be opened.';
/** The word a warning-severity variable row shows next to its name. Rendered as
 *  TEXT, not only as a colour or an icon. */
export const UNUSED_VARIABLE_STATUS = 'unused';

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

/** One panel's resolved facts, computed once and used for the label, the search
 *  haystack, the invalid annotation and the action set alike. */
interface MemberFacts {
  label: string;
  haystack: readonly string[];
  /** A panel's only failure mode: its query is not in this workspace. */
  invalid: 'unresolved-query' | null;
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

/** One tile plus its resolved facts — computed once per paint and shared by the
 *  panel rows and the variable inference (which labels its conflict diagnostic
 *  with the very same panel labels this tree displays). */
interface TileEntry {
  tile: TreeTile;
  facts: MemberFacts;
}

const queryMap = (workspace: TreeWorkspace | null): ReadonlyMap<string, TreeQuery> => {
  const queries = new Map<string, TreeQuery>();
  for (const query of workspace?.queries ?? []) queries.set(query.id, query);
  return queries;
};

const tileEntriesOf = (
  dashboard: TreeDashboard, queries: ReadonlyMap<string, TreeQuery>,
): TileEntry[] => (dashboard.tiles ?? []).map((tile) => ({ tile, facts: tileFacts(tile, queries) }));

/**
 * #447 — one Dashboard's variables, in the canonical inference order that IS the
 * Variables subtree's row order. The ONE place the tree layer builds an
 * `inferDashboardVariables` input, so the rows and the per-variable editor can
 * never disagree about what a Dashboard's variables are.
 */
function variablesFor(
  dashboard: TreeDashboard, tileEntries: readonly TileEntry[], allQueries: readonly TreeQuery[],
): DashboardVariable[] {
  const tileLabels: Record<string, string> = {};
  const declaringTiles: { id: string; queryId: string }[] = [];
  for (const { tile } of tileEntries) {
    // A tile with no query declares nothing. A tile whose query is MISSING from
    // this workspace is still passed in: the id is what inference looks the SQL
    // up by, and an unresolvable id simply contributes no declarations.
    if (typeof tile.queryId === 'string') declaringTiles.push({ id: tile.id, queryId: tile.queryId });
  }
  for (const { tile, facts } of tileEntries) tileLabels[tile.id] = facts.label;
  return inferDashboardVariables({
    tiles: declaringTiles,
    queries: allQueries,
    variableConfigs: dashboard.variableConfigs ?? undefined,
    tileLabels,
  });
}

/**
 * One Dashboard's variables, resolved straight from the committed aggregate — the
 * resolver behind opening a variable's option-SQL tab (#457, `ui/app.ts`), which
 * is handed only a Dashboard id and a NAME and must agree exactly with the row
 * the user clicked. An unknown Dashboard id resolves to no variables at all rather
 * than throwing; with a duplicated id (which a write path refuses outright) the
 * FIRST entry answers, matching the row order this tree paints.
 */
export function dashboardVariables(
  workspace: TreeWorkspace | null, dashboardId: string,
): DashboardVariable[] {
  if (workspace === null) return [];
  const dashboard = (workspace.dashboards ?? []).find((entry) => entry.id === dashboardId);
  if (dashboard === undefined) return [];
  return variablesFor(dashboard, tileEntriesOf(dashboard, queryMap(workspace)), workspace.queries ?? []);
}

/** One variable's row annotation. Derived ONLY from the status the pure
 *  inference already decided — this never re-classifies a variable. */
const variableAnnotation = (
  variable: DashboardVariable,
): { invalid: DashboardTreeInvalid; severity: DashboardTreeSeverity } => {
  if (variable.status === 'conflicted') return { invalid: 'variable-conflict', severity: 'error' };
  if (variable.status === 'orphaned') return { invalid: 'variable-unused', severity: 'warning' };
  return { invalid: null, severity: null };
};

/** A panel row's action vocabulary. #447 removed the filter half: a variable row
 *  has no menu at all. */
const PANEL_MENU_LABELS = {
  open: 'Open query',
  view: 'Open Dashboard in View and focus panel',
  edit: 'Open Dashboard in Edit and focus panel',
};

export function deriveDashboardTree(
  { workspace, surface, ui }: DashboardTreeInput,
): DashboardTree {
  const dashboards = workspace?.dashboards ?? [];
  const queries = queryMap(workspace);

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

    const tiles = dashboard.tiles ?? [];
    const tileEntries = tileEntriesOf(dashboard, queries);
    // #447: the variable rows come from the pure inference service, over THIS
    // Dashboard's panel-owned queries plus its stored option SQL.
    const variables = variablesFor(dashboard, tileEntries, workspace?.queries ?? []);
    // Name, every displayed type, AND the stored option SQL — #447 asks for all
    // three "where practical", and all three are in hand here.
    const variableEntries = variables.map((variable) => ({
      variable,
      haystack: [variable.name, ...variable.types, variable.sql ?? ''],
    }));

    // A direct Dashboard match shows its COMPLETE hierarchy for context (#426
    // permits this); otherwise only the members that matched are shown.
    const showAll = search === '' || dashboardMatched;
    const shownVariables = showAll ? variableEntries : variableEntries.filter((e) => hits(e.haystack));
    const shownTiles = showAll ? tileEntries : tileEntries.filter((e) => hits(e.facts.haystack));

    if (search !== '' && !dashboardMatched && shownVariables.length === 0 && shownTiles.length === 0) continue;

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
      // Variables are Dashboard-level controls and are deliberately NOT counted
      // here — this is the PANEL count.
      meta: String(tiles.length),
      expandable: true,
      expanded: dashboardExpanded,
      toggleable: !dashboardForced,
      matched: dashboardMatched,
      current: isCurrentDashboard,
      invalid: null,
      severity: null,
      diagnostic: null,
      deletable: false,
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

    const groupKeyFor = (group: DashboardTreeGroup): string => dashboardKey + ':group:' + group;
    const isCurrentMember = (member: DashboardFocusTarget): boolean =>
      isCurrentDashboard && currentMember !== null
      && currentMember.kind === member.kind && currentMember.id === member.id;

    // #447 — one VARIABLE row. No `…` menu (the issue forbids it), no double or
    // Shift gesture, and a trailing trash affordance for an orphan only.
    const variableRows = shownVariables.map(({ variable, haystack }): DashboardTreeRow => {
      const member: DashboardFocusTarget = { kind: 'variable', id: variable.name };
      const { invalid, severity } = variableAnnotation(variable);
      return {
        key: dashboardKey + ':variable:' + encodeKeyPart(variable.name),
        kind: 'variable',
        level: 3,
        parentKey: groupKeyFor('variables'),
        // The NAME is the label: it is the variable's whole identity, and it is
        // what the `{name:Type}` placeholders in the panel SQL say.
        label: variable.name,
        count: null,
        // One type when active, every disagreeing type when conflicted, the
        // stored `lastKnownType` for an orphan that has one — and nothing at all
        // for an orphan that does not, rather than an invented type.
        meta: variable.types.join(' | '),
        expandable: false,
        expanded: false,
        toggleable: false,
        matched: search !== '' && hits(haystack),
        current: isCurrentMember(member),
        invalid,
        severity,
        // Verbatim from the inference service — never re-composed here.
        diagnostic: variable.diagnostic,
        deletable: variable.status === 'orphaned',
        dashboardId: dashboard.id,
        member,
        queryId: null,
        group: 'variables',
        single: { kind: 'open-variable', dashboardId: dashboard.id, name: variable.name },
        double: null,
        shift: null,
        menu: [],
      };
    });

    const panelRows = shownTiles.map(({ tile, facts }): DashboardTreeRow => {
      const member: DashboardFocusTarget = { kind: 'tile', id: tile.id };
      // One query can back several panels, so this is one row PER TILE — never
      // merged by query id or label.
      const openQuery: DashboardTreeCommand | null = facts.queryId === null
        ? null
        : { kind: 'open-query', queryId: facts.queryId };
      const focusView = openDashboardCommand(dashboard.id, 'view', member);
      const focusEdit = openDashboardCommand(dashboard.id, 'edit', member);
      return {
        key: dashboardKey + ':tile:' + encodeKeyPart(tile.id),
        kind: 'panel',
        level: 3,
        parentKey: groupKeyFor('panels'),
        label: facts.label,
        count: null,
        meta: '',
        expandable: false,
        expanded: false,
        toggleable: false,
        matched: search !== '' && hits(facts.haystack),
        current: isCurrentMember(member),
        invalid: facts.invalid,
        severity: facts.invalid === null ? null : 'error',
        diagnostic: facts.invalid === null ? null : MISSING_QUERY_DIAGNOSTIC,
        deletable: false,
        dashboardId: dashboard.id,
        member,
        queryId: facts.queryId,
        group: 'panels',
        // Only the query-open action is withheld: Dashboard View/Edit focus
        // navigation stays available so a broken panel's diagnostics remain
        // reachable.
        single: openQuery,
        double: focusView,
        shift: focusEdit,
        menu: [
          { label: PANEL_MENU_LABELS.open, command: openQuery },
          { label: PANEL_MENU_LABELS.view, command: focusView },
          { label: PANEL_MENU_LABELS.edit, command: focusEdit },
        ],
      };
    });

    // Variables ALWAYS precedes Panels, and both group rows stay visible while
    // the Dashboard is expanded — including when empty, because #428 uses them as
    // stable drop targets.
    const groups: readonly { group: DashboardTreeGroup; label: string; total: number; members: readonly DashboardTreeRow[] }[] = [
      // The count is distinct INFERRED names plus orphaned configuration names —
      // which is exactly `variables.length`, because the inference already unions
      // the two. Independent of the search, like the panel count.
      { group: 'variables', label: 'Variables', total: variables.length, members: variableRows },
      { group: 'panels', label: 'Panels', total: tiles.length, members: panelRows },
    ];

    for (const { group, label, total, members } of groups) {
      // A search FORCES a group open only when it actually has a match to reveal;
      // otherwise the user's own expansion still decides. Mirrors `ui/schema.ts`'s
      // second level, whose forcing term is likewise conditional
      // (`tableCascadeForced`) rather than "any search at all" — with an
      // unconditional override, a group with no matches renders a chevron that
      // cannot open (nothing to show) and cannot stay closed once it does match,
      // and clicking it silently writes expansion that only surfaces later, after
      // the search is cleared.
      const groupForced = search !== '' && members.length > 0;
      const groupExpanded = ui.expandedGroups.has(groupStateKey(dashboard.id, group)) || groupForced;
      rows.push({
        key: groupKeyFor(group),
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
        severity: null,
        diagnostic: null,
        deletable: false,
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
      if (groupExpanded) rows.push(...members);
    }
  }

  return {
    rows,
    empty: rows.length > 0 ? null : dashboards.length === 0 ? 'no-dashboards' : 'no-matches',
    dashboardCount: dashboards.length,
  };
}
