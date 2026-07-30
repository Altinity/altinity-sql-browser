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

/**
 * `maxNavigationTotalPx` is optional and, when given, tightens `valueMax` to
 * whatever the viewport currently allows — see `clampLeftNavigationToMaximumTotal`
 * below, which computes the layout this ceiling must agree with. Omitted (or a
 * non-finite/non-positive value, which cannot be a real viewport budget), the
 * ceiling is `LEFT_PANEL_MAX_PX` exactly as before phase 3 — this parameter is
 * additive and every existing caller (there is still none in production, but the
 * unit tests below stand in for one) keeps its prior behaviour unconditionally.
 */
export function leftNavigationSeparatorAria(
  layout: LeftNavigationLayout, maxNavigationTotalPx?: number,
): LeftNavigationSeparatorAria {
  const valueMax = Number.isFinite(maxNavigationTotalPx) && (maxNavigationTotalPx as number) > 0
    ? Math.min(LEFT_PANEL_MAX_PX, maxNavigationTotalPx as number)
    : LEFT_PANEL_MAX_PX;
  return {
    valueMin: LEFT_RAIL_PX,
    valueMax,
    // Normalized, so a caller holding a layout with a non-finite width cannot
    // publish `aria-valuenow="NaN"` to assistive technology.
    valueNow: leftNavigationWidthPx(normalizeLeftNavigationLayout(layout)),
  };
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
 * is the wide sidebar's 180 or an open drawer's 140. Returning the floor
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
 * against its 140 floor with 93px to spare. Below 768 the mobile layout
 * replaces the rail and drawer entirely (`effectiveLeftNavigationLayout`
 * above), so this function is never consulted there either.
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
  const maxDrawerWidthPx = clamp(budget - LEFT_RAIL_PX, LEFT_FOLD_THRESHOLD_PX, LEFT_WIDE_THRESHOLD_PX);
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
 * - `effectiveAtStart` — what was actually rendered when the gesture began,
 *   i.e. `preferredAtStart` after `clampLeftNavigationToMaximumTotal` ran
 *   against whatever the viewport allowed at that moment. This can differ from
 *   `preferredAtStart` — a maximized preference squeezed by a narrow window —
 *   and the gap between the two is precisely what lets the commit step tell
 *   "the user actually resized this band" apart from "the band was just
 *   rendered smaller than preferred by an unrelated viewport constraint".
 * - `effective` — the live, post-clamp layout, replaced wholesale on every
 *   `advanceLeftNavigationResize` call. This is what gets rendered and reported
 *   as the gesture continues; it is not memory.
 *
 * **`commitLeftNavigationResize`'s table, restated as one rule:** only commit a
 * band's width if that band is the one `effective` currently renders AND its
 * rendered width actually differs from `effectiveAtStart`'s. Every other case —
 * a dormant band, a fold-through to bare rail, a click-and-release with no
 * movement — preserves `preferredAtStart` for that band UNCONDITIONALLY. Two
 * consequences fall out of that one rule rather than needing their own case:
 *
 * 1. **The dormant-band fix.** A gesture that resizes the drawer and THEN
 *    crosses into wide mode must not commit the drawer's mid-gesture width,
 *    because the drawer is no longer the band `effective` renders once the
 *    session ends — `drawerChanged` requires `effective.mode === 'rail'`, which
 *    is false at wide, so the drawer memory falls through to
 *    `preferredAtStart.drawerWidthPx` untouched. Without that mode guard, a
 *    drag that opened the drawer to 300 before continuing on to a 350px wide
 *    sidebar would silently overwrite the drawer's remembered width with a
 *    value the user never asked to keep.
 * 2. **Preferred wins over effective on a fold-through.** Ending at bare rail
 *    preserves BOTH widths from `preferredAtStart`, never from `effectiveAtStart`
 *    or `effective` — so a maximized 420px preference that a narrow viewport
 *    rendered at a clamped 313px, then folded to rail by the same gesture,
 *    still remembers 420 for the next `End`/restore. Committing `313` instead
 *    would silently downgrade a preference the user never touched, purely
 *    because the viewport happened to be narrow during an unrelated fold.
 *
 * `Home`/`End`/a bare-rail `ArrowRight` restore need no special case either:
 * they are restore commands, so the `effective` layout they produce typically
 * already equals `preferredAtStart`'s remembered width for the band they
 * restore, which is exactly the "nothing changed" shape the general rule
 * preserves correctly.
 *
 * A session is deliberately NOT a reducer step in `resolveLeftNavigationDrag`'s
 * family — `advanceLeftNavigationResize` does not call the mode reducer or the
 * maximum-total clamp itself. The caller runs those first to produce the next
 * `effective` layout (a pointer/keyboard event resolves through the existing
 * reducers, then `clampLeftNavigationToMaximumTotal` fits it to the viewport),
 * and only then advances the session with the result. Session bookkeeping and
 * layout arithmetic stay two separate concerns, so the arithmetic keeps its
 * one implementation.
 */
export interface LeftNavigationResizeSession {
  /** The persisted preference as of session start — the memory source every
   *  commit is reconstructed from, band by band. */
  readonly preferredAtStart: LeftNavigationLayout;
  /** What was actually rendered when the session began, i.e.
   *  `preferredAtStart` after the viewport's maximum-total clamp. */
  readonly effectiveAtStart: LeftNavigationLayout;
  /** The live, post-clamp layout — what is rendered and reported right now. */
  readonly effective: LeftNavigationLayout;
}

/** Begin a resize session: `effective` starts out equal to `effectiveAtStart`,
 *  since nothing has moved yet. */
export function beginLeftNavigationResize(
  preferred: LeftNavigationLayout, effective: LeftNavigationLayout,
): LeftNavigationResizeSession {
  return { preferredAtStart: preferred, effectiveAtStart: effective, effective };
}

/**
 * Advance a session to a new live layout. Pure snapshot replacement — the
 * caller has already run the layout through `resolveLeftNavigationDrag` /
 * `resolveLeftNavigationKey` and `clampLeftNavigationToMaximumTotal` to produce
 * `nextEffectiveLayout`; this function does not call either. Returns the SAME
 * session when the layout is unchanged by reference, so a caller can use
 * identity to skip a repaint exactly as the mode reducers do.
 */
export function advanceLeftNavigationResize(
  session: LeftNavigationResizeSession, nextEffectiveLayout: LeftNavigationLayout,
): LeftNavigationResizeSession {
  return nextEffectiveLayout === session.effective
    ? session
    : { ...session, effective: nextEffectiveLayout };
}

/**
 * Reconstruct the `LeftNavigationLayout` to persist from a resize session — see
 * this section's block comment above for the rule and why it is shaped this
 * way. `mode` and `focusedSection` always follow wherever the session ended
 * (a legitimate mode transition, not a width memory question); only the two
 * WIDTHS get the preserve-vs-commit treatment, band by band.
 */
export function commitLeftNavigationResize(session: LeftNavigationResizeSession): LeftNavigationLayout {
  const { preferredAtStart, effectiveAtStart, effective } = session;
  const wideChanged = effective.mode === 'wide' && effective.wideWidthPx !== effectiveAtStart.wideWidthPx;
  const drawerChanged = effective.mode === 'rail' && effective.focusedSection !== null
    && effective.drawerWidthPx !== effectiveAtStart.drawerWidthPx;
  return normalizeLeftNavigationLayout({
    mode: effective.mode,
    focusedSection: effective.focusedSection,
    wideWidthPx: wideChanged ? effective.wideWidthPx : preferredAtStart.wideWidthPx,
    drawerWidthPx: drawerChanged ? effective.drawerWidthPx : preferredAtStart.drawerWidthPx,
  });
}
