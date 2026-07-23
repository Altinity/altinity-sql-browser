// The signed-in workbench shell (#276 Phase 5) — `renderApp`'s ENTIRE former
// body (header + sidebar + splitters + the workbench DOM + every reactive
// effect + `workbench.attachShell` + the catalog bootstrap-load tail) moved
// here byte-identically as `mountWorkbenchShell(deps)`. `src/ui/app.ts`'s own
// exported `renderApp(app, helpers)` is now a thin composition call that
// assembles `WorkbenchShellDeps` from the real `app` object and calls this.
//
// `deps` is a narrow bag, NOT `App` — every value this shell's OWN logic
// reads (root/document/state/actions/conn/catalog/sqlEditor/specEditor/
// workbench session/queryDoc/prefs/matchMedia + the handful of app.ts-owned
// DOM helper functions: updateSaveBtn/specBlocked/renderVarStrip/updateBanner/
// setRunBtn/setExportBtn/activeTab) is its own field, read directly — never
// through `app.*` — so this module is one step closer to not needing `app`
// at all.
//
// `deps.app` is the one deliberate exception (documented at its own field),
// kept for three reasons that don't yet have a narrower home:
//   1. The render-module pass-through: renderTabs/renderSchema/renderResults/
//      renderSavedHistory/renderLibraryTitle all still take the full `App` —
//      this shell receives `app` SOLELY to forward it to those calls (a
//      documented crutch, not a license to read `app.*` for the shell's own
//      logic — see CLAUDE.md rule 5 on speculative primitives: rewriting
//      every render module to a narrow dep bag is out of scope here).
//   2. `app.dom` itself: reset (`app.dom = {}`) and populated here, but every
//      one of those render modules — and other files entirely (e.g.
//      codemirror-adapter.ts's `app.dom.sqlEditorView = view`) — reach into
//      `app.dom.*` directly, so the reset MUST land on the real object, not
//      a decoupled copy this shell would own instead.
//   3. `app.updateEditorModeUi`/`app.syncSelection`: this shell DEFINES both
//      closures and assigns them back onto `app` (not just calls them) —
//      other app.ts closures (`setEditorMode`, `commitLinkedQuery`, …) and
//      other modules entirely (results.ts, file-menu.ts, saved-history.ts)
//      read `app.updateEditorModeUi`/`app.syncSelection` off the live object,
//      so the assignment has to happen on the real `App`.
//   4. Every DEFERRED closure that touches `sqlEditor`/`specEditor` (the tabs
//      effect's `syncFromState()` calls, `app.syncSelection`'s own body)
//      reads them as `app.sqlEditor`/`app.specEditor`, not the `sqlEditor`/
//      `specEditor` deps locals — a caller can replace either port wholesale
//      on the real `app` object after mount (app.test.ts does exactly this
//      for `sqlEditor`), and the pre-extraction code always read them fresh.
//      The `sqlEditor`/`specEditor` deps fields exist only for the two
//      synchronous, run-once `.mount()` calls below, where a snapshot and a
//      live read are equivalent.
//
// Every ordering comment, effect subscription set, and the `attachShell`
// placement are preserved byte-identically — see the individual comments
// below (ported verbatim from app.ts's history).

import { h } from '../dom.js';
import { Icon } from '../icons.js';
import { MOBILE_BREAKPOINT_PX, savedForTab } from '../../state.js';
import type { QueryTab as Tab, AppState as State } from '../../state.js';
import { formatRows } from '../../core/format.js';
import { effect } from '@preact/signals-core';
import { renderTabs } from '../tabs.js';
import { renderSchema } from '../schema.js';
import { renderResults } from '../results.js';
import type { QueryResult } from '../results.js';
import { renderSavedHistory } from '../saved-history.js';
import { renderLibraryTitle, renderDashboardNav } from '../file-menu.js';
import { buildAppHeader } from '../app-header.js';
import { SCHEMA_GRAPH_MIME } from '../dnd-mime.js';
import { startDrag } from '../splitters.js';
import type { DragCtx, DragRect, DragStartEvent, SplitterAxis } from '../splitters.js';
import type { App, ActionsRegistry } from '../app.types.js';
import type { EditorPort } from '../../editor/editor-port.types.js';
import type { SpecEditorPort, SpecDiagnostic } from '../../editor/spec-editor.types.js';
import type { ConnectionSession } from '../../application/connection-session.js';
import type { SchemaCatalogService } from '../../application/schema-catalog-service.js';
import type { QueryDocumentSession } from '../../application/query-document-session.js';
import type { AppPreferences, PreferenceKey } from '../../application/app-preferences.js';
import type { WorkbenchSession } from './workbench-session.js';

/** `mountWorkbenchShell`'s dependency bag. See this file's header comment for
 *  the `app` field's rationale — every other field is read directly by this
 *  shell's own logic, never through `app.*`. */
export interface WorkbenchShellDeps {
  /** The full controller, kept ONLY for: the render-module pass-through
   *  (renderTabs/renderSchema/renderResults/renderSavedHistory/
   *  renderLibraryTitle), the `app.dom` reset + population (other modules
   *  read `app.dom.*` directly), and assigning `app.updateEditorModeUi`/
   *  `app.syncSelection` back onto the real object (other app.ts closures and
   *  other modules read them off it). The shell's own logic below never reads
   *  `app.*` beyond these three uses — see the fields below for everything
   *  else. */
  app: App;
  root: Element | null;
  document: Document;
  state: State;
  actions: ActionsRegistry;
  conn: Pick<ConnectionSession, 'email' | 'host'>;
  catalog: Pick<SchemaCatalogService, 'loadSchema' | 'loadReference'>;
  sqlEditor: EditorPort;
  specEditor: SpecEditorPort;
  /** The route-scoped run/runScript/runEntry/cancel session (#276 Phase 3a) —
   *  only `attachShell` is called here; the 3 run-coupled effects it wires
   *  are the session's own (see workbench-session.ts). */
  workbench: Pick<WorkbenchSession, 'attachShell'>;
  queryDoc: Pick<QueryDocumentSession, 'revalidateSpecDrafts'>;
  prefs: Pick<AppPreferences, 'save'>;
  matchMedia: ((query: string) => MediaQueryList) | null;
  activeTab(): Tab;
  updateSaveBtn(): void;
  specBlocked(tab: Tab): boolean;
  renderVarStrip(): void;
  updateBanner(): void;
  setRunBtn(running: boolean, gate?: { missing: string[]; invalid: string[]; errors: string[] }): void;
  setExportBtn(exporting: boolean): void;
  /** The DOM half of the theme toggle's caller (app.ts's own `toggleTheme`,
   *  composing `prefs.toggleTheme()` with the `data-theme`/icon swap) —
   *  this shell only ever wires it as the theme button's `onclick`. */
  toggleTheme(): void;
  startDrag: typeof startDrag;
}

/** Build the signed-in shell and mount all regions. Ported byte-identically
 *  from app.ts's former `renderApp` body (#276 Phase 5) — every ordering
 *  comment below is original. */
export function mountWorkbenchShell(deps: WorkbenchShellDeps): () => void {
  const {
    app, root, document: doc, state, actions, conn, catalog, sqlEditor, specEditor,
    queryDoc, prefs, matchMedia, activeTab, updateSaveBtn, specBlocked, renderVarStrip,
    updateBanner, setRunBtn, setExportBtn, toggleTheme, startDrag: doStartDrag,
  } = deps;
  doc.documentElement.setAttribute('data-theme', state.theme);
  doc.documentElement.setAttribute('data-density', state.density);

  app.dom = {};
  const header = buildAppHeader(app);

  app.dom.schemaSearchInput = h('input', {
    type: 'text', placeholder: 'Search tables, columns…',
    oninput: (e: Event) => { state.schemaFilter.value = (e.target as HTMLInputElement).value; },
  });
  app.dom.schemaList = h('div', { class: 'schema-list' });
  const schemaPane = h('div', { class: 'side-pane schema-pane', style: { height: state.sideSplitPct + '%', flexShrink: '0', minHeight: '0' } },
    h('div', { class: 'schema-search' }, h('div', { class: 'search-wrap' }, Icon.search(), app.dom.schemaSearchInput)),
    app.dom.schemaList);

  app.dom.savedTabsRow = h('div', { class: 'side-tabs' });
  app.dom.savedSearch = h('div', { class: 'saved-search' });
  app.dom.savedList = h('div', { class: 'saved-list' });
  const savedPane = h('div', { class: 'side-pane saved-pane', style: { flex: '1', minHeight: '0' } }, app.dom.savedTabsRow, app.dom.savedSearch, app.dom.savedList);

  const sidebar = h('div', { class: 'sidebar', style: { width: state.sidebarPx + 'px' } });
  const rectFor = (axis: SplitterAxis): DragRect => {
    if (axis === 'sideRow') return sidebar.getBoundingClientRect();
    return { top: app.dom.editorRegion!.getBoundingClientRect().top, bottom: app.dom.resultsRegion!.getBoundingClientRect().bottom };
  };
  const dragCtx: DragCtx = {
    state,
    rectFor,
    apply: (axis, value) => {
      if (axis === 'col') sidebar.style.width = value + 'px';
      else if (axis === 'sideRow') schemaPane.style.height = value + '%';
      else app.dom.editorRegion!.style.height = value + '%';
    },
    save: (name, value) => prefs.save(name as PreferenceKey, value),
  };
  app.dom.sideSplit = h('div', { class: 'row-resize side-split', onmousedown: (e: DragStartEvent) => doStartDrag(e, 'sideRow', dragCtx) });
  // Mobile Tables view (#126): a Schema | Library segmented control at the top of
  // the sidebar. CSS hides it above the breakpoint; below it, it swaps which pane
  // shows (the sidebar's data-mobile-tab drives both the active-button style and
  // the pane visibility — no JS effect needed for the active state).
  app.dom.mobileSegmented = h('div', { class: 'mobile-segmented' },
    h('button', { class: 'mseg-btn', 'data-seg': 'schema', onclick: () => { state.mobileTab.value = 'schema'; } }, Icon.database(), h('span', null, 'Schema')),
    h('button', { class: 'mseg-btn', 'data-seg': 'library', onclick: () => { state.mobileTab.value = 'library'; } }, Icon.layers(), h('span', null, 'Queries')));
  sidebar.append(app.dom.mobileSegmented, schemaPane, app.dom.sideSplit, savedPane);
  const sideHandle = h('div', { class: 'col-resize', onmousedown: (e: DragStartEvent) => doStartDrag(e, 'col', dragCtx) });

  app.dom.qtabsInner = h('div', { class: 'qtabs-inner' });
  const qtabsRow = h('div', { class: 'qtabs' }, app.dom.qtabsInner,
    h('button', { class: 'new-tab', title: 'New query', onclick: () => actions.newTab() }, Icon.plus()));

  app.dom.runBtn = h('button', { class: 'run-btn', onclick: () => actions.run() }, Icon.play(), h('span', null, 'Run'), h('kbd', null, '⌘↵'));
  app.dom.fmtBtn = h('button', { class: 'tb-btn', title: 'Format SQL (⌘⇧↵)', onclick: () => actions.formatQuery() }, Icon.braces(), 'Format');
  app.dom.explainBtn = h('button', { class: 'tb-btn', title: 'Explain this query (plan, indexes, pipeline, estimate)', onclick: () => actions.explainQuery() }, Icon.plan(), 'Explain');
  app.dom.formatSpecBtn = h('button', { class: 'tb-btn spec-action', title: 'Format Spec JSON (⌘⇧↵)', onclick: () => actions.formatSpec() }, Icon.braces(), 'Format');
  app.dom.saveBtn = h('button', { class: 'tb-btn save-btn', onclick: () => actions.save() });
  app.dom.sqlModeBtn = h('button', { class: 'editor-mode-btn', onclick: () => actions.setEditorMode('sql'), 'aria-pressed': 'true' }, 'SQL');
  app.dom.specModeBtn = h('button', { class: 'editor-mode-btn', onclick: () => actions.setEditorMode('spec'), 'aria-pressed': 'false' }, 'Spec');
  app.dom.editorModeSwitch = h('div', { class: 'editor-mode-switch', role: 'group', 'aria-label': 'Editor mode' }, app.dom.sqlModeBtn, app.dom.specModeBtn);
  // Chromium + secure-context only (app.canExport), and disabled while one is
  // already running (app.state.exporting — see setExportBtn's effect below).
  // Aria-disabled with a tooltip rather than natively `disabled` — a natively
  // disabled button swallows pointer events, so its title tooltip often never
  // shows, exactly where a "why is this greyed out?" explanation matters most.
  app.dom.exportBtn = h('button', {
    class: 'tb-btn', onclick: () => actions.exportEntry(),
  }, Icon.download(), 'Export');
  app.dom.shareBtn = h('button', { class: 'tb-btn', title: 'Share query (copies link)', onclick: () => actions.share() }, Icon.share(), 'Share');

  const editorToolbar = h('div', { class: 'ed-toolbar' },
    app.dom.runBtn, app.dom.fmtBtn, app.dom.explainBtn,
    app.dom.formatSpecBtn,
    app.dom.saveBtn, app.dom.editorModeSwitch,
    h('div', { style: { flex: '1' } }), app.dom.exportBtn, app.dom.shareBtn);
  // Query-variable strip (#134): one input per detected {name:Type} placeholder,
  // in a single row that scrolls horizontally (never wraps) when there are many.
  // Hidden (no vertical space) until the active tab has variables — see
  // renderVarStrip. Sits below the toolbar so it doesn't compete with the
  // splitter-sized editor for height.
  app.dom.varStrip = h('div', { class: 'var-strip', style: { display: 'none' } });
  app.dom.sqlEditorHost = h('div', { class: 'document-editor sql-document-editor' });
  app.dom.specEditorHost = h('div', { class: 'document-editor spec-document-editor' });
  app.dom.specStatus = h('div', { class: 'spec-status', role: 'status', 'aria-live': 'polite' });
  app.dom.specPane = h('div', { class: 'spec-editor-pane' }, app.dom.specEditorHost, app.dom.specStatus);
  app.dom.editorRegion = h('div', { class: 'editor-region', style: { height: state.editorPct + '%', minHeight: '0', overflow: 'hidden', flexShrink: '0' } },
    app.dom.sqlEditorHost, app.dom.specPane);
  app.dom.resultsRegion = h('div', { class: 'results-region', style: { flex: '1', minHeight: '0', overflow: 'hidden' } });
  // Drop a database/table from the schema tree here → render its lineage graph.
  // Disabled in mobile mode (#126): native drag doesn't fire from touch, and the
  // schema tree drops its drag sources below the breakpoint, so accepting a drop
  // here would be a dead affordance. (Clicking a db row still draws the graph via
  // showSchemaGraph — #124's tap-native trigger — so nothing is lost.)
  app.dom.resultsRegion.addEventListener('dragover', (e) => {
    if (state.isMobile.value) return;
    if (e.dataTransfer && [...e.dataTransfer.types].includes(SCHEMA_GRAPH_MIME)) e.preventDefault();
  });
  app.dom.resultsRegion.addEventListener('drop', (e) => {
    if (state.isMobile.value) return;
    const payload = e.dataTransfer && e.dataTransfer.getData(SCHEMA_GRAPH_MIME);
    if (!payload) return;
    e.preventDefault();
    try { actions.showSchemaGraph(JSON.parse(payload)); } catch { /* malformed payload */ }
  });
  app.dom.editorResultsSplit = h('div', { class: 'row-resize', onmousedown: (e: DragStartEvent) => doStartDrag(e, 'row', dragCtx) });

  const workbenchEl = h('div', { class: 'workbench' }, qtabsRow, editorToolbar, app.dom.varStrip, app.dom.editorRegion, app.dom.editorResultsSplit, app.dom.resultsRegion);
  app.dom.banner = h('div', { class: 'auth-banner', style: { display: 'none' } });
  const mainRow = h('div', { class: 'main-row' }, sidebar, sideHandle, workbenchEl);

  // Mobile bottom-tab nav (#126): one full-screen panel at a time. CSS hides it
  // above the breakpoint; below it, `mainRow[data-mobile-view]` (set by the
  // effect below) picks which of sidebar / editor / results fills the screen.
  // The Results tab carries a live badge (row count, or ● while a query streams).
  app.dom.mobileBadge = h('span', { class: 'mnav-badge' });
  const navBtn = (view: string, icon: SVGElement, label: string, extra?: HTMLElement): HTMLButtonElement => h('button', {
    class: 'mobile-nav-btn', 'data-view': view, onclick: () => { state.mobileView.value = view as 'tables' | 'editor' | 'results'; },
  }, h('span', { class: 'mnav-ic' }, icon, extra || null), h('span', { class: 'mnav-label' }, label));
  app.dom.mobileNav = h('div', { class: 'mobile-nav' },
    navBtn('tables', Icon.database(), 'Tables'),
    navBtn('editor', Icon.code(), 'Editor'),
    navBtn('results', Icon.table2(), 'Results', app.dom.mobileBadge));

  root!.replaceChildren(header, app.dom.banner, mainRow, app.dom.mobileNav);

  sqlEditor.mount(app.dom.sqlEditorHost!);
  specEditor.mount(app.dom.specEditorHost!);
  app.updateEditorModeUi = () => {
    const tab = activeTab();
    const linked = !!savedForTab(state, tab);
    if (!linked && tab.editorMode === 'spec') tab.editorMode = 'sql';
    const specMode = tab.editorMode === 'spec';
    app.dom.sqlEditorHost!.hidden = specMode;
    app.dom.specPane!.hidden = !specMode;
    for (const button of [app.dom.runBtn!, app.dom.fmtBtn!, app.dom.explainBtn!]) button.hidden = specMode;
    app.dom.formatSpecBtn!.hidden = !specMode;
    for (const button of [app.dom.exportBtn!, app.dom.shareBtn!]) button.hidden = specMode;
    app.dom.sqlModeBtn!.classList.toggle('active', !specMode);
    app.dom.specModeBtn!.classList.toggle('active', specMode);
    app.dom.sqlModeBtn!.setAttribute('aria-pressed', String(!specMode));
    app.dom.specModeBtn!.setAttribute('aria-pressed', String(specMode));
    app.dom.specModeBtn!.classList.toggle('is-disabled', !linked);
    app.dom.specModeBtn!.setAttribute('aria-disabled', String(!linked));
    app.dom.specModeBtn!.title = linked ? 'Edit saved-query Spec JSON' : 'Save this query to create an editable Spec.';
    // `tab.specDiagnostics`'s declared `SpecDiagnostic` (editor/spec-editor.
    // types.ts) doesn't carry `line`/`column` — but every diagnostic actually
    // stored there came from `evaluateSpecText`'s real `SpecValidationDiagnostic`
    // (core/spec-draft.js), which does (the JSON-syntax diagnostic in
    // particular always sets them). Widened locally rather than touching that
    // shared editor contract.
    const errors = (tab.specDiagnostics as (SpecDiagnostic & { line?: number; column?: number })[] | undefined)
      ?.filter((item) => item.severity === 'error') || [];
    const diagnostic = errors[0];
    app.dom.specStatus!.className = 'spec-status' + (diagnostic ? ' is-error' : '');
    app.dom.specStatus!.hidden = !diagnostic;
    app.dom.specStatus!.textContent = diagnostic
      ? `${diagnostic.line ? `Line ${diagnostic.line}, column ${diagnostic.column}: ` : ''}${diagnostic.message}${errors.length > 1 ? ` — ${errors.length} errors` : ''}`
      : '';
    app.dom.shareBtn!.disabled = specBlocked(tab);
    app.dom.shareBtn!.title = specBlocked(tab) ? 'Fix blocking Spec errors before sharing' : 'Share query (copies link)';
    app.dom.varStrip!.hidden = specMode;
    updateSaveBtn();
  };
  // Reactive repaint of the tab-dependent surface — replaces the old tabs.js
  // refresh(): re-runs whenever the tab list or active tab changes, so tab ops
  // just mutate the signals.
  const disposers: (() => void)[] = [];
  disposers.push(effect(() => {
    state.tabs.value;
    state.activeTabId.value;
    queryDoc.revalidateSpecDrafts({ refreshUi: false });
    renderTabs(app);
    // Live `app.sqlEditor`/`app.specEditor` reads (not the `sqlEditor`/
    // `specEditor` deps locals): a caller (e.g. a test) can hot-swap either
    // port wholesale on the real `app` object after mount — the original
    // pre-extraction code always read them off `app` fresh on every effect
    // run, and this effect re-runs on every later tab-list/active-tab change.
    app.sqlEditor.syncFromState();
    app.specEditor.syncFromState();
    updateSaveBtn();
    renderVarStrip(); // switching tabs / opening a saved query re-detects variables
    app.updateEditorModeUi!(); // assigned just above, unconditionally, before any effect can run
  }));
  // The workbench's 3 run-coupled reactive effects (#276 Phase 3a — see
  // workbench-session.ts's own `attachShell`): the results-pane repaint
  // (re-runs on a tab switch, a Table/JSON/Chart view change, or a run-state
  // flip — renderResults' activeTab() also reads tabs.value, so a tab-list
  // change repaints here too; streaming-data repaints still call renderResults
  // directly from the session's own onChunk), the Run button (label + disabled,
  // reflecting the run state and the selection — Run ↔ Run selection), and the
  // mobile Results-nav badge (● while a query streams, else the row count).
  // Idempotent: re-registers (disposing the previous set) on every renderApp()
  // re-run.
  deps.workbench.attachShell({
    renderResults: () => renderResults(app),
    setRunBtn: (running) => setRunBtn(running),
    setMobileBadge: () => {
      const r = activeTab().result as QueryResult | null;
      app.dom.mobileBadge!.textContent = state.running.value
        ? '●'
        : (r && r.rawText == null && r.progress ? formatRows(r.progress.rows) : '');
    },
  });
  // The Export button reflects the exporting state — set here (not just at
  // click-time) so a second click while one export is already running is
  // blocked visually too, not just by exportDirect's own re-entrance guard.
  disposers.push(effect(() => { setExportBtn(state.exporting.value); }));
  // Track the editor's text selection into a signal so the Run button label and
  // ⌘+Enter target just the highlighted text. `selectionchange` is the one event
  // that fires for keyboard, mouse, and programmatic selection; gate on the
  // editor being focused so selecting elsewhere (results, address bar) is ignored.
  app.syncSelection = () => {
    // Live `app.sqlEditor` read (see the tabs effect above's own comment) —
    // a caller can replace `app.sqlEditor` wholesale after mount, and this
    // closure is itself stored on `app.syncSelection` for the
    // `selectionchange` listener to call indefinitely, well past this
    // function's own return.
    const sel = app.sqlEditor.hasFocus() ? app.sqlEditor.getSelection().text : '';
    state.hasSelection.value = sel.trim() !== '';
  };
  doc.addEventListener('selectionchange', app.syncSelection);
  // Reactive repaint of the schema tree — replaces the scattered renderSchema()
  // calls: re-runs on schema load, load error, filter text, or expand/collapse.
  // Registered here (post-mount) so app.dom.schemaList already exists; the effect
  // also runs once now for the initial paint.
  disposers.push(effect(() => {
    state.schema.value;
    state.schemaError.value;
    state.schemaFilter.value;
    state.expanded.value;
    // Crossing the mobile breakpoint (#126) adds/removes each row's drag source
    // and hover title, so repaint the tree when isMobile flips.
    state.isMobile.value;
    renderSchema(app);
  }));
  // The schema/auth-failure banner reflects schemaError (a separate surface).
  disposers.push(effect(() => {
    state.schemaError.value;
    updateBanner();
  }));
  // Reactive repaint of the side panel: re-runs when the active panel changes
  // (Library ↔ History). Data-driven repaints (savedQueries/history mutations)
  // still call renderSavedHistory directly until those slices are signals too.
  disposers.push(effect(() => {
    state.sidePanel.value;
    renderSavedHistory(app);
  }));
  // Reactive repaint of the header library title (name + unsaved-changes dot):
  // re-runs when the name or dirty flag changes. The edit-mode toggle is driven
  // separately (editingLibrary is not a signal — file-menu.js renders it directly).
  disposers.push(effect(() => {
    state.libraryName.value;
    state.libraryDirty.value;
    renderLibraryTitle(app);
    // #302: the "Dashboard →" control's visibility tracks Dashboard presence,
    // which changes alongside these signals (star toggle / import / replace all
    // flip libraryDirty on their way through a commit).
    renderDashboardNav(app);
  }));
  // Mobile mode (#126): mirror the viewport width into `isMobile` (drives the
  // schema tree's drag/hover affordances, the results drop target, and the
  // auto-navigation in the action wrappers) via the injected matchMedia seam.
  // When the platform has no matchMedia the app stays in desktop JS mode — the
  // mobile CSS still applies, just without JS branching.
  const mq = matchMedia && matchMedia('(max-width: ' + MOBILE_BREAKPOINT_PX + 'px)');
  const onMobileChange = (e: MediaQueryListEvent): void => { state.isMobile.value = e.matches; };
  if (mq) {
    state.isMobile.value = mq.matches;
    mq.addEventListener('change', onMobileChange);
  }
  // Bottom-nav view switching: reflect the active mobile panel + Tables segmented
  // choice onto data-attributes the mobile CSS keys off (a no-op above the
  // breakpoint). Each runs once now for the initial paint.
  disposers.push(effect(() => { mainRow.dataset.mobileView = state.mobileView.value; }));
  disposers.push(effect(() => { sidebar.dataset.mobileTab = state.mobileTab.value; }));
  catalog.loadSchema();
  catalog.loadReference();
  return () => {
    for (const dispose of disposers) dispose();
    doc.removeEventListener('selectionchange', app.syncSelection!);
    mq?.removeEventListener('change', onMobileChange);
  };
}
