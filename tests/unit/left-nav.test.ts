// #487 phase 3 — the left navigation's controller seam (`application/left-nav.ts`).
// The pure mode machine itself (`resolveRailOpen`/`resolveRailActivation`/…) is
// covered exhaustively in `left-nav-layout.test.ts`; what is tested here is the
// glue: the state-slice projection, the persistence gap the module exists to
// close (a rail/drawer selection of a lower section now persists `sidePanel`,
// matching the wide sidebar's own tab switch), and — the specific regression
// this phase's design review caught — that `openFocusedSection`/
// `toggleFocusedSection` commit as ONE atomic signals transition, never two.

import { describe, it, expect, vi } from 'vitest';
import { effect, signal } from '@preact/signals-core';
import {
  openFocusedSection, readLeftNavigationLayout, toggleFocusedSection,
} from '../../src/application/left-nav.js';
import type { LeftNavApp, LeftNavStateSlice } from '../../src/application/left-nav.js';
import {
  LEFT_DRAWER_DEFAULT_PX, LEFT_WIDE_DEFAULT_PX,
} from '../../src/core/left-nav-layout.js';
import type { LeftNavigationSection, SidePanelKey } from '../../src/core/left-nav-layout.js';

/** A fake `LeftNavStateSlice`, rail mode by default (the mode every reducer
 *  here actually acts on) with no section focused and Library as the lower
 *  pane — override via `over`. */
function makeState(over: Partial<{
  mode: 'wide' | 'rail';
  sidebarPx: number;
  leftNavDrawerPx: number;
  section: LeftNavigationSection | null;
  upperRole: 'databases' | 'dashboards';
  sidePanel: SidePanelKey;
}> = {}): LeftNavStateSlice {
  return {
    sidebarPx: over.sidebarPx ?? LEFT_WIDE_DEFAULT_PX,
    leftNavDrawerPx: over.leftNavDrawerPx ?? LEFT_DRAWER_DEFAULT_PX,
    leftNavMode: signal(over.mode ?? 'rail'),
    leftNavSection: signal(over.section ?? null),
    upperRole: signal(over.upperRole ?? 'databases'),
    sidePanel: signal(over.sidePanel ?? 'saved'),
  };
}

function makeApp(state: LeftNavStateSlice): LeftNavApp & { save: ReturnType<typeof vi.fn> } {
  const save = vi.fn();
  return { state, prefs: { save }, save };
}

describe('readLeftNavigationLayout', () => {
  it('maps every field from the state slice', () => {
    const state = makeState({
      mode: 'rail', sidebarPx: 300, leftNavDrawerPx: 200, section: 'library',
    });
    expect(readLeftNavigationLayout(state)).toEqual({
      mode: 'rail', wideWidthPx: 300, drawerWidthPx: 200, focusedSection: 'library',
    });
  });

  it('maps a wide/no-focus state too', () => {
    const state = makeState({ mode: 'wide', section: null });
    expect(readLeftNavigationLayout(state)).toEqual({
      mode: 'wide',
      wideWidthPx: LEFT_WIDE_DEFAULT_PX,
      drawerWidthPx: LEFT_DRAWER_DEFAULT_PX,
      focusedSection: null,
    });
  });
});

describe('openFocusedSection — lower sections persist sidePanel', () => {
  it('opening Library from a mismatched History state fixes both signals together', () => {
    const state = makeState({ mode: 'rail', sidePanel: 'history', section: 'history' });
    const app = makeApp(state);

    openFocusedSection(app, 'library');

    expect(state.sidePanel.value).toBe('saved');
    expect(state.leftNavSection.value).toBe('library');
    expect(app.save).toHaveBeenCalledWith('sidePanel', 'saved');
  });

  it('opening History from a mismatched Library state fixes both signals together', () => {
    const state = makeState({ mode: 'rail', sidePanel: 'saved', section: 'library' });
    const app = makeApp(state);

    openFocusedSection(app, 'history');

    expect(state.sidePanel.value).toBe('history');
    expect(state.leftNavSection.value).toBe('history');
    expect(app.save).toHaveBeenCalledWith('sidePanel', 'history');
  });

  it('does not touch lowerNavigationFilters or any field beyond the four it owns', () => {
    const state = makeState({ mode: 'rail' }) as LeftNavStateSlice & {
      lowerNavigationFilters: Record<'library' | 'history', string>;
    };
    state.lowerNavigationFilters = { library: 'unchanged-marker', history: 'also-unchanged' };
    const app = makeApp(state);

    openFocusedSection(app, 'library');

    expect(state.lowerNavigationFilters).toEqual({ library: 'unchanged-marker', history: 'also-unchanged' });
  });
});

describe('idempotent side effects — no repeated writes for an already-selected section', () => {
  it('opening the same lower section twice only persists sidePanel once (#428 bounded drag-hover re-asserts repeatedly)', () => {
    const state = makeState({ mode: 'rail', sidePanel: 'history', section: 'history' });
    const app = makeApp(state);

    openFocusedSection(app, 'library');
    expect(app.save).toHaveBeenCalledTimes(1);
    expect(state.sidePanel.value).toBe('saved');

    openFocusedSection(app, 'library');
    expect(app.save).toHaveBeenCalledTimes(1);
    expect(state.sidePanel.value).toBe('saved');
  });

  it('opening the same upper section twice does not rewrite upperRole redundantly', () => {
    const state = makeState({ mode: 'rail', upperRole: 'databases', section: 'databases' });
    const app = makeApp(state);

    openFocusedSection(app, 'databases');
    openFocusedSection(app, 'databases');

    expect(state.upperRole.value).toBe('databases');
    expect(app.save).not.toHaveBeenCalled();
  });

  it('toggleFocusedSection also skips the redundant sidePanel persistence when re-activating the open section', () => {
    const state = makeState({ mode: 'rail', sidePanel: 'saved', section: 'library' });
    const app = makeApp(state);

    // toggleFocusedSection closes the drawer on the SAME section, but the pane
    // switch itself (selectSectionInExistingPane) still runs first with the
    // section still 'library' — sidePanel is already 'saved', so no save.
    toggleFocusedSection(app, 'library');

    expect(app.save).not.toHaveBeenCalled();
    expect(state.leftNavSection.value).toBeNull();
  });
});

describe('openFocusedSection — upper sections never persist', () => {
  it('opening Dashboards from a mismatched Databases state fixes both signals, no persistence', () => {
    const state = makeState({ mode: 'rail', upperRole: 'databases', section: 'databases' });
    const app = makeApp(state);

    openFocusedSection(app, 'dashboards');

    expect(state.upperRole.value).toBe('dashboards');
    expect(state.leftNavSection.value).toBe('dashboards');
    expect(app.save).not.toHaveBeenCalled();
  });

  it('opening Databases from a mismatched Dashboards state fixes both signals, no persistence', () => {
    const state = makeState({ mode: 'rail', upperRole: 'dashboards', section: 'dashboards' });
    const app = makeApp(state);

    openFocusedSection(app, 'databases');

    expect(state.upperRole.value).toBe('databases');
    expect(state.leftNavSection.value).toBe('databases');
    expect(app.save).not.toHaveBeenCalled();
  });
});

describe('atomicity — one batched transition, not two', () => {
  it('an effect reading both the pane signal and leftNavSection runs exactly once, and only ever sees the final combination', () => {
    const state = makeState({ mode: 'rail', sidePanel: 'history', section: 'history' });
    const app = makeApp(state);

    const seen: Array<{ panel: SidePanelKey; section: LeftNavigationSection | null }> = [];
    const dispose = effect(() => {
      seen.push({ panel: state.sidePanel.value, section: state.leftNavSection.value });
    });
    // The effect above runs once on install; clear that baseline observation so
    // the assertions below are only about the call under test.
    seen.length = 0;

    openFocusedSection(app, 'library');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ panel: 'saved', section: 'library' });

    dispose();
  });

  it('same atomicity guarantee for toggleFocusedSection', () => {
    const state = makeState({ mode: 'rail', upperRole: 'databases', section: 'databases' });
    const app = makeApp(state);

    const seen: Array<{ role: 'databases' | 'dashboards'; section: LeftNavigationSection | null }> = [];
    const dispose = effect(() => {
      seen.push({ role: state.upperRole.value, section: state.leftNavSection.value });
    });
    seen.length = 0;

    toggleFocusedSection(app, 'dashboards');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ role: 'dashboards', section: 'dashboards' });

    dispose();
  });
});

describe('toggleFocusedSection — closes an already-open section', () => {
  it('toggling the section that is already focused closes the drawer (resolveRailActivation semantics)', () => {
    const state = makeState({ mode: 'rail', section: 'library', sidePanel: 'saved' });
    const app = makeApp(state);

    toggleFocusedSection(app, 'library');

    expect(state.leftNavSection.value).toBeNull();
  });

  it('toggling a DIFFERENT section than the one open focuses the new one instead (no close)', () => {
    const state = makeState({ mode: 'rail', section: 'library', sidePanel: 'saved' });
    const app = makeApp(state);

    toggleFocusedSection(app, 'history');

    expect(state.leftNavSection.value).toBe('history');
  });

  it('openFocusedSection is idempotent instead of toggling — repeated calls keep the section open', () => {
    const state = makeState({ mode: 'rail', section: 'library', sidePanel: 'saved' });
    const app = makeApp(state);

    openFocusedSection(app, 'library');

    expect(state.leftNavSection.value).toBe('library');
  });
});

describe('wide mode — no drawer, only the pane switch applies', () => {
  it('openFocusedSection in wide mode leaves mode/section alone but still switches the pane', () => {
    const state = makeState({ mode: 'wide', section: null, sidePanel: 'history' });
    const app = makeApp(state);

    openFocusedSection(app, 'library');

    expect(state.leftNavMode.value).toBe('wide');
    expect(state.leftNavSection.value).toBeNull();
    expect(state.sidePanel.value).toBe('saved');
    expect(app.save).toHaveBeenCalledWith('sidePanel', 'saved');
  });
});
