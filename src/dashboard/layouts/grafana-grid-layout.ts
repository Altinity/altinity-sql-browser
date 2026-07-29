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
// - Heights are NUMERIC ROW UNITS, 1..16 (#291 height-units follow-up, owner
//   override): `px = 32 + 88*units` is the one canonical formula every
//   height→px conversion in this module and the renderer uses — units 1/2/3
//   land close to the legacy compact/medium/large tiers (120/208/296px vs the
//   old fixed 118/210/296, "close enough" per the owner decision, not required
//   to be exact) and unit 16 reaches 1440px, ~5x the old 296px max. The legacy
//   `compact|medium|large` strings stay valid on read (schema `anyOf`) for
//   backward compatibility with already-persisted documents; `normalize`
//   canonicalizes them to 1/2/3 so persisted docs converge to numeric, and
//   every OTHER function in this module (`resolveGridPlacement`,
//   `deriveGrafanaGridPlacement`, `deriveFlowFallback`, `snapGridHeight`,
//   `computeGrafanaGridLayout`) works with the canonical numeric form only —
//   the legacy string is never produced, only ever accepted as input.
// - `gridHeightUnitsFromFlowHeight`/`gridHeightUnitsToFlowHeight` are the
//   grid-units ↔ flow-height conversion pair (mirroring
//   `gridSpanFromFlowSpan`/`flowSpanFromGridSpan` for span): flow's OWN height
//   vocabulary (`compact|medium|large`) is untouched by this change — only the
//   grid engine's own persisted `height` moved to numeric units. The mapping
//   is deliberately not symmetric (3 flow values, 16 grid units): units 1→
//   compact, 2→medium, ≥3→large going grid→flow, so every unit above 3 still
//   maps somewhere sensible in the fallback instead of only unit 3 being valid.
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
  DashboardDocumentV2, FlowHeightV1, FlowLayoutV1, FlowTilePlacementV1,
  GrafanaGridHeightV1, GrafanaGridLayoutV2,
} from '../../generated/json-schema.types.js';

type Path = (string | number)[];

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const PLACEMENT_FIELDS = new Set(['span', 'height']);

/** The maximum column count grafana-grid@1 ever resolves to (its widest
 *  responsive breakpoint, ≥1160px container width). */
export const GRAFANA_GRID_MAX_COLUMNS = 12;

const isValidGridSpan = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= GRAFANA_GRID_MAX_COLUMNS;

// ── Height as numeric row units (#291 height-units follow-up) ──────────────

/** The valid numeric row-unit range for a grid tile's height. */
export const GRID_HEIGHT_UNIT_MIN = 1;
export const GRID_HEIGHT_UNIT_MAX = 16;

/** The canonical units→px formula, the ONE source of truth for every
 *  height→pixel conversion (the renderer's inline height, and the fixed
 *  point `snapGridHeight` is built around): `px = 32 + 88*units`. */
export const GRID_HEIGHT_PX_BASE = 32;
export const GRID_HEIGHT_PX_PER_UNIT = 88;

/** The grid default height, in row units — the numeric equivalent of the
 *  legacy "medium" tier. */
export const DEFAULT_GRID_HEIGHT_UNITS = 2;

const isValidGridHeightUnits = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= GRID_HEIGHT_UNIT_MIN && (value as number) <= GRID_HEIGHT_UNIT_MAX;

/** The legacy `compact|medium|large` string aliases the schema still accepts
 *  on read, and their numeric row-unit equivalents. */
const LEGACY_GRID_HEIGHT_UNITS: Record<'compact' | 'medium' | 'large', number> = { compact: 1, medium: 2, large: 3 };

const isLegacyGridHeight = (value: unknown): value is keyof typeof LEGACY_GRID_HEIGHT_UNITS =>
  typeof value === 'string' && Object.hasOwn(LEGACY_GRID_HEIGHT_UNITS, value);

/** True for anything the schema's `grafanaGridHeightV1` `anyOf` accepts: an
 *  integer 1..16, or one of the three legacy alias strings. */
const isValidGridHeightValue = (value: unknown): value is GrafanaGridHeightV1 =>
  isValidGridHeightUnits(value) || isLegacyGridHeight(value);

/** Canonicalize one height value to its numeric row-unit form: a legacy
 *  `compact|medium|large` alias maps to 1/2/3; anything else (including an
 *  already-numeric or a genuinely invalid value) passes through UNCHANGED —
 *  this only resolves the KNOWN legacy vocabulary, it is not a validator
 *  (`validatePlacement` owns rejecting an invalid value). */
function canonicalGridHeightUnits(value: unknown): unknown {
  return isLegacyGridHeight(value) ? LEGACY_GRID_HEIGHT_UNITS[value] : value;
}

/** Canonicalize + default one height value to a valid numeric row-unit
 *  count: a legacy alias converts, an already-valid integer passes through,
 *  anything else (missing, out of range, malformed) falls back to
 *  `DEFAULT_GRID_HEIGHT_UNITS`. Always returns a valid `1..16` integer. */
export function normalizeGridHeightUnits(value: unknown): number {
  const canonical = canonicalGridHeightUnits(value);
  return isValidGridHeightUnits(canonical) ? canonical : DEFAULT_GRID_HEIGHT_UNITS;
}

/** Row units → px, the canonical formula (`32 + 88*units`); a non-finite
 *  input still returns a finite number (`32`) rather than propagating NaN. */
export function gridHeightUnitsToPx(units: number): number {
  const safe = Number.isFinite(units) ? units : 0;
  return GRID_HEIGHT_PX_BASE + GRID_HEIGHT_PX_PER_UNIT * safe;
}

const GRID_HEIGHT_UNITS_FROM_FLOW_HEIGHT: Record<FlowHeightV1, number> = { compact: 1, medium: 2, large: 3 };

/** flow height (compact|medium|large) → grid row units (1|2|3), used when
 *  seeding a grid placement from a flow one (flow→grid engine switch,
 *  `deriveGrafanaGridPlacement`'s size-hints derivation) — the height-units
 *  mirror of `gridSpanFromFlowSpan`. */
export function gridHeightUnitsFromFlowHeight(flowHeight: FlowHeightV1): number {
  return GRID_HEIGHT_UNITS_FROM_FLOW_HEIGHT[flowHeight];
}

/** grid row units → flow height (compact|medium|large): units 1→compact,
 *  2→medium, ≥3→large. Used to regenerate the flow@1 fallback on every grid
 *  mutation — the height-units mirror of `flowSpanFromGridSpan`. An
 *  invalid/out-of-range input is normalized first, so this always returns a
 *  valid `FlowHeightV1`. */
export function gridHeightUnitsToFlowHeight(units: unknown): FlowHeightV1 {
  const normalized = normalizeGridHeightUnits(units);
  return normalized <= 1 ? 'compact' : normalized === 2 ? 'medium' : 'large';
}

/** The grafana-grid@1 default placement (#291): span 6 (half the 12-column
 *  grid), height 2 row units (the numeric equivalent of flow@1's own
 *  "medium" default). */
export const DEFAULT_GRID_PLACEMENT: { span: number; height: number } = { span: 6, height: DEFAULT_GRID_HEIGHT_UNITS };
export const DEFAULT_FULL_PLACEMENT: { height: number } = { height: 2 };
export const DEFAULT_REPORT_PLACEMENT: { height: number } = { height: 5 };
export const REPORT_GRID_SPAN = 9;

export type AuthoredDashboardStyle = 'grid' | 'full' | 'report';
export type TemporaryDashboardStyle = 'columns-2' | 'columns-3';
export type DashboardLayoutStyle = AuthoredDashboardStyle | TemporaryDashboardStyle;

interface GridTileStyles {
  grid?: { span?: number; height?: number };
  full?: { height?: number };
  report?: { height?: number };
}

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

/** One tile's STORED grid placement, or `undefined` when the layout holds none
 *  for it (#535). The read counterpart of `setGridPlacement` — trivial here
 *  because grafana-grid@1 is only ever a PRIMARY layout, but paired with
 *  `flowPlacementAt` so a caller never has to know which engine hides its
 *  placements where. Never mutates. */
export function gridPlacementAt(layout: unknown, tileId: string): unknown {
  if (!isObject(layout) || !isObject(layout.items)) return undefined;
  return layout.items[tileId];
}

function tileStylesAt(layout: unknown, tileId: string): GridTileStyles {
  if (!isObject(layout) || layout.version !== 2 || !isObject(layout.items)) return {};
  const entry = layout.items[tileId];
  return isObject(entry) ? entry as GridTileStyles : {};
}

/** Resolve one tile's independent authored dimensions. Missing maps use the
 * style's designed defaults and never inherit another style's dimensions. */
export function resolveStylePlacement(
  layout: unknown, tileId: string, style: AuthoredDashboardStyle,
): { span: number; height: number } {
  const styles = tileStylesAt(layout, tileId);
  if (style === 'grid') {
    const placement = isObject(styles.grid) ? styles.grid : {};
    return resolveGridPlacement(placement);
  }
  if (style === 'full') {
    const placement = isObject(styles.full) ? styles.full : {};
    return {
      span: GRAFANA_GRID_MAX_COLUMNS,
      height: isValidGridHeightUnits(placement.height) ? placement.height : DEFAULT_FULL_PLACEMENT.height,
    };
  }
  const placement = isObject(styles.report) ? styles.report : {};
  return {
    span: REPORT_GRID_SPAN,
    height: isValidGridHeightUnits(placement.height) ? placement.height : DEFAULT_REPORT_PLACEMENT.height,
  };
}

/** Set dimensions for exactly one authored style while preserving the other
 * two style maps byte-for-byte. Width is accepted only for Grid. */
export function setStylePlacement(
  layout: unknown, tileId: string, style: AuthoredDashboardStyle, placement: unknown,
): void {
  if (!isObject(layout) || layout.version !== 2) return;
  if (!isObject(layout.items)) layout.items = {};
  const items = layout.items as Record<string, unknown>;
  const current = isObject(items[tileId]) ? items[tileId] as Record<string, unknown> : {};
  const candidate = isObject(placement) ? placement : {};
  const next: Record<string, unknown> = {};
  if (style === 'grid' && Object.prototype.hasOwnProperty.call(candidate, 'span')) {
    next.span = candidate.span;
  }
  if (Object.prototype.hasOwnProperty.call(candidate, 'height')) {
    next.height = candidate.height;
  }
  current[style] = next;
  items[tileId] = current;
}

export function stylePlacementAt(
  layout: unknown, tileId: string, style: AuthoredDashboardStyle,
): unknown {
  const styles = tileStylesAt(layout, tileId);
  const placement = styles[style];
  return isObject(placement) ? placement : undefined;
}

/** Derive an initial grid placement from a query's `sizeHints.preferred`,
 *  reusing flow@1's own `compact|medium|wide` → span mapping
 *  (`deriveFlowPlacement`) and converting the result through
 *  `gridSpanFromFlowSpan`. Always returns a complete placement — grafana-grid
 *  has an explicit default (span 6, medium) rather than flow's "no opinion"
 *  `undefined`. */
export function deriveGrafanaGridPlacement(sizeHints: unknown): { span: number; height: number } {
  const flowPlacement = deriveFlowPlacement(sizeHints);
  if (!flowPlacement || flowPlacement.span === undefined) return { ...DEFAULT_GRID_PLACEMENT };
  // `deriveFlowPlacement`'s own contract: whenever it returns a placement
  // (span defined), height is always set too (it never returns a bare span).
  return { span: gridSpanFromFlowSpan(flowPlacement.span), height: gridHeightUnitsFromFlowHeight(flowPlacement.height!) };
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
 *  missing/invalid span falls back to the default; height is always
 *  canonicalized + defaulted through `normalizeGridHeightUnits` (a legacy
 *  alias converts, an already-numeric value passes through, anything else
 *  defaults) — so the result is always a complete, NUMERIC `{span, height}`
 *  (mirrors flow's `resolvePlacement`). */
export function resolveGridPlacement(placement: unknown): { span: number; height: number } {
  const p = isObject(placement) ? placement : {};
  return {
    span: isValidGridSpan(p.span) ? (p.span as number) : DEFAULT_GRID_PLACEMENT.span,
    height: normalizeGridHeightUnits(p.height),
  };
}

/** Normalize a candidate document's grid placements: prune a placement whose
 *  tile no longer exists (as before #291 height-units), AND canonicalize
 *  every remaining placement's `height` — a legacy `compact|medium|large`
 *  alias converts to its numeric row-unit equivalent (1/2/3) so a persisted
 *  document converges to the numeric vocabulary over time; a value already
 *  numeric (valid or not — validation is `validatePlacement`'s job, not
 *  this normalization step) is left untouched. */
function normalize(dashboard: DashboardDocumentV2): DashboardDocumentV2 {
  const next = cloneJson(dashboard);
  const tileIds = new Set<string>();
  for (const tile of Array.isArray(next.tiles) ? next.tiles : []) {
    if (isObject(tile) && typeof tile.id === 'string') tileIds.add(tile.id);
  }
  const items = gridItemsHost(next.layout);
  if (items) {
    for (const key of Object.keys(items)) {
      if (!tileIds.has(key)) { delete items[key]; continue; }
      const item = items[key];
      if (isObject(item) && Object.hasOwn(item, 'height')) {
        item.height = canonicalGridHeightUnits(item.height);
      }
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
  if (Object.hasOwn(placement, 'height') && !isValidGridHeightValue(placement.height)) {
    out.push(diagnostic([...path, 'height'], 'layout-placement-invalid-height',
      'Grafana-grid placement height must be an integer from 1 to 16 (or the legacy compact, medium, or large)'));
  }
  return out;
}

/** The single grafana-grid@1 plugin instance (stateless; safe to share). */
export const grafanaGridLayoutPlugin: DashboardLayoutPlugin = {
  type: 'grafana-grid', version: 1, normalize, validatePlacement,
};

function normalizeV2(dashboard: DashboardDocumentV2): DashboardDocumentV2 {
  const next = cloneJson(dashboard);
  const tileIds = new Set((Array.isArray(next.tiles) ? next.tiles : [])
    .filter((tile): tile is DashboardDocumentV2['tiles'][number] => isObject(tile) && typeof tile.id === 'string')
    .map((tile) => tile.id));
  if (!isObject(next.layout) || !isObject(next.layout.items)) return next;
  for (const key of Object.keys(next.layout.items)) {
    if (!tileIds.has(key)) delete next.layout.items[key];
  }
  return next;
}

function validateV2Placement(placement: unknown, path: Path = []): WorkspaceDiagnostic[] {
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
  if (Object.hasOwn(placement, 'height') && !isValidGridHeightUnits(placement.height)) {
    out.push(diagnostic([...path, 'height'], 'layout-placement-invalid-height',
      'Grafana-grid placement height must be an integer from 1 to 16'));
  }
  return out;
}

export const grafanaGridLayoutV2Plugin: DashboardLayoutPlugin = {
  type: 'grafana-grid', version: 2, normalize: normalizeV2, validatePlacement: validateV2Placement,
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
  /** The tile's resolved STORED span (`resolveGridPlacement(items[id]).span`)
   *  before any render-mode override and before the effective-columns clamp
   *  (#321 Full view). In `'tiles'` mode this equals the clamped `span`'s
   *  pre-clamp source value; in `'full'` mode `span` is overwritten to
   *  `columns` for the row-per-tile layout, so `persistedSpan` is the only
   *  place the unchanged stored span still travels — the UI's full-view
   *  resize must persist THIS value, never the overridden `span`. */
  persistedSpan: number;
  /** Row units (1..16), already canonicalized/defaulted by
   *  `resolveGridPlacement` — never the legacy string form (#291
   *  height-units follow-up: renamed from `height` so a discriminating
   *  consumer never mistakes this for flow's own string `FlowHeightV1`). */
  heightUnits: number;
  /** Exact session-preview height. Authored styles always leave this absent
   * and use `heightUnits`; 2/3-column previews always publish 300. */
  previewHeightPx?: number;
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
  style: DashboardLayoutStyle;
  /** Every visible tile, positioned, in `dashboard.tiles[]` semantic order. */
  tiles: GrafanaGridTileRender[];
}

/** One visible tile the grid lays out, in `dashboard.tiles[]` semantic order.
 *  `isKpi` marks an explicitly-configured KPI panel (chrome only — grafana-
 *  grid@1 has no KPI band). */
export interface GrafanaGridVisibleTile {
  id: string;
  isKpi?: boolean;
}

/** Legacy grafana-grid@1 render override retained for readable v1 documents.
 * Current grafana-grid@2 documents select the authored `style` instead. */
export type GridRenderMode = 'tiles' | 'full';

export interface ComputeGrafanaGridLayoutInput {
  tiles: readonly GrafanaGridVisibleTile[];
  /** The grafana-grid layout document (or any object whose `items` holds
   *  grid placements); tolerated when absent/non-object (every tile then
   *  renders at the grid default). */
  layout: unknown;
  /** The rendering container's width in px; see `effectiveGridColumns`. */
  containerWidth?: number;
  /** Render mode (#321); defaults to `'tiles'` (today's packed behavior)
   *  when absent. */
  renderMode?: GridRenderMode;
  style?: DashboardLayoutStyle;
  previewSpans?: ReadonlyMap<string, number>;
  mobile?: boolean;
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
  const {
    tiles, layout, containerWidth, renderMode = 'tiles',
    style = renderMode === 'full' ? 'full' : 'grid', previewSpans, mobile = false,
  } = input;
  const temporary = style === 'columns-2' || style === 'columns-3';
  const columns = temporary
    ? (mobile ? 1 : style === 'columns-2' ? 2 : 3)
    : style === 'grid' ? effectiveGridColumns(containerWidth) : GRAFANA_GRID_MAX_COLUMNS;
  const items = gridItemsFor(layout);

  let row = 0;
  let cursor = 0;
  const renders: GrafanaGridTileRender[] = tiles.map((tile, index) => {
    const placement = isObject(layout) && layout.version === 2
      ? resolveStylePlacement(layout, tile.id,
        style === 'full' || style === 'report' ? style : 'grid')
      : resolveGridPlacement(items[tile.id]);
    const authoredSpan = style === 'full' ? columns
      : style === 'report' ? REPORT_GRID_SPAN
        : temporary ? (previewSpans?.get(tile.id) ?? 1) : placement.span;
    const span = Math.min(columns, Math.max(1, authoredSpan));
    if (cursor + span > columns) {
      row += 1;
      cursor = 0;
    }
    const render: GrafanaGridTileRender = {
      tileId: tile.id,
      index,
      span,
      persistedSpan: placement.span,
      heightUnits: placement.height,
      ...(temporary ? { previewHeightPx: 300 } : {}),
      isKpi: !!tile.isKpi,
      row,
      colStart: cursor,
    };
    cursor += span;
    return render;
  });

  return { engine: 'grafana-grid', columns, style, tiles: renders };
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
 * default (span 1). `columns-2` is the fallback preset (#321: full-width was
 * removed from flow@1 entirely) — the canonical remaining single-decision
 * fallback for a rowless grid with no fixed column count.
 */
export function deriveFlowFallback(
  gridLayout: unknown, tiles: readonly GrafanaGridFallbackTile[],
): FlowLayoutV1 {
  const items = gridItemsFor(gridLayout);
  const flowItems: Record<string, FlowTilePlacementV1> = {};
  for (const tile of tiles) {
    const gridPlacement = resolveGridPlacement(items[tile.id]);
    flowItems[tile.id] = {
      span: flowSpanFromGridSpan(gridPlacement.span), height: gridHeightUnitsToFlowHeight(gridPlacement.height),
    };
  }
  return { type: 'flow', version: 1, preset: 'columns-2', items: flowItems };
}

export function deriveAuthoredFlowFallback(
  layout: unknown, tiles: readonly GrafanaGridFallbackTile[],
): FlowLayoutV1 {
  const preset: AuthoredDashboardStyle = isObject(layout)
    && (layout.preset === 'grid' || layout.preset === 'full' || layout.preset === 'report')
    ? layout.preset : 'grid';
  if (!isObject(layout) || layout.version !== 2) return deriveFlowFallback(layout, tiles);
  const flowItems: Record<string, FlowTilePlacementV1> = {};
  for (const tile of tiles) {
    const placement = resolveStylePlacement(layout, tile.id, preset);
    flowItems[tile.id] = preset === 'grid'
      ? {
        span: flowSpanFromGridSpan(placement.span),
        height: gridHeightUnitsToFlowHeight(placement.height),
      }
      : preset === 'full'
        ? { span: 2, height: gridHeightUnitsToFlowHeight(placement.height) }
        : { span: 1, height: gridHeightUnitsToFlowHeight(placement.height) };
  }
  return {
    type: 'flow',
    version: 1,
    preset: preset === 'report' ? 'report' : 'columns-2',
    items: flowItems,
  };
}

// ── Pure resize math (#291 Wave 3 — corner-drag resize): the DOM listener in
// ui/dashboard.ts stays a thin imperative adapter (rule 5); the snap/tier
// arithmetic lives here so it is 100%-covered without any DOM. ────────────────

/** The 8px gap between grid cells/rows — a single source of truth the CSS
 *  grid host (`gap: 8px`, styles.css) and the resize pointer math both use, so
 *  a corner-drag's column-width computation matches what the browser actually
 *  renders. */
export const GRID_GAP_PX = 8;

/** Snap a corner-drag's horizontal pixel delta to a column span: `round((dx +
 *  gap) / (colWidth + gap))`, clamped to `1..columns` — the same formula the
 *  design mock's reference implementation uses (`grafana-dashboard-behavior.js`).
 *  A non-finite/zero `colWidthPx` (no measured column width yet) still returns
 *  a clamped integer rather than NaN/Infinity. */
export function snapGridSpan(dxPx: number, colWidthPx: number, gapPx: number, columns: number): number {
  const safeColumns = Math.max(1, columns);
  const denominator = colWidthPx + gapPx;
  if (!Number.isFinite(denominator) || denominator <= 0) return 1;
  const raw = Math.round((dxPx + gapPx) / denominator);
  return Math.max(1, Math.min(safeColumns, raw));
}

/** Snap a corner-drag's vertical pixel delta to the nearest row-unit height:
 *  `round((dy - 32) / 88)`, clamped to `1..16` — the inverse of
 *  `gridHeightUnitsToPx`, so dragging a tile to exactly its OWN current px
 *  height is a stable fixed point (`snapGridHeight(gridHeightUnitsToPx(u))
 *  === u` for every valid `u`), not just a nearby tier. */
export function snapGridHeight(dyPx: number): number {
  const raw = Math.round((dyPx - GRID_HEIGHT_PX_BASE) / GRID_HEIGHT_PX_PER_UNIT);
  return Math.max(GRID_HEIGHT_UNIT_MIN, Math.min(GRID_HEIGHT_UNIT_MAX, raw));
}

/** Extract `{id}` refs from a RAW `dashboard.tiles[]`-shaped array — a
 *  malformed entry (non-object, or a non-string `id`) is dropped, never
 *  thrown. Lets every #291 call site hand `regenerateGridFallback` its own
 *  `dashboard.tiles` array directly instead of pre-mapping/filtering it
 *  itself (#291 review F9: three call sites duplicated this exact
 *  `filter(isObject...).map(...)`). */
function tileRefsOf(tiles: readonly unknown[]): GrafanaGridFallbackTile[] {
  const out: GrafanaGridFallbackTile[] = [];
  for (const tile of tiles) {
    if (isObject(tile) && typeof tile.id === 'string') out.push({ id: tile.id });
  }
  return out;
}

/** Regenerate a grafana-grid@1 layout's flow@1 `fallback` IN PLACE from its
 *  current `items` + the given RAW `dashboard.tiles[]` array (mutates
 *  `layout.fallback`, mirroring `setGridPlacement`'s own mutate-in-place
 *  contract) — a no-op when `layout` is not a grafana-grid@1 document. The
 *  single shared primitive every #291 application-layer mutation path
 *  (authoring commands and tile membership) calls so "every grid mutation
 *  regenerates the flow@1 fallback deterministically" is enforced once, not
 *  duplicated per call site. The
 *  non-grid guard runs BEFORE the tiles→refs mapping/allocation (#291 review
 *  F9) — calling this on the far-more-common flow-engine document costs only
 *  the guard check, never a `tiles[]` walk that would just be thrown away. */
export function regenerateGridFallback(layout: unknown, tiles: readonly unknown[]): void {
  if (!isObject(layout) || layout.type !== 'grafana-grid') return;
  layout.fallback = layout.version === 2
    ? deriveAuthoredFlowFallback(layout, tileRefsOf(tiles))
    : deriveFlowFallback(layout, tileRefsOf(tiles));
}

// ── Measurement math (#291 review F2): the grid host's `clientWidth` INCLUDES
// its own horizontal padding (`.dash-grid`'s `padding: 18px 20px 40px`,
// styles.css), but CSS grid TRACKS occupy the CONTENT box — using
// `clientWidth` directly for the responsive breakpoint clamp or the resize
// column-width math misclassifies tiers near a threshold and skews the
// column width by the same amount. `ui/dashboard.ts` pairs this with a thin
// DOM reader (`getComputedStyle(el).paddingLeft/Right`) for both call sites. ─

/** The grid host's CONTENT-box width: `clientWidth` minus its own horizontal
 *  padding, clamped to a minimum of 0. A non-finite padding read (e.g. an
 *  empty computed-style string under a no-stylesheet test environment, which
 *  `parseFloat` turns into `NaN`) is treated as 0 rather than propagating NaN
 *  — the un-padded `clientWidth` itself, exactly today's (pre-fix) behavior
 *  when no padding can be read. Pure — the DOM `getComputedStyle` read is the
 *  caller's job. */
export function contentBoxWidth(clientWidth: number, padLeft: number, padRight: number): number {
  const left = Number.isFinite(padLeft) ? padLeft : 0;
  const right = Number.isFinite(padRight) ? padRight : 0;
  return Math.max(0, clientWidth - left - right);
}
