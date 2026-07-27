// The Workbench's query column (#276 Phase 5, narrowed by the #425 follow-up
// prep split) — the tabs strip, editor toolbar, SQL/Spec editors, results
// region, and every reactive effect/`attachShell`/mount call that's specific
// to the query surface, mounted into a host `ui/app-shell.ts` owns (this
// module no longer builds the header, sidebar, or mobile nav — see
// `app-shell.ts`'s own header comment for those). `src/ui/app.ts`'s own
// exported `renderApp(app, helpers)` composes both shells.
//
// `deps` is a narrow bag, NOT `App` — every value this shell's OWN logic
// reads (document/state/actions/sqlEditor/specEditor/workbench session/
// queryDoc/prefs/queryHost + the handful of app.ts-owned DOM helper
// functions: updateSaveBtn/specBlocked/renderVarStrip/setRunBtn/setExportBtn/
// activeTab) is its own field, read directly — never through `app.*` — so
// this module is one step closer to not needing `app` at all.
//
// `deps.app` is the one deliberate exception (documented at its own field),
// kept for three reasons that don't yet have a narrower home:
//   1. The render-module pass-through: renderTabs/renderResults still take
//      the full `App` — this shell receives `app` SOLELY to forward it to
//      those calls (a documented crutch, not a license to read `app.*` for
//      the shell's own logic — see CLAUDE.md rule 5 on speculative
//      primitives: rewriting every render module to a narrow dep bag is out
//      of scope here).
//   2. `app.dom` itself: populated here (not reset — `app-shell.ts` resets it
//      exactly once, before either shell mounts), but every one of those
//      render modules — and other files entirely (e.g.
//      codemirror-adapter.ts's `app.dom.sqlEditorView = view`) — reach into
//      `app.dom.*` directly, so the fields this shell owns must land on the
//      real object, not a decoupled copy this shell would own instead.
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
// below (ported verbatim from app.ts's history, then from this module's own
// pre-split history).

import { h } from '../dom.js';
import { Icon } from '../icons.js';
import { savedForTab, variableDoc } from '../../state.js';
import type { QueryTab as Tab, AppState as State } from '../../state.js';
import { formatRows } from '../../core/format.js';
import { effect } from '@preact/signals-core';
import { renderTabs } from '../tabs.js';
import { renderResults } from '../results.js';
import type { QueryResult } from '../results.js';
import { SCHEMA_GRAPH_MIME } from '../dnd-mime.js';
import { startDrag } from '../splitters.js';
import type { DragCtx, DragRect, DragStartEvent } from '../splitters.js';
import type { App, ActionsRegistry } from '../app.types.js';
import type { EditorPort } from '../../editor/editor-port.types.js';
import type { SpecEditorPort, SpecDiagnostic } from '../../editor/spec-editor.types.js';
import type { QueryDocumentSession } from '../../application/query-document-session.js';
import type { AppPreferences, PreferenceKey } from '../../application/app-preferences.js';
import type { WorkbenchSession } from './workbench-session.js';

/** `mountWorkbenchShell`'s dependency bag. See this file's header comment for
 *  the `app` field's rationale — every other field is read directly by this
 *  shell's own logic, never through `app.*`. */
export interface WorkbenchShellDeps {
  /** The full controller, kept ONLY for: the render-module pass-through
   *  (renderTabs/renderResults), `app.dom` population (other modules read
   *  `app.dom.*` directly), and assigning `app.updateEditorModeUi`/
   *  `app.syncSelection` back onto the real object (other app.ts closures and
   *  other modules read them off it). The shell's own logic below never reads
   *  `app.*` beyond these three uses — see the fields below for everything
   *  else. */
  app: App;
  document: Document;
  state: State;
  actions: ActionsRegistry;
  sqlEditor: EditorPort;
  specEditor: SpecEditorPort;
  /** The route-scoped run/runScript/runEntry/cancel session (#276 Phase 3a) —
   *  only `attachShell` is called here; the 3 run-coupled effects it wires
   *  are the session's own (see workbench-session.ts). */
  workbench: Pick<WorkbenchSession, 'attachShell'>;
  queryDoc: Pick<QueryDocumentSession, 'revalidateSpecDrafts'>;
  prefs: Pick<AppPreferences, 'save'>;
  /** The host `ui/app-shell.ts`'s `mountAppShell` owns — this shell appends
   *  its own `workbenchEl` into it instead of building the surrounding
   *  header/sidebar/mobile-nav frame. */
  queryHost: HTMLElement;
  activeTab(): Tab;
  updateSaveBtn(): void;
  specBlocked(tab: Tab): boolean;
  renderVarStrip(): void;
  setRunBtn(running: boolean, gate?: { missing: string[]; invalid: string[]; errors: string[] }): void;
  setExportBtn(exporting: boolean): void;
  startDrag: typeof startDrag;
}

/** Build the query column and mount it into `deps.queryHost`. Ported
 *  byte-identically from this module's former body, which was itself ported
 *  byte-identically from app.ts's former `renderApp` body (#276 Phase 5) —
 *  every ordering comment below is original. */
export function mountWorkbenchShell(deps: WorkbenchShellDeps): () => void {
  const {
    app, document: doc, state, actions, sqlEditor, specEditor,
    queryDoc, prefs, queryHost, activeTab, updateSaveBtn, specBlocked, renderVarStrip,
    setRunBtn, setExportBtn, startDrag: doStartDrag,
  } = deps;

  // Only 'row' (editor/results split) runs through this ctx — the sidebar's
  // 'col'/'sideRow' splitters are app-shell's own, over elements this shell
  // has no business touching.
  const rectFor = (): DragRect => ({ top: app.dom.editorRegion!.getBoundingClientRect().top, bottom: app.dom.resultsRegion!.getBoundingClientRect().bottom });
  const dragCtx: DragCtx = {
    state,
    rectFor,
    apply: (axis, value) => { app.dom.editorRegion!.style.height = value + '%'; },
    save: (name, value) => prefs.save(name as PreferenceKey, value),
  };

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
  queryHost.appendChild(workbenchEl);

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
    // #457: the hovered title has to match the refusal `resolveEditorMode` would
    // give. A variable document is refused for a different reason than an unsaved
    // query, and telling its user to "save this query" names an action that does
    // not exist for them.
    app.dom.specModeBtn!.title = linked
      ? 'Edit saved-query Spec JSON'
      : variableDoc(tab) !== null
        ? 'A dashboard variable has no Spec.'
        : 'Save this query to create an editable Spec.';
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
    // #466/#501-review: a new/closed/switched tab changes the `tabs` SIGNAL
    // itself, which this effect reacts to — so this is the one place that
    // re-syncs the `beforeunload` guard for THAT case. An in-place
    // `dirtySql`/`dirtySpec` mutation never reaches here at all; that case is
    // `actions.rerenderTabs`'s job (`app.ts`).
    app.syncBeforeUnload();
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
  // `setMobileBadge` writes into `app.dom.mobileBadge` — an app-shell-owned
  // element (see app-shell.ts's own comment at its creation) — that crossing
  // is deliberate: the badge summarizes THIS shell's run state, not the
  // mobile nav's own concern.
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
  return () => {
    for (const dispose of disposers) dispose();
    doc.removeEventListener('selectionchange', app.syncSelection!);
  };
}
