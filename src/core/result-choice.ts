import type { QuerySpecV1 } from '../generated/json-schema.types.js';
import { CHART_TYPES as _CHART_TYPES } from './chart-data.js';
import { switchPanelType, type ChartFamilyType, type Column } from './panel-cfg.js';
import {
  patchQueryDashboard, patchQueryPanel, queryDashboard, queryPanel, type QueryRoot,
} from './saved-query.js';

// chart-data.js is unconverted (checkJs:false); CHART_TYPES' `value` is
// exactly one of the five chart PanelCfg type literals (verified against the
// wrapped module body — the same fact panel-cfg.ts's own wrapper relies on).
const CHART_TYPES = _CHART_TYPES as { value: ChartFamilyType; label: string }[];

/** The panel types the Result-choice picker actually offers as options —
 *  `table` is deliberately excluded (see PICKABLE_PANEL_TYPES below). */
export type PickablePanelType = 'kpi' | ChartFamilyType | 'logs' | 'text' | 'image';

/** One Panel-arm option in the Result-choice picker. */
export interface PanelResultChoice {
  id: string;
  kind: 'panel';
  panelType: PickablePanelType;
  label: string;
}
/** One Dashboard-role option in the Result-choice picker (currently only Filter). */
export interface RoleResultChoice {
  id: string;
  kind: 'role';
  role: 'filter';
  label: string;
}
export type ResultChoice = PanelResultChoice | RoleResultChoice;

export const PANEL_RESULT_CHOICES: readonly PanelResultChoice[] = Object.freeze([
  { id: 'panel:kpi', kind: 'panel', panelType: 'kpi', label: 'KPI' },
  ...CHART_TYPES.map(({ value, label }): PanelResultChoice =>
    ({ id: `panel:${value}`, kind: 'panel', panelType: value, label })),
  { id: 'panel:logs', kind: 'panel', panelType: 'logs', label: 'Logs' },
  { id: 'panel:text', kind: 'panel', panelType: 'text', label: 'Text' },
  { id: 'panel:image', kind: 'panel', panelType: 'image', label: 'Image' },
]);

export const DASHBOARD_ROLE_RESULT_CHOICES: readonly RoleResultChoice[] = Object.freeze([
  { id: 'role:filter', kind: 'role', role: 'filter', label: 'Filter' },
]);

// The panel types the picker actually offers as options. `table` is
// deliberately NOT among them — its surface is the adjacent Table result-view
// button, so it maps to the `(auto)` picker entry instead of a `panel:table`
// value that matches no option (which would leave the select blank with no way
// back to Table).
const PICKABLE_PANEL_TYPES: Set<PickablePanelType> = new Set(PANEL_RESULT_CHOICES.map((choice) => choice.panelType));

export function effectiveDashboardRole(spec: QuerySpecV1 | null | undefined): string {
  const role = spec?.dashboard?.role;
  return typeof role === 'string' && role ? role : 'panel';
}

// The transient preview a role owns on initial Library launch — never a
// persisted `spec.view` (Filter has none to persist; #244). `null` defers to
// the query's persisted view / the caller's other fallbacks.
export function rolePreviewView(spec: QuerySpecV1 | null | undefined): string | null {
  switch (effectiveDashboardRole(spec)) {
    case 'filter':
      return 'filter';
    default:
      return null;
  }
}

export function resultChoiceForSpec(spec: QuerySpecV1 | null | undefined): string {
  if (effectiveDashboardRole(spec) === 'filter') return 'role:filter';
  const type = spec?.panel?.cfg?.type;
  // A pickable explicit type selects its own option; anything else (table, an
  // absent panel, or an unknown/future type) resolves to `panel:auto`. The
  // cast below is exactly the membership check `.has` itself performs — a
  // `false` result for a non-pickable/unknown `type` falls straight to `panel:auto`.
  return type && PICKABLE_PANEL_TYPES.has(type as PickablePanelType) ? `panel:${type}` : 'panel:auto';
}

export function applyResultChoice(query: unknown, choice: ResultChoice | null | undefined, columns: Column[] = []): QueryRoot {
  // No-op passthrough: the caller gets back exactly the query root it passed
  // (real callers hold a QueryRoot; `query` stays `unknown` because this is
  // the same untrusted-ingress boundary the patchQuery* helpers guard).
  if (!choice || (choice.kind !== 'panel' && choice.kind !== 'role')) return query as QueryRoot;
  if (choice.kind === 'role') return patchQueryDashboard(query, { role: choice.role });
  let next = query;
  // Flip a non-panel role back to the implicit default while PRESERVING any
  // other dashboard sub-fields (forward-compat) — clearing the object would
  // drop them.
  if ((queryDashboard(query)?.role || 'panel') !== 'panel') {
    next = patchQueryDashboard(next, { role: 'panel' });
  }
  const panel = switchPanelType(queryPanel(next), choice.panelType, columns);
  return patchQueryPanel(next, { cfg: panel.cfg, key: panel.key ?? undefined });
}
