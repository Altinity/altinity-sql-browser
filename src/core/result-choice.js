import { CHART_TYPES } from './chart-data.js';
import { switchPanelType } from './panel-cfg.js';
import {
  patchQueryDashboard, patchQueryPanel, queryDashboard, queryPanel,
} from './saved-query.js';

export const PANEL_RESULT_CHOICES = Object.freeze([
  { id: 'panel:kpi', kind: 'panel', panelType: 'kpi', label: 'KPI' },
  ...CHART_TYPES.map(({ value, label }) => ({ id: `panel:${value}`, kind: 'panel', panelType: value, label })),
  { id: 'panel:logs', kind: 'panel', panelType: 'logs', label: 'Logs' },
  { id: 'panel:text', kind: 'panel', panelType: 'text', label: 'Text' },
]);

export const DASHBOARD_ROLE_RESULT_CHOICES = Object.freeze([
  { id: 'role:filter', kind: 'role', role: 'filter', label: 'Filter' },
]);

// The panel types the picker actually offers as options. `table` is
// deliberately NOT among them — its surface is the adjacent Table result-view
// button, so it maps to the `(auto)` picker entry instead of a `panel:table`
// value that matches no option (which would leave the select blank with no way
// back to Table).
const PICKABLE_PANEL_TYPES = new Set(PANEL_RESULT_CHOICES.map((choice) => choice.panelType));

export function effectiveDashboardRole(spec) {
  const role = spec?.dashboard?.role;
  return typeof role === 'string' && role ? role : 'panel';
}

export function resultChoiceForSpec(spec) {
  if (effectiveDashboardRole(spec) === 'filter') return 'role:filter';
  const type = spec?.panel?.cfg?.type;
  // A pickable explicit type selects its own option; anything else (table, an
  // absent panel, or an unknown/future type) resolves to `panel:auto`.
  return type && PICKABLE_PANEL_TYPES.has(type) ? `panel:${type}` : 'panel:auto';
}

export function applyResultChoice(query, choice, columns = []) {
  if (!choice || (choice.kind !== 'panel' && choice.kind !== 'role')) return query;
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
