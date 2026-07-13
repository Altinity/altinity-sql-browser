// Shared test helper: a minimal `app` controller stub for exercising the UI
// render modules in isolation under happy-dom. Not under src/, so it does not
// count toward coverage.
import { vi } from 'vitest';
import dagre from '@dagrejs/dagre';
import { createState, activeTab } from '../../src/state.js';
import { createNoopPort } from '../../src/editor/editor-port.js';

// A stand-in for the Chart.js constructor: records its canvas + config and
// exposes a destroy() spy, so the chart glue is testable without a real canvas.
export class FakeChart {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.config = config;
    this.destroyed = false;
  }
  // Mirrors Chart.js's single pointer-event entry point: results.js wraps this
  // to undo the page CSS zoom. Records the (corrected) event for assertions.
  _eventHandler(e, replay) { this.lastEvent = e; this.lastReplay = replay; }
  // Real Chart.js's resize()/update() — results.js calls these explicitly to
  // work around cross-window responsive-sizing (see renderChart's comment).
  resize(w, h) { this.lastResize = [w, h]; }
  update(mode) { this.lastUpdateMode = mode; }
  destroy() { this.destroyed = true; }
}

export function makeApp(over = {}) {
  const state = createState({ loadStr: (k, d) => d, loadJSON: (k, d) => d });
  const root = document.createElement('div');
  const app = {
    state,
    root,
    document,
    Chart: FakeChart,
    Dagre: dagre, // real dagre — it's pure (no DOM), so tests use it directly
    cssVar: () => '', // blank → chartColors() uses its dark-theme fallbacks
    chart: null,
    host: () => 'test.host',
    build: 'v0.0.0-test',
    activeTab: () => activeTab(state),
    editor: createNoopPort(), // render modules call the port unconditionally (#143)
    isSignedIn: () => true,
    // Dashboard (#149) surface: auth is resolved once before tiles fan out, the
    // Back link derives from the SPA base, and onSignedOut redirects on failure.
    ensureFreshToken: vi.fn(async () => true),
    chCtx: { onSignedOut: vi.fn() },
    basePath: '/sql',
    toggleTheme: vi.fn(),
    email: () => 'me@example.com',
    savePref: vi.fn(),
    saveVarValues: vi.fn(),
    saveFilterActive: vi.fn(),
    saveVarRecent: vi.fn(),
    saveVarRecentDisabled: vi.fn(),
    recordBoundParams: vi.fn(),
    // #185 detached-read seam: no-op by default (snapshot cases never call it);
    // interactive-rerun tests override it to stream rows into the result.
    runReadInto: vi.fn(async (result) => result),
    clearVarRecent: vi.fn(),
    clearAllVarRecent: vi.fn(),
    saveJSON: vi.fn(),
    saveStr: vi.fn(),
    downloadFile: vi.fn(),
    updateSaveBtn: vi.fn(),
    elapsedMs: () => 0,
    now: () => 0,
    wallNow: () => 0, // the #173 wave wall clock (epoch ms; fixed in tests)
    showLogin: vi.fn(),
    signOut: vi.fn(),
    loadVersion: vi.fn(),
    loadSchema: vi.fn(),
    entityDoc: vi.fn(async () => ''), // lazy hover-doc loader (#27); overridden per test
    loadIdps: async () => ({ idps: [], basicLogin: true }),
    dom: {
      qtabsInner: document.createElement('div'),
      schemaList: document.createElement('div'),
      resultsRegion: document.createElement('div'),
      savedTabsRow: document.createElement('div'),
      savedSearch: document.createElement('div'),
      savedList: document.createElement('div'),
      saveBtn: document.createElement('button'),
    },
    actions: {
      run: vi.fn(),
      cancel: vi.fn(),
      newTab: vi.fn(),
      selectTab: vi.fn(),
      closeTab: vi.fn(),
      loadIntoNewTab: vi.fn(),
      login: vi.fn(),
      connect: vi.fn(),
      share: vi.fn(),
      copyResult: vi.fn(),
      copySnapshot: vi.fn(),
      exportEntry: vi.fn(),
      exportDirect: vi.fn(),
      cancelExport: vi.fn(),
      cancelExportScript: vi.fn(),
      save: vi.fn(),
      formatQuery: vi.fn(),
      explainQuery: vi.fn(),
      setExplainView: vi.fn(),
      setResultRowLimit: vi.fn(),
      showSchemaGraph: vi.fn(),
      cancelSchemaGraph: vi.fn(),
      expandSchemaGraph: vi.fn(),
      openNodeDetail: vi.fn(),
      insertCreate: vi.fn(),
      openCreateInNewTab: vi.fn(),
      openShortcuts: vi.fn(),
      insertAtCursor: vi.fn(),
      replaceEditor: vi.fn(),
      loadColumns: vi.fn(),
      rerenderTabs: vi.fn(),
      rerenderResults: vi.fn(),
      updateSaveBtn: vi.fn(),
    },
    ...over,
  };
  return app;
}
