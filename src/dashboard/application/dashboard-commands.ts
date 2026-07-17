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
import { deriveFlowPlacement, setFlowPlacement } from '../layouts/flow-layout.js';
import type { DashboardLayoutPlugin } from '../layouts/flow-layout.js';
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

/** Apply one command to an ISOLATED clone of `draft`, returning the candidate
 *  dashboard or command-level diagnostics. The input `draft` is never
 *  mutated. */
export function applyCommand(
  draft: DashboardDocumentV1, command: DashboardCommand, ctx: ApplyCommandContext,
): ApplyCommandResult {
  const dashboard = cloneJson(draft);
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
      const placement = deriveFlowPlacement(sizeHints);
      if (placement) setFlowPlacement(dashboard.layout, id, placement);
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
      // A SHALLOW field patch: a `null` member deletes that tile field; any
      // other member replaces it wholesale (cloned). Deliberately NOT a deep
      // merge — `presentation.override` is itself stored RFC 7396 patch data,
      // so a deep merge would consume its meaningful `null`s.
      const patched = { ...(tiles[index] as Record<string, unknown>) };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete patched[key];
        else patched[key] = cloneJson(value);
      }
      tiles[index] = patched;
      return { ok: true, dashboard, value: undefined };
    }

    case 'update-placement': {
      const index = tileIndex(tiles, command.tileId);
      if (index < 0) return failWith(missingTile(command.tileId));
      const placementDiags = ctx.plugin.validatePlacement(command.placement,
        ['layout', 'items', command.tileId]);
      if (placementDiags.length) return { ok: false, diagnostics: placementDiags };
      setFlowPlacement(dashboard.layout, command.tileId, cloneJson(command.placement));
      return { ok: true, dashboard, value: undefined };
    }

    // change-layout: the load/version/fallback failures are the session's
    // `resolveActiveLayoutPlugin` step; a normalization that produces an
    // invalid document is the session's validation step. Here we only install
    // the (cloned) new layout.
    default:
      dashboard.layout = cloneJson(command.layout);
      return { ok: true, dashboard, value: undefined };
  }
}
