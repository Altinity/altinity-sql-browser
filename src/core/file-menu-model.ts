// The ONE File-menu model (#452): which rows the application's single File menu
// carries, in which order, and which of them the current work surface allows.
//
// #452 replaced two divergent File menus — the Workbench's workspace/Library one
// and the Dashboard page's import/export one — with a single control rendered on
// every surface. The rule that makes that unification meaningful lives here:
// **context changes ENABLED STATE only**. Every row is always present, always in
// the same position, whatever the surface. A caller cannot express "hide this
// row", because there is no such thing to express.
//
// #463 keeps that rule and drops the assumption underneath it: the Dashboard
// rows no longer require one exact Dashboard to be on screen. New/Import act on
// the WORKSPACE (create one, append one), and Export resolves an exact target
// from the workspace's own Dashboard ids — preferring the one on screen, asking
// for a chooser only when it genuinely cannot name one.
//
// Pure by construction: primitives in, row descriptors out. No DOM, no `app`, no
// workspace aggregate — `ui/file-menu.ts` projects these descriptors into
// `MenuRow`s (icons, click handlers) and `ui/app-header.ts`/`ui/dashboard.ts`
// supply the surface context. It deliberately declares its own `FileMenuMode`
// literal rather than importing `DashboardSurfaceMode` from
// `application/main-surface.ts`: that module reaches into `src/workspace/`, and
// `src/core/` must never depend on the workspace layer (build/check-boundaries.mjs).

/** A Dashboard surface presents the same live document in one of two modes;
 *  `view` is a presentation choice, not an authorization boundary (ADR-0003). */
export type FileMenuMode = 'view' | 'edit';

/**
 * What the surface currently on screen actually rendered — supplied by the
 * renderer, never re-derived from the route or from session state.
 *
 * `dashboardId` is the EXACT document the Dashboard surface resolved, and it is
 * `null` for the placeholder states (an empty collection, or a selection that no
 * longer resolves). It must come from the resolved document's own id: the render
 * target's requested id and the route can legitimately disagree, and a Dashboard
 * that is visibly on screen must never report "no dashboard".
 */
export type FileMenuSurface =
  | { readonly surface: 'query' }
  | {
    readonly surface: 'dashboard';
    readonly mode: FileMenuMode;
    readonly dashboardId: string | null;
  };

/** Everything the availability rules read. The counts are live (recomputed each
 *  time the menu opens), the surface is fixed when the header is built. */
export interface FileMenuContext {
  readonly surface: FileMenuSurface;
  /** An active workspace aggregate resolves. NOT "an aggregate is cached": the
   *  legacy/no-aggregate path still exports and imports through the
   *  `state`-derived fallback, so treating a null cache as "no workspace" would
   *  disable operations that work today. */
  readonly hasWorkspace: boolean;
  /** The zero-owner LIBRARY projection's size — never `workspace.queries.length`,
   *  which double-counts every Dashboard-owned copy (#427). */
  readonly libraryQueryCount: number;
  /**
   * Every Dashboard the workspace holds, in collection order — the IDS, not a
   * count (#463). Export has to resolve an EXACT target from this list, and a
   * bare count cannot name the sole Dashboard of a one-Dashboard workspace
   * without the caller reaching back into the aggregate and re-deciding there.
   * The footer's `<M> dashboards` is this list's length.
   */
  readonly dashboardIds: readonly string[];
}

export type FileMenuActionId =
  | 'new-workspace' | 'new-dashboard'
  | 'import-workspace' | 'import-queries' | 'import-dashboard'
  | 'export-workspace' | 'export-dashboard'
  | 'download-md' | 'download-sql';

export interface FileMenuItemSpec {
  readonly id: FileMenuActionId;
  readonly label: string;
  /** The file extension this row produces, or `null`. Kept independent of
   *  `reason` so a disabled row's extension does not have to be sacrificed to
   *  show why it is unavailable. */
  readonly meta: string | null;
  readonly enabled: boolean;
  /** Why the row is unavailable — `null` exactly when `enabled`. Rendered as its
   *  own `.fm-reason` span, and announced alongside the label. */
  readonly reason: string | null;
  /** A divider precedes this row. Part of the model so the ONE ordering
   *  authority also owns the grouping. */
  readonly separatorBefore: boolean;
}

/**
 * Which Dashboard an Export Dashboard action reads (#463).
 *
 * `exact` is the only thing that can be exported — the id is resolved HERE, by
 * the same rule that enabled the row, so no call site can re-decide it and land
 * on `dashboards[0]`. `choose` is not a target: it is this model saying it
 * cannot name one, and the UI owes the user a chooser before anything is read.
 *
 * There is no import analogue any more. #463 makes Import dashboard purely
 * ADDITIVE — it appends a new Dashboard to the workspace and can therefore never
 * name, replace or merge into an existing one.
 */
export type DashboardExportTarget =
  | { readonly kind: 'exact'; readonly dashboardId: string }
  | { readonly kind: 'choose' };

export interface FileMenuModel {
  /** All nine rows, always, in the settled order. */
  readonly items: readonly FileMenuItemSpec[];
  readonly footer: string;
  /** Non-null exactly when the `export-dashboard` row is enabled. */
  readonly exportDashboardTarget: DashboardExportTarget | null;
}

// Disabled reasons. One spelling each, so the same unavailability never
// reaches the user under two different words.
const NO_WORKSPACE = 'No workspace';
const EDIT_ONLY = 'Edit mode only';
const NO_DASHBOARDS = 'No dashboards';
const NO_LIBRARY_QUERIES = 'No Library queries';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** `reason === null` means enabled — the two fields can never disagree because
 *  only this helper builds a row. */
function row(
  id: FileMenuActionId, label: string, meta: string | null,
  reason: string | null, separatorBefore = false,
): FileMenuItemSpec {
  return { id, label, meta, enabled: reason === null, reason, separatorBefore };
}

/**
 * The Dashboard the surface has on screen, but ONLY when the workspace really
 * holds exactly that one — the same exactly-one-match rule
 * `workspace-dashboards.ts` enforces on the write side, applied here to ids
 * alone. A selection that no longer resolves, or that resolves ambiguously
 * against a duplicate-id workspace, is not an export target and must fall
 * through to the chooser rather than be guessed at.
 */
function openDashboardId(ctx: FileMenuContext): string | null {
  const { surface } = ctx;
  if (surface.surface === 'query' || surface.dashboardId === null) return null;
  const id = surface.dashboardId;
  return ctx.dashboardIds.filter((candidate) => candidate === id).length === 1 ? id : null;
}

/**
 * Which Dashboard Export reads, or `null` when the row is disabled (#463).
 *
 * Export is now WORKSPACE-aware rather than surface-gated: the Query surface can
 * export too, because a workspace's Dashboards exist whether or not one is
 * currently on screen. The surface only contributes a preference:
 *
 *   - the Dashboard on screen wins, so exporting from a Dashboard is one click
 *     and always exports the one you are looking at;
 *   - otherwise a single-Dashboard workspace has exactly one answer;
 *   - otherwise the model refuses to pick and asks for a chooser.
 *
 * No branch here can reach for `dashboardIds[0]`: the one-Dashboard case is the
 * whole list, not its head.
 */
function exportDashboardTargetOf(ctx: FileMenuContext): DashboardExportTarget | null {
  if (ctx.dashboardIds.length === 0) return null;
  const open = openDashboardId(ctx);
  if (open !== null) return { kind: 'exact', dashboardId: open };
  if (ctx.dashboardIds.length === 1) return { kind: 'exact', dashboardId: ctx.dashboardIds[0] };
  return { kind: 'choose' };
}

/** The shortest id tail a chooser is willing to show. Long enough to read as an
 *  identifier rather than noise; `shortIdFragments` grows it when it has to. */
const MIN_ID_FRAGMENT = 6;

/**
 * A distinguishing tail per id: the SHORTEST suffix length at which every listed
 * id is unique, falling back to the whole id when no suffix separates them.
 *
 * A Dashboard chooser lists titles, and duplicate titles are legitimate —
 * identity is the id — so each row needs a tiebreaker. A fixed-width tail is not
 * one: `sales-abcdef` and `ops-abcdef` share their last six characters, and two
 * rows that agree on title, tile count and fragment are indistinguishable to the
 * user picking between them. Growing the tail until the set is unique keeps the
 * short, readable case short without ever rendering two identical rows.
 *
 * Genuinely duplicate ids (the ambiguous-workspace case) return the full id and
 * still match — nothing can separate them, and the id-addressed reader fails
 * closed on that workspace anyway.
 */
export function shortIdFragments(ids: readonly string[]): string[] {
  const longest = Math.max(0, ...ids.map((id) => id.length));
  for (let length = MIN_ID_FRAGMENT; length < longest; length += 1) {
    const fragments = ids.map((id) => id.slice(-length));
    if (new Set(fragments).size === ids.length) return fragments;
  }
  return [...ids];
}

/** The footer line: both counts, always, grammatical at every value. Zero is
 *  reported normally rather than collapsing the row into an "empty" message —
 *  the structure must not change with the data. */
export function fileMenuFooter(ctx: FileMenuContext): string {
  return `${plural(ctx.libraryQueryCount, 'Library query', 'Library queries')}`
    + ` · ${plural(ctx.dashboardIds.length, 'dashboard', 'dashboards')}`;
}

/** The whole menu for one context: the nine rows in their settled order, the
 *  footer, and the Export target. The target rides along with the rows so
 *  "this row is enabled" and "here is what it acts on" are decided ONCE, by the
 *  same rule, and cannot drift apart at the call site. */
export function fileMenuModel(ctx: FileMenuContext): FileMenuModel {
  const dashboardSurface = ctx.surface.surface === 'dashboard' ? ctx.surface : null;
  const readOnly = dashboardSurface?.mode === 'view';
  const noLibrary = ctx.libraryQueryCount === 0 ? NO_LIBRARY_QUERIES : null;
  const noWorkspace = ctx.hasWorkspace ? null : NO_WORKSPACE;
  const exportTarget = exportDashboardTargetOf(ctx);

  return {
    items: [
      // #463 groups the rows by VERB — create, import, export, download — rather
      // than by the resource each one happens to touch. #452's single unlabeled
      // block put "Export workspace…" between the two imports, so the menu read
      // as an arbitrary list; the dividers here are the section headings #452
      // deliberately removed, expressed as grouping instead of as words.
      row('new-workspace', 'New workspace…', null, null),
      // Sentence case throughout (#463): the old "Import Dashboard…" capital
      // read as a proper noun beside "Import queries…".
      row('new-dashboard', 'New dashboard…', null, noWorkspace),
      row('import-workspace', 'Import workspace…', null, null, true),
      row('import-queries', 'Import queries…', null, readOnly ? EDIT_ONLY : null),
      // #463: additive, so it needs a workspace to add TO and nothing else. It
      // no longer asks which surface you are on or which Dashboard is open —
      // there is no longer anything for it to overwrite.
      row('import-dashboard', 'Import dashboard…', null, noWorkspace),
      row('export-workspace', 'Export workspace…', '.json', noWorkspace, true),
      // #463: gated on the WORKSPACE holding a Dashboard, not on one being on
      // screen. `exportDashboardTargetOf` and this reason read the same list, so
      // "enabled" and "has a target" cannot disagree.
      row('export-dashboard', 'Export dashboard…', '.json', exportTarget === null ? NO_DASHBOARDS : null),
      // #452 renames the two downloads so their LIBRARY scope is explicit — the
      // old "Download Markdown" reads as "download this dashboard" once the same
      // menu opens over a Dashboard.
      row('download-md', 'Download Library as Markdown', '.md', noLibrary, true),
      row('download-sql', 'Download Library as SQL', '.sql', noLibrary),
    ],
    footer: fileMenuFooter(ctx),
    exportDashboardTarget: exportTarget,
  };
}
