// The minimal flow@1 layout plugin the Phase-3 authoring commands drive
// (#280 "Normative flow@1 contract", "Dashboard layout registry and fallback").
// Phase 3 needs exactly two capabilities from the active layout plugin: it
// must NORMALIZE a candidate document (prune placements that no longer name a
// tile — the reason `remove-tile` does not leave an orphan) and it must
// VALIDATE one placement for `update-placement`. The full flow@1 viewer/editor
// (packing, KPI bands, keyboard reorder) is Phase 4; this file is only the
// authoring-domain seam. Pure — no DOM, no rendering.
//
// The plugin also serves an unsupported primary layout that carries a valid
// flow@1 fallback: normalization then operates on the fallback's placements,
// exactly as a viewer that cannot load the primary engine would.

import { diagnostic } from '../model/workspace-diagnostics.js';
import type { WorkspaceDiagnostic } from '../model/workspace-diagnostics.js';
import { isSupportedLayout } from '../model/workspace-semantics.js';
import { cloneJson } from '../../core/saved-query.js';
import { partitionKpiBands } from '../../core/dashboard.js';
import type {
  DashboardDocumentV1, FlowHeightV1, FlowPresetV1, FlowTilePlacementV1,
} from '../../generated/json-schema.types.js';

/** The flow@1 default placement (#280): span 1, medium height. */
export const DEFAULT_FLOW_PLACEMENT: FlowTilePlacementV1 = { span: 1, height: 'medium' };

const VALID_SPANS = new Set<unknown>([1, 2, 3]);
const VALID_HEIGHTS = new Set<unknown>(['compact', 'medium', 'large']);
const PLACEMENT_FIELDS = new Set(['span', 'height']);

type Path = (string | number)[];

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** The narrow layout-plugin contract the authoring session/commands use. */
export interface DashboardLayoutPlugin {
  readonly type: string;
  readonly version: number;
  /** Return a normalized COPY of the document (input never mutated). */
  normalize(dashboard: DashboardDocumentV1): DashboardDocumentV1;
  /** Diagnostics for one placement object (empty when valid). */
  validatePlacement(placement: unknown, path?: Path): WorkspaceDiagnostic[];
}

/** The object holding the active flow placements — the primary layout's
 *  `items` when it is flow@1, else a valid flow@1 fallback's `items`, else
 *  `null` (no flow surface to normalize). */
function flowItemsHost(layout: unknown): Record<string, unknown> | null {
  if (!isObject(layout)) return null;
  if (isSupportedLayout(layout.type, layout.version)) {
    if (!isObject(layout.items)) { layout.items = {}; }
    return layout.items as Record<string, unknown>;
  }
  const fallback = layout.fallback;
  if (isObject(fallback) && isSupportedLayout(fallback.type, fallback.version)) {
    if (!isObject(fallback.items)) { fallback.items = {}; }
    return fallback.items as Record<string, unknown>;
  }
  return null;
}

/** Set one tile's flow placement on a layout document (mutates in place).
 *  No-op when the layout has no flow surface. */
export function setFlowPlacement(layout: unknown, tileId: string, placement: unknown): void {
  const items = flowItemsHost(layout);
  if (items) items[tileId] = placement;
}

/** Derive an initial flow placement from a query's `sizeHints.preferred`
 *  (`compact|medium|wide` → span `1|2|3`), or `undefined` when there is no
 *  usable hint (the tile then renders at the flow default). */
export function deriveFlowPlacement(sizeHints: unknown): FlowTilePlacementV1 | undefined {
  if (!isObject(sizeHints)) return undefined;
  const span = sizeHints.preferred === 'wide' ? 3
    : sizeHints.preferred === 'medium' ? 2
      : sizeHints.preferred === 'compact' ? 1 : undefined;
  if (span === undefined) return undefined;
  return { span, height: 'medium' };
}

function normalize(dashboard: DashboardDocumentV1): DashboardDocumentV1 {
  const next = cloneJson(dashboard);
  const tileIds = new Set<string>();
  for (const tile of Array.isArray(next.tiles) ? next.tiles : []) {
    if (isObject(tile) && typeof tile.id === 'string') tileIds.add(tile.id);
  }
  const items = flowItemsHost(next.layout);
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
        `Unknown flow placement field ${JSON.stringify(key)}`));
    }
  }
  if (Object.hasOwn(placement, 'span') && !VALID_SPANS.has(placement.span)) {
    out.push(diagnostic([...path, 'span'], 'layout-placement-invalid-span', 'Flow placement span must be 1, 2, or 3'));
  }
  if (Object.hasOwn(placement, 'height') && !VALID_HEIGHTS.has(placement.height)) {
    out.push(diagnostic([...path, 'height'], 'layout-placement-invalid-height',
      'Flow placement height must be compact, medium, or large'));
  }
  return out;
}

/** The single flow@1 plugin instance (stateless; safe to share). */
export const flowLayoutPlugin: DashboardLayoutPlugin = {
  type: 'flow', version: 1, normalize, validatePlacement,
};

export type LoadLayoutPluginResult =
  | { ok: true; plugin: DashboardLayoutPlugin }
  | { ok: false; diagnostics: WorkspaceDiagnostic[] };

// ── Phase 4: the normative flow@1 render model (#280 "Normative flow@1
// contract") ────────────────────────────────────────────────────────────────
// Pure layout MATH shared by the viewer, the authoring preview, print/export,
// and the tests — no DOM, no persistence. Exact pixels, gaps, and report width
// stay renderer/theme concerns; this module owns column count, effective span,
// deterministic row-major packing, KPI-band grouping, and mobile normalization.

/** Desktop column count for each flow preset (#280 "Presets"). full-width and
 *  report render one column (report centers a constrained-width column);
 *  columns-2/columns-3 render two/three equal columns. */
export const FLOW_PRESET_COLUMNS: Record<FlowPresetV1, number> = {
  'full-width': 1, report: 1, 'columns-2': 2, 'columns-3': 3,
};

const FLOW_PRESETS = new Set<string>(Object.keys(FLOW_PRESET_COLUMNS));

/** The mobile breakpoint (#280 "Responsive/mobile normalization"): at or below
 *  this width the flow renders a single column with every effective span 1 and
 *  the persisted preset/span/height untouched. */
export const FLOW_MOBILE_BREAKPOINT = 768;

/** The desktop column count for a preset; an unknown/absent preset falls back
 *  to full-width (1). */
export function presetColumns(preset: unknown): number {
  return typeof preset === 'string' && Object.hasOwn(FLOW_PRESET_COLUMNS, preset)
    ? FLOW_PRESET_COLUMNS[preset as FlowPresetV1] : 1;
}

/** The effective span for one tile (#280 "Preset changes"): `min(storedSpan ??
 *  1, activeColumnCount)`. A stored span that is not 1|2|3 is treated as the
 *  default 1; changing presets never rewrites the stored span. */
export function effectiveSpan(storedSpan: unknown, activeColumnCount: number): number {
  const span = VALID_SPANS.has(storedSpan) ? (storedSpan as number) : 1;
  return Math.min(span, Math.max(1, activeColumnCount));
}

/** Merge one stored placement with `DEFAULT_FLOW_PLACEMENT` (#280 "Missing
 *  placement defaults"): a missing/invalid span or height falls back to the
 *  default, so the result is always a complete `{span, height}`. */
export function resolvePlacement(placement: unknown): Required<FlowTilePlacementV1> {
  const p = isObject(placement) ? placement : {};
  return {
    span: VALID_SPANS.has(p.span) ? (p.span as 1 | 2 | 3) : DEFAULT_FLOW_PLACEMENT.span!,
    height: VALID_HEIGHTS.has(p.height) ? (p.height as FlowHeightV1) : DEFAULT_FLOW_PLACEMENT.height!,
  };
}

/** The flow surface a layout document renders through (read-only, no mutation,
 *  unlike `flowItemsHost`): the primary layout when it is flow@1, else a valid
 *  flow@1 fallback, else `null`. */
function flowSurface(layout: unknown): Record<string, unknown> | null {
  if (!isObject(layout)) return null;
  if (isSupportedLayout(layout.type, layout.version)) return layout;
  const fallback = layout.fallback;
  if (isObject(fallback) && isSupportedLayout(fallback.type, fallback.version)) return fallback;
  return null;
}

/** One tile as placed for one render pass. `span` is already clamped to the
 *  active column count (and 1 on mobile); `index` is the tile's position in the
 *  visible-tiles input, which equals `dashboard.tiles[]` semantic order. */
export interface FlowTileRender {
  tileId: string;
  index: number;
  span: number;
  height: FlowHeightV1;
  isKpi: boolean;
}

/** One packed flow row: an ordinary run of tiles filling the active columns, or
 *  a KPI band that starts its own full-width row (#280 "KPI bands"). */
export interface FlowRow {
  kind: 'tiles' | 'kpi-band';
  columns: number;
  tiles: FlowTileRender[];
}

/** The computed flow render model — enough for a renderer to lay tiles out and
 *  for tests to assert the order equivalence, with no DOM involved. */
export interface FlowLayoutModel {
  preset: FlowPresetV1;
  /** Effective columns: the preset's desktop columns, or 1 on mobile. */
  columns: number;
  mobile: boolean;
  rows: FlowRow[];
  /** Visible tile IDs in semantic order — equals DOM = keyboard traversal =
   *  visual row-major = print/export order (#280 order equivalence). */
  order: string[];
}

/** One visible tile the flow lays out, in `dashboard.tiles[]` semantic order.
 *  `isKpi` marks an explicitly-configured KPI panel (band member). */
export interface FlowVisibleTile {
  id: string;
  isKpi?: boolean;
}

export interface ComputeFlowLayoutInput {
  tiles: readonly FlowVisibleTile[];
  layout: unknown;
  /** True at/below `FLOW_MOBILE_BREAKPOINT` — one column, every span 1, order
   *  unchanged, persistence untouched. */
  mobile?: boolean;
}

/**
 * Compute the deterministic flow render model (#280 "Packing and collision
 * rules", "KPI bands", "Responsive/mobile normalization"). Row-major packing:
 * read the visible tiles in `dashboard.tiles[]` order, resolve each effective
 * span, place it in the current row when it fits, else start the next row —
 * tiles never overlap. A maximal consecutive run of KPI tiles becomes one
 * full-width band row that occupies all active columns; the members keep
 * semantic order. Mobile forces one column and every span to 1 WITHOUT
 * touching the persisted preset/span/height. Pure and non-mutating.
 */
export function computeFlowLayout(input: ComputeFlowLayoutInput): FlowLayoutModel {
  const { tiles, layout, mobile = false } = input;
  const surface = flowSurface(layout);
  const rawPreset = surface && typeof surface.preset === 'string' ? surface.preset : undefined;
  const preset: FlowPresetV1 = rawPreset && FLOW_PRESETS.has(rawPreset) ? rawPreset as FlowPresetV1 : 'full-width';
  const items = surface && isObject(surface.items) ? surface.items as Record<string, unknown> : {};
  const columns = mobile ? 1 : presetColumns(preset);

  const renders: FlowTileRender[] = tiles.map((tile, index) => {
    const placement = resolvePlacement(items[tile.id]);
    return {
      tileId: tile.id, index, isKpi: !!tile.isKpi, height: placement.height,
      span: mobile ? 1 : effectiveSpan(placement.span, columns),
    };
  });

  // Reuse the #240 consecutive-KPI-run partition, then row-pack the ordinary
  // tiles between bands. A band flushes the current tile row and starts fresh.
  const rows: FlowRow[] = [];
  let current: FlowRow | null = null;
  let remaining = 0;
  for (const item of partitionKpiBands(tiles.map((t) => !!t.isKpi))) {
    if (item.kind === 'kpi-band') {
      current = null;
      remaining = 0;
      rows.push({ kind: 'kpi-band', columns, tiles: item.indices.map((i) => renders[i]) });
      continue;
    }
    const render = renders[item.index];
    if (!current || remaining < render.span) {
      current = { kind: 'tiles', columns, tiles: [] };
      rows.push(current);
      remaining = columns;
    }
    current.tiles.push(render);
    remaining -= render.span;
  }

  return { preset, columns, mobile, rows, order: tiles.map((tile) => tile.id) };
}

/** Resolve the active layout plugin for one layout document. flow@1 primary →
 *  the flow plugin; an unsupported primary WITH a valid flow@1 fallback → the
 *  flow plugin (operating on the fallback); otherwise a load failure — the
 *  `change-layout` "plugin cannot load / unsupported version without a valid
 *  fallback" path. */
export function resolveActiveLayoutPlugin(layout: unknown, path: Path = ['layout']): LoadLayoutPluginResult {
  if (isObject(layout)) {
    if (isSupportedLayout(layout.type, layout.version)) return { ok: true, plugin: flowLayoutPlugin };
    const fallback = layout.fallback;
    if (isObject(fallback) && isSupportedLayout(fallback.type, fallback.version)) {
      return { ok: true, plugin: flowLayoutPlugin };
    }
  }
  return {
    ok: false,
    diagnostics: [diagnostic(path, 'dashboard-layout-load-failed',
      'Dashboard layout cannot be loaded and has no valid flow@1 fallback')],
  };
}
