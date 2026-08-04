// #587 — the side-panel registry: the single place that maps each side-panel
// id to what a container needs to HOST it (a label, an icon factory, an
// accessible label, an optional live tab adornment) and to MOUNT it (a
// persistent host element + a `MountedSidePanel` lifecycle controller). The
// generic tab-row renderer (`renderSidePanelTabs`) and the generic activation
// dispatcher (`buildSidePanelRegistry`'s `showPanel`) are the reason adding a
// panel never touches `app-shell.ts`, `app-preferences.ts`, `state.ts`, or
// `workbench-session.ts` (#587 AC5) — this module's own
// `buildProductionSidePanelRegistry` (below) is now the ONE place the four
// real panel defs are listed, so `app-shell.ts` names no concrete panel at
// all: it hands this factory the two upper hosts it built and `app`, nothing
// more (PR #600 review, #587 finding 1 — the composition literally used to
// live in `app-shell.ts`, which is exactly what AC5 forbids).
//
// Persistent hosts, built ONCE and never rebuilt (#587 AC6, carried over from
// #487 phase 2's `nav-sections.ts`): switching panels only flips `hidden`.
// That is what preserves, by construction rather than by save/restore logic,
// each panel's own search text/focus, scroll, and any lazily-loaded content —
// across BOTH panes uniformly now, not just the upper one (#426's original
// scope). `mount(host)` therefore runs exactly ONCE per shell lifetime, at
// registry construction — never once per activation (the issue's own Tests
// wording says "per activation", which directly contradicts persistent hosts;
// AC6 is the binding decision here, see docs/ADR-0004's #587 addendum).
// `activate`/`deactivate`/`render` run on every transition instead, and
// `dispose` once, at shell teardown.

import { h } from './dom.js';
import { SIDE_PANELS } from '../core/side-panels.js';
import type { SidePanelId, SidePanelPane } from '../core/side-panels.js';
import { databasesPanelDef, dashboardsPanelDef } from './sidebar-upper.js';
import type { SidebarUpperHandle } from './sidebar-upper.js';
import { libraryPanelDef, historyPanelDef } from './saved-history.js';
import type { App } from './app.types.js';
import type {
  MountedSidePanel, SidePanelDef, SidePanelEntry, SidePanelRegistry,
} from './side-panel-registry.types.js';

// Re-exported verbatim so every existing importer of these names from THIS
// module keeps working unchanged (`app-shell.ts`, the unit/e2e fixtures).
// The interfaces themselves now live in `side-panel-registry.types.ts` — see
// that file's own header comment for why: `sidebar-upper.ts`/
// `saved-history.ts` need these TYPES, and this module needs THEIR concrete
// `*PanelDef` factories at runtime (the import two lines above), and having
// both edges point through this module would be a real module-graph cycle.
export type { MountedSidePanel, SidePanelDef, SidePanelEntry, SidePanelRegistry };

/** Build a registry from an explicit list of defs — the generic core every
 *  production/test caller goes through. Exported so a test can inject a fake
 *  def (#587 AC5's runtime proof) without touching any of the four files this
 *  issue forbids editing to add a panel. */
export function buildSidePanelRegistry(defs: readonly SidePanelDef[]): SidePanelRegistry {
  const entries: SidePanelEntry[] = defs.map((def) => {
    const host = def.host ?? h('div', { class: 'side-panel-host', 'data-panel': def.id, hidden: true });
    const mounted = def.mount(host);
    return {
      id: def.id, pane: def.pane, label: def.label, icon: def.icon,
      accessibleLabel: def.accessibleLabel, tabAdornment: def.tabAdornment,
      host, mounted,
    };
  });
  // Reject a duplicate id at CONSTRUCTION (PR #600 review, round 4). Nothing
  // upstream enforces uniqueness: `Record<SidePanelId, …>` cannot, because a
  // TypeScript union collapses duplicates, so a second manifest row reusing an
  // existing id needs no additional key; and the manifest-parity test cannot,
  // because it compares the registry against the same duplicated manifest and
  // both sides mirror the duplicate. This seam also accepts arbitrary INJECTED
  // defs (the AC5 fake-panel proof, the e2e fixture), which are not
  // manifest-backed at all, so the check has to live here.
  //
  // Failing loudly beats the silent breakage a duplicate causes: `byId` below
  // would keep only the LAST entry; the normalize loop would leave BOTH hosts
  // visible (each one's id equals its pane's default active id); and
  // `showPanel` skips every candidate whose id equals its target, so it could
  // never hide the shadowed sibling — a permanently double-rendered pane.
  const seen = new Set<SidePanelId>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`side-panel-registry: duplicate panel id "${entry.id}"`);
    seen.add(entry.id);
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  // One "currently active" id per pane, defaulting to the FIRST entry
  // declared for that pane (matches every pane's existing default: Databases
  // above, Library below) — corrected to the real value by the caller's own
  // reactive exposure effect on its very first run, exactly like #426's
  // upper-pane handle already worked.
  const activeByPane = new Map<SidePanelPane, SidePanelId>();
  for (const entry of entries) if (!activeByPane.has(entry.pane)) activeByPane.set(entry.pane, entry.id);
  // Normalize each host's initial `hidden` to match its pane's default active
  // id — WITHOUT firing `activate`/`render` (those run only on an explicit
  // `showPanel` call, exactly like #426's upper-pane handle already worked:
  // the caller's own reactive exposure effect performs the very first
  // `showPanel`, synchronously, immediately after construction). This just
  // means an already-correctly-shown default panel's first real activation
  // is not reported as a transition.
  for (const candidate of entries) candidate.host.hidden = activeByPane.get(candidate.pane) !== candidate.id;

  const entry = (id: SidePanelId): SidePanelEntry => {
    const found = byId.get(id);
    if (!found) throw new Error(`side-panel-registry: unknown panel id "${id}"`);
    return found;
  };

  const showPanel = (id: SidePanelId): void => {
    const target = entry(id);
    // Two passes, deliberately — see the ordering contract in this method's
    // own interface doc above. Pass 1 tears down EVERY other visible sibling
    // in the target's pane first, so a sibling's `deactivate` (which may
    // clear state the target's own `render` reads, e.g. the shared library
    // filter) can never run after the target has already painted. Pass 2
    // then reveals/activates/renders the target, once every sibling's
    // teardown above is guaranteed complete. A single pass over `entries`
    // made this order-dependent on manifest position instead.
    for (const candidate of entries) {
      if (candidate.pane !== target.pane || candidate.id === id) continue;
      if (!candidate.host.hidden) {
        candidate.host.hidden = true;
        candidate.mounted.deactivate?.();
      }
    }
    if (target.host.hidden) {
      target.host.hidden = false;
      target.mounted.activate?.();
    }
    target.mounted.render();
    activeByPane.set(target.pane, id);
  };

  const activeId = (pane: SidePanelPane): SidePanelId => {
    // `!`: every pane present in `entries` got a default above; a pane with no
    // entries at all is a construction error, not a runtime one.
    return activeByPane.get(pane)!;
  };

  return {
    entries,
    entry,
    showPanel,
    activeId,
    refreshActiveSidePanels: () => { entry(activeId('lower')).mounted.render(); },
    notifyRunComplete: () => { entry(activeId('lower')).mounted.onRunComplete?.(); },
    dispose: () => { for (const e of entries) e.mounted.dispose(); },
  };
}

type ProductionUpperHosts = Pick<SidebarUpperHandle, 'databasesHost' | 'dashboardsHost'>;

/**
 * One production factory per `SidePanelId`, keyed by a `Record` over the
 * FULL manifest-derived union — adding a `SIDE_PANELS` row without adding its
 * key here is a **compile error** ("Property … is missing"), not a silent
 * gap a test would need to catch (PR #600 review round 3, finding 1: the old
 * hand-written four-call array could drift from the manifest with nothing
 * red). Every factory takes the same `(app, upperHosts)` shape so this stays
 * a plain exhaustive map rather than special-casing at the call site: the two
 * upper factories read `upperHosts`, the two lower ones ignore it.
 */
const SIDE_PANEL_FACTORIES: Record<SidePanelId, (app: App, upperHosts: ProductionUpperHosts) => SidePanelDef> = {
  databases: (app, upperHosts) => databasesPanelDef(app, upperHosts.databasesHost),
  dashboards: (app, upperHosts) => dashboardsPanelDef(app, upperHosts.dashboardsHost),
  library: (app) => libraryPanelDef(app),
  history: (app) => historyPanelDef(app),
};

/**
 * The ONE production wiring: all four real panels (Databases/Dashboards over
 * the upper pane's existing hosts; Library/History over fresh persistent
 * hosts `buildSidePanelRegistry` builds for them), through the exact same
 * generic core every other caller (tests, the `dashboard-membership.html` e2e
 * fixture) goes through. `app-shell.ts` calls only this — it hands over the
 * two upper hosts it already built and `app`, and never imports a concrete
 * panel-def factory or names a panel id/label itself (#587 AC5). The def list
 * is built by mapping over `SIDE_PANELS` itself (not a separately hand-written
 * order), so panel ORDER is decided by the manifest alone; the `SIDE_PANELS.map`
 * below reads each row's own `id` to look up its factory, so a mismatched
 * `pane` on a def is still possible in principle (defs are independent
 * objects) and is what `tests/unit/side-panel-registry.test.ts`'s parity
 * check exists to catch. Adding a fifth panel means adding one row to
 * `SIDE_PANELS`, one key to `SIDE_PANEL_FACTORIES` above (TypeScript refuses
 * to compile without it), and that panel's own module — never touching
 * `app-shell.ts`.
 */
export function buildProductionSidePanelRegistry(
  app: App,
  upperHosts: ProductionUpperHosts,
): SidePanelRegistry {
  return buildSidePanelRegistry(SIDE_PANELS.map((spec) => SIDE_PANEL_FACTORIES[spec.id](app, upperHosts)));
}

/** Generic tab-row renderer, used identically for the upper and lower rows
 *  (#587 R2.1: one renderer, not a per-pane copy that could disagree about
 *  labels, icons, or the active state). Rebuilds the row's buttons — the
 *  ROW itself is a persistent container the caller owns; only its children
 *  are replaced, exactly like every other repainted-row pattern in this app
 *  (schema search stays outside the repainted schema list, etc.). */
export function renderSidePanelTabs(
  row: HTMLElement,
  entries: readonly SidePanelEntry[],
  activeId: SidePanelId,
  onSelect: (id: SidePanelId) => void,
): void {
  // #600 review finding 2 (round 2): no `aria-label` here. An explicit
  // `aria-label` on a button REPLACES the accessible name that would
  // otherwise be computed from its descendant content — and this button's
  // descendants are exactly the visible label plus `tabAdornment()` (the
  // live `.side-count` badge, e.g. "· 3"). Emitting `entry.accessibleLabel`
  // here silently deleted the count from every counted tab's accessible
  // name ("Databases · 3" became "Open Databases navigation") — a
  // regression against the pre-#587 DOM, not a fix for the "dead contract
  // surface" finding that motivated adding it. `accessibleLabel` still
  // exists on `SidePanelDef`/`SidePanelEntry` for its real consumer (see
  // that field's own doc comment) — it is simply never read here.
  row.replaceChildren(...entries.map((entry) => h('button', {
    class: 'side-tab' + (entry.id === activeId ? ' active' : ''),
    type: 'button',
    'aria-pressed': entry.id === activeId ? 'true' : 'false',
    onclick: () => onSelect(entry.id),
  }, entry.icon(), h('span', null, entry.label), entry.tabAdornment ? entry.tabAdornment() : null)));
}

/** The two PANES the mobile segmented control switches between (#126) — a
 *  DIFFERENT axis from the panel manifest above: `mobileTab` picks a PANE
 *  ('schema' shows the upper pane, 'library' shows the lower one), never a
 *  specific panel, and is session-only (state.ts documents this — never
 *  persisted). Kept as its own tiny table rather than derived from
 *  `SIDE_PANELS`, because "which two panes exist" and "which panels sit in a
 *  pane" are genuinely different facts; deriving one from the other here
 *  would force a same-shaped coincidence, not remove real duplication. */
export const MOBILE_PANES = [
  { pane: 'upper', seg: 'schema', label: 'Explore' },
  { pane: 'lower', seg: 'library', label: 'Library' },
] as const satisfies readonly { pane: SidePanelPane; seg: string; label: string }[];

// Re-exported so a UI caller can read the manifest through this module (its
// presentation-layer owner) without also importing `core/` directly, mirroring
// #487 phase 2's `nav-sections.ts` precedent.
export { SIDE_PANELS };
export type { SidePanelId, SidePanelPane } from '../core/side-panels.js';
