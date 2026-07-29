// The navigation section registry (#487 phase 2) — the one place that maps each
// `LeftNavigationSection` to what a container needs in order to *host* it: a
// label, an icon, an accessible label, and its single PERSISTENT host element.
//
// Why a registry at all: the four sections live in two hard-wired pane switchers
// (`Databases | Dashboards` above, `Library | History` below), each of which knew
// both its sections' labels and its sections' DOM. Phase 3 adds a third container
// — the rail's focused drawer — that must be able to show ANY one of the four with
// no switcher inside it. Three containers over one section vocabulary is exactly
// the duplication #487's "Navigation section registry" boundary exists to prevent
// ("Maps rail sections to existing views and labels without duplicating their
// domain state").
//
// The hosts are built ONCE and never rebuilt, extending #426's `buildSidebarUpper`
// contract from the upper pane to the lower one. That is what makes #487's "Wide
// and focused presentations share and preserve all navigation state" true by
// construction rather than by restoration logic: a phase-3 mode change MOVES a
// host element between containers, and a moved element keeps its input values, its
// expansion, its lazily-loaded rows and its scroll offset. Nothing here restores
// anything, because nothing here destroys anything.
//
// What this module deliberately does NOT own: any section's rendering, search or
// domain behaviour. `buildSidebarUpper` still builds the Databases/Dashboards
// hosts and owns their exposure (this registry is handed that handle, so the
// dependency runs one way and there is no import cycle); `saved-history.ts` still
// renders the Library and History lists into the elements built below. This module
// owns only the *hosting* contract — which is why it can be the single seam all
// three containers address.

import { h } from './dom.js';
import { Icon } from './icons.js';
import { LEFT_NAV_SECTIONS } from '../core/left-nav-layout.js';
import type { LeftNavigationSection } from '../core/left-nav-layout.js';
// Re-exported so a UI caller reads the whole section vocabulary from the registry
// (its owner) without also importing `core/`. The pure decode itself lives beside
// `decodeLeftNavigationMode`, because `state.ts` applies it at the load boundary
// and cannot import `src/ui/`.
export { sectionForSidePanelKey, sidePanelKeyFor } from '../core/left-nav-layout.js';
export type { LowerNavigationSection, SidePanelKey } from '../core/left-nav-layout.js';
import type { SidebarUpperHandle } from './sidebar-upper.js';
import type { AppDom } from './app.types.js';

/** The slice of `app` the registry needs — the four lower-pane elements it
 *  attaches to `app.dom`, which `saved-history.ts` then renders into. A real
 *  `App` satisfies it directly. */
export interface NavSectionsApp {
  dom: Pick<AppDom, 'savedSearch' | 'savedList' | 'historySearch' | 'historyList'>;
}

/**
 * Which wide-sidebar pane presents a section. The rail presents all four
 * identically, so this is about the WIDE presentation only — it is how
 * `showSection` knows which hosts are a section's siblings (i.e. which ones it
 * must hide in order to expose this one).
 */
export type NavSectionPane = 'upper' | 'lower';

/** A section's presentation, independent of any DOM — so a switcher tab, a rail
 *  launcher and a drawer header all name a section identically. */
export interface NavSectionMeta {
  /** The visible label, exactly as the wide switchers already show it — #427
   *  renamed the Queries tab to "Library" and that is the user-facing name. */
  readonly label: string;
  /** A FACTORY, not an element: one SVG node cannot be in the wide switcher and
   *  the rail launcher at the same time, so each caller mints its own. */
  readonly icon: () => SVGElement;
  /**
   * For a control whose visible label is absent or insufficient — phase 3's rail
   * launchers are icon-only, so this is what they announce. The strings are
   * #487's own "Rail state" table verbatim, which is why they are not simply
   * `label`: a launcher has to say what activating it *does*, and a tab that
   * already sits in a labelled switcher does not.
   */
  readonly accessibleLabel: string;
  readonly pane: NavSectionPane;
}

/**
 * The four sections' presentation, in one place. Both wide switchers and (in
 * phase 3) the rail read it, so a label or icon can never disagree between the two
 * presentations of the same section.
 */
export const NAV_SECTION_META: Readonly<Record<LeftNavigationSection, NavSectionMeta>> = {
  databases: {
    label: 'Databases', icon: Icon.database, pane: 'upper',
    accessibleLabel: 'Open Databases navigation',
  },
  dashboards: {
    label: 'Dashboards', icon: Icon.dashboard, pane: 'upper',
    accessibleLabel: 'Open Dashboards navigation',
  },
  library: {
    // "Library", not "Queries" — #427 landed, and #487's table says the label and
    // the rail tooltip follow it.
    label: 'Library', icon: Icon.layers, pane: 'lower',
    accessibleLabel: 'Open Library navigation',
  },
  history: {
    label: 'History', icon: Icon.history, pane: 'lower',
    accessibleLabel: 'Open query History',
  },
};

export interface NavSectionEntry extends NavSectionMeta {
  readonly section: LeftNavigationSection;
  /** The single persistent host. Built once, moved between containers, never
   *  rebuilt. */
  readonly host: HTMLElement;
}

export interface NavSectionRegistry {
  /** All four, in `LEFT_NAV_SECTIONS` order (rail order, top to bottom). */
  readonly entries: readonly NavSectionEntry[];
  entry(section: LeftNavigationSection): NavSectionEntry;
  /**
   * Expose exactly one section within its own pane, hiding its pane siblings.
   * A hidden host contributes no layout but keeps its DOM — the whole point.
   *
   * Scoped to the pane because the wide sidebar shows one upper section AND one
   * lower section simultaneously; a global "exactly one of four" would blank half
   * the sidebar. Phase 3's drawer shows one of four, and gets there by moving the
   * host rather than by widening this rule.
   */
  showSection(section: LeftNavigationSection): void;
}

/** A section host: the wrapper a container mounts, and the element `showSection`
 *  toggles. The same class for all four, so phase 3's drawer needs no per-section
 *  layout rule. */
const sectionHost = (section: LeftNavigationSection, hidden: boolean, ...content: Node[]): HTMLElement =>
  h('div', { class: 'nav-section-host', 'data-section': section, hidden }, ...content);

/**
 * Build the registry. Called once per shell mount, right after the `app.dom` reset
 * — every host it owns is a singleton for the life of that shell.
 *
 * `upper` is #426's already-built upper pane: the registry adopts its two hosts
 * and delegates their exposure back to it, rather than reaching into another
 * module's DOM. The lower pane has no such owner, so the registry builds its two
 * hosts here.
 */
export function buildNavSectionRegistry(
  app: NavSectionsApp, upper: SidebarUpperHandle,
): NavSectionRegistry {
  // Each lower section gets its OWN search box and list. Before #487 both rendered
  // through one shared pair that a section switch repainted — workable for two tabs
  // in one pane, but it cannot satisfy "search/expansion/scroll state survives
  // section and mode changes" for phase 3's drawer, and it cannot be moved into the
  // drawer without taking the other section's content along. Two persistent pairs
  // is the same shape the upper pane has had since #426.
  app.dom.savedSearch = h('div', { class: 'saved-search' });
  app.dom.savedList = h('div', { class: 'saved-list' });
  app.dom.historySearch = h('div', { class: 'saved-search' });
  app.dom.historyList = h('div', { class: 'saved-list' });

  // The initially-exposed section per pane matches what each pane's own default
  // has always been (Databases above, Library below); the shell's exposure effects
  // correct both on their first, registration-time run anyway.
  const hosts: Readonly<Record<LeftNavigationSection, HTMLElement>> = {
    databases: upper.databasesHost,
    dashboards: upper.dashboardsHost,
    library: sectionHost('library', false, app.dom.savedSearch, app.dom.savedList),
    history: sectionHost('history', true, app.dom.historySearch, app.dom.historyList),
  };

  const entries: readonly NavSectionEntry[] = LEFT_NAV_SECTIONS.map((section) => ({
    section, host: hosts[section], ...NAV_SECTION_META[section],
  }));
  const bySection = new Map(entries.map((entry) => [entry.section, entry]));

  // Each pane exposes its own sections. The upper pane DELEGATES to #426's
  // `showRole`, which has owned that pair's exposure since it was written — this
  // registry unifies how the containers *address* a section, it does not take over
  // another module's hosts. The ternary keeps `showUpper` total without a cast:
  // `pane` is a runtime value TypeScript cannot narrow the section union by, and
  // only the upper pane's own two sections ever reach it.
  const showUpper = (section: LeftNavigationSection): void =>
    upper.showRole(section === 'dashboards' ? 'dashboards' : 'databases');
  const showLower = (section: LeftNavigationSection): void => {
    hosts.library.hidden = section !== 'library';
    hosts.history.hidden = section !== 'history';
  };
  const showers: Readonly<Record<NavSectionPane, (section: LeftNavigationSection) => void>> = {
    upper: showUpper, lower: showLower,
  };

  return {
    entries,
    // `!`: `entries` is built from LEFT_NAV_SECTIONS, so the map has every member
    // of the `LeftNavigationSection` union as a key.
    entry: (section) => bySection.get(section)!,
    showSection: (section) => { showers[NAV_SECTION_META[section].pane](section); },
  };
}
