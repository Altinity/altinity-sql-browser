// The Dashboard's pointer-gesture controller (#589 wave 2, extracted from
// `ui/dashboard.ts`'s render closure). Owns the two tile pointer gestures
// (corner-drag resize, and Command/Ctrl-drag reorder) plus the ⌘/Ctrl
// cursor-affordance cue that shares a keyboard listener with the drag gesture
// — the three pieces of interaction state that used to live as private
// `let`s inside `renderDashboard`. Everything DOM/library-shaped it touches
// (`document`, the grid host, the live document's tile order, the active
// engine, the active style, the grid's placement/column state, the rendered
// surface for a tile, and the scroll host) is read through `TileGestureDeps`
// — this module owns no state that outlives one `renderDashboard` call, and
// `dashboard.ts` constructs a fresh controller per render.
//
// This is a pure DOM-interaction move, not a behavior change: every guard,
// every read-once-vs-read-live discipline, and every listener ordering is
// carried over verbatim from the pre-extraction code. In particular:
//
//   - A drag gesture snapshots `deps.activeEngine()` ONCE, at pointerdown,
//     into `liveReflow` — which then governs the reflow/hit-test PATH for the
//     rest of that one gesture. `deps.renderedSurface(tileId)`, by contrast,
//     is called fresh every time a rendered surface is needed (home-rect
//     capture, drop-target styling) — its own internal engine check (owned by
//     `dashboard.ts`, not this module) is therefore LIVE across the same
//     gesture. An engine flip mid-drag (a repaint from an unrelated cause,
//     e.g. a variable refresh) can make these two disagree — this is a
//     pre-existing latent inconsistency, not something this extraction is
//     licensed to fix.
//   - A resize gesture reads `deps.currentStyle()` once at pointerdown (to
//     gate columns-2/3 and decide `fixedWidth`) and AGAIN, fresh, at commit
//     time when building the `update-placement` command's `style` field — so
//     a style change mid-resize (also from an unrelated repaint) commits
//     under the style active at COMMIT time, not the one active when the
//     drag started.
//   - There is no cross-gesture exclusivity: a drag and a resize can be
//     concurrently active (they gate on separate flags — `dragActive` only
//     blocks a second drag, never a resize). The one thing they share is the
//     single "currently cancellable gesture" slot (`installedGestureCancel`):
//     the LAST gesture to (re)install it owns it, and each gesture's own
//     cleanup only clears the slot if it is still the one holding it — so an
//     older gesture's cleanup can never null out a newer gesture's slot, but
//     a `dispose()`/rerender mid-overlap only ever cancels whichever gesture
//     happens to hold the slot at that instant, not both.
//   - Neither gesture filters window pointermove/pointerup by `pointerId` — a
//     pointer OTHER than the one that started the gesture still moves/ends
//     it, exactly as before.
// Do not "fix" any of the above in a later pass without a dedicated issue —
// `tests/unit/dashboard.test.ts`'s "tile gesture concurrency characterization"
// suite pins every one of them down deliberately.

import { h } from './dom.js';
import { movedPastThreshold, hitTestTile, resolveOverlapInsertIndex, flipDelta } from '../core/tile-reorder.js';
import type { TileRect } from '../core/tile-reorder.js';
import { createDragAutoScroll } from '../core/dashboard-autoscroll.js';
import type { DragAutoScrollController, DragAutoScrollTarget, FrameScheduler } from '../core/dashboard-autoscroll.js';
import {
  DEFAULT_GRID_HEIGHT_UNITS, GRAFANA_GRID_MAX_COLUMNS, GRID_GAP_PX, GRID_HEIGHT_UNIT_MAX, GRID_HEIGHT_UNIT_MIN,
  gridHeightUnitsToPx, snapGridHeight, snapGridSpan,
} from '../dashboard/layouts/grafana-grid-layout.js';
import type { AuthoredDashboardStyle } from '../dashboard/layouts/grafana-grid-layout.js';
import type { DashboardCommand } from '../dashboard/application/dashboard-commands.js';
import type { DashboardStyle } from '../dashboard/application/dashboard-viewer-session.js';

/** One tile's rendered grid placement, as `dashboard.ts`'s reconciler last
 *  committed it — mirrors the anonymous shape of its own `gridPlacementByTile`
 *  map value. `persistedSpan` is the AUTHORED span (never render-mode- or
 *  responsive-clamp-overridden); `span`/`heightUnits`/`colStart` are the
 *  rendered/effective values a corner-drag previews from and pins against. */
export interface GridPlacement {
  span: number;
  heightUnits: number;
  colStart: number;
  persistedSpan: number;
}

/**
 * Everything `createTileGestureController` reads from the enclosing
 * `renderDashboard` render. Every member is a getter (or a stable value
 * handed once) rather than a snapshot passed at construction time — most are
 * called MULTIPLE times across a single render, and some multiple times
 * within a single gesture, on purpose (see the module doc comment above for
 * exactly which ones are one-time snapshots vs. live reads and why).
 */
export interface TileGestureDeps {
  /** The render's document. Read once per gesture (via `.defaultView`) to
   *  resolve the window a gesture's temporary listeners attach to, and once
   *  by `installModifierCue` for the same reason. */
  document: Document;
  /** The `.dash-grid` host. A stable node for the whole render — never
   *  reassigned — so there is no read-once-vs-live distinction for it. */
  grid: HTMLElement;
  /** Dispatch one authoring command. Called only at a gesture's commit point
   *  (drag `onUp`, resize pointerup-commit, resize keyboard step) — never
   *  during a live preview. */
  runCommand(command: DashboardCommand): void;
  /** The engine active as of the last publish. A drag gesture calls this
   *  EXACTLY ONCE, at pointerdown, and freezes the result into `liveReflow`
   *  for that gesture's remaining duration. A resize gesture calls it fresh
   *  at every pointerdown and every keydown (each is its own independent
   *  gate check, never cached across events). */
  activeEngine(): 'flow' | 'grafana-grid' | null;
  /** The Dashboard's current style. A resize gesture calls this once at
   *  pointerdown/keydown (to gate columns-2/3 and derive `fixedWidth`) and
   *  again, fresh, at the moment it commits — so a style change mid-gesture
   *  is reflected in the committed command, not frozen at gesture start. */
  currentStyle(): DashboardStyle;
  /** The grafana-grid engine's last-rendered effective column count. Read
   *  once per resize gesture, at its start. */
  gridColumns(): number;
  /** One tile's last-reconciled grid placement, or `undefined` before the
   *  first grid publish. Read once per resize gesture, at its start
   *  (pointerdown or keydown) — never re-read mid-gesture. */
  gridPlacement(tileId: string): Readonly<GridPlacement> | undefined;
  /** The grid host's measured content-box width. Read once per resize
   *  gesture, at its start, to derive the per-column pixel width used for the
   *  whole gesture's live snap preview. */
  measuredGridWidth(): number;
  /** The live document's tile ids, in canonical (persisted) order. Read
   *  fresh — never cached — every time a drag gesture needs it: once when
   *  capturing home rects (`beginMove`), on every reflow resolution
   *  (`reflowTo`, grid engine only), and again at the gesture's own commit
   *  (`onUp`) to compute the final `move-tile` index. A document change that
   *  lands mid-gesture (a concurrent commit from another producer) is
   *  therefore visible to a still-active drag. */
  tileOrder(): readonly string[];
  /** The DOM element a tile's card/KPI-member host currently renders through
   *  — resolved LIVE, on every call, by `dashboard.ts` (it re-reads its own
   *  `activeEngine` each time this is invoked, not just at gesture start).
   *  Called for every tile OTHER than the one being dragged (siblings, drop
   *  targets) — the dragged tile itself always uses the `card` element handed
   *  directly to `wireTileDrag`. */
  renderedSurface(tileId: string): HTMLElement;
  /** The Dashboard's scrollable viewport (`.dash-page`), or `null` when none
   *  is mounted (e.g. a test fixture). Read once per drag gesture, at its
   *  start — the auto-scroll target and its sticky-topbar offset are derived
   *  from that one read and never re-resolved mid-gesture. */
  scrollHost(): HTMLElement | null;
  /** Force a full grid-structure rebuild on the next publish. Called exactly
   *  once, from a completed drag gesture's DOM restore (`restoreDrag`) —
   *  covers both a cancelled (snap-back) and a committed move, since either
   *  way the gesture's own synchronous DOM restore has to be superseded by
   *  the next publish's real reconciliation. Never called by a resize
   *  gesture, which restores its own inline styles directly. */
  invalidateGridStructure(): void;
}

export interface TileGestureController {
  /** Wire one tile card's corner-drag reorder gesture (grip, no modifier; or
   *  body, ⌘/Ctrl). A read-only Dashboard never calls this. */
  wireTileDrag(tileId: string, card: HTMLElement): void;
  /** Wire one tile's corner-drag / keyboard-arrow resize gesture (grafana-grid
   *  engine only — a no-op gate while flow is active). A read-only Dashboard
   *  never calls this (its cards have no resize handle to begin with). */
  wireGridResize(tileId: string, handle: HTMLElement, card: HTMLElement): void;
  /** Install the ⌘/Ctrl cursor-affordance cue (`.dash-grid.modkey`) and start
   *  tracking the held-modifier state `wireTileDrag`'s body-drag shortcut
   *  reads. A no-op if `deps.document` has no `defaultView` (mirrors the
   *  pre-extraction code's own `gridWin` guard). Edit mode only — callers
   *  gate this the same way they already gate `wireTileDrag`. */
  installModifierCue(): void;
  /** Tear down everything this controller owns: cancel whichever gesture
   *  currently holds the shared cancel slot (if any), and remove the
   *  modifier-cue listeners (if installed) — in that order, matching
   *  `disposeDashboardSurface`'s pre-extraction teardown order. Does NOT
   *  remove the permanent per-card/per-handle listeners `wireTileDrag`/
   *  `wireGridResize` install once at tile-build time: those have no
   *  explicit teardown before this extraction either — the DOM node itself
   *  being discarded on the next grid rebuild is their only cleanup, and
   *  this preserves that exactly rather than adding a listener registry. */
  dispose(): void;
}

/** `card.style.height` as a direct inline px value (numeric row units via
 *  `gridHeightUnitsToPx`) — no fixed-tier CSS class to toggle instead. */
function setGridHeightPx(card: HTMLElement, heightUnits: number): void {
  card.style.height = gridHeightUnitsToPx(heightUnits) + 'px';
}

export function createTileGestureController(deps: TileGestureDeps): TileGestureController {
  const grid = deps.grid;

  // #332: the origin card of a just-completed move whose synthesized click
  // must be swallowed once (see `wireTileDrag`'s pointerdown handler and its
  // `click` listener below). Module-to-gesture, not per-card.
  let clickSuppressCard: HTMLElement | null = null;
  // #332: at most one tile-DRAG gesture at a time — a second pointerdown while
  // one is armed is ignored, so two live listener sets can't cross-
  // contaminate. Deliberately named for exactly what it guards: a RESIZE
  // gesture has its own, entirely separate gate (`activeEngine`/style checks)
  // that never reads this flag, so a resize can start and run concurrently
  // with an active drag — this is not a controller-wide mutual-exclusion
  // guarantee, see the module doc comment above.
  let dragActive = false;
  // Retained across the window keyboard stream because WebKit may omit a
  // held Control key from a subsequent pointer event.
  let reorderModifierHeld = false;
  // An in-flight gesture (drag OR resize) owns window/document listeners and
  // pointer capture. Whichever gesture (re)installs this last owns it — a
  // new render, or `dispose()`, cancels whatever currently holds the slot.
  // Self-clearing: each gesture's own cleanup only nulls this if it is STILL
  // the one holding it (never someone else's newer gesture).
  let installedGestureCancel: (() => void) | null = null;
  let installedModifierCue:
    | { win: Window; onKeyDown: (e: KeyboardEvent) => void; onKeyUp: (e: KeyboardEvent) => void; onBlur: () => void }
    | null = null;

  const prefersReducedMotion = (): boolean =>
    (deps.document.defaultView || window).matchMedia('(prefers-reduced-motion: reduce)').matches;

  // #291 corner-drag resize (Workbench edit mode + grafana-grid engine only):
  // pointer math stays a THIN adapter over the pure `snapGridSpan`/
  // `snapGridHeight` (grafana-grid-layout.ts, rule 5) — live preview via
  // inline style/class during the drag, one `update-placement` dispatch on
  // pointerup. A no-op while flow is active (`activeEngine` guard) even
  // though the handle DOM always exists once built (CSS hides it under the
  // ancestor `.dash-gg-grid` scope; this is the interaction-level backstop).
  //
  // #291 review F3 (pin-during-drag): the tile is PINNED to an explicit
  // `grid-column: ${colStart+1} / span N` for the whole gesture, rather than
  // just `span N` (which lets the browser's own auto-placement re-decide the
  // tile's position on every span change). Without the pin, growing the span
  // mid-drag could make the tile SELF-WRAP to a new row via auto-placement —
  // after which `rect` (captured once at pointerdown) no longer describes the
  // tile's actual position, so every subsequent snap — including the FINAL
  // persisted one at pointerup — was measured against a stale rect. Pinning
  // means the tile can never move mid-drag, so `rect` stays valid throughout.
  // The tradeoff: an explicit start means a span that overflows the columns
  // remaining at THIS start would demand phantom implicit tracks (the same
  // overflow failure mode as F1) instead of wrapping — so both the live
  // preview and the persisted span are clamped to `columns - colStart` for
  // the gesture. Widening further than that needs a second drag after the
  // next repack (deterministic beats a jumpy mid-drag reflow).
  // Full/Report vertical-only resize: each style has a fixed effective width,
  // so horizontal pointer movement is ignored entirely (no `grid-column`
  // re-pin: the card IS full width, there is no sub-span to preview), and the
  // pointerup dispatch re-sends the update writes only that style's
  // `{height}` map. Grid keeps the two-axis resize and its independent
  // `{span,height}` map.
  function wireGridResize(tileId: string, handle: HTMLElement, card: HTMLElement): void {
    handle.addEventListener('pointerdown', (event: Event) => {
      if (deps.activeEngine() !== 'grafana-grid') return;
      const start = event as PointerEvent;
      if (start.button !== 0) return;
      start.preventDefault();
      start.stopPropagation(); // never let the resize handle start a card drag
      const styleAtStart = deps.currentStyle();
      const fixedWidth = styleAtStart === 'full' || styleAtStart === 'report';
      if (styleAtStart === 'columns-2' || styleAtStart === 'columns-3') return;
      const columns = Math.max(1, deps.gridColumns());
      const placement = deps.gridPlacement(tileId);
      const colStart = placement ? placement.colStart : 0;
      const persistedSpan = placement ? placement.persistedSpan : columns;
      // The columns actually available at this tile's pinned start — the
      // clamp ceiling for both the live preview and the persisted span
      // (tiles mode only — full view never touches span).
      const maxSpan = Math.max(1, columns - colStart);
      let curSpan = Math.min(placement ? placement.span : columns, maxSpan);
      let curHeight = placement ? placement.heightUnits : DEFAULT_GRID_HEIGHT_UNITS;
      const savedGridColumn = card.style.gridColumn;
      const savedHeight = card.style.height;
      if (!fixedWidth) card.style.gridColumn = `${colStart + 1} / span ${curSpan}`;
      const rect = card.getBoundingClientRect();
      const colWidthPx = (deps.measuredGridWidth() - GRID_GAP_PX * (columns - 1)) / columns;
      card.classList.add('dash-gg-resizing');
      const win = deps.document.defaultView || window;
      const move = (ev: PointerEvent): void => {
        if (!fixedWidth) {
          const span = snapGridSpan(ev.clientX - rect.left, colWidthPx, GRID_GAP_PX, maxSpan);
          if (span !== curSpan) { curSpan = span; card.style.gridColumn = `${colStart + 1} / span ${curSpan}`; }
        }
        const height = snapGridHeight(ev.clientY - rect.top);
        if (height !== curHeight) { curHeight = height; setGridHeightPx(card, height); }
      };
      const cleanup = (commit: boolean): void => {
        card.classList.remove('dash-gg-resizing');
        win.removeEventListener('pointermove', move as EventListener);
        win.removeEventListener('pointerup', up as EventListener);
        win.removeEventListener('pointercancel', cancel as EventListener);
        win.removeEventListener('blur', cancel);
        deps.document.removeEventListener('keydown', onKey, true);
        handle.removeEventListener('lostpointercapture', cancel as EventListener);
        if (installedGestureCancel === cancel) installedGestureCancel = null;
        if (typeof handle.hasPointerCapture === 'function' && handle.hasPointerCapture(start.pointerId)) {
          handle.releasePointerCapture(start.pointerId);
        }
        if (!commit) {
          card.style.gridColumn = savedGridColumn;
          card.style.height = savedHeight;
          return;
        }
        const style = deps.currentStyle() as AuthoredDashboardStyle;
        deps.runCommand({
          type: 'update-placement',
          tileId,
          style,
          placement: fixedWidth ? { height: curHeight } : { span: curSpan, height: curHeight },
        });
      };
      const up = (): void => cleanup(true);
      const cancel = (): void => cleanup(false);
      const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') cancel(); };
      win.addEventListener('pointermove', move as EventListener);
      win.addEventListener('pointerup', up as EventListener);
      win.addEventListener('pointercancel', cancel as EventListener);
      win.addEventListener('blur', cancel);
      deps.document.addEventListener('keydown', onKey, true);
      handle.addEventListener('lostpointercapture', cancel as EventListener);
      if (typeof handle.setPointerCapture === 'function') handle.setPointerCapture(start.pointerId);
      installedGestureCancel = cancel;
    });
    handle.addEventListener('keydown', (event: Event) => {
      if (deps.activeEngine() !== 'grafana-grid') return;
      const key = event as KeyboardEvent;
      const placement = deps.gridPlacement(tileId)!;
      const style = deps.currentStyle();
      const fixedWidth = style === 'full' || style === 'report';
      if (style === 'columns-2' || style === 'columns-3') return;
      let span = placement.persistedSpan;
      let height = placement.heightUnits;
      if (key.key === 'ArrowUp') height = Math.max(GRID_HEIGHT_UNIT_MIN, height - 1);
      else if (key.key === 'ArrowDown') height = Math.min(GRID_HEIGHT_UNIT_MAX, height + 1);
      // Keyboard span edits tune the authored placement, not the responsive
      // effective span. A saved 12-column tile rendered in a 4-column narrow
      // grid therefore moves 12→11 on ArrowLeft and stays 12 on ArrowRight;
      // it never jumps to the visible clamp (3/4) and loses desktop intent.
      else if (!fixedWidth && key.key === 'ArrowLeft') span = Math.max(1, placement.persistedSpan - 1);
      else if (!fixedWidth && key.key === 'ArrowRight') span = Math.min(GRAFANA_GRID_MAX_COLUMNS, placement.persistedSpan + 1);
      else return;
      key.preventDefault();
      if (span === placement.persistedSpan && height === placement.heightUnits) return;
      deps.runCommand({
        type: 'update-placement',
        tileId,
        style: style as AuthoredDashboardStyle,
        placement: fixedWidth ? { height } : { span, height },
      });
    });
  }

  // #332 tile reorder — pointer drag, NOT native HTML5 drag (a plain body drag
  // must select text, never reorder). A drag STARTS from the top-left grip with
  // no modifier, OR from anywhere on the body with ⌘/Ctrl held (the schema-graph
  // modifier model). On the grafana-grid engine the dragged tile lifts and
  // follows the pointer while the siblings reflow live to open a gap; the move
  // commits to whichever slot the dragged tile overlaps most
  // (`resolveOverlapInsertIndex`, core/tile-reorder.ts, max-overlap — no area
  // threshold, so a short tile like a KPI still resolves correctly against a
  // taller neighbor); it snaps back when it still overlaps its own origin
  // slot most, or overlaps nothing. The flow engine keeps the simpler
  // point-hit-test path (its KPI tiles render detached in a band, with no
  // coherent grid slot to reflow into).
  // A completed move dispatches the same atomic `move-tile` command exactly once;
  // a cancelled move (pointercancel / window blur / Escape) leaves the document,
  // revision, and fallback untouched. Read-only never wires it.
  function wireTileDrag(tileId: string, card: HTMLElement): void {
    // A completed move synthesizes a `click` on the origin card only when the
    // release lands back on it (a cross-tile release fires no native click —
    // different down/up targets). This capture-phase guard swallows that one
    // click so a table cell / log field / link under it is not activated.
    card.addEventListener('click', (event) => {
      if (clickSuppressCard === card) { event.stopPropagation(); event.preventDefault(); clickSuppressCard = null; }
    }, true);
    const onPointerDown: EventListener = (event) => {
      const pe = event as PointerEvent;
      if (pe.button !== 0) return; // primary button only
      // A fresh gesture never inherits a stale suppress. Belt and braces next to the
      // timestamp window above — this covers a pointer gesture that begins inside
      // the window, which the window alone would still swallow.
      clickSuppressCard = null;
      // Every head control owns its own gesture — the resize handle (which also
      // stops propagation), the inline widen, and the `⋯` that holds the rest — so
      // a press on one never starts a move. `.dash-tile-open` is View-mode-only,
      // where this handler is never wired at all; it stays listed because a flow
      // KPI band member's card is reused across a mode change within one session's
      // cached `tileEls`.
      const target = pe.target as Element;
      if (target.closest('.dash-gg-resize, .dash-tile-open, .dash-tile-widen, .dash-tile-menu')) return;
      // Start ONLY from the grip (no modifier), or from the body with ⌘/Ctrl.
      // A plain body press does neither → left alone for text selection.
      const fromGrip = !!target.closest('.dash-gg-grip');
      // WebKit can leave `ctrlKey` false on pointer events synthesized while
      // Control is held. Its modifier-state query remains authoritative, so
      // use both representations for the cross-browser body-drag shortcut.
      const hasReorderModifier = (input: PointerEvent): boolean => reorderModifierHeld || input.metaKey || input.ctrlKey
        || input.getModifierState?.('Meta') || input.getModifierState?.('Control');
      const modified = hasReorderModifier(pe);
      if (!fromGrip && !modified) return;
      if (dragActive) return; // one drag at a time — ignore a second concurrent pointer
      pe.preventDefault(); // suppress the text selection this press would otherwise start
      dragActive = true;
      // Live reflow (float + placeholder + FLIP) is grafana-grid only; flow uses
      // the point-hit-test path. Snapshotted ONCE here — see the module doc
      // comment above for why this can disagree with `deps.renderedSurface`'s
      // own live engine read later in the SAME gesture.
      const liveReflow = deps.activeEngine() === 'grafana-grid';
      const startX = pe.clientX;
      const startY = pe.clientY;
      let moving = false;
      let rects: TileRect[] = [];
      let dropId: string | null = null;               // flow path: outlined hover target
      let placeholder: HTMLElement | null = null;      // grid path: holds the dragged tile's slot
      let savedHeight = '';                            // grid path: the card's grid height inline style
      let savedDisplay = '';                           // both paths: the card's inline display, restored after the float
      let lastReflowId: string | null = null;          // grid path: last resolved insertion slot
      const touched = new Set<HTMLElement>();           // grid path: siblings carrying a FLIP transform
      const win = deps.document.defaultView || window;
      const surfaceRect = (surface: HTMLElement): DOMRect => {
        const own = surface.getBoundingClientRect();
        if (!surface.classList.contains('dash-kpi-member')) return own;
        const childRects = [...surface.children].map((child) => child.getBoundingClientRect());
        const left = Math.min(...childRects.map((r) => r.left));
        const top = Math.min(...childRects.map((r) => r.top));
        const right = Math.max(...childRects.map((r) => r.right));
        const bottom = Math.max(...childRects.map((r) => r.bottom));
        return new DOMRect(left, top, right - left, bottom - top);
      };
      const hitRects = (tileId2: string, surface: HTMLElement): TileRect[] => {
        const nodes = surface.classList.contains('dash-kpi-member') ? [...surface.children] : [surface];
        return nodes.map((node) => {
          const r = node.getBoundingClientRect();
          return { tileId: tileId2, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        });
      };
      // #338: edge auto-scroll while a move is active. `wireTileDrag` runs
      // BEFORE `.dash-page` is inserted (app.root!.replaceChildren happens
      // once, later, at the end of renderDashboard), so the scroll host and
      // its sticky topbar are resolved here, at pointerdown runtime, when the
      // page IS mounted. A `scrollEl === null` (e.g. a test fixture with no
      // `.dash-page`) degrades cleanly: `autoScroll` stays null and
      // `currentRects()` always returns the unadjusted home rects.
      const scrollEl = deps.scrollHost();
      const topbar = scrollEl?.querySelector('.dash-topbar') as HTMLElement | null;
      let scrollTop0 = 0;
      let autoScroll: DragAutoScrollController | null = null;
      let lastPointerX = startX;
      let lastPointerY = startY;
      // Candidate HOME rects, shifted by however far the page has scrolled
      // since `beginMove` captured them — the floating dragged card is
      // position:fixed (viewport-anchored), so it never needs this
      // adjustment; only the STATIONARY siblings' captured rects go stale as
      // the page scrolls under them.
      const currentRects = (): TileRect[] => {
        const dy = (scrollEl ? scrollEl.scrollTop : 0) - scrollTop0;
        if (dy === 0) return rects;
        return rects.map((r) => ({ ...r, top: r.top - dy, bottom: r.bottom - dy }));
      };
      const gridTiles = (): HTMLElement[] =>
        [...grid.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains('dash-gg-tile'));
      const setDrop = (id: string | null): void => {
        if (id === dropId) return;
        if (dropId) deps.renderedSurface(dropId).classList.remove('dash-drop-target');
        dropId = id;
        if (id && id !== tileId) deps.renderedSurface(id).classList.add('dash-drop-target');
      };
      // Move the placeholder so the dragged tile PREVIEWS at the exact final
      // index the commit will splice it to. `move-tile` does splice(from,1) then
      // splice(toIndex,0,moved), so `moved` lands AT index `toIndex` (= the
      // overlapped tile's index) — "the dragged tile takes the slot it overlaps".
      // Among the other cards (currentDoc order minus the dragged one), that is
      // insertion position `targetIndex`; sibs[targetIndex] is the card that
      // follows the gap (undefined → append, i.e. dropping onto the last slot).
      // A null / own-slot resolve returns the gap to the dragged tile's home.
      const reflowTo = (id: string | null): void => {
        if (id === lastReflowId) return;
        lastReflowId = id;
        const sibs = gridTiles().filter((c) => c !== card);
        let ref: Element | null;
        if (id && id !== tileId) {
          const targetIndex = deps.tileOrder().indexOf(id);
          ref = sibs[targetIndex] ?? null; // null → append to the grid (last slot)
        } else {
          ref = card; // snap-back preview: gap returns to the dragged tile's home slot
        }
        const first = sibs.map((c) => c.getBoundingClientRect());
        grid.insertBefore(placeholder!, ref);
        const animate = !prefersReducedMotion();
        sibs.forEach((c, i) => {
          const { dx, dy } = flipDelta(first[i], c.getBoundingClientRect());
          c.style.transition = 'none';
          c.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
          touched.add(c);
        });
        void grid.offsetWidth; // flush the inverted transforms before playing them back to 0
        touched.forEach((c) => { c.style.transition = animate ? 'transform 160ms ease' : ''; c.style.transform = ''; });
      };
      // #338: the single resolution body shared by a real pointermove AND an
      // auto-scroll animation frame (which has no new pointer event of its
      // own — the pointer is stationary while tiles scroll underneath it).
      // `px`/`py` are the LATEST known pointer coords; `currentRects()` folds
      // in however far the page has scrolled since `beginMove`.
      const resolveFromPointer = (px: number, py: number): void => {
        if (liveReflow) {
          const floating = card.getBoundingClientRect();
          reflowTo(resolveOverlapInsertIndex(floating, currentRects()));
        } else {
          setDrop(hitTestTile(currentRects(), px, py));
        }
      };
      const beginMove = (): void => {
        moving = true;
        grid.classList.add('dash-reordering'); // user-select:none + grabbing, only now
        scrollTop0 = scrollEl ? scrollEl.scrollTop : 0;
        // Capture every grid-placed tile's home rect once, in canonical order —
        // overlap/hit-testing always measures against these home positions, so a
        // live sibling shift never feeds back into the decision.
        rects = deps.tileOrder().flatMap((id) => {
          const c = deps.renderedSurface(id);
          // Every rendered movement surface is attached to this grid: ordinary
          // cards directly, KPI members through their band/stream ancestors.
          return hitRects(id, c);
        });
        // Capture the card's HOME rect and inline styles BEFORE inserting the
        // grid placeholder: `grid.insertBefore(placeholder, card)` displaces
        // the card into the NEXT grid cell, so reading getBoundingClientRect()
        // after it would capture the shifted (wrong-column) left and the
        // floated tile would sit a column off from the cursor horizontally
        // (real-browser only — happy-dom ignores grid placement).
        const r0 = surfaceRect(card);
        savedHeight = card.style.height;
        savedDisplay = card.style.display;
        if (liveReflow) {
          // Insert a same-size placeholder in the card's slot so the grid can
          // FLIP-reflow into the gap; the flow path has no slot grid, so no
          // placeholder there — the remaining flow tiles simply reflow to
          // close the gap while the dragged tile floats above them.
          placeholder = h('div', { class: 'dash-tile-placeholder' });
          placeholder.style.gridColumn = card.style.gridColumn;
          placeholder.style.height = card.style.height;
          grid.insertBefore(placeholder, card);
        }
        // Lift the card to a fixed follower — BOTH engines float, so the
        // dragged tile stays under the cursor even while #338 auto-scroll
        // moves the page underneath it (a flow tile left position:static
        // would otherwise scroll off-screen with the rest of the content).
        // The card stays a DOM child of its container (position:fixed pulls
        // it out of flow in place — simpler cleanup than reparenting).
        // Defensive: a KPI-band card's WRAPPER is display:contents, not the
        // card itself, but if some path ever leaves the card's own computed
        // display as 'contents' it can't be position:fixed meaningfully —
        // force a real box for the duration of the drag.
        if (win.getComputedStyle(card).display === 'contents') {
          // A flow KPI query may own several KPI cards. Preserve the stream's
          // row/wrap geometry inside the temporary physical wrapper.
          card.style.display = card.classList.contains('dash-kpi-member') ? 'flex' : 'block';
        }
        card.classList.add('dash-floating');
        card.style.position = 'fixed';
        card.style.left = r0.left + 'px';
        card.style.top = r0.top + 'px';
        card.style.width = r0.width + 'px';
        card.style.height = r0.height + 'px';
        card.style.zIndex = '40';
        // #338: while the drag is active, the pointer nearing the top/bottom
        // edge of the visible `.dash-page` viewport auto-scrolls it — both
        // engines (a grid live-reflow AND a flow reorder can both need more
        // room than the viewport shows). No scroll host (e.g. a fixture with
        // no `.dash-page`) → no auto-scroll, everything else is unaffected.
        if (scrollEl) {
          const el = scrollEl;
          const target: DragAutoScrollTarget = {
            visibleTop: () => el.getBoundingClientRect().top + (topbar ? topbar.offsetHeight : 0),
            visibleBottom: () => el.getBoundingClientRect().bottom,
            scrollBy: (dy: number): number => {
              const before = el.scrollTop;
              const max = Math.max(0, el.scrollHeight - el.clientHeight);
              el.scrollTop = Math.max(0, Math.min(max, before + dy));
              return el.scrollTop - before;
            },
            canScrollUp: () => el.scrollTop > 0,
            canScrollDown: () => el.scrollTop < Math.max(0, el.scrollHeight - el.clientHeight),
          };
          const scheduler: FrameScheduler = {
            request: (cb) => win.requestAnimationFrame(cb),
            cancel: (h2) => win.cancelAnimationFrame(h2),
          };
          autoScroll = createDragAutoScroll(target, scheduler, {
            reducedMotion: prefersReducedMotion(),
            onScrollFrame: () => resolveFromPointer(lastPointerX, lastPointerY),
          });
        }
      };
      const restoreDrag = (): void => {
        // Deterministic, synchronous DOM restore — never rely on the signature-
        // gated reconcile (a snap-back leaves currentDoc unchanged, so the next
        // publish would early-return without rebuilding the DOM the drag mutated).
        if (placeholder) { placeholder.remove(); placeholder = null; }
        card.classList.remove('dash-floating');
        card.style.position = card.style.left = card.style.top = card.style.width = card.style.zIndex = card.style.transform = '';
        card.style.height = savedHeight; // restore the grid height inline style (not clear it)
        card.style.display = savedDisplay; // restore the card's own display (only forced when computed 'contents')
        touched.forEach((c) => { c.style.transition = ''; c.style.transform = ''; });
        touched.clear();
        // defense-in-depth: force a full grid rebuild on the next publish. A
        // revision bump, never a direct signature mutation (#589 wave 1) —
        // `dashboardRepaintPlan` alone decides whether the bump is still
        // unconsumed and a rebuild is owed.
        deps.invalidateGridStructure();
      };
      const onMove = (ev: PointerEvent): void => {
        if (!moving) {
          if (!movedPastThreshold(ev.clientX - startX, ev.clientY - startY)) return;
          beginMove();
        }
        lastPointerX = ev.clientX;
        lastPointerY = ev.clientY;
        card.style.transform = 'translate(' + (ev.clientX - startX) + 'px,' + (ev.clientY - startY) + 'px)'; // both engines float and follow the cursor
        resolveFromPointer(ev.clientX, ev.clientY);
        // Latest pointer Y (viewport coords — unaffected by scroll, the card
        // is position:fixed) drives the edge-proximity check every move, on
        // top of whatever a running auto-scroll frame already applied.
        autoScroll?.setPointerY(ev.clientY);
      };
      const cleanup = (): void => {
        win.removeEventListener('pointermove', onMove as EventListener);
        win.removeEventListener('pointerup', onUp as EventListener);
        win.removeEventListener('pointercancel', onCancel as EventListener);
        win.removeEventListener('blur', onCancel);
        deps.document.removeEventListener('keydown', onKey, true);
        card.removeEventListener('lostpointercapture', onCancel as EventListener);
        autoScroll?.stop();
        autoScroll = null;
        if (moving) { restoreDrag(); setDrop(null); }
        grid.classList.remove('dash-reordering');
        dragActive = false;
        if (installedGestureCancel === cleanup) installedGestureCancel = null;
        if (typeof card.hasPointerCapture === 'function' && card.hasPointerCapture(pe.pointerId)) {
          card.releasePointerCapture(pe.pointerId);
        }
      };
      const onUp = (ev: PointerEvent): void => {
        const wasMoving = moving;
        const targetId = !wasMoving ? null
          : liveReflow ? resolveOverlapInsertIndex(card.getBoundingClientRect(), currentRects())
            : hitTestTile(currentRects(), ev.clientX, ev.clientY);
        cleanup();
        if (!wasMoving) return; // never crossed the threshold: leave the click alone
        // A completed drag that releases back over its origin card synthesizes a
        // real click on it (same down/up target) — swallow it so no cell/link/
        // preview fires.
        clickSuppressCard = card;
        // #471: and a release ANYWHERE ELSE synthesizes no origin click at all, so
        // nothing would ever consume this. The synthesized click, when there is one,
        // is dispatched in the same input task as the release — so a zero-delay timer
        // runs strictly after it, and disarms the flag before any later click can meet
        // it. That later click may have no pointerdown to clear it (Enter on a focused
        // tile action), which is exactly the case a pointerdown-only reset missed.
        win.setTimeout(() => { if (clickSuppressCard === card) clickSuppressCard = null; }, 0);
        if (targetId && targetId !== tileId) {
          deps.runCommand({ type: 'move-tile', tileId, toIndex: deps.tileOrder().indexOf(targetId) });
        }
      };
      const onCancel = (): void => cleanup(); // pointercancel / window blur — cancel, never dispatch
      const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') cleanup(); };
      win.addEventListener('pointermove', onMove as EventListener);
      win.addEventListener('pointerup', onUp as EventListener);
      win.addEventListener('pointercancel', onCancel as EventListener);
      win.addEventListener('blur', onCancel);
      deps.document.addEventListener('keydown', onKey, true);
      card.addEventListener('lostpointercapture', onCancel as EventListener);
      if (typeof card.setPointerCapture === 'function') card.setPointerCapture(pe.pointerId);
      installedGestureCancel = cleanup;
    };
    card.addEventListener('pointerdown', onPointerDown);
  }

  // #332: while ⌘/Ctrl is held the grid shows the grab affordance over its
  // tiles (CSS `.dash-grid.modkey`), the same cursor cue the schema graph uses.
  // Edit mode only — callers gate this call the same way they gate
  // `wireTileDrag`. Torn down by `dispose()`.
  function installModifierCue(): void {
    const win = deps.document.defaultView;
    if (!win) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.key === 'Meta' || e.key === 'Control') {
        reorderModifierHeld = true;
        grid.classList.add('modkey');
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      reorderModifierHeld = e.metaKey || e.ctrlKey;
      if (!reorderModifierHeld) grid.classList.remove('modkey');
    };
    const onBlur = (): void => { reorderModifierHeld = false; grid.classList.remove('modkey'); };
    win.addEventListener('keydown', onKeyDown);
    win.addEventListener('keyup', onKeyUp);
    win.addEventListener('blur', onBlur);
    installedModifierCue = { win, onKeyDown, onKeyUp, onBlur };
  }

  function dispose(): void {
    if (installedModifierCue) {
      const m = installedModifierCue;
      m.win.removeEventListener('keydown', m.onKeyDown);
      m.win.removeEventListener('keyup', m.onKeyUp);
      m.win.removeEventListener('blur', m.onBlur);
      installedModifierCue = null;
    }
    if (installedGestureCancel) installedGestureCancel();
  }

  return { wireTileDrag, wireGridResize, installModifierCue, dispose };
}
