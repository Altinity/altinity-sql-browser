// The ONE application "File ▾" menu (#452). Every work surface — Query,
// Dashboard Edit, Dashboard View, the empty-Dashboard placeholder, the
// Dashboard workspace-not-found fallback — renders THIS control, with the same
// rows in the same order. #452 removed the Dashboard's separate menu
// (`buildDashboardFileMenu`) and the `AppHeaderOptions.fileButton` seam that let
// a surface substitute its own: the File word must not change meaning when the
// user changes work surface. Surfaces now supply CONTEXT only
// (`FileMenuSurfaceContext`), which the pure `core/file-menu-model.ts` turns
// into enabled/disabled rows — it can enable or disable an item, never remove or
// reorder one.
//
// Resource-oriented portable-bundle workspace operations — New workspace /
// New dashboard / Import queries / Import dashboard / Import workspace /
// Export dashboard / Export workspace — plus the one-way Markdown/SQL Library
// downloads (buildMarkdownDoc/buildSqlDoc, unchanged).
// #463 makes the three Dashboard commands WORKSPACE operations rather than
// operations on whichever Dashboard is open: New appends an empty one, Import
// appends the imported one, and Export resolves an exact target (preferring the
// one on screen, asking through a chooser when it cannot name one). None of them
// can replace a Dashboard, so the destructive-replace confirm and the
// `create-first`/compatibility-slot targeting both went with them.
// #406 makes workspace import additive: local identity is reminted, the
// generated key is made unique, and the previously active record is untouched.
// The legacy Library New/Save-JSON/Open-replace/Append ops are gone; every
// write here builds a `PortableBundleImportPlan` (workspace/import-planner.js)
// or a repository-level primitive (workspace/workspace-operations.js) INSIDE
// the transform passed to `app.mutateWorkspace` (#341/#344 review fix — never
// from a pre-queue snapshot: `commitWorkspace`/`planBuild` below are the only
// path every mutation here goes through), commits the WHOLE candidate, and
// projects the result onto `state` via `app.applyCommittedWorkspace` before
// repainting (`afterLibraryChange`). Detached Dashboard snapshot transport was
// removed by #407; every operation here only COMMITS to the workspace, never
// executes a query. Render module over the `app`
// controller; every side effect goes through an injected seam
// (app.mutateWorkspace / app.downloadFile / app.FileReader / app.document /
// app.genId / app.wallNow), so it is fully testable.

import { h, attachBackdropClose } from './dom.js';
import { Icon } from './icons.js';
import { closeOpenMenus, openMenu } from './menu.js';
import type { MenuHandle, MenuRow } from './menu.js';
import { fileMenuModel } from '../core/file-menu-model.js';
import type {
  DashboardExportTarget, FileMenuActionId, FileMenuSurface,
} from '../core/file-menu-model.js';
import { flashToast } from './toast.js';
import { renderSavedHistory } from './saved-history.js';
import { buildMarkdownDoc, buildSqlDoc } from '../core/saved-io.js';
import { queryName } from '../core/saved-query.js';
import { decodePortableBundleJson, encodePortableBundleJson } from '../dashboard/model/portable-bundle-codec.js';
import { normalizeLegacyLibraryToBundle } from '../dashboard/model/legacy-bundle.js';
import { libraryQueries } from '../dashboard/model/query-ownership.js';
import { buildDashboardExportBundle, buildWorkspaceExportBundle } from '../dashboard/model/dashboard-export.js';
import { dashboardDependencyQueryIds } from '../dashboard/model/bundle-order.js';
import {
  planImportQueries, planImportDashboard, planReplaceWorkspace,
  detectQueryConflicts, autoResolveConflicts, listBundleDashboards,
} from '../workspace/import-planner.js';
import type {
  QueryDecision, QueryConflict, QueryConflictAction, DashboardSummary, PortableBundleImportPlan,
} from '../workspace/import-planner.js';
import {
  appendDashboard, createNewWorkspace, renameWorkspace,
} from '../workspace/workspace-operations.js';
import { createEmptyDashboard } from '../dashboard/application/empty-dashboard.js';
import { deriveWorkspaceKey } from '../core/workspace-key.js';
import type { App } from './app.types.js';
import {
  findDashboardStrict, withCompatibilityDashboard,
} from '../workspace/workspace-dashboards.js';
import type {
  DashboardDocumentV2, PortableBundleV2, SavedQueryV2, StoredWorkspaceV5,
} from '../generated/json-schema.types.js';
import type { WorkspaceDiagnostic } from '../dashboard/model/workspace-diagnostics.js';

/** Workspace/library name → safe file base (strips path/illegal chars,
 *  collapses spaces). */
const fileBase = (name: unknown): string => (String(name || '')).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'queries';
const queries = (n: number): string => n + (n === 1 ? ' query' : ' queries');
const first = (diagnostics: readonly WorkspaceDiagnostic[], fallback: string): string => diagnostics[0]?.message || fallback;
function keyboardOwnerChannel(app: Pick<App, 'acquireKeyboardOwner'>): (owner: App['keyboardOwner']) => void {
  let release: (() => void) | null = null;
  return (owner) => {
    release?.();
    release = owner ? app.acquireKeyboardOwner(owner.kind) : null;
  };
}

/**
 * What the surface currently on screen rendered — the ONLY thing a surface
 * contributes to the File menu (#452). `workspaceMissing` is the Dashboard
 * workspace-not-found fallback saying so directly: that surface exists BECAUSE
 * no aggregate resolved, which the route status alone does not always report.
 */
export type FileMenuSurfaceContext = FileMenuSurface & { readonly workspaceMissing?: boolean };

/** The Query surface's context — the default when a caller supplies none. */
export const QUERY_FILE_MENU: FileMenuSurfaceContext = Object.freeze({ surface: 'query' as const });

/** Build the header File button + workspace title; returns the nodes to splice
 *  into the app header (after the connection chip). One control, every surface:
 *  `context` changes which rows are ENABLED, never which rows exist. */
export function libraryControls(
  app: App, context: FileMenuSurfaceContext = QUERY_FILE_MENU, titleEditable = true,
): HTMLElement[] {
  // #452: one trigger contract everywhere. The Workbench button used to only
  // ever OPEN (re-clicking it was a no-op) while the Dashboard's toggled — the
  // same header control behaving differently per surface. The toggle wins: it is
  // the reversible one, and it restores focus to the trigger on close.
  let handle: MenuHandle | null = null;
  const btn = h('button', {
    class: 'hd-file-btn', title: 'File',
    'aria-haspopup': 'menu', 'aria-expanded': 'false',
    onclick: () => {
      if (handle) { handle.close(); btn.focus(); return; }
      handle = openFileMenu(app, context, () => { handle = null; });
    },
  }, h('span', null, 'File'), Icon.chevDown()) as HTMLButtonElement;
  app.dom.fileBtn = btn;
  return [btn, buildWorkspaceTitle(app, titleEditable)];
}

/** Build the shared header workspace identity in editable or read-only form. */
export function buildWorkspaceTitle(app: App, editable: boolean): HTMLElement {
  app.dom.libraryTitle = h('div', {
    class: 'lib-title', 'data-editable': editable ? 'true' : 'false',
  });
  renderLibraryTitle(app);
  return app.dom.libraryTitle;
}

/** (Re)render the workspace title into its slot: a click-to-rename name button
 *  with an unsaved-changes dot, or an inline rename input while editing. */
export function renderLibraryTitle(app: App): void {
  const slot = app.dom.libraryTitle;
  if (!slot) return;
  const state = app.state;
  slot.replaceChildren();
  if (slot.dataset.editable === 'false') {
    slot.appendChild(h('span', {
      class: 'lib-name lib-name-readonly', title: state.libraryName.value,
    }, h('span', { class: 'lib-name-text' }, state.libraryName.value)));
    return;
  }
  if (app.editingLibrary) {
    const input = h('input', { class: 'lib-name-input', value: state.libraryName.value });
    let done = false;
    // Enter/blur commit; Escape cancels. The guard stops the blur fired by the
    // re-render teardown from undoing a cancel (same pattern as saved rename).
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      // Leave edit mode first, so the async rename commit below repaints the
      // button view via the libraryName/libraryDirty effect in createApp
      // rather than a transient input.
      app.editingLibrary = false;
      const nextName = input.value;
      renderLibraryTitle(app); // explicit: the cancel/no-op path changes no signal
      if (commit && nextName.trim()) void renameWorkspaceAction(app, nextName);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    slot.appendChild(input);
    setTimeout(() => { input.focus(); input.select(); });
    return;
  }
  slot.appendChild(h('button', {
    class: 'lib-name', title: 'Rename workspace',
    onclick: () => { app.editingLibrary = true; renderLibraryTitle(app); },
  }, h('span', { class: 'lib-name-text' }, state.libraryName.value),
     state.libraryDirty.value ? h('span', { class: 'lib-dirty', title: 'Changes since the last export or import' }) : null));
}

/** Each row's icon — presentation, so it stays here rather than in the pure
 *  model. Exhaustive over `FileMenuActionId`, so a new action cannot be added
 *  without choosing one. */
const ROW_ICONS: Record<FileMenuActionId, () => Node> = {
  'new-workspace': () => Icon.plus(),
  // #463: the grid glyph, not a second `plus` — the two New rows sit adjacent
  // and identical icons would make them read as one repeated command.
  'new-dashboard': () => Icon.dashboard(),
  'import-workspace': () => Icon.folderOpen(),
  'export-workspace': () => Icon.download(),
  'import-queries': () => Icon.upload(),
  'import-dashboard': () => Icon.upload(),
  'export-dashboard': () => Icon.download(),
  'download-md': () => Icon.download(),
  'download-sql': () => Icon.download(),
};

/**
 * Open the File dropdown anchored under the File button (Esc / outside-click
 * close; #331 area 2 — built on the shared `openMenu` primitive, which is itself
 * idempotent per trigger, so re-opening while already open is a no-op).
 *
 * Returns the handle so `libraryControls` can implement its click-to-close
 * toggle, or `null` when a menu was already mounted on this trigger.
 */
export function openFileMenu(
  app: App, context: FileMenuSurfaceContext = QUERY_FILE_MENU, onClose?: () => void,
): MenuHandle | null {
  const doc = app.document;
  // Re-entrancy guard: `openMenu` itself dedups per trigger, but the picker
  // setup + `handle.el.appendChild(...)` below run BEFORE that call, so a
  // redundant open (e.g. a keyboard shortcut fired while the menu is already
  // up) would splice two orphaned hidden inputs into the live menu. The
  // trigger's `aria-expanded` — set to 'true' by `openMenu` on open and back
  // to 'false' on close — is the authoritative open-state flag to bail on.
  if (app.dom.fileBtn!.getAttribute('aria-expanded') === 'true') return null;
  // #427: the LIBRARY projection, matching the sidebar count, the workspace
  // picker's count and the document exports below. Counting the raw collection
  // would roughly double for every migrated workspace, and — worse — the count
  // would enable "Download Library as Markdown/SQL" on a workspace whose every
  // query is owned, which then toasts "Nothing to save".
  const list = libraryEntries(app);
  // #452: recomputed on every open, so the same header control reflects current
  // state after a surface change without its rows moving. Only the SURFACE half
  // of the context is fixed when the header was built — the surface is what
  // knows which document it actually rendered.
  // Not `app.currentWorkspace !== null`: that is also null on the legacy
  // no-aggregate path, where export/import deliberately fall back to the
  // `state`-derived workspace and must stay available.
  const hasWorkspace = app.workspaceRouteStatus === 'ready' && context.workspaceMissing !== true;
  const model = fileMenuModel({
    surface: context,
    hasWorkspace,
    libraryQueryCount: list.length,
    // No resolved workspace means no Dashboards to act on, whatever `state` is
    // still projecting: the workspace-not-found surface exists BECAUSE nothing
    // resolved, and a `state.dashboard` left over from the workspace the user
    // came from would otherwise offer to export a document that is not there.
    dashboardIds: hasWorkspace ? workspaceDashboards(app).map((dashboard) => dashboard.id) : [],
  });

  const importQueriesInput = pickerInput(app, 'import-queries', (f) => onImportQueriesFile(app, f));
  const openWorkspaceInput = pickerInput(app, 'import-workspace', (f) => onOpenWorkspaceFile(app, f));
  // #452 review I4: the Dashboard picker is a menu-parented row like the other
  // two now. It used to be body-mounted by `triggerImportDashboard` and removed
  // only on `change`, so a CANCELLED native chooser leaked a hidden input onto
  // the page across every surface switch.
  const importDashboardInput = pickerInput(app, 'import-dashboard', (f) => onImportDashboardFile(app, f));

  // `model.exportDashboardTarget` is non-null exactly when its row is enabled
  // (asserted in file-menu-model.test.ts), and a disabled row has no click
  // handler at all — so that assertion can never fire.
  const RUN: Record<FileMenuActionId, () => void> = {
    'new-workspace': () => newWorkspaceAction(app),
    'new-dashboard': () => newDashboardAction(app),
    'import-workspace': () => openWorkspaceInput.click(),
    'export-workspace': () => { void exportWorkspaceAction(app); },
    'import-queries': () => importQueriesInput.click(),
    'import-dashboard': () => importDashboardInput.click(),
    'export-dashboard': () => resolveExportDashboard(app, model.exportDashboardTarget!),
    'download-md': () => downloadAction(app, 'md'),
    'download-sql': () => downloadAction(app, 'sql'),
  };

  // One ordering authority: the pure model. This loop only paints it.
  const rows: MenuRow[] = [];
  for (const item of model.items) {
    if (item.separatorBefore) rows.push({ kind: 'sep' });
    rows.push({
      kind: 'item', icon: ROW_ICONS[item.id](), label: item.label, meta: item.meta,
      reason: item.reason, disabled: !item.enabled, onClick: RUN[item.id],
    });
  }
  rows.push({ kind: 'sep' });
  rows.push({ kind: 'custom', node: h('div', { class: 'fm-count' }, model.footer) });

  // `.app-file-menu` is the File menu's own selector — `.file-menu` is the
  // shared dropdown chrome the Dashboard tree menu and style picker also mount.
  const handle = openMenu({ document: doc, trigger: app.dom.fileBtn!, rows, onClose,
    menuClass: 'app-file-menu', onKeyboardOwnerChange: keyboardOwnerChannel(app) });
  // The hidden file pickers aren't menu ROWS (no label/click chrome of their
  // own) — they're display:none inputs `.click()`-triggered by the three Import
  // items above. Parent them to the mounted menu so they're torn down with it on
  // close, whether or not the user actually picked a file (#452 review I4). The
  // item click closes the menu (detaching these) BEFORE running its onClick, so
  // the `.click()` fires on a now-detached input — which is fine: a programmatic
  // `.click()` opens the native file chooser whether or not the input is in
  // the document (the standard detached-input pattern), and it still runs
  // synchronously inside the original user gesture.
  handle.el.append(importQueriesInput, openWorkspaceInput, importDashboardInput);
  return handle;
}

// ── file pickers + bundle decode ────────────────────────────────────────────

/** `owner` names the row whose click triggers this input — the menu parents
 *  several, and addressing them by append order made a test's target depend on
 *  how many pickers happened to precede it. */
function pickerInput(app: App, owner: FileMenuActionId, onPick: (file: File) => void): HTMLInputElement {
  return h('input', {
    type: 'file', accept: '.json,application/json', 'data-picker': owner,
    style: { display: 'none' },
    onchange: (e: Event) => {
      const target = e.target as HTMLInputElement;
      const f = target.files && target.files[0];
      target.value = '';
      if (f) onPick(f);
    },
  });
}

// `identifyPortableBundle` (portable-bundle-codec.ts) returns EXACTLY one of
// these codes, and only these, when the document isn't recognizable as a
// portable bundle at all (before any structural validation runs) — the
// signal that legacy Library JSON is worth trying. Any OTHER decode failure
// (malformed JSON, a resource-limit guard, a structurally-invalid portable
// bundle) means the file WAS a portable bundle attempt, so falling back would
// only replace a precise diagnostic with a useless "Unrecognized file format".
const BUNDLE_IDENTITY_CODES = new Set([
  'bundle-invalid-root', 'bundle-invalid-format', 'bundle-version-missing',
  'bundle-version-invalid', 'bundle-version-unsupported',
]);
const isUnrecognizedBundleFormat = (diagnostics: readonly WorkspaceDiagnostic[]): boolean =>
  diagnostics.length === 1 && BUNDLE_IDENTITY_CODES.has(diagnostics[0].code);

/** Read + decode one portable-bundle (or legacy Library v1/v2) JSON file, then
 *  `onBundle(bundle)`. `decodePortableBundleJson` runs first; a
 *  format/version-identity failure falls back to
 *  `normalizeLegacyLibraryToBundle` (legacy Library → an in-memory bundle with
 *  `dashboards: []`). Any other failure (or a failed fallback) toasts the
 *  first diagnostic and aborts — never a partial import. */
function readBundleFile(app: App, file: File, onBundle: (bundle: PortableBundleV2) => void): void {
  const reader = new (app.FileReader || globalThis.FileReader)();
  reader.onload = () => {
    const text = String(reader.result);
    const nowISO = new Date(app.wallNow()).toISOString();
    // `decodePortableBundleJson` validates an EXISTING document (it always
    // carries its own `exportedAt`) — `nowISO` is only meaningful for the
    // legacy fallback below, which builds a fresh bundle envelope around
    // queries that may have no `exportedAt` of their own.
    const decoded = decodePortableBundleJson(text);
    if (decoded.ok) { onBundle(decoded.value); return; }
    if (!isUnrecognizedBundleFormat(decoded.diagnostics)) {
      flashToast('✕ ' + first(decoded.diagnostics, 'Could not read file'), { document: app.document });
      return;
    }
    const legacy = normalizeLegacyLibraryToBundle(text, { nowISO });
    if (legacy.ok) { onBundle(legacy.value); return; }
    flashToast('✕ ' + first(legacy.diagnostics, 'Unrecognized file format'), { document: app.document });
  };
  reader.onerror = () => flashToast('✕ Could not read file', { document: app.document });
  reader.readAsText(file);
}

// ── current workspace + commit/project ──────────────────────────────────────

/** The current committed aggregate, reconstructed from `state` — W4 keeps
 *  `state.savedQueries`/`dashboard`/`workspaceId`/`libraryName` as a live
 *  projection of it, so this never needs its own read of `app.workspace`.
 *
 *  #424: `state.dashboard` projects only the COMPATIBILITY Dashboard, so the
 *  collection is taken from `app.currentWorkspace` (which carries every stored
 *  Dashboard) with the live projection folded back into its compatibility slot.
 *  Falling back to `state.dashboard` alone would silently truncate a
 *  multi-Dashboard workspace on the degraded Export path. */
function currentWorkspace(app: App): StoredWorkspaceV5 {
  const envelope: StoredWorkspaceV5 = {
    storageVersion: 5,
    id: app.state.workspaceId,
    key: app.state.workspaceKey,
    name: app.state.libraryName.value,
    queries: app.state.savedQueries,
    dashboards: app.currentWorkspace ? app.currentWorkspace.dashboards : [],
  };
  return app.state.dashboard ? withCompatibilityDashboard(envelope, app.state.dashboard) : envelope;
}

/**
 * Every Dashboard the menu can act on, in collection order (#463) — the list
 * behind the footer count, the Export chooser and the model's export targeting.
 *
 * Deliberately NOT `currentWorkspace(app).dashboards`: that folds the live
 * `state.dashboard` projection into the compatibility SLOT, which is right for a
 * commit (entry 0 is the projected document) but would report entry 0's id twice
 * — and drop the real one — if the projection ever held a non-first Dashboard.
 * Reading the two sources separately keeps the id list exactly as committed, and
 * still covers the legacy no-aggregate install, where the single projected
 * Dashboard is the only one there is.
 */
function workspaceDashboards(app: App): readonly DashboardDocumentV2[] {
  if (app.currentWorkspace) return app.currentWorkspace.dashboards;
  return app.state.dashboard ? [app.state.dashboard] : [];
}

/** Re-sync the surfaces a workspace change touches: Save button (tab links
 *  may be pruned) and the saved list (count + rows). The title (name + dirty
 *  dot) repaints itself via the libraryName/libraryDirty effect in createApp. */
function afterLibraryChange(app: App): void {
  // Dashboard shares the application header, but none of the Workbench body
  // chrome below exists. Re-render its route after any allowed header/File
  // mutation (rename, New dashboard, or Import dashboard).
  if (app.sqlRoute.surface === 'dashboard') { app.reloadDashboardRoute(); return; }
  app.updateSaveBtn();
  // Always defined by the time a file-menu action can run (post-boot,
  // post-first-renderApp()) — app.types.ts only marks it optional because it's
  // absent before that first render.
  app.updateEditorModeUi!();
  renderSavedHistory(app);
}

/** Commit ONE workspace mutation through `app.mutateWorkspace`, then project +
 *  repaint on success. `build` receives the latest COMMITTED aggregate at
 *  DEQUEUE time (never a pre-queue snapshot — #341/#344 review fix: a queue
 *  around an independently pre-built candidate does not prevent lost
 *  updates); every file-menu commit goes through this one function so none of
 *  them can fork from that discipline. `build` returning `null` aborts the
 *  commit — the caller is expected to have already toasted its own reason (a
 *  plan invalidation), so this stays silent for that case. A rejected commit
 *  (schema/persistence failure) toasts the first diagnostic. Never a partial
 *  write either way. */
async function commitWorkspace(
  app: App, build: (latest: StoredWorkspaceV5 | null) => StoredWorkspaceV5 | null,
  successMsg?: string | (() => string),
): Promise<boolean> {
  const result = await app.mutateWorkspace((latest) => {
    const candidate = build(latest);
    return candidate ? { candidate } : null;
  });
  if (!result.ok) {
    // `build` declined (aborted) — its own toast (if any) already fired.
    if (result.aborted) return false;
    flashToast('✕ ' + first(result.diagnostics, 'Could not save workspace'), { document: app.document });
    return false;
  }
  // #343 §2: `mutateWorkspace` already projected the committed workspace.
  afterLibraryChange(app);
  // A function `successMsg` is evaluated AFTER the builder ran, so it can
  // report what the dequeue-time plan actually did (#344 review 3: the
  // imported-count toast must reflect the plan, not the bundle size).
  if (successMsg) flashToast(typeof successMsg === 'function' ? successMsg() : successMsg, { document: app.document });
  return true;
}

/** #344 review 3: re-check the pre-queue conflict DECISIONS against the
 *  dequeue-time baseline. The conflict dialog ran against a snapshot; a write
 *  that landed in the queue between the dialog and this commit can mint a NEW
 *  id collision the user never saw — and the planner deliberately defaults an
 *  undecided collision to 'skip', which would silently drop the incoming
 *  query under a success toast. A new canonically-IDENTICAL conflict is
 *  auto-resolved to 'use-existing' (same rule the dialog itself applies); a
 *  new content-DIFFERING conflict aborts (`null`) — the user must re-run the
 *  import and decide against the workspace as it now is. */
function revalidateDecisions(
  base: StoredWorkspaceV5, incoming: readonly SavedQueryV2[], decisions: readonly QueryDecision[],
): QueryDecision[] | null {
  const conflicts = detectQueryConflicts(base.queries, incoming);
  const decided = new Set(decisions.map((decision) => decision.sourceId));
  const fresh = conflicts.filter((conflict) => !decided.has(conflict.sourceId));
  if (fresh.some((conflict) => !conflict.canonicalEqual)) return null;
  return [...decisions, ...autoResolveConflicts(fresh)];
}

/** Wrap an import-planner call as a `commitWorkspace` builder: revalidate the
 *  pre-queue `decisions` against the dequeue-time baseline (`latest`, falling
 *  back to the `state`-projected `currentWorkspace` when no aggregate is
 *  persisted yet — as fresh as it gets), then let `run` plan with the
 *  revalidated set. Aborts (`null`) with a toast when a new content-differing
 *  conflict appeared while queued (`revalidateDecisions`) or when the plan
 *  invalidated (`candidateWorkspace: null` — e.g. a skipped required
 *  Dashboard dependency) — never a partial/invalid/silently-lossy commit. */
function planBuild(
  app: App, incoming: readonly SavedQueryV2[], decisions: readonly QueryDecision[],
  run: (base: StoredWorkspaceV5, decisions: readonly QueryDecision[]) => PortableBundleImportPlan,
): (latest: StoredWorkspaceV5 | null) => StoredWorkspaceV5 | null {
  return (latest) => {
    const base = latest ?? currentWorkspace(app);
    const revalidated = revalidateDecisions(base, incoming, decisions);
    if (!revalidated) {
      flashToast('✕ Workspace changed while importing — nothing imported, try again', { document: app.document });
      return null;
    }
    const plan = run(base, revalidated);
    if (!plan.candidateWorkspace) {
      flashToast('✕ ' + first(plan.diagnostics, 'Import failed'), { document: app.document });
      return null;
    }
    return plan.candidateWorkspace;
  };
}

/** The count an import's success toast reports: incoming queries the plan
 *  actually resolved to a target ('use-existing' counts — the query is
 *  available after the import; 'skip' does not). */
function importedQueryCount(plan: PortableBundleImportPlan): number {
  return Object.values(plan.queryMappings).filter((m) => m.action !== 'skip').length;
}

// ── conflict resolution (global default + per-row override) ────────────────

/** Detect id conflicts between `existing`/`incoming`, silently auto-resolve
 *  the canonically-identical ones, and — only when conflicts with genuinely
 *  different content remain — open the conflict dialog for the rest before
 *  calling `run` with the combined `QueryDecision[]`. `run` is never called
 *  if the dialog is cancelled. */
function withQueryDecisions(
  app: App, existing: readonly SavedQueryV2[], incoming: readonly SavedQueryV2[],
  run: (decisions: QueryDecision[]) => void,
): void {
  const conflicts = detectQueryConflicts(existing, incoming);
  if (!conflicts.length) { run([]); return; }
  const auto = autoResolveConflicts(conflicts);
  const remaining = conflicts.filter((c) => !c.canonicalEqual);
  if (!remaining.length) { run(auto); return; }
  openConflictDialog(app, remaining, (decisions) => run([...auto, ...decisions]));
}

const CONFLICT_ACTIONS: { value: QueryConflictAction; label: string }[] = [
  { value: 'use-existing', label: 'Keep existing' },
  { value: 'copy', label: 'Keep both (copy)' },
  { value: 'replace', label: 'Replace existing' },
  { value: 'skip', label: 'Skip' },
];

function actionSelect(
  initial: QueryConflictAction | '', onChange: (v: QueryConflictAction | '') => void, withDefaultOption: boolean,
): HTMLSelectElement {
  const select = h('select', {
    class: 'fm-select',
    onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as QueryConflictAction | ''),
  }) as HTMLSelectElement;
  const options = withDefaultOption
    ? [{ value: '' as const, label: 'Use default' }, ...CONFLICT_ACTIONS]
    : CONFLICT_ACTIONS;
  for (const o of options) select.appendChild(h('option', { value: o.value }, o.label));
  select.value = initial;
  return select;
}

/** One global default action selector, plus a per-row override list — the
 *  owner-decided conflict UI (#287 W5). A row left on "Use default" resolves
 *  to whichever action the global selector currently holds AT SUBMIT time
 *  (not when the row was rendered). */
function openConflictDialog(
  app: App, conflicts: readonly QueryConflict[], onResolve: (decisions: QueryDecision[]) => void,
): void {
  let globalAction: QueryConflictAction = 'use-existing';
  const overrides = new Map<string, QueryConflictAction>();
  // No `if (v)` guard here (unlike the per-row selects below): the global
  // select never offers the "Use default" option (`withDefaultOption: false`),
  // so its onchange value is structurally always one of the four real actions.
  const globalSelect = actionSelect(globalAction, (v) => { globalAction = v as QueryConflictAction; }, false);
  const rows = conflicts.map((c) => {
    const rowSelect = actionSelect('', (v) => {
      if (v) overrides.set(c.sourceId, v); else overrides.delete(c.sourceId);
    }, true);
    return h('div', { class: 'fm-conflict-row' },
      h('span', { class: 'fm-label' }, queryName(c.existing)), rowSelect);
  });
  const handle = openDialogShell(app, `Resolve ${conflicts.length} conflicting ${conflicts.length === 1 ? 'query' : 'queries'}`, [
    h('div', { class: 'fm-dialog-body' },
      'These incoming queries share an id with an existing query whose content differs.',
      h('div', { class: 'fm-conflict-global' },
        h('span', { class: 'fm-label' }, 'Default action for every row below'), globalSelect),
      h('div', { class: 'fm-conflict-rows' }, rows)),
    h('div', { class: 'fm-dialog-actions' },
      h('button', { class: 'fm-dialog-cancel', onclick: () => handle.close() }, 'Cancel'),
      h('button', { class: 'fm-dialog-confirm', onclick: () => {
        const decisions: QueryDecision[] = conflicts.map((c) => (
          { sourceId: c.sourceId, action: overrides.get(c.sourceId) ?? globalAction }
        ));
        handle.close();
        onResolve(decisions);
      } }, 'Apply')),
  ], 'fm-dialog-card--wide');
}

// ── multi-dashboard picker ───────────────────────────────────────────────────

/** One choosable Dashboard. `meta` is the secondary identity line the caller
 *  decides: duplicate TITLES are legitimate (identity is the id), so a chooser
 *  that showed names alone would offer two indistinguishable rows. */
interface DashboardPickerRow {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
}

const tiles = (n: number): string => `${n} ${n === 1 ? 'tile' : 'tiles'}`;

/** Show a picker over `dashboards` in the caller's array order — presentation
 *  order, never re-sorted. Both callers must resolve exactly one Dashboard, so
 *  there is no "No dashboard" row (#424 retired its one user, the workspace
 *  import, which now takes every bundled Dashboard). Cancelling — including via
 *  Escape or an outside click, which `openDialogShell` owns — never calls
 *  `onPick`. */
function openDashboardPicker(
  app: App, title: string, dashboards: readonly DashboardPickerRow[],
  onPick: (id: string) => void,
): void {
  const rows = dashboards.map((d) => h('button', {
    class: 'fm-item', 'data-dashboard-id': d.id,
    onclick: () => { handle.close(); onPick(d.id); },
  },
    h('span', { class: 'fm-label' }, d.title),
    h('span', { class: 'fm-meta' }, d.meta)));
  const handle = openDialogShell(app, title, [
    h('div', { class: 'fm-dialog-body fm-picker-list' }, rows),
    h('div', { class: 'fm-dialog-actions' },
      h('button', { class: 'fm-dialog-cancel', onclick: () => handle.close() }, 'Cancel')),
  ], 'fm-dialog-card--wide');
}

// ── actions: New workspace ───────────────────────────────────────────────────

function newWorkspaceAction(app: App): void {
  void doNewWorkspace(app);
}

async function doNewWorkspace(app: App): Promise<void> {
  await app.serializeWrite(async () => {
    const listed = await app.workspace.list();
    const name = 'SQL Library';
    const key = deriveWorkspaceKey(name, [
      ...listed.summaries.map((item) => item.key),
      ...listed.corrupt.map((item) => item.key),
    ]);
    const result = await app.workspace.create(createNewWorkspace(app.genId, key, name));
    if (!result.ok) {
      flashToast('✕ ' + first(result.diagnostics, 'Could not create workspace'), { document: app.document });
      return;
    }
    app.applyCommittedWorkspace(result.workspace);
    app.rewriteWorkspaceRoute(result.workspace.key);
    const opened = await app.workspace.markOpened(result.workspace.key);
    afterLibraryChange(app);
    flashToast(
      opened.ok
        ? 'Started a new workspace'
        : 'Started a new workspace, but its last-used timestamp could not be saved.',
      { document: app.document },
    );
  });
}

// ── actions: New dashboard ───────────────────────────────────────────────────

/** The name a New dashboard prompt opens on — the same title
 *  `createEmptyDashboard` has always stamped, offered for editing instead of
 *  applied silently. Duplicates are allowed (identity is the id), so accepting
 *  it unchanged twice is a legitimate outcome, not a collision. */
const DEFAULT_DASHBOARD_NAME = 'Dashboard';

function newDashboardAction(app: App): void {
  openNameDialog(app, {
    title: 'New dashboard',
    label: 'Dashboard name',
    initial: DEFAULT_DASHBOARD_NAME,
    confirmLabel: 'Create dashboard',
    onConfirm: (name) => { void doNewDashboard(app, name); },
  });
}

/**
 * Append one empty Dashboard to the workspace and open it in Edit mode (#463).
 *
 * Additive by construction: `appendDashboard` preserves every existing Dashboard
 * and query in place, so nothing here can reach `dashboards[0]` or the
 * compatibility slot.
 *
 * The document is minted BEFORE the commit is queued, unlike the imports — which
 * must re-plan against the dequeue-time baseline because their content depends
 * on it. An empty Dashboard's content does not: it is a self-contained value
 * with a freshly minted id, and only the APPEND has to see `latest`. That is
 * what lets the navigation below name exactly what was committed without reading
 * anything back out of the aggregate.
 *
 * A rejected commit leaves navigation and local state untouched —
 * `commitWorkspace` toasts the diagnostic and answers `false`.
 */
async function doNewDashboard(app: App, name: string): Promise<void> {
  const created: DashboardDocumentV2 = { ...createEmptyDashboard(app.genId()), title: name };
  const committed = await commitWorkspace(
    app, (latest) => appendDashboard(latest ?? currentWorkspace(app), created), 'Created dashboard',
  );
  if (!committed) return;
  app.openDashboard({ dashboardId: created.id, mode: 'edit' });
}

// ── actions: rename ──────────────────────────────────────────────────────────

async function renameWorkspaceAction(app: App, name: string): Promise<void> {
  // `latest ?? currentWorkspace(app)` covers the no-persisted-aggregate
  // (legacy/first-run) case — reading `app.state` inside the queued build is
  // at-DEQUEUE-time, as fresh as it gets when there's no aggregate to read.
  await commitWorkspace(app, (latest) => renameWorkspace(latest ?? currentWorkspace(app), name));
}

// ── actions: Import queries ─────────────────────────────────────────────────

function onImportQueriesFile(app: App, file: File): void {
  readBundleFile(app, file, (bundle) => startImportQueries(app, bundle));
}

function startImportQueries(app: App, bundle: PortableBundleV2): void {
  // The conflict dialog is shown against this snapshot — unavoidable, since it
  // needs SOMETHING to detect conflicts against before the user decides. The
  // commit below re-plans against the LATEST committed baseline right before
  // writing, so a mutation that lands while the dialog is open is folded in
  // rather than clobbered (#341/#344) — only the CONFLICT SET shown to the
  // user can be (harmlessly) stale, never the committed candidate.
  const workspace = currentWorkspace(app);
  withQueryDecisions(app, workspace.queries, bundle.queries, (decisions) => {
    // `lastPlan` is written by the builder inside the queued op, so the
    // (function) success message reports what the DEQUEUE-TIME plan actually
    // imported — never the bundle size (#344 review 3: a dialog-time 'skip'
    // or a dequeue-time auto-resolve must not inflate the count).
    let lastPlan: PortableBundleImportPlan | null = null;
    void commitWorkspace(
      app, planBuild(app, bundle.queries, decisions,
        (base, revalidated) => (lastPlan = planImportQueries(base, bundle, revalidated, app.genId))),
      // `lastPlan!` — the success message only runs after the builder did.
      () => 'Imported ' + queries(importedQueryCount(lastPlan!)),
    );
  });
}

// ── actions: Import Dashboard ────────────────────────────────────────────────

function onImportDashboardFile(app: App, file: File): void {
  readBundleFile(app, file, (bundle) => startImportDashboard(app, bundle));
}

// #452 removed `triggerImportDashboard`. It existed so the Dashboard's own File
// menu could start this flow with no menu of its own to hang a picker on, and it
// body-mounted an input removed only on `change` — so a CANCELLED file chooser
// leaked it onto the page for the rest of the session. With one shared menu the
// row owns a menu-parented picker that is torn down on close either way, and
// keeping a second entry point would have left two implementations of one
// operation.

/** Bundle Dashboards as picker rows. A bundle's ids are the EXPORTER's, and are
 *  reminted on import, so the tile count is the only identity worth showing. */
const bundleRows = (dashboards: readonly DashboardSummary[]): DashboardPickerRow[] =>
  dashboards.map((d) => ({ id: d.id, title: d.title, meta: tiles(d.tileCount) }));

function startImportDashboard(app: App, bundle: PortableBundleV2): void {
  const dashboards = listBundleDashboards(bundle);
  if (!dashboards.length) { flashToast('✕ No dashboard in file', { document: app.document }); return; }
  if (dashboards.length === 1) { doImportDashboard(app, bundle, dashboards[0].id); return; }
  openDashboardPicker(app, 'Import which dashboard?', bundleRows(dashboards), (id) => {
    doImportDashboard(app, bundle, id);
  });
}

// #463 removed the "Import and replace current Dashboard?" confirm along with
// the replacement it gated. The dialog existed because the import destroyed the
// Dashboard it was invoked from; an additive import destroys nothing, and
// confirming an operation that cannot lose data only teaches the user to dismiss
// confirmations.

function doImportDashboard(app: App, bundle: PortableBundleV2, dashboardId: string): void {
  // Same snapshot-for-the-dialog / re-plan-against-latest-for-the-commit split
  // as `startImportQueries` above (#341/#344).
  const workspace = currentWorkspace(app);
  const source = bundle.dashboards.find((d) => d.id === dashboardId);
  const closureIds = new Set(dashboardDependencyQueryIds(source));
  const closureQueries = bundle.queries.filter((q) => closureIds.has(q.id));
  withQueryDecisions(app, workspace.queries, closureQueries, (decisions) => {
    // #463: the plan APPENDS a freshly minted Dashboard to whatever the
    // dequeue-time baseline holds. There is no target to pass, nothing to
    // re-validate about one, and no window in which the destination can go
    // stale — the file chooser, the picker and the conflict dialog can all sit
    // open across an arbitrary number of concurrent commits and the import still
    // lands beside them rather than on top of one.
    //
    // What #452 had to defend against here (a `selectedDashboardId` read that
    // silently resolved to the collection's FIRST entry, overwriting a Dashboard
    // the user never named) is now unrepresentable: `planImportDashboard` has no
    // parameter that can name an existing entry.
    //
    // `lastPlan` carries the minted LOCAL id back out of the queued builder, the
    // same way `startImportQueries` carries its count. An append is otherwise
    // invisible — the imported Dashboard lands last in a collection the user may
    // not even have open — so opening it is what distinguishes a successful
    // additive import from a silent no-op.
    let lastPlan: PortableBundleImportPlan | null = null;
    void commitWorkspace(
      app, planBuild(app, closureQueries, decisions,
        (base, revalidated) => (lastPlan = planImportDashboard(base, bundle, dashboardId, revalidated, app.genId))),
      'Imported dashboard',
    ).then((committed) => {
      // `lastPlan!` / `importedDashboardId!` — a COMMITTED plan is a valid plan,
      // and a valid `planImportDashboard` always reports the id it minted.
      if (committed) app.openDashboard({ dashboardId: lastPlan!.importedDashboardId!, mode: 'edit' });
    });
  });
}

// ── actions: Import workspace ────────────────────────────────────────────────

function onOpenWorkspaceFile(app: App, file: File): void {
  readBundleFile(app, file, (bundle) => startOpenWorkspace(app, bundle));
}

/** #424: a workspace import now takes the bundle WHOLE — every bundled
 *  Dashboard lands in the new workspace, in bundle order. The old "which
 *  dashboard?" picker existed only because a workspace could hold at most one;
 *  keeping it would mean silently discarding the rest of a multi-Dashboard
 *  bundle. Import Dashboard (which imports exactly one into the CURRENT
 *  workspace) keeps its own picker. */
function startOpenWorkspace(app: App, bundle: PortableBundleV2): void {
  void importWorkspace(app, bundle);
}

async function importWorkspace(
  app: App, bundle: PortableBundleV2,
): Promise<void> {
  await app.serializeWrite(async () => {
    const listed = await app.workspace.list();
    const name = bundle.metadata?.name?.trim() || 'Imported workspace';
    const key = deriveWorkspaceKey(name, [
      ...listed.summaries.map((item) => item.key),
      ...listed.corrupt.map((item) => item.key),
    ]);
    const base = createNewWorkspace(app.genId, key, name);
    const plan = planReplaceWorkspace(base, bundle, [], app.genId);
    if (!plan.candidateWorkspace) {
      flashToast('✕ ' + first(plan.diagnostics, 'Import failed'), { document: app.document });
      return;
    }
    const result = await app.workspace.create(plan.candidateWorkspace);
    if (!result.ok) {
      flashToast('✕ ' + first(result.diagnostics, 'Could not import workspace'), { document: app.document });
      return;
    }
    app.applyCommittedWorkspace(result.workspace);
    app.rewriteWorkspaceRoute(result.workspace.key);
    const opened = await app.workspace.markOpened(result.workspace.key);
    afterLibraryChange(app);
    flashToast(
      opened.ok
        ? 'Imported workspace'
        : 'Imported workspace, but its last-used timestamp could not be saved.',
      { document: app.document },
    );
  });
}

// ── actions: Export ──────────────────────────────────────────────────────────

function downloadEncodedBundle(app: App, bundle: PortableBundleV2, baseName: string): void {
  const encoded = encodePortableBundleJson({ queries: bundle.queries, dashboards: bundle.dashboards, nowISO: bundle.exportedAt });
  if (!encoded.ok) { flashToast('✕ ' + first(encoded.diagnostics, 'Could not export'), { document: app.document }); return; }
  app.downloadFile(fileBase(baseName) + '.json', 'application/json', encoded.value);
  flashToast('Exported → .json', { document: app.document });
}

/** #341: flush every write already queued through `serializeWrite` (a Dashboard
 *  command, a saved-query mutation, an import) then read the latest COMMITTED
 *  aggregate — the truth an export must build from, never mid-flight `state`.
 *  Returns `null` when no aggregate is persisted (legacy/degraded install) OR
 *  when the flush/read REJECTS (blocked/quota/private-mode IndexedDB); the
 *  callers then fall back to the pre-#341 `app.state`-derived reads, so an
 *  export never becomes a silent no-op on an unhandled rejection. */
async function flushAndLoadCommitted(app: App): Promise<StoredWorkspaceV5 | null> {
  try {
    await app.flushWorkspaceWrites();
    const result = await app.workspace.loadById(app.state.workspaceId);
    return result.status === 'ok' ? result.workspace : null;
  } catch {
    return null;
  }
}

/** An export that has resolved to one id — what actually reads a document.
 *  `choose` never reaches this far: `resolveExportDashboard` converts it. */
type ExactDashboardExport = Extract<DashboardExportTarget, { kind: 'exact' }>;

/** The target as committed truth holds it — `null` when it was removed, or when
 *  the id became ambiguous (never resolved by a guess). */
function committedDashboard(
  ws: StoredWorkspaceV5, target: ExactDashboardExport,
): DashboardDocumentV2 | null {
  const lookup = findDashboardStrict(ws, target.dashboardId);
  return lookup.status === 'ok' ? lookup.dashboard : null;
}

/** The degraded (no readable aggregate) fallback: the live projection, but only
 *  if it IS the requested Dashboard. */
function degradedDashboard(
  app: App, target: ExactDashboardExport,
): DashboardDocumentV2 | null {
  const live = app.state.dashboard;
  return live && live.id === target.dashboardId ? live : null;
}

/**
 * Turn the model's Export decision into one exact Dashboard (#463).
 *
 * `exact` runs straight through — the model already resolved it, preferring the
 * Dashboard on screen — so exporting the Dashboard you are looking at, or the
 * only one a workspace has, stays a single click. `choose` is the model saying
 * it cannot name one, and is the ONLY path that opens a chooser; cancelling it
 * exports nothing.
 *
 * The chooser's pick goes back through `exportDashboardAction` as an `exact`
 * target, so every export — chosen or direct — reads committed truth by id
 * through the same fail-closed lookup.
 */
function resolveExportDashboard(app: App, target: DashboardExportTarget): void {
  if (target.kind === 'exact') {
    void exportDashboardAction(app, { kind: 'exact', dashboardId: target.dashboardId });
    return;
  }
  const rows = workspaceDashboards(app).map((dashboard) => ({
    id: dashboard.id,
    title: dashboard.title,
    // Duplicate titles are allowed, so the tile count alone can still leave two
    // identical rows. The id tail is the tiebreaker of last resort — it is the
    // only thing guaranteed to differ.
    meta: `${tiles(dashboard.tiles.length)} · ${dashboard.id.slice(-6)}`,
  }));
  openDashboardPicker(app, 'Export which dashboard?', rows, (id) => {
    void exportDashboardAction(app, { kind: 'exact', dashboardId: id });
  });
}

/**
 * Export ONE exactly-identified Dashboard's dependency closure as a bundle.
 *
 * #452: the id arrives explicitly. The old
 * `selectedDashboardId(app.mainSurface)` read fell back to the compatibility
 * Dashboard whenever the selection was `null` — so exporting from Query mode
 * silently downloaded the collection's FIRST entry. The target type has no
 * "unspecified" case, which is what makes that unrepresentable rather than
 * merely guarded.
 *
 * `flushAndLoadCommitted` returning `null` is NOT a stale target: it is the
 * legacy/no-aggregate install, or an IndexedDB read that rejected
 * (blocked/quota/private mode). #341 deliberately keeps exporting from `state`
 * there rather than becoming a silent no-op — but only when `state` is holding
 * the very Dashboard that was asked for, so the degraded path still cannot
 * retarget.
 */
export async function exportDashboardAction(
  app: App, target: ExactDashboardExport,
): Promise<void> {
  const ws = await flushAndLoadCommitted(app);
  const dashboard = ws ? committedDashboard(ws, target) : degradedDashboard(app, target);
  if (!dashboard) { flashToast('✕ That dashboard is no longer available', { document: app.document }); return; }
  const queryList = ws ? ws.queries : app.state.savedQueries;
  const bundle = buildDashboardExportBundle(dashboard, queryList, new Date(app.wallNow()).toISOString());
  downloadEncodedBundle(app, bundle, dashboard.title || app.state.libraryName.value);
}

async function exportWorkspaceAction(app: App): Promise<void> {
  const ws = await flushAndLoadCommitted(app);
  const bundle = buildWorkspaceExportBundle(ws ?? currentWorkspace(app), new Date(app.wallNow()).toISOString());
  downloadEncodedBundle(app, bundle, app.state.libraryName.value);
}

/** The LIBRARY projection: the queries no Dashboard member owns. Each member owns
 *  a dedicated copy of its query, so the raw collection would count and export
 *  every panel twice — once as the Library source and once as the owned copy, with
 *  identical names and SQL. With no workspace aggregate yet, every saved query is
 *  a Library query: there are no Dashboards to own one. */
function libraryEntries(app: App): SavedQueryV2[] {
  const workspace = app.currentWorkspace;
  if (!workspace) return app.state.savedQueries;
  return libraryQueries({ queries: app.state.savedQueries, dashboards: workspace.dashboards });
}

/** #452: no empty-Library guard here any more. The row is DISABLED when the
 *  projection is empty ("No Library queries"), so the old "Nothing to save"
 *  toast was unreachable — and telling the user after the click was always worse
 *  than showing them before it. */
function downloadAction(app: App, fmt: 'md' | 'sql'): void {
  const qs = libraryEntries(app);
  if (fmt === 'md') app.downloadFile(fileBase(app.state.libraryName.value) + '.md', 'text/markdown', buildMarkdownDoc(qs));
  else app.downloadFile(fileBase(app.state.libraryName.value) + '.sql', 'application/sql', buildSqlDoc(qs));
  flashToast('Saved ' + queries(qs.length) + ' → .' + fmt, { document: app.document });
}

// ── dialogs (shared `.fm-dialog-*` visual language) ─────────────────────────

interface DialogHandle { close(): void; }
const dialogClosers = new WeakMap<Element, () => void>();

/** Close body-mounted File menus/dialogs before an application surface exits. */
export function disposeFileMenuOverlays(app: Pick<App, 'document' | 'dom'>): void {
  closeOpenMenus(app.document);
  const dialog = app.dom.fileDialog;
  if (dialog) dialogClosers.get(dialog)?.();
}

/** Mount one `.fm-dialog-backdrop`/`.fm-dialog-card` (title + caller-supplied
 *  content nodes), wired for Esc + outside-click close — the shared shell
 *  the conflict dialog/the dashboard picker/the name dialog all build on.
 *
 *  #463: closing RETURNS FOCUS to the File trigger. Every one of these dialogs
 *  is opened from a File-menu row, and the row is already gone by the time the
 *  dialog mounts (the shared `openMenu` closes before running the click) — so
 *  `activeElement` is `<body>` and there is nothing to remember. Without this,
 *  dismissing a dialog left focus on `<body>` and a keyboard user lost their
 *  place in the menu they had just been in. `fileBtn!` holds the same invariant
 *  `openFileMenu` asserts; on a detached button (a surface swap tore the header
 *  down under an open dialog) `focus()` is a harmless no-op. */
function openDialogShell(app: App, title: string, content: unknown[], extraCardClass?: string): DialogHandle {
  const doc = app.document;
  const releaseKeyboard = app.acquireKeyboardOwner('modal');
  let backdrop: HTMLElement;
  const close = (): void => {
    doc.removeEventListener('keydown', onKey, true);
    detachBackdrop();
    dialogClosers.delete(backdrop);
    backdrop.remove();
    if (app.dom.fileDialog === backdrop) app.dom.fileDialog = undefined;
    releaseKeyboard();
    app.dom.fileBtn!.focus();
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const card = h('div', { class: extraCardClass ? `fm-dialog-card ${extraCardClass}` : 'fm-dialog-card' },
    h('div', { class: 'fm-dialog-title' }, title), content);
  backdrop = h('div', { class: 'fm-dialog-backdrop' }, card);
  const detachBackdrop = attachBackdropClose(backdrop, close);
  app.dom.fileDialog = backdrop;
  dialogClosers.set(backdrop, close);
  doc.body.appendChild(backdrop);
  doc.addEventListener('keydown', onKey, true);
  return { close };
}

interface NameDialogOpts {
  title: string;
  /** The input's visible + accessible label — the two are the same element. */
  label: string;
  initial: string;
  confirmLabel: string;
  /** Called with the TRIMMED name, only on a real commit. */
  onConfirm: (name: string) => void;
}

/**
 * Ask for one name (#463 — New dashboard is the first caller), on the same
 * `.fm-dialog-*` shell as the confirm/conflict/picker dialogs, so Escape,
 * outside-click and surface-exit teardown all behave identically.
 *
 * The name is trimmed once, at the boundary, and a whitespace-only name commits
 * NOTHING: the confirm button stays disabled, so there is no reachable state in
 * which the caller has to defend against an empty title. Enter is the same
 * commit as the button (and equally refused when empty); Escape cancels through
 * the shell. Duplicate names are allowed and deliberately not validated —
 * identity is the id.
 */
function openNameDialog(
  app: App, { title, label, initial, confirmLabel, onConfirm }: NameDialogOpts,
): void {
  const input = h('input', {
    class: 'fm-dialog-input', type: 'text', id: 'fm-name-input', value: initial, spellcheck: 'false',
  }) as HTMLInputElement;
  const confirm = h('button', {
    class: 'fm-dialog-confirm',
    onclick: () => commit(),
  }, confirmLabel) as HTMLButtonElement;
  const commit = (): void => {
    const name = input.value.trim();
    if (!name) return;
    handle.close();
    onConfirm(name);
  };
  const sync = (): void => { confirm.disabled = input.value.trim() === ''; };
  input.addEventListener('input', sync);
  input.addEventListener('keydown', (e) => {
    // Escape is the shell's, on a capture-phase document listener; only Enter is
    // ours, and only because a single-field dialog has no form to submit.
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
  });
  const handle = openDialogShell(app, title, [
    h('div', { class: 'fm-dialog-body' },
      h('label', { class: 'fm-dialog-label', for: 'fm-name-input' }, label), input),
    h('div', { class: 'fm-dialog-actions' },
      h('button', { class: 'fm-dialog-cancel', onclick: () => handle.close() }, 'Cancel'),
      confirm),
  ]);
  sync();
  // Same deferred focus+select as the inline workspace rename: the card is in
  // the document by now, and selecting the default name makes typing over it the
  // one-keystroke path.
  setTimeout(() => { input.focus(); input.select(); });
}
