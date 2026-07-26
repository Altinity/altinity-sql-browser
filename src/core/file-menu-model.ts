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

/** Everything the availability rules read. The two counts are live (recomputed
 *  each time the menu opens), the surface is fixed when the header is built. */
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
  readonly dashboardCount: number;
}

export type FileMenuActionId =
  | 'new-workspace' | 'import-workspace' | 'export-workspace'
  | 'import-queries' | 'import-dashboard' | 'export-dashboard'
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
 * Which Dashboard an Import Dashboard action commits into. Explicit because
 * #452's central defect was Dashboard commands reading the selection internally
 * and silently falling back to the collection's first entry.
 *
 * `create-first` is offered ONLY for a genuinely empty collection. The empty
 * placeholder is also reached when a selection stops resolving against a
 * NON-empty collection, and `create-first` commits through the compatibility
 * slot — which would overwrite entry 0, the exact retarget this issue forbids.
 */
export type DashboardImportTarget =
  | { readonly kind: 'exact'; readonly dashboardId: string }
  | { readonly kind: 'create-first' };

/** Which Dashboard an Export Dashboard action reads. Always exact — there is no
 *  export analogue of `create-first`, so the type makes "export something
 *  unspecified" unrepresentable rather than guarding it at runtime. */
export interface DashboardExportTarget {
  readonly dashboardId: string;
}

export interface FileMenuModel {
  /** All eight rows, always, in the settled order. */
  readonly items: readonly FileMenuItemSpec[];
  readonly footer: string;
  /** Non-null exactly when the `import-dashboard` row is enabled. */
  readonly importDashboardTarget: DashboardImportTarget | null;
  /** Non-null exactly when the `export-dashboard` row is enabled. */
  readonly exportDashboardTarget: DashboardExportTarget | null;
}

// Disabled reasons. One spelling each, so the same unavailability never
// reaches the user under two different words.
const NO_WORKSPACE = 'No workspace';
const EDIT_ONLY = 'Edit mode only';
const OPEN_A_DASHBOARD = 'Open a dashboard';
const NO_DASHBOARD = 'No dashboard';
const DASHBOARD_UNAVAILABLE = 'Dashboard unavailable';
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

/** Why Import Dashboard is unavailable, or `null` when it is available.
 *  Ordered most-specific-surface-first: the surface you are on explains the
 *  unavailability better than the workspace state behind it. */
function importDashboardReason(ctx: FileMenuContext): string | null {
  const { surface } = ctx;
  if (surface.surface === 'query') return OPEN_A_DASHBOARD;
  if (surface.mode === 'view') return EDIT_ONLY;
  if (!ctx.hasWorkspace) return NO_WORKSPACE;
  if (surface.dashboardId !== null) return null;
  // The placeholder: importable only when there is genuinely nothing to
  // overwrite. See `DashboardImportTarget`.
  return ctx.dashboardCount === 0 ? null : DASHBOARD_UNAVAILABLE;
}

/** Why Export Dashboard is unavailable, or `null`. Export is safe in BOTH modes
 *  — it reads — so `view` is not a reason here. */
function exportDashboardReason(ctx: FileMenuContext): string | null {
  const { surface } = ctx;
  if (surface.surface === 'query') return OPEN_A_DASHBOARD;
  return surface.dashboardId === null ? NO_DASHBOARD : null;
}

function importDashboardTargetOf(ctx: FileMenuContext): DashboardImportTarget | null {
  if (importDashboardReason(ctx) !== null) return null;
  // Narrowed by the reason check above: `query` already returned a reason.
  const surface = ctx.surface as Extract<FileMenuSurface, { surface: 'dashboard' }>;
  return surface.dashboardId === null
    ? { kind: 'create-first' }
    : { kind: 'exact', dashboardId: surface.dashboardId };
}

function exportDashboardTargetOf(ctx: FileMenuContext): DashboardExportTarget | null {
  if (exportDashboardReason(ctx) !== null) return null;
  const surface = ctx.surface as Extract<FileMenuSurface, { surface: 'dashboard' }>;
  return { dashboardId: surface.dashboardId as string };
}

/** The footer line: both counts, always, grammatical at every value. Zero is
 *  reported normally rather than collapsing the row into an "empty" message —
 *  the structure must not change with the data. */
export function fileMenuFooter(ctx: FileMenuContext): string {
  return `${plural(ctx.libraryQueryCount, 'Library query', 'Library queries')}`
    + ` · ${plural(ctx.dashboardCount, 'dashboard', 'dashboards')}`;
}

/** The whole menu for one context: the eight rows in their settled order, the
 *  footer, and the two Dashboard targets. Targets ride along with the rows so
 *  "this row is enabled" and "here is what it acts on" are decided ONCE, by the
 *  same rule, and cannot drift apart at the call site. */
export function fileMenuModel(ctx: FileMenuContext): FileMenuModel {
  const dashboardSurface = ctx.surface.surface === 'dashboard' ? ctx.surface : null;
  const readOnly = dashboardSurface?.mode === 'view';
  const noLibrary = ctx.libraryQueryCount === 0 ? NO_LIBRARY_QUERIES : null;

  return {
    items: [
      // One unlabeled group of workspace/Library/Dashboard operations — #452
      // removed the per-surface section headings, which were the most visible
      // way the two old menus disagreed.
      row('new-workspace', 'New workspace…', null, null),
      row('import-workspace', 'Import workspace…', null, null),
      row('export-workspace', 'Export workspace…', '.json', ctx.hasWorkspace ? null : NO_WORKSPACE),
      row('import-queries', 'Import queries…', null, readOnly ? EDIT_ONLY : null),
      row('import-dashboard', 'Import Dashboard…', null, importDashboardReason(ctx)),
      row('export-dashboard', 'Export Dashboard…', '.json', exportDashboardReason(ctx)),
      // #452 renames the two downloads so their LIBRARY scope is explicit — the
      // old "Download Markdown" reads as "download this dashboard" once the same
      // menu opens over a Dashboard.
      row('download-md', 'Download Library as Markdown', '.md', noLibrary, true),
      row('download-sql', 'Download Library as SQL', '.sql', noLibrary),
    ],
    footer: fileMenuFooter(ctx),
    importDashboardTarget: importDashboardTargetOf(ctx),
    exportDashboardTarget: exportDashboardTargetOf(ctx),
  };
}
