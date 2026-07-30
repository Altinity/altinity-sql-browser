// The desktop left navigation's layout decisions (#487 phase 1) — pure, no DOM,
// no globals. This module owns the *semantic* mode ('wide' two-pane sidebar vs
// compact 'rail'), the widths each presentation may take, and every transition
// between them. It owns none of the rendering: phase 2 extracts the section
// registry, phase 3 builds the rail, the docked focused drawer and the resize
// separator on top of exactly these functions.
//
// Why a mode reducer rather than reading CSS widths back: #487 is explicit that
// "the mode is explicit application-shell state" and must not be re-derived from
// every pointer pixel after every repaint. So the separator's job in phase 3 is
// only to report a proposed width; what that width *means* is decided here, once,
// in one place both the pointer and the keyboard paths go through — which is also
// why the issue's "keyboard separator operations match pointer transitions" test
// is a property of this module rather than something the UI has to keep in sync.
//
// Every function here takes and returns the navigation's proposed *total* width.
// That is deliberate and it is what keeps a drag continuous: a wide sidebar's own
// width IS the total, while an open drawer's width is the total minus the rail
// beside it. Handing the reducer one mode-relative number instead made a
// monotone rightward drag snap the navigation 108px BACKWARDS on the frame it
// converted a drawer to the wide sidebar, because the two measurements disagree
// by exactly the rail's width at the crossing. Totals are the only common
// currency, so the reducer does the per-mode subtraction itself.

import { clamp } from './format.js';

/** The compact rail's fixed visual width. Nothing resizes the rail *to* another
 *  value — it is the mode, not a width — though it does appear as a lower bound
 *  elsewhere here (the separator's `aria-valuemin`, and the offset an open
 *  drawer's own width sits behind). */
export const LEFT_RAIL_PX = 48;

/**
 * The two mode thresholds, and the pair *is* the hysteresis: folding wide → rail
 * requires a proposal below `LEFT_FOLD_THRESHOLD_PX`, restoring rail → wide
 * requires one above `LEFT_WIDE_THRESHOLD_PX`. Between the two the mode is
 * sticky, so no single pointer pixel can oscillate it — which is what #487 means
 * by "must not flicker near a single threshold".
 */
export const LEFT_FOLD_THRESHOLD_PX = 140;
export const LEFT_WIDE_THRESHOLD_PX = 260;

/** The WIDE two-pane sidebar's resize bounds — the range `asb:sidebarPx` has
 *  always used, preserved verbatim per #487 ("preserve the existing
 *  sidebar-width preference range"). `LEFT_PANEL_MAX_PX` bounds ONLY the wide
 *  sidebar — a 420px drawer is impossible, since a drag that far right
 *  converts to the wide sidebar first (see `clampDrawerWidthPx`).
 *
 *  `LEFT_PANEL_MIN_PX`, though, is now ALSO the focused drawer's own resizable
 *  floor, reused rather than duplicated as a second "180" constant: phase 1
 *  shipped the drawer's floor at the fold threshold (140) as an explicit open
 *  question, and a real-browser check settled it — at 140px the Dashboards
 *  section's three titles rendered as "Sa...", "O...", "A..." (unreadable and
 *  indistinguishable), while at 180px they read as "Sales re...", "Ops
 *  late...", "A very lo..." (ellipsized, but readable and distinguishable). */
export const LEFT_PANEL_MIN_PX = 180;
export const LEFT_PANEL_MAX_PX = 420;

/** The wide sidebar's documented default — the value `asb:sidebarPx` has
 *  defaulted to since it was introduced, and the fallback a corrupt stored value
 *  falls back to. */
export const LEFT_WIDE_DEFAULT_PX = 248;

/** The focused drawer's documented default, inside the drawer's own
 *  [fold, wide] band below. */
export const LEFT_DRAWER_DEFAULT_PX = 240;

/** Keyboard resize steps for the separator: a small step for a bare arrow, a
 *  large one for Shift+arrow (#487's "Left/Right Arrow resize by a small step;
 *  Shift+Left/Right resize by a larger step"). */
export const LEFT_NAV_STEP_PX = 16;
export const LEFT_NAV_LARGE_STEP_PX = 64;

export type LeftNavigationMode = 'wide' | 'rail';

/**
 * The four rail sections, named as #487's own section table names them.
 *
 * **`'library'` is NOT the value `AppState.sidePanel` holds for the same
 * section.** That signal still stores `'saved'` (persisted at `asb:sidePanel`,
 * compared against in `ui/saved-history.ts`); #427 renamed the visible *label* to
 * "Library" and deliberately left the stored value alone, since migrating it
 * would discard every user's persisted lower-pane choice for no behavioural gain.
 *
 * So the vocabularies genuinely differ, and the mapping lives in exactly one
 * place — `sectionForSidePanelKey` / `sidePanelKeyFor` below, added in phase 2.
 * `ui/nav-sections.ts` (the navigation section registry) is its UI-side owner and
 * only consumer of the section half; the *decode* half belongs here beside
 * `decodeLeftNavigationMode`, because `state.ts` applies it at the load boundary
 * and must not import from `src/ui/`.
 */
export type LeftNavigationSection = 'databases' | 'dashboards' | 'library' | 'history';

/** Rail order, top to bottom — the order #487's section table lists, and the
 *  same order the existing wide switchers present (Databases | Dashboards above,
 *  Library | History below). */
export const LEFT_NAV_SECTIONS: readonly LeftNavigationSection[] =
  ['databases', 'dashboards', 'library', 'history'];

/** The lower sidebar pane's two sections, in the registry's vocabulary. Derived
 *  from `LeftNavigationSection` so the section names have exactly one source. */
export type LowerNavigationSection = Extract<LeftNavigationSection, 'library' | 'history'>;

/**
 * What `AppState.sidePanel` actually stores. `'saved'` is the Library section:
 * #427 renamed the visible label but deliberately left the persisted value at
 * `asb:sidePanel` alone, since migrating it would discard every user's lower-pane
 * choice for no behavioural gain.
 */
export type SidePanelKey = 'saved' | 'history';

/** Section → stored value. */
export function sidePanelKeyFor(section: LowerNavigationSection): SidePanelKey {
  return section === 'library' ? 'saved' : 'history';
}

/**
 * Stored value → section, and the DECODER for `asb:sidePanel`: a missing, invalid
 * or obsolete stored value resolves to the Library section, which is that
 * preference's documented default (`state.ts` reads it with `'saved'` as the
 * fallback), rather than propagating an unrecognized string.
 *
 * That fallback direction matters, and it is a deliberate fix rather than
 * preserved behaviour. Before phase 2 the lower pane's two sections shared one
 * search/list pair and every reader compared `=== 'saved'`, so an unrecognized
 * value fell through to the History branch — i.e. to neither the default nor the
 * value's own meaning. With two hosts, two readers disagreeing about the fallback
 * exposes one section's host while painting into the other's, which renders as a
 * blank pane. `state.ts` now decodes once at load, so the signal only ever holds
 * a `SidePanelKey` and the disagreement is unreachable rather than merely
 * avoided by discipline.
 */
export function sectionForSidePanelKey(key: unknown): LowerNavigationSection {
  return key === 'history' ? 'history' : 'library';
}

/**
 * The complete left-navigation layout. `wideWidthPx` is deliberately the SAME
 * value `AppState.sidebarPx` persists at `asb:sidebarPx` — #487 suggests a new
 * `wideWidthPx` field, but that key already holds exactly this width over
 * exactly this range, and two sources of truth for one width is a bug waiting
 * to happen. `state.ts` maps the two names at the boundary.
 *
 * `focusedSection` is session UI state (never persisted, per #487) and is only
 * meaningful in 'rail' mode: 'wide' shows both panes, so there is nothing to
 * focus. **Every reducer here maintains that invariant** — no sequence of drags,
 * keys or rail activations can produce 'wide' with a non-null `focusedSection`,
 * and `leftNavigationLayoutIsCoherent` states it as a checkable predicate.
 *
 * The invariant lives in the reducers, though, NOT in the two signals
 * `state.ts` stores it across: those are independently settable, so phase 3 must
 * route every write through these functions. In particular a wide-mode
 * `openFocusedSection(section)` must drive the existing pane switchers, never
 * `state.leftNavSection` — see `resolveRailActivation`.
 *
 * `readonly` throughout, matching `core/dashboard-tree-ui-state.ts` (the closest
 * sibling: also a pure copy-on-write UI-state reducer). It matters here because
 * the reducers below return the SAME object when nothing changes, and phase 3 is
 * invited to use that identity to skip a repaint — which only holds if a caller
 * cannot mutate a layout in place.
 */
export interface LeftNavigationLayout {
  readonly mode: LeftNavigationMode;
  readonly wideWidthPx: number;
  readonly drawerWidthPx: number;
  readonly focusedSection: LeftNavigationSection | null;
}

/**
 * True for exactly the four known section names.
 *
 * No caller yet, and deliberately so: phase 3's `openFocusedSection(section)` is
 * a public seam #428's drag-hover path calls from outside this module, and that
 * is the boundary an unchecked string could cross. Nothing validates through it
 * today — `focusedSection` is session-only state seeded from a literal, so there
 * is no persistence path an obsolete section could arrive by. It lands with the
 * type it guards rather than being invented later against a half-remembered union.
 */
export function isLeftNavigationSection(value: unknown): value is LeftNavigationSection {
  return LEFT_NAV_SECTIONS.some((section) => section === value);
}

/**
 * Heal a layout into a renderable one: a focused drawer only in rail mode, both
 * widths finite and inside their own band, and a section only if it is one of the
 * four. Returns the argument itself when it is already legal, so the reducers'
 * identity-skip contract survives.
 *
 * Every reducer normalizes its input through this, which is what makes their
 * postcondition unconditional. Without it the invariant was only ever a
 * *precondition* — `resolveLeftNavigationDrag({ mode: 'wide', focusedSection:
 * 'databases' }, 300)` preserved the illegal pair rather than fixing it, and
 * `End` handed it straight back. That matters because `state.ts` stores `mode` and
 * `focusedSection` in two independently writable signals: any caller that writes
 * one without the other produces exactly that pair, and `leftNavigationWidthPx`
 * would then push the centre surface by a width that omits the open drawer.
 *
 * Healing here does not make the atomic-write discipline optional — phase 3 should
 * still write both signals together — but it means a slip is corrected on the next
 * interaction instead of persisting as an unrenderable shell.
 */
export function normalizeLeftNavigationLayout(layout: LeftNavigationLayout): LeftNavigationLayout {
  const mode = layout.mode === 'rail' ? 'rail' : 'wide';
  const wideWidthPx = clampWideWidthPx(layout.wideWidthPx);
  const drawerWidthPx = clampDrawerWidthPx(layout.drawerWidthPx);
  const focusedSection = mode === 'rail' && isLeftNavigationSection(layout.focusedSection)
    ? layout.focusedSection
    : null;
  const unchanged = mode === layout.mode && wideWidthPx === layout.wideWidthPx
    && drawerWidthPx === layout.drawerWidthPx && focusedSection === layout.focusedSection;
  return unchanged ? layout : { mode, wideWidthPx, drawerWidthPx, focusedSection };
}

/** A layout is coherent exactly when normalizing it changes nothing — so this
 *  covers the `mode`/`focusedSection` pairing AND finite, in-band widths, rather
 *  than only the pairing (a `NaN` width used to pass). */
export function leftNavigationLayoutIsCoherent(layout: LeftNavigationLayout): boolean {
  return normalizeLeftNavigationLayout(layout) === layout;
}

/** Decode a persisted mode. Anything that is not exactly `'rail'` — a missing
 *  key, an obsolete value, a truncated write — decodes to `'wide'`, the
 *  documented default for a fresh desktop session. */
export function decodeLeftNavigationMode(value: unknown): LeftNavigationMode {
  return value === 'rail' ? 'rail' : 'wide';
}

/**
 * Clamp a wide-sidebar width into `[LEFT_PANEL_MIN_PX, LEFT_PANEL_MAX_PX]`.
 *
 * NaN-safe on purpose: `clamp` alone is not. `Math.min(420, NaN)` is NaN and so
 * is `Math.max(180, NaN)`, so the bare `clamp(parseInt(stored), 180, 420)` this
 * replaces decoded a corrupt `asb:sidebarPx` straight through to NaN — and a NaN
 * width reaches the DOM as `width: NaNpx`, which the browser drops, silently
 * collapsing the sidebar. #487 requires invalid widths to "clamp safely".
 *
 * Only NaN takes the default: `±Infinity` has an unambiguous clamp target and
 * still returns the bound it is pressed against, exactly as the bare `clamp` did.
 * Guarding both would have introduced a discontinuity — `-1` → 180 but
 * `-Infinity` → 248 — and quietly changed this key's existing behaviour.
 */
export function clampWideWidthPx(px: number): number {
  if (Number.isNaN(px)) return LEFT_WIDE_DEFAULT_PX;
  return clamp(px, LEFT_PANEL_MIN_PX, LEFT_PANEL_MAX_PX);
}

/**
 * Clamp a focused-drawer width into `[LEFT_PANEL_MIN_PX, LEFT_WIDE_THRESHOLD_PX]`
 * — i.e. `[180, 260]` — the drawer's own band, NOT the wide sidebar's
 * `[LEFT_PANEL_MIN_PX, LEFT_PANEL_MAX_PX]` (`[180, 420]`). The two bands now
 * share a floor but not a ceiling: a drawer drag converts to the wide sidebar
 * long before it would ever reach 420, so nothing above 260 is a legal drawer
 * width. `clampWideWidthPx` governs the wide sidebar.
 *
 * **The floor is deliberately `LEFT_PANEL_MIN_PX`, not `LEFT_FOLD_THRESHOLD_PX`
 * — a real, settled design decision, not phase 1's original shape.** Phase 1
 * shipped this clamp's floor AT the fold threshold (`[140, 260]`), flagged as
 * an explicit open question: a 140px drawer has to hold a title, a search box,
 * tree indentation and action controls, and might be too narrow to do it
 * legibly. A real-browser check confirmed it was: at 140px the Dashboards
 * section's three titles rendered as "Sa...", "O...", "A..." — unreadable and
 * indistinguishable from one another — while at 180px they read as "Sales
 * re...", "Ops late...", "A very lo..." — still ellipsized, but genuinely
 * readable and distinguishable. So the floor was raised to `LEFT_PANEL_MIN_PX`,
 * reusing the wide sidebar's own floor constant rather than inventing a second
 * "180" value, since the two are now the identical width for the identical
 * reason.
 *
 * That reuse is also what gives the drawer the wide sidebar's own dead-zone
 * mechanism FOR FREE, with no new branch anywhere: `resolveLeftNavigationDrag`'s
 * drawer branch still folds only below `LEFT_FOLD_THRESHOLD_PX` (140,
 * unchanged — that comparison runs on the RAW proposal, before this clamp), so
 * a raw proposal between 140 and 180 no longer folds, and no longer clips at
 * the raw proposed width either; it simply clamps UP to this floor and holds
 * there — exactly mirroring `clampWideWidthPx`'s own dead zone, which falls out
 * of its plain range clamp the same way.
 */
export function clampDrawerWidthPx(px: number): number {
  if (Number.isNaN(px)) return LEFT_DRAWER_DEFAULT_PX;
  return clamp(px, LEFT_PANEL_MIN_PX, LEFT_WIDE_THRESHOLD_PX);
}

/**
 * Decode a persisted pixel width, falling back to `fallbackPx` for anything that
 * is not a complete number.
 *
 * `parseInt` is deliberately not used: it accepts a numeric *prefix*, so
 * `'12junk'` decodes to 12 and `'200px'` to 200 — which made the "an invalid
 * stored value returns to its documented default" contract false for exactly the
 * corruption most likely to occur (a truncated write, or a value someone hand-
 * edited with a CSS unit). `Number` requires the whole string, and the
 * `Number.isFinite` guard also rejects the literal `'Infinity'` that `Number`
 * would otherwise accept — a stored infinity is a corrupt value, not a width
 * pressed against a bound.
 *
 * The clamp still runs afterwards, so a well-formed but out-of-range value is
 * pulled into its band rather than discarded.
 */
export function decodeStoredPx(raw: unknown, fallbackPx: number): number {
  if (typeof raw !== 'string' || raw.trim() === '') return fallbackPx;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallbackPx;
}

/**
 * The width the navigation actually occupies in the shell row — what the centre
 * surface is pushed by, and what the separator reports as `aria-valuenow`.
 * 'rail' with a drawer open occupies both: #487 requires every rail icon to stay
 * visible while a drawer is open, so the drawer sits beside the rail rather than
 * replacing it.
 */
export function leftNavigationWidthPx(layout: LeftNavigationLayout): number {
  if (layout.mode === 'wide') return layout.wideWidthPx;
  return layout.focusedSection === null ? LEFT_RAIL_PX : LEFT_RAIL_PX + layout.drawerWidthPx;
}

/**
 * The mode machine. Given the current layout and the proposed TOTAL navigation
 * width, return the next layout.
 *
 * `totalPx` is the navigation's full width measured from its own left edge — for
 * a pointer drag, `clientX` minus whatever the shell offsets the navigation by
 * (zero today; phase 3 must subtract a real offset if a left gutter ever appears,
 * or every threshold here silently shifts by it). The reducer derives each mode's
 * own panel width from that total itself, which is what keeps a drag continuous
 * across a mode change.
 *
 * Returns the SAME object when nothing changes — a bare rail drag below the wide
 * threshold has no effect at all, since the rail's width is the mode.
 *
 * **A drag follows the pointer; it does not restore remembered widths.** #487
 * asks a rail → wide drag to "restore the last useful wide width" *and* to "show
 * deterministic resize feedback", and those two cannot both hold: whatever width
 * the crossing frame installs, the very next pointermove overwrites with the
 * pointer's own position, so a restored width would survive exactly one frame and
 * read as a flicker. Direct manipulation wins during a gesture — the panel edge
 * stays under the finger — and the remembered width is restored by `End`, which
 * has no pointer to follow. See `resolveLeftNavigationKey`.
 *
 * Width memory: `wideWidthPx` is only committed for proposals inside
 * `[MIN, MAX]`, and a fold leaves it untouched, so it survives a trip through
 * rail mode for `End` and for the persisted preference. The documented
 * consequence is that dragging through the 140–180 dead zone rests the width at
 * the 180 floor, so a later `End` restores 180 rather than the pre-drag width —
 * deterministic, and the alternative (freezing the width while the pointer keeps
 * moving) would show a sidebar that refuses to shrink to its own floor.
 */
export function resolveLeftNavigationDrag(
  input: LeftNavigationLayout, totalPx: number,
): LeftNavigationLayout {
  const layout = normalizeLeftNavigationLayout(input);
  if (layout.mode === 'wide') {
    // A wide sidebar IS the whole navigation, so its panel width is the total.
    // Past the fold threshold: commit rail. The wide width is frozen at whatever
    // the drag last rested at inside the wide range, and the rail opens with no
    // focused section — #487 gives it none automatically.
    if (totalPx < LEFT_FOLD_THRESHOLD_PX) {
      return { ...layout, mode: 'rail', focusedSection: null };
    }
    // Ordinary wide resize. Between the fold threshold and the 180 floor the
    // sidebar sits AT the floor rather than clipping, so the user has to pull
    // decisively past 140 to fold — "do not leave a partially clipped wide
    // sidebar".
    return { ...layout, wideWidthPx: clampWideWidthPx(totalPx) };
  }
  // An open drawer sits BESIDE the rail, so its own width is the total minus the
  // rail; a bare rail has no panel, and a rightward drag is a bid for a sidebar
  // whose width would be the whole total.
  const hasDrawer = layout.focusedSection !== null;
  const panelPx = hasDrawer ? totalPx - LEFT_RAIL_PX : totalPx;
  // Past the wide threshold: restore the two-pane sidebar AT THE POINTER, not at
  // the remembered width (see this function's doc — a restored width would live
  // one frame). `totalPx`, not `panelPx`: the sidebar replaces the rail as well
  // as the drawer, so the total is what it must fill to stay under the finger.
  if (panelPx > LEFT_WIDE_THRESHOLD_PX) {
    return { ...layout, mode: 'wide', wideWidthPx: clampWideWidthPx(totalPx), focusedSection: null };
  }
  // A bare rail below the wide threshold has nothing to resize.
  if (!hasDrawer) return layout;
  // Fold the focused drawer closed, keeping its width for the next open — the
  // rail itself stays visible, per #487.
  if (panelPx < LEFT_FOLD_THRESHOLD_PX) return { ...layout, focusedSection: null };
  return { ...layout, drawerWidthPx: clampDrawerWidthPx(panelPx) };
}

/** The subset of a keyboard event the separator's key handling reads — so a
 *  plain `{ key }` fixture satisfies it without a DOM event. The modifiers are
 *  read to REJECT chords: `Ctrl+Home` must not fold the navigation, and
 *  `Alt+ArrowLeft` is the browser's Back on some platforms. Shift is the one
 *  modifier with a meaning here (the large step). */
export interface LeftNavigationKey {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** Fold to a bare rail — `Home`, and the leftward arrow's boundary transition. */
function foldToRail(layout: LeftNavigationLayout): LeftNavigationLayout {
  return layout.mode === 'rail' && layout.focusedSection === null
    ? layout
    : { ...layout, mode: 'rail', focusedSection: null };
}

/** Restore the wide sidebar at its REMEMBERED width — `End`, and the rightward
 *  arrow's boundary transition out of a bare rail. This is the one place a
 *  remembered width is restored; a pointer drag follows the pointer instead. */
function restoreWide(layout: LeftNavigationLayout): LeftNavigationLayout {
  return layout.mode === 'wide'
    ? layout
    : { ...layout, mode: 'wide', wideWidthPx: clampWideWidthPx(layout.wideWidthPx), focusedSection: null };
}

/**
 * Resolve a keyboard separator operation, or `null` when the key is not one of
 * ours — phase 3 must not swallow keys it does not handle, and must not treat a
 * Ctrl/Meta/Alt chord as a resize.
 *
 * **Arrows resize within a band and perform the semantic transition at its edge.**
 * That edge case is not decoration: an arrow key carries a *relative* step, and
 * every band here is bounded by a dead zone wider than one step, so a purely
 * relative arrow gets stranded at a boundary forever.
 *
 * All three ends had that failure, and they are exact mirrors of each other:
 *
 * - a bare rail is 48px wide and the nearest legal wide width is 180, so a +16
 *   step proposes 64, lands in the sticky band and does nothing;
 * - a wide sidebar at its 180 floor folds only below 140, so a −16 step proposes
 *   164, clamps straight back to 180 and does nothing;
 * - an open drawer at its OWN 180 floor folds only below the identical 140, for
 *   the identical reason, so a −16 step lands in that same 140–179 dead zone,
 *   clamps straight back to 180 and does nothing. This third case is NEW: the
 *   drawer's floor used to sit exactly AT the fold threshold (140), so any step
 *   below it was already below the threshold too and folded on its own — only
 *   raising the floor to 180 (see `clampDrawerWidthPx`) separated the two and
 *   made a dead zone, and therefore a stranding, possible here as well.
 *
 * A *pointer* escapes all three because `clientX` is absolute — it keeps
 * travelling until it crosses the threshold — so leaving them relative made the
 * keyboard and pointer disagree over a *sequence* even while agreeing on every
 * single step. Eleven ArrowLeft presses from a 300px sidebar used to sit at 180
 * forever while the equivalent pointer path folded, with `aria-valuemin: 48`
 * advertised throughout. `Home`/`Shift+Arrow` escaping is not a defence: the
 * W3C splitter pattern makes plain Left/Right the separator's move keys.
 *
 * So the boundary step performs the transition the band edge implies, and every
 * step inside a band still routes through `resolveLeftNavigationDrag` — the
 * resize arithmetic has exactly one implementation.
 */
export function resolveLeftNavigationKey(
  input: LeftNavigationLayout, event: LeftNavigationKey,
): LeftNavigationLayout | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const layout = normalizeLeftNavigationLayout(input);
  // Home folds and End restores, regardless of mode — pressed twice they are
  // idempotent, not a toggle.
  if (event.key === 'Home') return foldToRail(layout);
  if (event.key === 'End') return restoreWide(layout);
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return null;
  const towardWide = event.key === 'ArrowRight';
  // A bare rail has no panel to resize: rightward is the restore transition (at
  // the remembered width, like End — a fixed threshold-plus-step would silently
  // discard a remembered 420 and hand back 276), and leftward is a no-op because
  // the rail is already as folded as it goes.
  if (layout.mode === 'rail' && layout.focusedSection === null) {
    return towardWide ? restoreWide(layout) : layout;
  }
  // A wide sidebar already at its floor: leftward is the fold transition.
  if (layout.mode === 'wide' && !towardWide && layout.wideWidthPx <= LEFT_PANEL_MIN_PX) {
    return foldToRail(layout);
  }
  // An open drawer now needs the IDENTICAL check, and that need is new: before
  // the drawer's floor was raised to LEFT_PANEL_MIN_PX to match the wide
  // sidebar's (see `clampDrawerWidthPx`), the drawer's floor WAS the fold
  // threshold, so an ordinary relative step below it was already below the
  // threshold too and folded on its own — no special case required. Now that
  // the two values differ, a step below the drawer's floor lands IN the
  // 140–179 dead zone instead of past it, and would strand there forever
  // exactly like the wide sidebar's floor once did, absent this check. A
  // 'rail' layout reaching here is never bare (the bare-rail branch above
  // already returned), so `focusedSection` is guaranteed non-null.
  if (layout.mode === 'rail' && !towardWide && layout.drawerWidthPx <= LEFT_PANEL_MIN_PX) {
    return { ...layout, focusedSection: null };
  }
  const step = event.shiftKey ? LEFT_NAV_LARGE_STEP_PX : LEFT_NAV_STEP_PX;
  return resolveLeftNavigationDrag(layout, leftNavigationWidthPx(layout) + (towardWide ? step : -step));
}

/**
 * A rail launcher CLICK. Clicking the active section closes the drawer; clicking a
 * different one switches content in place without closing first, as #487 requires.
 *
 * **This is a toggle, so it is not the `openFocusedSection` seam** — see
 * `resolveRailOpen` below. Conflating the two is a real bug rather than a naming
 * quibble: #428's bounded drag-hover fires repeatedly while a Library query is
 * held over the Dashboards icon, and a toggle would flap the drawer open and shut
 * on alternate notifications.
 *
 * **Returns the layout unchanged in wide mode, and that is a hard limit, not a
 * silent fallback.** There is no drawer in wide mode and both panes are already
 * showing, so "open this section" there means selecting a pane, which is the
 * registry's job and not a width decision. Phase 3 must branch on the mode and
 * drive the existing upper/lower switchers — writing `state.leftNavSection`
 * directly to force a wide-mode drawer would break the `mode`/`focusedSection`
 * invariant, and `leftNavigationWidthPx` would then push the centre surface by a
 * width that omits the drawer entirely.
 */
export function resolveRailActivation(
  input: LeftNavigationLayout, section: LeftNavigationSection,
): LeftNavigationLayout {
  const layout = normalizeLeftNavigationLayout(input);
  if (layout.mode !== 'rail') return layout;
  return { ...layout, focusedSection: layout.focusedSection === section ? null : section };
}

/**
 * Open a section IDEMPOTENTLY — the deterministic `openFocusedSection(section)`
 * seam #487 requires the left-navigation API to provide for #428.
 *
 * "Deterministic" is the operative word: repeated calls must leave the section
 * open, because the caller is a bounded drag-hover that re-asserts intent rather
 * than a click that expresses a change. Already showing this section returns the
 * layout by identity; wide mode returns unchanged, for the same reason as
 * `resolveRailActivation`.
 */
export function resolveRailOpen(
  input: LeftNavigationLayout, section: LeftNavigationSection,
): LeftNavigationLayout {
  const layout = normalizeLeftNavigationLayout(input);
  if (layout.mode !== 'rail' || layout.focusedSection === section) return layout;
  return { ...layout, focusedSection: section };
}

/**
 * The layout that actually applies at this viewport. Below the mobile breakpoint
 * #487 requires the desktop rail and focused drawer not to render at all, and the
 * established mobile segmented/bottom navigation to stand in — so the effective
 * mode is always the two-pane presentation mobile already styles, with no focused
 * section.
 *
 * The argument is returned UNTOUCHED for desktop, and the mobile branch is a
 * projection, never a write: the persisted `mode` and both widths keep whatever
 * the user last chose, which is what "ignore desktop folding preferences for
 * effective mobile layout; preserve those preferences for the next desktop
 * session" asks for. Phase 3 renders through this rather than reading `mode`
 * directly.
 */
export function effectiveLeftNavigationLayout(
  input: LeftNavigationLayout, isMobile: boolean,
): LeftNavigationLayout {
  const layout = normalizeLeftNavigationLayout(input);
  if (!isMobile) return layout;
  return layout.mode === 'wide' ? layout : { ...layout, mode: 'wide', focusedSection: null };
}

/** The separator's ARIA range: the rail's width is the floor (the navigation can
 *  never be narrower than the mode it folds into) and the wide sidebar's ceiling
 *  is the max, with the live occupied width as `aria-valuenow`.
 *
 *  Both extremes are genuinely reachable — a rail+drawer drag that keeps going
 *  right converts to wide and on to 420 — but the interior is not continuous:
 *  49–179 is no resting width in any mode, because a wide sidebar folds before it
 *  gets there. That gap is inherent to one control spanning two modes rather than
 *  a bug in the range, and phase 3's assistive-technology pass is where the
 *  announcement wording gets judged against it. */
export interface LeftNavigationSeparatorAria {
  readonly valueMin: number;
  readonly valueMax: number;
  readonly valueNow: number;
}

/**
 * `maxNavigationTotalPx` is optional and, when given, tightens `valueMax` to
 * whatever the viewport currently allows — see `clampLeftNavigationToMaximumTotal`
 * below, which computes the layout this ceiling must agree with. Omitted (or a
 * non-finite/non-positive value, which cannot be a real viewport budget), the
 * ceiling is `LEFT_PANEL_MAX_PX` exactly as before phase 3 — this parameter is
 * additive and every existing caller (there is still none in production, but the
 * unit tests below stand in for one) keeps its prior behaviour unconditionally.
 *
 * `valueMax` is floored at `valueMin` (`LEFT_RAIL_PX`) and `valueNow` is
 * clamped into `[valueMin, valueMax]`, so the ARIA invariant `valueMin <=
 * valueNow <= valueMax` holds for ANY budget, including one pathologically
 * below the rail's own width or below the current mode's own floor. #487's
 * planned production UI never reaches that range in practice — see
 * `clampLeftNavigationToMaximumTotal`'s own comment for the arithmetic showing
 * the realistic budget floor sits around 280px, well above every mode's own
 * minimum — so this is defensive robustness on a PUBLIC pure helper rather
 * than a behaviour change for any realistic budget: neither clamp does
 * anything when `maxNavigationTotalPx` is omitted or at least `LEFT_RAIL_PX`.
 */
export function leftNavigationSeparatorAria(
  layout: LeftNavigationLayout, maxNavigationTotalPx?: number,
): LeftNavigationSeparatorAria {
  const valueMin = LEFT_RAIL_PX;
  const uncappedMax = Number.isFinite(maxNavigationTotalPx) && (maxNavigationTotalPx as number) > 0
    ? Math.min(LEFT_PANEL_MAX_PX, maxNavigationTotalPx as number)
    : LEFT_PANEL_MAX_PX;
  const valueMax = Math.max(valueMin, uncappedMax);
  // Normalized, so a caller holding a layout with a non-finite width cannot
  // publish `aria-valuenow="NaN"` to assistive technology; clamped into the
  // final [valueMin, valueMax] range so an occupied width that exceeds a
  // pathologically small budget cannot publish an out-of-range valueNow either.
  const rawValueNow = leftNavigationWidthPx(normalizeLeftNavigationLayout(layout));
  const valueNow = clamp(rawValueNow, valueMin, valueMax);
  return { valueMin, valueMax, valueNow };
}

/**
 * The centre SQL/results surface's documented minimum width. Phase 4's
 * viewport-resize handling subtracts this (plus the resize separator's own
 * width and any docked panel) from the viewport to get the budget it hands to
 * `clampLeftNavigationToMaximumTotal` below — this module does not read the
 * viewport itself, so the constant lives here purely so the UI layer has one
 * source for it rather than a second copy of the number.
 */
export const LEFT_CENTRE_MIN_PX = 480;

/**
 * Shrink `layout`'s CURRENT mode's own panel width so the navigation's total
 * occupied width (`leftNavigationWidthPx`) fits inside `maxNavigationTotalPx`,
 * without ever changing `mode`.
 *
 * This is a narrower job than the mode reducer above. #487 phase 4 is where a
 * viewport too small for the centre surface's own minimum gets to fold a wide
 * sidebar to rail or close an open drawer — a MODE decision, driven by the
 * viewport crossing a breakpoint, not by a pointer or a key. Doing any of that
 * here would duplicate `resolveLeftNavigationDrag`'s job with a second,
 * viewport-shaped entry point, and the two would disagree about hysteresis the
 * first time someone edited only one of them. So this function answers a
 * strictly smaller question — "shrink the width THIS mode already has, inside
 * the band this mode can already legally occupy" — and leaves whether to fold
 * or close entirely to phase 4.
 *
 * That narrower scope is also why a budget below the mode's own floor is
 * "best effort" rather than an error: `wide`'s floor is `LEFT_PANEL_MIN_PX`
 * (180) and a bare `rail`'s occupied width is the fixed `LEFT_RAIL_PX` (48,
 * nothing to shrink), so the only floor this function can be asked to violate
 * is `LEFT_PANEL_MIN_PX` itself — the wide sidebar's floor AND, since #487
 * phase 3's real-browser pass raised the drawer's floor to match (see
 * `clampDrawerWidthPx`), an open drawer's floor too. Returning the floor
 * anyway — rather than throwing, or returning something outside every mode's
 * legal range — keeps the result always renderable; a caller that actually
 * needs the navigation narrower than what a mode CAN render must change the
 * mode, which is phase 4's job, not this function's.
 *
 * In practice that floor path is unreachable above the existing mobile
 * breakpoint, so it is defensive rather than a state phase 4 has to design
 * for today. `MOBILE_BREAKPOINT_PX` (`state.ts`) is 768, the resize separator
 * that will subtract from the viewport is 7px wide (`.col-resize` in
 * `styles.css`), and `LEFT_CENTRE_MIN_PX` above is 480 — so at the smallest
 * viewport this function is ever consulted at (768px wide, the boundary where
 * mobile's own two-pane layout stops standing in), the budget phase 4 would
 * pass is `768 − 480 − 7 = 281`. That clears the wide sidebar's 180 floor with
 * 101px to spare, and clears an open drawer's `281 − LEFT_RAIL_PX(48) = 233`
 * against its own (now identical) 180 floor with 53px to spare — down from the
 * 93px this margin had against the drawer's original 140 floor, but still
 * comfortably positive. Below 768 the mobile layout replaces the rail and
 * drawer entirely (`effectiveLeftNavigationLayout` above), so this function is
 * never consulted there either.
 *
 * `maxNavigationTotalPx` itself is a plain number budget, not a viewport: a
 * non-finite or NEGATIVE value (a corrupt measurement, or a caller that has
 * not measured yet) is treated as "no additional constraint" rather than
 * propagated into a NaN or Infinity output. Zero is not in that list — it is
 * an extreme but legitimate budget, and clamping into either band's own range
 * floors it exactly like any other too-small value.
 */
export function clampLeftNavigationToMaximumTotal(
  layout: LeftNavigationLayout, maxNavigationTotalPx: number,
): LeftNavigationLayout {
  const normalized = normalizeLeftNavigationLayout(layout);
  // Zero is a legitimate (if extreme) budget — clamping into either band's own
  // range floors it correctly. Only a NEGATIVE or non-finite value cannot mean
  // a real width, so those fall back to "no additional constraint" rather than
  // being clamped into a nonsensical floor.
  const budget = Number.isFinite(maxNavigationTotalPx) && maxNavigationTotalPx >= 0
    ? maxNavigationTotalPx
    : Infinity;
  if (normalized.mode === 'wide') {
    // The wide sidebar IS the total, so the budget applies to it directly.
    const maxWideWidthPx = clamp(budget, LEFT_PANEL_MIN_PX, LEFT_PANEL_MAX_PX);
    return normalized.wideWidthPx <= maxWideWidthPx
      ? normalized
      : { ...normalized, wideWidthPx: maxWideWidthPx };
  }
  if (normalized.focusedSection === null) return normalized; // bare rail: fixed width, nothing to shrink.
  // An open drawer sits BESIDE the rail, so its own budget is the total minus
  // the rail — mirroring `resolveLeftNavigationDrag`'s `panelPx` derivation.
  // The floor is LEFT_PANEL_MIN_PX, matching `clampDrawerWidthPx` — NOT
  // LEFT_FOLD_THRESHOLD_PX, which is a fold POINT for the raw drag proposal,
  // not a legal width this clamp should ever produce.
  const maxDrawerWidthPx = clamp(budget - LEFT_RAIL_PX, LEFT_PANEL_MIN_PX, LEFT_WIDE_THRESHOLD_PX);
  return normalized.drawerWidthPx <= maxDrawerWidthPx
    ? normalized
    : { ...normalized, drawerWidthPx: maxDrawerWidthPx };
}

/**
 * A resize SESSION — the drag/keyboard-resize memory phase 3 needs and a plain
 * continuously-advancing width field cannot provide.
 *
 * **Why not just keep overwriting a remembered width on every frame?** That was
 * tried and is exactly the bug this module's own
 * "restore memory is sampling-dependent" test (above) already pins for the OLD
 * design: which width ends up remembered depends on which intermediate pointer
 * samples the browser happened to deliver, because one field was doing duty as
 * both "the width currently on screen" and "the width to restore later". A
 * session separates those two questions by keeping THREE layouts, not one:
 *
 * - `preferredAtStart` — the persisted preference as of when the gesture began.
 *   This is the memory source `commitLeftNavigationResize` reconstructs from,
 *   and it is captured ONCE, so no intermediate frame can overwrite it.
 * - `proposed` — the latest RAW reducer proposal, BEFORE the viewport's
 *   maximum-total clamp runs. This is the OTHER memory source
 *   `commitLeftNavigationResize` reads: comparing the raw proposal against
 *   `preferredAtStart` is what lets a restore command commit the user's actual
 *   remembered width even while a narrow viewport cannot render it in full —
 *   see the bug history below.
 * - `effective` — `proposed` after `clampLeftNavigationToMaximumTotal` has run
 *   against the current viewport budget. This is what gets rendered and
 *   reported as the gesture continues; it is not memory, and
 *   `commitLeftNavigationResize` never reads it for its width decision.
 *
 * **A real bug this shape fixes, not a hypothetical one.** An earlier version
 * of this session compared `effective` against an `effectiveAtStart` snapshot —
 * i.e. two POST-CLAMP layouts — to decide whether a band's width had "changed".
 * That is wrong whenever a restore command (`Home`, `End`, or a bare-rail
 * `ArrowRight`) runs while the clamp is active: starting at a bare rail,
 * `effectiveAtStart.wideWidthPx` passes the dormant preferred width straight
 * through unclamped (there is nothing to clamp — 'wide' is not the rendered
 * mode yet), so it read as the full preference, e.g. 420. `End` then proposed
 * exactly 420 back — correct — but if the viewport only allows 313, `effective`
 * rendered 313, `effective.wideWidthPx (313) !== effectiveAtStart.wideWidthPx
 * (420)` read as true, and the old logic committed 313: a transient,
 * viewport-driven value the user never asked to keep, silently overwriting
 * their real preference. Comparing the RAW `proposed` (420) against
 * `preferredAtStart` (420) instead finds no change, because
 * `clampLeftNavigationToMaximumTotal` never touches `mode` — so `mode`/
 * `focusedSection` read identically off `proposed` or `effective`, and only the
 * WIDTH needs the pre/post-clamp distinction the session now keeps.
 *
 * **`commitLeftNavigationResize`'s table, restated as one rule:** only commit a
 * band's width if that band is the one the session's FINAL `proposed` layout is
 * in, AND its raw proposed width actually differs from `preferredAtStart`'s.
 * Every other case — a dormant band, a fold-through to bare rail, a
 * click-and-release with no movement — preserves `preferredAtStart` for that
 * band UNCONDITIONALLY. Two consequences fall out of that one rule rather than
 * needing their own case:
 *
 * 1. **The dormant-band fix.** A gesture that resizes the drawer and THEN
 *    crosses into wide mode must not commit the drawer's mid-gesture width,
 *    because the drawer is no longer the band the FINAL `proposed` is in —
 *    `drawerChanged` requires `proposed.mode === 'rail'`, which is false once
 *    the session ends at wide, so the drawer memory falls through to
 *    `preferredAtStart.drawerWidthPx` untouched regardless of what the
 *    drawer's transient width was mid-drag.
 * 2. **Preferred wins over a viewport clamp on ANY commit, not only a
 *    fold-through.** Because the comparison is always RAW-proposed vs
 *    preferred, never rendered-effective vs anything, a maximized 420px
 *    preference that a narrow viewport can only render at a clamped 313px
 *    still commits the user's honest 420 whenever the session ends without an
 *    actual new proposal for that band — restoring it in full the next time
 *    there is room, exactly as #487's "a viewport clamp must never downgrade a
 *    stored preference" requires.
 *
 * `Home`/`End`/a bare-rail `ArrowRight` restore need no special case either:
 * they are restore commands, so the RAW `proposed` layout they produce
 * typically already equals `preferredAtStart`'s remembered width for the band
 * they restore, which is exactly the "nothing changed" shape the general rule
 * preserves correctly.
 *
 * `advanceLeftNavigationResize` performs the viewport clamp ITSELF now (taking
 * the raw proposal and the current budget as arguments), rather than asking the
 * caller to clamp first and hand in an already-clamped layout — a future
 * caller (the pointer/keyboard handler a later phase-3 step builds, which does
 * not exist yet) cannot forget the clamp, because it is part of this
 * function's contract rather than caller discipline. The MODE arithmetic
 * itself stays out of this module either way — `advanceLeftNavigationResize`
 * still does not call `resolveLeftNavigationDrag`/`resolveLeftNavigationKey`;
 * the caller runs the proposal through those first, then hands the raw result
 * here alongside the viewport budget. Session bookkeeping and layout
 * arithmetic stay two separate concerns, so the arithmetic keeps its one
 * implementation.
 */
export interface LeftNavigationResizeSession {
  /** The persisted preference as of session start — the memory source every
   *  commit is reconstructed from, band by band. */
  readonly preferredAtStart: LeftNavigationLayout;
  /** The latest RAW reducer proposal, BEFORE the viewport clamp — the other
   *  memory source `commitLeftNavigationResize` reads from. */
  readonly proposed: LeftNavigationLayout;
  /** The latest proposal AFTER the viewport clamp — what is rendered and
   *  reported right now. Never read by the commit decision. */
  readonly effective: LeftNavigationLayout;
}

/** Begin a resize session: `proposed` starts out equal to `preferred` (nothing
 *  has moved yet), and `effective` is `preferred` clamped to the viewport
 *  budget at hand — mirroring what a caller would render before any gesture
 *  begins. */
export function beginLeftNavigationResize(
  preferred: LeftNavigationLayout, maxNavigationTotalPx: number,
): LeftNavigationResizeSession {
  return {
    preferredAtStart: preferred,
    proposed: preferred,
    effective: clampLeftNavigationToMaximumTotal(preferred, maxNavigationTotalPx),
  };
}

/**
 * Advance a session to a new RAW proposal. The caller has already run the
 * layout through `resolveLeftNavigationDrag`/`resolveLeftNavigationKey` to
 * produce `proposedLayout`; this function applies the viewport clamp itself
 * (see this section's block comment for why the clamp lives here rather than
 * in the caller) and records both the raw proposal and its clamped `effective`
 * counterpart. Returns the SAME session when neither changes by reference, so
 * a caller can use identity to skip a repaint exactly as the mode reducers do.
 */
export function advanceLeftNavigationResize(
  session: LeftNavigationResizeSession, proposedLayout: LeftNavigationLayout, maxNavigationTotalPx: number,
): LeftNavigationResizeSession {
  const effective = clampLeftNavigationToMaximumTotal(proposedLayout, maxNavigationTotalPx);
  return proposedLayout === session.proposed && effective === session.effective
    ? session
    : { ...session, proposed: proposedLayout, effective };
}

/**
 * Reconstruct the `LeftNavigationLayout` to persist from a resize session — see
 * this section's block comment above for the rule and why it is shaped this
 * way. `mode` and `focusedSection` always follow wherever the session ended
 * (a legitimate mode transition, not a width memory question) — read off
 * `effective`, since `clampLeftNavigationToMaximumTotal` never changes `mode`,
 * so `effective.mode`/`effective.focusedSection` agree with `proposed`'s
 * exactly. Only the two WIDTHS get the preserve-vs-commit treatment, band by
 * band, and that decision is made against the RAW `proposed` width, never
 * `effective`'s — the fix this function exists for.
 */
export function commitLeftNavigationResize(session: LeftNavigationResizeSession): LeftNavigationLayout {
  const { preferredAtStart, proposed, effective } = session;
  const wideChanged = proposed.mode === 'wide' && proposed.wideWidthPx !== preferredAtStart.wideWidthPx;
  const drawerChanged = proposed.mode === 'rail' && proposed.focusedSection !== null
    && proposed.drawerWidthPx !== preferredAtStart.drawerWidthPx;
  return normalizeLeftNavigationLayout({
    mode: effective.mode,
    focusedSection: effective.focusedSection,
    wideWidthPx: wideChanged ? proposed.wideWidthPx : preferredAtStart.wideWidthPx,
    drawerWidthPx: drawerChanged ? proposed.drawerWidthPx : preferredAtStart.drawerWidthPx,
  });
}
