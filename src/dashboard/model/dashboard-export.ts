// Portable-bundle export builders (#280/#287 "Canonical output ordering",
// "Portable dependency closure"). Pure structural assembly only — callers
// pass the returned PortableBundleV2 to `encodePortableBundleJson`
// (portable-bundle-codec.ts) for validation/canonical encoding; this module
// never encodes or validates itself so it stays independently unit-testable.
//
// Two builders, two ordering contracts:
//   - `buildDashboardExportBundle` — one Dashboard's dependency closure: only
//     the queries it actually references (bundle-order.ts), in dependency
//     order, so a single-Dashboard export never drags in unrelated queries.
//   - `buildWorkspaceExportBundle` — the full workspace catalog: every saved
//     query in its existing catalog/authoring order (never reordered by
//     Dashboard usage), plus EVERY stored Dashboard in workspace order — a
//     workspace export never truncates to the one Dashboard the current UI
//     happens to expose (#424).
//
// Both deep-clone every resource they emit — an export must never let the
// caller's in-memory workspace/session state (including Dashboard `revision`)
// be mutated through the returned bundle, and must never mutate its inputs.

import { cloneJson } from '../../core/saved-query.js';
import { dashboardDependencyQueryIds } from './bundle-order.js';
import {
  CURRENT_PORTABLE_BUNDLE_VERSION, PORTABLE_BUNDLE_FORMAT, PORTABLE_BUNDLE_V2_SCHEMA_ID,
} from './portable-bundle-codec.js';
import type {
  DashboardDocumentV2, PortableBundleV2, SavedQueryV2, StoredWorkspaceV5,
} from '../../generated/json-schema.types.js';

function bundleEnvelope(
  nowISO: string, queries: SavedQueryV2[], dashboards: DashboardDocumentV2[],
): PortableBundleV2 {
  return {
    $schema: PORTABLE_BUNDLE_V2_SCHEMA_ID as PortableBundleV2['$schema'],
    format: PORTABLE_BUNDLE_FORMAT as PortableBundleV2['format'],
    version: CURRENT_PORTABLE_BUNDLE_VERSION as PortableBundleV2['version'],
    exportedAt: nowISO,
    queries,
    dashboards,
  };
}

/** Build a portable bundle for exporting ONE Dashboard: the Dashboard plus
 *  exactly the queries it depends on (tiles then filter sources, each once,
 *  in `dashboardDependencyQueryIds` order); a dependency id absent from
 *  `queries` is skipped rather than failing. Unrelated catalog queries never
 *  appear. Deep-clones both the Dashboard and every emitted query — the
 *  input `dashboard` (and its `revision`) is left byte-for-byte unchanged. */
export function buildDashboardExportBundle(
  dashboard: DashboardDocumentV2, queries: readonly SavedQueryV2[], nowISO: string,
): PortableBundleV2 {
  const byId = new Map<string, SavedQueryV2>();
  for (const query of queries) {
    if (!byId.has(query.id)) byId.set(query.id, query);
  }
  const bundleQueries: SavedQueryV2[] = [];
  for (const id of dashboardDependencyQueryIds(dashboard)) {
    const query = byId.get(id);
    if (query) bundleQueries.push(cloneJson(query));
  }
  return bundleEnvelope(nowISO, bundleQueries, [cloneJson(dashboard)]);
}

/** Build a portable bundle for exporting the WHOLE workspace: every saved
 *  query in its existing catalog order (never reordered by Dashboard tile
 *  usage) plus EVERY stored Dashboard in workspace order — including ones the
 *  current single-surface UI does not expose (#424). Deep-clones every emitted
 *  resource — the input `workspace` (including each Dashboard `revision`) is
 *  left byte-for-byte unchanged. */
export function buildWorkspaceExportBundle(
  workspace: StoredWorkspaceV5, nowISO: string,
): PortableBundleV2 {
  const queries = cloneJson(workspace.queries);
  const dashboards = cloneJson(workspace.dashboards);
  return bundleEnvelope(nowISO, queries, dashboards);
}
