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
 *  sidebar-width preference range"). These do NOT bound the focused drawer; see
 *  `clampDrawerWidthPx`. */
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
 * So the vocabularies genuinely differ, and phase 2's navigation section registry
 * owns the mapping in exactly one place — `'library' ↔ 'saved'`, with the other
 * three sections identical. That mapping is deliberately NOT written here yet: it
 * has no caller until the registry exists, and a second copy of it is precisely
 * the duplication phase 2 is meant to prevent.
 */
export type LeftNavigationSection = 'databases' | 'dashboards' | 'library' | 'history';

/** Rail order, top to bottom — the order #487's section table lists, and the
 *  same order the existing wide switchers present (Databases | Dashboards above,
 *  Library | History below). */
export const LEFT_NAV_SECTIONS: readonly LeftNavigationSection[] =
  ['databases', 'dashboards', 'library', 'history'];

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
 * Clamp a focused-drawer width into `[LEFT_FOLD_THRESHOLD_PX,
 * LEFT_WIDE_THRESHOLD_PX]` — the drawer's own band, NOT the wide sidebar's
 * `[MIN, MAX]`.
 *
 * That is a reading of #487's drawer-resize rules rather than of its constant
 * list: a drawer drag must fold closed below the fold threshold and convert to
 * the wide sidebar above the wide threshold, so everything in between is the
 * only width a drawer can hold. Giving the drawer the wide sidebar's 180 floor
 * and 420 ceiling would make most of that range unreachable — the drag would
 * have converted to wide long before 420. `MIN`/`MAX` govern the wide sidebar.
 */
export function clampDrawerWidthPx(px: number): number {
  if (Number.isNaN(px)) return LEFT_DRAWER_DEFAULT_PX;
  return clamp(px, LEFT_FOLD_THRESHOLD_PX, LEFT_WIDE_THRESHOLD_PX);
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
 * both bands are bounded by a dead zone wider than one step, so a purely relative
 * arrow gets stranded at a boundary forever.
 *
 * Both ends had that failure, and they are exact mirrors:
 *
 * - a bare rail is 48px wide and the nearest legal wide width is 180, so a +16
 *   step proposes 64, lands in the sticky band and does nothing;
 * - a wide sidebar at its 180 floor folds only below 140, so a −16 step proposes
 *   164, clamps straight back to 180 and does nothing.
 *
 * A *pointer* escapes both because `clientX` is absolute — it keeps travelling
 * until it crosses the threshold — so leaving them relative made the keyboard and
 * pointer disagree over a *sequence* even while agreeing on every single step.
 * Eleven ArrowLeft presses from a 300px sidebar used to sit at 180 forever while
 * the equivalent pointer path folded, with `aria-valuemin: 48` advertised
 * throughout. `Home`/`Shift+Arrow` escaping is not a defence: the W3C splitter
 * pattern makes plain Left/Right the separator's move keys.
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
  // A wide sidebar already at its floor: leftward is the fold transition. An open
  // drawer needs no equivalent — its own floor IS the fold threshold, so an
  // ordinary step below it already closes it.
  if (layout.mode === 'wide' && !towardWide && layout.wideWidthPx <= LEFT_PANEL_MIN_PX) {
    return foldToRail(layout);
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

export function leftNavigationSeparatorAria(layout: LeftNavigationLayout): LeftNavigationSeparatorAria {
  return {
    valueMin: LEFT_RAIL_PX,
    valueMax: LEFT_PANEL_MAX_PX,
    // Normalized, so a caller holding a layout with a non-finite width cannot
    // publish `aria-valuenow="NaN"` to assistive technology.
    valueNow: leftNavigationWidthPx(normalizeLeftNavigationLayout(layout)),
  };
}
