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
//   - `columns-2` / `columns-3`: one more column per press, wrapping at the
//     preview's own column count. The caller owns this session-local span map;
//     no command or persisted flow placement is involved.
//   - `grid`: the authored 12-column surface doubles span on each press and
//     wraps to 1 at the maximum. Height is always resent unchanged because a
//     placement write replaces the complete Grid placement object.
//   - `report` and `full` have exactly one column each, so there is no width to
//     step through and the action does not exist. `full` additionally never
//     persists tile widths at all (#321).
//
// Pure — no DOM, no persistence. The caller feeds the tile's PERSISTED placement
// (`layout.items[tileId]`, never a render-mode-overridden effective span) and
// dispatches the result as an `update-placement` command, which re-validates it
// through the active engine's own plugin.

import {
  GRAFANA_GRID_MAX_COLUMNS, resolveGridPlacement,
} from '../layouts/grafana-grid-layout.js';
import { presetColumns, resolvePlacement } from '../layouts/flow-layout.js';
import type { DashboardStyle } from './dashboard-viewer-session.js';

/** The styles that expose a widen step: every multi-column one. */
const WIDENABLE: ReadonlySet<string> = new Set(['columns-2', 'columns-3', 'grid']);

/** Whether the active style has more than one column to step through. `report`
 *  and `full` are single-column by definition, so they carry no widen action. */
export function canWidenPanel(style: DashboardStyle): boolean {
  return WIDENABLE.has(style);
}

/** The widest this style can render one tile: the grid's 12 columns, or the flow
 *  preset's own column count. Never called for a non-widenable style. */
function maxSpan(style: DashboardStyle): number {
  return style === 'grid' ? GRAFANA_GRID_MAX_COLUMNS : presetColumns(style);
}

/**
 * The placement ONE widen press produces, as an `update-placement` payload for
 * the active engine.
 *
 * At the maximum the cycle wraps to a single column. Height is preserved.
 */
export function nextPanelPlacement(
  input: { style: DashboardStyle; placement: unknown },
): Record<string, unknown> {
  const { style, placement } = input;
  const max = maxSpan(style);
  if (style === 'grid') {
    const { span, height } = resolveGridPlacement(placement);
    return { span: span >= max ? 1 : Math.min(max, span * 2), height };
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
  const span = style === 'grid'
    ? resolveGridPlacement(placement).span : resolvePlacement(placement).span;
  if (span >= max) return 'Shrink to 1 column';
  // Always ≥ 2: `span >= 1` and the maximum is at least 2 for every widenable
  // style, so there is no "widen to 1 column" wording to spell out.
  const next = style === 'grid' ? Math.min(max, span * 2) : span + 1;
  return 'Widen to ' + next + ' columns';
}
