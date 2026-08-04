// #587 — the side-panel registry: the single place that maps each side-panel
// id to what a container needs to HOST it (a label, an icon factory, an
// accessible label, an optional live tab adornment) and to MOUNT it (a
// persistent host element + a `MountedSidePanel` lifecycle controller). The
// generic tab-row renderer (`renderSidePanelTabs`) and the generic activation
// dispatcher (`buildSidePanelRegistry`'s `showPanel`) are the reason adding a
// panel never touches `app-shell.ts`, `app-preferences.ts`, `state.ts`, or
// `workbench-session.ts` (#587 AC5) — those files address panels only through
// this module's exports.
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

/** What a mounted panel exposes to the registry after `mount(host)` runs once.
 *  Switching panels never calls `mount` again — only these. */
export interface MountedSidePanel {
  /** Refresh this panel's content from current state. Called once right after
   *  `mount`, and again on every activation (#587 R2.6: a persistent HIDDEN
   *  host must never show stale DOM once it becomes visible again). */
  render(): void;
  /** Runs when this panel transitions from hidden to visible, BEFORE `render`. */
  activate?(): void;
  /** Runs when this panel transitions from visible to hidden. */
  deactivate?(): void;
  /** Fires after a clean query/script run, but ONLY when this panel is the
   *  active one in its pane (dispatch is scoped by the caller, not by this
   *  hook checking its own visibility) — issue Deliverable 1 names this
   *  `onRunComplete`; only the History panel defines it today. */
  onRunComplete?(): void;
  /** Runs once, at shell disposal. */
  dispose(): void;
}

/** A panel's complete presentation + behaviour, independent of any DOM until
 *  `mount` runs. */
export interface SidePanelDef {
  readonly id: SidePanelId;
  readonly pane: SidePanelPane;
  /** The visible label, exactly as today's switchers show it. */
  readonly label: string;
  /** A FACTORY, not a prebuilt element — a tab row and (in principle) any
   *  other presentation each mint their own node from the same source. */
  readonly icon: () => SVGElement;
  /** For a control whose visible label is absent or insufficient. Kept
   *  separate from `label` (a proven #487 phase-2 decision, #587 AC6). */
  readonly accessibleLabel: string;
  /**
   * An optional live badge next to the label — e.g. Databases'/Dashboards'
   * row/Dashboard count, Library's live query count (#587 R2.7: three
   * `.side-count` adornments exist today; dropping them on a generic tab row
   * would be a visual regression against this issue's own non-goal). Called
   * on every tab-row repaint; `null` renders nothing. History defines no
   * adornment today, matching current behaviour.
   */
  tabAdornment?(): Node | null;
  /**
   * Supply an existing host instead of letting the registry build a bare
   * generic wrapper. ONLY the upper pane's two panels use this — their hosts
   * (`upper-role-host[data-role=…]`) are read directly by e2e specs
   * (`tests/e2e/dashboard-tree.spec.js`) and predate this registry (#426);
   * preserving them verbatim avoids an unrelated selector churn. Library and
   * History get a fresh generic host.
   */
  host?: HTMLElement;
  /** Called exactly once, at registry construction, with this entry's
   *  persistent host (either the one supplied above, or a fresh generic
   *  wrapper the registry built). Appends whatever content this panel owns
   *  and returns the lifecycle controller. */
  mount(host: HTMLElement): MountedSidePanel;
}

/** A def, fully resolved: `host` is always present (built if not supplied),
 *  and `mount` has already run. */
export interface SidePanelEntry {
  readonly id: SidePanelId;
  readonly pane: SidePanelPane;
  readonly label: string;
  readonly icon: () => SVGElement;
  readonly accessibleLabel: string;
  tabAdornment?(): Node | null;
  readonly host: HTMLElement;
  readonly mounted: MountedSidePanel;
}

export interface SidePanelRegistry {
  /** All entries, in manifest order. */
  readonly entries: readonly SidePanelEntry[];
  entry(id: SidePanelId): SidePanelEntry;
  /**
   * Expose exactly one panel WITHIN ITS OWN PANE, hiding its pane siblings —
   * never a global "exactly one of N", which would blank the other pane.
   * EVERY pane sibling's `deactivate` runs BEFORE the target's `activate`/
   * `render` — a strict ordering, not an artifact of manifest/registration
   * order (review finding 1: a single pass over `entries` let an outgoing
   * panel's teardown, e.g. clearing a shared filter, run AFTER the incoming
   * panel had already rendered against the stale value, whenever the target
   * happened to be visited first). A no-op call (the panel is already
   * active) still re-renders it, so an explicit re-activation always
   * reflects current state.
   */
  showPanel(id: SidePanelId): void;
  /** The currently active panel id within `pane`. */
  activeId(pane: SidePanelPane): SidePanelId;
  /** Repaint the active LOWER-pane panel's body — the compatibility seam
   *  `renderSavedHistory(app)` (10 call sites, counted with `rg`: 5 in
   *  `saved-history.ts`, 4 in `app.ts`, 1 in `file-menu.ts` — excluding the
   *  function's own definition and import lines) delegates to this. */
  refreshActiveSidePanels(): void;
  /** Dispatch `onRunComplete` to the active LOWER-pane panel ONLY, and only if
   *  it defines the hook (#587 AC3: a clean run always calls this — today only
   *  History repaints). */
  notifyRunComplete(): void;
  /** Tear every panel down once, at shell disposal. */
  dispose(): void;
}

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
