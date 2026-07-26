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

import { cloneJson } from '../../core/saved-query.js';
import type { DashboardDocumentV1, DashboardDocumentV2 } from '../../generated/json-schema.types.js';

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
  return { ...rest, documentVersion: 2 };
}
