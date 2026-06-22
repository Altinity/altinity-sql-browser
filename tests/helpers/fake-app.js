// Shared test helper: a minimal `app` controller stub for exercising the UI
// render modules in isolation under happy-dom. Not under src/, so it does not
// count toward coverage.
import { vi } from 'vitest';
import { createState, activeTab } from '../../src/state.js';

export function makeApp(over = {}) {
  const state = createState({ loadStr: (k, d) => d, loadJSON: (k, d) => d });
  const root = document.createElement('div');
  const app = {
    state,
    root,
    document,
    host: () => 'test.host',
    activeTab: () => activeTab(state),
    isSignedIn: () => true,
    email: () => 'me@example.com',
    savePref: vi.fn(),
    saveJSON: vi.fn(),
    updateSaveBtn: vi.fn(),
    elapsedMs: () => 0,
    editingSavedId: null,
    showLogin: vi.fn(),
    signOut: vi.fn(),
    loadVersion: vi.fn(),
    loadSchema: vi.fn(),
    dom: {
      qtabsInner: document.createElement('div'),
      schemaList: document.createElement('div'),
      resultsRegion: document.createElement('div'),
      savedTabsRow: document.createElement('div'),
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
      share: vi.fn(),
      copyResult: vi.fn(),
      exportResult: vi.fn(),
      save: vi.fn(),
      exportSaved: vi.fn(),
      importSavedFile: vi.fn(),
      formatQuery: vi.fn(),
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
