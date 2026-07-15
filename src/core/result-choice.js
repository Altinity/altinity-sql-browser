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

export function effectiveDashboardRole(spec) {
  const role = spec?.dashboard?.role;
  return typeof role === 'string' && role ? role : 'panel';
}

export function resultChoiceForSpec(spec) {
  return effectiveDashboardRole(spec) === 'filter'
    ? 'role:filter'
    : `panel:${spec?.panel?.cfg?.type || 'auto'}`;
}

export function applyResultChoice(query, choice, columns = []) {
  if (!choice || (choice.kind !== 'panel' && choice.kind !== 'role')) return query;
  if (choice.kind === 'role') return patchQueryDashboard(query, { role: choice.role });
  let next = query;
  if ((queryDashboard(query)?.role || 'panel') !== 'panel') {
    next = patchQueryDashboard(next, { role: 'panel' });
  }
  const panel = switchPanelType(queryPanel(next), choice.panelType, columns);
  return patchQueryPanel(next, { cfg: panel.cfg, key: panel.key ?? undefined });
}
