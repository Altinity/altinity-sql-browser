// #587 type-only seam contracts for `ui/side-panel-registry.ts` — extracted
// (PR #600 review, #587 finding 1) so the two DOM-owning panel modules
// (`sidebar-upper.ts`, `saved-history.ts`) can import these shapes WITHOUT a
// module-graph edge back to `side-panel-registry.ts` itself. That edge is
// needed the other direction now: `side-panel-registry.ts`'s
// `buildProductionSidePanelRegistry` imports the two modules' concrete
// `*PanelDef` factories at RUNTIME (not just their types) to be the one place
// that wires all four production panels, so `app-shell.ts` can call it
// without naming a single concrete panel (#587 AC5). Had `sidebar-upper.ts`/
// `saved-history.ts` kept importing these types FROM `side-panel-registry.ts`
// directly, that would be a real cycle at the module-specifier level — ESM
// tolerates cycles at runtime, but the unbundled e2e harnesses
// (`tests/e2e/*.html`, which load `/src` as raw ESM with no bundler to
// resolve load order) are fragile against them. `import type` alone erases
// at build time and wouldn't have caused a RUNTIME cycle either, but this
// follows the repo's own established `src/**/*.types.ts` convention (ADR-0002
// phase 0) for a type-only seam rather than relying on that erasure — and
// these interfaces have no executable statements, so (like every other
// `*.types.ts` file) they carry no coverage obligation.
//
// `side-panel-registry.ts` re-exports every name below verbatim, so no
// existing importer of e.g. `SidePanelDef` from `./side-panel-registry.js`
// needs to change.

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
