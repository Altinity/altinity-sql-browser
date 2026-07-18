// The grafana-grid@1 layout plugin (#291): a second Dashboard layout engine,
// sibling to flow@1 (flow-layout.ts). Same `DashboardLayoutPlugin` contract
// (`normalize`, `validatePlacement`) plus its own pure render math. Pure — no
// DOM, no globals; the DOM reconciliation (Wave 3) is a separate module.
//
// Design choices this module makes (owner decisions round, #291 plan):
// - Rowless: unlike flow@1's row-major `FlowRow[]`, grafana-grid@1 lays every
//   visible tile directly onto a single flat 12-column grid, in canonical
//   `dashboard.tiles[]` order — no row grouping type at all (`FlowRow` is
//   deliberately NOT reused/widened). `computeGrafanaGridLayout` still runs a
//   real, pure, deterministic packing simulation (row/colStart per tile) so
//   the model is testable and usable by a non-CSS-grid consumer (print/export,
//   a future canvas renderer) without depending on the browser's own grid
//   auto-placement to reproduce identical wrapping.
// - KPI tiles get no special banding (no "kpi-band" concept exists in a
//   rowless grid): a KPI tile is placed exactly like any other tile, using
//   its own `{span, height}` placement, in canonical order. `isKpi` is
//   carried through to the render model only so a renderer can still style a
//   KPI tile differently (chrome, not placement).
// - Heights reuse flow@1's `compact|medium|large` vocabulary verbatim, not a
//   new scale (the `dashboard-layout-grafana-grid-v1.schema.json` defs use
//   the same values; the generated `GrafanaGridHeightV1` type is structurally
//   identical to `FlowHeightV1`).
// - `deriveGrafanaGridPlacement` reuses flow's own `sizeHints` → span mapping
//   (`deriveFlowPlacement`) and then converts through `gridSpanFromFlowSpan`,
//   rather than duplicating the sizeHints interpretation.
// - `deriveFlowFallback` ALWAYS resolves every known tile's EFFECTIVE grid
//   placement (via `resolveGridPlacement`, which fills in the grid default
//   span 6/medium when a tile has no persisted grid item) before converting
//   to a flow item. This is a deliberate choice over "skip tiles with no
//   persisted grid placement" (which would let them fall through to flow's
//   OWN different default, span 1): every grid mutation regenerates a fully
//   explicit, deterministic flow@1 fallback for every tile, so a default-sized
//   grid tile (span 6) maps to its flow equivalent (span 2), not flow's own
//   unrelated default.

import { diagnostic } from '../model/workspace-diagnostics.js';
import type { WorkspaceDiagnostic } from '../model/workspace-diagnostics.js';
import { cloneJson } from '../../core/saved-query.js';
import { deriveFlowPlacement } from './flow-layout.js';
import type { DashboardLayoutPlugin } from './flow-layout.js';
import type {
  DashboardDocumentV1, FlowLayoutV1, FlowTilePlacementV1,
  GrafanaGridHeightV1, GrafanaGridTilePlacementV1,
} from '../../generated/json-schema.types.js';

type Path = (string | number)[];

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const VALID_HEIGHTS = new Set<unknown>(['compact', 'medium', 'large']);
const PLACEMENT_FIELDS = new Set(['span', 'height']);

/** The maximum column count grafana-grid@1 ever resolves to (its widest
 *  responsive breakpoint, ≥1160px container width). */
export const GRAFANA_GRID_MAX_COLUMNS = 12;

const isValidGridSpan = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= GRAFANA_GRID_MAX_COLUMNS;

/** The grafana-grid@1 default placement (#291): span 6 (half the 12-column
 *  grid), medium height — matching flow@1's default height. */
export const DEFAULT_GRID_PLACEMENT: Required<GrafanaGridTilePlacementV1> = { span: 6, height: 'medium' };

/** The object holding the active grid placements — the primary layout's
 *  `items` (grafana-grid@1 is never a fallback target, so there is no
 *  fallback-surface duck-typing here unlike flow's `flowItemsHost`). */
function gridItemsHost(layout: unknown): Record<string, unknown> | null {
  if (!isObject(layout)) return null;
  if (!isObject(layout.items)) { layout.items = {}; }
  return layout.items as Record<string, unknown>;
}

/** Set one tile's grid placement on a layout document (mutates in place).
 *  No-op when the layout is not an object. */
export function setGridPlacement(layout: unknown, tileId: string, placement: unknown): void {
  const items = gridItemsHost(layout);
  if (items) items[tileId] = placement;
}

/** Derive an initial grid placement from a query's `sizeHints.preferred`,
 *  reusing flow@1's own `compact|medium|wide` → span mapping
 *  (`deriveFlowPlacement`) and converting the result through
 *  `gridSpanFromFlowSpan`. Always returns a complete placement — grafana-grid
 *  has an explicit default (span 6, medium) rather than flow's "no opinion"
 *  `undefined`. */
export function deriveGrafanaGridPlacement(sizeHints: unknown): Required<GrafanaGridTilePlacementV1> {
  const flowPlacement = deriveFlowPlacement(sizeHints);
  if (!flowPlacement || flowPlacement.span === undefined) return { ...DEFAULT_GRID_PLACEMENT };
  // `deriveFlowPlacement`'s own contract: whenever it returns a placement
  // (span defined), height is always set too (it never returns a bare span).
  return { span: gridSpanFromFlowSpan(flowPlacement.span), height: flowPlacement.height! };
}

const GRID_SPAN_FROM_FLOW_SPAN: Record<1 | 2 | 3, 4 | 6 | 12> = { 1: 4, 2: 6, 3: 12 };

/** flow span (1|2|3) → grid span (4|6|12), used when seeding a grid layout
 *  from an existing flow placement (flow→grid engine switch). */
export function gridSpanFromFlowSpan(flowSpan: 1 | 2 | 3): 4 | 6 | 12 {
  return GRID_SPAN_FROM_FLOW_SPAN[flowSpan];
}

/** grid span (1..12) → flow span (1|2|3): 1-4→1, 5-8→2, 9-12→3. Used to
 *  regenerate the flow@1 fallback on every grid mutation. An invalid/missing
 *  grid span is treated as the grid default (6), which maps to flow span 2. */
export function flowSpanFromGridSpan(gridSpan: unknown): 1 | 2 | 3 {
  const span = isValidGridSpan(gridSpan) ? gridSpan : DEFAULT_GRID_PLACEMENT.span;
  return span <= 4 ? 1 : span <= 8 ? 2 : 3;
}

/** Merge one stored grid placement with `DEFAULT_GRID_PLACEMENT`: a
 *  missing/invalid span or height falls back to the default, so the result is
 *  always a complete `{span, height}` (mirrors flow's `resolvePlacement`). */
export function resolveGridPlacement(placement: unknown): Required<GrafanaGridTilePlacementV1> {
  const p = isObject(placement) ? placement : {};
  return {
    span: isValidGridSpan(p.span) ? (p.span as number) : DEFAULT_GRID_PLACEMENT.span,
    height: VALID_HEIGHTS.has(p.height) ? (p.height as GrafanaGridHeightV1) : DEFAULT_GRID_PLACEMENT.height,
  };
}

function normalize(dashboard: DashboardDocumentV1): DashboardDocumentV1 {
  const next = cloneJson(dashboard);
  const tileIds = new Set<string>();
  for (const tile of Array.isArray(next.tiles) ? next.tiles : []) {
    if (isObject(tile) && typeof tile.id === 'string') tileIds.add(tile.id);
  }
  const items = gridItemsHost(next.layout);
  if (items) {
    for (const key of Object.keys(items)) {
      if (!tileIds.has(key)) delete items[key];
    }
  }
  return next;
}

function validatePlacement(placement: unknown, path: Path = []): WorkspaceDiagnostic[] {
  if (!isObject(placement)) {
    return [diagnostic(path, 'layout-placement-invalid', 'Placement must be an object')];
  }
  const out: WorkspaceDiagnostic[] = [];
  for (const key of Object.keys(placement)) {
    if (!PLACEMENT_FIELDS.has(key)) {
      out.push(diagnostic([...path, key], 'layout-placement-unknown-field',
        `Unknown grafana-grid placement field ${JSON.stringify(key)}`));
    }
  }
  if (Object.hasOwn(placement, 'span') && !isValidGridSpan(placement.span)) {
    out.push(diagnostic([...path, 'span'], 'layout-placement-invalid-span',
      'Grafana-grid placement span must be an integer from 1 to 12'));
  }
  if (Object.hasOwn(placement, 'height') && !VALID_HEIGHTS.has(placement.height)) {
    out.push(diagnostic([...path, 'height'], 'layout-placement-invalid-height',
      'Grafana-grid placement height must be compact, medium, or large'));
  }
  return out;
}

/** The single grafana-grid@1 plugin instance (stateless; safe to share). */
export const grafanaGridLayoutPlugin: DashboardLayoutPlugin = {
  type: 'grafana-grid', version: 1, normalize, validatePlacement,
};

// ── Pure render math: rowless packing (#291) ────────────────────────────────

/** Effective column count for a container width (#291 "Responsive clamp"):
 *  ≥1160px→12, ≥720px→6, ≥470px→4, else→2. An absent/non-finite width
 *  defaults to the widest desktop breakpoint (12) — the useful default for
 *  tests and non-DOM consumers (print/export) where no measured width exists. */
export function effectiveGridColumns(containerWidth?: unknown): number {
  const width = typeof containerWidth === 'number' && Number.isFinite(containerWidth) ? containerWidth : Infinity;
  if (width >= 1160) return 12;
  if (width >= 720) return 6;
  if (width >= 470) return 4;
  return 2;
}

/** The effective span for one tile: `min(storedSpan ?? default, columns)`.
 *  An invalid/missing stored span is treated as the grid default (6); the
 *  persisted span itself is never mutated (mirrors flow's `effectiveSpan`). */
export function effectiveGridSpan(storedSpan: unknown, columns: number): number {
  const span = isValidGridSpan(storedSpan) ? storedSpan : DEFAULT_GRID_PLACEMENT.span;
  return Math.min(span, Math.max(1, columns));
}

/** One tile as placed for one render pass — a flat position in a single
 *  grid, NOT a row-grouped `FlowRow` (#291 "rowless"). `row`/`colStart` are a
 *  real deterministic packing simulation (row-major, wraps when the next
 *  tile's span does not fit in the remaining columns), independent of
 *  whatever grid-auto-placement a DOM renderer may additionally rely on. */
export interface GrafanaGridTileRender {
  tileId: string;
  index: number;
  span: number;
  height: GrafanaGridHeightV1;
  isKpi: boolean;
  row: number;
  colStart: number;
}

/** The computed grafana-grid@1 render model: a single flat grid, no rows
 *  type, tagged with `engine` so a caller can discriminate it against a flow
 *  `FlowLayoutModel` without either type needing to know about the other. */
export interface GrafanaGridLayoutModel {
  engine: 'grafana-grid';
  /** Effective columns for the given container width. */
  columns: number;
  /** Every visible tile, positioned, in `dashboard.tiles[]` semantic order. */
  tiles: GrafanaGridTileRender[];
  /** Visible tile IDs in semantic order (parity with flow's `order`). */
  order: string[];
}

/** One visible tile the grid lays out, in `dashboard.tiles[]` semantic order.
 *  `isKpi` marks an explicitly-configured KPI panel (chrome only — grafana-
 *  grid@1 has no KPI band). */
export interface GrafanaGridVisibleTile {
  id: string;
  isKpi?: boolean;
}

export interface ComputeGrafanaGridLayoutInput {
  tiles: readonly GrafanaGridVisibleTile[];
  /** The grafana-grid layout document (or any object whose `items` holds
   *  grid placements); tolerated when absent/non-object (every tile then
   *  renders at the grid default). */
  layout: unknown;
  /** The rendering container's width in px; see `effectiveGridColumns`. */
  containerWidth?: number;
}

function gridItemsFor(layout: unknown): Record<string, unknown> {
  return isObject(layout) && isObject(layout.items) ? (layout.items as Record<string, unknown>) : {};
}

/**
 * Compute the deterministic grafana-grid@1 render model (#291): a single
 * flat 12-(or fewer-)column grid, tiles placed in `dashboard.tiles[]` order.
 * Row-major packing: place each tile's effective span in the current row
 * when it fits, else wrap to a new row — tiles never overlap, and there is
 * no row-grouping type, band, or fold (rowless). Pure and non-mutating.
 */
export function computeGrafanaGridLayout(input: ComputeGrafanaGridLayoutInput): GrafanaGridLayoutModel {
  const { tiles, layout, containerWidth } = input;
  const columns = effectiveGridColumns(containerWidth);
  const items = gridItemsFor(layout);

  let row = 0;
  let cursor = 0;
  const renders: GrafanaGridTileRender[] = tiles.map((tile, index) => {
    const placement = resolveGridPlacement(items[tile.id]);
    const span = effectiveGridSpan(placement.span, columns);
    if (cursor + span > columns) {
      row += 1;
      cursor = 0;
    }
    const render: GrafanaGridTileRender = {
      tileId: tile.id, index, span, height: placement.height, isKpi: !!tile.isKpi, row, colStart: cursor,
    };
    cursor += span;
    return render;
  });

  return { engine: 'grafana-grid', columns, tiles: renders, order: tiles.map((tile) => tile.id) };
}

// ── Engine conversion: grid → flow fallback (#291) ──────────────────────────

/** One tile grafana-grid@1 needs only the stable ID of, to regenerate a
 *  flow@1 fallback for it. */
export interface GrafanaGridFallbackTile {
  id: string;
}

/**
 * Derive a complete, valid flow@1 layout document from a grafana-grid@1
 * layout, for use as the Dashboard's `fallback` (#291: "every grid mutation
 * regenerates the flow@1 fallback deterministically"). Every known tile gets
 * an explicit flow item — even one with no persisted grid placement, which
 * resolves to the grid default (span 6) and maps to its flow equivalent
 * (span 2), rather than silently falling through to flow's own unrelated
 * default (span 1). `full-width` is the fallback preset: the closest single-
 * column analog to a rowless grid with no fixed column count.
 */
export function deriveFlowFallback(
  gridLayout: unknown, tiles: readonly GrafanaGridFallbackTile[],
): FlowLayoutV1 {
  const items = gridItemsFor(gridLayout);
  const flowItems: Record<string, FlowTilePlacementV1> = {};
  for (const tile of tiles) {
    const gridPlacement = resolveGridPlacement(items[tile.id]);
    flowItems[tile.id] = { span: flowSpanFromGridSpan(gridPlacement.span), height: gridPlacement.height };
  }
  return { type: 'flow', version: 1, preset: 'full-width', items: flowItems };
}
