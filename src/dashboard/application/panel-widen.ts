// The Dashboard tile's one-press WIDEN step (#535).
//
// #280 phase 8 moved span/height authoring into the saved-query Spec editor and
// removed the in-tile size buttons. Width is the one adjustment users make
// constantly, and a JSON editor is the wrong place for it, so the ONE step this
// module defines comes back to the tile head — reading only, and never anything
// two-dimensional: the corner drag (#291) stays the free-form resize.
//
// The step is a CYCLE, not a monotonic grow. A button that dead-ends at the
// maximum is a button whose next press does nothing, so the press after the
// widest one returns the tile to a single column. That is also what makes the
// action reachable with one hand on a keyboard: every reachable width is on the
// same key.
//
// Which widths exist is the ACTIVE STYLE's business, not the tile's:
//
//   - `columns-2` / `columns-3` (flow@1): one more column per press, wrapping at
//     the preset's own column count. Height is untouched — flow's `height` is a
//     three-value enum the flow renderer never applies as pixels anyway
//     (`ui/dashboard.ts` clears the inline height for flow rows).
//   - `grafana-grid` in `tiles` mode: the grid is a 12-column surface with
//     numeric row-unit heights, so "one more column" is far too small a step.
//     Both dimensions DOUBLE (owner decision), each clamped to its own maximum,
//     and the wrap resets to a single column at the grid's default height.
//   - `report` and `full` have exactly one column each, so there is no width to
//     step through and the action does not exist. `full` additionally never
//     persists tile widths at all (#321).
//
// Pure — no DOM, no persistence. The caller feeds the tile's PERSISTED placement
// (`layout.items[tileId]`, never a render-mode-overridden effective span) and
// dispatches the result as an `update-placement` command, which re-validates it
// through the active engine's own plugin.

import {
  DEFAULT_GRID_HEIGHT_UNITS, GRAFANA_GRID_MAX_COLUMNS, GRID_HEIGHT_UNIT_MAX, resolveGridPlacement,
} from '../layouts/grafana-grid-layout.js';
import { presetColumns, resolvePlacement } from '../layouts/flow-layout.js';
import type { DashboardStyle } from './dashboard-viewer-session.js';

/** The styles that expose a widen step: every multi-column one. */
const WIDENABLE: ReadonlySet<string> = new Set(['columns-2', 'columns-3', 'grafana-grid']);

/** Whether the active style has more than one column to step through. `report`
 *  and `full` are single-column by definition, so they carry no widen action. */
export function canWidenPanel(style: DashboardStyle): boolean {
  return WIDENABLE.has(style);
}

/** The widest this style can render one tile: the grid's 12 columns, or the flow
 *  preset's own column count. Never called for a non-widenable style. */
function maxSpan(style: DashboardStyle): number {
  return style === 'grafana-grid' ? GRAFANA_GRID_MAX_COLUMNS : presetColumns(style);
}

/**
 * The placement ONE widen press produces, as an `update-placement` payload for
 * the active engine.
 *
 * At the maximum the cycle wraps to a single column — for grid that also returns
 * the height to the engine default, because a wrapped tile that kept a doubled
 * height would be a one-column tile four rows tall, which is not a state any
 * press asked for.
 */
export function nextPanelPlacement(
  input: { style: DashboardStyle; placement: unknown },
): Record<string, unknown> {
  const { style, placement } = input;
  const max = maxSpan(style);
  if (style === 'grafana-grid') {
    const { span, height } = resolveGridPlacement(placement);
    if (span >= max) return { span: 1, height: DEFAULT_GRID_HEIGHT_UNITS };
    return { span: Math.min(max, span * 2), height: Math.min(GRID_HEIGHT_UNIT_MAX, height * 2) };
  }
  const { span, height } = resolvePlacement(placement);
  return { span: span >= max ? 1 : span + 1, height };
}

/**
 * The button's title and accessible name for its CURRENT state.
 *
 * The label names the destination rather than the action, because the action
 * reverses at the maximum: "Widen" on a tile that is about to shrink would be a
 * lie, and the tile's own width is the only clue the user has about which press
 * they are on.
 */
export function widenLabel(input: { style: DashboardStyle; placement: unknown }): string {
  const { style, placement } = input;
  const max = maxSpan(style);
  const span = style === 'grafana-grid'
    ? resolveGridPlacement(placement).span : resolvePlacement(placement).span;
  if (span >= max) return 'Shrink to 1 column';
  // Always ≥ 2: `span >= 1` and the maximum is at least 2 for every widenable
  // style, so there is no "widen to 1 column" wording to spell out.
  const next = style === 'grafana-grid' ? Math.min(max, span * 2) : span + 1;
  return 'Widen to ' + next + ' columns';
}
