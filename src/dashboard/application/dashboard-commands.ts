// The typed, fallible Dashboard commands (#280 "Fallible, atomic authoring
// commands"). `applyCommand` is the pure APPLY step of the atomic algorithm:
// it clones the current draft, applies one command to that isolated candidate,
// and returns either the candidate dashboard (plus an optional command value)
// or the command-level diagnostics that make it impossible — WITHOUT mutating
// the input draft. The session (dashboard-authoring-session.ts) then normalizes
// through the layout plugin, runs whole-workspace + presentation validation,
// and only replaces its draft when the candidate is fully valid.
//
// Command-level failures caught here are the ones no downstream validation
// could see because they concern the command itself, not the resulting shape:
// a missing query, a duplicate default instance, a missing tile, an
// out-of-range move index (never silently clamped, per #280), an unsafe tile
// patch, or an invalid placement. Role/limit/reference/presentation failures
// are left to the session's validation stage.

import { cloneJson } from '../../core/saved-query.js';
import { diagnostic } from '../model/workspace-diagnostics.js';
import type { WorkspaceDiagnostic } from '../model/workspace-diagnostics.js';
import { deriveFlowPlacement, resolvePlacement, setFlowPlacement } from '../layouts/flow-layout.js';
import type { DashboardLayoutPlugin } from '../layouts/flow-layout.js';
import {
  deriveGrafanaGridPlacement, gridSpanFromFlowSpan,
  regenerateGridFallback as regenerateGridLayoutFallback, setGridPlacement,
} from '../layouts/grafana-grid-layout.js';
import type { QueryResolver } from './dashboard-query-resolver.js';
import type {
  DashboardDocumentV1, DashboardLayoutDocumentV1, DashboardTileV1,
} from '../../generated/json-schema.types.js';

/** A tile-local patch for `update-tile` — an RFC 7396 merge patch over the
 *  tile object. `id`/`queryId` may not be patched (tile identity is stable);
 *  a `null` member deletes an optional tile field. */
export type DashboardTilePatch = Record<string, unknown>;

export type DashboardCommand =
  | { type: 'add-query'; queryId: string }
  | { type: 'add-query-instance'; queryId: string; variant?: string }
  | { type: 'remove-tile'; tileId: string }
  | { type: 'move-tile'; tileId: string; toIndex: number }
  | { type: 'update-tile'; tileId: string; patch: DashboardTilePatch }
  | { type: 'update-placement'; tileId: string; placement: Record<string, unknown> }
  | { type: 'change-layout'; layout: DashboardLayoutDocumentV1 };

/** The #280 command-result union, `draftVersion` included on both arms. */
export type DashboardCommandResult<T = void> =
  | { ok: true; value: T; document: DashboardDocumentV1; draftVersion: number }
  | { ok: false; diagnostics: WorkspaceDiagnostic[]; draftVersion: number };

export interface ApplyCommandContext {
  resolver: QueryResolver;
  /** Mint a fresh tile instance ID. */
  genTileId: () => string;
  /** The active layout plugin, used to validate `update-placement`. */
  plugin: DashboardLayoutPlugin;
}

export type ApplyCommandResult =
  | { ok: true; dashboard: DashboardDocumentV1; value: unknown }
  | { ok: false; diagnostics: WorkspaceDiagnostic[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const failWith = (...diagnostics: WorkspaceDiagnostic[]): ApplyCommandResult =>
  ({ ok: false, diagnostics });

const missingTile = (tileId: string): WorkspaceDiagnostic =>
  diagnostic(['tiles'], 'dashboard-command-tile-missing', `No tile ${JSON.stringify(tileId)} on this Dashboard`);

const tileIndex = (tiles: unknown[], tileId: string): number =>
  tiles.findIndex((tile) => isObject(tile) && tile.id === tileId);

/** Command types whose tile/placement mutation must regenerate a
 *  grafana-grid@1 layout's flow@1 `fallback` (#291 "every grid mutation
 *  regenerates the flow@1 fallback deterministically") — every command that
 *  changes `tiles[]` membership/order or a grid placement. `change-layout`
 *  manages `fallback` itself (see its case below, both engine-switch
 *  directions); `update-tile` never touches tiles[] membership/order or
 *  placements, so it is deliberately excluded. */
const GRID_FALLBACK_COMMANDS = new Set<DashboardCommand['type']>([
  'add-query', 'add-query-instance', 'remove-tile', 'move-tile', 'update-placement',
]);

/** Regenerate a grafana-grid@1 layout's flow@1 `fallback` from the
 *  document's CURRENT items + tile set, via the single shared primitive
 *  (`regenerateGridLayoutFallback`, grafana-grid-layout.ts) every #291
 *  application-layer mutation path calls — a no-op when the layout is not
 *  grafana-grid@1. Centralized here (called once, from `applyCommand`) so no
 *  individual command case needs its own copy. */
function regenerateGridFallback(dashboard: DashboardDocumentV1): void {
  const tileRefs = dashboard.tiles
    .filter((tile): tile is DashboardTileV1 => isObject(tile) && typeof tile.id === 'string')
    .map((tile) => ({ id: tile.id }));
  regenerateGridLayoutFallback(dashboard.layout, tileRefs);
}

/** One-level merge of an `update-tile` presentation patch onto the tile's
 *  existing presentation. A non-object patch replaces the whole field; else
 *  each patch sub-field replaces (or, when `null`, deletes) the same sub-field
 *  on a clone of the existing presentation. Sub-field VALUES (notably
 *  `override`, which is stored RFC 7396 patch data) are cloned verbatim — the
 *  merge never recurses into them, so their nested `null`s survive. */
function mergeTilePresentation(existing: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return cloneJson(patch);
  const result: Record<string, unknown> = {};
  if (isObject(existing)) for (const key of Object.keys(existing)) result[key] = cloneJson(existing[key]);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = cloneJson(value);
  }
  return result;
}

/** Apply one command to an ISOLATED clone of `draft`, returning the candidate
 *  dashboard or command-level diagnostics. The input `draft` is never
 *  mutated. On success, when the ACTIVE command type touches tiles[] or grid
 *  placements while grafana-grid@1 is the primary layout, the flow@1
 *  `fallback` is regenerated as one centralized post-step (#291;
 *  `change-layout` is excluded — it manages `fallback` itself). */
export function applyCommand(
  draft: DashboardDocumentV1, command: DashboardCommand, ctx: ApplyCommandContext,
): ApplyCommandResult {
  const dashboard = cloneJson(draft);
  const result = applyCommandToClone(dashboard, command, ctx);
  if (result.ok && GRID_FALLBACK_COMMANDS.has(command.type)) regenerateGridFallback(result.dashboard);
  return result;
}

function applyCommandToClone(
  dashboard: DashboardDocumentV1, command: DashboardCommand, ctx: ApplyCommandContext,
): ApplyCommandResult {
  const tiles = dashboard.tiles as unknown[];

  switch (command.type) {
    case 'add-query':
    case 'add-query-instance': {
      const { queryId } = command;
      if (!ctx.resolver.has(queryId)) {
        return failWith(diagnostic(['tiles'], 'dashboard-command-query-missing',
          `No saved query ${JSON.stringify(queryId)} to add`, queryId));
      }
      if (command.type === 'add-query'
        && tiles.some((tile) => isObject(tile) && tile.queryId === queryId)) {
        return failWith(diagnostic(['tiles'], 'dashboard-command-duplicate-instance',
          `Query ${JSON.stringify(queryId)} already has a default tile`, queryId));
      }
      const id = ctx.genTileId();
      const tile: DashboardTileV1 = { id, queryId };
      if (command.type === 'add-query-instance' && typeof command.variant === 'string') {
        tile.presentation = { variant: command.variant };
      }
      tiles.push(tile);
      const query = ctx.resolver.get(queryId);
      const sizeHints = isObject(query) && isObject(query.spec) && isObject(query.spec.dashboard)
        ? query.spec.dashboard.sizeHints : undefined;
      // Add-time placement seeding is engine-aware (#291): grafana-grid@1
      // always gets an explicit placement (its own default when there is no
      // usable hint), matching `deriveGrafanaGridPlacement`'s "no opinion"
      // contract being the grid default rather than flow's bare `undefined`.
      if (ctx.plugin.type === 'grafana-grid') {
        setGridPlacement(dashboard.layout, id, deriveGrafanaGridPlacement(sizeHints));
      } else {
        const placement = deriveFlowPlacement(sizeHints);
        if (placement) setFlowPlacement(dashboard.layout, id, placement);
      }
      return { ok: true, dashboard, value: { tileId: id } };
    }

    case 'remove-tile': {
      const index = tileIndex(tiles, command.tileId);
      if (index < 0) return failWith(missingTile(command.tileId));
      tiles.splice(index, 1);
      // The removed tile's placement becomes an orphan; layout normalization
      // (the session's next step) prunes it.
      return { ok: true, dashboard, value: undefined };
    }

    case 'move-tile': {
      const index = tileIndex(tiles, command.tileId);
      if (index < 0) return failWith(missingTile(command.tileId));
      const { toIndex } = command;
      // Out-of-range indexes FAIL; they are never silently clamped (#280).
      if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= tiles.length) {
        return failWith(diagnostic(['tiles'], 'dashboard-command-index-out-of-range',
          `Move index ${JSON.stringify(toIndex)} is out of range 0..${tiles.length - 1}`));
      }
      const [moved] = tiles.splice(index, 1);
      tiles.splice(toIndex, 0, moved);
      return { ok: true, dashboard, value: undefined };
    }

    case 'update-tile': {
      const index = tileIndex(tiles, command.tileId);
      if (index < 0) return failWith(missingTile(command.tileId));
      const { patch } = command;
      if (!isObject(patch)) {
        return failWith(diagnostic(['tiles', index], 'dashboard-command-invalid-patch',
          'Tile patch must be an object'));
      }
      if (Object.hasOwn(patch, 'id') || Object.hasOwn(patch, 'queryId')) {
        return failWith(diagnostic(['tiles', index], 'dashboard-command-invalid-patch',
          'Tile patch may not change tile id or queryId'));
      }
      // A field patch on the tile: a top-level `null` member deletes that
      // field; any other top-level member replaces it wholesale (cloned).
      // `presentation` is the ONE exception — it is merged ONE LEVEL so a
      // caller can set/clear `variant` and `override` independently without
      // destroying the other: each sub-field is replaced wholesale (a `null`
      // sub-field deletes it). Crucially the merge stops there — an `override`
      // VALUE is stored verbatim (it is RFC 7396 patch data whose nested
      // `null`s are meaningful and must NOT be consumed by a deeper merge).
      const patched = { ...(tiles[index] as Record<string, unknown>) };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) { delete patched[key]; continue; }
        if (key === 'presentation') { patched.presentation = mergeTilePresentation(patched.presentation, value); continue; }
        patched[key] = cloneJson(value);
      }
      tiles[index] = patched;
      return { ok: true, dashboard, value: undefined };
    }

    case 'update-placement': {
      const index = tileIndex(tiles, command.tileId);
      if (index < 0) return failWith(missingTile(command.tileId));
      // Validated through the ACTIVE engine's own plugin (`ctx.plugin`,
      // resolved by the session from the current document — grid: span
      // 1..12; flow: span 1..3) rather than a hardcoded flow plugin (#291).
      const placementDiags = ctx.plugin.validatePlacement(command.placement,
        ['layout', 'items', command.tileId]);
      if (placementDiags.length) return { ok: false, diagnostics: placementDiags };
      if (ctx.plugin.type === 'grafana-grid') {
        setGridPlacement(dashboard.layout, command.tileId, cloneJson(command.placement));
      } else {
        setFlowPlacement(dashboard.layout, command.tileId, cloneJson(command.placement));
      }
      return { ok: true, dashboard, value: undefined };
    }

    // change-layout: the load/version/fallback failures are the session's
    // registry-resolution step; a normalization that produces an invalid
    // document is the session's validation step. Here we install the new
    // layout AND, when it is an engine switch (#291 owner decision 3),
    // convert placements between engines:
    //  - flow -> grafana-grid: seed every tile's grid placement from its
    //    current flow placement (`resolvePlacement` fills the flow default
    //    for a tile with none), converted via `gridSpanFromFlowSpan`, and
    //    snapshot the CURRENT flow layout (minus its own `fallback`, which a
    //    flow primary never carries) as the new `layout.fallback`.
    //  - grafana-grid -> flow: restore `layout.fallback` (kept continuously
    //    valid by the grid-mutation fallback regeneration above) as the new
    //    flow primary, dropping the `fallback` field itself (a flow primary
    //    IS the fallback engine, so it never carries one). Switching to a
    //    flow PRESET while grid is active is exactly this restore, then
    //    applying `command.layout.preset` on top — the caller (Wave 3 UI)
    //    only ever needs to send `{ type: 'flow', version: 1, preset? }`.
    //  - anything else (same-engine change, e.g. a flow preset switch while
    //    flow is already active, or an unrecognized combination): install the
    //    (cloned) new layout document wholesale, as `change-layout` always
    //    did before #291. A regenerated fallback still backstops a wholesale
    //    grid layout that did not already carry one.
    case 'change-layout': {
      const currentType = dashboard.layout.type;
      const targetType = command.layout.type;

      if (currentType === 'flow' && targetType === 'grafana-grid') {
        const flowItems = dashboard.layout.items ?? {};
        const gridItems: Record<string, unknown> = {};
        for (const tile of tiles) {
          if (!isObject(tile) || typeof tile.id !== 'string') continue;
          const flowPlacement = resolvePlacement(flowItems[tile.id]);
          gridItems[tile.id] = { span: gridSpanFromFlowSpan(flowPlacement.span), height: flowPlacement.height };
        }
        // Drop the (never-present-on-a-flow-primary) `fallback` field before
        // snapshotting — a flow primary IS the fallback engine, so it never
        // carries one, but this stays defensive against a malformed input.
        const { fallback: _droppedFallback, ...flowSnapshot } = dashboard.layout;
        dashboard.layout = {
          type: 'grafana-grid', version: 1, items: gridItems, fallback: flowSnapshot,
        } as unknown as DashboardLayoutDocumentV1;
        return { ok: true, dashboard, value: undefined };
      }

      if (currentType === 'grafana-grid' && targetType === 'flow') {
        const fallback = dashboard.layout.fallback;
        if (!fallback) {
          return failWith(diagnostic(['layout'], 'dashboard-command-layout-fallback-missing',
            'No flow@1 fallback to restore for this Dashboard'));
        }
        const restored = cloneJson(fallback) as unknown as Record<string, unknown>;
        const preset = typeof command.layout.preset === 'string' ? command.layout.preset : undefined;
        if (preset !== undefined) restored.preset = preset;
        dashboard.layout = restored as unknown as DashboardLayoutDocumentV1;
        return { ok: true, dashboard, value: undefined };
      }

      dashboard.layout = cloneJson(command.layout);
      regenerateGridFallback(dashboard);
      return { ok: true, dashboard, value: undefined };
    }
  }
}
