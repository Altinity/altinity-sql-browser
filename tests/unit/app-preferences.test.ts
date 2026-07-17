import { describe, it, expect, vi } from 'vitest';
import { createAppPreferences } from '../../src/application/app-preferences.js';
import type { AppPreferencesDeps, AppPreferencesStateSlice } from '../../src/application/app-preferences.js';
import { KEYS } from '../../src/state.js';

function makeDeps(over: Partial<AppPreferencesDeps> = {}): AppPreferencesDeps & { saveStr: ReturnType<typeof vi.fn> } {
  const state: AppPreferencesStateSlice = { theme: 'light' };
  return {
    saveStr: vi.fn(),
    state,
    ...over,
  } as AppPreferencesDeps & { saveStr: ReturnType<typeof vi.fn> };
}

describe('save()', () => {
  it('persists a preference under its state.ts KEYS entry, stringified', () => {
    const deps = makeDeps();
    const prefs = createAppPreferences(deps);
    prefs.save('resultRowLimit', 500);
    expect(deps.saveStr).toHaveBeenCalledWith(KEYS.resultRowLimit, '500');
  });

  it('stringifies a non-string value the same way for every preference key', () => {
    const deps = makeDeps();
    const prefs = createAppPreferences(deps);
    const cases: Array<[keyof typeof KEYS, unknown, string]> = [
      ['theme', 'dark', 'dark'],
      ['sidebarPx', 260, '260'],
      ['editorPct', 45, '45'],
      ['sideSplitPct', 58, '58'],
      ['cellDrawerPx', 560, '560'],
      ['sidePanel', 'history', 'history'],
      ['resultRowLimit', 1000, '1000'],
      ['dashLayout', 'wide', 'wide'],
      ['dashCols', 3, '3'],
    ];
    for (const [name, value, expected] of cases) {
      deps.saveStr.mockClear();
      prefs.save(name as never, value);
      expect(deps.saveStr).toHaveBeenCalledWith(KEYS[name], expected);
    }
  });
});

describe('setTheme()', () => {
  it('persists the given theme without touching state', () => {
    const deps = makeDeps();
    const prefs = createAppPreferences(deps);
    prefs.setTheme('dark');
    expect(deps.saveStr).toHaveBeenCalledWith(KEYS.theme, 'dark');
    expect(deps.state.theme).toBe('light'); // setTheme is persist-only — state.theme is toggleTheme's job
  });
});

describe('toggleTheme()', () => {
  it('flips light to dark, persists, and returns the new value', () => {
    const deps = makeDeps();
    const prefs = createAppPreferences(deps);
    expect(prefs.toggleTheme()).toBe('dark');
    expect(deps.state.theme).toBe('dark');
    expect(deps.saveStr).toHaveBeenCalledWith(KEYS.theme, 'dark');
  });

  it('flips dark back to light, persists, and returns the new value', () => {
    const deps = makeDeps({ state: { theme: 'dark' } });
    const prefs = createAppPreferences(deps);
    expect(prefs.toggleTheme()).toBe('light');
    expect(deps.state.theme).toBe('light');
    expect(deps.saveStr).toHaveBeenCalledWith(KEYS.theme, 'light');
  });
});

describe('typed per-key setters', () => {
  it('setSidebarPx persists under KEYS.sidebarPx', () => {
    const deps = makeDeps();
    createAppPreferences(deps).setSidebarPx(300);
    expect(deps.saveStr).toHaveBeenCalledWith(KEYS.sidebarPx, '300');
  });

  it('setEditorPct persists under KEYS.editorPct', () => {
    const deps = makeDeps();
    createAppPreferences(deps).setEditorPct(50);
    expect(deps.saveStr).toHaveBeenCalledWith(KEYS.editorPct, '50');
  });

  it('setSideSplitPct persists under KEYS.sideSplitPct', () => {
    const deps = makeDeps();
    createAppPreferences(deps).setSideSplitPct(62);
    expect(deps.saveStr).toHaveBeenCalledWith(KEYS.sideSplitPct, '62');
  });

  it('setCellDrawerPx persists under KEYS.cellDrawerPx', () => {
    const deps = makeDeps();
    createAppPreferences(deps).setCellDrawerPx(600);
    expect(deps.saveStr).toHaveBeenCalledWith(KEYS.cellDrawerPx, '600');
  });

  it('setSidePanel persists under KEYS.sidePanel', () => {
    const deps = makeDeps();
    createAppPreferences(deps).setSidePanel('history');
    expect(deps.saveStr).toHaveBeenCalledWith(KEYS.sidePanel, 'history');
  });

  it('setResultRowLimit persists under KEYS.resultRowLimit', () => {
    const deps = makeDeps();
    createAppPreferences(deps).setResultRowLimit(5000);
    expect(deps.saveStr).toHaveBeenCalledWith(KEYS.resultRowLimit, '5000');
  });

  it('setDashLayout persists under KEYS.dashLayout', () => {
    const deps = makeDeps();
    createAppPreferences(deps).setDashLayout('report');
    expect(deps.saveStr).toHaveBeenCalledWith(KEYS.dashLayout, 'report');
  });

  it('setDashCols persists under KEYS.dashCols', () => {
    const deps = makeDeps();
    createAppPreferences(deps).setDashCols(2);
    expect(deps.saveStr).toHaveBeenCalledWith(KEYS.dashCols, '2');
  });
});
