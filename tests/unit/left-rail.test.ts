// #487 phase 3 — the compact icon rail (`src/ui/left-rail.ts`). Exercises: the
// four launchers render with the registry's real label/accessibleLabel pair
// (asserting they differ, not merely that both are truthy), a click drives the
// REAL `toggleFocusedSection` (asserting the resulting state, not a mock of
// the function), `aria-expanded` tracks `state.leftNavSection` reactively
// without a manual re-render, and `dispose()` actually stops the effect.

import { describe, it, expect, vi } from 'vitest';
import { signal } from '@preact/signals-core';
import { buildLeftRail } from '../../src/ui/left-rail.js';
import type { LeftRailDeps } from '../../src/ui/left-rail.js';
import {
  LEFT_NAV_SECTIONS, LEFT_WIDE_DEFAULT_PX, LEFT_DRAWER_DEFAULT_PX,
} from '../../src/core/left-nav-layout.js';
import type { LeftNavigationSection } from '../../src/core/left-nav-layout.js';
import { NAV_SECTION_META } from '../../src/ui/nav-sections.js';
import type { LeftNavApp, LeftNavStateSlice } from '../../src/application/left-nav.js';
import type { SidePanelKey } from '../../src/core/left-nav-layout.js';

const DRAWER_ID = 'left-nav-drawer';

/** A fake registry: only `entry` is read, so a plain map over `NAV_SECTION_META`
 *  (the real, single source of label/icon/accessibleLabel truth) satisfies it. */
function fakeRegistry() {
  return {
    entry: (section: LeftNavigationSection) => ({
      section, host: document.createElement('div'), ...NAV_SECTION_META[section],
    }),
  };
}

/** A fake `LeftNavStateSlice` — rail mode, no section focused, Library the
 *  lower pane by default (mirrors `left-nav.test.ts`'s own `makeState`, since
 *  a rail click's resulting state is asserted through the exact same
 *  `application/left-nav.ts` this fixture is typed against). */
function makeState(over: Partial<{
  mode: 'wide' | 'rail';
  section: LeftNavigationSection | null;
  upperRole: 'databases' | 'dashboards';
  sidePanel: SidePanelKey;
}> = {}): LeftNavStateSlice {
  return {
    sidebarPx: LEFT_WIDE_DEFAULT_PX,
    leftNavDrawerPx: LEFT_DRAWER_DEFAULT_PX,
    leftNavMode: signal(over.mode ?? 'rail'),
    leftNavSection: signal(over.section ?? null),
    upperRole: signal(over.upperRole ?? 'databases'),
    sidePanel: signal(over.sidePanel ?? 'saved'),
  };
}

function makeDeps(state: LeftNavStateSlice): LeftRailDeps & { save: ReturnType<typeof vi.fn> } {
  const save = vi.fn();
  const app: LeftNavApp = { state, prefs: { save } };
  return {
    app, registry: fakeRegistry(), state, drawerElementId: DRAWER_ID, save,
  };
}

describe('buildLeftRail', () => {
  it('renders one button per LEFT_NAV_SECTIONS entry, in order', () => {
    const handle = buildLeftRail(makeDeps(makeState()));
    const buttons = Array.from(handle.el.querySelectorAll('button'));
    expect(buttons).toHaveLength(LEFT_NAV_SECTIONS.length);
    handle.dispose();
  });

  it('each button carries the registry label as title and the accessibleLabel as aria-label — distinct strings', () => {
    const handle = buildLeftRail(makeDeps(makeState()));
    const buttons = Array.from(handle.el.querySelectorAll('button'));
    LEFT_NAV_SECTIONS.forEach((section, i) => {
      const meta = NAV_SECTION_META[section];
      const btn = buttons[i];
      expect(btn.getAttribute('title')).toBe(meta.label);
      expect(btn.getAttribute('aria-label')).toBe(meta.accessibleLabel);
      expect(btn.getAttribute('title')).not.toBe(btn.getAttribute('aria-label'));
      expect(btn.getAttribute('type')).toBe('button');
      expect(btn.classList.contains('left-rail-btn')).toBe(true);
      // Icon-only: no visible text content.
      expect(btn.textContent).toBe('');
      expect(btn.querySelector('svg')).not.toBeNull();
    });
    handle.dispose();
  });

  it('every button aria-controls points at the same passed-in drawer id', () => {
    const handle = buildLeftRail(makeDeps(makeState()));
    const buttons = Array.from(handle.el.querySelectorAll('button'));
    for (const btn of buttons) expect(btn.getAttribute('aria-controls')).toBe(DRAWER_ID);
    handle.dispose();
  });

  it('each button gets its OWN icon instance, not a shared node', () => {
    const handle = buildLeftRail(makeDeps(makeState()));
    const svgs = Array.from(handle.el.querySelectorAll('svg'));
    expect(svgs).toHaveLength(LEFT_NAV_SECTIONS.length);
    for (let i = 0; i < svgs.length; i++) {
      for (let j = i + 1; j < svgs.length; j++) expect(svgs[i]).not.toBe(svgs[j]);
    }
    handle.dispose();
  });

  it('aria-expanded starts false for all four when no section is focused', () => {
    const handle = buildLeftRail(makeDeps(makeState({ section: null })));
    const buttons = Array.from(handle.el.querySelectorAll('button'));
    for (const btn of buttons) expect(btn.getAttribute('aria-expanded')).toBe('false');
    handle.dispose();
  });

  it('aria-expanded is true for exactly the focused section', () => {
    const state = makeState({ section: 'library' });
    const handle = buildLeftRail(makeDeps(state));
    const buttons = Array.from(handle.el.querySelectorAll('button'));
    LEFT_NAV_SECTIONS.forEach((section, i) => {
      expect(buttons[i].getAttribute('aria-expanded')).toBe(section === 'library' ? 'true' : 'false');
    });
    handle.dispose();
  });

  it('aria-expanded updates reactively as the signal changes, without a manual re-render', () => {
    const state = makeState({ section: null });
    const handle = buildLeftRail(makeDeps(state));
    const buttons = Array.from(handle.el.querySelectorAll('button'));
    const historyIdx = LEFT_NAV_SECTIONS.indexOf('history');
    const databasesIdx = LEFT_NAV_SECTIONS.indexOf('databases');

    state.leftNavSection.value = 'history';
    expect(buttons[historyIdx].getAttribute('aria-expanded')).toBe('true');
    expect(buttons[databasesIdx].getAttribute('aria-expanded')).toBe('false');

    state.leftNavSection.value = 'databases';
    expect(buttons[historyIdx].getAttribute('aria-expanded')).toBe('false');
    expect(buttons[databasesIdx].getAttribute('aria-expanded')).toBe('true');

    // Same DOM nodes throughout — this is an attribute update, not a rebuild.
    const stillSame = Array.from(handle.el.querySelectorAll('button'));
    expect(stillSame).toEqual(buttons);
    handle.dispose();
  });

  it('clicking a rail launcher toggles the REAL resulting state (upper section)', () => {
    const state = makeState({ mode: 'rail', section: null, upperRole: 'databases' });
    const deps = makeDeps(state);
    const handle = buildLeftRail(deps);
    const buttons = Array.from(handle.el.querySelectorAll('button'));
    const dashboardsBtn = buttons[LEFT_NAV_SECTIONS.indexOf('dashboards')];

    dashboardsBtn.click();
    expect(state.leftNavSection.value).toBe('dashboards');
    expect(state.upperRole.value).toBe('dashboards');

    // Clicking the already-open section's icon again CLOSES it (toggle, not open).
    dashboardsBtn.click();
    expect(state.leftNavSection.value).toBeNull();
    handle.dispose();
  });

  it('clicking a rail launcher for a lower section persists sidePanel via prefs.save', () => {
    const state = makeState({ mode: 'rail', section: null, sidePanel: 'saved' });
    const deps = makeDeps(state);
    const handle = buildLeftRail(deps);
    const buttons = Array.from(handle.el.querySelectorAll('button'));
    const historyBtn = buttons[LEFT_NAV_SECTIONS.indexOf('history')];

    historyBtn.click();
    expect(state.leftNavSection.value).toBe('history');
    expect(state.sidePanel.value).toBe('history');
    expect(deps.save).toHaveBeenCalledWith('sidePanel', 'history');
    handle.dispose();
  });

  it('switching between two different sections opens the new one without closing first (no toggle-off)', () => {
    const state = makeState({ mode: 'rail', section: 'library' });
    const deps = makeDeps(state);
    const handle = buildLeftRail(deps);
    const buttons = Array.from(handle.el.querySelectorAll('button'));
    buttons[LEFT_NAV_SECTIONS.indexOf('history')].click();
    expect(state.leftNavSection.value).toBe('history');
    handle.dispose();
  });

  it('dispose() stops the reactive effect — a later signal write does not update the DOM', () => {
    const state = makeState({ section: null });
    const handle = buildLeftRail(makeDeps(state));
    const buttons = Array.from(handle.el.querySelectorAll('button'));
    const databasesIdx = LEFT_NAV_SECTIONS.indexOf('databases');

    handle.dispose();
    state.leftNavSection.value = 'databases';
    expect(buttons[databasesIdx].getAttribute('aria-expanded')).toBe('false');
  });
});
