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
import type { DashboardDocumentV1, FlowTilePlacementV1 } from '../../generated/json-schema.types.js';

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
