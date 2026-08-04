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
      ['rightInspectorPx', 560, '560'],
      ['sidePanel', 'history', 'history'],
      ['resultRowLimit', 1000, '1000'],
    ];
    // `save` is deliberately generic (#587 AC4: `value`'s type follows
    // `name`) — this loop exercises it dynamically across every key, which a
    // generic signature can't type-check statically, so the call goes
    // through an intentionally-untyped alias rather than `as never`.
    const saveDynamic = prefs.save as (name: string, value: unknown) => void;
    for (const [name, value, expected] of cases) {
      deps.saveStr.mockClear();
      saveDynamic(name, value);
      expect(deps.saveStr).toHaveBeenCalledWith(KEYS[name], expected);
    }
  });
});

// #587 AC5's second falsifiability leg (per R2.10): a compile-time proof.
// `tsc --noEmit` (one of this repo's gates) gives the assertion below teeth —
// `@ts-expect-error` itself becomes a compile ERROR if the following line is
// NOT actually a type error, so removing the `PreferenceValues['sidePanel']`
// constraint (reverting `save` to `unknown`) would fail `check:types`, not
// just silently stop catching this at compile time.
describe('save() — compile-time contract (#587 AC4)', () => {
  it('accepts the two real SidePanelKey values, and rejects the registry id "library" both at compile time and at the raw storage seam', () => {
    const deps = makeDeps();
    const prefs = createAppPreferences(deps);
    prefs.save('sidePanel', 'saved');
    prefs.save('sidePanel', 'history');
    expect(deps.saveStr).toHaveBeenCalledTimes(2);
    // The raw storage seam must never see the registry's OWN id "library" —
    // `KEYS.sidePanel` only ever gets a real persisted `SidePanelKey`
    // ('saved'/'history'). Asserted before the compile-time trap below, so
    // this negative assertion is meaningful on its own rather than riding
    // along with a write the trap itself performs.
    expect(deps.saveStr).not.toHaveBeenCalledWith(KEYS.sidePanel, 'library');
    // Compile-time-only trap, wrapped in a function that is never invoked —
    // `tsc --noEmit` still type-checks an uncalled function body, so this
    // stays a real compile error if the `PreferenceValues['sidePanel']`
    // constraint regresses, without itself performing the very write this
    // test forbids (that write is what the assertion above already ruled
    // out, before this function is even defined).
    const neverCalled = (): void => {
      // @ts-expect-error — 'library' is the registry's OWN id, never a
      // persisted `SidePanelKey` value (see `decodeSidePanelKey`'s downgrade-
      // safety comment) — `prefs.save('sidePanel', 'library')` must not
      // type-check.
      prefs.save('sidePanel', 'library');
    };
    void neverCalled;
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
