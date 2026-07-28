// Creating one blank Dashboard-owned Panel (#515). Pure — no DOM,
// persistence, or id generation.
//
// The query and tile are one aggregate candidate: callers either validate and
// commit both or observe neither. Placement deliberately goes through the
// canonical `add-query-instance` command so this path inherits the same
// size-hint defaults, layout normalization, and grid-fallback regeneration as
// every other panel add.

import { SPEC_VERSION } from '../../core/saved-query.js';
import { PORTABLE_LIMITS } from '../model/portable-limits.js';
import { findDashboardStrict, replaceDashboard } from '../../workspace/workspace-dashboards.js';
import { applyCommand } from './dashboard-commands.js';
import type { ApplyCommandResult } from './dashboard-commands.js';
import { createQueryResolver } from './dashboard-query-resolver.js';
import { resolveLayoutPluginSync } from '../layouts/layout-registry.js';
import type { SavedQueryV2, StoredWorkspaceV5 } from '../../generated/json-schema.types.js';

export type PanelCreationAbort =
  | 'dashboard-missing'
  | 'dashboard-ambiguous'
  | 'tile-limit'
  | 'id-collision'
  | 'blank-name';

export type PanelCreationResult =
  | {
    ok: true;
    workspace: StoredWorkspaceV5;
    data: { queryId: string; tileId: string };
  }
  | { ok: false; reason: PanelCreationAbort };

export interface CreatePanelCandidateInput {
  latest: StoredWorkspaceV5;
  dashboardId: string;
  queryId: string;
  tileId: string;
  name: string;
  description: string;
}

const fail = (reason: PanelCreationAbort): PanelCreationResult => ({ ok: false, reason });

/**
 * Build the complete candidate for one new empty panel.
 *
 * Existing query and Dashboard objects are retained byte-for-byte except for
 * the one target Dashboard, whose revision advances exactly once.
 */
export function createPanelCandidate(input: CreatePanelCandidateInput): PanelCreationResult {
  const { latest, dashboardId, queryId, tileId } = input;
  const lookup = findDashboardStrict(latest, dashboardId);
  if (lookup.status !== 'ok') {
    return fail(lookup.status === 'missing' ? 'dashboard-missing' : 'dashboard-ambiguous');
  }
  const base = lookup.dashboard;
  if (base.tiles.length >= PORTABLE_LIMITS.maxTilesPerDashboard) return fail('tile-limit');
  if (latest.queries.some((query) => query.id === queryId)
    || base.tiles.some((tile) => tile.id === tileId)) {
    return fail('id-collision');
  }

  const name = input.name.trim();
  if (name === '') return fail('blank-name');
  const description = input.description.trim();
  const query: SavedQueryV2 = {
    id: queryId,
    sql: '',
    specVersion: SPEC_VERSION,
    spec: {
      name,
      ...(description === '' ? {} : { description }),
      dashboard: { role: 'panel' },
    },
  };
  const queries = [...latest.queries, query];
  const applied = applyCommand(base, { type: 'add-query-instance', queryId }, {
    resolver: createQueryResolver(queries),
    genTileId: () => tileId,
    plugin: resolveLayoutPluginSync(base.layout),
  }) as Extract<ApplyCommandResult, { ok: true }>;
  const normalized = resolveLayoutPluginSync(applied.dashboard.layout).normalize(applied.dashboard);
  const workspace = replaceDashboard({ ...latest, queries }, dashboardId, {
    ...normalized,
    revision: base.revision + 1,
  }) as StoredWorkspaceV5;

  return { ok: true, workspace, data: { queryId, tileId } };
}
