# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

GitHub Releases (cut from `v*` tags by `.github/workflows/release.yml`) carry the
auto-generated per-PR notes; this file is the curated, human-readable history.

## [Unreleased]

### Added
- **ADR-0004: retain vanilla rendering, reject the Preact migration**
  (`docs/ADR-0004-ui-shell.md`; #577). Three tagged, never-merged evaluation
  states (S0 baseline, S1 vanilla right-inspector control, S2 Preact
  treatment — `577/baseline`/`577/control`/`577/treatment`) measured over one
  18-entry superset manifest showed the treatment costing **+330 shell
  plumbing code lines (+26% over the control)** and **+7,755 B gzip**, while
  domain/island line counts stayed identical across all three states — a
  clean failure of the precommitted rule's code-dominance half, so the
  recommendation is RETAIN. #578 (the phased migration umbrella) closes as
  moot; the investment redirects to shared vanilla shell primitives tracked
  as #586 (`SurfaceLifecycle` + docked right-inspector slot), #587
  (side-panel registry), #588 (composition-root decomposition), and #589
  (dashboard gesture/repaint extraction).
- **`SurfaceLifecycle` (`src/ui/surface-lifecycle.ts`) + a docked
  `inspectorHost` slot** (#586, phase 1 of the #593 refactor umbrella).
  `.main-row` (`app-shell.ts`) gains a real, shell-owned `inspectorHost` +
  `inspectorResize` handle as layout siblings of `queryHost`/`dashboardHost`
  — never a `position: fixed` overlay. The cell-detail drawer, rows viewer,
  and Reference pane (`results.ts`/`doc-pane.ts`) all now dock into it
  through the shared `SurfaceLifecycle` open/close/Escape/focus-restore
  primitive and `inspector-host.ts`'s singleton-slot manager, replacing three
  independent hand-rolled lifecycles (`isTopDrawer`, the `.cd-backdrop` DOM
  probes/CSS, and the docs pane's own bespoke resize/keydown wiring — all
  deleted). `cellDrawerPx`/`docPanePx` collapse into one `rightInspectorPx`
  preference (compat read order: `rightInspectorPx` → `docPanePx` →
  `cellDrawerPx` → 480px default; single canonical write, and each candidate
  is validated independently so a corrupt canonical value falls through to a
  real legacy one instead of yielding `NaN`). Because the inspector is now a
  layout sibling rather than an overlay, its width is clamped **dock-aware** —
  the old flat 92vw ceiling could starve the centre surface once the panel
  took real layout space, so the ceiling now also reserves a 320px minimum for
  the centre (plus the sidebar and handles) and is recomputed whenever the
  panel unfolds or the window resizes, not once at construction. The clamp
  only ever changes the *displayed* width; the user's persisted preference is
  never narrowed by it. Docked surfaces
  are now non-modal (no keyboard-owner acquisition — the pre-#586 modal cell
  drawer blocked every app shortcut while open; this issue's docked model
  fixes that), so `app.ts`'s Query↔Dashboard surface transition and
  sign-out/connection-scope teardown now close whichever surface currently
  occupies the shared dock (`closeInspector`), not just Reference. One
  deliberate behavior change: since the dock holds only one occupant at a
  time, opening Cell while Rows is showing now REPLACES Rows instead of
  stacking a second panel on top of it (#488, the next phase, owns
  tool-registry/tab persistence semantics; not in scope here). The one
  surviving non-docked case — a cell-detail drawer opened inside a real
  detached browser tab (`results.ts`'s Data Pane) — keeps a self-contained
  modal overlay (renamed `.cell-detail-overlay`), still built on
  `SurfaceLifecycle`.
- **A side-panel registry replaces hard-composed sidebar switching** (#587,
  phase 2 of the #593 refactor umbrella). `core/side-panels.ts` is a single
  `as const satisfies` manifest (`SIDE_PANELS`: id, pane, persisted key) every
  id/pane/key union elsewhere derives from via `typeof`, plus the
  `asb:sidePanel` load-boundary decoder; `ui/side-panel-registry.ts` is the
  generic, DOM-owning half — persistent per-panel hosts built once and never
  rebuilt, a mount-once/activate-per-transition lifecycle (`MountedSidePanel`:
  `render`/`activate?`/`deactivate?`/`onRunComplete?`/`dispose`), pane-scoped
  `showPanel` (the wide sidebar shows one Databases-or-Dashboards panel AND
  one Library-or-History panel simultaneously — never a global "exactly one of
  four"), and one tab-row renderer shared by both panes. `app-shell.ts`'s
  sidebar composition, `sidebar-upper.ts` (which now only builds the two upper
  bodies — schema search+list, Dashboard search+tree — registering them
  through `databasesPanelDef`/`dashboardsPanelDef` rather than owning their
  tab-row vocabulary), and `saved-history.ts` (which stops building the lower
  tab row at all; `libraryPanelDef`/`historyPanelDef` each own one persistent
  search+list host) all address panels only through this registry now.
  `state.sidePanel: Signal<SidePanelKey>` decodes the raw stored value
  fail-closed at load (`decodeSidePanelKey`) — **this is the `'library'` ↔
  `'saved'` persisted-key bridge**: on `main` before this phase there was no
  bridge at all (a raw, unvalidated `localStorage` read), so an unrecognized
  stored value silently painted the History body with neither tab visually
  active; it now resolves to the documented default (Library), and the
  registry's own id `'library'` is never itself a persisted value (a
  downgrade-safe invariant — #591 must not re-implement this bridge).
  `app-preferences.ts`'s `save` is now generic over a `PreferenceValues` map,
  so `prefs.save('sidePanel', 'library')` is a compile error, not a runtime
  discipline. `workbench-session.ts` drops `sidePanel` from
  `WorkbenchStateSlice` entirely and renames `WorkbenchHooks.renderSavedHistory`
  to `onRunComplete` (fired unconditionally on a clean run now — dispatch to
  whichever panel, if any, is scoped entirely to the hook's own wiring in
  `app.ts`, via `app.shell.sidePanels.notifyRunComplete()`). The three
  `AppDom` fields the per-panel pattern used (`savedList`/`savedSearch`/
  `savedTabsRow`) are gone; adding a panel now touches only the registry's two
  files plus the panel's own module. Two criteria are adapted from the
  issue's literal wording (recorded as deliberate, not missed): mount-once-
  per-shell lifecycle wins over the issue's Tests-section "per activation"
  phrasing, which contradicts the persistent-host decision the same issue's
  Deliverable/AC6 makes binding; and the registry is two files
  (`core/side-panels.ts` + `ui/side-panel-registry.ts`), not the "(one file)"
  AC5 names, forced by this repo's core/no-DOM purity rule.
- **Fail-closed decoders for the five remaining persisted-domain reads in
  `createState`** (#591, phase 3 of the #593 refactor umbrella). Every
  localStorage-backed field `state.ts` still trusted via a raw `as` cast —
  `varValues`, `filterActive`, `varRecent`, `varRecentDisabled`, `history` —
  now decodes through five new pure functions in `core/state-codec.ts`
  (`decodeStoredVarValues`/`decodeStoredFilterActive`/`decodeStoredRecentMap`/
  `decodeStoredVarRecentDisabled`/`decodeStoredHistory`), the same
  `decodeStoredSavedQueries`/`decodeSidePanelKey` precedent #587 and #586
  already established for `savedQueries` and `sidePanel`. Each decoder is a
  total type-guard function over `unknown`: a malformed top level fails
  closed to the field's documented default (a fresh object/array each call,
  never shared/aliased), and a well-formed top level with malformed
  individual entries drops only those entries rather than discarding the
  whole value. `HistoryEntry` moves from `state.ts` to `core/state-codec.ts`
  (re-exported, so every existing importer keeps compiling unchanged — the
  same `ResultSort` → `core/sort.ts` precedent already in this file); its new
  `HISTORY_MAX_ENTRIES` constant replaces the literal `50` both at decode
  time and in `pushHistory`'s write-side cap, so the two can no longer drift.
  Also fixes an inherited #586 finding: `firstValidPx` (the
  `rightInspectorPx`/`docPanePx`/`cellDrawerPx` compat-read helper) used a
  bare `parseInt` + `Number.isFinite`, which silently accepts a non-numeric
  tail (`'420px'`, `'1e3'`) or reads only a leading digit (`'0x10'` → `0`) as
  "valid" — it now requires a complete, optionally-signed decimal integer
  (`/^[+-]?\d+$/` after trimming) before parsing, so a lenient-but-malformed
  canonical value correctly falls through to a real legacy fallback instead
  of a wrong number. No behavior change for well-formed persisted data; no
  change to `editorPct`/`sideSplitPct`/`cellDrawerPx`/`docPanePx` numeric
  clamping, `clamp` itself, or `decodeStoredSavedQueries`.
- **Decomposed the `createApp` composition root along four extraction seams,
  plus typed staged construction** (#588, phase 4 of the #593 refactor
  umbrella). `src/ui/app.ts` (`createApp`) shrank from ~3,246 to ~2,226 lines
  and the flat `App` interface from 112 to 105 required members, via five
  sequential, gate-green extractions: (1) `renderVarStrip`/`setRunBtn` →
  `src/ui/workbench/variable-strip.ts` (a new sibling controller, not
  `variable-bar.ts` — that module's `VariableBarApp` port is deliberately
  adapter-facing with neutral names, and the Workbench's own state doesn't
  fit it); (2) `anchoredPopover` promoted into `src/ui/popover.ts` beside the
  existing modal `openAnchoredDialog`, the save cluster
  (`updateSaveBtn`/`saveActiveQuery`/`openConflictChooser`/…) into
  `src/ui/workbench/save-controller.ts`, and the three copy-pasted
  `keyboardOwnerChannel` implementations (`file-menu.ts`/
  `library-assign-menu.ts`/`dashboard.ts`) hoisted into one
  `src/ui/keyboard-owner.ts`; (3) workspace persistence, cross-tab
  BroadcastChannel sync, refresh scheduling, and the `beforeunload` guard
  into `src/application/workspace-session.ts` (queueing/tokens/broadcast/
  listeners only — `applyCommittedWorkspace` stays in `app.ts` since it does
  real UI orchestration, not "zero DOM" as originally scoped); (4) routing
  and main-surface navigation into `src/application/surface-navigation.ts`,
  with `SurfaceCommandPort`/`DashboardFocusOutcome`/`WorkspaceRouteStatus`
  relocated to `src/application/main-surface.ts` so the new
  `src/application/*` modules never import `src/ui/` (mechanically checked
  by `check:arch`, including type-only imports); (5) the `appBase:
  Partial<App>` + `as App` cast replaced by one late-bound object literal —
  a forgotten member assignment is now a `tsc` compile error instead of a
  runtime hole (caught one for real: `App.editingLibrary` had never been
  initialized and was silently reading `undefined`). All four extractions
  are pure refactors — one pre-existing defect is deliberately **not**
  fixed: `anchoredPopover`'s stale `close()` can clobber a newer popover
  sharing the same `dom` ref slot (documented in `popover.ts` and pinned by
  a characterization test; tracked separately, not part of this phase).
  `openSavePopover`, `handleSqlPopState`, `focusDashboardMember`,
  `syncSqlRoute`, `rewriteWorkspaceRoute`, `sourceTabId`, `documentVisible`,
  `getLastCommittedToken`, `serializeWrite`, `flushWorkspaceWrites`, and
  `refreshWorkspaceFromStore` are gone from the flat `App` bag (repointed to
  `app.nav.*`/`app.workspaceSession.*` at every production consumer); `App`
  gains `nav`/`workspaceSession`.
- **Extracted `dashboardRepaintPlan` + `createTileGestureController` out of
  `renderDashboard`'s closure** (#589, phase 5 of the #593 refactor umbrella,
  3 waves plus 3 rounds of ChatGPT-review fixes; zero functional change).
  `dashboard.ts` shrank from 3,228 to 2,772 lines (-456, -14.1%) — the wave-3
  measurement was -509, but a subsequent correctness fix (restoring
  compute/apply interleaving across all six repaint decisions so a throw
  computing a later decision can never strand an earlier one's already-decided
  side effect, exactly matching pre-extraction ordering) added back ~53 lines
  of explicit per-decision orchestration, landing below AC4's ~500–700-line
  target. Reported honestly rather than restated to fit the band; the optional
  tile-chrome extraction stays out of scope for this issue regardless.
  - **Wave 1** — the repaint-decision logic that used to live as a pile of
    private `let` signature caches inside `renderDashboard`'s `effect()`
    callback now lives in `src/dashboard/application/dashboard-repaint-plan.ts`
    (`dashboardRepaintPlan`/`seedRepaintMemo`/`dashboardPersistBag`/
    `valueString`, moved verbatim) — pure, no DOM/signals imports, 100%
    covered. `dashboard.ts` asks it what to do each publish and commits the
    returned signatures onto one real `RepaintMemo` object **field-by-field,
    at the exact point each corresponding side effect runs** (never batched up
    front), preserving the pre-extraction partial-failure semantics: if one
    applier throws (e.g. the variable-persist save seam), only the memo fields
    whose side effects actually ran advance, and a later publish still owes
    whatever didn't complete. The grid-drag-cancel path's direct
    `lastGridSig = ''` signature reset is replaced by an explicit
    `gridStructureInvalidationRev` counter the planner alone consumes, rather
    than any code outside it reasoning about a raw signature value.
    (ChatGPT-review follow-up: the module is decomposed into six granular
    pure functions — `planRepublishFlow`/`planBarRebuild`/`planOptionsPush`/
    `planLabelRefresh`/`planPersist`/`planStructuralRebuild` — one per
    decision, so `dashboard.ts` can compute-and-apply each one immediately
    before computing the next, matching pre-extraction ordering exactly. The
    `dashboardRepaintPlan` composition above remains as a directly-tested
    convenience surface; production calls the six functions directly. A
    dedicated test proves the two stay equivalent.)
  - **Wave 2** — `wireTileDrag`/`wireGridResize`/the modifier-cue install (the
    Dashboard's corner-drag resize, Command/Ctrl-drag reorder, and ⌘/Ctrl
    modifier cue) now live in `src/ui/dashboard-tile-gestures.ts` behind an
    injected `TileGestureDeps` seam (document/grid/runCommand/activeEngine/
    currentStyle/gridColumns/gridPlacement/measuredGridWidth/tileOrder/
    renderedSurface/scrollHost/invalidateGridStructure); `dashboard.ts`
    constructs one fresh controller per render and calls
    `gestures.wireTileDrag`/`gestures.wireGridResize`/
    `gestures.installModifierCue` from the same call sites the pre-extraction
    functions were. Deliberately preserves — not "fixes" — two pre-existing
    latent defects a naive reading of "one gesture at a time" would not
    expect, both filed to the `inbox` for separate follow-up: (A) mixed
    drag/resize concurrency — a resize has no cross-gesture guard against an
    active drag (or vice versa) and no dedicated resize-vs-resize guard
    either; the shared "currently cancellable gesture" slot is last-writer-wins
    and self-clearing; neither gesture filters its window
    `pointermove`/`pointerup` listeners by `pointerId`; (B) a drag snapshots
    the active engine ONCE at pointerdown into its reflow-path choice while
    its rendered-surface lookups keep reading the engine live for the rest of
    that same gesture, so the two can disagree after a mid-drag engine flip.
    Filed as #606 and #607 respectively. `tests/unit/dashboard.test.ts`
    gained a dedicated "tile gesture concurrency characterization" suite
    pinning both down;
    `tests/unit/dashboard-tile-gestures.test.ts` covers the extracted module
    directly (100/100/97.74/100 stmts/funcs/branches/lines).
  - **Wave 3** — migrated `dashboard.test.ts`'s DOM-simulation gesture/resize-
    cancel mechanics assertions onto the waves 1–2 direct unit tests now that
    they cover the same ground more thoroughly: fully redundant blocks
    (no-arm/non-primary-press/action-chrome/display:contents gating, the
    modkey keydown/keyup/blur toggle, the flow point-hit-test drop-target
    mechanics, the pointercancel/blur/Escape/lostpointercapture resize-cancel
    variants, the grid clamp-to-columns-remaining math, the mid-drag
    floating/placeholder mechanics) were deleted outright; a handful were
    thinned to the one "production wiring" case per behavior the plan calls
    for (a real ⌘/Ctrl drag persists a reorder through `app.workspace.commit`;
    a real resize persists placement and survives reconciliation; a route
    rerender's teardown hook — not `dispose()` directly — cancels an in-flight
    gesture). Nothing with unique production-only value was touched: KPI-band
    regrouping, Full-view/fixed-width persistence round-trips, the real-browser
    placeholder/FLIP regressions, and the full `#338` auto-scroll suite (topbar
    offset, flow-engine interplay, scroll-frame-only recompute) all stay, since
    none of it is redundant with the new modules' isolated-DOM unit tests.
    Net result: `dashboard.test.ts` closes at 6,484 lines — 3 lines *below*
    its 6,487-line pre-Wave-1 baseline, net of the +205 lines waves 1–2 added
    for the new modules' own characterization/consumption tests (i.e. wave 3
    retired ~208 lines of assertions the direct unit tests now make
    redundant) — satisfying AC5, with the full suite still green at the
    100/95/90/100 per-file coverage floors.

### Changed
- **The committed workspace aggregate and main-surface navigation are now
  reactive signals; the #426 Dashboard-tree invalidation counter is retired**
  (#590). `app.currentWorkspace`/`app.mainSurface` become signal-backed
  accessor pairs (peeking getter, notifying setter) — a mutation is its own
  notification, so a future write path can never again forget to invalidate
  the tree, as #426/#427 did. `app.committedWorkspace`
  (`ReadonlySignal<StoredWorkspaceV5 | null>`) and `app.treeNavigation`
  (`ReadonlySignal<string>`, a `computed` structural key over exactly
  `kind`/`dashboardId`/`currentMember`) are the two tracked reads the
  `app-shell.ts` tab-count/tree/Library effects now subscribe through,
  replacing `state.dashboardTreeRevision`. `app.currentWorkspace`'s setter
  is asymmetric — it accepts no `null`; a transitional null publication
  (workspace load failure, sign-out, an external delete) is now a named
  departure operation owned by a new closure-private surface-retirement
  coordinator in `app.ts`, which atomically batches the publication with the
  disposal of any live shell so an about-to-be-torn-down surface never
  repaints against transitional state. `app.reloadDashboardRoute()` (a
  post-commit fold-and-reassign that would double-publish once the
  aggregate is signal-backed) is deleted; the Dashboard-route post-commit
  refresh is render-only. No persisted/schema change and no user-visible
  behavior change — `tests/unit/surface-lifecycle-arch.test.ts` and
  `tests/unit/surface-accessor-contracts.test.ts` back the structural/
  compile-time claims with a static-source scan and `@ts-expect-error`
  fixtures respectively.
- **The project wiki moved in-repo, as tracked `.wiki/`.** The maintainer/agent
  knowledge base is no longer a separate `altinity-sql-browser.wiki.git`
  checkout; it is now `.wiki/` in this repository, versioned with the code and
  updated in the same commits/PRs as the changes it documents (see
  `.wiki/Maintaining-This-Wiki.md`; the old wiki remote is a frozen archive).
  Reconciled its content against current reality: ADR-0004's Preact rejection,
  the 2026-08-03 `main` reset of #487 phases 1–3 (salvage branches
  `feat/left-nav-layout-core-487p1`/`feat/nav-section-registry-487p2`/
  `feat/left-rail-focused-drawer-487p3`), the #593 refactor-umbrella sequencing
  of #586–592/#585, and the V2 roadmap (#582). Also added a `CLAUDE.md`
  Working-discipline rule — issue contracts specify final-state invariants,
  not frame-by-frame gesture behavior, per ADR-0004's retrospective finding
  that the frame-level focus contract, not the code, was the dominant cost
  driver in #487/#488.
- **`VariableBarApp`'s shared activation port is now caller-neutral** (#478).
  `state.filterActive`/`params.saveFilterActive` — named after Workbench
  persistence even though Dashboard's own caller uses them for an unpersisted
  in-memory draft — are renamed to `state.activeByName`/`params.saveActive`
  on the shared `variable-bar.ts` contract only. Every persisted name and
  storage key is unchanged (`AppState.filterActive`,
  `WorkbenchParameterSession.saveFilterActive`, `effectiveFilterActive`,
  `asb:filterActive`; no storage migration). Both callers now construct an
  explicit adapter instead of a same-shape cast: Dashboard aliases its local
  draft activation map with a no-op `saveActive` (the draft is never
  persisted); detached Data aliases the real `AppState.filterActive` object
  and routes `saveActive` to `app.params.saveFilterActive()`. Pure rename +
  adapter refactor — no user-visible behavior changes.

### Fixed
- **`sql.demo.altinity.cloud` couldn't reach any host via "Advanced — connect to
  another server."** The chart-default `connectSrc` bounds CSP `connect-src` to
  a fixed 4-origin allowlist (README.md/docs/DEPLOYMENT.md's documented
  security posture — same origins as `config.hosts`), so typing any other
  ClickHouse host into the Advanced field was silently refused by the browser
  with a bare "Failed to fetch" (no CSP-violation surfaced anywhere in the UI —
  tracked separately as a UX gap, #575). This shared instance is used ad hoc
  against arbitrary clusters, so `deploy/helm/values-demo.yaml` now overrides
  `connectSrc: "https:"` (any HTTPS origin) instead of inheriting the fixed
  allowlist. The chart's own default in `helm/altinity-sql-browser/values.yaml`
  is unchanged — this only loosens the one shared demo release, trading away
  its origin-allowlist defense-in-depth for the ability to point it at any
  cluster.
- **The Dashboard tree no longer reveals two rows' pencil/trash actions at
  once, and its `· N` count now sits inline after the label** (#568). The
  hover/focus reveal rule (`.dash-tree-row:focus-within .dash-tree-act`)
  matched on any focus, so a row a user had merely clicked to select kept its
  actions visible indefinitely, alongside whichever other row the pointer was
  hovering — swapped to `:focus-visible`/`:has(:focus-visible)` (the row's own
  composite tab stop and its controls, respectively — `:has()`'s implicit
  descendant selector alone misses the row itself), which only a real
  keyboard Tab/Arrow grants, preserving reveal-on-keyboard-focus without
  pinning a clicked row open. A directly-focused action button (`.dash-tree-
  act:focus`, no `:focus-visible`) reveals only itself regardless of
  modality, so a programmatic focus-return or a test's direct `.focus()` —
  the pre-existing contract `tests/e2e/tile-open-workbench.spec.js`'s
  "Panels-row plus" test already relied on — still works. Separately,
  `Sales revenue · 2` read as a
  right-aligned
  column rather than immediately after the name (`Library · 66`'s placement,
  as `dashboard-tree-model.ts` already documented as the intent): the label
  and count are now wrapped in one flex group so only that group grows,
  matching the narrow-sidebar test's own claim.
- **A detached Data pane's variable dropdown no longer shows a frozen
  snapshot of recent values** (#478 follow-up). #555's caller-neutral
  `VariableBarApp` adapter copied `varRecent` into `state` as a plain data
  property, captured once at adapter-construction time — but unlike
  `activeByName` (aliased, mutated in place), `varRecent` is *replaced*
  wholesale on every record/clear (`workbench-parameter-session.ts`), so a
  copy went stale immediately: a detached pane's "Clear recent" persisted but
  the still-open dropdown kept listing the cleared values, and a re-run's
  newly recorded value never appeared until the pane was closed and reopened.
  The Dashboard adapter (`dashboard.ts`) had the identical staleness
  pre-dating #555. `VariableBarApp` now exposes `getVarRecent(): RecentMap`,
  a live-read callback both adapters implement by reading their own
  `varRecent` reference at call time, instead of a `state.varRecent` snapshot.
- **A Dashboard tile whose id is `__proto__` or `constructor` no longer loses
  its placement** (#551, found reviewing #549). Both are legal tile ids under
  `dashboardTileV1.id` (pattern `\S`), and a placement-map write of the shape
  `map[tileId] = placement` silently drops them: the assignment invokes the
  inherited `Object.prototype.__proto__` setter instead of creating an own
  property, so the tile falls back to the layout engine's default size.
  Worse, one read site (`grafana-grid@2`'s `setStylePlacement`, merging a new
  style onto a tile's existing style map) read the same key back before
  writing it, and for a tile id with no own entry yet that bare read resolves
  to `Object.prototype` itself — the subsequent merge-write mutated the real
  `Object.prototype` for the whole process, not just the one layout. Every
  placement-map write (`grafana-grid-layout.ts`, `flow-layout.ts`,
  `dashboard-document.ts`'s legacy-layout migrations and fallback
  regeneration, `dashboard-commands.ts`'s `duplicate-tile` and the
  flow→grafana-grid `change-layout` conversion) now goes through one shared
  `Object.defineProperty`-based helper (`defineJsonField`, already used by
  `core/saved-query.ts` for the same class of Spec/panel JSON fields), and
  every read that could be merged or mutated goes through its paired
  own-property-only counterpart (`readJsonField`), closing that
  `Object.prototype` escape.
- **Dashboard styles now persist independent dimensions and temporary column
  previews no longer mutate authored layouts** (behavioral correction to
  #535/#538). The new `grafana-grid@2` contract stores Grid `{span,height}`,
  Full `{height}`, and Report `{height}` independently. Grid defaults to 6×2,
  Full to fixed 12×2, and Report to a centered 9×5; Full and Report resize only
  vertically and expose no Widen action. Grid Widen now changes width only,
  preserving height through `span × 2` up to 12 and then wrapping to 1.
  **2 columns** and **3 columns** are fresh session previews: every tile starts
  at span 1 and exactly 300px high, saved dimensions are ignored, Widen changes
  session state only, switching/rebuilding/reloading resets them, and mobile
  collapses them to one column. Existing `grafana-grid@1` and `flow@1`
  documents normalize deterministically at codec boundaries without changing
  the Dashboard or workspace document version. A Dashboard whose primary layout
  engine this build cannot load — an unknown engine, or a future `grafana-grid`
  version — is still READ through its `flow@1` fallback, but selecting an
  authored style now fails with a diagnostic instead of stamping the requested
  preset onto a layout it cannot convert. A Dashboard that opens directly in
  Report exposes its vertical-only resize label from the first render.
  *Downgrade limitation:* a build predating `grafana-grid@2` also reads such a
  Dashboard through that fallback, but must not be used to EDIT one — it
  rewrites the fallback from placements it cannot interpret, so layout edits
  made there are lost (authored Grid/Full/Report dimensions are never touched,
  and this build regenerates the fallback deterministically on the next read).
  Gating editing on fallback use is tracked in #550.
- **`build/check-boundaries.mjs` now enforces that `src/core` stays a pure,
  reusable-logic leaf** (#455): a new `RULES` entry rejects any import from
  `src/core/**` into `src/workspace/**`, `src/application/**`, `src/ui/**`, or
  `src/net/**`, matching the invariant `src/application/main-surface.ts`
  already documented but that nothing mechanically enforced. Deliberately
  narrower than "no imports from any other layer": `src/editor` stays
  reachable, preserving the documented legacy type-only import from
  `core/saved-io.ts` to `editor/spec-editor.types.js`.
- **The typography contract now catches `openMenu`/`openConfirmMenu` classes
  supplied through options rather than an `h()` `class:` literal** (#498): a
  new `openMenu extension classes have CSS rules` test scans all of
  `src/ui/**/*.ts` for literal `menuClass`/`extraClass` values (handling
  several whitespace-separated classes per value) and, separately, the
  `goClass`/`cancelClass` values `openConfirmMenu` callers pass at their
  `dash-tree-confirm*`/`qtab-close-confirm*`/`dash-tile-confirm*` call sites
  (confirm-menu.ts forwards these as `extraClass`, so the literal lives at the
  caller, not the shared helper). A sabotage test proves the contract actually
  fails when a matching CSS rule is removed. The scan surfaced one real,
  previously uncaught gap: `dash-style-item` (the Dashboard layout-picker row,
  `dashboard.ts`) had no CSS rule at all; `src/styles.css` now gives it one.
- **`tests/unit/filter-bar.test.ts`'s 4 raw NUL bytes were already resolved**
  (#435) — the file was renamed to `tests/unit/variable-bar.test.ts` by the
  #459 filter→variable rename, which replaced the four separate literal
  NUL bytes with one `GROUP_KEY` constant built from the JavaScript escape
  sequence for code point zero, matching the escape `src/core/time-range.ts`
  uses in production. Verified no raw NUL bytes remain anywhere under `src/`
  or `tests/`; no code change was needed.

### Changed
- **Sidebar tab headers go text-only once the sidebar is dragged to 220px or
  narrower** (#552) — both the upper Databases/Dashboards role switcher and
  the lower Library/History switcher hide their icons and `· N` counts at
  that width, keeping the four labels readable, aligned and clickable with no
  clipping or overlap even at the sidebar's 180px drag minimum. A pure CSS
  container-query gate (`@container sidebar (max-width: 220px)`, named/scoped
  on `.sidebar`'s new `container-type: inline-size`) restores the full
  presentation the instant the sidebar widens past the threshold, with no JS
  state to reconcile.
- **Dashboard tree rows now use one consistent column layout for counts and
  actions, and Add panel moved to the Panels row** (#553). The Dashboard row's
  panel count now renders as the same inline `· N` right after the label that
  Variables/Panels already used, instead of competing right-aligned text next
  to the action cluster; the rightmost column is actions only. The Add panel
  (`+`) control moved from the Dashboard row to the Panels group row, since it
  creates a member of that group. #552's narrow-sidebar container query
  (`@container sidebar (max-width: 220px)`, reused verbatim — no second
  breakpoint) now also hides the Dashboard tree's `· N` counts, recovering
  space for the Dashboard/Variables/Panels labels; the count stays in each
  row's accessible name even while visually hidden, and every row's
  expand/collapse and direct actions remain reachable by mouse and keyboard.

## [0.7.2] - 2026-07-29

### Fixed
- **The Caddy container now runs under Kubernetes' no-new-privileges policy.**
  Its unneeded privileged-port capability is removed during the image build;
  the smoke test exercises the same policy.

## [0.7.1] - 2026-07-29

### Fixed
- **Dashboard tile descriptions now match the selected presentation density.**
  Full view and Report show the saved-query description beneath the tile name;
  Grid Tiles and the 2/3-column styles keep only the name visible and expose the
  description by hovering that name.
- **Deleting a panel from its tile header no longer leaves its query behind in
  Library** (#537). The tile-header trash dispatched a document-only tile
  removal, which leaves `queries` untouched — and since every panel tile is the
  sole owner of a dedicated saved-query copy (#427), that left the copy with zero
  owners, which is precisely what makes a query a Library query. A deleted panel
  therefore reappeared as an apparently standalone Library entry. The tile header
  now uses the same confirmed, ownership-proven, atomic path the Dashboards tree
  does: the tile and its dedicated query go in one commit, and the write refuses
  outright — changing nothing, with a diagnostic — for a query that is missing,
  shared, ambiguous, retargeted, or not a panel query. There is no implicit "move
  this panel query into Library" behaviour.
- **WebKit now follows Dashboard-tree keyboard focus through concealed row
  actions** (#540). Explicit, roving tab stops keep Tab on the focused row's
  chevron and actions; a pointer- or programmatically-focused row becomes the
  owner too, so returning from an action dialog continues through that row
  rather than skipping its remaining controls.
- **OAuth document-recovery E2E runs no longer reuse an incompatible stale
  harness server** (#533). Playwright now probes the fixture's server-only
  config route before accepting an existing process, preventing misleading
  ready-latch timeouts when an older static harness still owns the test port.
  The fixture also drains every intercepted startup ClickHouse request before
  arming its deliberate 401, so a late catalog success cannot mask auth loss.
- **Dashboard variable option SQL can no longer pass Run with more than 1000
  rows** (#496). The existing bounded probe still fetches one sentinel row, but
  Run now rejects that 1001-row response after column-shape validation and
  before History or detached-result source capture. Zero through 1000 raw rows
  remain valid, authored `LIMIT` text is not parsed, and transport errors or
  cancellation keep their original outcome.
- **Workbench executions now claim one shared run slot before awaiting
  authentication** (#503). Ordinary queries, scripts, and Dashboard-variable
  probes can no longer race through a pending config load or token refresh;
  cancellation during preflight prevents a late request, and operation-local
  timers, query IDs, and controllers keep stale finalisers from disrupting a
  newer run.
- **In-place authentication recovery no longer compresses the mounted
  workspace** (#512). The preserved editor or Dashboard now stays behind a
  blocking viewport overlay, rather than being pushed below a second,
  independently scrolling login region.

### Changed
- **The Docker SPA runtime now uses Caddy with build-time compression sidecars.**
  The image carries Brotli (quality 11), Zstandard (level 19), and gzip (level
  9) variants of `sql.html`; Caddy negotiates them from `Accept-Encoding` with
  `Vary: Accept-Encoding` and never compresses requests at runtime. The
  ClickHouse and release-bundle paths continue to distribute the single raw
  `sql.html` artifact.
- **A Dashboard panel tile head now carries two controls and a `⋯` menu**
  (#544). #535 had left the head with five — grip, duplicate, widen, expand,
  delete — competing with the tile title for one flex row, and a tile a single
  grid column wide has no row left to compete for. Edit mode is now
  *grip · title · widen · ⋯*; View mode is unchanged, keeping its single direct
  expand icon, because one action does not need a menu. The `⋯` always lists all
  four actions — Duplicate, Widen, Open in Workbench and run, and Remove tile —
  and each row states why it cannot run when it cannot, so nothing is merely
  absent. The inline widen is a shortcut on top of its row: a CSS container query
  withdraws it below roughly 260px of tile, where the ellipsized title has nothing
  left to give, and the row remains. **Remove now works under every layout
  style**: it was gated twice to Grid Tiles — a CSS ancestor scope and an engine
  check inside its own click handler — so Report, 2 columns and 3 columns had no
  delete at all, and a flow KPI band member had none under any style. This
  reintroduces an overflow menu on a surface #494 removed one from; that decision
  was about a two-control row in a fixed-width side pane, and is not reopened
  here.

### Added
- **Dashboard `Bool` variables now use compact tri-state checkboxes** (#530).
  Checked and unchecked emit the same canonical `true` and `false` values as
  the former choices, while the existing Clear all action restores the native
  indeterminate unset state. The shared Dashboard variable bar uses the control
  in both Dashboard variable surfaces; non-Boolean variables keep their current
  controls.
- **Same-named Workbench tabs now show their source only when disambiguation is
  needed** (#464). Colliding Dashboard tabs receive a compact Dashboard icon and
  the shortest readable title abbreviation; Library and draft collisions receive
  explicit labels, while unique tabs keep the existing compact layout. Every tab
  exposes its full source through a semantic tab control and tooltip, including
  Dashboard-variable tabs. Roving Arrow/Home/End navigation preserves focus
  through activation and close-driven strip replacement, and accessible names
  announce unsaved, externally changed, and externally deleted state. Source
  presentation is derived from the canonical saved-query/Dashboard ownership
  graph rather than stored as a second identity, and repaints immediately after
  Dashboard renames. Dirty, conflict, deleted, and close controls retain their
  established order and behavior.
- **A Dashboard panel tile head carries duplicate, widen and expand actions**
  (#535, revised by #544 above — all but widen moved into the `⋯` menu in the
  same release, and widen kept an inline button alongside its row).
  *Duplicate* (edit mode) places a copy of the panel immediately after the
  source, carrying its presentation, any local title/description and its size;
  because every panel tile solely owns a saved-query copy (#427), the copy gets
  its own dedicated clone rather than sharing the source's document. *Widen*
  (edit mode) steps a tile through the widths the active style has. The #538
  behavioral correction above makes 2/3 columns session-only previews and
  makes Grid widening horizontal-only: doubled span up to 12, then 1, with
  height preserved. Its
  label names the width the next press produces, and it hides itself under
  Report, under Full view and below the mobile breakpoint, where there is no
  width to step. *Expand* — the existing Open in Workbench action, now on the
  design's expand glyph — additionally runs the opened query on its own saved
  view and reveals the panel's Dashboards-tree row, so leaving a Dashboard no
  longer loses your place in it or lands on an empty result pane. A flow KPI
  band member gets duplicate and expand but not widen: a band ignores tile
  widths. Duplicate and expand carry the design's own glyphs; widen ships as a
  horizontal double-headed arrow rather than the design's four-way arrows, which
  are drawn at 24px and become an unreadable blob — and near-indistinguishable
  from the expand brackets beside them — at the 13px a tile head renders. This restores in-tile width authoring, which #280 phase 8 had moved
  into the Spec editor; the free-form two-dimensional resize remains the
  corner drag.
- **OAuth reauthentication now preserves dirty document work across its page
  redirect** (#512 phase 3). Before navigation, a versioned, expiring
  `sessionStorage` checkpoint captures authored tab state only and binds it to
  the OAuth attempt plus the current workspace. A successful callback loads
  the committed workspace, reconciles linked tabs, restores and revalidates raw
  Spec drafts before first render, reinstalls the dirty unload guard, and only
  then consumes the checkpoint. Results, ClickHouse session ids, credentials,
  and other execution state are never checkpointed. Failed callbacks retain
  the drafts for a state-rebound retry; malformed, expired, or
  workspace-mismatched payloads fail closed without deletion until their
  matching workspace returns. The separate tab-scoped, 15-minute
  validated-callback marker binds state and validation time to a canonical
  live-document fingerprint; a checkpoint alone is never retry authority, and expiry
  is logical eligibility rather than a promise of eager deletion. Unavailable
  workspaces and prepublication storage/validation failures retain unpublished
  recovery. Valid pending recovery suppresses legacy shared content and retries
  after authoritative workspace load without overwriting a newer document
  session—even after that work is saved clean. Changed sessions require an
  explicit Restore drafts action; the marker is retired before publication.
  Callback mismatch does not revoke unrelated pending authority. A new OAuth
  attempt invalidates older authority. Redirect preparation is transactional
  across checkpoint, marker, IdP, origin, verifier, state, and return route; the
  intentional redirect receives a one-shot unload bypass only after storage
  succeeds, and explicit Log out clears the checkpoint and marker.
- **Temporary ClickHouse authentication loss now suspends only authenticated
  execution, not the in-memory document session** (#512 phase 2, absorbing
  #502/#520/#522). A disposable, epoch-fenced execution scope coordinates
  Workbench and Dashboard queries, exports, schema graphs, catalog/reference
  loads, formatting, SHOW CREATE, and detached-result refreshes. Closing it
  aborts local work before best-effort server cancellation with an immutable
  origin and `Authorization` lease, and stale completions cannot publish into
  the next authenticated epoch; stale preflight work is also rejected before
  it can send a replacement epoch's credentials. The mounted shell, exact
  editor/tab/result objects, drafts, dirty state, route, and unload guard survive while the
  header turns red and the existing authentication controls appear inline.
  Successful Basic reauthentication installs a fresh scope and reloads
  connection metadata in place; its reusable inline form clears the password,
  resets submission state, and hides password visibility after success, ready
  for a later recovery. Inline OAuth uses Phase 3's durable document checkpoint;
  explicit Log out remains destructive.
  Async error-body classification and config discovery are epoch-fenced; refresh
  authority snapshots its epoch and rechecks it after config discovery before
  token-endpoint I/O, so stale discovery cannot replace a newer auth-header
  policy. Catalog, schema, reference, and docs transports share a
  connection-generation abort signal: `invalidate()` aborts them synchronously,
  while stale writes remain fenced.
- **Connection state now has one explicit, epoch-fenced lifecycle** (#512
  phase 1). OAuth/Basic credentials, single-flight token refresh, transport
  success/failure, auth loss, reauthentication, and explicit sign-out flow
  through `ConnectionSession`; stale refreshes cannot publish tokens or
  lifecycle state into a newer login. The accessible header chip reacts to
  that lifecycle (green connected, amber offline, red auth-required) instead
  of inferring connectivity from the best-effort server-version probe. HTTP
  query failures remain query errors and do not falsely mark the transport
  offline.
- **A Dashboard row can create a blank Panel directly from the Dashboards
  tree** (#515). Its new plus action opens the shared name/description dialog,
  then atomically commits one empty panel-role query and one canonically laid
  out tile—without selecting or copying a Library query. The action is
  keyboard-accessible, unavailable for ambiguous or 100-panel Dashboards, and
  a successful Add reveals the new Panel and opens its clean linked tab with
  focus in the SQL editor.
- **Every Library query now has a keyboard-accessible “Add to dashboard…”
  action** (#483). Its Dashboard → panel chooser uses the same assignment
  command as drag/drop, creates the same independent owned query and tile, and
  supports arrow navigation, Escape, Cancel, and focus restoration. The compact
  Plus appears on row hover or keyboard focus; a successful add switches the
  sidebar to the Dashboard tree and selects the new panel. Both chooser stages
  flip above a row near the viewport bottom, and oversized menus scroll within
  the viewport instead of placing Add/Cancel off-screen.

### Removed
- **The unused saved-query repair planner has been removed** (#429 phase 6 /
  #500). Direct, ownership-safe Panel and Dashboard trash actions are the
  supported cascading delete paths; Library deletion and saved-query edits
  continue to fail closed when whole-workspace validation would invalidate a
  live Dashboard member.

## [0.7.0] - 2026-07-27

### Added
- **Every tagged release now mirrors `sql.html` to
  `docs.altinity.com/altinity-sql-browser/sql.html`** (`docs/sql.html`,
  published by a new `release.yml` step, alongside a demo `docs/config.json`
  offering the Antalya/github.demo clusters) — a try-it-now link independent
  of any ClickHouse-served deployment. Fixed `loadConfigDoc` (`src/net/oauth-config.ts`)
  to resolve `config.json` from the containing directory when `basePath` is a
  static filename (e.g. `sql.html`) rather than a route (e.g. `/sql`), which
  this static hosting case needs and the ClickHouse route did not exercise.
- **File ▾ → Import example dashboard…** (#506): a modal dialog lists the three
  flagship example dashboards (ClickHouse Operations, Shop Charts, OnTime
  Charts) by their catalogue name; Import is disabled until one is selected,
  and Cancel/Escape/close leave the workspace untouched. Selecting one runs it
  through the exact same portable-bundle decode/validate/dependency-closure/
  commit path a file-based **Import dashboard…** uses — purely additive, so an
  existing Dashboard is never replaced or merged into. The catalogue is
  `examples/dashboard-manifest.json` (the ordered `{file, name}` source of
  truth) plus the three referenced `examples/*.json` files, compiled by the new
  `build/compile-example-dashboards.mjs` into the checked-in
  `src/generated/example-dashboards.ts` (mirroring the JSON-Schema generation
  pipeline) so the catalogue ships inside the single build artifact; `npm run
  check:examples` (wired into `prebuild`/`pretest`) fails the build on a
  missing, malformed, or stale example so one cannot ship unnoticed.

### Changed
- **`shop-charts.json` and `ontime-charts.json` moved to portable-bundle v2 /
  Dashboard document v2**, dropping their curated `filters` arrays in favor of
  inferred Variables — the phase-3 example rewrite `spec-examples.test.js` had
  been pinning them against, following `clickhouse-operations.json`'s earlier
  move (#458 follow-up). Every `from`/`to`/`country`/`category`/`carrier`/
  `origin` variable was already targeting exactly the tiles whose query
  declares its `{name:Type}` placeholder, so the curated `targets` lists these
  examples carried added nothing the placeholders didn't already say; removing
  them changes no runtime behavior. `build-ontime-charts.mjs` now passes its
  bundle's own `version` through to `writeExampleBundle` instead of silently
  reverting to v1 on its next regeneration.
- **The three flagship dashboards' Array/enum variables get real option lists
  again.** `country`/`category` (`shop-charts.json`), `carrier`/`origin`
  (`ontime-charts.json`), and `user`/`query_kind`/`exception_code`/
  `query_hash`/`metric`/`is_initial_query` (`clickhouse-operations.json`) had
  been reduced to bare freeform-text Array inputs ever since #447's mechanical
  minimum pass dropped every curated filter's `sourceQueryId` — the pre-#447
  option-source queries existed (`shop-filter-options`, `ontime-filter-options`,
  `gco-filter`) but returned one row of ARRAY-typed columns, a shape the v2
  option-SQL contract (one row per option, two String columns: value, then
  label) cannot reuse directly. Each is now ported into its own
  `variableConfigs[name].sql`, so these variables render a searchable
  (multi-)select again instead of pure freeform text, restoring the pre-#447
  browsing experience under the new inferred model.

### Fixed
- **A fresh time-range pair seeds to an active "-1d" → "now" range instead of
  empty.** Most panel queries declare their `from`/`to` (or `start`/`end`,
  `from_time`/`to_time`, `start_time`/`end_time`) variables directly in a
  required `WHERE` clause, never behind an optional `/*[ … ]*/` block — so on
  first load, before #447's curated `defaultValue` was removed, every one of
  those panels was blocked until the user set a range by hand. A
  never-persisted time-range bound (no committed value in this browser for
  this Dashboard yet) now starts at a real, running `-1d` → `now`, active from
  the first render; a variable outside every resolvable pair, or one with ANY
  already-persisted value (even a deliberately cleared one), is untouched.
- **An error toast now stays up long enough to read.** `flashToast` defaulted
  every toast — success or failure — to the same 1.6s auto-dismiss, so a
  failed open/import/save (`✕ …`, the app's established failure marker) could
  vanish before it was even fully read, let alone copied for a bug report.
  An error toast's default now runs 30s instead; a plain informational toast
  (no leading `✕`) is unchanged. An explicit `duration` passed by the caller
  still wins either way.

### Added
- **Dashboard and Panel rows act directly, and the `⋯` overflow menus are gone**
  (#494 / #429 phase 4). A Dashboard row now carries a pencil and a trash; a
  Panel row carries a pencil that edits its dedicated query's name and
  description, and a trash that removes the tile *and* that query in one atomic
  commit. Both clusters follow the Library Query row's vocabulary: revealed on
  hover and `:focus-within`, destructive action rightmost, each button
  separately named for a screen reader (`Edit Revenue`, `Remove Revenue from
  dashboard`), each keyboard-operable inside the row's single tab stop, and
  each isolated from the row's own click/Shift-click/expand gestures.

  Deleting anything **confirms first**, naming both the panel and the Dashboard
  and saying that the dedicated query copy goes too — with keyboard focus on
  Cancel, through the same `autofocus` row #501 added for the orphaned-variable
  confirm. A panel delete removes the
  tile, every layout placement (including the grafana-grid flow fallback) and
  exactly its owned query, bumps that Dashboard's revision once, and moves
  keyboard focus to the next panel row — then the previous, then the Panels
  group. An orphaned variable configuration deliberately survives.

  Edit and delete are only offered when ownership can be **proven**: the tile's
  query must exist and be owned by that one tile. A query shared between panels,
  or a reference to a query the workspace no longer carries, leaves both
  controls rendered but `aria-disabled` with the reason in their tooltip —
  nothing is ever guessed or cascade-deleted. Every dialog and confirmation
  re-resolves its target inside the write queue, so one that went stale while it
  was open commits nothing and says so.

  Every one of those operations re-proves the **exact identity** the user
  confirmed, inside the write queue: the Dashboard, the tile, the query the
  confirmation named, that the tile still references it, that exactly one
  document carries that id, and that it is a panel-role query. A tile
  re-pointed while the confirmation was open, an ambiguous id, or a reference
  to a non-panel query all refuse and say why, rather than deleting whatever
  the tile happens to point at by then.

  A fifth review pass found the Dashboard/tile identity check was looser than
  delete's own: both the tree's availability rule and the metadata guard asked
  "is there at least one match" rather than "is there exactly one", so two
  Dashboard documents sharing an id — or two tiles of the *same* Dashboard
  sharing an id, even when they reference different queries — could still
  offer a pencil that delete already refused. Both now count Dashboard and
  Dashboard-local tile ids the same pass counts query ids, and refuse
  identically. The pencil's own rapid-reactivation race is fixed too:
  replacing an already-open dialog force-closes it first, and that closing
  dialog's `onClose` used to reset the *same* trigger's `aria-expanded` back to
  `"false"` right after the new dialog had just set it `"true"` — stranding
  the trigger effectively unfocusable for as long as the replacement stayed
  open. And the viewer's tile-description override now trims before the
  fallback, matching its title override (#476): a whitespace-only description
  is schema-legal and was silently masking the query's own description with
  nothing, since the tree's own warning note already trimmed and so never
  fired for it.

  A sixth pass found the fifth round's own fix incomplete: counting duplicated
  ids made edit/delete agree with delete's stricter rule, but the row's
  *presentation* identity — `row.key`, and the `data-key` every focus
  restoration, drag highlight and the roving tabindex resolve by — still
  collapsed two ambiguous rows onto one key. A duplicated Dashboard or tile id
  could therefore put more than one row in the Tab order at once, and let
  focus/highlight resolution silently pick whichever matching DOM node came
  first. Malformed duplicates now get distinct presentation keys, and a
  Panel row's own View/Edit Dashboard-focus navigation (addressed by
  Dashboard id + tile id, unlike its still-available open-query gesture,
  addressed by query id alone) is withheld under the same ambiguity — the
  Dashboard viewer's own tile-focus lookup is keyed by tile id alone and
  would otherwise resolve the *other* duplicate. Every drop target this
  ambiguity could reach (the Dashboard row, its Panels group, and a Variable
  row) is withheld too.

  The same pass found the orphaned-variable trash still discarding its own
  commit outcome (`void commitVariableConfig(...)`) — the one destructive
  control on this row that predates this round's `reportRemoval` pattern for
  the Dashboard and Panel trash. A concurrent Dashboard deletion, a Dashboard
  that became a duplicate id, or a storage rejection all committed nothing
  and said nothing: the confirmation just closed. It now awaits and reports
  the outcome the same way, and the orphan-delete control is itself withheld
  when the Dashboard id is already known to be ambiguous.

  Not yet included: the **Open in Dashboard** focus button, which is held back
  until #438 fixes tile focus on flow-layout KPI tiles.
- **Closing a dirty tab, or leaving the page, now confirms first** (#466). The
  tab strip's close button asks before discarding an unsaved draft — a normal
  query tab or a Dashboard-variable's option SQL, saved-linked or never saved
  anywhere — instead of dropping it unconditionally; Cancel keeps the tab open
  exactly as it was. Reloading or closing the browser tab/window while any tab
  still holds an unsaved draft now shows the browser's own native confirmation
  too. Both read the same dirty predicate the tab's own dirty-dot indicator
  already used, so nothing needed reclassifying — a never-saved scratch tab
  gets the same protection as a saved query. The confirm's default keyboard
  focus is Cancel, not the destructive action, so pressing Enter right after
  opening it never discards the draft — the Dashboard tree's own orphaned-
  variable delete confirm gets the same fix (#501), same root cause. The
  page-leave warning installs and removes itself as tabs go dirty/clean
  rather than staying permanently registered, since Firefox (and older
  Chromium) exclude a page from the back/forward cache merely for having a
  `beforeunload` listener attached at all — including re-syncing immediately
  after a save that clears a draft's dirty flags while navigating away from
  its surface mid-write, rather than only on the next unrelated tab repaint.
- **A Dashboard row's pencil edits its title and description** (#429 phase 3).
  It opens a small dialog prefilled from the Dashboard's own committed
  document — Cancel and Escape commit nothing, a blank title disables Save, and
  a real commit bumps only that Dashboard's revision and refreshes the tree and
  any open Dashboard surface. (Phase 3 put this pencil beside the row's `⋯`
  menu and shipped no Dashboard trash; #494 above then removed that menu and
  added the trash, so what ships in this release is the pencil as part of the
  direct-action cluster.)
- **Drag a Library query onto a Dashboard to assign it** (#428). One drag from the
  lower Library list now has three destination-dependent meanings, and the row
  publishes two independent payloads to serve them:

  - onto a **Dashboard row or its Panels group** → an independent panel-owned
    *copy* of the query plus a tile referencing it. The Library entry is never
    modified, never removed, and keeps its favourite; repeated drops of the same
    source create genuinely independent panels rather than sharing one query. The
    new tile's placement is seeded from the source's own size hints, so a wide
    panel lands wide.
  - onto an **inferred Variables row** → the query's SQL text is copied into that
    Dashboard variable's option-SQL configuration. Only text: no clone, no tile,
    no owner, no lineage. Later edits to the Library query do not reach the copy.
  - onto the **main SQL editor** → unchanged from PR #40: the `( … )` subquery
    insertion at the drop position, still undoable, still touching no storage.

  Dashboard assignment never trusts what it reads off the drag. The payload is
  just `(workspaceId, queryId)`, re-resolved against the latest committed
  workspace inside the write queue — so a source deleted, edited, or turned
  Dashboard-owned mid-drag aborts cleanly, a drop landing after a workspace switch
  is rejected, and an ordinary same-workspace change simply rebases. Every
  assignment is one atomic, fully validated commit that bumps only the target
  Dashboard's revision, exactly once.

  Eligible destinations light up while you drag, the row under the pointer takes a
  dashed outline, and resting on a collapsed Dashboard opens it — along with both
  its groups, so Panels and Variables rows become reachable without dropping
  first. That auto-expansion is view state only: it never navigates and never
  writes. The Variables *group* is deliberately not a target (it does not say
  which variable), nor is an individual panel row or an orphaned variable.

  A successful drop **lands on what it created**: the tree expands to the new
  panel or variable row and focuses it, and the assigned document opens in the
  editor — for a panel the new owned copy (not the Library original), for a
  variable its `Variable: <name>` tab. The Dashboard itself is still never opened
  in View/Edit, and nothing is executed.

  A drop can never silently overwrite an unsaved variable draft. If the matching
  `Variable: <name>` tab has unsaved changes the assignment is refused outright
  and that tab is focused, and the check runs inside the write transaction rather
  than before it, so a keystroke landing while the commit is *queued* cannot slip
  past. A keystroke landing while the commit is *persisting* is a window no check
  can close — the write is already durable — so that case is reported instead of
  hidden: a toast that stays until you act on it explains that the tab's unsaved
  changes now differ from what was assigned, and offers **Discard draft** to adopt
  the assigned SQL. Nothing discards your typing on its own. Dropping a blank query
  is refused as a no-op rather than treated as a deletion — clearing option SQL
  stays the variable tab's explicit blank-Save.

  The empty-Dashboard message now names this route. The keyboard-accessible
  **Add to dashboard…** equivalent is tracked separately in #483; until it lands,
  assignment is pointer-only.

- **The File menu creates, imports and exports Dashboards across the whole
  workspace** (#463). Its three Dashboard commands still assumed one exact
  Dashboard was already open — a model that stopped fitting once a workspace
  could hold many. There was no way to create a Dashboard from the menu at all;
  **Import Dashboard…** was disabled on the Query surface with *Open a
  dashboard* and, where it did work, **replaced** whichever Dashboard was open;
  and **Export Dashboard…** was unavailable unless one was on screen, even with
  Dashboards sitting in the workspace to choose from.

  All three are now workspace operations:

  - **New dashboard…** — a new row, immediately after **New workspace…**. It
    asks for a name, appends an empty Dashboard to the current workspace, opens
    it in Edit mode, and switches the upper sidebar to the Dashboards tree so
    the new Dashboard is actually visible in the list that marks it selected.
    Duplicate names are allowed (identity is the id); Cancel and Escape commit
    nothing, and a rejected commit leaves navigation, the sidebar and local
    state untouched.
  - **Import dashboard…** is **additive** and available from Query, Dashboard
    View, Dashboard Edit and the empty-Dashboard placeholder whenever a writable
    workspace exists. The imported Dashboard is appended under a freshly minted
    id and opened the same way a created one is, so it can never merge into or
    replace the one you are looking at — and the destructive *Import and replace
    current Dashboard?* confirm is gone with the replacement it gated. Dependent
    queries still go through the existing conflict planner.
  - **Export dashboard…** is workspace-aware rather than surface-gated. Zero
    Dashboards disables it with *No dashboards*; the Dashboard on screen (in
    View as well as Edit) exports in one click; a sole Dashboard exports
    directly from Query too; anything else opens a chooser listing each
    Dashboard's tile count and an id fragment — widened until no two rows read
    alike — so duplicate names stay distinguishable. Both choosers focus their
    first row and keep Tab inside the dialog. Every export resolves an **exact
    id** in the workspace it was chosen from — contents and file name both: ids
    are unique within a workspace, not across them, so switching workspace while
    the export flushes pending writes cancels it instead of exporting a same-id
    Dashboard from the new one, and no export lands under the name of the
    workspace you moved to. There is no fallback to `dashboards[0]` left to
    reach.

  The menu regroups by verb — create / import / export / download — behind three
  dividers, and the two Dashboard rows drop to sentence case. Row order,
  separators, labels, availability and reason text remain the pure model's alone
  (`core/file-menu-model.ts`), and context still changes enabled state only:
  no row appears, disappears or moves when the work surface changes.

### Fixed
- **Enter on a Dashboard-tree action button ran the row's command instead of the
  button's** (#495 review). The tree's keyboard handler lives on the list and its
  Enter arm runs the focused row's action, so Enter on the rename pencil opened
  the Dashboard — and could swallow the button's own activation on the way. Every
  nested control now stops Enter/Space from propagating (without preventing the
  default, so native activation still fires exactly once), and the tree handler
  independently ignores an Enter that originated on a button. Arrow keys, Home and
  End still walk the tree from a focused control.
- **A failed Dashboard rename closed its dialog and discarded the edit** (#495
  review). The dialog now waits for the write: a Dashboard deleted in another tab,
  a duplicate id, a validation rejection or a storage failure keeps the card open
  with the typed text intact and shows one targeted message inside it. Both
  buttons are disabled while a write is in flight, so the same rename cannot be
  submitted twice.
- **Creating a Dashboard from the empty-workspace placeholder said nothing when
  the commit was rejected** (#495 review / #481). Both entry points — File ▸ New
  dashboard… and the placeholder — now run one creation command and report
  identically; each keeps its own "where to go afterwards" policy.
- **Modal dialogs were invisible to assistive technology** (#495 review). The
  shared dialog shell now marks its card `role="dialog"` with `aria-modal="true"`
  and an `aria-labelledby` pointing at its own heading, so a screen reader is told
  a modal opened and which one.
- **A Dashboard variable's Run action validates its option SQL again** (#465,
  follow-up to #457). #457 moved option SQL into a `dashboard-variable` main-editor
  tab and deleted the drawer's **Test** action along with it, but nothing replaced
  the check it performed — the ordinary Run action executed the SQL raw and
  reported a plain success even when it returned the wrong number or type of
  columns. The break surfaced later and further away: only when the Dashboard-wide
  option batch failed, as one merged `UNION ALL` column list that cannot say which
  variable's branch was at fault.

  Run on a `dashboard-variable` tab is now validated as a variable option query
  end to end. Every locally-detectable problem — blank or comment-only SQL, a
  non-`SELECT`, more than one statement, a `FORMAT` or `INTO OUTFILE` clause, a
  `{name:Type}` parameter, an optional `/*[ … ]*/` block, an unterminated string
  or comment, the reserved batch-tag column name — is reported with no request
  sent, before authentication. (A multi-statement query is rejected by name
  rather than silently handed to the ordinary script runner, which has no concept
  of this contract.) A query that passes runs through the same bounded,
  read-only single-branch probe (row cap, `max_result_bytes`, `readonly: 2`)
  the option batch's own branches run under, so Run can never accept SQL the
  batch would reject, nor pull an unbounded result of its own. Its response is
  then checked against the same shape the batch requires — exactly two
  non-nullable `String`-compatible columns (`String`, `LowCardinality(String)`,
  `FixedString(N)`) — and a shape failure is never recorded as a successful
  run (no history entry, no detached-result source); a genuinely valid run
  keeps both, exactly as it did before this fix. Ordinary query-tab Run
  behaviour is unchanged.

  The Explain button/view-switch now say so instead of silently doing the
  wrong thing on this tab: EXPLAIN has no meaning for a two-column option-SQL
  contract, and forwarding it into the new validated Run path would have run
  an ordinary probe with no indication Explain was ignored.

- **Opening a saved query resolves it before it navigates** (#443, #429). Handing
  `openSavedQuery` an id that names nothing used to switch to the Query surface
  and push a history entry first, then discover the query was missing — opening
  no tab, showing no diagnostic, and leaving the user somewhere they never asked
  to be. It now resolves first: a miss reports *"That query is no longer part of
  this workspace."* and changes no surface, no route and no tab, while a resolving id
  behaves exactly as before.

- **A whitespace-only tile title no longer blanks a heading or a screen-reader
  name** (#476, #429). `tile.title` carries no `minLength`, so a hand-authored or
  imported `"   "` is a legal document — and being truthy it beat the query-name
  fallback, leaving the visible `.dash-tile-name` empty and composing accessible
  names like *"Open, — , in Workbench"*. The Dashboard viewer now trims the
  authored title before the fallback, so such a title behaves exactly like an
  absent one and shows the query name instead. A title with surrounding
  whitespace is kept, trimmed. This changes what existing documents carrying such
  a title display; no shipped UI writes `tile.title`, so only hand-authored and
  imported documents are affected.

- **A degraded workspace export no longer loses a Dashboard** (#463). When the
  committed read is unavailable — blocked, over-quota or private-mode IndexedDB —
  the File menu rebuilds the workspace from its live projection. That projection
  has been the *selected* Dashboard since #425, but it was folded back through
  the compatibility slot, which is entry 0 unconditionally: with Dashboards
  `[A, B]` and B on screen, the reconstruction produced `[B, B]`, dropping A and
  minting a duplicate id. It now folds back **by exact id**, leaves the committed
  collection alone when the projection names no stored entry, and seats the
  projection only when there is genuinely nothing stored. This is the path a user
  reaches precisely when their storage is failing and they are trying to get
  their work out.

- **An `Array(T)` Dashboard variable with option SQL is a searchable
  multi-select** (#468). `Array(T)` is the type multi-select exists for, but #447
  phase 1 removed the curated model's multiselect control as an owner decision and
  phase 2 classified every container as having no inferred control — so a variable
  like `user : Array(String)`, with a perfectly good option query configured,
  rendered a free-text box and never ran that query. The #189/PR-#364 control is
  back, now driven by the variable's own Dashboard-local option SQL.

  The closed trigger reads **`Not set`**, the single option's **label**, or
  **`N selected`**. The popover offers a labelled search over both labels and
  values, a tri-state **Select visible** scoped to whatever the search currently
  shows (hidden rows are never touched), per-option checkboxes, and **Clear /
  Cancel / Apply**. Nothing commits until Apply, which canonicalizes by option
  order, fires at most once, and re-runs only the panels declaring that variable —
  a no-op Apply issues nothing. Cancel, Escape and clicking outside discard the
  draft and return focus to the trigger.

  Selections stay **real arrays** end to end — through viewer state, the
  per-Dashboard store, and the existing typed `Array(T)` serializer, which binds
  `param_user=['ada','bo']` with quotes, backslashes, Unicode and big integers all
  escaped, never a joined `"ada,bo"`. An **empty** selection is unset (the panels
  wait) rather than a literal `[]`, which would return nothing while looking
  filtered. Selections survive a reload.

  A committed selection is **never silently changed**. While the option batch is
  in flight the control is inert (`Loading options…`) — the Dashboard is mounted
  before the request finishes, so an Apply against a list that had not arrived
  would otherwise clear a restored selection. An automatic refresh only ever
  **removes** values that are genuinely gone, in **one** coalesced wave, and
  preserves the committed ORDER: the array binds as an ordered ClickHouse literal
  and panel SQL may read it positionally, so re-sorting it to match a new option
  order would change what panels bind without re-running them. A label-only or
  option-order-only change therefore does nothing at all. If the option list came
  back **truncated** at the 1,000 cap, nothing is pruned at either end — a
  selected value may simply live past the cap, so the refresh leaves it alone
  *and* **Apply keeps it** rather than dropping it for being absent from a list
  that is known to be a prefix. (**Clear** still removes everything, and with a
  complete list an absent value is genuinely gone and does get dropped.) New
  options are never auto-selected.

  Eligibility is one pure predicate (`multiSelectElementType`) shared by the option
  batch and the control dispatch, so a type whose option SQL ran can never be one
  the bar refuses to render a select for. `Tuple`, `Map`, `Nested` and nested
  `Array(Array(…))` are unchanged: no option query, no select, and the same
  free-text field plus marker as before. An `Array(scalar T)` with **no** option SQL
  also keeps that field, but its marker now names the fix ("add option SQL to pick
  from a list") instead of calling a controllable type uncontrollable.

  **Fixes a latent bug:** every `Array(T)` variable with valid option SQL was
  silently marked `status: 'error'` by a branch commented "unreachable via
  `optionBatchVariables`' own rule" — which was wrong, and invisible only because
  the select it would have applied to never rendered.

- **Dashboard variables can offer a list of values, and every list on a Dashboard
  loads in one request** (#447, phase 2). A variable (inferred from the
  `{name:Type}` placeholders in its panels' SQL) may carry optional
  Dashboard-local **option SQL**: one read query returning two `String` columns —
  value, then label, by **position**; column names are never read. A variable with
  option SQL renders a **strict single-select**; one without keeps the direct-input
  control inferred from its declared type.

  Every configured variable on the Dashboard is compiled into a **single
  `UNION ALL` request per refresh**, so ten configured variables still cost one
  round trip. It runs concurrently with the panel wave — option SQL cannot
  reference a variable, so no panel is ever waiting on it. Each branch is bounded
  independently (1,000 options), and a list cut off at that cap says so.

  A select **never auto-selects**: a variable starts unset, its panels wait rather
  than run, and the inline **×** returns it to unset. Changing a value re-runs only
  the panels that declare that variable. Duplicate values collapse to the first
  row's label.

  A combined-query problem is reported as a **batch-level failure** (every
  option-backed control unavailable, one banner, no automatic fall-back to N
  separate queries), because `UNION ALL` reports one merged column list for every
  branch and so cannot say which one is at fault. Narrowing it down means running
  a single variable's SQL on its own, which its own editor tab's Run action does
  (#457/#465).

  Cascading option queries are rejected outright, and `Array`/`Tuple`/`Map`/
  `Nested` variables are marked as having no inferred control — they keep their
  text input, since a literal typed there still binds. (**Narrowed by #468
  above**, in this same unreleased set: an `Array` of a scalar WITH option SQL now
  renders a multi-select. The marker survives for every other container, and for
  an `Array(scalar T)` nobody has configured.)

- **The no-inferred-control diagnostic no longer renders a duplicate second row**
  (#470). The marker above used to be a sibling element (icon + a repeat of the
  declared type, e.g. `Array(Int32)`) appended beside the input; since it and the
  input's own wrapper were both pinned to the same CSS grid column, the layout
  pushed it into a visible second row that read as a duplicate control rather
  than a diagnostic. It now adorns the SAME input in place — a yellow/dashed
  class (mirroring the existing invalid/conflict affordances), a decorative
  icon absolutely positioned over the input, and the full message reachable on
  hover (`title`) and keyboard focus (`aria-describedby`) — with no change to
  the input's rendered width or the one-row filter layout.

### Changed
- **Exactly one command creates a Dashboard** (#429 phase 3, absorbing #481).
  File ▸ New dashboard… and the empty-workspace placeholder's Create button now
  both prompt for a name (seeded with the same default) and commit through
  `appendDashboard` — never the compatibility slot the placeholder used to
  write through silently. The placeholder still reveals exactly what it
  created, by the id the commit actually returned.
- **A Dashboard tree row is three independent targets: chevron, name, trailing
  action** (#429 phase 2, absorbing #472). Clicking a Dashboard's **name** now
  opens it in View — immediately, with no double-click window to sit through —
  and Shift-click still opens Edit. Expansion belongs to the **chevron** alone,
  which became a real button with its own accessible name (*Expand Sales* /
  *Collapse Sales*), its own `aria-expanded`, its own focus ring and native
  Enter/Space, and which never navigates. The trailing `⋯` does neither.

  Before this, a single click only expanded the row and opening needed a
  double-click, so navigation waited ~300ms on every click and the two operations
  competed for one gesture. They no longer do, and the delayed arbitration is gone
  from Dashboard rows entirely; a **panel** row's gestures are unchanged (click
  opens its query, double-click and Shift-click focus the tile), so it still
  arbitrates. Keyboard: `Enter` on a Dashboard row opens View, `Shift+Enter` opens
  Edit, `→`/`←` still expand and collapse, and Tab reaches all three of a focused
  row's targets without turning the tree into one tab stop per chevron.

  The row's `⋯` menu loses **Open in View**, which is now simply what clicking the
  row does, and keeps **Open in Edit**, whose only other forms are the hidden
  Shift-click and `Shift+Enter` modifiers. A Dashboard the search is holding open
  still cannot be collapsed (expansion state stays the user's), but its name now
  opens it, where before that click did nothing at all.
- **A Dashboard tile opens its own query in the Workbench; the Dashboard-level
  `< Query` button is gone** (#471). Every query-backed tile carries an
  **Open in Workbench** icon action in its own chrome, in both View and Edit mode
  and in both layout engines. It opens *that tile's* query document in the main SQL
  editor — or selects the tab already showing it — and leaves the Dashboard's
  filters, layout, scroll position and View/Edit state untouched.

  Identity is the tile's own query id, never the displayed name. A Dashboard tile
  references a dedicated saved-query copy that exactly one member owns (#427), so
  two Dashboards holding same-**named** copies open two separate tabs, re-opening
  one selects the tab it already has, and **Save from that tab updates the
  Dashboard's copy** rather than a same-named Library query. The compact
  collision *badges* that make two same-named tabs tellable apart remain #464.

  The action is deliberately not edit-mode-only — inspecting the query behind a
  tile is a View-mode act first. It is subtle until the tile is hovered or the
  button is focused, always visible on touch, and pressing it never starts a tile
  drag, resize, selection or chart gesture. A **queryless** tile (a `text` panel)
  and a tile whose query id no longer resolves show no action at all, rather than a
  disabled control or one pointing at an unrelated document.

  The removed `< Query` button named no document — it was ordinary back-navigation
  occupying primary toolbar space. Two follow-on consequences: a Grid-Tiles **KPI**
  tile's chrome overlay now reveals and accepts clicks in View mode too (it had no
  View-mode control before), and because the mobile rules hide the sidebar for a
  full-bleed Dashboard, **the bottom nav no longer hides itself on the Dashboard
  surface** — it shows only **Editor**, which returns to the Workbench. Without
  that, a phone looking at a Dashboard with no tiles would have had no route back
  at all.

  **Returning with Back now lands on the Dashboard you left, where you left it.**
  The URL deliberately carries no Dashboard id, and opening a query tears the
  Dashboard down, so Back used to rebuild the *first* Dashboard in the workspace at
  the top of the page — tolerable while a global back button existed, and not
  tolerable once per-tile actions are the way out. Each Dashboard history entry now
  remembers its own id, current member and scroll offset, so several Back steps
  across several Dashboards each return correctly; a remembered Dashboard that has
  since been deleted falls back to the Workbench rather than to some other one.

- **The Dashboard runtime now says "variable" everywhere it meant "variable"**
  (#459). #447 replaced curated Dashboard filters with inferred variables but left
  the surviving code calling them filters, so the source read as if a model it had
  deleted were still there. Renamed, with no behaviour change: the runtime types
  and session API (`ViewerFilterState` → `ViewerVariableState`, `applyFilters` →
  `applyVariables`, `DashboardViewState.filters` → `.variableStates`,
  `.filterDiagnostics` → `.optionDiagnostics`, and the rest of the
  `setFilter`/`clearFilter`/`resetFilters` family), the time-range pair identities
  (`fromFilterId`/`toFilterId` → `fromVariableId`/`toVariableId`), four modules
  (`ui/filter-bar.ts` → `ui/variable-bar.ts`, `ui/filter-option-field.ts` →
  `ui/variable-option-field.ts`, `core/filter-width.ts` → `core/variable-width.ts`,
  `dashboard/model/dashboard-filter-store.ts` → `dashboard-variable-store.ts`), and
  the `.dash-filter*`/`.dash-clear-filters`/`.detached-filter-row`/`.filter-select`
  CSS family. `.ms-overlay` became `.popover-overlay` — not because the `ms-`
  prefix is gone (#468 restored the multi-select control, and its own fourteen
  `ms-*` classes are very much alive) but because that one class was never the
  multi-select's: it is the default backdrop class of the *shared* anchored-dialog
  primitive `ui/popover.ts`, which the time-range control uses too. It now says
  what it belongs to.

  The visible vocabulary moved with it: the variable row's section label reads
  **Variables** rather than **Filters**, and the Dashboard, time-range,
  detached-view and multi-select controls announce themselves to assistive tech as
  variables ("Dashboard variables", "Query variables", "`<name>` variable, N
  selected"). Nothing else about the controls changed.

  **Saved Dashboard variable values are untouched.** The localStorage key stays
  `asb:dashFilters`, keeping its historical name deliberately: renaming it would
  have discarded every committed value on the next load. `asb:filterActive` and
  its helpers keep their names too — what they denote is activation of a
  parameter's optional `/*[ … ]*/` filter block, a live SQL-filter concept that
  predates the curated Dashboard model and outlived it, and that key is persisted
  as well. (The shared variable-bar port also exposes that name to its Dashboard
  caller, where nothing is persisted behind it; that leaky abstraction is #478,
  deliberately not folded into a rename.) Both exceptions are documented where
  they live, and a new test pins every persisted key string so a future rename
  cannot orphan real data while the suite stays green.

- **Dashboard variable option SQL is edited in the main editor, as its own tab**
  (#457). Clicking a variable in the Dashboards tree switches to Query and opens
  a dedicated **`Variable: <name>`** tab on that variable's committed option SQL
  (blank when it has none), reusing the editor, tab strip, toolbar, Run action
  and result area every query already uses. Re-clicking the same variable selects
  the tab it already has; the same variable name in two Dashboards opens two
  independent tabs, because a variable is identified by its Dashboard **and** its
  exact name. Open tabs and unsaved drafts are never disturbed.

  Save writes only `variableConfigs[<name>]` on that Dashboard — never a Library
  entry, a History row, a favourite or a panel — and blank or whitespace-only SQL
  removes the configuration, returning the variable to direct input. A Save whose
  Dashboard no longer resolves (deleted meanwhile, or an ambiguous id) commits
  nothing and keeps the draft, rather than guessing a target.

  This replaces the right-side **option-SQL drawer** introduced in #447 phase 1.
  The application already had a complete SQL editing surface; a second one in a
  narrow drawer duplicated that machinery, shrank the working area and ran its own
  editor lifecycle. The drawer, its editor seam, its textarea fallback and its
  drawer-local **Test** action are all gone — running a variable's SQL is now the
  ordinary Run action. Re-hosting Test's two-`String`-column check on that Run
  shipped as #465, below.

- **One File menu for the whole application** (#452). Query, Dashboard Edit,
  Dashboard View, the empty-Dashboard placeholder and the Dashboard
  workspace-not-found fallback now render the *same* File menu — same rows, same
  order, same labels, same trigger behaviour. Before, the same header control
  changed meaning with the work surface: the Dashboard's own menu offered
  import/export and dropped every workspace and Library operation, Dashboard View
  dropped a row again, the two implementations ordered and grouped their rows
  differently, and only one of the two triggers toggled shut when clicked again.

  Context now changes **enabled state only** — a row never disappears or moves.
  An unavailable row is dimmed, carries `aria-disabled`, is skipped by keyboard
  navigation, cannot be activated, and states its reason on its own line
  (*Open a dashboard*, *Edit mode only*, *No dashboard*, *Dashboard unavailable*,
  *No workspace*, *No Library queries*). The per-surface section headings are
  gone, `Download Markdown`/`Download SQL` became **Download Library as
  Markdown**/**as SQL** so their scope is unambiguous when opened over a
  Dashboard, and the footer reports both counts (`N Library queries · M
  dashboards`) from the zero-owner Library projection rather than the raw
  collection.

  **Dashboard operations now require an exact target.** `Export Dashboard…` and
  `Import Dashboard…` receive the Dashboard the surface actually rendered instead
  of re-reading the session selection, which returned `null` in Query mode and
  silently made both commands act on the collection's *first* Dashboard. Import
  onto the empty placeholder creates the workspace's first Dashboard, and is
  offered only when the collection is genuinely empty — the placeholder is also
  reached when a selection stops resolving against a non-empty collection, where
  that path would have overwritten Dashboard #1. A target removed while the
  import dialog is open fails closed with a diagnostic and commits nothing.

  The File menu is 288px wide (from 252px) to fit the longer labels, and the
  Dashboard-only `.dash-file-menu`/`.dash-fm-item`/`.dash-file-btn` classes,
  the `AppHeaderOptions.fileButton` seam, and the untargeted
  `actions.exportDashboard`/`actions.importDashboard` registry entries are gone.
- **Dashboard filters are gone; a Dashboard's variables are INFERRED from the
  `{name:Type}` placeholders in its panels' own SQL** (#447, phase 1). There is no
  persisted filter object any more — no filter id, no label separate from the
  name, no option-source query reference, no explicit target list, no selection
  mode. A variable's name and ClickHouse type come from the panel queries that
  declare it, matched **exactly and case-sensitively**: `country` and `Country`
  are two variables, and a variable binds automatically to every panel query on
  the same Dashboard that declares that exact name. Adding or removing a panel
  changes the variable list by itself; creating a variable is never a separate
  action. The one thing still stored is `dashboards[].variableConfigs` — optional
  Dashboard-local option SQL keyed by variable name, holding only the SQL plus an
  informational `lastKnownType` so an orphaned entry can still show a type.

  The lower-left tree's **Filters** group is now **Variables**, listing
  `name : Type` for every distinct inferred name plus every preserved orphaned
  configuration. Declaring one name with two different types produces ONE row
  showing every type, marked with an error icon and accessible error text (never
  colour alone), whose hover diagnostic lists the conflicting panels; it renders
  no working control, is excluded from execution, blocks only the panels that
  require it, and resolves by itself once the panel SQL agrees. When the last
  panel reference to a CONFIGURED variable disappears its SQL is preserved as an
  `unused` orphan — warning-marked, hidden from the controls, excluded from
  execution, still editable, and deletable through a trailing trash icon that
  asks for confirmation because SQL will be lost. An UNconfigured variable that
  loses its last reference simply disappears. A variable row has exactly two
  operations: click to open its option SQL, and (orphans only) delete. There is
  no overflow menu.

  Because the tree group was renamed, a Dashboard whose Filters group was
  expanded opens with Variables collapsed once; session expansion state is not
  migrated.

  **Not in this phase** (they land with #447's phase 2): the typed direct-input
  control matrix and its unsupported-compound diagnostics, option-backed
  single-selects, the strict two-`String`-column option contract, the
  `UNION ALL` batch compiler and its one-request execution, per-variable
  Run/Test, and panel-waits-for-unset semantics. Dashboard controls in this phase
  are the existing direct-input fields, now fed by inferred variables. In
  particular, clearing a variable deactivates it but still leaves its last value
  bound where a panel requires that parameter outside an optional block — the
  pre-existing behaviour for plain filters, which phase 2's unset/selection work
  addresses.

- **`Filter` is no longer a saved-query role or a panel type** (#447). The role
  enum is `["panel", "setup"]`, and the result-panel picker is a flat list of real
  visualisations: the `Dashboard role` category, the `Filter` option, the
  `Preview…` placeholder and the `Panel` heading are all removed, along with the
  Filter result view and its preview. The whole option-provider runtime goes with
  them — implicit filter synthesis, provider discovery by output-column name,
  provider merging and duplicate-provider arbitration, identical-provider
  collapse, shared-source execution dedup, one query feeding several filter
  arrays, array/multiselect parsing and controls, and per-filter panel targets.
  A Dashboard tile is now the only kind of member that references a saved query,
  so "one query, several owners" has no valid form left.

- **Stored workspaces are `storageVersion: 5`, Dashboard documents
  `documentVersion: 2`, portable bundles `version: 2`** (#447). v2/v3/v4 records
  and v1 bundles stay readable and migrate on read: each is validated against its
  OWN schema at its own Dashboard document version, then carried forward. There is
  no v3→v4 step any more — filters are dropped first, so the ownership migration
  only ever walks document v2 and mints a dedicated copy per panel tile. A copy a
  filter used to own is **kept**: losing its last owner makes it a Library query,
  exactly as removing any other member does, so no SQL is destroyed and the query
  reappears in the Library beside the original it was cloned from. Owned-copy ids
  still derive to the same values they did before, so nothing is re-minted and no
  open tab is disturbed. `maxQueries` stays at 5224 — removing filters lowers the
  derived worst case, but a record already at that bound must keep decoding, so it
  is a compatibility ceiling now rather than a recomputed maximum.

  One document is deliberately **not** recoverable: a stored workspace or bundle
  carrying a saved query with the removed `filter` role fails its structural pass
  before migration can reach it, and is reported unsupported rather than migrated.
  The curated-filter representation was experimental with no production legacy, so
  such a workspace is recreated rather than repaired — delete the stored record (or
  the `asb-workspaces-v2` IndexedDB database) and re-import.

- **The compound From/To time-range control and the chart crosshair/brush
  survive** (#335/#334), re-based from curated filter definitions onto inferred
  variables. A range pair is still discovered from the recognized name table or
  authoritative saved-query `timeRanges` metadata, but a bound is now identified by
  its variable name and typed by that variable's agreed declaration, so the
  array/selection-mode gate the old resolver applied is gone.
- **Every Dashboard panel owns a dedicated saved-query copy, and the lower-left
  pane is the Library** (#427; #447 removed the curated-filter half of this). A
  workspace's queries split into two kinds: a **Library** query, which no
  Dashboard member references, and a Dashboard-**owned** copy, referenced by
  exactly one panel tile. Ownership is derived from those references alone —
  there is no flag on the query — and no query may be shared by two tiles or by
  members of different Dashboards. Existing
  workspaces migrate on open (`storageVersion: 4`): every original query stays
  exactly where it was as the Library source, and each member gains its own copy
  with the owner's role and no favourite. Dashboard, tile, filter and layout ids,
  their order, and every Dashboard revision are preserved, so the #426 tree's
  expansion and selection survive the migration untouched. The clone ids are
  DERIVED from the member each copy belongs to rather than generated, so opening
  the same record twice — or in two tabs — produces the same document instead of
  two tabs fighting over ids. The stored query bound rose from 1000 to 5224
  (1000 originals plus the 4224 members a valid workspace can hold), because at
  the old bound migrating a large workspace produced a record that would fail
  validation on every future open; portable bundles track the same bound, so an
  older build will reject a very large new bundle. The encoded-document cap rose
  with it, 10 MiB to 20 MiB, for the same reason and one step further along: that
  bound is enforced only when WRITING, so a stored workspace between roughly 5 and
  10 MiB used to decode and migrate fine and then fail every subsequent save —
  permanently read-only, with no repair path.

  One hand-off to #429 is worth stating plainly: removing a panel from a Dashboard
  leaves the dedicated copy it owned with no owner, so that copy reappears in the
  Library beside the original it was cloned from. Deleting a member and its owned
  query as one atomic operation is #429's trash action; until then the copy is kept
  rather than silently discarded.
- **The lower pane is `Library | History`** and lists only standalone queries,
  with a matching count, `Search library queries…`, and Library-worded empty
  states; on phones the segment is relabelled the same way. A Dashboard-owned
  copy stays stored and stays openable from the Dashboards tree — it simply is
  not a Library entry. Markdown/SQL document exports and the workspace picker's
  query count follow the same projection, so a migrated workspace no longer
  exports every panel twice.
- **The favourite star is a Library preference, with no Dashboard meaning
  whatsoever** (#427, closes #434). It used to BE membership: starring a query
  appended a tile — minting a whole Dashboard if the workspace had none — and
  unstarring removed every tile referencing it, which is why #425 had to refuse
  starring while a non-first Dashboard was selected. All of that is gone: a star
  writes `spec.favorite` and nothing else, the refusal and its toast are
  retired, taking a tile off a Dashboard no longer rewrites the query, and
  importing a favourited query no longer creates Dashboard content (so a
  queries-only bundle no longer arrives with a Dashboard attached). Starred
  queries still sort first in the Library. An implicit filter's option source is
  now matched by parameter NAME against Library filter-role queries, with the
  favourite requirement dropped — so an unstarred query can supply options, and
  a copy some Dashboard already owns can no longer be borrowed as another
  Dashboard's source.
- A workspace now stores an ordered **collection** of Dashboard documents
  (`StoredWorkspaceV3`, #424) instead of zero or one. Records written under the
  previous contract are read and migrated deterministically on open — Dashboard
  ids, revisions, layouts, filters, tiles, favorites, and unknown
  forward-compatible fields are preserved exactly, no tile is derived from or
  removed because of a favorite flag, and nothing is reordered; every new write
  is `storageVersion: 3`. Dashboard ids are unique per workspace and each
  Dashboard is validated independently against the shared query collection,
  while tile, filter, and layout ids stay Dashboard-local. **No UI change:** the
  Workbench and Dashboard still expose exactly one Dashboard, resolved through a
  single compatibility selector, and the favorite star drives its membership
  exactly as before. Additional Dashboards are preserved, validated, exported,
  and never modified by an action that did not target them. Two import/export
  consequences: a workspace export now carries every stored Dashboard rather
  than only the visible one, and **Import workspace** imports every Dashboard in
  the file (in file order) instead of asking which single one to keep.

### Added
- **A Databases / Dashboards switcher and a read-only Dashboard hierarchy tree**
  (#426). The upper-left pane gains an equal-role tab row over two persistent
  hosts, so every stored Dashboard is finally reachable: `Dashboard → Filters →
  Panels`, in collection order, with panel counts, per-role search, expansion,
  scroll and full keyboard navigation. Switching roles only hides a host, so the
  schema search text and focus, expansion, lazily-loaded columns and scroll
  survive by construction — as do the sidebar width and the upper/lower splitter.
  A panel row opens its query; double-click and Shift-click open the Dashboard in
  View or Edit focused on that exact tile or curated filter, addressed by
  Dashboard-local id and never by query id. Those gestures are mutually
  exclusive: the primary action is deferred for the double-click window and
  cancelled outright by the second click, so a query never flashes on the way to
  a Dashboard, and the disclosure chevron stays the instant path for expansion.
  Repeated member navigation inside an already-open Dashboard is delivered
  **in place** through the existing surface command port — no rebuild, no re-run,
  no extra history entry. The tree is a strictly read-only projection of the
  committed workspace: it never clones, repairs or rewrites a reference, and it
  renders a diagnostic row (keeping Dashboard navigation available) for a broken
  one, while a curated filter that simply has no option source yet is treated as
  the transitional state it is, not an error. The obsolete header
  `SQL Browser | Dashboard` switch is gone — the brand zone is now
  non-interactive `Altinity® SQL Browser` — along with a vestigial hidden
  Dashboard-nav seam that was built but never attached to the page. On phones the
  sidebar's upper segment is relabelled **Explore**, since that pane now holds
  both roles.
- **A Dashboard is now a full-size main work surface, selected by stable id**
  (#425). Opening one replaces the complete SQL editor and result/data-drawer
  area — the left sidebar stays visible — and the View/Edit switch lives in the
  primary toolbar (the separate Back-to-query/title row was folded into the
  compact toolbar by #437). Returning finds the Query surface exactly as it was: the same editor contents,
  selection, scroll, active tab, result view, and editor/results split, because
  the surface is hidden rather than rebuilt. A surface change no longer cancels
  the query running in the editor, and Back/Forward between surfaces of one
  workspace no longer tears the editor down. Any Dashboard in the workspace can
  be opened by its stable id in View or Edit mode, with an optional navigation
  target that focuses, scrolls to, and briefly highlights one panel tile (by
  tile id, never query id) or one curated filter (by filter id). Selection is
  session state — never persisted, cleared on sign-out, and re-validated against
  every committed workspace, so a deleted or ambiguous selection falls back to
  Query mode instead of silently switching to another Dashboard; URLs are
  unchanged. Export Dashboard and Import Dashboard now address the selected
  Dashboard rather than the workspace's first one; the favourite star, which
  still drives panel membership through the first Dashboard, declines with an
  explanation while a different one is open (it is rewired in #427).
- Inter and JetBrains Mono are now **shipped with the artifact** instead of only
  being named in the font stacks. DESIGN.md has always specified both, but with
  no `@font-face` and no CDN allowed, they rendered only for users who happened
  to have them installed locally — everyone else silently got the platform UI
  face and Menlo/Consolas. `build/fonts.mjs` inlines latin-subset, upright,
  variable-weight woff2 as base64 `@font-face` sources: ~89 KB of woff2, +19%
  gzip on `dist/sql.html`, still zero third-party requests. `unicode-range` is
  preserved so codepoints outside the subset (Cyrillic, CJK, the ⌘/↵/→ glyphs)
  keep falling through to the platform font rather than rendering tofu. The KPI
  metric gains `tabular-nums` so a refreshing value no longer twitches.
- A named type scale (`--text-*`, `--fw-*`, `--lh-*`) and
  `tests/unit/typography-contract.test.js`, which gates it: every `font-size` in
  `src/styles.css` must resolve to a token, no two steps within a ramp may sit
  closer than 1px, the tokens must match the DESIGN.md frontmatter, no class the
  UI renders may be left with no CSS rule, and token contrast must clear WCAG AA
  in both themes. Nothing previously enforced any of this — behaviour coverage
  cannot see a missing stylesheet.
- Surface-aware keyboard shortcuts for SQL Browser and Dashboard (#417). The
  shared, platform-aware shortcut catalog now drives both help and dispatch;
  Dashboard gains refresh, View/Edit, and `G` navigation commands while stale
  viewer sessions, loading routes, stacked overlays, and nested text inputs
  fail closed. Contextual help is torn down on route and authentication
  transitions so it cannot survive onto another surface or Login. Dashboard
  Style adds `G G`, `G F`, `G R`, `G 2`, and `G 3` for Grid Tiles, Full view,
  Report, and two/three columns; View mode previews every style without
  changing the shared dashboard.

### Changed
- The Dashboard toolbar is one compact row instead of two (#437). The #425
  surface row (Back to query, the Dashboard title) is gone — Back to query
  returns as an icon-first control at the START of that single row (#426, once
  the header's SQL Browser / Dashboard switch it had delegated to was itself
  retired), and View/Edit now sits at the end of the primary toolbar, after a
  combined freshness control. That control replaces the separate "Updated
  HH:MM" label and text "Refresh" button with the bare time plus an icon-only
  refresh action (a spinner while running, a tooltip/`aria-label` naming the
  last-updated time once a run completes). That time is a genuine wall clock
  (`DashboardViewState.lastSuccessWallMs`, only ever advanced by a `refresh()`
  wave that leaves every tile it ran out of `error` status) rather than "now"
  at whatever moment a render happens to run, so it stays stable across an
  unrelated publish (tile Search, a layout switch) and a refresh that leaves a
  tile in error shows an accessible "Refresh failed" state instead of silently
  claiming a fresh time — the last known-good time survives underneath it. The
  tile-search placeholder shortens to "Search" (its accessible label is
  unchanged) and the field itself narrows to a ~120–145px responsive range.
  The empty-Dashboard placeholder gets the same one-row treatment.
- Radii, elevation and the semantic/object-kind/syntax palettes are tokens too
  (`--r-*`, `--shadow-*`, `--ring-*`, `--kind-*`, `--role-*`, `--sql-*`). Fourteen
  radius values against a documented four-step scale became four plus `--r-pill`;
  fourteen shadows across eleven black alphas became one token per documented
  entry. `.dash-tile` was at 10px while DESIGN.md's own Dashboard Tiles section
  said 8px.
- KPI cards no longer wear a 3px accent bar across the top. The author's per-KPI
  colour hint (`presentation.color`) tints the card's own 1px frame instead: the
  bar mitred against the 8px radius, and a coloured stripe on a metric card is
  the dashboard cliché PRODUCT.md lists as an anti-reference. `--kpi-accent` now
  defaults to `--border` rather than `--accent`, so a KPI with no author hint is
  neutral and ClickHouse Blue stays scarce instead of appearing on every card.
- Reference-doc admonitions state their variant with a 1px frame in the variant
  colour plus a coloured title word, replacing the 3px left stripe — colour paired
  with text, per the Evidence Rule. Blockquotes drop to a hairline left rule.
- The streaming progress bar and the column/row resize handles animate `transform`
  instead of `width`/`height`, keeping two high-frequency surfaces off the layout
  path. The progress fill is full-width and scaled from the left by `results.ts`.
- The Altinity logomark moved to `src/ui/brand-logo.ts`. Its 26 gradient stops are
  a supplied brand asset, deliberately outside the palette and never to be
  borrowed for UI chrome; its own module lets `.impeccable/config.json` exclude
  exactly that file from the design-system colour check instead of all ~60 icons.
- The type ramp is collapsed from 22 ad-hoc values to six interface steps
  (9 / 10.5 / 11.5 / 12.5 / 14 / 16px) plus a document ramp for Read surfaces
  and two display sizes. 231 literal `font-size` declarations became tokens, nine
  `font:` shorthands carrying hidden literal sizes were expanded, and five values
  that sat below the documented 11px floor are gone. The half-pixel neighbours it
  removed (9/9.5, 10/10.5, 13.5/14/14.5) could not carry hierarchy: at these
  sizes a 0.5px step buys ~0.26px of x-height, below one device pixel at 1×.
- `body` now sets an explicit base size and `h1`–`h6` reset to `font-size:
  inherit`, so a heading or surface the stylesheet misses degrades to the
  product's own body size instead of to user-agent typography.

### Fixed
- Three follow-ups on the Dashboard tree (#426). A row the **search** is holding
  open no longer offers a toggle at all — its chevron gets no handler, and click,
  ArrowLeft and ArrowRight leave expansion alone — because a search exposes paths
  without mutating saved expansion state, so a toggle there wrote state that was
  invisible until the search cleared and surprising afterwards. Opening a
  Dashboard focused on a tile or filter it does not contain no longer marks that
  phantom member as current, while the focus **request** still survives unchecked
  so the delivery path keeps reporting the miss. And a deferred single-click is
  now cancelled by every projection rather than only a workspace switch: deleting
  a Dashboard inside the double-click window could otherwise let the delayed
  toggle re-add a just-pruned id, or open a dead query id.
- The shared anchored-dialog focus trap (`openAnchoredDialog`, #439) now owns
  **every** Tab/Shift+Tab transition instead of only wrapping at the first and
  last declared focusable element. Native sequential-focus policy is not
  portable: WebKit/Safari's default "Tab highlights every item on a webpage"
  preference is off, so browser-delegated middle-of-list traversal could skip
  checkboxes and buttons entirely — in the multi-select and time-range
  popovers this meant keyboard focus could never reach Clear/Cancel/Apply, or
  escape the modal trap altogether. The eligible set is still recomputed on
  every press (disabled/hidden/removed controls drop out immediately, restored
  ones rejoin without reopening the dialog), and a focused element no longer in
  that set is treated as unfocused (Tab goes to the first eligible element,
  Shift+Tab to the last). Verified in Chromium, Firefox, and WebKit. The
  primitive also gained `handle.reclaimFocus()`: disabling the
  currently-focused control (the multi-select's busy state disables every row
  but Cancel while a Filter source is loading) natively blurs it out of the
  dialog entirely, past the trap's dialog-scoped reach — a plain Tab press
  right after would never re-enter the modal. Multi-select now calls it the
  moment busy state lands, recovering focus onto Cancel instead of leaving it
  stranded on the page behind the modal.
- The Dashboard surface (#425) is brought onto the token system it was written
  before. Its **title** was `13px/600` — half a pixel above `--text-body`, a step
  the One-Pixel Floor forbids because nobody can see it — and now steps up by
  weight instead, at `--text-body`/`--fw-semibold`, one weight above the
  `--text-label` controls beside it. Its **navigation highlight** mixed its own
  translucent accent (`in srgb … 25%`) beside the ring family's `in oklab … 22%`:
  one halo in two spellings, already drifting. It is `--ring-nav` now, a fourth
  member of that family. That highlight also forced `border-radius: 6px` onto
  whatever it marked, so a `--r-md` dashboard tile visibly **changed shape** while
  highlighted and the ring mitred against the corner it was pointing at; it now
  sets no radius and follows the target's own. A dead `gap: 8px` — overridden by
  `.dash-toolbar`'s later, equally specific `gap: 10px` since the day it landed —
  is removed, so the surface toolbar and the filter row beneath it are visibly one
  sticky bar.
- The pane-splitter indicator is a real `1px` line again. Moving it off the
  layout path (see below) had left it a `3px` bar held down by `scaleX(.34)`,
  which painted `1.02px` and, worse, reported `3px` to anything reading the
  computed box — so `splitters.spec.js` had been failing on this branch, unrun,
  since that change. It now scales **up** from an honest `1px`, and the spec
  measures the painted extent (layout size × the transform's own scale) rather
  than the untransformed box, which is what it always meant to assert.
- Three gaps in the design-system gate, each of which is why the above shipped.
  The shadow check tested for `rgba(` only, so a hand-mixed
  `color-mix(…, transparent)` passed; it now rejects any box-shadow that builds
  its own translucent colour, and a companion test pins every ring halo to one
  colour space at one alpha. The unstyled-class check reads a curated file list,
  and #425 split `app.ts` into `app-shell.ts` and `workbench/workbench-shell.ts` —
  moving the application frame, the sidebar and both surface hosts out of its
  view; the list follows the markup now.
- Two DOM state badges (`.qtab-external`, `.mnav-badge`) were sitting on
  `--text-nano`, the 9px tier DESIGN.md reserves for SVG text inside the zoomable
  graphs — one because the mechanical 9px→token mapping put it there, one because it
  was authored in the same change that wrote the restriction. Both now use
  `--text-micro`, the documented tier for state badges. The contract test now
  enforces the restrictions themselves rather than only that *some* token is used:
  `--text-nano` is confined to the graph surfaces, the display tier to the login
  mark and the KPI metric, and the document ramp to Read surfaces.
- `font-src 'self'` blocked both inlined typefaces in every real deployment. CSP
  `'self'` is an origin match and does not cover the `data:` scheme — it has to be
  listed explicitly, exactly as the neighbouring `img-src data:` already did. Fixed
  in both configs that ship a policy (`deploy/http_handlers.xml` and
  `deploy/nginx/default.conf.template`). The failure was invisible by construction:
  a blocked `@font-face` renders no tofu, it falls through to the platform face and
  looks correct, so the deployed app would have kept using system fonts with only a
  console violation as evidence — while every local check passed, because the CSP
  exists only in the deploy configs. `tests/unit/csp-contract.test.js` now asserts
  every URL scheme the built artifact references is permitted by the corresponding
  directive, in every config that ships a CSP, and that those configs agree.
- `--fg-faint` met no accessibility bar in either theme (2.55:1 light, 3.10:1
  dark at worst) while carrying most of the smallest text in the product — row
  counts, capped/cancelled badges, tile footers, the "Press ⌘↵ to run query"
  hint. Now 4.61:1 light / 4.79:1 dark against their worst backgrounds
  (WCAG 2.2 AA 1.4.3).
- ClickHouse Blue as *text* failed AA too (4.10:1 on light chips, 3.83:1 on dark
  surfaces). Text now uses `--accent-text` — the palette's existing Deep
  ClickHouse Blue in light theme, a lifted `#2596CC` in dark. Fills, borders,
  focus rings, carets and icons keep `--accent`, where the 3:1 non-text
  threshold applies.
- The destructive Overwrite button in the linked-tab conflict chooser uses a new
  `--error-fill` rather than `--error-fg`. A foreground token is tuned to be legible
  AS text on its plane, so dark theme's `#f87171` carried white at only 2.77:1 as a
  fill. `--error-fill` is dark enough for white text in both themes (4.98:1 dark,
  6.47:1 light) and keeps a visible edge against the dialog behind it.
- Six surfaces shipped with no CSS rule at all and therefore rendered in browser
  chrome. The linked-tab conflict chooser (#343) — the dialog that decides
  whether to overwrite work saved in another tab — had 13.333px Arial buttons
  with `2px outset` borders and a title visually identical to its description.
  The query-tab marker warning that a linked query changed or was deleted
  rendered as an unstyled stray `!`/`⌫` character. `workspace-not-found` had a
  32px `h1` and a raw `#0000EE` underlined link; `workspace-loading` and two
  dashboard empty states had 19.5px user-agent headings. All are now typeset in
  the product's own vocabulary, with the destructive Overwrite action carrying
  error tokens and the safe Reload action as the accented default.

### Removed
- The variable bar's `updateStatus` seam and its `FieldStatus` type (#460).
  `updateStatus` was the per-field execution-status affordance the curated
  filter model published through — #447 phase 1 deleted every producer, but
  kept the consumer side as a documented no-op for a later, non-rebuild
  affordance to land through. Phase 2 and #457 both landed without ever
  needing it, and #460 confirmed it has zero production callers (only test
  callers remained), so the bar-level fold, the `FieldHandle`/
  `VariableBarHandle` method, and the three no-op implementations (the
  multi-select field, the option-backed select, and the time-range control in
  `time-range-field.ts`) are gone. `ViewerVariableState.options`/`optionsRev`
  were audited too and kept — phase 2's batched option runtime is a real,
  live producer of both.

## [0.6.4] - 2026-07-24

### Fixed
- Remove obsolete `iss` and `hd` login-link hints from SQL Browser URLs. IdP
  selection remains owned by the deployment configuration and session state.

## [0.6.3] - 2026-07-24

### Fixed
- Keep Grafana-grid KPI hover chrome control-only: saved-query titles and
  descriptions no longer overlay metric values while moving or editing a tile.
- Keep the shared connection host visible after the server-version probe,
  restore Dashboard filters to their initial default-derived active state, and
  retain Dashboard time-range announcements when no ordinary filters exist.
- Restore Dashboard tiles for favorited panel queries imported through either
  query-only or query-only workspace imports, so the imported report opens
  instead of incorrectly offering only “Create dashboard”.

### Added
- **Unified SQL Browser and Dashboard chrome.** Both surfaces now share the
  same brand, surface, workspace, connection, examples, shortcuts, theme, and
  user zones. Dashboard layout, tile count/search, time range, refresh, and
  View/Edit controls live in a sticky primary tool row; ordinary parameters
  live in a separate sticky filter row. Tile search matches effective titles
  and descriptions without rerunning queries or changing saved layout/order,
  and ordinary-filter Clear all restores defaults in one execution wave while
  preserving every time-range pair.
- **Unified `/sql` routing for Workbench and Dashboard surfaces** (#407).
  Workspace identity, surface, and presentation mode now live in canonical
  `ws`, `surface`, and `mode` query parameters. Workbench/Dashboard switches
  stay in the same tab with useful Back-button history, while View/Edit uses
  replacement history. Dashboard view mode renders the same live workspace
  document without authoring controls; an explicit missing workspace never
  falls back, and an empty workspace offers Create only in edit mode. The old
  surface becomes an inert loading route before cross-workspace navigation,
  while same-workspace Back/Forward switches immediately. Dashboard uses the
  shared application header and route controls. Global Workbench shortcuts
  fail closed outside a ready matching route, and renderer generations let in-flight
  durable writes finish without obsolete Dashboard or Workbench callbacks
  repainting the selected surface. Direct Dashboard startup now shares the
  authenticated server-version probe. Empty Dashboard routes also react when
  another tab creates the Dashboard. The old `/sql/dashboard` bootstrap split,
  detached Dashboard snapshot stores,
  one-time state handoff, and cross-tab credential handoff have been removed.
- **Multi-workspace local persistence foundation** (#406). Stored workspaces
  now use the V2 contract with separate immutable opaque `id`, immutable
  human-readable URL `key`, and mutable display `name`. IndexedDB stores one
  validated aggregate per workspace behind an ID key path and unique key
  index; the repository can list summaries, load by ID/key, create, replace,
  and delete individual records without affecting neighbors. Last-used key and
  injected-clock `lastOpenedAt` metadata select the most recently opened valid
  workspace for implicit startup, while explicit `?ws=` lookup never falls
  back. Workspace import is additive with reminted local identity, Dashboard
  links resolve stable keys, and active edits reload/commit by immutable ID.

## [0.6.2] - 2026-07-23

### Fixed
- Make the Dashboard multi-select Apply button remain a clear primary action on
  hover, while preserving distinct disabled, keyboard-focus, and pressed states
  (#386).
- Declared Node.js 22 as the minimum source-development runtime, kept the
  committed `.nvmrc` as the version-manager default, and enabled strict npm
  engine checks so unsupported local installs fail before the test runner
  reaches incompatible dependencies (#383).

### Changed
- KPI queries now have one frameless Dashboard presentation in Grid Tiles,
  Full view, Report, 2-column, and 3-column styles. Flow KPI-band members and
  transparent grid wrappers move with Command/Ctrl-drag while plain dragging
  continues to select text; movement reuses the shared floating preview,
  destination resolution, auto-scroll, cancellation, and exact-once commit
  path. Grid KPI title/delete/resize chrome appears transiently on hover or
  keyboard focus without shifting content, and resize is keyboard-operable
  with arrow keys (#340).
- Consolidated the non-Iceberg examples into three responsive flagship
  dashboards: On-time flights, Shop analytics, and ClickHouse Operations.
  Each uses an authored `grafana-grid@1` layout with a complete `flow@1`
  fallback, shared filters, and focused visible tiles; useful secondary
  analyses remain untiled Library entries. Removed the superseded KPI, logs,
  query-log, System Explorer, and earlier Grafana-port fixtures and generator.
- CI now classifies pull-request changes before starting expensive jobs:
  example-only changes run focused bundle/contract checks, while unit coverage,
  build/size, release-bundle smoke, browser E2E, and Docker jobs run only for
  relevant paths. Pushes to `main`, release tags, and manual dispatches retain
  full validation, with a nightly cross-browser E2E safety run and stable gate.

### Added
- **Saved-query time-range metadata and synchronized Dashboard chart
  interaction** (#334). Query Spec v1 now carries zero or one authoritative
  `{from,to}` parameter pair. Normal saved-query create/SQL-update flows infer
  one conservative recognized date/time pair when metadata is absent, while
  explicit `[]` opts out and Dashboard viewing never writes metadata. The
  Dashboard derives runtime groups from that saved metadata, synchronizes an
  exact-time vertical crosshair across compatible temporal charts, and lets a
  plain mouse drag select a forward or reverse range. Selection formats each
  bound through its declared Date/Date32/DateTime/DateTime64 contract, commits
  and activates both filters atomically, reserves affected generations before
  asynchronous preflight/source work, and reruns each dependent tile once;
  Command/Ctrl-drag remains tile movement and manual filter inputs remain the
  keyboard-accessible fallback.
- **Cross-tab workspace consistency: refresh before write and stale-tab
  invalidation** (#343). Workbench and editable-Dashboard tabs editing the same
  workspace now stay consistent under normal sequential editing. Every
  interactive workspace mutation flows through the shared read-before-write
  primitive (`app.mutateWorkspace`), which loads the latest committed
  IndexedDB workspace inside the write queue, applies the operation as a
  semantic transform over it, projects committed truth exactly once, and
  broadcasts a small `workspace-changed` invalidation (never the workspace
  body) on a `BroadcastChannel('asb:workspace')` seam; window focus /
  visibility provide the fallback when the channel is absent or a message was
  missed, and duplicate notifications coalesce into one queue-ordered reload
  guarded by a snapshot-token compare. Saved-query create/save/rename/
  delete/star no longer commit candidates built from stale in-memory state —
  unrelated changes made in another tab survive, and operations whose target
  was deleted externally abort instead of resurrecting it. On an external
  change, a clean linked Workbench tab silently adopts the new version; a
  dirty one keeps its draft and enters an explicit conflict state whose Save
  button opens a two-action resolution chooser (**Reload saved version** /
  **Keep my draft** behind an explicit Overwrite confirmation); a dirty tab
  whose query was deleted elsewhere becomes an unsaved draft (Save-as-new
  only). An editable Dashboard rebuilds its viewer session from committed
  truth — even when only a referenced query changed and the Dashboard
  document is byte-identical — deferring until pending command descriptors
  settle and preserving per-Dashboard filter values; detached read-only
  Dashboard views ignore primary-workspace invalidation entirely. No
  repository CAS, schema change, or simultaneous-commit protection is
  involved (#343 non-goals; membership semantics stay with #370).

### Fixed
- **Dashboard tile deletion now keeps Workbench star membership consistent**
  (#370). `dashboard.tiles[]` is the canonical favorite state for panel-role
  queries: deleting the final tile clears the compatibility
  `spec.favorite` flag, while deleting one of several instances keeps it set.
  The same atomic workspace transform removes the selected tile from explicit
  filter targets, normalizes the active layout/fallback, and advances the
  Dashboard revision once. Legacy or imported `favorite: true` panel queries
  without a tile now render unstarred and one click creates membership while
  repairing the mirror flag; filter/setup favorites keep their independent
  compatibility behavior.
- **Migrated the development test stack to Vitest 4** (#372). Vitest and its
  V8 coverage provider now use the supported 4.x line, removed pool options
  have been migrated, stricter mock typings are explicit, and the more accurate
  AST remapping is backed by focused edge tests without lowering any per-file
  threshold. Real CodeMirror fixtures are destroyed between app tests so DOM
  observers cannot leak into the next case.
- **Hardened the development test stack** (#366). Vitest and its V8 coverage
  provider now use the patched 3.2.x line, Happy DOM now uses 20.11.0, and the
  lockfile resolves the patched transitive dependency graph. `npm audit` is
  clean; the change affects local/CI tooling only, never the shipped artifact.
- **Dashboard tiles now respect an explicit saved `view: "table"`** (#368).
  The compatibility form resolves to a Table base presentation before runtime
  panel detection, while an explicit `panel` and its variants/overrides retain
  their existing precedence.

### Added
- **Compound time-range control for Dashboard filter bars** (#335). A pair of
  scalar date-like filters whose parameter names match #334's recognized table
  (`from`/`to`, `from_time`/`to_time`, `start`/`end`, `start_time`/`end_time`,
  case-insensitive — never `start`/`stop`) and whose executable consumers agree
  on date-like scalar contracts now renders as one compound control in a
  **Time** section ahead of the other filters, replacing the pair's two
  individual fields (source-backed/curated filters never group; every
  non-group filter keeps its existing control). The closed trigger shows the
  range resolved against the most recent execution wave's shared clock — no
  ticking timers — with the raw tokens carried in the accessible name; the
  popover stages token-or-absolute **From**/**To** edits with live resolved
  previews, per-field relative-time constants (typing filters the list;
  selecting stages, never commits), group-scoped session-only **Recently
  used** ranges (immediate apply), and an explicit **Apply** gated on both
  bounds resolving with `from ≤ to` (equal instants permitted). Apply commits
  both bounds atomically through the new public
  `DashboardViewerSession.applyFilters(entries)` batch API — one publish, one
  execution wave over the union of both parameters' resolved targets; a
  failed or identical draft commits nothing. Pair discovery sits behind a
  resolver seam so #334's saved-query `timeRanges` metadata can replace the
  interim name inference without touching the UI. Absolute bounds are now
  validated locally (`parseAbsoluteInstant`: preview formats, ISO-`T`
  variants, epoch digits for DateTime types, real calendar checks, years
  from 1900). The popover chrome is a shared primitive
  (`ui/popover.ts` `openAnchoredDialog`) extracted from the #189 multiselect
  — both controls now consume it — and `fixedAnchor` gained an opt-in pure
  viewport clamp for narrow screens.

- **Searchable multiselect for query-backed Dashboard filters** (#189). A
  source-backed filter whose executable consumers agree on one `Array(T)`
  parameter type now renders a dedicated searchable-checklist control: the
  closed trigger shows `All` / `Not set` / the selected label / `N selected`,
  and the popover offers a labeled search, a tri-state **Select visible**
  scoped to the filtered subset, per-option checkboxes, and **Clear / Cancel /
  Apply** — edits stay in a local draft until Apply, which canonicalizes by
  option order, commits at most once, and triggers at most one targeted
  panel wave (a no-op Apply issues nothing; Cancel/Escape/outside-click
  discard the draft and return focus to the trigger). The effective mode is
  inferred at runtime from the agreed consumer type (scalar `T` → single,
  `Array(T)` → multiselect) and can be overridden per filter with the new
  optional `DashboardFilterDefinitionV1.selection.mode` (`"single"` on an
  array contract commits `[value]`); inference is runtime-only and never
  written back into the dashboard document. A helper is exposed only when
  every executable consumer (the filter's resolved targets plus any dependent
  Filter sources) agrees on one compatible type — conflicting scalar/Array or
  element types, nested arrays, undeclared targets, target-less
  configurations, an explicit `multiple` on a scalar contract, or an unknown
  mode all fall back to the ordinary string input with persistent
  path-precise `filter-selection-*` diagnostics (never a silent downgrade).
  "Executable consumer" is defined once (`gatherExecutableConsumers`) and
  shared by contract resolution, the per-wave helper merge, and
  whole-workspace semantic validation — `validateDashboardSemantics` runs
  the same resolver at authoring/import time, mapping each diagnostic to
  its exact document path (`filters[i].selection.mode`,
  `filters[i].targets[j]`, `filters[i].parameter`), and a declaration
  outside the resolved consumer set (a presentation-error tile, a
  never-executing cascading-invalid source, a non-targeted tile) can never
  suppress a valid helper.
  Committed multiselect values stay real `string[]` arrays end to end —
  through viewer state, localStorage persistence, structural equality, and
  the existing typed `Array(T)` serializer (duplicates removed, empty-string
  elements valid, never comma-joined; an active empty array serializes as a
  real `[]` — activation is decided exclusively by the active flag, never by
  a value sentinel). Option refreshes reconcile by bound
  value: surviving selections stay active in canonical order (label/order-only
  changes rerun nothing), removals join one reconciled panel wave, an empty
  intersection deactivates the filter keeping its dormant value, and new
  options are never auto-selected; a refresh that lands while the popover is
  open cancels it (announced via a live region) so a stale draft can never be
  applied. Filter commits now plan their panel wave from the filter's
  **resolved targets** (explicit `targets` else declaring tiles) instead of
  rerunning every tile that merely declares the parameter name, and a failed
  source degrades the curated control to a usable free-text input (raw values
  still flow through the typed pipeline) instead of a disabled one.
- **Parameterized Dashboard Filter sources with single-layer dependencies**
  (#360). A Filter-role source query may now declare its own `{name:Type}`
  query parameters and bind committed *root* Dashboard filter values through the
  existing native `param_<name>` pipeline (no textual SQL interpolation) — so a
  query-log option source can compute its user / query-kind / exception-code
  lists for the selected `{from:DateTime}` / `{to:DateTime}` window instead of a
  hard-coded range. A source **waits** (issues no ClickHouse request) until every
  required root parameter is committed, active, valid, and serializable; relative
  values (`-1d`, `now`) resolve against one wall clock per wave; changing a root
  filter reruns **only** the sources that declare it, then the affected panels, in
  one combined wave; a refreshed option set that drops a filter's active value
  deactivates it before panels run; and a Filter source that depends on *another*
  source-backed parameter is rejected with a visible diagnostic (cascading Filter
  sources are unsupported — single-layer only). Dashboard execution and the
  Workbench Filter preview share one preparation operation (`prepareFilterSource`
  in `core/filter-execution.ts`), so structural diagnostics, relative-value
  resolution, optional-block materialization, validation/serialization, and
  native arguments are identical on both surfaces. Source-backed filters render a
  waiting / stale / error affordance in the filter bar (chosen by source
  topology, not transient status) instead of silently degrading to a plain
  control; a superseded or session-destroyed commit can never publish stale
  results or run its panels, and a dependency change clears the affected options
  so a stale set can't appear current while the new source loads. Filter
  execution injects no `readonly` setting (kept from #359).
  `examples/query-log-explorer.json`'s `qle-filter` source is migrated to a
  `{from:DateTime}` / optional `{to:DateTime}` window (matching its panels, where
  `to` is optional and means "up to now") as a worked example.
- **Favoriting a Filter-source query auto-binds it to a matching Dashboard
  filter** (#189/#364). A favorited `filter`-role saved query whose top-level
  output column name equals an (otherwise implicit) panel-tile parameter now
  attaches its option list to that parameter automatically — the field upgrades
  from a plain text box to the query-backed control with no authored
  `DashboardFilterDefinitionV1` and no per-filter settings (single vs.
  multiselect is still inferred from the consumer type). Binding is pure
  name-matching against the source's parsed output columns
  (`core/select-columns.ts`): a parameter produced by exactly one favorited
  source binds; a parameter produced by zero or by two-or-more (ambiguous)
  favorited sources stays a plain input rather than guessing. Runtime-only —
  the synthesized binding is never written back into the dashboard document.

### Fixed
- **One wall-clock snapshot per Dashboard execution wave** (#335). Each wave
  (initial load, Refresh, per-tile refresh, filter commits, dependent
  filter-source waves) now captures a single `wallNow()` reading, threads it
  through every relative-token resolution it performs, and publishes it as
  `DashboardViewState.waveWallNowMs`. Previously one refresh took several
  independent clock readings, so relative tokens (`now`, `-1d`) in different
  sub-phases of the same wave could resolve to instants seconds apart.
- **Saved-query, workspace, and Dashboard persistence stay consistent** (#365).
  Starring a panel query now creates the workspace's Dashboard and first tile
  atomically even when the committed aggregate previously held
  `dashboard:null`; applying New/Open/Replace workspace clears dangling saved
  query links from still-open editor tabs so Save can create the query instead
  of silently rejecting it; and Table/JSON result-view changes now dirty and
  update a linked query's Spec, with linked Save persisting the active
  Table/JSON/Panel view while preserving a Filter role's dormant view.
- Removed a stray NUL byte embedded in `dashboard-viewer-session.ts`'s
  `optionsSignature` (introduced by #361), which silently made the file look
  binary to plain `grep`/`rg`.
- **Dashboard filters sharing one Filter-source query now populate** (#359).
  When several Dashboard filter definitions referenced the same Filter-role
  source query, the viewer ran that query once per definition and keyed each
  provider by the filter-definition id — so `mergeDashboardFilterHelpers`
  rejected every helper as a duplicate provider, every control rendered empty,
  and the explanatory diagnostics were silently discarded. The filter runtime
  is now split into per-definition state and one `FilterSourceRuntime` per
  unique `sourceQueryId`: the source SQL executes exactly once per refresh wave
  no matter how many filters/parameters it feeds, the provider is keyed by the
  saved source-query id (two DISTINCT sources providing the same helper still
  correctly collide with no arbitrary winner), and the merge's diagnostics
  (info/warning/error, severity preserved) are now published to the Dashboard
  instead of dropped — including a `filter-helper-missing` warning (naming the
  source and column) when a source succeeds but omits a consumer's helper, so
  that filter no longer renders as an unexplained empty control. Each source
  also retains its last-known provider on its runtime and the merge reads the
  complete set, so a future selective wave (#360) can re-merge unaffected
  sources without clearing or rerunning them. This is the one-source-runtime
  boundary #360 builds on.

### Changed
- **Dashboard Filter execution no longer injects `readonly`** (#359). Server
  read-only policy belongs to ClickHouse user/profile configuration, not
  Dashboard/Workbench feature code; `filterExecution` keeps only its
  result-format/byte-cap transport settings. Panel execution is unchanged.
- **Filter option state is honest on failure** (#359). A source failure,
  missing helper, type conflict, or duplicate-provider collision now CLEARS a
  filter's curated options (with a visible diagnostic) instead of silently
  retaining stale ones, and an unresolvable `sourceQueryId` surfaces a visible
  `source-error` rather than a silent plain field. An active value no longer
  present in refreshed options is deactivated (its value kept) before dependent
  panels run; a non-empty → different-non-empty option replacement now updates
  the rendered combobox (a per-filter option revision folded into the
  filter-bar rebuild signature); and a superseded refresh wave can no longer
  publish options or activation over a fresher one.

## [0.6.1] - 2026-07-21

### Changed
- **Workbench File menu reorganized around primary workspace actions, with
  `Replace workspace…` renamed to `Open workspace…`** (#342). The first four
  rows are now one unlabeled group in a fixed order — New workspace…, Open
  workspace…, Export workspace… (`.json`), Import queries… — with the
  `IMPORT / REPLACE` and `EXPORT` section headings removed. Below a
  separator, `Share / Publish` (Download Markdown/SQL) now comes before
  `Variable history` (recent-values toggle + clear-all); the query-count
  footer stays last. `Open workspace…` is a pure rename — the picker,
  transactional planner (`planReplaceWorkspace`), conflict resolution, and
  destructive-replace confirmation are unchanged, with the confirm dialog and
  success toast copy updated to match ("Open workspace?" / "Opened
  workspace"). New `Icon.folderOpen()` (`ui/icons.ts`) replaces the reused
  `refresh` glyph on that row. The standalone Dashboard's own File menu
  (#302) is untouched.
- **Compact, type-aware widths for every `{name:Type}` variable/filter
  input** (#345). `.var-input` no longer reserves a flat 150px for every
  field regardless of its declared ClickHouse type — a new pure
  `filterWidthCategory`/`filterInputWidthCh` (`core/filter-width.ts`) resolves
  a stable `ch`-unit width from the type's effective base (`Nullable`/
  `LowCardinality` already unwrapped by `parseParamType`), or from `'enum'`
  for a dropdown/curated field: boolean/tiny-int 9ch, numeric 13ch, `Date`
  13ch, `DateTime`/relative-time 17ch (narrower than `DateTime` even though
  both share the same relative-time combobox control), enum/curated 14ch,
  generic string/UUID/unknown 16ch. Applied exactly once per field build via
  the shared `applyFieldWidth` (`ui/var-field.ts`, next to the existing
  `applyFieldState`) from both `{name:Type}` surfaces — the Workbench
  var-strip (`ui/app.ts`) and the Dashboard/detached-view/curated shared
  filter bar (`ui/filter-bar.ts`) — through a `--var-input-ch` CSS custom
  property, so the width never shifts while typing. The curated Dashboard
  Filter field's inline clear-button padding (18px wider than a plain
  field's) is compensated in its own `.filter-select .var-input` rule so its
  usable text room matches a plain field at the same width category. Long
  values still scroll horizontally inside the input; combobox/curated
  popups are unaffected and can render wider than their input.
- **Dashboard tiles move with a grip drag + live reflow, plain drags select
  text, and table/log cells open the shared cell-detail drawer** (#332). Native
  whole-card HTML5 `draggable` is removed. A tile move now starts from the
  top-left **grip** with no modifier, or from anywhere on the tile body with
  **⌘/Ctrl** held (the schema-graph modifier model) — so an unmodified body drag
  selects and copies text inside Markdown/text, table, and logs tiles instead of
  dragging the tile. On the Grid Tiles (grafana-grid) engine the dragged tile
  **lifts and follows the cursor** while the other tiles reflow live to open a
  gap at the insertion point; the move **commits to whichever slot the dragged
  tile overlaps by the greatest area** (max-overlap, `resolveOverlapInsertIndex`
  in `core/tile-reorder.ts` — replaces an earlier ≥2/3-of-destination-area
  threshold that a short tile, e.g. a KPI, could never reach against a taller
  neighbor and so always snapped back) and otherwise **snaps back** when it
  still overlaps its own origin most or overlaps nothing — the snap-back restore
  is synchronous and independent of the signature-gated grid reconcile. Sibling
  motion uses a FLIP animation that honors `prefers-reduced-motion`. The flow
  engine also lifts the dragged tile to a floating follower under the cursor,
  but still resolves its destination by the simpler point-hit-test (its KPI
  band has no grid slot to live-reflow into, so there is no placeholder or
  FLIP there). A move still dispatches the existing atomic `move-tile` command
  exactly once and preserves canonical `dashboard.tiles[]` order; a cancelled
  gesture (pointercancel / window blur / Escape) changes nothing, and the click a
  completed move would synthesize is suppressed so it never activates a cell.
  While ⌘/Ctrl is held the grid shows a grab affordance (`.dash-grid.modkey`).
  Dashboard table cells and log fields now open the **same** right-side
  cell-detail drawer used by Workbench results (shared `openCellDetail`, no
  Dashboard-specific viewer) — in both edit and read-only modes, over the
  Dashboard's own document — passing the source column name/type and the raw
  (untruncated) value; each source-backed log field (time, level, message, and
  each extra) is independently clickable and keyboard-operable (Enter/Space).
  A cell value that looks like **Markdown** now opens the drawer on a rendered
  preview (with a Rendered↔Source toggle, like HTML) using the same bounded,
  fail-closed `renderDocMarkdown` viewer the reference-docs pane uses; plain,
  non-markup text still shows as source only. **Dashboard Text (Markdown) tiles**
  now render inline through that same top-quality doc viewer (the lightweight
  `core/markdown-lite.ts` renderer is retired — the app has a single Markdown
  paradigm), and a Text tile is click/Enter-Space-openable into the shared
  preview drawer (a drag-select or an inner-link click never opens it). Read-only
  Dashboards never enable tile movement.
- **Grid Tiles is the default Dashboard style; Full view replaces the old
  Full width preset** (#321). The `grafana-grid@1` engine is renamed to
  **Grid Tiles** in the UI (the persisted `{type:'grafana-grid',version:1}`
  identifier is unchanged) and is now the layout every newly created
  Dashboard starts in (empty `items`, a `columns-2` flow fallback; new tiles
  keep the span-6/height-2 default). The old `flow@1/full-width` preset is
  removed completely — from the flow JSON Schema and generated types, flow
  normalization/render, the selector, `is-wide` CSS, legacy layout mapping
  (`wide` now maps to `report`), grid→flow fallback generation (now
  `columns-2`), and all fixtures/tests; valid flow presets are now only
  `report`, `columns-2`, `columns-3`. **Full view** is introduced as a
  transient, never-persisted render mode over Grid Tiles: every tile renders
  one-per-row at the full effective column count (12/6/4/2 responsive) while
  the authored spans are left untouched. Toggling Grid Tiles ↔ Full view runs
  no `change-layout`, never commits, and never bumps the Dashboard revision;
  a reload or a newly opened viewer session always starts in Grid Tiles.
  Selecting Full view from a flow preset performs exactly one persisted
  flow→grid conversion, then only the transient override; selecting a flow
  preset from Full view clears the override and persists the flow change.
  While Full view is active, reorder/add/delete and vertical height changes
  still persist, but the corner resize becomes **vertical-only** (a
  `ns-resize` affordance with a "Resize tile height" label) — horizontal
  pointer movement can never change a span. The editable style selector is
  ordered `Grid Tiles, Full view, Report, 2 columns, 3 columns`; a read-only
  Dashboard exposes a reduced `Grid Tiles / Full view` runtime toggle (only
  when its layout is grafana-grid — a read-only flow Dashboard shows no
  selector), and the selector's accessible name is now `Dashboard style`.
  Export/import never carry Full view state. There is no read-compatibility
  path for `flow@1/full-width` development data (owner decision — the project
  has no production compatibility requirement for it).
- **Grafana-grid KPI tiles are polished in both Dashboard modes** (#316,
  follow-on to #291). Edit mode keeps the full editing shell but drops the
  never-populated tile footer (no more phantom separator line). View mode
  strips all outer tile chrome — header, border, background, radius, body
  padding — leaving the KPI cards (or the loading/unfilled/error state card,
  now full-width with `role="status"`/`role="alert"` and the tile title in
  its accessible name) as the only visible surfaces; the tile element stays
  the CSS-grid item and carries `role="group"` + the query title as its
  accessible name. KPI cards inside grid tiles lay out as an equal-width
  responsive grid (`auto-fill`, min 150px — a lone last-row card no longer
  stretches) with container-query value typography
  (`clamp(16px, 14cqi, 38px)`). Shared card polish everywhere (workbench,
  flow bands, grid tiles — owner decision pinned on #316): the value's
  number+unit render as glued spans that never orphan the unit to its own
  line, descriptions clamp to two visual lines (full text stays in the DOM),
  and delta rows anchor to the card bottom for consistent rhythm. Flow-band
  stream layout, ordinary tiles, schemas, persistence, and KPI value
  semantics are unchanged. New real-browser e2e suite
  (`tests/e2e/dashboard-grid-kpi.spec.js`) covers the frameless view, equal
  widths, unit orphaning, delta alignment, 12/6/4/2 responsive columns,
  themes, and 360px no-overflow.

### Added
- **Long Dashboards auto-scroll while a tile is being dragged** (#338, extends
  the #332 grip / ⌘/Ctrl tile move). Once an active move crosses the movement
  threshold, holding the pointer near the top or bottom edge of the visible
  `.dash-page` viewport scrolls it continuously — direction and speed follow
  the pointer's distance from the edge (bounded, proportional acceleration;
  a lower bounded speed under `prefers-reduced-motion`), and scrolling
  continues with the pointer held stationary. The destination preview
  recomputes every frame the page scrolls (captured tile home rects are
  shifted by the scroll delta, so a stationary pointer lands on the newly
  revealed slot), yet the move still persists exactly **one** atomic
  `move-tile` command on release and nothing during the gesture; a cancel
  (pointerup outside / pointercancel / window blur / Escape) changes neither
  tile order nor revision. The effective top edge sits below the sticky
  Dashboard topbar. Plain text selection, chart brushing, cell interaction,
  tile resize, and read-only Dashboards never start auto-scroll. The
  edge-velocity math and the single-`requestAnimationFrame`-loop controller
  are a pure, injected-seam module (`core/dashboard-autoscroll.ts`,
  `DragAutoScrollTarget` + `FrameScheduler`) so a future nested Dashboard
  scroll container can reuse the controller unchanged; both the Grid Tiles
  live-reflow and the flow (Report / 2-column / 3-column) reorder paths
  auto-scroll. Fixed alongside: the grabbed tile now floats (`position:fixed`)
  and follows the cursor in **every** editable layout, not just Grid Tiles —
  a flow-layout tile used to stay `position:static` while dragging, so
  auto-scroll carried it off-screen with the rest of the page instead of
  keeping it under the pointer; this covers the KPI band tile as well. No new
  bundled runtime dependency.
- **Broad version-exact reference via `system.documentation` (ClickHouse
  26.6+) with safe Markdown rendering** (#60 Phase 3, #315). Servers 26.6
  and newer contribute the full breadth of `system.documentation` — table
  functions, settings, MergeTree/server settings, dictionary
  layouts/sources, skipping indexes, disk types, combinators, and future
  unknown kinds (rendered with their preserved server label) — as the
  fallback and depth source behind the structured loaders. Parsed pre-26.6
  servers are short-circuited without a single query or probe; 26.6+ and
  unknown-version connections get one silent capability probe (`source`
  column optional — real 26.6 builds ship only name/type/description).
  Markdown bodies are tokenized by **`marked` (the sixth bundled runtime
  dependency — used strictly as a pure lexer; `marked.parse()`/HTML output
  is never called; measured +44 KB raw / ~3% artifact delta)** and the
  token tree is projected 1:1 into strict DOM construction by
  `src/core/doc-markdown.ts` + `src/ui/doc-markdown-view.ts` — no
  `innerHTML` anywhere, an injected https-only link policy, recursive
  inline fidelity (a link inside bold stays a link), and Docusaurus
  `:::tip/note/info/warning/danger/important` admonitions rendered as
  styled asides: headings (setext included), lists, quotes, tables,
  thematic breaks, and fenced code with exact-copy buttons and ClickHouse
  highlighting for SQL fences; raw HTML, images, and policy-rejected links
  stay visible as literal text (fail-closed); byte/node/nesting/link limits
  truncate quietly (fixed-seed fuzz-tested never-throws contract). The classifier gains strong contexts for SETTINGS names
  (query-level and MergeTree DDL), FROM/INSERT INTO FUNCTION table
  functions, CODEC lists, skipping-index TYPEs, and `system.*` tables; F1
  on an unresolved bare word now opens an accessible disambiguation list
  (kind + name + summary, back-stack integrated) instead of doing nothing.
  A visually secondary "View latest on clickhouse.com" link appears only
  when safely derivable from the entry's source path — the app never
  fetches the public site.
  types** (#60 Phase 2, #314). The documentation pane and F1 now cover four
  more entity kinds, each fed by its own capability-probed system table
  (`system.formats` — which has no `syntax` column and is never asked for
  one —, `system.table_engines`, `system.database_engines`,
  `system.data_type_families`; probed independently once per connection, so
  a denied source degrades alone). A pure strong-context SQL classifier
  routes the caret: top-level `FORMAT <name>` (either FORMAT/SETTINGS
  order, never confused with `format()` calls), `ENGINE = <name>` in table
  vs database DDL (leading comments handled), and strong data-type
  positions — CREATE column definitions, `CAST(x AS T)`, `x::T`, `{p:T}` —
  resolving the innermost nested type under the caret. Format completion
  info gains Open reference; schema surfaces gain keyboard-accessible
  `Open engine reference` / `Open type reference` buttons (tree rows +
  detail pane, existing gestures untouched, hidden when the source is
  durably unavailable). The pane renders the new kinds with syntax blocks,
  capability facts, and related entries navigable in place through a
  bounded session-local Back stack.
- **Version-exact function reference docs from the connected server** (#60
  Phase 1, #313). CM6 hover and completion info upgrade in place with the
  connected ClickHouse server's own `system.functions` metadata (signature,
  one-line summary, `since` version badge, `Alias of` notice) and expose a
  keyboard-activatable **Open reference** button; **F1** in the editor opens
  the same entry for the symbol at the caret (documented in the shortcuts
  dialog). A persistent, **non-modal** right-side documentation pane
  (`src/ui/doc-pane.ts`, resizable, `role="complementary"`, Escape/close
  with focus restore) renders the full structured entry: description,
  arguments/parameters, returned value, categories,
  deterministic/higher-order badges, and copyable examples highlighted with
  the shared ClickHouse CM6 dialect (extracted to `src/editor/ch-lang.ts`).
  Availability is **capability-gated, not version-gated**: the actual
  `system.functions` columns are probed once per connection (works on
  pre-26.6 servers; missing optional columns degrade field-by-field; denied
  or absent sources degrade silently, cached per connection), lookups are
  deduplicated, keyed `kind:name`, and connection-generation-safe across
  reconnects, and no documentation SQL ever runs on the keystroke path. The
  shared non-modal drawer chrome behind the pane was extracted from the
  cell-detail/rows-viewer scaffold (`src/ui/drawer.ts` — the shared Drawer
  primitive deferred to #60), and the editor layer is now an enforced leaf
  (`build/check-boundaries.mjs`: `src/editor` must not import `src/ui`; UI
  actions are injected app callbacks).
- **Line/area/bar/hbar charts over a time-role X column now draw a genuine
  Chart.js `time` scale** (#309, follow-up to #310's category-axis
  mitigation). `chartJsConfig` (`src/core/chart-data.ts`) switches the
  category axis to `type: 'time'` and each dataset's points to `{x, y}`
  (epoch in `y` and value in `x` for `hbar`, whose category axis is `Y`;
  epoch in `x` for every other cartesian type) whenever the X column's role
  is `'time'` and every displayed category parses as a ClickHouse
  `Date`/`DateTime`/`DateTime64` string (a new pure `chartTimeValue()`,
  reading the literal wall-clock digits with no timezone conversion — same
  "show it exactly as written" contract as the existing `chartLabel()`, with
  a calendar round-trip check so a date-shaped-but-invalid value like month
  `13` falls back rather than the `Date` constructor silently rolling it
  over); any category that fails to parse, or an empty result, falls the
  whole axis back to the existing category scale. Chart.js then places ticks
  on natural time boundaries and points/bars at their real elapsed time
  instead of one evenly-spaced category per row, so gaps in
  irregularly-sampled data show as gaps rather than being compressed away.
  Pie and non-time-role charts are unaffected. **Fifth bundled runtime
  dependency** (CLAUDE.md rule 4): **`chartjs-adapter-date-fns`** (+ its
  `date-fns` peer), imported for its registration side effect next to
  `chart.js/auto` in `main.ts` — measured **+11.6 KiB gzip / +9.7 KiB
  brotli** to the artifact (date-fns's tree-shaken surface across every
  add/difference/startOf/endOf unit the adapter imports; larger than the
  issue's ~3 KB estimate, still a low single-digit percent of the bundle and
  no new network requests).

### Fixed
- **Editable Dashboard and Workbench are now two editors over one committed
  workspace, with consistent exports** (#341). Previously the standalone
  Dashboard persisted layout/order/resize/delete edits with a fire-and-forget
  `workspace.commit()` that only bumped a route-local revision counter — it
  never projected the committed aggregate back through
  `app.applyCommittedWorkspace`, so `app.state.dashboard` (which both exports
  read) went stale, rapid edits could start overlapping commits outside the
  saved-query write queue, and an older commit resolving after a newer one
  could clobber tile order/placement/style. All workspace writes now go through
  one app-level primitive, **`app.mutateWorkspace(transform)`**: a queued op
  (the same `serializeWrite` chain saved-query mutations use) that reads the
  latest **committed** aggregate via `workspace.loadCurrent()` at dequeue time,
  applies the caller's transform to it, and commits — because a queue around
  independently pre-built full snapshots still loses updates, every File-menu
  mutation (rename, import queries/dashboard, replace, new) builds its
  candidate **inside** the transform from that dequeue-time baseline (the
  conflict dialog's snapshot is UX-only, and the collected decisions are
  **revalidated** at dequeue time: a query-id conflict minted while the import
  waited in the queue auto-resolves when canonically identical, and aborts the
  import with a "workspace changed" toast when the content differs — never a
  silent skip; the "Imported N" toast now reports what the plan actually
  imported, not the bundle size), and every editable Dashboard command
  (`move-tile`, `update-placement`, `change-layout`, `remove-tile`) is queued
  as a **command descriptor** re-applied to committed truth when its turn
  arrives — never as a document snapshot derived from a prior command's
  still-uncommitted optimistic doc, so a rejected command can't be smuggled
  into a later command's successful commit. An optimistic preview stays
  instant; after every resolution (success, `ok:false`, no-longer-applies
  abort, or a storage rejection) the still-pending descriptors are **rebased**
  onto committed truth and re-published, so a failed command's effect
  disappears everywhere, revisions stay strictly monotonic, the diagnostic is
  toasted, and the shared queue is never wedged. A failed or no-longer-applies
  command rolls back to the **dequeue-time** committed truth its queued op
  observed (never a stale route-local cache — so a tile a concurrent producer
  removed disappears from the render, too), and a rollback that must *restore*
  a removed tile rebuilds the Dashboard route from committed truth (#350),
  since the viewer session's `syncDocument` can reorder and drop tiles but
  never reinstate one. Dashboard export and
  Workbench workspace export both now `flushWorkspaceWrites()` (await pending
  writes) then build from the latest committed `StoredWorkspaceV1`
  (`workspace.loadCurrent()`), falling back to `app.state` only when no
  aggregate is persisted or the read rejects — so the Dashboard document and
  every shared saved-query resource are **canonically identical** across both
  bundles, and export/import preserves exact tile order, shape, style, filters,
  and membership. Same-tab writes are strictly serialized here; cross-tab
  optimistic-concurrency (revision CAS) is a scoped follow-up (#343), consistent
  with #341's cross-tab minimum contract (reload consistency).
- **Dashboard KPI bands now render as one horizontal wrapping row in flow
  layouts** (#331). The flow renderer emitted each consecutive-KPI band member
  as `.dash-kpi-member`, but the `display:contents` flattening rule targeted a
  never-emitted `.dash-kpi-source` class, so members stayed block-level and the
  KPI cards stacked vertically instead of sharing the band's `flex-wrap` stream.
  The class contract is unified on `.dash-kpi-member` across renderer, CSS, and
  tests; Report / 2-column / 3-column bands are now a single horizontal card
  stream in canonical tile order. Grid Tiles (#321) and frameless (#316) KPI
  behavior are unchanged.
- **Dashboard File menu now shares the Workbench File-menu primitive** (#331).
  A new data-driven `src/ui/menu.ts` (`openMenu`) owns the shared dropdown
  structure and interaction grammar — icon/label/metadata columns, section
  headings, separators, overlay/outside-click dismiss, Escape + focus-restore,
  ArrowUp/Down roving focus, `aria-haspopup`/`aria-expanded`, and anchored
  placement — and both the Workbench (`file-menu.ts`) and Dashboard
  (`buildDashboardFileMenu`) menus are rebuilt on it, ending the duplicated
  builders. The Dashboard File trigger now uses the same downward-chevron
  treatment as Workbench (no more right-arrow that misread as navigation) and
  its menu gains EXPORT/IMPORT/OPEN section headings, icons, and `.json`
  metadata; read-only Dashboards expose Export only at this point (superseded
  by #347, below). Actions and permission rules are unchanged.
- **Read-only Dashboard views (detached current-workspace and one-time
  session-bundle) no longer render a File menu at all** (#347). The prior
  read-only behavior above (#331) still showed an Export button, but
  `exportDashboardAction` resolves the latest **committed primary** workspace
  via `app.workspace.loadCurrent()` — in a read-only route that primary
  workspace can be unrelated to the Dashboard actually on screen, so clicking
  Export could silently download the wrong (and potentially private) Dashboard
  and its queries. `buildDashboardFileMenu` no longer takes a `readOnly` flag;
  the caller now omits the button/menu from the DOM entirely — never disabled
  or visually hidden — when the resolved route is read-only, keeping keyboard
  tab order and the accessibility tree free of an inoperable control. Editable
  current-workspace Dashboards are unaffected and keep the full
  Export/Import/Open-for-viewing menu.
- **Dashboard tile content stays inside the tile body, above the footer**
  (#331). `.dash-tile-body` gained `overflow:hidden`, and the tall-panel
  containment contract (`flex:1 1 auto; min-width/min-height:0; max-height:100%;
  overflow:auto`) now covers Markdown/text (`.md-view`) and the diagnostic
  `.panel-with-note` wrapper alongside tables and logs, so long content scrolls
  inside the body instead of painting over the footer or neighbouring tiles
  (both flow and Grid Tiles engines, which share the tile shell). A metaless
  panel (e.g. a Text tile that never runs a query) now hides its footer rather
  than reserving an empty footer line, reasserted before the unchanged-rows
  repaint short-circuit so a sibling tile's refresh can't leave it stale.

## [0.6.0] - 2026-07-18

### Added
- **`grafana-grid@1` — a rowless Grafana-style tile-grid Dashboard layout**
  (#291, building on #280). A second layout engine next to the normative
  `flow@1`: a responsive 12-column tile grid with deterministic packing —
  per-tile `{span: 1–12, height: 1–16 row units}` (`px = 32 + 88×units`;
  units 1/2/3 ≈ the flow tiers, unit 16 = 1440 px ≈ 5× flow's tallest;
  the legacy `compact|medium|large` strings stay readable and upgrade to
  1/2/3 on the next edit) persisted in `layout.items`, vertical position
  derived purely from the
  canonical `dashboard.tiles[]` order, and a container-width column clamp
  (12/6/4/2 at ≥1160/≥720/≥470 px of *content-box* width) that never mutates
  persisted spans. No rows, no folding (owner decision). The engine registers
  lazily in the layout registry (`schemas/dashboard-layout-grafana-grid-v1.
  schema.json` + generated types/validator; the `fallback` slot stays pinned
  to `flow@1`), and every grid mutation deterministically regenerates a
  **valid `flow@1` fallback** (grid→flow span 1–4→1, 5–8→2, 9–12→3). The
  edit-mode layout select gains a **Grafana grid** option: switching from
  flow seeds spans from the current flow placements (1→4, 2→6, 3→12) and
  snapshots the flow layout as the fallback; switching back restores it.
  Workbench-only (edit-mode) placement editing per the mock: whole-card
  drag-reorder, **corner-drag resize** (span snaps to columns, height snaps
  per row unit across all 16 stops; the tile is pinned to its column during
  the drag so the persisted placement always matches the pointer), and tile
  delete — every change propagates immediately (no Save/Undo, owner
  decision). KPI tiles place like any other tile (no KPI band). Filters,
  panel/KPI rendering, and view-mode read-only rules (#306/ADR-0003) are
  reused unchanged. Includes a real-browser e2e harness
  (`tests/e2e/dashboard-grid.*`) covering packing, row-unit heights, the
  responsive clamp, 360 px overflow, resize, and hover chrome.
- **Direct + full-screen Dashboard viewing with a one-time cross-tab handoff**
  (#288, Dashboard v1 Phase 6 — the final phase of #280; also lands #302). Two
  explicit viewing modes on the standalone `/dashboard` route (ADR-0003): an
  **edit mode** opened from the new Workbench-header **`Dashboard →`** control
  (bookmarkable `?ws=&dash=` current-workspace route that verifies BOTH the
  workspace and dashboard ids — showing *Dashboard unavailable* rather than
  silently opening a different one — and shares the IndexedDB workspace store so
  reorder/relayout persist), and a read-only **view mode** opened from the
  Dashboard page's own **File → "Open for viewing…"** that snapshots the current
  dashboard into a detached copy in a **new tab**. The cross-tab *state* handoff
  uses a **one-time IndexedDB token** (unguessable 256-bit token; the validated
  bundle is written before the tab opens, atomically consumed exactly once, and
  the token stripped from the URL via `history.replaceState`) — `sessionStorage`
  alone is insufficient. The consumed handoff **materializes** into a persistent
  detached-views store under its own id, so a view tab survives relogin/reload
  while staying detached from later Workbench edits. The read-only viewer path
  builds no Workbench/editor modules (boundary-tested). Closes #153.
- **Portable open/import/export + a transactional import planner** (#287, Dashboard
  v1 Phase 5). The File menu's ambiguous `Append` is gone, replaced by
  resource-oriented **Import queries / Import Dashboard / Replace workspace** and
  **Export Dashboard / Export workspace** operations, all writing the one canonical
  `altinity-sql-browser/portable-bundle` (`PortableBundleV1`) interchange format
  through the deterministic canonical encoder. Export never mutates workspace
  identity or Dashboard revision; **Export Dashboard** emits a dependency closure
  (the Dashboard plus exactly its referenced queries), **Export workspace** emits
  the whole catalog plus the zero-or-one Dashboard. Import runs a transactional
  planner (`src/workspace/import-planner.ts`): parse → schema validation → select
  Dashboard → dependency closure → conflict detection → decisions → complete ID
  remapping → central reference rewrite → candidate workspace → whole-workspace
  validation → atomic commit, with conflict actions **use-existing** (automatic
  only on canonical equality), **copy** (fresh id + full reference rewrite),
  **replace**, and **skip** (skipping a required Dashboard dependency invalidates
  the Dashboard import rather than silently dropping a tile). A multi-Dashboard
  bundle asks which Dashboard to import. Legacy Library v1/v2 files remain
  **importable** (normalized to an in-memory bundle with `dashboards: []`); no new
  Library-only JSON is written.

### Changed
- **Dashboard operations moved out of the Workbench File menu** (#302). The
  Workbench File menu now owns workspace + query-collection operations only (New
  workspace / Import queries / Replace workspace / Export workspace / Download
  Markdown+SQL / variable history). Dashboard navigation moved to a `Dashboard →`
  control next to the workspace name (shown only when a Dashboard exists; opens
  the standalone route in a new tab), and **Import Dashboard / Export Dashboard**
  moved to the standalone Dashboard page's own resource-scoped **File** menu
  (which also hosts the new **Open for viewing…**). Dashboard import still runs
  the transactional planner and commits atomically; portable-bundle, schema, and
  persistence semantics are unchanged.
- **The `StoredWorkspaceV1` aggregate is now the single source of truth for the
  saved-query collection** (#287). All query CRUD (create/edit/rename/delete/star)
  commits the whole workspace through the atomic `WorkspaceRepository`
  (validate-before-publish per #280) instead of the flat `asb:saved` localStorage
  key, which is retired (read once only as the legacy-migration source); boot loads
  and projects the aggregate. Saved-query writes are serialized so two rapid
  concurrent edits can't interleave and resurrect a just-deleted query. The
  external-bundle **trust preflight** and durable cross-tab transport are deferred
  to Phase 6 (#288); every Phase-5 file operation only commits to the workspace and
  never executes queries.

### Fixed
- **The Workbench favorite star now drives Dashboard tile membership** (part of
  #299, post-#287 aggregate). Since `dashboard.tiles[]` became the canonical
  Dashboard membership (#280/#287), starring a query only flipped `spec.favorite`
  and never added a tile, so favoriting/unfavoriting in the Workbench had no
  effect on the Dashboard. `toggleFavorite` now reflects the flip onto tile
  membership in the **same atomic commit**: a favorited **panel-role** query gains
  a tile (mirroring the legacy migration's role gate — a filter/setup-role
  favorite stays favorite-only), and unfavoriting removes every tile referencing
  the query and scrubs those tile ids from filter targets. `spec.favorite` stays
  the star's visual state (the documented dual-write retirement is deferred).
- **A corrupt-but-present workspace aggregate is surfaced on boot instead of
  silently swallowed** (#300). `WorkspaceRepository` gains `loadCurrentResult()`,
  which distinguishes "no aggregate yet" (`empty`) from "a record is stored but
  won't decode/validate" (`corrupt`) — previously both collapsed to `null`, so a
  corrupt record let boot continue on the legacy projection and the next CRUD
  commit orphaned it with no user-visible error. Boot now shows a toast ("Saved
  workspace could not be read…") with a **Reset workspace** action that clears the
  unreadable record and rebuilds a fresh aggregate from the current local state.
  `flashToast` gained an optional non-auto-dismissing action button.
- **Dashboard filter values persist across a reload again** (#303, regression from
  the #280 dashboard rewrite). The isolated viewer session initialized every
  filter purely from `def.defaultValue`/`defaultActive` and persisted nothing, so
  a committed filter value lived only in memory and reset on reload (the Workbench
  var-strip was unaffected). Filter runtime value/active now persist to an
  **isolated** per-dashboard key (`asb:dashFilters`, `dashboardId → filterId →
  {value,active}`) — deliberately separate from the Workbench's
  `asb:varValues`/`asb:filterActive` — seeded back on load. Persistence stays a
  pure `dashboard/model` store behind the existing `loadJSON`/`saveJSON` seam;
  opening a dashboard does not persist its defaults (only genuine committed
  changes write).
- **Dashboard filter strips no longer wrap, the visible "Clear all" control and
  "N active" count are both removed, and the layout switcher moved to the
  header as a compact select** (#294 + a same-PR 2026-07-18 owner follow-up —
  together reverse the visible clear-all/count UX decisions made in #286/#293).
  `.dash-toolbar` and the filter field region (`.dash-filter-host`, which IS
  now the horizontally-scrolling viewport — no separate `.filter-strip-scroll`
  wrapper) stay `flex-wrap: nowrap` at every viewport width, not just the
  ≤768px mobile breakpoint from #248 — several `{name:Type}` params at desktop
  width used to wrap the toolbar onto extra rows, permanently shrinking the
  dashboard's data area. Both the **Clear all** button (`filterClearAllButton`,
  `.dash-filter-clear-all`) and the **"N active"** status (`filterActiveCount`,
  `.dash-filter-count`/`.dash-filter-count-host`) are deleted outright —
  `DashboardViewerSession.clearAllFilters()`/`activeFilterCount` stay tested
  application-level operations/state with no UI trigger or display. The
  toolbar itself is now hidden whenever there are no filters, at every width
  (previously mobile-only), since it holds nothing else. The flow preset
  switcher is now a compact `<select class="result-panel-select">` — matching
  the Workbench's panel-type picker convention (`renderPanelTypePicker` in
  `panels.ts`) — in the header's top row right after the tile-count chip,
  replacing the four-button `.dash-seg` segmented control that used to live in
  the filter toolbar; a select needs far less room, so the whole toolbar width
  goes to filters. The required/optional `{name:Type}` filter-name affordance
  (shared by the Workbench var-strip and the Dashboard filter bar) is now bold
  for a required name instead of a leading `*` glyph. Combobox popovers,
  relative-time previews, and filter execution/activation/debounce/recents/
  validation are unchanged. The "hide native scrollbar, allow horizontal
  auto-scroll" viewport contract is one shared rule read by both `.var-strip`
  and `.dash-filter-host` (previously copy-pasted per surface — review
  follow-up), and the scroll viewport carries enough vertical padding that a
  focused field's box-shadow ring is never clipped by its `overflow-y: hidden`.
  New Playwright coverage (`dashboard-mobile.spec.js`, `workbench-var-strip.spec.js`)
  pins the never-wrap/scroll contract, the focus-ring padding, the bold/muted
  required-vs-optional styling, and the relocated layout select, for both
  surfaces in a real browser (invisible to the happy-dom unit suite).
  **Dead-CSS cleanup** from an audit prompted by the same change: `.dash-skip`
  (styled but never constructed by `dashboard.ts` since #286 flipped Dashboard
  membership onto `dashboard.tiles[]` — there is no "N not shown" concept left
  to display) is deleted from `src/styles.css` and the `dashboard-mobile.html`/
  `.spec.js` fixture. A second dead class, `.dash-grid.is-wide`, turned out to
  guard a real, still-intended "Full width" preset behavior that #286's
  `flow@1` rewrite never re-wired (`is-report` kept its toggle, `is-wide` lost
  its) — filed as **#298** rather than deleted or silently fixed here, since
  restoring it is a distinct rendering fix that needs its own >1560px-viewport
  regression test.
- **Line/area chart X-axis tick labels no longer rotate into an unreadable
  wall of timestamps at a few hundred rows.** Line/area charts still draw a
  Chart.js `category` scale (one tick per distinct row — no time scale yet),
  so `chartJsConfig` (`src/core/chart-data.ts`) now forces the category axis's
  ticks to `autoSkip: true, maxRotation: 0, minRotation: 0` for those two chart
  types, letting Chart.js drop enough labels to stay horizontal instead of
  rotating every one of them. Bar/hbar/pie category axes are unchanged. A real
  Chart.js time scale (natural tick boundaries, gap-aware point placement) is
  filed as a follow-up: **#309**.

### Added
- **Dashboard v1 contracts, codecs, canonical encoding, and resource limits**
  (#283, phase 1 of #280). New canonical JSON Schemas ship through the existing
  manifest pipeline with generated types and Ajv-compiled validators:
  `stored-workspace-v1`, `dashboard-v1` (with `DashboardTileV1`,
  `DashboardFilterDefinitionV1`, `DashboardLayoutDocumentV1`, and the
  `DashboardLayoutFallbackV1 = flow@1` fallback), `dashboard-layout-flow-v1`
  (the normative `flow@1` contract with the closed `FlowTilePlacementV1` —
  span 1|2|3, height compact|medium|large — and the presets
  full-width|report|columns-2|columns-3), and `portable-bundle-v1`
  (`queries` + `dashboards`, both required even when empty). `query-spec-v1`
  gained the additive `QueryDashboardPresentationV1` (role/defaultVariant/
  variants/sizeHints) plus `QueryPresentationPatchV1` (RFC 7396 merge-patch of
  the panel spec) — a revision, not a new Spec version; the schema-driven Spec
  editor autocomplete picks the new fields up automatically. Pure `src/`
  additions: one canonical deterministic encoder (`dashboard/model/canonical-json.ts`,
  shared by export/persistence/hashing/equality), a deterministic
  numeric-aware diagnostic sorter, `PORTABLE_LIMITS` enforcement
  (schema bounds + codec UTF-8-byte/depth guards + runtime re-checks), and
  whole-workspace cross-resource semantic validation. No persistence, no UI,
  no import planner yet (later phases of #280).

- **Atomic `StoredWorkspaceV1` persistence and one-shot legacy migration**
  (#284, phase 2 of #280). New pure `src/workspace/` modules: a
  `WorkspaceRepository` (`loadCurrent`/`commit`/`clearCurrent`) that
  validates the complete candidate through phase-1 whole-workspace validation
  **before** writing and then atomically replaces the aggregate in one
  transaction — a failed write leaves the previously stored workspace intact,
  never increments Dashboard revision, and never produces a partially-mixed
  workspace (multi-tab policy: last successful commit wins, atomic replacement,
  not compare-and-swap). Persistence is **IndexedDB** (chosen over a single
  localStorage key: the 10 MiB `maxDecodedJsonBytes` aggregate exceeds the
  ~5 MB localStorage quota, and phase 6 needs IndexedDB anyway) behind an
  injected `WorkspaceStore` seam (`env.indexedDB`, mirroring the crypto/storage
  seams) so the repository unit-tests against a plain in-memory fake. The
  one-shot legacy migration builds one candidate `StoredWorkspaceV1` from the
  flat `asb:*` keys — the initial Dashboard from `spec.favorite` (panel-role
  favorites become tiles in catalog order), `asb:dashLayout`/`asb:dashCols`
  converted to a valid `flow@1` layout — validates the whole candidate, and
  persists it atomically; it runs only when no aggregate record exists and
  never deletes or modifies legacy keys. Repository + operation semantics only;
  no authoring commands, viewer, or import UI yet (later phases of #280).
  - **`spec.favorite` dual-write removal path.** During phases 2-4 `spec.favorite`
    stays the membership source the existing favorites-driven Dashboard render
    reads, while `dashboard.tiles` becomes the canonical membership going
    forward; phase 3's star command dual-writes both. Membership **reads** flip
    to `dashboard.tiles` when phase 4's `DashboardViewerSession` + `flow@1`
    viewer replace `src/ui/dashboard.ts`'s `savedQueries.filter(queryFavorite)`
    render; the `spec.favorite` **dual-write** is then deleted in the v1
    Dashboard GA release (the release closing #280), after phase 5 lands — the
    schema keeps `favorite` only as an ignored legacy-compat field readable by
    old migrations.

- **Dashboard authoring domain: atomic commands, presentation resolution, and
  workspace-wide validation** (#285, phase 3 of #280). New pure/typed modules,
  each 100%-covered, keeping the direction model/layouts ← application ← UI:
  - `dashboard/model/json-merge-patch.ts` — an in-house RFC 7396 JSON Merge
    Patch (no new dependency): objects merge recursively, a `null` member
    deletes, arrays and non-objects replace wholesale, and the result shares no
    structure with its inputs.
  - `dashboard/model/presentation-resolver.ts` — the ONE canonical presentation
    resolver (base panel → selected/`defaultVariant` variant patch → tile
    override → final validation), shared by Dashboard viewing, saved-query
    mutation validation, and tests. Enforces the #280 rules: a missing selected
    variant name fails (no silent fallback), neither a variant nor an override
    may change `panel.cfg.type`, deleting a required field fails final
    validation, and result-column role validation runs only when result
    metadata is available.
  - `dashboard/layouts/flow-layout.ts` — the minimal `flow@1` layout plugin the
    authoring domain needs: placement validation (closed span/height contract),
    document normalization (orphan-placement pruning), size-hint-derived initial
    placement, and `resolveActiveLayoutPlugin` (flow@1, or an unsupported
    primary with a valid flow@1 fallback, else a load failure).
  - `dashboard/application/dashboard-commands.ts` +
    `dashboard-query-resolver.ts` — fallible, atomic typed commands for every
    membership/placement/layout change
    (`add-query`, `add-query-instance`, `remove-tile`, `move-tile`,
    `update-tile`, `update-placement`, `change-layout`): clone the draft → apply
    to an isolated candidate → return diagnostics or the candidate without
    mutating the input. The unused session wrapper was removed before gaining
    a production caller; future non-DOM authoring must be built against the
    shared `mutateWorkspace` pipeline.
  - `dashboard/application/saved-query-mutation.ts` — `planSavedQueryMutation`
    constructs and validates a complete candidate workspace for every
    saved-query mutation (delete or replace), rejecting an invalidating one
    unless the caller supplies an atomic repair (remove affected tiles/filters,
    switch to another variant, or remap references), then commits mutation +
    repair as one candidate.
  A new `check:arch` rule keeps `dashboard/application` off the Dashboard UI.
  Live Workbench wiring consumes these commands through the shared workspace
  mutation path.

- **Dashboard read-only viewer runtime + normative `flow@1` layout** (#286,
  phase 4 of #280). New pure/application modules, gated at the per-file
  thresholds, all constructible and unit-tested with plain fakes — no Workbench,
  no full `App`, no `AppState`, no editors:
  - `dashboard/application/dashboard-viewer-session.ts` — the standalone
    **`DashboardViewerSession`**: it takes an immutable `DashboardDocumentV1`
    snapshot plus the workspace queries and runs the Dashboard end-to-end,
    reading membership from **`dashboard.tiles[]`** (not `spec.favorite`) and
    resolving every tile through the ONE shared `presentation-resolver`
    (`resolveDashboardPresentations`/`resolvePresentation` — no copy). It owns
    only runtime state — filter values/activation, per-tile results/errors/
    progress, the resolved flow layout — published through one `state` signal a
    renderer subscribes to; `start`/`refresh`/`refreshTile`/`setFilter`/
    `cancelTile`/`destroy` plus `clearFilter`/`clearAllFilters`, with bounded
    concurrency, per-tile `AbortController` cancellation, stale-wave generation
    guards, and `destroy()` teardown. It depends only on narrow injected seams
    (a query executor, a token-preflight connection, an optional layout
    registry) declared locally, so it imports nothing from `src/application`,
    `src/net`, `src/state.ts`, `src/ui`, or `src/editor`.
  - **#235 resolved inside the execution planner**: panels whose declared params
    cannot be affected by any filter **source** query run in PARALLEL with the
    filter wave; panels a source-backed filter targets wait for the wave and see
    the correct blanked/active values on the first pass. The overlap is computed
    from the explicit `DashboardFilterDefinitionV1.parameter`/`targets` contract.
  - **Filter usability semantics** (absorbing #188's kept scope): per-filter
    clear that deactivates without discarding the last value (reactivation
    restores it, one affected-panel wave), a coalesced clear-all resetting every
    filter to its `defaultActive`/`defaultValue` in ONE wave, and an
    `activeFilterCount` counting active filter DEFINITIONS. (The per-filter
    "required/invalid" blocking badge was dropped as noise by owner decision —
    an unfilled required filter just leaves its target tiles unfilled.)
  - `dashboard/layouts/flow-layout.ts` **extended** with the normative `flow@1`
    render math (pure, 100%): `presetColumns`, `effectiveSpan`
    (`min(storedSpan ?? 1, activeColumnCount)` — preset changes never rewrite
    stored spans), `resolvePlacement` (defaults span 1 / medium), and
    `computeFlowLayout` — deterministic row-major packing (no overlaps),
    maximal-consecutive-KPI-run band grouping preserving #240, mobile
    one-column normalization that never mutates persistence, and the order
    equivalence `dashboard.tiles[] = DOM = keyboard = visual row-major =
    print/export`.
  - `dashboard/layouts/layout-registry.ts` — a compile-time-registered,
    lazy-loadable **layout registry** (`DashboardLayoutRegistration` {id,
    versions, load}), never arbitrary remote plugins, with the fallback
    contract: a primary engine that cannot load falls back to a valid `flow@1`
    fallback, and an unsupported primary without one fails closed.
  - Accessible authoring (`moveTileEarlier`/`moveTileLater`/`setTileSpan`/
    `setTileHeight`) is driven by the phase-3 `move-tile`/`update-placement`
    commands; pointer drag (#153's reorder half) is an equivalent alternative,
    never the only mechanism.
  - A strengthened `check:arch` rule (plus a unit `dashboard-boundaries` test)
    proves the Dashboard model/application layers — including the viewer session
    — import no Workbench UI, `App`, `AppState`, editor, `src/application`, or
    `src/net` module.
  - **Live read-flip.** `src/ui/dashboard.ts` is rewritten to render from a
    `DashboardViewerSession` bound to the persisted `StoredWorkspaceV1`
    (`app.loadDashboardWorkspace()` → the phase-2 `WorkspaceRepository`, running
    the one-shot legacy migration when no aggregate exists), reading membership
    from **`dashboard.tiles[]`** — no longer `savedQueries.filter(queryFavorite)`.
    The DOM reconciles from the session's `state` signal: `flow@1` rows/columns,
    KPI bands (via `renderKpiCards`, preserving #240), per-tile
    loading/unfilled/error/ready with chart-paint-once, mobile one-column
    normalization at the 768px breakpoint, and the empty state. A migrated
    Dashboard's implicit `{name:Type}` params are surfaced as runtime-only filter
    definitions so the filter bar is not lost. The `spec.favorite` dual-WRITE
    stays until GA (the Workbench star action); only the READ is flipped.
  - **Rich filter bar.** The Dashboard filter bar is the SHARED `buildFilterBar`
    — the same rich field family the Workbench var-strip and detached view use
    (relative-time presets, recents, enum + curated comboboxes) — driven over
    the viewer's filter model: a draft value/active bag the bar mutates,
    `session.getFilterField` for live #170 validation, and `session.applyFilter`
    on commit (which owns activation). Recents flow through the shim from the
    real app; the viewer never imports global `AppState` (check-boundaries keeps
    the phase-4 forbidden list intact). Toolbar affordances stay: a coalesced
    clear-all (one wave) and an "N active" count. (The per-filter blocking badge
    was dropped as noise by owner decision.)
  - **Tile reordering is pointer DRAG ONLY** (owner override, final #286 scope).
    A drop persists the new `dashboard.tiles[]` order through the `move-tile`
    command. Note: #280's accessibility section says drag should not be the only
    reorder mechanism — this is a deliberate product-owner override; the per-tile
    keyboard Move controls were removed. The in-tile span/height buttons were
    also removed (span/height are tuned in the Spec editor); the underlying
    `update-placement`/`setTileSpan`/`setTileHeight` authoring commands stay in
    the application layer. The per-filter "×" clear affordance was removed too.
  This closes **#235** (filter wave / panel parallelism) and the reorder half of
  **#153** (open-in-window arrives in Phase 6), and dissolves **#188** into the
  viewer's filter contract.
  - **Fix (post-review):** the `.dash-grid` container kept its old-model
    `grid-template-columns`, so it laid the new flow `.dash-row` wrappers out in
    columns — full-width showed multiple rows side by side and 3-column showed
    the rows multiplied across the page. The container is now a vertical flex
    stack; each `.dash-row` owns its own column count. (Invisible to the unit
    suite because happy-dom does not compute CSS layout; verified in real
    Chromium.)

### Changed
- **The app.ts → services refactor is complete** (#276, Phase 5). The
  temporary `App` delegates from Phases 2–4 are deleted — consumers read
  `app.conn`/`app.catalog`/`app.params`/`app.queryDoc`/`app.prefs` directly
  through narrow interfaces (`app.saveVarRecent` survives as the one
  documented exception); the workbench DOM + effects moved into
  `ui/workbench/workbench-shell.ts` behind a narrow deps bag, making
  `renderApp` a thin composition call; the dashboard shell is typed against
  a narrow `DashboardApp`; the per-tab ClickHouse `session_id` helpers got
  their final home (`application/ch-session-params.ts`, one shared
  implementation); the boundary guard now also forbids either shell from
  importing `src/ui/app.ts`. **Behavior fix**: signing out now tears the
  session down — an in-flight run is aborted and server-`KILL`ed, exports
  and lineage fetches cancel, and the schema/reference caches invalidate
  before the login screen renders (previously stale work could land after
  sign-out and caches survived account switches).
  `docs/ARCHITECTURE.md` rewritten to describe the actual modular-monolith
  shape (it still documented the pre-refactor god object as the design).
- **Phase 4 of the app.ts → services refactor complete** (#276): five more
  focused modules under `src/application/`, all constructible without
  `App`/`AppState`/DOM, behavior byte-identical. `WorkbenchParameterSession`
  (`app.params`) owns the `{name:Type}` prepare/gate/hardening/recents
  policy (the var strip stays a DOM view calling it); `ExportService`
  (`app.exports`) owns direct + script export behind an injectable
  `ExportSink`, consolidating the last duplicated cancellation-state copies
  (its 40 test scenarios moved to an in-memory-sink spec);
  `QueryDocumentSession` (`app.queryDoc`) owns the Spec evaluation/document
  lifecycle and `SavedQueryService` (`app.saved`) the create/commit/history/
  share persistence (typed results; the shell keeps the exact messages and
  post-commit repaint cascade); `SchemaGraphSession` (`app.graph`) owns the
  lineage operation lifecycle with its stale-request guards, the abort state
  now session-private; `AppPreferences` (`app.prefs`) is the typed
  preference-persistence surface (`save` + `toggleTheme` — deliberately no
  speculative per-key setters). `app.ts` is down to 1,761 lines of shell
  wiring from the original 2,964.
- **Server metadata and reference lifecycle extracted into
  `SchemaCatalogService`** (#276 Phase 4A). Version probe, schema tree
  loading, lazy column loading, SQL reference/completions assembly, and the
  entity-documentation cache now live in
  `src/application/schema-catalog-service.ts` (`app.catalog`), constructible
  without `App`/`AppState`/DOM; the connection status chip and auth banner
  stay UI, driven by the same signals. `app.refData`/`app.completions` remain
  writable through forwarding accessors (the CM6 harness mutates them
  directly), and the service gains `invalidate()` for the Phase-5 connection
  lifecycle wiring. Behavior byte-identical.
- **Dashboard tile/filter runtime extracted into a route-scoped
  `DashboardSession`** (#276 Phase 3b). Wave generations, per-slot
  cancellation, the 6-way tile pool, filter waves/merging, and the retry
  cascade now live in `src/ui/dashboard/dashboard-session.ts` — constructible
  without the `App` object, fed an explicit `DashboardRuntimeInput` (built by
  the shell from the favorites list, so a stored dashboard document can
  replace that source later), with every DOM write behind injected shell
  hooks. `renderDashboard(app)` keeps its signature as the integration entry
  (the existing DOM-driven dashboard suite passed unmodified). `destroy()`
  aborts all in-flight tile/KPI/filter work, tears down chart instances,
  disposes the filter bar, and turns later entry points into no-ops — closing
  the orphaned-debounce-timer gap (`buildFilterBar` now returns
  `{ el, dispose }`; both the dashboard and the detached Data view dispose the
  previous bar on re-render). A stale-generation guard on streamed progress
  keeps a superseded request's last buffered chunk from touching the newer
  wave's live label. Tile supersede remains client-abort only (no server
  `KILL`) by design. Behavior byte-identical.
- **Workbench run lifecycle extracted into a route-scoped `WorkbenchSession`**
  (#276 Phase 3a). `run`/`runScript`/`runEntry`/`cancel` orchestration now
  lives in `src/ui/workbench/workbench-session.ts`; the run bookkeeping
  fields (`runT0`/`runQueryId`/`runTick`) and the in-flight `AbortController`
  are private session state (the `RunState` cast and `AppState.abortController`
  are gone — issue rule 5: cancellation belongs to its owner). The session is
  the sole production writer of the `running` signal; the three run-coupled
  reactive effects register through `session.attachShell(...)` with captured
  disposers (idempotent on re-render — also fixes a latent double-registration
  on the connect → re-render path), and `destroy()` releases effects, the
  elapsed ticker, and any in-flight operation (unit-proven; no production
  caller until Phase 5's route shells). The architecture guard now carries a
  rule list: route sessions (`ui/workbench` ↔ `ui/dashboard`) must not import
  each other, and the dashboard route must not import the editor. Behavior
  byte-identical.
- **Authentication and connection lifecycle extracted into `ConnectionSession`**
  (#276 Phase 2). OAuth PKCE login/refresh, Basic-auth probing, IdP config
  resolution, identity, sign-in/out, and the cross-tab dashboard auth handoff
  now live in `src/application/connection-session.ts` — constructible without
  `App`/`AppState`/DOM, with rendering inverted through an injected
  `onAuthLost` shell callback (the session never renders or toasts). The app
  exposes it as `app.conn`; `app.chCtx` remains the same single live ClickHouse
  context object (now session-owned). The scalar auth fields
  (`token`/`refreshToken`/`authMode`/`chAuth`/`basicUserClaim`/`idpId`) left
  the `App` contract; view/bootstrap-consumed members stay as one-line
  delegates slated for removal in the issue's Phase 5. Behavior, storage keys,
  handoff message pinning, and error strings are byte-identical.
- **Query execution extracted into an application service** (#276 Phases 0–1,
  the first step of the app.ts → services refactor). The shared
  request/stream/normalize core (`runReadInto`) and the multiquery-script
  transport loop (per-statement retry/classification, stop-on-first-failure,
  per-attempt `query_id` publication for Cancel's `KILL QUERY`) now live in
  `src/application/query-execution-service.ts` — constructible without
  `App`/`AppState`/DOM, with every side effect (ch-client, clock, uid, timer)
  injected. `app.runReadInto` is deleted; the workbench `run()`/`runScript()`,
  dashboard tiles, and the detached Data view all execute through
  `app.exec.executeRead`/`executeScript`, and `cancel()` uses the stateless
  `app.exec.kill(queryId)`. Behavior, wire format, retry rules, and error
  messages are byte-identical. A new architecture guard
  (`build/check-boundaries.mjs`, wired into `pretest` as `check:arch`) enforces
  the day-1 boundary rule: `src/application/**` must not import `src/ui/**` or
  `src/editor/**`. Type homes tightened along the way: `ResultSort` moved to
  `core/sort.ts` and `ScriptEntry` to `core/script-result.ts` (old import paths
  re-exported), and the `filterExecution`/`panelExecution` params bags are now
  the strict wire shape (`Record<string, string | number>`), deleting the
  narrowing casts at every execution call site.

### Added
- **Bundle-size report on every PR** (#275). `npm run size-report` builds the
  production artifact once (through the same `buildArtifact` the release uses, so
  the measured bytes are byte-for-byte the shipped `dist/sql.html`) and emits a
  machine-readable `bundle-size-report.json`, a human-readable
  `bundle-size-report.md`, and the raw `esbuild-meta.json`. It records raw/gzip/
  Brotli sizes for the artifact, JS bundle, and minified CSS; attributes JS output
  bytes to input modules and npm packages (hand-written `src/**`, generated
  `src/generated/**`, and each external package reported separately); lists the
  top-30 modules and entry-point/chunk totals; and, given a base report
  (`--base`), appends absolute + percentage deltas. A new CI `size` job produces
  the report on every PR — with best-effort deltas vs. the PR base — and uploads
  it as an artifact. Reporting only: no bundle-size budget fails the build yet
  (thresholds are a follow-up once baseline variance is known). Pure attribution/
  formatting lives in `build/size-report-lib.mjs`, unit-tested in
  `tests/unit/size-report.test.js`.
- **Helm chart.** A chart at `helm/altinity-sql-browser/` deploys the nginx image
  to Kubernetes (Deployment + ClusterIP Service + config ConfigMap + optional
  Ingress/HPA), non-root, config via `.Values.config` → `/sql/config.json`, CSP
  origins via `.Values.connectSrc`. `release.yml` packages and pushes it to
  `oci://ghcr.io/altinity/altinity-sql-browser/helm` on `v*` tags (altinity-mcp
  parity). For Altinity edge-proxy environments, `service.annotations` expose a
  host with no ingress/cert/DNS work (`deploy/helm/values-demo.yaml` targets
  `sql.demo.altinity.cloud`).
- **Production container + GHCR image.** The Docker image is now a static
  **nginx** server for the single-file SPA (replacing the containerized Python
  runner): it serves `/sql`, `/sql/dashboard`, a mounted `config.json` at
  `/sql/config.json`, and `/healthz`, runs non-root on port 8080, and carries the
  same security headers/CSP as the on-cluster deployment (`CONNECT_SRC` env fills
  the CSP `connect-src`). A new `.github/workflows/docker.yml` publishes a
  multi-arch (`amd64`+`arm64`) image to `ghcr.io/altinity/altinity-sql-browser`
  — `edge` on `main`, `X.Y.Z`+`latest` on release tags — so the image ships as
  part of every release. `deploy/config.json.example` now carries a runnable demo
  (antalya + github.demo, each in `demo:demo` and Google-SSO modes) and is baked
  in as the default served config. `deploy/k8s/` and `docker-compose.yaml`
  updated to the nginx model (config via ConfigMap/mount, `securityContext`,
  `/healthz` + `/sql/config.json` probes).

### Changed
- **ADR-0002 TypeScript migration complete** (#267). Every hand-written module
  under `src/` (106 runtime modules + 6 type-only seam files) and every unit
  test is strict TypeScript, converted
  leaf-up in dependency-tier waves with zero behavior change — the tail
  covered `chart-data`, `ch-client`, the CM6 adapters, `explain-graph`,
  `results` (which now owns the canonical `Result` union), `app.ts` (declared
  against the `App` contract, with `app.types.ts` reconciled to reality:
  `SchemaFocus.kind`, `specCompletionSources: DynamicSources`, corrected
  `loadIdps`/`openNodeDetail` signatures), and `main.ts`.
  `tests/helpers/fake-app.ts` satisfies the full `App` contract, deleting
  ~1,080 lines of per-test stub scaffolding across eight specs. Still `.js`
  by design: the two generated artifacts under `src/generated/`, the
  Playwright e2e specs (outside the `tsc` gate), and two node-tooling unit
  specs pending an `@types/node` decision — the vitest mixed-tree resolver
  shim survives only for those two. The build and artifact are unchanged;
  runtime deps stay four. The conversion surfaced and fixed two real dropped
  `return`s (`exportEntry`, `renderDashboard` promises) and a latent
  never-exercised completion-ranking branch.
- **Chart style internals consolidated (post-#258 review).** The per-chart-type
  style surface (which fields each type owns, their accepted values, and their
  defaults) now lives in one `CHART_STYLE_SPEC` table that both
  `normalizeChartStyle` and `chartStylePreset` read, replacing the parallel
  field lists that could drift. Chart rendering resolves visible-measure field
  metadata once per repaint (threaded from `chart-render` through
  `chartJsConfig` into `buildChartData`) instead of three times. No user-facing
  behavior or schema change.

### Fixed
- **Chart aggregation sums the whole fetched result, and the note is honest**
  (#111, follow-up to #109). `buildChartData()` no longer slices the raw rows
  before grouping — it discovers unique X categories across *all* fetched rows
  (first-seen order), retains the first `chartRowCap(type)` of them, and
  aggregates every fetched row whose X falls in a retained category. A row past
  the old raw-row boundary now still contributes to its category, and a category
  is no longer dropped merely because its first row arrived late. The result
  carries typed `meta` (`totalRows`/`totalCategories`/`shownCategories`/
  `categoriesTruncated`/`duplicateCellsSummed`/`groupKey`); a new pure
  `chartDataNote(meta)` renders `first N of M categories` and/or
  `duplicate X[/series] rows summed in the browser` — describing only the
  browser-side transform, never whether the SQL pre-aggregated. Duplicate
  detection keys on X (or `(X, series)`), so a normal multi-series result with
  repeated X values is not reported as summing, and a duplicate confined to an
  omitted category never flags the visible chart. The note now renders on every
  surface — Dashboard and read-only/detached tiles (`controls:false`) disclose
  category truncation and duplicate summing as a standalone block above the
  canvas, instead of silently capping. Chart data is aggregated once per render
  (`chartJsConfig` accepts the precomputed result).
- **Share-link result view is validated before use** (#266). The share-link
  bootstrap (`src/main.ts`) now narrows `spec.view` against the `resultView`
  enum before assigning it — the v2 tagged decode passes `spec.view` through
  verbatim, so a crafted link could previously set `resultView` to an arbitrary
  string. Legacy `view: "chart"` still maps to `panel` and a Filter-role
  preview still wins; any other value silently falls back to the default view,
  matching the Library-activation path (`ui/saved-history.ts`).

### Added
- **ADR-0002 phases 1–5: the TypeScript migration slice lands whole** (#262,
  same PR as phase 0). Phase 1: `build/emit-schema-types.mjs`, a hand-rolled
  deterministic emitter (no `json-schema-to-typescript` — see the ADR-0002
  addendum), generates `src/generated/json-schema.types.ts`
  (`QuerySpecV1`/`SavedQueryV2`/`LibraryV2` + a usable `PanelCfg` discriminated
  union with a `FuturePanelCfg` forward-compat member) from the canonical
  schema manifest, staleness-checked by `check:schemas`;
  `src/schema-contract.types.ts` pins the semantic invariants at
  `check:types` time. Phases 2–5 convert 19 modules to strict `.ts` — the
  state model (`src/state.ts`, typed signals, honest localStorage ingress),
  the saved-query/panel/dashboard contract spine, the parameter/filter/
  execution pipeline, and the dashboard runtime (typed slot lifecycle,
  tile/KPI hook contracts) — zero behavior change, still-`.js` imports typed
  via local wrapper consts, per-file coverage held. Their unit tests convert
  to `.ts` as a second wave (assertions unchanged); vitest gains a mixed-tree
  resolver shim (Vite only retries `.js`→`.ts` from TS importers). The build
  and artifact are unchanged; runtime deps stay four.
- **ADR-0002 phase 0: TypeScript gate** (#262). `tsconfig.json` (strict,
  `allowJs`, `checkJs: false`, `noEmit`, `erasableSyntaxOnly`); `typescript`
  devDependency; `tsc --noEmit` joins `pretest` (and therefore CI) alongside
  `check:schemas`. Five type-only `.types.ts` seam-interface files, each
  co-located next to the runtime module it describes: `EditorPort`,
  `SpecEditorPort`, `CodeViewerHandle`, `CreateAppEnv`/`BootstrapEnv`, and the
  `App` controller surface as consumed by render modules. No existing `.js`
  module converted; the build and artifact are unchanged. Vitest coverage
  `include` widens to `src/**/*.{js,ts}`, excluding the type-only files
  (no executable statements) alongside `src/generated/`.
- **ADR-0002 accepted: incremental strict TypeScript, dev-time only**
  (`docs/ADR-0002-static-typing.md`; phase 0 tracked by #262). `tsc --noEmit`
  joins the gate; files convert leaf-up one at a time; esbuild and the
  artifact are untouched, runtime deps stay four. In the same review,
  ADR-0001 gained an addendum re-affirming **no UI framework** at the
  dashboard milestone and replacing its re-evaluation trigger with three
  concrete conditions (plugin ecosystem, virtualized large lists, rising
  invalidation-bug rate).
- **Bar, Column, Area, and Pie now share type-specific presentation presets**
  (#258) through the same compact Style selector. Bar/Column add Grouped,
  Stacked, Compact, Joined, Minimal, and Data range; Area adds additive
  Stacked to its Line-family variants; Pie adds Donut and a genuinely compact
  frame. Presets update one type-specific `panel.cfg.style` object, match that
  object before claiming a named state, preserve dormant
  fields and unknown extensions across type switches, and render identically
  in the workbench and Dashboard. The canonical Spec schema and completion now
  document the complete type-specific style branches.
- **Line and Area Style now offers seven complete presentation presets**
  (#256). Clean, Smooth, Stepped, Points, Zero-based, Minimal, and Sparkline
  write the full renderer-independent `panel.cfg.style` object through the
  existing compact selector; exact advanced combinations that match none of
  them remain visible as a disabled Custom selection. Scale, legend, grid, and
  axes settings join curve and point controls in the canonical Spec schema and
  completion surface, preserve unknown extensions, and render consistently in
  the workbench, detached views, and Dashboard. Sparkline removes axes, grid,
  legend, and normal markers while retaining hover targets, tooltips, data,
  colors, and responsive sizing.
- **Chart panels now apply saved `panel.fieldConfig` metadata consistently**
  (#254). Exact result-column overrides merge over defaults to drive legend
  display names, per-measure tooltip units/decimals and descriptions, and
  shared-axis formatting when visible measures are
  compatible. Hidden measures are omitted without rewriting their saved Y
  selection, with an explicit all-hidden state; missing and invalid measure
  values now remain `null` geometry instead of becoming zero. The same shared
  renderer supplies workbench, detached, and Dashboard charts, while the
  compact chart toolbar remains unchanged and advanced formatting stays in the
  Spec editor.
  `noValue` metadata remains preserved, but interactive missing-point text is
  deferred to #257 because Chart.js excludes null/skipped points from normal
  tooltip selection; configuring only `noValue` does not alter valid values'
  existing localized tooltip formatting.
- **Line and Area panels now have compact style presets for dense time series**
  (#252). Clean, Smooth, Stepped, and Points controls map to explicit Chart.js
  curve and point settings, with automatic point visibility based on the final
  rendered label and dataset counts. Style metadata persists across panel type
  switches, shares, OAuth handoff, and Library import/export, while unsupported
  future string values remain lossless and render with safe defaults.

## [0.5.0] - 2026-07-15

### Removed
- **The dormant `html{zoom}` bridge and every runtime/test path that
  compensated for it are torn out** (#148). PR #147 had already set
  `--zoom: 1` (native page scale), leaving the whole zoom-correction layer a
  no-op; this removes it outright: `html { zoom: var(--zoom) }`, the
  `--zoom`/`--vp-zoom` custom properties, and the `@supports not (zoom: 1)`
  fallback are gone from `src/styles.css`, along with the viewport-unit
  `calc(.../var(--vp-zoom))` sizing on the fullscreen graph overlay and
  detached-tab panels (now plain `100%`/native full-height layout).
  `src/core/zoom-support.js` (`viewportZoom`) and `app.measureViewportZoom`/
  `app.applyViewportZoom`/`app.vpZoom` are deleted, as is the detached-view's
  `--vp-zoom` mirroring onto a child tab. `zoomScale()` is deleted from
  `src/ui/dom.js`; `fixedAnchor(rect, opts)` drops its `scale` argument (all
  File/Save/user-menu/combobox/footer callers updated to native coordinates).
  Splitter (`dragValue`/`startDrag`), result-grid column resize
  (`colResizeWidth`), schema-detail pane resize, and the cell-detail drawer
  all drop their scale argument/callback and operate on native `clientX`/
  `clientY` directly. Chart.js's `unzoomChartEvent`/`installChartZoomFix`
  pointer-event correction is removed; the chart instantiates directly
  (its cross-realm detached-document resize fix is unrelated and stays).
  The synthetic `tests/e2e/zoom.html`/`zoom-support.spec.js` harness and
  `tests/unit/zoom-support.test.js` are deleted in favor of behavior-level
  coverage on the normal app surfaces. No behavior change intended — the app
  used `--zoom: 1` already; this only removes the now-dead compensation code.

### Added
- **The Dashboard now has a compact mobile presentation at the canonical
  768px breakpoint** (#248). Its sticky header stays on one line with an
  icon-only back link and Refresh action, an ellipsized Library title, and the
  theme action; secondary favorite/source/update metadata and the desktop
  layout selector are hidden. Every saved desktop layout is visually
  overridden to one normal-height full-width column without changing its
  persisted preference. Dashboard filters stay in one horizontally scrollable
  row with fixed-position combobox popovers, while a Dashboard with no filters
  omits the now-empty mobile toolbar entirely. Widening the viewport restores
  the saved desktop layout and full controls automatically.
- **Favorited saved queries can now act as Dashboard Filter sources** (#160).
  One explicit read-only query returns exactly one row containing any number of
  `Array(T)`, `Array(Tuple(value T, label L))`, or `Map(K,V)` helpers. Exact
  result-column names upgrade matching Dashboard parameters to strict,
  searchable single-select controls; invalid sources and provider conflicts
  fall back per field without delaying or removing unrelated panels. Filter
  requests run and reconcile persisted activation before Panel requests start,
  with bounded concurrency, cancellation generations, Refresh, and source Retry.
  The workbench result selector is role-aware, preserves dormant Panel config,
  and provides a completed-run-only Filter preview without changing shared
  Dashboard values.
- `examples/query-log-explorer.json` — a worked Dashboard Filter sources demo
  against `system.query_log` on any cluster: one Filter source per option
  shape (`Array(Tuple(value, label))`, `Map(String, String)`, plain
  `Array(T)`), plain auto-detected fields alongside them, a KPI panel, four
  analytical Panels adapted from the Altinity KB's ["Handy queries for
  system.query_log"](https://kb.altinity.com/altinity-kb-useful-queries/query_log/),
  a Logs panel, and a Text panel explaining the demo.

### Fixed
- **Opening a Filter-role saved or shared query now always starts in the
  Filter preview** (#244, folds in #249). Library-row activation previously
  restored whichever result view (Table/JSON/Panel) was already open,
  independent of the query's Dashboard role; a Filter-role query with SQL
  that can't auto-run (empty/DDL, reachable via an import or legacy
  localStorage entry that bypassed SQL-shape validation) fell through to no
  view change at all. Separately, the share-link/OAuth-handoff bootstrap path
  only ever restored `resultView` for a *queryless* Panel link — any
  SQL-bearing shared Filter query, or a SQL-bearing shared Panel query with a
  persisted `spec.view`, always landed on the default Table view. Both call
  sites now resolve the same `rolePreviewView(spec) || queryView(query)`
  precedence (`src/core/result-choice.js`): a role-owned transient preview
  wins over a persisted view, which wins over the queryless-Panel/default
  fallback. The preview stays transient — no `spec.view: "filter"` is ever
  persisted — and ordinary reruns after the query is open continue to
  preserve the user's current Table/JSON/Filter selection.
- Review follow-ups on the Dashboard Filter sources work above, found in a
  UI/UX pass on #232 before merge: a curated field's clear (×) button now
  reports the cleared value (not the stale prior selection) to
  `varValues`/`filterActive`, and gets an `aria-label` naming the field it
  clears instead of an anonymous "×" (this is what the e2e suite was actually
  catching — same bug, both assertions). The clear button is icon-based and
  positioned inside the field like every other clear affordance, instead of
  falling into normal flow below the input. The Dashboard's role/Filter
  diagnostic banners (`.dash-config-diagnostic`, e.g. "Filter helper … has no
  current Panel consumer") and the workbench Filter preview's type/diagnostic
  text now have real styling — both referenced undefined CSS variables and
  rendered as unstyled body text. The tab-strip/Library "Filter" role badge no
  longer reads as a second open tab (it shared the bordered `.qtab` row with no
  styling of its own). `Enum8`/`Enum16` and `LowCardinality(...)` columns are
  now recognized as valid Filter/KPI scalar types (the type parser rejected
  Enum's quoted member list and never unwrapped `LowCardinality`). A Filter or
  KPI query's Table/JSON view no longer shows `[object Object]` for named-tuple
  columns serialized as objects. A curated field now gets the same
  is-invalid/conflict affordance a plain filter field does. A real pointer
  click on the clear button double-committed (mousedown blurred the input
  before the click handler ran); fixed with the same commit-before-blur
  `preventDefault` pattern `combobox.js` already uses for option commits. A
  curated field never got the `is-optional` CSS class, so it always showed
  the required-field asterisk even when its param was genuinely optional.
- A second pre-merge cleanup pass on #232 removing invented primitives and
  duplication, and fixing bugs found alongside them:
  - The curated Filter field (Dashboard filter bar **and** the bottom-drawer
    Filter preview) is rewritten to reuse the shared `var-combo` combobox
    primitive (`combobox.js`'s `createCombobox`/`wireComboInput`, the same
    `.var-combo`/`.var-input`/`.var-combo-list` clothes the enum/recent/
    relative-time fields wear). It previously hand-rolled its own listbox with
    CSS classes that did not exist, so the dropdown rendered as an unstyled
    inline bulleted list that pushed the clear (×) button out of place.
  - The `{severity, code, message, …}` diagnostic factory duplicated across
    three Filter modules is now one shared `core/diagnostics.js` helper (#236).
  - Filter sources reuse the tile wave's generation/abort guard
    (`supersedeSlot`/`slot.gen`) instead of a parallel re-implementation (#237).
  - Curated Filter fields are seeded from a persisted last-known bundle
    (`asb:filterCurated`) so they paint as the searchable dropdown immediately
    instead of flashing a plain text input for one frame on each load (#234).
  - The result-presentation picker no longer breaks for a `table`-typed panel:
    it mapped to a `panel:table` value that matched no option, leaving the
    select blank with no way back to Table — a table panel now resolves to the
    `(auto)` entry (Table's surface remains the adjacent Table view).
  - Typing SQL now re-evaluates the whole Spec validator graph only for
    Filter-role tabs (whose diagnostics depend on the SQL), not on every
    keystroke of every tab.
  - The result-presentation `<select>` now switches the drawer to a preview
    **consistently**: it shows a `Preview…` placeholder while on Table/JSON, so
    picking *any* entry (a chart, Logs, KPI, Text, or the Filter role) — even the
    query's current one — is a real `change` that switches to that preview.
    Previously it reflected the current type/role, so re-picking it fired no
    event and the view never switched.
  - The Filter drawer preview is now a **result-grid** consistent with the
    Table/JSON views — columns `name · options · type · example`, with the
    interactive per-helper combobox in the `example` cell (no clear ×).
- `examples/query-log-explorer.json` reworked: the `hours` lookback is replaced
  by a real DateTime range — `from` (required) and `to` (optional) on
  `event_time` — applied to every `system.query_log` panel; `namePattern` is
  replaced by a universal optional `search` over the query text (and the
  exception message in the log panel); the three per-shape Filter favorites are
  consolidated into a **single** `Filter` source returning `user` + `query_kind`,
  and the exception-code Filter and "Errors over time" panel are removed.

### Changed
- **Explicit, favorited KPI queries now render as full-width Dashboard KPI
  bands instead of nested inside a generic gray tile** (#240). A KPI band
  spans every Dashboard column regardless of the selected Full width/Report/
  2-column/3-column layout; consecutive explicit `panel.cfg.type==='kpi'`
  favorites merge into one flat, wrapping card stream (favorite order, then
  result-column order), with no per-favorite name, description, or
  rows/time/bytes footer. Loading, missing-parameter, and error states render
  as compact in-stream state cards (naming the source query); one source's
  failure never hides its band siblings; warnings render below the band,
  each naming its query. Cards use controlled, content-driven widths
  (160–320px desktop, full row under 520px). An auto-detected (unconfigured)
  one-row KPI result is unaffected — it remains an ordinary tile, following
  the selected layout, exactly as before. `src/ui/kpi-panel.js` gained a
  lower-level `renderKpiCards()` primitive (the individual card nodes,
  decoupled from the workbench's `.kpi-panel/.kpi-grid` wrapper) that both the
  workbench preview and the new `src/ui/dashboard-kpi-band.js` module share;
  `core/dashboard.js` gained the pure `partitionKpiBands()` grouping. No
  schema change, no new runtime dependency.
- **`src/core/clickhouse-type.js` is now the sole ClickHouse type-expression
  parser** (#238), replacing `param-type.js`'s independent regex parser; the
  latter is now a thin compatibility projection deriving everything from the
  shared AST. The parser gained numeric/string literal argument nodes
  (`Decimal(P,S)`, `FixedString(N)`, `DateTime('tz')`, `DateTime64(P,'tz')`),
  full `Enum8`/`Enum16` member parsing (explicit/implicit codes, escaped and
  `$tag$…$tag$` heredoc names — the tokenizer itself is now heredoc-aware, so
  a heredoc body may contain `(`, `)`, `,`, or a stray quote character without
  corrupting the surrounding parse), and distinct `unwrapNullable`/
  `unwrapLowCardinality`/`unwrapValueTransparentWrappers`/`analyzeTypeModifiers`
  helpers — `Nullable(...)` and `LowCardinality(...)` are no longer conflated.
  **`LowCardinality(T)` is now transparent for declared-parameter value
  handling**: validation, serialization, relative-time resolution, and Enum
  membership all use exactly `T`'s rules, recursively (including inside
  `Array(LowCardinality(T))`) — previously `LowCardinality(...)`-wrapped
  parameters fell through to permissive, unvalidated passthrough. Declaration-
  *identity* comparison (conflict detection) moved from a whitespace-deleting
  string compare to a canonical formatter that is whitespace-insensitive
  outside quoted/heredoc content but wrapper-sensitive — `LowCardinality(String)`
  is a different declaration from `String`, never treated as the same
  conflict-free type. `LowCardinality(Array(...))`/`Nullable(LowCardinality(...))`
  are syntactically permissive but never treated as an ordinary supported
  scalar by the Dashboard Filter helper reader; **`LowCardinality` wrapping an
  `Enum8`/`Enum16` (any nesting order) is now rejected everywhere** — no
  ClickHouse version accepts it (live-verified: `ILLEGAL_TYPE_OF_ARGUMENT`), so
  it degrades to opaque passthrough for parameters and is never a supported
  Filter/KPI scalar, instead of offering Enum dropdown/membership behavior for
  a declaration that can never bind on a real server. KPI and Filter helper
  behavior is otherwise unchanged, now backed by the shared parser. No new
  runtime dependency.
- **Quote-delimited token scanning is now one shared primitive** (#241):
  `src/core/quoted-span.js`'s `scanDelimited()` is the single authoritative
  backslash/doubled-delimiter rule for `'…'`, `` `…` ``, and `"…"` spans,
  consumed by both `sql-spans.js` (unchanged behavior) and
  `clickhouse-type.js`'s tokenizer, which previously used a one-character
  backslash lookback that misclassified an EVEN-length backslash run before a
  closing quote as escaping it (`Enum8('label\\' = 1)` — a member name ending
  in one literal backslash — could drop the member, degrade the whole type to
  opaque/pass-through, or in one case throw). Also fixed: quoted Tuple member
  names (backtick/double-quote identifiers) now correctly decode a *doubled*
  delimiter (`` `a``b` `` / `"a""b"` → `` a`b ``/`a"b`), not just backslash
  escapes.
- **Saved-query Library JSON now uses the version 2 canonical model** (#211):
  every entry is `{id, sql, specVersion, spec}`, with the complete Spec carried
  unchanged through local storage, tabs, panel edits, sharing, import/export,
  and merge. Version 1 files and share links are upgraded on read; exports,
  official examples, and generated Libraries now emit only version 2. Unknown
  Spec and panel fields are preserved for forward compatibility.
- **Builds now use a committed `package-lock.json` and `npm ci`** (#157), making
  local, pull-request, and tagged-release artifacts resolve the same complete
  dependency graph instead of silently picking up newly published transitive
  versions. The lockfile includes esbuild's platform binaries as optional
  packages, so Linux CI and macOS development each install the correct binary
  without sacrificing reproducibility.

### Fixed
- **Draggable pane splitters now use one quiet, consistent visual treatment**
  (#227): sidebar, editor/results, schema/Library, schema-detail, and cell-detail
  handles keep a generous fixed hit area around a centered 1px theme-border
  line, then show the same 3px accent indicator on hover and throughout a drag
  without moving adjacent panes. The former permanently thick horizontal bars
  and horizontal-only center grip are removed.
- **Schema search cascades through the database/table/column hierarchy instead
  of flat-filtering table and column names independently** (#208). A database
  name match now shows that database and every one of its tables; a table
  match shows its parent database, the matching table, and all its currently
  loaded columns; a column match shows only the matching columns plus their
  table/database context. Ancestors required by a match render as visually
  open even when persistently collapsed, and a database with no matching
  descendant is hidden entirely (previously every database always rendered,
  even empty ones) — a non-empty filter with no matches at all now renders one
  "No matching databases, tables, or columns." message instead of empty rows.
  Search-driven reveals are a pure presentation-time projection: they never
  write `state.expanded`, so clearing the filter restores the exact prior
  expand/collapse state, and typing never triggers column-loading requests — a
  directly-matching table whose columns aren't cached yet shows none until
  expanded. Fixes a related cosmetic bug found in review: a click on a row
  shown open only via the search cascade (not persisted expansion) no longer
  flashes its chevron shut and back open (`src/ui/schema.js`).

### Added
- **KPI panels now render one-row scalar and named-tuple results** (#154) in
  both the workbench and Dashboard through one shared reader and renderer.
  The canonical Presentation Spec supports exact-name field metadata, nested
  delta display semantics, units, rounding, colors, NULL text, and visibility;
  explicit KPI queries own typed progress streaming and reject authored
  trailing `FORMAT` clauses before sending a request.
- **The saved-query Spec editor now provides complete schema-driven native
  CodeMirror autocomplete** (#221). Root/nested properties, discriminated panel
  branches, constants, enums, booleans, nullable values, defaults, examples,
  object/array skeletons, and schema-owned snippets all come from the canonical
  `query.spec` schema rather than editor-owned lists. Annotated positions add
  cached last-successful result column names/indexes and dynamic field-configuration
  keys without executing SQL. Typing opens the same popup used by the SQL
  editor; `Ctrl-Space`, arrows, Enter, Tab, and Escape retain native CodeMirror
  behavior and the information pane shows schema documentation. Completion
  works against incomplete JSON through a non-persisted tolerant Lezer model,
  while the bottom Spec strip is now reserved for blocking errors only—warnings,
  informational diagnostics, valid-state messages, and missing dynamic data do
  not appear there or disable Save.
- **Complete canonical Library JSON contracts and a versioned codec** (#224)
  now cover the closed Library v2 and saved-query v2 envelopes as well as the
  independently versioned, extensible query Spec. One pure parse/validate/
  migrate/decode/encode boundary drives Open, Replace, Append, Save JSON,
  examples, and historical local-storage ingress; unsupported future versions,
  duplicate IDs, malformed timestamps, and corrupt storage fail atomically with
  exact path diagnostics. New exports include a `$schema` hint and valid
  `exportedAt`; older v2 files without the timestamp remain readable under a
  documented compatibility policy. A manifest-driven strict Ajv build emits
  self-contained named validators, a schema catalog, and a single offline
  Library bundle while excluding `/drafts/` schemas and keeping Ajv plus
  `ajv-formats` out of the production runtime.
- **A canonical Draft 2020-12 schema and pure validation/introspection service
  now define `query.spec`** (#220). All implemented panel branches carry
  schema-owned documentation, snippets, status, and result-column completion
  annotations; known fields are validated while unknown extensions and future
  panel types remain storable. Ajv compiles the schema at build time from a dev
  dependency into deterministic self-contained ESM, with stale generated files
  failing tests and builds. Stable exact-path diagnostics now drive Spec editor
  validation, synchronous atomic Save, import/Replace/Append, external Spec
  writers, and static runtime panel checks, while the existing app-owned
  feature-validator registry remains the layer for result/context rules.
  Checked-in examples, generator output, templates, and authoring-guide JSON
  are schema-validated in tests.
- **The workbench now has independent SQL and saved-query Spec JSON editor
  modes** (#212). A visible `SQL | Spec` switch keeps separate per-tab drafts,
  undo/search state, dirty flags, and injected CodeMirror adapters. Spec mode
  adds local JSON formatting, folding, search, parse markers with line/column,
  and synchronously registered semantic validators keyed by exact path arrays;
  known static structure is now owned by the canonical schema added in #220,
  while unknown extension fields remain valid. Linked Save atomically commits SQL plus the current valid Spec in one
  Library write, with normalized Name/Description and all other fields/order
  retained; invalid Spec persists nothing. Spec is a lightweight editing mode:
  its toolbar contains only Format, Save, and the SQL | Spec switch, while Run,
  Explain, SQL Format, Export, Share, and Share’s global shortcut are SQL-only.
  Validation remains continuous through diagnostics and status. Library pencil,
  favorite, and Panel writers merge their changes into every valid open draft,
  preserving unrelated unsaved and extension fields; invalid JSON or a blocking
  schema/feature diagnostic stops the staged writer before mutation, and invalid
  JSON focuses the affected Spec tab. Reopening an
  already-open saved query activates its existing tab. No package or lockfile
  change was needed because JSON language support landed in #213.
- **A shared, injected read-only CodeMirror source viewer** (#213) now provides
  complete-text rendering, line numbers, local search, selection/copy, and
  compartment-based wrapping for text, JSON, SQL, XML/HTML source, and plain
  Markdown source. It mounts in either the app document or a detached document
  realm and has explicit idempotent teardown. The editable SQL editor and the
  viewer share only presentation/search extensions and the existing `.sql-*`
  token classes; editor history, completion, hover, schema loading, drag/drop,
  tab parking, and state synchronization remain isolated behind `EditorPort`.
  `@codemirror/lang-json` and `@codemirror/lang-xml` are the only added packages;
  the measured self-contained artifact grows by 18,063 bytes raw / 7,059 bytes
  gzip.
- **Iceberg Catalog Explorer example library**
  ([docs/ICEBERG-CATALOG-EXPLORER-DEMO.md](docs/ICEBERG-CATALOG-EXPLORER-DEMO.md)).
  Content-only (no code changes): `examples/iceberg-install.json` carries
  generator entries that emit, from ordinary `{param}` filter inputs, the DDL
  for per-catalog `ice_meta_<catalog>` Iceberg-metadata navigation views
  (DEFINER-locked, bucket-scoped S3 grant), a cross-catalog `ice_meta_all`
  union layer discovered live from `system.databases`, a chmem memory-store
  seed, and a per-catalog drill-down mini-library — all emitted through
  `FORMAT TSVRaw` so the raw result cell copy-pastes byte-exact into a new
  tab. `examples/iceberg-catalog-dashboard.json` (BI) and
  `examples/iceberg-dba-dashboard.json` (DBA, with snapshot-commit and
  metadata-version **logs panels**) dashboard the views with one shared
  optional `catalog` filter on every tile. Built from
  `examples/iceberg-templates/` by `examples/mjs/build-iceberg-install.mjs` /
  `examples/mjs/build-iceberg-dashboards.mjs`.

## [0.4.0] - 2026-07-13

### Added
- **The detached Data view is now interactive: Panel switcher + query filters**
  (#185). The Data pane's **Expand** used to open a frozen snapshot; it now
  opens a self-contained, re-runnable full-screen surface (real browser tab, or
  the in-app overlay fallback) bound to the result's captured `source`
  (`{sql, tabId, rowLimit, title, description}`, attached by `run()` on a normal
  row-returning result). The detached header shows that captured query title (a
  real heading; it also sets the browser-tab title) with the saved description
  clamped below it; a `{name:Type}` source gets a **filter row** built from the
  same shared control the SQL Browser and dashboards use (extracted to
  `src/ui/filter-bar.js`), and its Table | JSON | Panel switcher, sort, and
  column widths are local. Committing a filter or clicking **Refresh** re-runs
  **only** the detached query with full workbench parity — streaming, the
  server-side row cap, and real request abort — through one shared execution
  seam (`app.runReadInto`) that writes no tab/global state; a per-view
  generation guard + AbortController mean a stale or post-close response can
  never overwrite the current result. Filters read/write the same shared
  `varValues`/`filterActive`/`varRecent` stores (a value entered anywhere is
  offered everywhere; successful runs record recents via the shared recorder),
  the originating tab's ClickHouse session is reused when the source needed one,
  and the main workbench result/view/sort/panel/history and global running state
  are untouched. Copy always copies the current detached result. The
  Table/JSON/Panel dispatch is now one shared `renderResultView` used by both
  the live pane and the detached view (no parallel copies). No new runtime
  dependency. (Dashboard tiles moved onto the same shared streaming seam in
  #193 — see Changed below.)
- **Schema column name and type are now independent drag targets** (#186).
  Dragging a column's name still inserts the SQL-safe quoted identifier;
  dragging its type meta now inserts the complete schema-provided ClickHouse
  type — including every Enum member — never the compacted display text
  (e.g. dragging `Enum16(33 values)` inserts the full `Enum16('Close' = -11,
  …)` declaration). A new `COLUMN_TYPE_MIME` drag payload
  (`src/ui/dnd-mime.js`) keeps this separate from the existing identifier
  drag; the CodeMirror drop handler consumes it with identifier precedence
  preserved. Icon/whitespace and type-less columns carry no type-drag
  payload; database/table row dragging is unchanged.
- **Dashboard: one four-way layout switcher with a new Full-width mode**
  (#184). The dashboard's two separate layout controls (Arrange|Report plus a
  right-aligned Columns 2|3) collapse into a single segmented control —
  `Full width | Report | 2 columns | 3 columns` — so every effective layout is
  one click away. **Full width** is a new experimental mode: one tile per row
  filling the entire available dashboard width (inside the existing page
  gutters) for horizontally expansive Grafana-style panels, keeping the normal
  Arrange tile height rather than Report's taller document look. State is
  unchanged — `dashLayout` gains a `wide` value alongside `arrange`/`report`
  (no preference migration; existing selections stay valid) and `dashCols`
  keeps its 2/3 meaning. The control carries a `Dashboard layout` group label
  and per-button tooltips, exposes exactly one `aria-pressed` button, and
  layout changes stay presentation-only (no tile re-query).
  The saved-query visualization config is promoted from "a chart, plus special
  cases" to a first-class panel union — `panel.cfg.type ∈ bar | hbar | line |
  area | pie | table | logs | text` — designed in the results pane's new
  **Panel** tab (a Type picker + per-type config) and rendered identically as
  dashboard tiles by one registry (`src/ui/panels.js`), so drawer preview ≡
  tile by construction. Previews never execute SQL: they render from the tab's
  last explicit Run (the text panel needs no result at all — its Markdown
  lives in `panel.cfg.content`, rendered by an in-house safe subset parsed to
  an AST and built as DOM, raw HTML inert, http(s) links only, no new runtime
  dependency). The `logs` panel names its `{time, msg, level}` columns (with
  convention-based auto-detection covering `system.text_log` and OTel tables);
  `table` is the explicit plain-grid choice; text panels save with empty SQL,
  export their content to Markdown, and are skipped by the `.sql` script
  export. The **dashboard now partitions favorites before execution** — a
  text favorite renders immediately with zero queries — and nothing multi-row
  is skipped anymore: unconfigured results go log-shape → chartable → table
  (the log-shape signal outranks autoChart), explicit panels never vanish
  (zero-row explicit panels show an honest "0 rows" state), and grid tiles
  keep sort/column-width state across refreshes while the schema is unchanged.
  Tile fetches now carry best-effort server caps (`max_result_rows` sentinel +
  `max_result_bytes`, overflow `break`) with a guaranteed 5,000-row client
  trim and an honest "first 5,000 rows fetched" footer note (#164).
- **Library format: the `panel` field** (#166). `library.json` gains an
  optional `panel: {cfg, key?}` with `version` staying 1 (additive; older
  builds drop the unknown field). One pure `upgradeSavedEntry()` runs at
  every ingress — localStorage startup, JSON import, Replace/Append/merge,
  tab restore, share-link decode (including the OAuth round-trip stash) — so
  a user upgrading in place sees no visual change; `view:'table'` entries
  with a latent chart migrate losslessly (the chart roles ride in a nested
  stash and prefill a switch back to a chart type). **Rollback safety:**
  saves, exports and share links dual-write a legacy `chart` mirror for
  chart-family panels for one release (derived via one seam, so mirror and
  panel cannot drift; removing it next minor requires the upgrader to strip
  `chart` when `panel` exists). Unknown panel types and unknown cfg fields
  are preserved, never silently stripped.

### Changed
- **Data-skipping indexes moved off schema graph cards into the detail drawer**
  (#179). Expanded schema-graph cards no longer render the inline `idx: …` line:
  because a card's width is the widest rendered text line, long index names/types
  used to inflate the card and distort graph spacing (a heavily-indexed table
  spread far wider than the same columns with no indexes). Card geometry
  (width/height/layout/spacing) is now completely independent of index count,
  name, and type. The full index metadata instead appears in a new
  **Data-skipping indexes (N)** section of the bottom detail drawer, after
  Columns: every index (never a capped subset), with Name, Expression, full Type
  (`type_full` preferred so `bloom_filter(0.01)` / `tokenbf_v1(…)` stay
  distinguishable, falling back to `type`), Granularity, and compressed size —
  long Name/Expression/Type cells ellipsize with the full value on hover, and the
  section is omitted when a table has no skipping indexes. The rows are fetched
  once per detail-open (one read added to `loadTableDetail`'s existing parallel
  batch); the now-dead skip-index read `loadSchemaCards` issued on every graph
  load is gone. No new runtime dependency. (Follow-up to the #177 compact-type
  work.)
- **Dashboard tiles now stream through the shared `app.runReadInto` seam** (#193,
  follow-up to #185). Every query-backed tile runs on the same execution path as
  the workbench `run()` and the detached Data view instead of the bespoke
  `queryDashboardTile` (`FORMAT JSON`, whole-response `parseJsonResult`) it used
  before — gaining streaming transport, bounded client memory, live progress, and
  **real per-tile cancellation** via an `AbortController`. The read-only guard is
  preserved (`readonly:2` + `max_result_bytes` ride in the request; the row cap is
  the `newResult('Table', DASH_TILE_ROW_CAP)` client trim against a server
  `max_result_rows = CAP + 1` sentinel, so exactly-cap results are not flagged and
  `>CAP` are trimmed and flagged). Each wave reserves its slot generation **at
  creation** (aborting any in-flight request then) so a queued Refresh worker a
  newer filter wave has superseded discards itself without issuing — closing a
  stale-wave race; targeted filter re-runs now take one token preflight and the
  same 6-way concurrency pool as full Refresh. While a tile streams, only its
  loading placeholder's row count updates — panel classification and rendering
  happen once, on completion, so charts are never rebuilt mid-stream. Two small,
  deliberate behavior changes: a Dashboard panel query with an **explicit `FORMAT`
  clause** is now rejected with a clear tile error (the streaming parser only
  understands the structured stream, so a stray `FORMAT` would silently corrupt
  the tile), and the tile footer always shows ms (wall-clock) and bytes (streamed
  progress). The now-unused `app.runTile` / `queryDashboardTile` /
  `dashboardTileSql` / `parseJsonResult` machinery is deleted so future cap or
  settings fixes can't apply to only one path. No new runtime dependency; no change
  to the workbench or detached view.
- **One authoritative ClickHouse lexical scanner + structural lexer replaces the
  legacy highlighter tokenizer** (#182, supersedes #141). All string-based SQL
  analysis — statement splitting, parameter detection, optional-block/format
  handling, type display, completion, FROM/JOIN scope, and parameter-comparison
  inference — now runs on the shared `core/sql-spans.js` scanner (`{kind, start,
  end, closed}` spans, authoritative) and the new offset-bearing `core/sql-lex.js`
  structural lexer. The old `[type, text]` tokenizer in `core/sql-highlight.js`
  (and the private comment/quote skippers duplicated across `format.js`,
  `type-display.js`, and `optional-blocks.js`) are removed; its fallback keyword/
  function sets move to `core/sql-reference.js`. CodeMirror 6 keeps sole ownership
  of editor parsing/highlighting and gains the `hashComments` / `slashComments` /
  `doubleDollarQuotedStrings` dialect flags. Lexical fixes that follow from the
  unified scanner: `//` comments, restricted `#` (comment only before space/`!`),
  nested block comments, `$tag$` heredoc opacity (incl. heredoc Enum members),
  quoted-identifier escapes, and correct trailing-`FORMAT` / DDL schema-refresh
  classification after every supported comment form. No runtime dependency added.
- **A panel-config edit now dirties the tab like a SQL edit, and an untouched
  auto-derived config is no longer frozen into the entry on Save** (#166).
  Previously the Chart tab silently persisted whatever autoChart last derived;
  now `panel` persists only when restored or explicitly configured, and the
  preview renders a clone (render never mutates tab state). The detached Data
  Pane's third view is now a read-only render of the source tab's panel
  (previously an editable chart with its own config bar).
- **Grid renderer extracted into its own module with shared state wiring**
  (#167). The sortable/resizable data grid (`renderGrid`), the column-resize
  primitives (`colResizeWidth`, `resizeHandle`, `reapplyWidths`), and a new
  `renderGridView` adapter now live in `src/ui/grid-render.js`. The adapter
  centralizes the sort-update → repaint choreography that the main results
  table, the script-result rows viewer, and the detached Data pane each
  hand-rolled — the caller still owns where sort/width state lives and what a
  repaint means, so every surface keeps its exact state lifetime and repaint
  scope. Behavior-preserving; prepares the module boundary the Panels track
  (#166) builds on (a `table` panel becomes the fourth consumer without
  another copy of the wiring). A grid consumer may now omit `onCell` (cell
  clicks are inert instead of a TypeError).

### Fixed
- **Schema tree table actions open generated SQL in a new query tab instead of
  overwriting the active editor** (#180). Double-clicking a table used to
  `replaceEditor()` the current document with `SELECT * FROM … LIMIT 100`, and
  Shift-click replaced it with the formatted `SHOW CREATE` DDL — both could
  destroy an unrelated query the user was mid-edit on. Both actions now go
  through the existing `loadIntoNewTab()` path instead, naming the new tab with
  the unquoted `db.table` display name while the SQL itself still uses the
  SQL-safe `qualifyIdent()` result. Fetching/formatting the DDL is now shared
  between the editor-replacing `insertCreate()` (unchanged, still used by
  database rows) and the new tab-opening `openCreateInNewTab()` via a common
  `fetchCreateSql()` helper (`src/ui/app.js`, `src/ui/schema.js`). Database,
  column, drag, and expand/collapse behavior is unchanged.
- **The Logs rescue path deep-clones the saved panel configuration before
  handing it to controls** (#200). The rescue branch (#192/#195) fed Logs
  controls `{ ...saved.cfg }`, a shallow spread — any nested unknown field
  (the panel-config contract preserves fields it doesn't own, for forward
  compatibility) stayed aliased to the live `tab.panelCfg` until the explicit
  `onChange` write-back. `renderPanelView` now uses the canonical
  `clonePanelCfg` helper, matching the non-rescue path's already-deep-cloned
  `resolvePanel` output (`src/ui/panels.js`). No behavior change for the
  current string-valued Logs fields; this closes the gap for a future
  object-valued or extension field.
- **The detached Data view keeps its committed result visible during streaming
  reruns** (#198). Changing a filter or clicking **Refresh** used to repaint the
  in-flight result on every network chunk, which (a) flashed `Query returned 0
  rows.` whenever a chunk carried column metadata before any data rows, and (b)
  destroyed and recreated the Panel's Chart.js instance on every chunk. The
  detached view now follows the same commit-on-success policy as dashboard
  tiles: streaming updates a lightweight `Running… <n> rows read` status only,
  the previously committed Table/JSON/Panel (and its chart) stays on screen
  untouched, and the new result is committed and repainted exactly once after a
  successful current-generation completion. Failure, cancellation, supersession,
  and close all keep the previous committed result — and because the in-flight
  result is never painted, the old failure-time restore repaint is gone. Winning
  bound parameters are still recorded once; the committed toolbar row count no
  longer changes mid-stream (`src/ui/results.js`). Dashboard and workbench
  streaming behavior are unchanged.
- **The detached view's Logs (Panel) surface now scrolls** (#185 follow-up).
  A readonly panel renders straight into the block-level `.res-body` with no
  `.panel-body` flex wrapper, so the `flex:1; min-height:0` that bounds
  `.dash-logs` in the docked pane never applied — the logs list grew to its
  full content height and `.res-body`'s `overflow:hidden` clipped it with no
  way to scroll. `.res-body > .dash-logs` (and the `.panel-with-note` wrapper)
  now take `height:100%` like the adjacent `.chart-view`, so the list is
  bounded to the pane and its own `overflow:auto` scrolls (`src/styles.css`).
- **The workbench Panel tab keeps Logs authoring controls available when a
  saved Logs panel falls back** (#192). A saved `{type:'logs'}` panel whose
  Time/Message roles no longer resolve against the current result used to
  fall back to the ordinary fallback diagnostic and preview (usually Table)
  with no way to repair it — reselecting Logs from the picker is a same-type
  no-op, so the saved configuration was stuck. `renderPanelView` now derives
  controls from the saved Logs config whenever the fallback is a saved Logs
  panel (`src/ui/panels.js`), while the preview keeps rendering the existing
  `resolvePanel()` fallback + diagnostic unchanged; selecting explicit
  Time/Message/Level roles repairs the panel in place (marks the tab dirty,
  runs no SQL) and the next repaint renders Logs normally. Dashboard,
  detached, and other read-only surfaces are unaffected — the rescue is
  scoped to the editable workbench tab and strictly to a saved Logs type.
- **The Logs rescue's fallback preview is now read-only, so it can no longer
  silently overwrite the saved config** (#195). #192's rescue kept a saved
  Logs panel's Time/Message/Level controls available while it fell back to a
  Table *or* chart preview, but that fallback preview still rendered with its
  own normal, writable workbench controls — a fallback chart's X/Y/Series bar
  competed with the Logs controls above it, and editing the chart axes would
  replace the saved `{type:'logs'}` config with a derived chart config even
  though the chart was only ever a temporary stand-in. The rescue predicate
  (`hasGrid && saved?.cfg?.type === 'logs' && resolved.fallback`) is now
  computed once in `panelContext()` and shared by both the toolbar Panel
  picker (which now shows **Logs** as the active type throughout rescue,
  never the resolved fallback type) and `renderPanelView`, which renders the
  fallback preview with `readonly: true` (suppressing the chart arm's config
  bar entirely) and no `onCfgChange` callback. Repairing Time/Message/Level
  still writes the saved Logs config as before; choosing another type from
  the Panel picker remains the only way to explicitly convert away from Logs.
- **Logs role selectors now name a stale saved column instead of silently
  showing `(auto)`** (#196). When a saved Logs role (`time`/`msg`/`level`)
  pointed at a column name no longer present in the current result, its
  `<select>` had no matching `<option>`, so the browser fell back to
  displaying `(auto)` — visually indistinguishable from a role that was never
  explicitly configured, so editing a different role could silently persist
  the stale name unnoticed. `logsRoleSelect` (`src/ui/panels.js`) now derives
  a `logsRoleState` per role: a non-empty saved name that doesn't match any
  current column (case-insensitively, mirroring `resolveLogsShape`'s
  matching policy) renders as a selected, disabled `"<name> (missing)"`
  option with `aria-invalid`/`title` on the still-enabled `<select>`, so the
  user can pick a current column or `(auto)` to repair it, or leave it stored
  for later. Applies to all three roles (Level is optional, so a stale Level
  can be marked missing even while Logs renders normally). Rendering never
  mutates or canonicalizes `tab.panelCfg`. (Also fixed in passing: setting a
  detached `<option>`'s `.selected` before `appendChild` is not reliably
  honored under happy-dom — `panelSelect` now sets `sel.value` once after
  every option is attached.)
- **Unbounded column types no longer crush width-constrained UI** (#177). A
  declared type with an arbitrarily long body — a giant `Enum16(…)`, a
  many-field `Tuple(…)`, `Nested`/`Variant`/`AggregateFunction`/`JSON(…)` —
  used to consume the schema-tree row (reducing the column name to zero
  width) or was blindly character-cut in graph cards
  (`Enum16('Close' = -11, 'Err…`). A shared pure formatter
  (`core/type-display.js` `compactType`) now collapses unbounded declaration
  bodies to semantic summaries (`Enum16(41 values)`, `Tuple(12 fields)`,
  `Array(Tuple(12 fields))` — outer wrappers preserved; quote-aware,
  balanced-bracket, effectively linear scan; malformed input degrades to
  plain truncation) across the schema tree, the schema-detail table, column
  completion detail, and the schema graph cards. The full declared type
  stays reachable everywhere: row/cell hover titles, a per-column SVG
  `<title>` on graph cards, and the CM6 completion info pane (via a new
  `fullType` on column completion items). Long `CODEC(…)` chains in the
  detail table are capped the same way, and `.tree-row .meta` gained a CSS
  max-width backstop so no future raw value can reproduce the layout
  failure.

### Added
- **Optional SQL blocks `/*[ … ]*/` with explicit filter activation** (#165).
  A comment-wrapped predicate — `WHERE 1 /*[ AND d = {d:String} ]*/` — is
  included only while every parameter inside it is active; a blank filter now
  means "no filter" instead of blocking the run. The raw template is
  SQL-transparent (each block is a plain comment to any tool that doesn't know
  the convention, so it runs anywhere with all filters inactive), and values
  still bind only through native `{name:Type}` parameters — never
  interpolated. Wired through the #173 pipeline's two materializations: the
  all-active *analysis view* feeds the variables strip, the dashboard filter
  bar and affected-tile detection (block-only params get an "optional"
  affordance and never gate Run/tiles), and the *execution view* is what runs
  and exports — parameters of omitted blocks are never sent as `param_` args.
  Activation is explicit state (`state.filterActive`, persisted alongside
  `varValues`, blank ⇒ inactive for text controls, not carried in share
  links). Non-row-returning statements are never materialized; nested,
  unbalanced, parameterless, `;`-containing, whole-statement, or
  `*/`-containing blocks produce clear errors; and the Format action skips a
  statement containing blocks (with a notice) rather than round-tripping a
  template through server-side `formatQuery()`.
- **Typed client-side validation for `{name:Type}` variable inputs** (#170).
  A value is now checked against its declared type *before* the query is
  sent, for the numeric/scalar families that are cheap to validate purely:
  `Int8…Int256`/`UInt8…UInt256` (range-checked via `BigInt`; wraps like
  `256` for `UInt8` are blocked client-side even though ClickHouse's param
  path would silently accept and wrap them), `Float32`/`Float64` (decimal /
  scientific notation, `inf`/`nan`), `Bool` (a narrow, never-`invalid`
  accept-set — its live accept grammar isn't fully enumerable), and `UUID`
  (hyphenated or 32-hex compact). `String`/`Array`/`Map`/`Decimal`/`Enum`/
  `Date*` and any unrecognized type are always passed through unvalidated
  (`Enum` membership is #172; `Date`/`DateTime` relative expressions are
  #169). New pure `src/core/param-validate.js` (100% covered) plugs into
  #173's pipeline as its validation stage. A value is `invalid` only when
  ClickHouse's actual param-value grammar (verified live — not the SQL
  literal grammar) certainly rejects it; a plausible mid-typing prefix
  (`-`, `1e`, a half UUID) reads as neutral `incomplete` while the field is
  focused and hardens to the inline error on blur/Enter/execute. The
  workbench var-strip and the Dashboard's global filter bar (#149 D3) share
  one small affordance (`src/ui/var-field.js`) for the invalid-field styling
  + reason tooltip; an invalid value gates exactly like an unfilled one (Run
  disabled workbench-side, the tile placeholder dashboard-side). Also fixes
  two dormant gaps the validation stage exposed: the Run button's disabled
  state now reflects `invalid`/source errors, not just `missing` (previously
  only visually out of sync with the actual gate), and a field whose value
  fails serialization no longer rolls up as `ok` in `prepareParameterizedBatch`'s
  per-field state.
- **Relative time expressions for date/time variables** (#169). A
  `Date`/`Date32`/`DateTime`/`DateTime64(N)` (any `Nullable(…)`-wrapped)
  variable now accepts Grafana-grammar relative expressions — `-1h`,
  `now-7d`, `now/d` — alongside absolute values: the stored value is the
  expression, so it re-resolves against "now" on every workbench Run,
  Dashboard load/Refresh, or filter-change wave instead of freezing a
  timestamp the moment it's typed. New pure `src/core/relative-time.js`
  (100% covered) — `resolveRelativeValue`/`isDateLikeType`/
  `resolveVarValues` — parses the grammar (case-sensitive units; `s`/`m`/`h`
  offsets are fixed durations, `d`/`w`/`M`/`y` offsets and all `/u` rounding
  are local-timezone calendar arithmetic with DST-safe "same wall-clock time"
  semantics and month-end clamping) and formats per declared type (local
  calendar date / integer epoch seconds / epoch seconds with an `N`-digit
  fraction — live-verified against ClickHouse 26.3.13's `param_*` path). A
  near-miss expression (starts `now…` or sign+digits but fails to parse)
  gates via #170's existing invalid-field machinery, following its exact
  incomplete→invalid timing: neutral and non-blocking while still being
  typed (`now-`, `-1`, ordinary keystrokes toward a valid expression), and
  hardened to the visible inline error only on blur/Enter/execute — no
  second affordance, no separate timing model (review fix, post-merge).
  Plugs into #173's pipeline as the real `resolveRelativeValue` stage
  (previously identity). The UI is the first consumer of a new accessible
  type-to-filter combobox primitive (`src/ui/combobox.js`, #174 §1 — full
  keyboard map, ARIA `combobox`/`listbox`/`option` roles, IME-composition
  safety, mousedown-before-blur commit, `aria-describedby` wired to the
  preview/error element) composed in `src/ui/relative-time-field.js` with a
  live preview of the resolved instant as a human-readable UTC ("server
  time") calendar string (`2026-07-11 13:23:45`) — never the wire value
  actually sent (which stays epoch seconds/date per the declared type), and
  never converted to the viewer's local zone, so the same instant reads
  identically for every viewer; both the workbench var-strip and the
  Dashboard's global filter bar (#149 D3) upgrade their date-like fields to
  it, unchanged for every other type.
  Resolved instants are FLOORED to the whole second for every date/time type
  (never rounded), so `DateTime` and `DateTime64(0)` agree on the same
  instant and a resolved `now` never lands a second in the future.
- **Shared parameter pipeline (Phase 7.0)** (#173). A pure, two-phase,
  multi-source parameter pipeline — `analyzeParameterizedSources` (per-field
  declarations across all occurrences, per-source requiredness, cross-source
  type-conflict diagnostics) and `prepareParameterizedBatch` (per-source
  `{statements, missing, invalid, errors, runnable}` verdicts, immutable
  `boundParams` snapshots, per-param field states) — that
  #165/#169/#170/#171/#172/#160/#175 plug into (#165/#169/#170 via their own
  stage seams, real from their entries above; #171 below reads the
  `boundParams` output directly rather than overriding a stage; #172/#160/
  #175 still identity/unknown until they land). Includes a typed serializer: `Array(T)` values bind as ClickHouse
  array literals with correct quote/backslash escaping, big integers
  (`UInt64`/`UInt128`/`UInt256`, `Int128`/`Int256`) stay strings end-to-end
  (never through a JS `Number`), and scalar-string values remain
  byte-identical to before. Serialization is per-statement by the local
  declaration; a structurally incompatible stored value blocks only its own
  source — on the dashboard, one bad tile never blocks its siblings. Execution
  waves share one separately-injected wall clock (`env.wallNow`), distinct
  from the `performance.now`-based duration clock.
- **Per-variable recent-value history with an MRU dropdown** (#171). Every
  `{name:Type}` field now remembers its **10 most recently used** values,
  offered in a dropdown on focus (type-to-filter, click inserts, Esc/blur
  closes — the field stays free-text). A value is recorded only when a
  statement or dashboard tile **completes successfully**, read straight from
  that statement's #173 `boundParams` snapshot: a failed statement records
  nothing, statement 1 of a later-failing script still records, a param
  confined to an inactive #165 optional block is never recorded, and an
  empty string is never recorded even when actively bound. A relative-time
  value (#169) records the typed *expression* (`-1h`), never the resolved
  instant, so it keeps re-resolving on reuse. New pure
  `src/core/recent-values.js` (100% covered): `recordRecent`/`clearRecent`/
  `clearAllRecent` (MRU insert, exact-string dedupe/move-to-front, a 10-per-
  name cap and a ~100-entry global-LRU total cap across all names), plus
  `visibleRecents`/`filterRecentValues`/`recentOptions` — the render-time
  helper that hides (never deletes) a recent #170's validator marks invalid
  for the field's *current* declared type, so it reappears once viewed
  through a compatible declaration. Storage is `asb:varRecent`
  (versioned + sequence-stamped, name-keyed like `varValues`, shared/
  persisted the same way — plaintext, same exposure). Two new UI seams
  compose the existing accessible combobox primitive (`src/ui/combobox.js`,
  #174 §1) rather than building a second control: `src/ui/recent-field.js`
  (recents-only, for every non-date-like field) and an extension to
  `src/ui/relative-time-field.js` (adds an optional `getRecents` that
  upgrades its dropdown into ONE combined list — presets first, then a
  "Recent" group). A separate `src/ui/combo-footer.js` renders the per-field
  "Clear recent" affordance as its own small `position:fixed` box anchored
  under the listbox (kept out of `combobox.js` itself, whose `listEl` is
  fully owned by its own render pass, and out of the listbox's own
  `role="option"` items, where a destructive action would be an ARIA
  regression). The header **File** menu gains a "Variable history" section:
  a "Remember recent variable values" preference (recording off, existing
  history retained until cleared) and a "Clear all recent values" action —
  the closest thing the app has to a settings surface today. Both the
  workbench variables strip (app.js) and the Dashboard's global filter bar
  (#149 D3, dashboard.js) record on their respective success paths and share
  the same dropdown/footer wiring.
- **Enum variables render as a dropdown of their allowed values** (#172), two
  tiers, zero new network requests. **v1 (declared type, both surfaces):** a
  variable declared `{name:Enum8(…)}`/`Enum16(…)` (`Nullable(…)` unwrapped)
  gets a dropdown listing its member names, parsed straight out of the
  declaration by new pure `enumMembers`/`enumValues` (`src/core/param-type.js`,
  100% covered — reuses the shared string-span scanner so escaped quotes
  (`'a''b'`), braces (`'}'`), spacing variants, negative codes, and unicode
  member names all parse exactly like ClickHouse's own literal grammar, and
  implicit auto-numbered members — `Enum8('hello', 'world')`,
  `Enum8('One' = 1, 'Two', 'Three')` — get their real codes with ClickHouse's
  previous-code+1 rule).
  Membership is enforced (#170's invalid affordance, blocking) via a new
  `param-validate.js` branch: a LIVE-VERIFIED server fact (ClickHouse 26.3.13)
  is that a bare numeric code string (`1`) is ALSO accepted for a declared
  Enum param, binding as the member with that code — so validation accepts
  member names AND matching numeric codes (a strict digit prefix of a declared
  code, like `1` on the way to code `12`, stays neutral while typing, same as
  a member-name prefix), rejecting everything else with a
  reason that lists (and, past 8, samples + counts) the allowed values. Works
  in both the workbench variables strip and the Dashboard filter bar, since
  the declaration travels with the tile SQL. **v2 (schema-cache inference,
  workbench only, suggestions — never blocking):** a plain `{s:String}`
  compared directly to a column (`col = {s}` or `{s} = col`, qualified/aliased
  forms included — an expression, `IN`, `BETWEEN`, or the same param compared
  to two different columns all yield no match) whose *cached* type (#84's
  schema cache) is an Enum offers the identical dropdown, purely as
  suggestions: the declared type stays `String`, so a non-member still
  executes — the cache can lag the server. New pure
  `src/core/param-comparison.js` (`paramComparisonColumns`, 100% covered) finds
  the syntactic column reference; a new `resolveComparisonColumnType` in
  `src/core/from-scope.js` resolves it against the statement's FROM scope and
  the loaded schema (exactly one confident match required — ambiguous or
  not-yet-loaded degrades silently to a plain input, upgrading automatically
  once the column lands on the existing idle-tick loader; a background load
  that completes while the user is focused inside the variables strip DEFERS
  the strip rebuild until that field blurs, so it never steals focus, wipes
  in-progress text, or closes an open dropdown mid-typing). **Third consumer of
  the shared combobox** (`src/ui/combobox.js`, #174 §1) via new
  `src/ui/enum-field.js`: enum values render under a "Values" header once
  recents (#171) are also wired (paired labeling, exactly relative-time-
  field.js's own rule), a large `Enum16` (thousands of members) type-to-filters
  the COMPLETE member list first and only then caps the rendered rows at
  `ENUM_DROPDOWN_CAP` (≈200) with a "type to narrow" hint, so a member past the
  cap stays reachable by typing. `param-scan.js` gained a position-carrying
  `scanParamOccurrences` (the existing `scanParamDeclarations` is now a thin
  wrapper over it) so v2 can locate each param occurrence's FROM scope.

### Fixed
- **Phase 7 whole-branch review fixes** (#173/#165/#169/#170/#171/#172).
  Type-conflicted `{name}` declarations now *surface*: the field carries
  `conflict` through `fieldControls`, degrades to a plain text input on both
  the workbench var-strip and the dashboard filter bar (never a one-sided enum
  or date control), and shows an amber `.is-conflict` warning whose tooltip
  lists the disagreeing declarations. The #172 v2 schema-cache scan runs on the
  analysis materialization, so a `col = {p}` comparison inside a `/*[ … ]*/`
  optional block gets its dropdown too; and comparison-column conflicts are
  decided on *resolved* identity, not raw qualifier text (`e.status` +
  `status` in a single-table query now match; JOIN sides still don't).
  "Clear recent" now also empties the open dropdown list; a recent that
  duplicates a rendered enum member/preset is no longer listed twice; every
  execution path (run / script / both exports) captures its prepared args at
  wave start, so a value edited during a token-refresh await can no longer
  desync from the gate; the array-element serializer now shares the
  validator's live-verified Int/Float token grammar (rejects `007`, accepts
  `inf`/`nan`); and the var strip no longer analyzes the same SQL twice per
  editor keystroke. Manual-testing follow-ups (PR #176): a date-like field's
  combined dropdown now lists **Recent first, then Presets** (a recorded
  expression that duplicates a preset surfaces under Recent, not Presets —
  the enum/plain-recents fields are unchanged, still Values/plain-first);
  the "Clear recent" footer no longer lingers on screen after an option is
  picked via mousedown (`combobox.js` gained a shared `onClose` hook so every
  field module's footer hides on the same close path, not just focus/input/
  keydown/blur); and the README's Enum section now spells out that a bare
  `{o:Enum8}`/`{o:Enum16}` is rejected by ClickHouse (`Enum data type cannot
  be empty`) rather than inferring the dropdown.
- **Multi-statement SQL now binds query parameters per statement everywhere**
  (#155, absorbed by #173). `paramArgs` gated on the leading keyword of the
  whole text, so a favorite like `SET x = 1; SELECT {year:UInt16}` never
  received `param_year`; every gate/exec call site in the workbench and the
  dashboard now consumes the pipeline's per-statement batch instead.
- **Schema panel: a broken table in one data-lake-catalog database no longer
  hides every catalog database's tables** (#162). `loadSchema` queried
  `system.tables` across every database in one shot; once ClickHouse resolves
  per-table metadata for a `DataLakeCatalog` (Iceberg/Glue/…) database, a
  single unresolvable table there either aborts the whole query or (depending
  on `database_datalake_require_metadata_access`) silently drops tables from
  *other*, healthy catalogs too — traced to a ClickHouse-side gap, reported
  upstream as [ClickHouse/ClickHouse#110032](https://github.com/ClickHouse/ClickHouse/issues/110032).
  Each `DataLakeCatalog`-engine database is now queried separately, requesting
  only `database, name` — the one shape ClickHouse can resolve without opening
  each table's storage object, so one broken table can't take down anything
  else. Trade-off: `total_rows`/`total_bytes`/`comment` for catalog tables show
  as zero/empty rather than being fetched.

## [0.3.0] - 2026-07-04

### Added
- **Dashboard (phase 1): open your favorited Library queries as a read-only
  dashboard in a new tab** (#149). A new **File ▾ → "Open as dashboard"** item
  (enabled once at least one query is starred) opens `/sql/dashboard` — the same
  single served artifact, reached by a client-side route — and renders each
  favorited, chartable query as a live chart tile, reusing the existing Chart.js
  result view. The new tab is authenticated by a **one-time, same-origin
  `postMessage` credential handoff** from the opener (both the target origin and
  the peer window are verified); a cold/bookmarked visit falls back to the normal
  login flow, which returns to the dashboard after sign-in. Tile queries run
  **read-only** (`readonly=2`), so a favorite that happens to contain a write is
  rejected server-side rather than executed on open/refresh. Tiles fetch with a
  bounded concurrency (so a large favorites list doesn't stampede the cluster),
  the auth token is resolved once before they fan out (no intra-tab refresh
  race), and a handed-off-but-expired token is refreshed rather than forcing a
  re-login. Single-row (KPI) and non-chartable favorites are skipped for now with
  an "N not shown" note. KPI tiles, global filters, drag-to-arrange layout,
  per-tile controls, and export arrive in later phases (#149 D2–D7). Known
  limitation: two tabs independently refreshing a *rotating* OAuth refresh token
  can race (BroadcastChannel sync deferred).
- **Dashboard (phase 2): Arrange / Report layout switcher** (#149). A toolbar
  below the dashboard header (the future filter bar) adds a primary **Arrange |
  Report** segmented control: **Arrange** is the uniform multi-column grid, and
  **Report** lays the tiles out as a single full-width scrolling column with
  taller charts. A secondary **Columns 2 | 3** control tunes the Arrange grid
  (hidden in Report's single column). Both are presentation-only — switching
  reshapes the grid and the chart tiles resize themselves, with no tile re-query
  — and the choice is persisted per browser (`asb:dashLayout` / `asb:dashCols`),
  surviving reloads and Refresh. Chart tiles were also brought closer to the
  design: the saved query **description** shows as a subtitle under the tile
  name, the chart now draws on the **tile's own background** (instead of the
  darker results-table background), and the value-axis **gridlines are hidden**
  on tiles (they read as noisy light lines on a dark panel). Drag-to-reorder and
  1/2-column tile spans arrive in a later phase (#149 D4).
- **Dashboard (phase 3): global filter bar** (#149, #152). A **filter bar** in
  the dashboard toolbar renders one text field per `{name:Type}` parameter
  detected across every favorited tile's SQL (`dashboardParams`, unique by
  name, first-appearance order) — absent entirely when no favorite has one.
  Fields share the same persisted `state.varValues` the SQL Browser workbench
  already uses (#134): a value typed on the dashboard shows up in the
  workbench's variable strip for the same name, and vice versa. Typing
  debounces (~500 ms idle) before re-running only the tiles that reference the
  changed name — not the whole grid; Enter or blur commits immediately,
  bypassing the debounce. A tile whose SQL still has an empty/absent parameter
  never runs its query — it shows a distinct "Enter a value for: …" placeholder
  (excluded from the "N not shown" count, since one filter value away it
  becomes chartable). Tiles now live in **stable per-favorite slots** built up
  front and updated in place (loading/unfilled/error/chart) rather than
  inserted/removed, so a filter-driven tile flipping states repeatedly never
  reorders the grid or orphans its identity; each slot's fetch carries a
  monotonically increasing generation counter so a superseded in-flight
  response can never overwrite a newer edit's result. `ch-client.js`'s
  `queryJson`/`queryDashboardTile` gained an optional `params` argument
  (backward compatible) to forward `param_<name>` args to ClickHouse®. Per-tile
  Type/X/Y overrides, KPI tiles, and dropdown/cascading filters arrive in later
  phases (#149 D5–D7).
- **Schema-aware, FROM-driven autocompletion** (#84) — column completion now
  fires *while you type*, driven by the statement's `FROM`/`JOIN` clause, so you
  no longer have to expand a table in the sidebar first. A new pure module
  `src/core/from-scope.js` resolves the caret's statement into its base tables
  (`{db, table, alias}[]`, reusing the SQL tokenizer so strings/comments/`;`
  never fool it), and completion uses it three ways: **aliases resolve**
  (`e.` after `FROM events e` offers `events`' columns), **unqualified columns
  are scoped** to the statement's tables (an unrelated loaded table's columns
  are no longer suggested), and **columns load lazily** on a **debounced idle
  tick** (300 ms, never on the keystroke path) — deduped via the existing
  `'loading'` sentinel, cached per connection, and the open dropdown refreshes
  when they arrive. `db.table.`/`table.` qualification still works; with no
  FROM in view completion degrades gracefully to the global pool. Non-goals
  (v1): CTE/subquery-derived scopes, `USING`, `SELECT *` expansion, table
  functions. Builds directly on the CM6 editor (#21).

### Fixed
- **Editor scrollbars are back, and the whole UI's scrollbars behave
  consistently again.** The console no longer renders at 1.2× via `html{zoom}`
  (`--zoom` is now `1` — native size). `zoom:1.2` (= 6/5) landed element box
  sizes on fractional device pixels, and the leftover sub-pixel made scroll
  containers — the CodeMirror editor most visibly — read as "scrollable by
  ~1px" over content that visibly fit, painting a **phantom scrollbar** (the
  same rounding also drove the Safari viewport-unit divergence, #70). #145 had
  hidden the editor's bars outright to dodge it; with zoom removed the editor
  now uses the app's standard themed scrollbars like every other pane — a
  vertical bar for a long query, a horizontal bar for a long line, and nothing
  when the content fits. The UI is ~20% smaller than before; use browser zoom
  (⌘+) to enlarge. The now-dormant zoom-bridging machinery (`--vp-zoom`
  measurement, Chart/menu-anchor/splitter zoom correction) is left in place for
  a separate teardown (roadmap #68).

### Changed
- **The SQL editor is now CodeMirror 6** (#21) — the deliberate 4th bundled
  runtime dependency, replacing the hand-rolled textarea editor wholesale
  behind the #143 `EditorPort` seam (`src/editor/codemirror-adapter.js`;
  `main.js` swaps one injected factory). What changes for users: **per-tab
  undo history** (the shared textarea undo stack couldn't do this), real
  IME/touch editing, CM6's find/replace panel (`⌘F`), and measured-text
  rendering (no more fixed-glyph-width geometry). Highlighting still tracks
  the connected server's `system.keywords`/`functions` — the sets now feed a
  ClickHouse `SQLDialect` swapped via a Compartment on connect — and
  completion keeps the pure `core/completions.js` candidate set + ranking
  (CM6 renders the UI; `filter: false` preserves our order). Global shortcuts
  (`⌘↵` run, `⌘⇧↵` format, `⌘S`/`⌘⇧S`) stay on the document handler — CM6's
  conflicting `Mod-Enter` binding is stripped so an open completion can never
  swallow the run chord. Deleted with the cutover: the textarea adapter,
  `editor-complete/intel/search`, `core/editor-{marks,geometry,brackets,search}`
  and the `maskLiterals`-based literal masking (~2,600 LOC incl. tests) —
  execCommand undo, four-way scroll sync, and the editor's `html{zoom}`
  popover bridging all go with them. Signature help is dropped in this parity
  v0 (#60 rebuilds docs properly); function docs show as the completion info
  tooltip and on hover. Bundle: **+402,911 B raw (+83%) / +132,903 B gzip
  (+85%)** (484,674 → 887,585 raw; 155,810 → 288,713 gzip) — over the issue's
  raw estimate, accepted at the plan gate as the price of the Phase-4 editor
  foundation (#84 schema-aware autocomplete builds directly on this).
- **The SQL editor now sits behind an injected `EditorPort` seam** (#143): the
  hand-rolled textarea editor moved from `src/ui/` to `src/editor/` and is the
  first adapter (`createTextareaEditor`) of a small port interface
  (`src/editor/editor-port.js`) injected through `createApp(env)` like
  Chart/Dagre. The editor's state writes on typing (`tab.sql`/dirty, tab strip,
  Save button, #134 var strip) moved out of the adapter into an app-level
  `onDocChange` subscriber, and drag-and-drop MIME constants live in a neutral
  `src/ui/dnd-mime.js`. No user-visible change; this is the prep step that
  makes the CodeMirror 6 swap (#21) a reversible one-line adapter change.
  Bundle: +966 B raw / +428 B gzip (the port module — no new dependency).

### Added
- **Query variables** (#134): typed ClickHouse placeholders — `{name:Type}` —
  are detected while you edit, and a single-line strip below the editor toolbar
  shows one input per variable (it scrolls horizontally when there are many, and
  is hidden when there are none). **Run is disabled until every variable has a
  value.** On execution the values ride along as ClickHouse's native
  `param_<name>` query-string arguments, so the *server* substitutes them per the
  declared type (injection-safe; `String`/`Identifier`/`DateTime`/`Array`/`Map`
  all work) — the SQL text is sent unchanged. Substitution applies to
  row-returning statements only, so a `CREATE VIEW … {x:String} …` definition is
  stored verbatim (matching ClickHouse parameterized views). Run, ⌘↵, Explain,
  and Export all honor the same gate and pass the same params. Entered values are
  **shared by variable name across every query and persisted** (`asb:varValues`),
  so a value typed once is reused — prefilled automatically — wherever the same
  variable appears, and survives reloads. (Distinct from #39's `{{name}}`
  composable-query CTE-merge — different syntax and purpose.) The literal/comment
  lexing shared with the script splitter now lives in one scanner
  (`src/core/sql-spans.js`, #139), which also makes detection quote-aware inside a
  type — a `}` in `{e:Enum8('}' = 1)}` no longer truncates the placeholder.
- **Best-effort mobile mode** (#126): below a 768px viewport the shell becomes a
  **bottom-tab-nav workbench** — a bottom bar switches between three full-screen
  panels, **Tables / Editor / Results**, instead of squeezing the desktop
  sidebar + split panes onto a phone. Tables has a **Schema | Library** segmented
  toggle; Results carries a live badge (row count, or ● while a query streams).
  The nav follows the natural flow: tapping a schema column jumps to the Editor,
  loading a saved query opens it in the Editor, and running a query jumps to
  Results. Every pointer-only affordance is *removed* rather than left
  half-working on touch — all resize handles, the schema tree's native drag
  sources and hover tooltips, the drag-to-drawer schema-graph drop target, the
  graph-based `Pipeline` EXPLAIN view, and both graph fullscreen `Expand`
  buttons; button-anchored popovers (Save, user menu) center on-screen; the
  editor/results toolbars swipe-scroll; and the header declutters so the File /
  theme / user-menu controls fit. The core SQL loop stays fully usable: tap to
  browse the schema (a db-row tap still draws its lineage graph, via #124),
  write, run, read results, chart, and the four text/table EXPLAIN views. A
  single breakpoint (`MOBILE_BREAKPOINT_PX`, mirrored by the CSS `@media`) drives
  an injected `matchMedia` `isMobile` signal plus `mobileView` / `mobileTab`.
- **Click a closed database row to draw its schema graph** (#124): expanding a
  collapsed db in the tree now also draws its lineage in the bottom drawer, the
  same as dragging it — collapsing again doesn't re-fetch or re-draw.
  Drag-to-drawer is unchanged. On a schema with 50+ view/MV objects needing
  `EXPLAIN AST`, the inline graph now draws **progressively**: the free edges
  (dependencies/target/engine-arg/dictionary — no extra round trip) paint
  immediately, then a single second layout merges in the view/MV source edges
  once `EXPLAIN AST` settles, with a "resolving N/M…" toolbar readout. Below
  that threshold the fetch is fast enough that a visible first paint would just
  be flicker, so it still draws in one step. The loading placeholder / toolbar
  now has a working **Cancel**: it aborts the in-flight fetch and either keeps
  the already-drawn free-edges graph (marked partial) or falls back to the
  empty-results placeholder, whichever has something to show.

### Changed
- The build now minifies `src/styles.css` with esbuild's CSS transform (same
  minifier already used for the JS bundle) instead of inlining it raw — the
  stylesheet was shipping every source comment and all its indentation
  verbatim. Cuts the served artifact by ~23 KB (~4.7%), no new dependency
  (esbuild already provides the CSS minifier). Investigated gzip too: every
  demo cluster already serves the SPA gzip-compressed (ClickHouse's HTTP
  server compresses any static-handler response when the client sends
  `Accept-Encoding: gzip`, independent of any config in this repo) — verified
  ~54% smaller on the wire already, nothing to change there.

### Fixed
- **`npm test` flaked on Node 25** (#130): one `app.test.js` case asserted a
  persisted preference by reading the ambient `globalThis.localStorage` directly,
  which Node 25's native Web Storage (broken without `--localstorage-file`)
  leaves without a `getItem` method — a `TypeError` on a clean local run, though
  CI (Node 22) was unaffected. The test now stubs an in-memory store the way the
  `storage`/`state` specs already do, insulating the assertion from the host
  runtime; an `.nvmrc` pins local dev to Node 22 to match CI.
- The inline schema-lineage graph had a stale-write race (same class as #97):
  running or Explaining a query — or dragging/clicking a second db/table —
  while a lineage fetch was still in flight could let the stale fetch's
  resolution land on the tab's *new* result once it finally settled, silently
  showing an old graph instead of the actual query output. A request-identity
  guard now drops any write from a superseded fetch. Separately, an abort
  during the best-effort `system.dictionaries` read inside the lineage fetch is
  now correctly propagated as a cancellation instead of silently degrading to
  "no dictionaries, continue".
- Login screen: removed the footer's GitHub source link and "OAuth ·
  credentials" method tag — noise a first-time visitor had to parse before
  signing in (#123). The screen's other reported complexity (multiple visible
  panels, the server picker) is a deployment config choice, not a code issue.
  Consolidated all login-screen config docs (OAuth setup, multiple IdPs,
  credentials login, the host/Advanced picker, the local-dev saved-connection
  picker) out of the README into a single new
  [docs/LOGIN-SCREEN.md](docs/LOGIN-SCREEN.md), linked from the README.
- The sidebar's schema/library **splitter (drag to resize) stopped working**
  after #126: it resized `sidebar.firstElementChild`, which #126's new mobile
  segmented control (hidden on desktop) had silently become instead of the
  schema pane — so dragging visibly did nothing. Now targets the schema pane
  directly.
- **Iceberg/Glue/Unity/HMS/REST-catalog databases showed zero tables** (#122):
  ClickHouse >=25.8 hides `DataLakeCatalog`-backed databases from
  `system.tables`/`system.columns` unless
  `show_data_lake_catalogs_in_system_tables = 1` is set. The schema panel's
  table list, column expansion, table-detail pane, and schema-lineage graph
  now request that setting, falling back to the plain query (and remembering
  the fallback for the rest of the session, mirroring `ctx.authConfirmed`) on
  servers older than 25.8 that don't have it.

## [0.2.0] - 2026-07-01

### Added
- **Table/column COMMENT display**: a table's `COMMENT` now shows as a native
  hover tooltip on its node — in both the compact inline schema-lineage graph
  and the fullscreen rich-card graph, never a drawn line, so it can't affect
  either graph's layout — and in the table-info panel's header next to the kind
  badge. Column comments show as a new (wide) column in that panel's columns
  table. The panel's "uncompressed" byte column is replaced by "size %" — the
  percentage of the original (uncompressed) size still on disk after
  compression.
- **Multiquery + run-selection** (#83): run a `;`-separated script (DDL / INSERT /
  SELECT) in one shot, or run just the highlighted text. ⌘+Enter auto-detects — a
  single statement behaves exactly as before; more than one runs **sequentially**
  (one ClickHouse request per statement, stopping on the first failure) into a
  compact per-statement summary grid. A non-empty editor selection runs only that
  text (the Run button flips to **Run selection**); a single selected statement
  still gets the full Table/Chart/EXPLAIN view. Row-returning statements show the
  first row inline (comma-separated) — click to open all rows (capped at 100) in a
  side pane; effectful statements show **OK**. Each grid row also shows that
  statement's own execution time (the toolbar still shows the script total). The
  click-to-open row pane is the **same sortable + resizable grid** as the main
  results table (one shared component). A script that needs cross-statement state
  (a `CREATE TEMPORARY` table or a session `SET`) runs inside a **per-tab
  ClickHouse HTTP session** so that state persists across its separate
  per-statement requests; ordinary scripts run session-less. Cancel aborts mid-script. Splitting
  is purely lexical (`src/core/sql-split.js`), skipping `;` inside string/identifier
  literals and `--` / `#` / `/* */` comments. Known limitation: an `INSERT … FORMAT
  …` with inline data containing `;` mis-splits — run those on their own.
  **Format** pretty-prints each statement of a script and rejoins them (`;` + blank
  line; best-effort — an unformattable statement keeps its text), with a busy
  spinner on the button. **Explain** shows a clear message instead of a generic
  ClickHouse error when the editor holds more than one statement. Opening a saved
  query / history entry **auto-runs only read-only queries** — an effectful one
  (CREATE/ALTER/DROP/INSERT/…) loads into the editor without executing.
- **Result-row cap** with a 100 / 500 / 1000 / 5000 / 10000 selector in the result
  toolbar (default **500**, a global preference persisted across tabs and reloads).
  A normal `SELECT` now fetches at most the selected cap rather than pulling every
  row over the wire: ClickHouse stops cleanly at the cap server-side
  (`max_result_rows` + `result_overflow_mode = 'break'`), a small client-side guard
  trims the block-boundary overage `break` can leave, and a **"first N (capped)"**
  badge appears in the stats row when the limit is hit. Changing the selector
  re-runs the current query, so raising the cap genuinely fetches more. The display
  grid now renders up to the selected cap (10000 actually shows 10000). EXPLAIN /
  PIPELINE / ESTIMATE runs are exempt. (#86)
- Playwright e2e now runs on **WebKit** in addition to Chromium and Firefox, so
  many Safari regressions on the `html{zoom}`-based layout fail CI instead of
  shipping silently. README gained a **Supported browsers** stance: desktop
  Chromium/Firefox/Safari are supported; the full browser/ClickHouse/IdP matrix
  is tracked in #71. (#69)
- `tests/e2e/zoom-support.spec.js` regression-guards the fullscreen-panel sizing
  mechanism (#70) on all three engines. Caveat now documented: Playwright's WebKit
  is **not** a faithful Safari proxy for `zoom` × `getBoundingClientRect`/viewport
  units — it behaves like Chromium there — so that path is verified manually (#71).
- Small schema/EXPLAIN polish (#85): on ClickHouse ≥ 26.3, the EXPLAIN
  plain/Indexes/Projections views render with `pretty = 1, compact = 1` (older
  servers are unaffected — gated on the connected server's version); underscore-
  prefixed tables (`_…`) now sort to the end of each database in the schema
  sidebar and the lineage graph; opening a table's detail pane (fullscreen schema
  graph) shows a loading spinner immediately instead of a blank pane while its
  columns/partitions/DDL fetch; database rows show their `comment` as hover text
  when set (else the existing shortcut hints, now also noting drag-to-graph); and
  the no-comment table hover text now also notes drag-to-insert.
- **Streaming Export** (#87): a new **Export** button in the editor toolbar (next
  to Share) runs the current editor query **uncapped** and streams the result
  straight to a user-chosen file via the File System Access API
  (`showSaveFilePicker` → `resp.body` → disk), bypassing the result grid entirely
  — memory stays flat regardless of result size. Format follows the query: an
  explicit trailing `FORMAT <name>` (in either order relative to a `SETTINGS`
  clause) streams verbatim with a matching file extension; otherwise it defaults
  to `TabSeparatedWithNames`. An inline progress banner (bytes written · elapsed ·
  Cancel) tracks the export; Cancel aborts the stream and issues its own
  `KILL QUERY`, entirely separate from the grid run's cancel state. A **mid-stream**
  ClickHouse error (after the response has already started, so the HTTP status
  can't change) is detected via the `X-ClickHouse-Exception-Tag` header + the
  trailing `__exception__` frame and excised with a hold-back write buffer, so the
  error text is never written into the file — reported as "Export incomplete"
  instead. A session-less export of session-scoped SQL (a `CREATE TEMPORARY
  TABLE` / `SET` from earlier in the same tab) is guarded the same way the rest
  of the app handles those cases. Chromium + a secure context only (no File
  System Access API elsewhere) — the button stays visible but `aria-disabled`
  with an explanatory tooltip. **Replaces** the old result-panel Export
  (buffered CSV/TSV download of the already-loaded grid); Copy is unaffected.
- **Script export** (#99, a follow-up to #87): pressing **Export** on a
  multi-statement script (instead of a single query) opens a **directory**
  picker and runs the statements **sequentially** in one shared ClickHouse HTTP
  session — `SET` / `CREATE TEMPORARY TABLE` state carries across statements the
  same way a run does. Each row-returning statement streams **uncapped** to its
  own file (`NNN-slug.ext`, matching the log's `#` column); non-row statements
  run for effect and log OK/error with no file. A live log pane (metadata only
  — never the exported rows, so a multi-million-row script export stays flat)
  shows status/file/bytes/elapsed per statement; Cancel aborts the active
  statement, issues its own `KILL QUERY`, marks the rest **Skipped**, and keeps
  already-completed files. Stop-on-first-failure, no retry (unlike a normal
  script run, which retries a read-only statement once on a transient
  `SESSION_IS_LOCKED`) — a partially-written file shouldn't be silently
  re-attempted. A script with no result-producing statements shows a toast
  instead of prompting for a folder.
- **Detached-tab primitive + Data Pane Expand** (#100): extracted the schema
  graph's real-tab/overlay-fallback logic into a shared `openInDetachedTab`
  helper (`src/ui/detached-view.js`), now used by the schema graph, the
  EXPLAIN pipeline graph, and a new **Expand** button next to Copy in the
  results toolbar. Expand opens a **snapshot** of the current grid — sortable,
  resizable, with its own Copy, and the full **Table/JSON/Chart** switcher
  (same as the inline pane, but scoped locally: switching view/chart config
  there never touches the live tab's own state) — in a real browser tab,
  falling back to the in-app overlay when a pop-up can't be opened. It
  doesn't live-update if the query is re-run afterward. Pipeline's Expand now
  also opens in a real tab (previously overlay-only); the schema graph's
  existing tab/overlay behavior is unchanged. `app.state.detachedView` (a
  count) tracks how many detached views are open at once. Along the way,
  fixed Chart.js rendering nothing (a 0×0 canvas, then laid-out axes with no
  visible bars/points) when its canvas lives in a detached tab's own
  document — Chart.js's responsive-sizing and resize-triggered relayout read
  through APIs bound to the window its own module runs in, always the main
  window; `renderChart` now forces an explicit resize + `'resize'`-mode
  update off the canvas's own (realm-agnostic) geometry once it's attached.
  Also mirrors the app's favicon into every detached tab (a `faviconHref`
  seam, same pattern as the existing `stylesText` one) — `about:blank` ships
  neither, so a real tab previously showed the browser's generic icon.
- **Cell-detail drawer resize** (#101): the right-hand drawer used by both the
  cell-detail view and the rows viewer now has a drag handle on its left edge
  (`splitters.js` gains a fourth `'drawer'` axis alongside `col`/`sideRow`/`row`),
  clamped to `320px..92vw` and persisted as `cellDrawerPx` — one shared width for
  both. Fixed a click-through: finishing a resize drag with the mouse released
  over the backdrop (instead of the panel) previously closed the drawer, since
  the browser's post-mouseup `click` targets the nearest common ancestor of the
  mousedown/mouseup targets, bypassing the panel's own `stopPropagation`. Closing
  the drawer *mid-drag* (e.g. Escape while the mouse button is still down) now
  also cancels the in-progress drag and reverts the width, rather than leaving
  stray listeners that would persist a stale width or swallow a later, unrelated
  click.
- **UI consistency polish** (#102): the schema tree's expand/collapse chevron
  now rotates a single icon instead of swapping between two glyphs, matching
  the login screen's Advanced disclosure — the rotation actually animates
  (`flipChevron` restores the pre-toggle angle and forces a layout read before
  the target, since `renderSchema` rebuilds the row's DOM on every toggle and
  a freshly-created node has no "from" state for its CSS transition to
  interpolate from). The share toast can be dismissed early by clicking it (it
  no longer blocks clicks while visible); its auto-hide timer now lives on the
  toast element itself rather than a module-level field, so a toast in a
  detached tab's document can't clobber one in the main document's. Opening
  the user menu or the File menu now autofocuses a sensible first item (Log
  out / New Library). `shortcutsOpen`, `editingSavedId`, and
  `bannerDismissedFor` moved into `state.js` as signals, consistent with the
  rest of the ADR-0001 migration — no behavior change.

### Changed
- State reactivity now uses `@preact/signals-core` (the third bundled runtime
  dependency), adopted incrementally per
  [ADR-0001](docs/ADR-0001-reactivity.md): the tab list, side panel, run state
  (`running`/`resultView`), the library title, and now the **schema panel**
  (`schema`/`schemaError`/`schemaFilter`) repaint via signal `effect`s instead of
  manual render calls. No user-facing behavior change. A Preact schema-panel spike
  was evaluated and **rejected** — the app stays framework-free (ADR-0001
  addendum); the schema slice is the documented imperative exception, converted
  with a *replaced* Set-valued `expanded` signal and reference-replaced column
  loads rather than in-place mutation. This **completes the migration**. (#88, #91)
- **Chart-type-aware row cap** (#109): the flat 500-row chart cap is now a
  per-type lookup (`chartRowCap(type)` / `CHART_ROW_CAPS` in
  `src/core/chart-data.js`) — Pie 30, Bar (horizontal) 500, Column 1000, Line/
  Area 5000 — matching each chart shape's actual readability ceiling instead
  of one eyeballed number. Switching chart type re-slices to the new cap and
  updates the truncation note in lockstep.

### Fixed
- A newly created, still-empty database (e.g. `CREATE DATABASE`) never appeared
  in the schema tree, even after a reload/relogin: `loadSchema()` only listed
  databases that had at least one row in `system.tables`. It now enumerates
  databases from `system.databases` and attaches tables where they exist, so an
  empty database shows up immediately. Separately, the schema tree didn't
  refresh after running DDL at all — `CREATE`/`DROP`/`ALTER`/`RENAME`/
  `TRUNCATE`/`ATTACH`/`DETACH`/`EXCHANGE` now auto-reload the schema on a
  successful run, so the tree stays in sync without a manual page reload.
- Multiquery scripts no longer fail intermittently with **"Network error"**. A
  ClickHouse HTTP session is now attached **only when the SQL actually needs one**
  (a `CREATE TEMPORARY` table or a session `SET`), or when the tab already opened
  one (sticky, so that state persists across runs in the tab) — ordinary scripts
  run session-less, removing the session-lock / replica-affinity reset that
  surfaced (behind a proxy/LB) as a reset connection. When a session *is* in use,
  a transient failure is retried **only when safe**: a `SESSION_IS_LOCKED`
  (rejected before execution) or a connection reset on a **read-only** statement.
  A connection reset on an `INSERT`/DDL is **not** retried — it may have executed
  server-side, so it's surfaced as "the statement may have executed; re-run
  manually" rather than silently double-applied.
- The `session_id` / `query_id` fallback used when `crypto.randomUUID` is
  unavailable (non-secure `http://` contexts) now mixes in `Math.random` instead of
  only a coarse `performance.now()`, so two tabs can't mint the same id and collide
  on the session lock.
- Result-table **column resize** now uses a splitter model: dragging a column's
  right edge trades width with its right neighbor (the table's total width and the
  other columns stay put), instead of growing the whole table and shifting later
  columns sideways. Dragging the last column still widens the table. Applies to the
  data grid, the multiquery script grid, and the script-row pane (one shared grid).
- The fullscreen schema / EXPLAIN graph panels were mis-sized on **Safari** (#70).
  They size off viewport units, and engines disagree on how `vw`/`vh` interact
  with `html{zoom}`: Chromium's ignore `zoom` (so `100vh` overshoots one screen by
  the zoom factor and must be divided back), but WebKit/Safari's track `zoom`, so
  the existing `calc(.../var(--zoom))` correction shrank those panels to ~83%. The
  divisor is now measured at runtime (a `100vh` probe vs the one-screen `#root`)
  and published as `--vp-zoom` — ~`--zoom` on Chromium, ~1 on Safari — so the
  panels fit exactly one screen on both. The rest of the UI was already correct on
  Safari (its pointer/caret/drag corrections self-calibrate to the live rect
  ratio). A `@supports not (zoom: 1)` rule still neutralizes the factor to 1 on
  engines that can't parse `zoom` at all.
- The fullscreen schema graph's node detail pane could show stale data:
  clicking table A then quickly clicking table B before A's fetch resolved let
  A's slower response land last and silently replace B's already-mounted pane
  and selection ring — last-**resolved** wins instead of last-**clicked**.
  `openNodeDetail` now tracks the most recently requested node per overlay
  document and drops a fetch whose click has since been superseded. (#97)
- Cancelling or hitting a mid-stream error during a streaming Export (#87) left
  no recoverable file at all: on Chrome's File System Access API,
  `writable.abort()` leaves a hidden, 0-byte `.crswap` swap file behind and never
  materializes the visible target. `streamToFile` now `close()`s the writable
  instead, finalizing whatever bytes were already committed under the target
  handle, then renames it in place to `<name>.partial` via `FileSystemFileHandle
  .move()` (Chrome 110+) so a cancelled/failed export leaves a clearly-labeled,
  inspectable partial artifact. Falls back to leaving the plain (non-renamed)
  file on browsers without `.move()` support, or if the rename itself fails (#105).
- `createApp` built the `app` object with a `doc` field, but every other module
  (`explain-graph.js`, `results.js`, `schema-detail.js`, `file-menu.js`,
  `shortcuts.js`, `app.js` itself) read `app.document` instead — never
  assigned, so `app.document || document` silently always fell back to the
  global `document`, harmless today only because the two happened to coincide
  in both production and tests. `app` now exposes `document` (not `doc`), and
  the fallbacks that were provably unreachable (verified per call site against
  `makeApp()` / real callers) were dropped; the fallbacks that are
  deliberately null/minimal-`app`-tolerant (`detached-view.js`,
  `explain-graph.js`, `schema-detail.js`, and `shortcuts.js` — which has a
  dedicated `delete app.document` test) were left untouched. (#106)
- Every backdrop/panel modal (the cell-detail drawer, the rows-viewer pane, the
  graph overlay, the file-menu confirm dialog, the keyboard-shortcuts modal)
  closed on **any** `click` reaching its backdrop, without checking where the
  gesture's `mousedown` actually landed. A browser's `click` fires on the
  nearest common ancestor of `mousedown`/`mouseup`, not the `mousedown` target,
  so dragging a text selection from inside the panel past its edge before
  releasing produced a `click` targeting the backdrop directly — the panel's
  own `stopPropagation()` never ran (the panel wasn't in that click's
  propagation path at all) and the modal closed, discarding the in-progress
  selection. A new shared `attachBackdropClose` (`src/ui/dom.js`) tracks where
  `mousedown` landed and only closes on a `click` whose `mousedown` also
  landed on the backdrop itself; all five call sites now share it instead of
  each pairing an `onclick: close` backdrop with an `onclick: stopPropagation`
  panel. The cell-detail drawer's resize-drag one-shot click-swallow listener
  (#101) is superseded by the same general fix. (#110)
- The fullscreen schema graph's rich node card had no overflow cap on its
  `idx:` skip-index line — unlike columns (capped at `MAX_COLS` with a "+N
  more" row), every skip-index was joined onto one unbounded line. A
  heavily-indexed table (e.g. an OTel-style log table with a bloom filter per
  Map key/value plus a tokenbf on the body) produced a single line 1700px+
  wide, blowing the card — and the whole graph layout — out of proportion.
  `buildCardModel` now caps the line at `CARD.MAX_IDX` (6) with a "+N more"
  suffix, mirroring the columns' overflow pattern.

## [0.1.5] - 2026-06-29

### Added
- `SECURITY.md`: private vulnerability-disclosure policy + the `config.json`
  threat model (it's served to browsers — prefer a PKCE public client; lock the
  redirect URI if a `client_secret` is unavoidable) and the CSP/token baseline (#72).
- In-app build stamp: the build bakes `v<version> (<short-commit>)` into
  `dist/sql.html` (graceful `v<version>` fallback when not a git checkout) and
  shows it in the user menu, so a bug report can be tied to an exact build (#74).
- `NOTICE` + `THIRD-PARTY-NOTICES.md`, and the bundled Chart.js / dagre (MIT)
  notices are now embedded in the built `dist/sql.html`.
- `CONTRIBUTING.md` and this `CHANGELOG.md`.
- Dependabot configuration for npm + GitHub Actions updates.

## [0.1.4] - 2026-06-28

### Changed
- Schema detail pane: removed the "Insert SHOW CREATE" action button; opening a
  node now rings its card (a double border) and the ring clears on every
  pane-close path including Esc (#65).
- Code-review follow-ups for the schema/zoom work: extracted `schemaLayout()` and
  a `fixedAnchor()` helper, and the transitive-lineage node cap now counts only
  linked nodes so a large single database isn't truncated early (#64).

## [0.1.3] - 2026-06-28

### Changed
- Whole-database schema graph now draws **every** table (linked or not), packs the
  unlinked tables into a grid below the lineage, and drops the redundant `<db>.`
  prefix from node labels for objects in the focused database (#63).

## [0.1.2] - 2026-06-28

### Fixed
- Bridged the shipped `html { zoom }` across the full-view schema panel and the
  splitter / detail-pane-resize / popover coordinate math, so the full view fits
  one screen (the detail-pane DDL was previously pushed off-screen) and drags and
  popovers track the cursor (#62).

## [0.1.1] - 2026-06-28

### Added
- `antalya-oauth` demo connection (Google SSO).

### Changed
- Documentation updates; dropped the inaccurate "zero-dependency" framing (the
  app bundles two deliberate runtime dependencies).

## [0.1.0] - 2026-06-28

### Added
- Initial release: OAuth-gated (PKCE) single-file SQL browser served from
  ClickHouse — SQL editor, sortable results table + chart view, EXPLAIN pipeline
  graph, and the schema data-flow graph. Built by esbuild into one `dist/sql.html`.

[Unreleased]: https://github.com/Altinity/altinity-sql-browser/compare/v0.6.2...HEAD
[0.6.2]: https://github.com/Altinity/altinity-sql-browser/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/Altinity/altinity-sql-browser/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Altinity/altinity-sql-browser/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Altinity/altinity-sql-browser/compare/v0.4.5...v0.5.0
[0.4.5]: https://github.com/Altinity/altinity-sql-browser/compare/v0.4.0...v0.4.5
[0.4.0]: https://github.com/Altinity/altinity-sql-browser/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Altinity/altinity-sql-browser/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Altinity/altinity-sql-browser/compare/v0.1.5...v0.2.0
[0.1.5]: https://github.com/Altinity/altinity-sql-browser/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Altinity/altinity-sql-browser/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Altinity/altinity-sql-browser/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Altinity/altinity-sql-browser/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Altinity/altinity-sql-browser/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Altinity/altinity-sql-browser/releases/tag/v0.1.0
