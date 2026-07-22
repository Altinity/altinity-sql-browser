// The header "File ▾" menu (#287 W5): resource-oriented portable-bundle
// workspace operations — New workspace / Import queries / Import Dashboard /
// Open workspace / Export Dashboard / Export workspace — plus the kept
// "Open as dashboard" (#149), the Variable history section, and the one-way
// Markdown/SQL "share" downloads (buildMarkdownDoc/buildSqlDoc, unchanged).
// #342 reordered the Workbench menu around an unlabeled primary group (New /
// Open / Export workspace / Import queries), renamed "Replace workspace…" to
// "Open workspace…" (same destructive whole-workspace replace semantics —
// see `startOpenWorkspace`/`confirmOpenWorkspace` below), and moved Share/
// Publish above Variable history.
// The legacy Library New/Save-JSON/Open-replace/Append ops are gone; every
// write here builds a `PortableBundleImportPlan` (workspace/import-planner.js)
// or a repository-level primitive (workspace/workspace-operations.js) INSIDE
// the transform passed to `app.mutateWorkspace` (#341/#344 review fix — never
// from a pre-queue snapshot: `commitWorkspace`/`planBuild` below are the only
// path every mutation here goes through), commits the WHOLE candidate, and
// projects the result onto `state` via `app.applyCommittedWorkspace` before
// repainting (`afterLibraryChange`). External read-only "Open for viewing" +
// a trust preflight are DEFERRED to #288 — every operation here only COMMITS
// to the workspace, never executes a query. Render module over the `app`
// controller; every side effect goes through an injected seam
// (app.mutateWorkspace / app.downloadFile / app.FileReader / app.document /
// app.genId / app.wallNow), so it is fully testable.

import { h, attachBackdropClose } from './dom.js';
import { Icon } from './icons.js';
import { openMenu } from './menu.js';
import type { MenuRow } from './menu.js';
import { flashToast } from './toast.js';
import { renderSavedHistory } from './saved-history.js';
import { buildMarkdownDoc, buildSqlDoc } from '../core/saved-io.js';
import { queryName } from '../core/saved-query.js';
import { decodePortableBundleJson, encodePortableBundleJson } from '../dashboard/model/portable-bundle-codec.js';
import { normalizeLegacyLibraryToBundle } from '../dashboard/model/legacy-bundle.js';
import { buildDashboardExportBundle, buildWorkspaceExportBundle } from '../dashboard/model/dashboard-export.js';
import { dashboardDependencyQueryIds } from '../dashboard/model/bundle-order.js';
import {
  planImportQueries, planImportDashboard, planReplaceWorkspace,
  detectQueryConflicts, autoResolveConflicts, listBundleDashboards,
} from '../workspace/import-planner.js';
import type {
  QueryDecision, QueryConflict, QueryConflictAction, DashboardSummary, PortableBundleImportPlan,
} from '../workspace/import-planner.js';
import { createNewWorkspace, renameWorkspace } from '../workspace/workspace-operations.js';
import type { App } from './app.types.js';
import type { PortableBundleV1, SavedQueryV2, StoredWorkspaceV1 } from '../generated/json-schema.types.js';
import type { WorkspaceDiagnostic } from '../dashboard/model/workspace-diagnostics.js';

/** Workspace/library name → safe file base (strips path/illegal chars,
 *  collapses spaces). */
const fileBase = (name: unknown): string => (String(name || '')).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'queries';
const queries = (n: number): string => n + (n === 1 ? ' query' : ' queries');
const first = (diagnostics: readonly WorkspaceDiagnostic[], fallback: string): string => diagnostics[0]?.message || fallback;

/** Build the header File button + editable workspace title; returns the nodes
 *  to splice into the app header (after the connection chip). */
export function libraryControls(app: App): HTMLElement[] {
  app.dom.fileBtn = h('button', {
    class: 'hd-file-btn', title: 'File — workspace and dashboard import/export',
    'aria-haspopup': 'menu', 'aria-expanded': 'false',
    onclick: () => openFileMenu(app),
  }, h('span', null, 'File'), Icon.chevDown());
  app.dom.libraryTitle = h('div', { class: 'lib-title' });
  renderLibraryTitle(app);
  // #302: Dashboard navigation lives next to the workspace name (not in the
  // File menu). A plain navigation control (not a dropdown) that opens the
  // standalone Dashboard; shown only when the workspace has a Dashboard. The
  // label collapses to icon-only on narrow screens via `hd-hide-mobile-label`,
  // but the accessible name ("Open Dashboard") is always present.
  app.dom.dashboardNav = h('button', {
    class: 'hd-dash-nav', title: 'Open Dashboard', 'aria-label': 'Open Dashboard',
    onclick: () => app.actions.openDashboard(),
  }, Icon.layers(), h('span', { class: 'hd-dash-nav-label hd-hide-mobile-label' }, 'Dashboard →'));
  renderDashboardNav(app);
  return [app.dom.fileBtn, app.dom.libraryTitle, app.dom.dashboardNav];
}

/** #302 — show the header "Dashboard →" control only when the current workspace
 *  has a Dashboard. Re-run on library changes (see the workbench-shell effect +
 *  `afterLibraryChange`). No-op before `libraryControls` has built the slot. */
export function renderDashboardNav(app: App): void {
  const nav = app.dom.dashboardNav;
  if (!nav) return;
  nav.hidden = !app.state.dashboard;
}

/** (Re)render the workspace title into its slot: a click-to-rename name button
 *  with an unsaved-changes dot, or an inline rename input while editing. */
export function renderLibraryTitle(app: App): void {
  const slot = app.dom.libraryTitle;
  if (!slot) return;
  const state = app.state;
  slot.replaceChildren();
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

/** Open the File dropdown anchored under the File button (Esc / outside-click
 *  close; #331 area 2 — built on the shared `openMenu` primitive, which is
 *  itself idempotent per trigger, so re-opening while already open is a
 *  no-op). */
export function openFileMenu(app: App): void {
  const doc = app.document;
  // Re-entrancy guard: `openMenu` itself dedups per trigger, but the picker
  // setup + `handle.el.appendChild(...)` below run BEFORE that call, so a
  // redundant open (e.g. a keyboard shortcut fired while the menu is already
  // up) would splice two orphaned hidden inputs into the live menu. The
  // trigger's `aria-expanded` — set to 'true' by `openMenu` on open and back
  // to 'false' on close — is the authoritative open-state flag to bail on.
  if (app.dom.fileBtn!.getAttribute('aria-expanded') === 'true') return;
  const list = app.state.savedQueries;
  const empty = list.length === 0;

  // #302: the Workbench File menu owns workspace + query-collection operations
  // ONLY. Dashboard navigation moved to the header "Dashboard →" control
  // (`libraryControls`), and Dashboard import/export moved to the Dashboard
  // page's own File menu — none of them appear here anymore.
  const importQueriesInput = pickerInput(app, (f) => onImportQueriesFile(app, f));
  const openWorkspaceInput = pickerInput(app, (f) => onOpenWorkspaceFile(app, f));

  // Variable recent-value history (#171): this is the closest thing the app
  // has to a "settings" surface today (no dedicated preferences panel exists
  // yet — rg for one turned up nothing), so it follows the File menu's own
  // established pattern (a labeled section + `.fm-item` rows) rather than
  // inventing a new surface. "Remember recent variable values" toggles
  // recording only — existing history is retained until explicitly cleared,
  // by this action or a field's own "Clear recent" (combo-footer.js).
  const historyToggle = h('label', { class: 'fm-item fm-toggle' },
    h('input', {
      type: 'checkbox', class: 'fm-checkbox',
      checked: !app.state.varRecentDisabled,
      onchange: (e: Event) => {
        app.state.varRecentDisabled = !(e.target as HTMLInputElement).checked;
        app.params.saveVarRecentDisabled();
      },
    }),
    h('span', { class: 'fm-label' }, 'Remember recent variable values'));
  const countRow = h('div', { class: 'fm-count' }, empty ? 'Workspace is empty' : queries(list.length) + ' in workspace');

  // #342: the first four rows are one unlabeled primary-workspace-action
  // group (no heading) in this exact order, followed by Share / Publish,
  // then Variable history — the query-count footer stays last.
  const rows: MenuRow[] = [
    { kind: 'item', icon: Icon.plus(), label: 'New workspace…', onClick: () => newWorkspaceAction(app) },
    { kind: 'item', icon: Icon.folderOpen(), label: 'Open workspace…', onClick: () => openWorkspaceInput.click() },
    { kind: 'item', icon: Icon.download(), label: 'Export workspace…', meta: '.json', onClick: () => exportWorkspaceAction(app) },
    { kind: 'item', icon: Icon.upload(), label: 'Import queries…', onClick: () => importQueriesInput.click() },
    { kind: 'sep' },
    { kind: 'section', label: 'Share / Publish' },
    { kind: 'item', icon: Icon.download(), label: 'Download Markdown', meta: '.md', onClick: () => downloadAction(app, 'md') },
    { kind: 'item', icon: Icon.download(), label: 'Download SQL', meta: '.sql', onClick: () => downloadAction(app, 'sql') },
    { kind: 'sep' },
    { kind: 'section', label: 'Variable history' },
    { kind: 'custom', node: historyToggle, focusable: true },
    {
      kind: 'item', icon: Icon.trash(), label: 'Clear all recent values',
      onClick: () => {
        app.params.clearAllVarRecent();
        flashToast('Cleared recent variable values', { document: app.document });
      },
    },
    { kind: 'custom', node: countRow },
  ];

  const handle = openMenu({ document: doc, trigger: app.dom.fileBtn!, rows });
  // The hidden file pickers aren't menu ROWS (no label/click chrome of their
  // own) — they're display:none inputs `.click()`-triggered by the Import
  // queries / Open workspace items above. Parent them to the mounted menu
  // so they're torn down with it on close (no leak) and `picker(i)`-style
  // lookups (`.file-menu input[type=file]`) keep finding them. The item click
  // closes the menu (detaching these) BEFORE running its onClick, so the
  // `.click()` fires on a now-detached input — which is fine: a programmatic
  // `.click()` opens the native file chooser whether or not the input is in
  // the document (the standard detached-input pattern), and it still runs
  // synchronously inside the original user gesture.
  handle.el.appendChild(importQueriesInput);
  handle.el.appendChild(openWorkspaceInput);
}

// ── file pickers + bundle decode ────────────────────────────────────────────

function pickerInput(app: App, onPick: (file: File) => void): HTMLInputElement {
  return h('input', {
    type: 'file', accept: '.json,application/json', style: { display: 'none' },
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
function readBundleFile(app: App, file: File, onBundle: (bundle: PortableBundleV1) => void): void {
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
 *  projection of it, so this never needs its own read of `app.workspace`. */
function currentWorkspace(app: App): StoredWorkspaceV1 {
  return {
    storageVersion: 1,
    id: app.state.workspaceId,
    name: app.state.libraryName.value,
    queries: app.state.savedQueries,
    dashboard: app.state.dashboard,
  };
}

/** Re-sync the surfaces a workspace change touches: Save button (tab links
 *  may be pruned) and the saved list (count + rows). The title (name + dirty
 *  dot) repaints itself via the libraryName/libraryDirty effect in createApp. */
function afterLibraryChange(app: App): void {
  // #302: on the standalone Dashboard route the only committing operation is
  // Import Dashboard, and none of the Workbench chrome below exists — re-render
  // the dashboard instead (repointing the URL at the possibly-new dashboard id).
  if (app.dashboardRoute) { app.reloadDashboardRoute(); return; }
  app.updateSaveBtn();
  // Always defined by the time a file-menu action can run (post-boot,
  // post-first-renderApp()) — app.types.ts only marks it optional because it's
  // absent before that first render.
  app.updateEditorModeUi!();
  renderSavedHistory(app);
  // Keep the header "Dashboard →" control in sync when a commit adds/removes
  // the workspace's Dashboard (e.g. Open workspace / Import queries).
  renderDashboardNav(app);
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
  app: App, build: (latest: StoredWorkspaceV1 | null) => StoredWorkspaceV1 | null,
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
  base: StoredWorkspaceV1, incoming: readonly SavedQueryV2[], decisions: readonly QueryDecision[],
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
  run: (base: StoredWorkspaceV1, decisions: readonly QueryDecision[]) => PortableBundleImportPlan,
): (latest: StoredWorkspaceV1 | null) => StoredWorkspaceV1 | null {
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

/** Show a picker over `dashboards` (bundle array order — presentation order,
 *  not re-sorted); `allowNone` adds a "No dashboard" row (Open workspace's
 *  own owner decision — Import Dashboard never offers it, since it must
 *  import exactly one). Cancelling calls neither branch of `onPick`. */
function openDashboardPicker(
  app: App, title: string, dashboards: readonly DashboardSummary[], allowNone: boolean,
  onPick: (id: string | null) => void,
): void {
  const rows = dashboards.map((d) => h('button', {
    class: 'fm-item', onclick: () => { handle.close(); onPick(d.id); },
  },
    h('span', { class: 'fm-label' }, d.title),
    h('span', { class: 'fm-meta' }, `${d.tileCount} ${d.tileCount === 1 ? 'tile' : 'tiles'} · ${d.filterCount} ${d.filterCount === 1 ? 'filter' : 'filters'}`)));
  const noneRow = allowNone ? h('button', {
    class: 'fm-item', onclick: () => { handle.close(); onPick(null); },
  }, h('span', { class: 'fm-label' }, 'No dashboard')) : null;
  const handle = openDialogShell(app, title, [
    h('div', { class: 'fm-dialog-body fm-picker-list' }, rows, noneRow),
    h('div', { class: 'fm-dialog-actions' },
      h('button', { class: 'fm-dialog-cancel', onclick: () => handle.close() }, 'Cancel')),
  ], 'fm-dialog-card--wide');
}

// ── actions: New workspace ───────────────────────────────────────────────────

function newWorkspaceAction(app: App): void {
  const cur = currentWorkspace(app);
  if (cur.queries.length || cur.dashboard) confirmNewWorkspace(app, cur);
  else void doNewWorkspace(app);
}

async function doNewWorkspace(app: App): Promise<void> {
  // Independent of `latest` (a brand-new workspace never derives from the
  // current one) — still routed through `commitWorkspace`/`mutateWorkspace`
  // for the same one write-path discipline every other mutation here uses.
  await commitWorkspace(app, () => createNewWorkspace(app.genId), 'Started a new workspace');
}

function confirmNewWorkspace(app: App, cur: StoredWorkspaceV1): void {
  openConfirm(app, {
    title: 'Start a new workspace?',
    body: ['This clears your current ', h('b', null, String(cur.queries.length)), ' saved ',
      cur.queries.length === 1 ? 'query' : 'queries', cur.dashboard ? ' and your Dashboard' : '',
      '. Open editor tabs are unaffected. Export first if you want to keep them.'],
    confirmLabel: 'New workspace',
    onConfirm: () => void doNewWorkspace(app),
  });
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

function startImportQueries(app: App, bundle: PortableBundleV1): void {
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

/** #302 — programmatically trigger the "Import Dashboard…" flow (used by the
 *  Dashboard page's own File menu via `app.actions.importDashboard`): open a
 *  file picker, then run the same transactional import as the Workbench used to.
 *  On success `commitWorkspace` → `afterLibraryChange` repaints the active surface
 *  (the Dashboard route re-renders itself). */
export function triggerImportDashboard(app: App): void {
  const input = pickerInput(app, (f) => onImportDashboardFile(app, f));
  // Self-remove once a selection fires so repeated imports don't leak hidden
  // inputs onto the page (the Workbench menu's own pickers are cleaned up with
  // the menu; this one has no menu to ride along with).
  input.addEventListener('change', () => input.remove(), { once: true });
  app.document.body.appendChild(input);
  input.click();
}

function startImportDashboard(app: App, bundle: PortableBundleV1): void {
  const dashboards = listBundleDashboards(bundle);
  if (!dashboards.length) { flashToast('✕ No dashboard in file', { document: app.document }); return; }
  if (dashboards.length === 1) { runImportDashboard(app, bundle, dashboards[0].id); return; }
  openDashboardPicker(app, 'Import which dashboard?', dashboards, false, (id) => {
    if (id) runImportDashboard(app, bundle, id);
  });
}

function runImportDashboard(app: App, bundle: PortableBundleV1, dashboardId: string): void {
  // v1 holds at most one Dashboard, so importing one REPLACES the current
  // Dashboard (its tiles/layout/filters). Confirm first when that would discard
  // an existing Dashboard — matching New workspace/Open workspace, which also
  // gate destructive commits (#287; flagged in review — silent, unrecoverable loss).
  if (app.state.dashboard) {
    openConfirm(app, {
      title: 'Import and replace current Dashboard?',
      body: ['This replaces your current Dashboard (its tiles, layout, and filters) with the imported one. ',
        'Its saved queries are kept and merged. Open editor tabs are unaffected. ',
        'Export your Dashboard first if you want to keep it.'],
      confirmLabel: 'Import Dashboard',
      onConfirm: () => doImportDashboard(app, bundle, dashboardId),
    });
    return;
  }
  doImportDashboard(app, bundle, dashboardId);
}

function doImportDashboard(app: App, bundle: PortableBundleV1, dashboardId: string): void {
  // Same snapshot-for-the-dialog / re-plan-against-latest-for-the-commit split
  // as `startImportQueries` above (#341/#344).
  const workspace = currentWorkspace(app);
  const source = bundle.dashboards.find((d) => d.id === dashboardId);
  const closureIds = new Set(dashboardDependencyQueryIds(source));
  const closureQueries = bundle.queries.filter((q) => closureIds.has(q.id));
  withQueryDecisions(app, workspace.queries, closureQueries, (decisions) => {
    // 'copy' mints a fresh Dashboard id/revision for the imported Dashboard,
    // which then REPLACES the workspace's zero-or-one current Dashboard
    // (v1 single-Dashboard model, #280 "Import Dashboard replaces the current
    // Dashboard"). The confirm above gates the destructive case.
    void commitWorkspace(
      app, planBuild(app, closureQueries, decisions,
        (base, revalidated) => planImportDashboard(base, bundle, dashboardId, revalidated, 'copy', app.genId)),
      'Imported dashboard',
    );
  });
}

// ── actions: Open workspace ──────────────────────────────────────────────────
// #342: user-facing rename of "Replace workspace…" — same destructive
// whole-workspace replace semantics (picker → plan → confirm → commit), just
// relabeled. `planReplaceWorkspace` (import-planner.js) keeps its own name;
// it's an internal primitive, not user-facing copy.

function onOpenWorkspaceFile(app: App, file: File): void {
  readBundleFile(app, file, (bundle) => startOpenWorkspace(app, bundle));
}

function startOpenWorkspace(app: App, bundle: PortableBundleV1): void {
  const dashboards = listBundleDashboards(bundle);
  if (dashboards.length > 1) {
    openDashboardPicker(app, 'Open workspace — which dashboard?', dashboards, true, (id) => {
      confirmOpenWorkspace(app, bundle, id === null ? undefined : id);
    });
    return;
  }
  confirmOpenWorkspace(app, bundle, dashboards[0]?.id);
}

function confirmOpenWorkspace(app: App, bundle: PortableBundleV1, sourceDashboardId: string | undefined): void {
  const cur = currentWorkspace(app);
  openConfirm(app, {
    title: 'Open workspace?',
    body: ['Opening this file replaces your current ', h('b', null, String(cur.queries.length)), ' saved ',
      cur.queries.length === 1 ? 'query' : 'queries', cur.dashboard ? ' and your Dashboard' : '',
      ' with ', h('b', null, String(bundle.queries.length)), ' ', queries(bundle.queries.length),
      sourceDashboardId ? ' and the selected Dashboard' : '', ' from the file. Open editor tabs are unaffected.'],
    confirmLabel: 'Open workspace',
    onConfirm: () => {
      // Same snapshot-for-the-dialog / re-plan-against-latest-for-the-commit
      // split as `startImportQueries`/`doImportDashboard` above (#341/#344) —
      // `cur` above (the confirm body's own snapshot) has the same property.
      const workspace = currentWorkspace(app);
      withQueryDecisions(app, workspace.queries, bundle.queries, (decisions) => {
        void commitWorkspace(
          app, planBuild(app, bundle.queries, decisions,
            (base, revalidated) => planReplaceWorkspace(base, bundle, sourceDashboardId, revalidated, app.genId)),
          'Opened workspace',
        );
      });
    },
  });
}

// ── actions: Export ──────────────────────────────────────────────────────────

function downloadEncodedBundle(app: App, bundle: PortableBundleV1, baseName: string): void {
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
async function flushAndLoadCommitted(app: App): Promise<StoredWorkspaceV1 | null> {
  try {
    await app.flushWorkspaceWrites();
    return await app.workspace.loadCurrent();
  } catch {
    return null;
  }
}

export async function exportDashboardAction(app: App): Promise<void> {
  const ws = await flushAndLoadCommitted(app);
  // #302: invoked from the Dashboard page's File menu (via
  // `app.actions.exportDashboard`). Guard a null Dashboard here — unlike the
  // old Workbench menu item, the caller no longer pre-checks `hasDashboard`.
  const dashboard = ws ? ws.dashboard : app.state.dashboard;
  if (!dashboard) { flashToast('No dashboard to export', { document: app.document }); return; }
  const queryList = ws ? ws.queries : app.state.savedQueries;
  const bundle = buildDashboardExportBundle(dashboard, queryList, new Date(app.wallNow()).toISOString());
  downloadEncodedBundle(app, bundle, dashboard.title || app.state.libraryName.value);
}

async function exportWorkspaceAction(app: App): Promise<void> {
  const ws = await flushAndLoadCommitted(app);
  const bundle = buildWorkspaceExportBundle(ws ?? currentWorkspace(app), new Date(app.wallNow()).toISOString());
  downloadEncodedBundle(app, bundle, app.state.libraryName.value);
}

function downloadAction(app: App, fmt: 'md' | 'sql'): void {
  const qs = app.state.savedQueries;
  if (!qs.length) { flashToast('Nothing to save', { document: app.document }); return; }
  if (fmt === 'md') app.downloadFile(fileBase(app.state.libraryName.value) + '.md', 'text/markdown', buildMarkdownDoc(qs));
  else app.downloadFile(fileBase(app.state.libraryName.value) + '.sql', 'application/sql', buildSqlDoc(qs));
  flashToast('Saved ' + queries(qs.length) + ' → .' + fmt, { document: app.document });
}

// ── dialogs (shared `.fm-dialog-*` visual language) ─────────────────────────

interface DialogHandle { close(): void; }

/** Mount one `.fm-dialog-backdrop`/`.fm-dialog-card` (title + caller-supplied
 *  content nodes), wired for Esc + outside-click close — the shared shell
 *  `openConfirm`/the conflict dialog/the dashboard picker all build on. */
function openDialogShell(app: App, title: string, content: unknown[], extraCardClass?: string): DialogHandle {
  const doc = app.document;
  const close = (): void => {
    doc.removeEventListener('keydown', onKey, true);
    detachBackdrop();
    if (app.dom.fileDialog) { app.dom.fileDialog.remove(); app.dom.fileDialog = undefined; }
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const card = h('div', { class: extraCardClass ? `fm-dialog-card ${extraCardClass}` : 'fm-dialog-card' },
    h('div', { class: 'fm-dialog-title' }, title), content);
  const backdrop = h('div', { class: 'fm-dialog-backdrop' }, card);
  const detachBackdrop = attachBackdropClose(backdrop, close);
  app.dom.fileDialog = backdrop;
  doc.body.appendChild(backdrop);
  doc.addEventListener('keydown', onKey, true);
  return { close };
}

interface ConfirmOpts {
  title: string;
  body: unknown[];
  confirmLabel: string;
  onConfirm: () => void;
}

function openConfirm(app: App, { title, body, confirmLabel, onConfirm }: ConfirmOpts): void {
  const handle = openDialogShell(app, title, [
    h('div', { class: 'fm-dialog-body' }, body),
    h('div', { class: 'fm-dialog-actions' },
      h('button', { class: 'fm-dialog-cancel', onclick: () => handle.close() }, 'Cancel'),
      h('button', { class: 'fm-dialog-confirm', onclick: () => { handle.close(); onConfirm(); } }, confirmLabel)),
  ]);
}
