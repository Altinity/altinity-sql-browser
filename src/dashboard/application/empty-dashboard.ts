// Canonical empty Dashboard document. Shared by the Dashboard authoring
// session and the Workbench favorite -> tile bridge: both paths must mint the
// same valid document when a StoredWorkspaceV1 legitimately has dashboard:null.

import { deriveFlowFallback } from '../layouts/grafana-grid-layout.js';
import type { DashboardDocumentV1 } from '../../generated/json-schema.types.js';

export function createEmptyDashboard(id: string): DashboardDocumentV1 {
  const layout = { type: 'grafana-grid' as const, version: 1 as const, items: {} };
  return {
    documentVersion: 1, id, title: 'Dashboard', revision: 1,
    layout: { ...layout, fallback: deriveFlowFallback(layout, []) },
    filters: [], tiles: [],
  };
}
