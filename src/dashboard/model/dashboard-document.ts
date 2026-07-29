// Pure Dashboard-document shape migrations (#447). One home for the transforms
// that carry a Dashboard document from one contract version to the next, so the
// two containers that hold Dashboards — the stored workspace and the portable
// bundle — share the transform instead of each re-deriving it.
//
// This lives in `src/dashboard/model` rather than beside either container's codec
// because it is a Dashboard-document concern and both containers depend DOWNWARD
// on this layer. Putting it in `src/workspace` and importing it from the bundle
// codec would invert that.
//
// Pure — no DOM, no persistence, no clock.

import { cloneJson, defineJsonField, readJsonField } from '../../core/saved-query.js';
import type { DashboardDocumentV1, DashboardDocumentV2 } from '../../generated/json-schema.types.js';

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const gridHeight = (value: unknown, fallback = 2): number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 16
    ? value as number
    : value === 'compact' ? 1 : value === 'medium' ? 2 : value === 'large' ? 3 : fallback;
const flowHeight = (value: unknown): 'compact' | 'medium' | 'large' => {
  const units = gridHeight(value);
  return units <= 1 ? 'compact' : units === 2 ? 'medium' : 'large';
};
const flowToGridSpan = (value: unknown): 4 | 6 | 12 =>
  value === 3 ? 12 : value === 2 ? 6 : 4;
const gridToFlowSpan = (value: unknown): 1 | 2 | 3 => {
  const span = Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 12
    ? value as number : 6;
  return span <= 4 ? 1 : span <= 8 ? 2 : 3;
};

function resolvedFlowPlacement(value: unknown): {
  span: 1 | 2 | 3;
  height: 'compact' | 'medium' | 'large';
} {
  const placement = isObject(value) ? value : {};
  return {
    span: placement.span === 2 || placement.span === 3 ? placement.span : 1,
    height: placement.height === 'compact' || placement.height === 'large'
      ? placement.height : 'medium',
  };
}

function authoredPlacement(
  layout: Record<string, unknown>, tileId: string, style: 'grid' | 'full' | 'report',
): { span: number; height: number } {
  const items = isObject(layout.items) ? layout.items : {};
  const ownEntry = readJsonField(items, tileId);
  const entry = isObject(ownEntry) ? ownEntry : {};
  const placement = isObject(entry[style]) ? entry[style] as Record<string, unknown> : {};
  if (style === 'grid') {
    return {
      span: Number.isInteger(placement.span) ? placement.span as number : 6,
      height: gridHeight(placement.height, 2),
    };
  }
  return {
    span: style === 'full' ? 12 : 9,
    height: gridHeight(placement.height, style === 'full' ? 2 : 5),
  };
}

function regenerateFallback(layout: Record<string, unknown>, tileIds: readonly string[]): void {
  const preset = layout.preset === 'full' || layout.preset === 'report' ? layout.preset : 'grid';
  const items: Record<string, unknown> = {};
  for (const tileId of tileIds) {
    const placement = authoredPlacement(layout, tileId, preset);
    defineJsonField(items, tileId, preset === 'grid'
      ? { span: gridToFlowSpan(placement.span), height: flowHeight(placement.height) }
      : preset === 'full'
        ? { span: 2, height: flowHeight(placement.height) }
        : { span: 1, height: flowHeight(placement.height) });
  }
  layout.fallback = {
    type: 'flow',
    version: 1,
    preset: preset === 'report' ? 'report' : 'columns-2',
    items,
  };
}

/**
 * Upgrade every readable legacy layout to the canonical grafana-grid@2
 * authored-style contract. Dashboard/workspace document versions and revision
 * are deliberately unchanged.
 */
export function upgradeDashboardLayout<T extends DashboardDocumentV1 | DashboardDocumentV2>(
  dashboard: T,
): T {
  const next = cloneJson(dashboard);
  const layout = next.layout as unknown as Record<string, unknown>;
  const tileIds = next.tiles.map((tile) => tile.id);

  if (layout.type === 'grafana-grid' && layout.version === 2) {
    regenerateFallback(layout, tileIds);
    return next;
  }

  const items: Record<string, Record<string, unknown>> = {};
  if (layout.type === 'grafana-grid' && layout.version === 1) {
    const oldItems = isObject(layout.items) ? layout.items : {};
    for (const tileId of tileIds) {
      const old = readJsonField(oldItems, tileId);
      if (!isObject(old)) continue;
      const grid: Record<string, unknown> = {};
      if (Object.hasOwn(old, 'span')) grid.span = old.span;
      if (Object.hasOwn(old, 'height')) grid.height = gridHeight(old.height);
      defineJsonField(items, tileId, { grid });
    }
    next.layout = {
      type: 'grafana-grid', version: 2, preset: 'grid', items,
    } as never;
  } else if (layout.type === 'flow' && layout.version === 1) {
    const oldItems = isObject(layout.items) ? layout.items : {};
    if (layout.preset === 'report') {
      for (const tileId of tileIds) {
        const old = readJsonField(oldItems, tileId);
        if (!isObject(old) || !Object.hasOwn(old, 'height')) continue;
        defineJsonField(items, tileId, {
          report: { height: gridHeight(old.height) },
        });
      }
      next.layout = {
        type: 'grafana-grid', version: 2, preset: 'report', items,
      } as never;
    } else {
      for (const tileId of tileIds) {
        const old = resolvedFlowPlacement(readJsonField(oldItems, tileId));
        defineJsonField(items, tileId, {
          grid: {
            span: flowToGridSpan(old.span),
            height: gridHeight(old.height),
          },
        });
      }
      next.layout = {
        type: 'grafana-grid', version: 2, preset: 'grid', items,
      } as never;
    }
  } else {
    return next;
  }
  regenerateFallback(next.layout as unknown as Record<string, unknown>, tileIds);
  return next;
}

/**
 * Drop one Dashboard's curated filters, producing the document v2 shape.
 *
 * `filters` is removed outright and `documentVersion` becomes 2. Everything else
 * survives the deep clone verbatim — id, title, description, revision, layout,
 * every tile with its presentation, and any unknown forward-compatible field —
 * because #430 requires member ids and Dashboard revisions to survive a migration
 * so the tree's expansion and selection stay valid across it.
 *
 * No `variableConfigs` is synthesized. A curated filter's persisted identity was
 * a filter id, a label and an option-source query reference, none of which the
 * inferred-variable model has anywhere to put: a variable's name and type come
 * from the panel SQL that declares it, and its option SQL is authored fresh. A
 * filter whose only content was a `sourceQueryId` therefore has nothing to carry
 * forward, and the query it pointed at is preserved regardless — losing its last
 * owner turns it into a Library query, so its SQL stays available to paste into a
 * variable editor by hand.
 */
export function dropCuratedFilters(dashboard: DashboardDocumentV1): DashboardDocumentV2 {
  const { filters: _filters, ...rest } = cloneJson(dashboard);
  return upgradeDashboardLayout({ ...rest, documentVersion: 2 });
}
