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
import { buildQueryOwnershipIndex } from '../dashboard/model/query-ownership.js';
import { queryDashboardRole } from '../dashboard/model/workspace-semantics.js';
import type { DashboardVariable } from '../core/dashboard-variables.js';
import type { LibraryDropTarget } from '../core/library-drag.js';

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
  spec?: { name?: string; description?: string; dashboard?: { role?: string } | null } | null;
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

/**
 * #494 — the trailing DIRECT controls a row offers, replacing the `⋯` overflow
 * menu on Dashboard and Panel rows alike.
 *
 * A row's operations are stated here, fully resolved, for the same reason its
 * commands are: `ui/dashboard-tree.ts` must not re-derive capability from row
 * kind, DOM classes or — worst of all — ownership. Which panel may be edited
 * or deleted is a data-integrity question about the whole workspace, and it is
 * answered exactly once, here.
 */
export type DashboardTreeActionKind =
  | 'edit-dashboard'
  | 'delete-dashboard'
  | 'edit-panel'
  | 'delete-panel'
  /** #447's orphaned-variable trash, now expressed as one of these rather
   *  than as its own `deletable` boolean. */
  | 'delete-variable-config';

/** What an action acts ON, by stable ids only — never a title, a label or a
 *  collection position (#430). A panel action carries the owned query's id as
 *  well as the tile's: both are re-resolved inside the write's transform, and
 *  the pair is what proves the write is aimed at the intended resource. */
export type DashboardTreeActionTarget =
  | { kind: 'dashboard'; dashboardId: string }
  | { kind: 'panel'; dashboardId: string; tileId: string; queryId: string }
  | { kind: 'variable-config'; dashboardId: string; name: string };

export interface DashboardTreeAction {
  kind: DashboardTreeActionKind;
  /** The control's accessible name. Always identifies the target RESOURCE —
   *  a screen-reader user hears the buttons of many rows in sequence, and
   *  "Edit" alone names none of them. */
  label: string;
  /** The pointer tooltip, which may be shorter than the accessible name. */
  tooltip: string;
  /** `null` when the operation belongs to this row's vocabulary but cannot be
   *  performed right now (#494's malformed-ownership rule). The control still
   *  renders — disabled semantically, not merely greyed out — so the row's
   *  vocabulary stays stable and discoverable. */
  target: DashboardTreeActionTarget | null;
  /** Why it is unavailable, for the tooltip and the accessible description.
   *  Non-null exactly when `target` is `null`. */
  unavailable: string | null;
  /**
   * The question a DESTRUCTIVE action asks before it runs; `null` for an
   * editing one, which needs no confirmation.
   *
   * Composed here rather than in the view because it names the resources by
   * their resolved display titles — the panel's label AND its owning
   * Dashboard's — and the view holds only the row it is painting. It is the
   * same reason a row's `diagnostic` is composed by the model.
   */
  confirm: string | null;
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
  /**
   * #494: the row's trailing direct controls, in paint order — edit before
   * delete, so the destructive one is rightmost and never where the pointer
   * lands by habit.
   *
   * This replaced three separate expressions of the same idea: `renamable`
   * (#429 phase 3's Dashboard pencil), `deletable` (#447's orphaned-variable
   * trash) and the `menu` list. A group row has none.
   */
  actions: readonly DashboardTreeAction[];
  dashboardId: string;
  /** The member this row addresses, by Dashboard-local id — never by query id. */
  member: DashboardFocusTarget | null;
  /** The query a primary click would open, when one resolves. */
  queryId: string | null;
  group: DashboardTreeGroup | null;
  /** Primary click. Deferred through the click arbiter exactly when this row also
   *  has a `double` — which, since #429/#472 split the Dashboard row, means a
   *  PANEL row only. Every other row runs its primary press immediately, having
   *  no competing gesture to wait out. */
  single: DashboardTreeCommand | null;
  /** The double-click action, and thereby the view's arbitration switch: a row
   *  with no `double` needs no double-click window. Only a panel row has one — a
   *  Dashboard row's expansion moved to its chevron (#429/#472), so its primary
   *  press can open at once. */
  double: DashboardTreeCommand | null;
  shift: DashboardTreeCommand | null;
  /**
   * #428: what a Library-query drop on THIS row would write, or `null` when the
   * row rejects assignment. Resolved here for the same reason every other
   * structural decision is — the view must not re-derive it. That keeps the whole
   * "Rejected destinations" list one pure, exhaustively-tested rule instead of a
   * pile of `kind`/`group`/`invalid` branches inside the drop handler, which
   * `ui/dashboard-tree.ts` could not hold at its coverage gate.
   *
   * Accepting rows are the Dashboard row, its Panels group (both mean "add a
   * panel to this Dashboard" and persist identically), and an INFERRED variable
   * row. Everything else is `null`: an individual panel row, the Variables group
   * (it does not identify WHICH variable receives the SQL), and an orphaned
   * variable (a configuration no panel declares any more is not a destination,
   * though it stays editable and deletable through its own affordances).
   *
   * A CONFLICTED variable still accepts: it is inferred, it names a real
   * variable, and its type conflict is orthogonal to where option SQL is stored.
   */
  dropTarget: LibraryDropTarget | null;
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

/** The tree row key for one Dashboard tile. Exported — and used by the row
 *  builder below, so the two cannot drift — because #428 has to address the row
 *  it just created without re-deriving the key format by hand. */
export const tileRowKey = (workspaceId: string, dashboardId: string, tileId: string): string =>
  encodeKeyPart(workspaceId) + ':' + encodeKeyPart(dashboardId) + ':tile:' + encodeKeyPart(tileId);

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

/**
 * Why a panel's pencil and trash are rendered but unavailable (#494).
 *
 * Both say what is wrong with the DATA rather than "not allowed": the row is
 * showing a tile whose dedicated query cannot be proven, and the user's next
 * move is to inspect the workspace data, not to try again. #429 deliberately
 * keeps malformed ownership fail-closed rather than guessing a repair — a
 * guessed owner is how one delete becomes two.
 */
const MISSING_PANEL_QUERY_REASON =
  'This panel’s query is not in this workspace, so there is nothing to edit or remove.';
const UNPROVEN_OWNERSHIP_REASON =
  'This panel’s query is shared with another panel, so it cannot be edited or removed here.';
/** Two saved-query documents carry this id (`workspace-duplicate-query-id`).
 *  Which one the pencil would edit has no answer, so neither control is
 *  offered — and the commit paths refuse the same state, which is the point:
 *  a control must not open a dialog only to refuse at the end of it. */
const AMBIGUOUS_QUERY_REASON =
  'Two saved queries in this workspace share this panel’s query id, so it cannot be edited or removed here.';
/** A tile may only reference a PANEL-role query (`dashboard-setup-reference` /
 *  `dashboard-tile-role-incompatible` in the semantic validator). Editing or
 *  deleting through a tile that references, say, a Setup query would silently
 *  repair the workspace by destroying the evidence — fail closed instead. */
const WRONG_ROLE_REASON =
  'This panel references a query that is not a panel query, so it cannot be edited or removed here.';
/** Two Dashboard documents carry this id. Which one a Dashboard-level edit or
 *  delete would act on has no answer — the same "a control must not open a
 *  dialog only to refuse at the end of it" rule `AMBIGUOUS_QUERY_REASON`
 *  states, applied to the Dashboard identity delete already refuses on
 *  (`dashboard-duplicate` in `removeDashboardDocument`/`removeDashboardPanel`). */
const AMBIGUOUS_DASHBOARD_REASON =
  'Two dashboards in this workspace share this id, so it cannot be edited or removed here.';
/** Two tiles in the SAME Dashboard carry this id — even when they reference
 *  different queries. Each would otherwise look, independently, like that
 *  query's sole owner (`ownersOfQuery` cannot tell them apart), so this is
 *  checked ahead of ownership rather than folded into it. */
const AMBIGUOUS_TILE_REASON =
  'Two panels in this dashboard share this id, so it cannot be edited or removed here.';
/** Same ambiguity as `AMBIGUOUS_DASHBOARD_REASON`, worded for the one control
 *  an orphaned-variable row offers — delete only, never edit. Deleting stored
 *  option SQL is addressed by Dashboard id alone (#447), so a duplicated
 *  Dashboard id leaves it exactly as unresolvable as a Dashboard-level delete;
 *  `commitVariableConfig`'s own strict-replacement guard refuses it too. */
const AMBIGUOUS_DASHBOARD_VARIABLE_REASON =
  'Two dashboards in this workspace share this id, so this stored option SQL cannot be removed here.';

/** One trailing control, available. */
const action = (
  kind: DashboardTreeActionKind, label: string, tooltip: string,
  target: DashboardTreeActionTarget, confirm: string | null = null,
): DashboardTreeAction => ({ kind, label, tooltip, target, unavailable: null, confirm });

/** One trailing control the data does not permit right now. It still renders:
 *  a row whose vocabulary silently shrinks teaches the user that panels
 *  sometimes have no pencil, which is a worse lie than a disabled one. */
const unavailableAction = (
  kind: DashboardTreeActionKind, label: string, reason: string,
): DashboardTreeAction => ({
  kind, label, tooltip: reason, target: null, unavailable: reason, confirm: null,
});

/** Quoted for a confirmation sentence, in the typographic quotes this UI uses
 *  everywhere else. */
const quoted = (name: string): string => '“' + name + '”';

export function deriveDashboardTree(
  { workspace, surface, ui }: DashboardTreeInput,
): DashboardTree {
  const dashboards = workspace?.dashboards ?? [];
  const queries = queryMap(workspace);
  // #494: ONE ownership index per paint, from the #427 module that defines the
  // rule — the tree does not get its own private notion of who owns a query.
  // Tiles with no `queryId` are dropped on the way in because ownership is
  // exactly the set of tile→query references; a tile that references nothing
  // owns nothing, and its panel row's edit/delete are unavailable anyway.
  // How many DOCUMENTS carry each id — not the same question as how many
  // owners reference it. `queryMap` above collapses duplicates (last wins), so
  // the availability rule below cannot read cardinality off it.
  const documentsById = new Map<string, number>();
  for (const query of workspace?.queries ?? []) {
    documentsById.set(query.id, (documentsById.get(query.id) ?? 0) + 1);
  }
  // How many Dashboard DOCUMENTS carry each Dashboard id — the same shape of
  // count as `documentsById` above, one level up. `deleteDashboardDocument`/
  // `removeDashboardPanel` already refuse a duplicated Dashboard id
  // (`dashboard-duplicate`); this is what lets the row's own pencil/trash
  // agree ahead of a commit rather than opening a dialog that then refuses.
  const dashboardIdCounts = new Map<string, number>();
  for (const dashboard of dashboards) {
    dashboardIdCounts.set(dashboard.id, (dashboardIdCounts.get(dashboard.id) ?? 0) + 1);
  }
  // Which OCCURRENCE of a duplicated Dashboard id this is, in document order —
  // 0 for the first, 1 for the second, and so on. Availability only needs the
  // COUNT above; this is what lets two rows sharing a duplicated id still get
  // two DISTINCT presentation keys below, so the roving tabindex, `data-key`
  // focus restoration and drag-highlight lookups (all keyed on `row.key`) each
  // resolve to exactly one row instead of silently picking whichever matching
  // node happens to be first in the DOM.
  const dashboardOccurrenceSeen = new Map<string, number>();
  const ownership = buildQueryOwnershipIndex({
    queries: workspace?.queries ?? [],
    dashboards: dashboards.map((dashboard) => ({
      id: dashboard.id,
      tiles: (dashboard.tiles ?? [])
        .filter((tile): tile is TreeTile & { queryId: string } => typeof tile.queryId === 'string')
        .map((tile) => ({ id: tile.id, queryId: tile.queryId })),
    })),
  });

  /**
   * The pencil + trash a panel row offers, and whether the data permits them.
   *
   * Availability is the #427 exactly-one-owner rule, checked against THIS
   * Dashboard and THIS tile: a query with several owners, one owned by a
   * different member, or a reference to a query the workspace does not carry
   * all leave both controls rendered and unavailable. `facts.queryId` is
   * already `null` for a reference that resolves to nothing, which is what
   * separates the two reasons.
   */
  const panelActions = (
    dashboardId: string, dashboardLabel: string, tileId: string, label: string, queryId: string | null,
    identityReason: string | null,
  ): DashboardTreeAction[] => {
    // Checked BEFORE ownership, not folded into it: a duplicated Dashboard or
    // Dashboard-local tile id is ambiguous on its own terms, and the #427
    // ownership index — keyed by query id — cannot see it. Two tiles sharing
    // an id but referencing different queries each look, independently, like
    // that query's sole owner; this is what keeps the model agreeing with
    // `removeDashboardPanel`'s own `dashboard-duplicate`/`tile-duplicate`
    // refusals instead of offering a pencil delete already refuses.
    if (identityReason !== null) {
      return [
        unavailableAction('edit-panel', 'Edit ' + label, identityReason),
        unavailableAction('delete-panel', 'Remove ' + label + ' from dashboard', identityReason),
      ];
    }
    const owners = queryId === null ? [] : ownership.ownersByQueryId.get(queryId) ?? [];
    const owned = owners.length === 1
      && owners[0].dashboardId === dashboardId && owners[0].tileId === tileId;
    const rightRole = queryId !== null && queryDashboardRole(queries.get(queryId)) === 'panel';
    const unique = queryId !== null && documentsById.get(queryId) === 1;
    if (queryId === null || !owned || !unique || !rightRole) {
      const reason = queryId === null
        ? MISSING_PANEL_QUERY_REASON
        : (!owned ? UNPROVEN_OWNERSHIP_REASON
          : (!unique ? AMBIGUOUS_QUERY_REASON : WRONG_ROLE_REASON));
      return [
        unavailableAction('edit-panel', 'Edit ' + label, reason),
        unavailableAction('delete-panel', 'Remove ' + label + ' from dashboard', reason),
      ];
    }
    const target: DashboardTreeActionTarget = { kind: 'panel', dashboardId, tileId, queryId };
    return [
      action('edit-panel', 'Edit ' + label, 'Edit name & description', target),
      action('delete-panel', 'Remove ' + label + ' from dashboard', 'Remove panel', target,
        'Remove panel ' + quoted(label) + ' from ' + quoted(dashboardLabel)
        + '? This also deletes its dedicated query copy.'),
    ];
  };

  const search = ui.searchText.trim().toLowerCase();
  const hits = (haystack: readonly string[]): boolean =>
    haystack.some((text) => text.toLowerCase().includes(search));

  const selectedId = surface.kind === 'dashboard' ? surface.dashboardId : null;
  const currentMember = surface.kind === 'dashboard' ? surface.currentMember : null;
  const workspaceId = workspace?.id ?? '';

  const rows: DashboardTreeRow[] = [];

  for (const dashboard of dashboards) {
    const dashboardIdDuplicated = (dashboardIdCounts.get(dashboard.id) ?? 0) > 1;
    const dashboardOccurrenceIndex = dashboardOccurrenceSeen.get(dashboard.id) ?? 0;
    dashboardOccurrenceSeen.set(dashboard.id, dashboardOccurrenceIndex + 1);
    // The PRESENTATION key, distinct from the (still ambiguous) mutation
    // target below: when the id is duplicated, every row this Dashboard emits
    // — this one and, through `groupKeyFor`/the variable and panel keys built
    // from it, every descendant — carries a `:dup:<occurrence>` suffix so the
    // two Dashboards' subtrees never collide on `row.key`/`data-key`, even
    // though `dashboardId: dashboard.id` (what `edit-dashboard`'s target and
    // `dropTarget` would name, were either not already unavailable/null below)
    // still names the SAME ambiguous id.
    const dashboardKey = encodeKeyPart(workspaceId) + ':' + encodeKeyPart(dashboard.id)
      + (dashboardIdDuplicated ? ':dup:' + dashboardOccurrenceIndex : '');
    const title = trimmed(dashboard.title);
    const description = trimmed(dashboard.description);
    const dashboardMatched = search !== '' && hits([title, description]);

    const tiles = dashboard.tiles ?? [];
    // Dashboard-LOCAL tile-id cardinality: two tiles of the SAME Dashboard
    // sharing an id, never a count across Dashboards — a tile id is only ever
    // addressed together with its owning Dashboard id (#430).
    const tileIdCounts = new Map<string, number>();
    for (const tile of tiles) {
      tileIdCounts.set(tile.id, (tileIdCounts.get(tile.id) ?? 0) + 1);
    }
    // Same occurrence-tracking as `dashboardOccurrenceSeen`, scoped to THIS
    // Dashboard's own tiles — reset every iteration, since a tile id is only
    // ever compared against siblings of the same Dashboard.
    const tileOccurrenceSeen = new Map<string, number>();
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
      // #494: the Dashboard row's own two direct controls. Its `⋯` menu is
      // gone — *Open in Edit* was its last item, and a menu button that opens
      // a one-item menu beside two real controls is chrome, not vocabulary.
      // Shift-click / Shift+Enter remain the Edit gesture (`shift` below).
      //
      // A duplicated Dashboard id leaves both unavailable: `findDashboardStrict`
      // already refuses `dashboard-duplicate` for both removal paths, and a
      // rename has no less ambiguous a target — offering a pencil that a
      // commit would only refuse is the exact bug this closes.
      actions: dashboardIdDuplicated
        ? [
          unavailableAction('edit-dashboard', 'Edit dashboard ' + (title || UNTITLED_DASHBOARD),
            AMBIGUOUS_DASHBOARD_REASON),
          unavailableAction('delete-dashboard', 'Delete dashboard ' + (title || UNTITLED_DASHBOARD),
            AMBIGUOUS_DASHBOARD_REASON),
        ]
        : [
          action('edit-dashboard', 'Edit dashboard ' + (title || UNTITLED_DASHBOARD),
            'Edit dashboard title & description', { kind: 'dashboard', dashboardId: dashboard.id }),
          action('delete-dashboard', 'Delete dashboard ' + (title || UNTITLED_DASHBOARD),
            'Delete dashboard', { kind: 'dashboard', dashboardId: dashboard.id },
            'Delete dashboard ' + quoted(title || UNTITLED_DASHBOARD)
            + '? This also deletes every query its panels own.'),
        ],
      dashboardId: dashboard.id,
      member: null,
      queryId: null,
      group: null,
      // #429/#472 — the Dashboard row's THREE independent targets. The primary
      // press now OPENS (it used to expand, deferred through the double-click
      // window); expansion moved to the chevron alone, which is why there is no
      // `double` action left to arbitrate against. Unconditional, unlike the
      // toggle it replaced: a row a search is holding open cannot change its
      // expansion (`toggleable`), but it can always be opened.
      single: openDashboardCommand(dashboard.id, 'view'),
      double: null,
      shift: openDashboardCommand(dashboard.id, 'edit'),
      // A duplicated Dashboard id cannot be a drop destination either: an
      // assignment drop resolves its target by `dashboardId` alone, and
      // `dashboardId` alone has two answers here — the same ambiguity that
      // already withholds this row's own pencil/trash above.
      dropTarget: dashboardIdDuplicated ? null : { kind: 'panel', dashboardId: dashboard.id },
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
        // #447's trash, unchanged in behaviour: an ORPHANED configuration is
        // the only variable state with anything of its own to delete — an
        // active or conflicted variable is inferred from the panel SQL.
        //
        // A duplicated Dashboard id leaves it unavailable too: the delete is
        // addressed by `dashboardId` alone, `commitVariableConfig`'s own
        // strict-replacement guard refuses an ambiguous one exactly the way
        // the Dashboard row's own delete does, and offering a trash the
        // commit would only silently no-op is the same bug being closed
        // everywhere else on this row.
        actions: variable.status === 'orphaned'
          ? [dashboardIdDuplicated
            ? unavailableAction('delete-variable-config',
              'Delete the stored option SQL for ' + variable.name, AMBIGUOUS_DASHBOARD_VARIABLE_REASON)
            : action('delete-variable-config',
              'Delete the stored option SQL for ' + variable.name, 'Delete stored option SQL',
              { kind: 'variable-config', dashboardId: dashboard.id, name: variable.name },
              'Delete the stored option SQL for ' + quoted(variable.name) + '? The SQL is lost.')]
          : [],
        dashboardId: dashboard.id,
        member,
        queryId: null,
        group: 'variables',
        single: { kind: 'open-variable', dashboardId: dashboard.id, name: variable.name },
        double: null,
        shift: null,
        // #428: an ORPHAN is not an assignment destination. A configuration no
        // panel declares any more has nothing to bind to, though it stays
        // editable and deletable through its own affordances — which is why this
        // reads the same `status === 'orphaned'` that `deletable` above does.
        // A duplicated Dashboard id is withheld here too — same reasoning as
        // the Dashboard row's own `dropTarget` above.
        dropTarget: (variable.status === 'orphaned' || dashboardIdDuplicated)
          ? null
          : { kind: 'variable', dashboardId: dashboard.id, variableName: variable.name },
      };
    });

    const panelRows = shownTiles.map(({ tile, facts }): DashboardTreeRow => {
      const member: DashboardFocusTarget = { kind: 'tile', id: tile.id };
      const tileIdDuplicated = (tileIdCounts.get(tile.id) ?? 0) > 1;
      const tileOccurrenceIndex = tileOccurrenceSeen.get(tile.id) ?? 0;
      tileOccurrenceSeen.set(tile.id, tileOccurrenceIndex + 1);
      const identityAmbiguous = dashboardIdDuplicated || tileIdDuplicated;
      // One query can back several panels, so this is one row PER TILE — never
      // merged by query id or label.
      const openQuery: DashboardTreeCommand | null = facts.queryId === null
        ? null
        : { kind: 'open-query', queryId: facts.queryId };
      const focusView = openDashboardCommand(dashboard.id, 'view', member);
      const focusEdit = openDashboardCommand(dashboard.id, 'edit', member);
      return {
        // Disambiguated the SAME way the Dashboard row's own key is — built
        // from `dashboardKey` (already carrying its own `:dup:` suffix when
        // the DASHBOARD id is duplicated, never the raw `dashboard.id`
        // `tileRowKey` would use) plus this tile's own suffix when the TILE
        // id is duplicated. A duplicated id at either level still needs a
        // UNIQUE `row.key` per row — the roving tabindex, `data-key` focus
        // restoration and drag-highlight lookups downstream all resolve by
        // this key alone, so two rows sharing one would let either mechanism
        // silently pick the wrong (first-in-DOM) row. Equal to
        // `tileRowKey(workspaceId, dashboard.id, tile.id)` whenever neither is
        // duplicated, since `dashboardKey` itself is then unsuffixed.
        key: dashboardKey + ':tile:' + encodeKeyPart(tile.id)
          + (tileIdDuplicated ? ':dup:' + tileOccurrenceIndex : ''),
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
        actions: panelActions(dashboard.id, title || UNTITLED_DASHBOARD, tile.id, facts.label, facts.queryId,
          dashboardIdDuplicated ? AMBIGUOUS_DASHBOARD_REASON
            : (tileIdDuplicated ? AMBIGUOUS_TILE_REASON : null)),
        dashboardId: dashboard.id,
        member,
        queryId: facts.queryId,
        group: 'panels',
        // Only the query-open action stays available under identity ambiguity
        // (it is addressed by `queryId` alone, which is unaffected): View/Edit
        // focus navigation is withheld instead, because both are addressed by
        // `dashboard.id` + `member.id` — the Dashboard viewer's own tile-focus
        // lookup is keyed by tile id alone, so an ambiguous pair could resolve
        // (or highlight) a DIFFERENT tile than the one the row names.
        single: openQuery,
        double: identityAmbiguous ? null : focusView,
        shift: identityAmbiguous ? null : focusEdit,
        // #428 rejects an individual panel row: sharing one query between panels
        // and moving members between Dashboards are both out of scope, so there
        // is no assignment a panel row could mean.
        dropTarget: null,
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
        actions: [],
        dashboardId: dashboard.id,
        member: null,
        queryId: null,
        group,
        // A group row has no double or Shift action, so its expansion needs no
        // arbitration and the view toggles it immediately.
        single: groupForced ? null : { kind: 'toggle' },
        double: null,
        shift: null,
        // #428: Panels means the same thing as the Dashboard row itself —
        // including its own ambiguous-id rejection when `dashboardId` alone
        // has two answers. The VARIABLES group never accepts — it does not
        // identify which variable would receive the SQL, and guessing is
        // worse than rejecting.
        dropTarget: (group === 'panels' && !dashboardIdDuplicated)
          ? { kind: 'panel', dashboardId: dashboard.id } : null,
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
