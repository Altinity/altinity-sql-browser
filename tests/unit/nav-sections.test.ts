import { describe, it, expect, vi } from 'vitest';
import {
  buildNavSectionRegistry, NAV_SECTION_META, sectionForSidePanelKey, sidePanelKeyFor,
} from '../../src/ui/nav-sections.js';
import {
  sectionForSidePanelKey as coreSectionFor, sidePanelKeyFor as coreKeyFor,
} from '../../src/core/left-nav-layout.js';
import type { NavSectionsApp } from '../../src/ui/nav-sections.js';
import { LEFT_NAV_SECTIONS } from '../../src/core/left-nav-layout.js';
import type { SidebarUpperHandle } from '../../src/ui/sidebar-upper.js';
import { h } from '../../src/ui/dom.js';

/**
 * A stand-in for #426's upper pane. The registry ADOPTS those two hosts and
 * delegates their exposure back to `showRole`, so a fake handle is exactly the
 * right seam here — `sidebar-upper.test.ts` covers the real one, and this spec
 * proves the delegation rather than re-testing it.
 */
const upperHandle = (): SidebarUpperHandle & { showRole: ReturnType<typeof vi.fn> } => {
  const databasesHost = h('div', { class: 'nav-section-host', 'data-section': 'databases' });
  const dashboardsHost = h('div', { class: 'nav-section-host', 'data-section': 'dashboards', hidden: true });
  const showRole = vi.fn((role: 'databases' | 'dashboards') => {
    databasesHost.hidden = role !== 'databases';
    dashboardsHost.hidden = role !== 'dashboards';
  });
  return { databasesHost, dashboardsHost, showRole };
};

const build = () => {
  const app: NavSectionsApp = { dom: {} };
  const upper = upperHandle();
  const registry = buildNavSectionRegistry(app, upper);
  return { app, upper, registry };
};

describe('the library ↔ saved vocabulary bridge', () => {
  // The bridge's own behaviour is specified in `left-nav-layout.test.ts` — the
  // pure decode lives in `core/` so `state.ts` can apply it at the load boundary.
  // What matters HERE is that the registry re-exports that one implementation
  // instead of carrying a second copy: a UI caller must be unable to reach a
  // different answer than the state layer did.
  it('re-exports the core implementation, not a second copy', () => {
    expect(sidePanelKeyFor).toBe(coreKeyFor);
    expect(sectionForSidePanelKey).toBe(coreSectionFor);
  });
});

describe('NAV_SECTION_META', () => {
  it('describes all four sections with a distinct label and an icon FACTORY', () => {
    expect(Object.keys(NAV_SECTION_META).sort()).toEqual([...LEFT_NAV_SECTIONS].sort());
    const labels = LEFT_NAV_SECTIONS.map((section) => NAV_SECTION_META[section].label);
    expect(labels).toEqual(['Databases', 'Dashboards', 'Library', 'History']);
  });

  it('carries #487\'s own accessible labels for the icon-only rail launchers', () => {
    // Verbatim from the issue's "Rail state" table. Pinned as exact strings
    // because a launcher has to announce what activating it DOES — a `toBeTruthy`
    // assertion would pass for a copy-paste of the wrong section's name, and
    // phase 3 would then either announce the wrong thing or hard-code the right
    // thing beside the registry.
    expect(LEFT_NAV_SECTIONS.map((s) => NAV_SECTION_META[s].accessibleLabel)).toEqual([
      'Open Databases navigation',
      'Open Dashboards navigation',
      'Open Library navigation',
      'Open query History',
    ]);
    // Distinct from the tab label in every case, which is why it is its own field.
    for (const section of LEFT_NAV_SECTIONS) {
      expect(NAV_SECTION_META[section].accessibleLabel).not.toBe(NAV_SECTION_META[section].label);
    }
  });

  it('mints a FRESH icon per call, so two presentations can show one section at once', () => {
    // One SVG node cannot be in the wide switcher and the rail launcher
    // simultaneously — appending it to the second would remove it from the first.
    const first = NAV_SECTION_META.library.icon();
    const second = NAV_SECTION_META.library.icon();
    expect(first).not.toBe(second);
    expect(first.tagName).toBe(second.tagName);
  });

  it('places two sections in each wide pane', () => {
    const panes = LEFT_NAV_SECTIONS.map((section) => NAV_SECTION_META[section].pane);
    expect(panes).toEqual(['upper', 'upper', 'lower', 'lower']);
  });
});

describe('buildNavSectionRegistry', () => {
  it('exposes one entry per section, in rail order', () => {
    const { registry } = build();
    expect(registry.entries.map((entry) => entry.section)).toEqual([...LEFT_NAV_SECTIONS]);
    for (const section of LEFT_NAV_SECTIONS) {
      const entry = registry.entry(section);
      expect(entry.section).toBe(section);
      expect(entry.label).toBe(NAV_SECTION_META[section].label);
      expect(entry.pane).toBe(NAV_SECTION_META[section].pane);
    }
  });

  it('gives each section EXACTLY ONE host, and adopts the upper pane\'s two', () => {
    const { upper, registry } = build();
    const hosts = registry.entries.map((entry) => entry.host);

    expect(new Set(hosts).size).toBe(4);
    // The upper pane's hosts are #426's own elements, not copies — a copy would
    // silently strand every schema/Dashboard behaviour bound to the originals.
    expect(registry.entry('databases').host).toBe(upper.databasesHost);
    expect(registry.entry('dashboards').host).toBe(upper.dashboardsHost);
    for (const host of hosts) {
      expect(host.classList.contains('nav-section-host')).toBe(true);
    }
    expect(registry.entry('library').host.dataset.section).toBe('library');
    expect(registry.entry('history').host.dataset.section).toBe('history');
  });

  it('builds the lower pane\'s two search/list pairs and hands them to app.dom', () => {
    const { app, registry } = build();
    const library = registry.entry('library').host;
    const history = registry.entry('history').host;

    expect([...library.children]).toEqual([app.dom.savedSearch, app.dom.savedList]);
    expect([...history.children]).toEqual([app.dom.historySearch, app.dom.historyList]);
    // Separate elements, not one shared pair — that is the split.
    expect(app.dom.savedList).not.toBe(app.dom.historyList);
    expect(app.dom.savedSearch).not.toBe(app.dom.historySearch);
    expect(app.dom.savedSearch!.className).toBe('saved-search');
    expect(app.dom.historySearch!.className).toBe('saved-search');
    expect(app.dom.savedList!.className).toBe('saved-list');
    expect(app.dom.historyList!.className).toBe('saved-list');
  });

  it('starts each pane on its historical default section', () => {
    const { registry } = build();
    expect(registry.entry('databases').host.hidden).toBe(false);
    expect(registry.entry('dashboards').host.hidden).toBe(true);
    expect(registry.entry('library').host.hidden).toBe(false);
    expect(registry.entry('history').host.hidden).toBe(true);
  });

  it('exposes exactly one section per pane, leaving the OTHER pane alone', () => {
    const { registry } = build();
    // `!!`: `hidden` is typed `boolean | 'until-found'` in lib.dom; the registry
    // only ever assigns booleans, and the shape of the assertion is what matters.
    const hidden = (): boolean[] => registry.entries.map((entry) => !!entry.host.hidden);

    registry.showSection('history');
    // The upper pane is untouched: the wide sidebar shows one upper AND one lower
    // section at once, so a global "one of four" would blank half the sidebar.
    expect(hidden()).toEqual([false, true, true, false]);

    registry.showSection('dashboards');
    expect(hidden()).toEqual([true, false, true, false]);

    registry.showSection('library');
    expect(hidden()).toEqual([true, false, false, true]);

    registry.showSection('databases');
    expect(hidden()).toEqual([false, true, false, true]);
  });

  it('delegates upper-pane exposure to #426\'s showRole rather than setting hidden itself', () => {
    const { upper, registry } = build();

    registry.showSection('dashboards');
    registry.showSection('databases');
    expect(upper.showRole.mock.calls).toEqual([['dashboards'], ['databases']]);

    // A lower section must not reach the upper pane's owner at all.
    registry.showSection('history');
    expect(upper.showRole).toHaveBeenCalledTimes(2);
  });

  it('never rebuilds a host when exposure changes', () => {
    const { registry } = build();
    const before = registry.entries.map((entry) => entry.host);
    const marker = h('div', { class: 'sv-search-input' });
    registry.entry('history').host.appendChild(marker);

    registry.showSection('history');
    registry.showSection('library');
    registry.showSection('history');

    expect(registry.entries.map((entry) => entry.host)).toEqual(before);
    // The hidden host kept its DOM — which is what makes "wide and focused
    // presentations share and preserve all navigation state" structural.
    expect(registry.entry('history').host.contains(marker)).toBe(true);
  });
});
