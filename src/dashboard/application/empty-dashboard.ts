// Canonical empty Dashboard document. Shared by the Dashboard authoring
// session and the Workbench favorite -> tile bridge: both paths must mint the
// same valid document when a workspace legitimately has no Dashboard yet.

import { regenerateGridFallback } from '../layouts/grafana-grid-layout.js';
import type { DashboardDocumentV2 } from '../../generated/json-schema.types.js';

/** #429 phase 3: the one title every "New dashboard" prompt offers for
 *  editing (File menu, and the empty-workspace placeholder), so the two
 *  entry points share a literal instead of each hard-coding their own copy. */
export const DEFAULT_DASHBOARD_TITLE = 'Dashboard';

export function createEmptyDashboard(id: string, title: string = DEFAULT_DASHBOARD_TITLE): DashboardDocumentV2 {
  const dashboard: DashboardDocumentV2 = {
    documentVersion: 2 as const, id, title, revision: 1,
    layout: { type: 'grafana-grid' as const, version: 2 as const, preset: 'grid' as const, items: {} },
    tiles: [],
  };
  regenerateGridFallback(dashboard.layout, dashboard.tiles);
  return dashboard;
}
