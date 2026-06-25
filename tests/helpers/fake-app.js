// Shared test helper: a minimal `app` controller stub for exercising the UI
// render modules in isolation under happy-dom. Not under src/, so it does not
// count toward coverage.
import { vi } from 'vitest';
import dagre from '@dagrejs/dagre';
import { createState, activeTab } from '../../src/state.js';

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
    activeTab: () => activeTab(state),
    isSignedIn: () => true,
    email: () => 'me@example.com',
    savePref: vi.fn(),
    saveJSON: vi.fn(),
    saveStr: vi.fn(),
    downloadFile: vi.fn(),
    updateSaveBtn: vi.fn(),
    updateLibraryTitle: vi.fn(),
    elapsedMs: () => 0,
    editingSavedId: null,
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
      exportResult: vi.fn(),
      save: vi.fn(),
      formatQuery: vi.fn(),
      explainQuery: vi.fn(),
      setExplainView: vi.fn(),
      showSchemaGraph: vi.fn(),
      insertCreate: vi.fn(),
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
