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
export type PickablePanelType = 'kpi' | ChartFamilyType | 'logs' | 'text';

/** One Panel-arm option in the Result-choice picker. */
export interface PanelResultChoice {
  id: string;
  kind: 'panel';
  panelType: PickablePanelType;
  label: string;
}
/** #447 removed `RoleResultChoice` (and the `DASHBOARD_ROLE_RESULT_CHOICES`
 *  list whose single entry was `role:filter`): the picker offers a FLAT list of
 *  real panel visualisations only, so every choice is a panel choice. */
export type ResultChoice = PanelResultChoice;

export const PANEL_RESULT_CHOICES: readonly PanelResultChoice[] = Object.freeze([
  { id: 'panel:kpi', kind: 'panel', panelType: 'kpi', label: 'KPI' },
  ...CHART_TYPES.map(({ value, label }): PanelResultChoice =>
    ({ id: `panel:${value}`, kind: 'panel', panelType: value, label })),
  { id: 'panel:logs', kind: 'panel', panelType: 'logs', label: 'Logs' },
  { id: 'panel:text', kind: 'panel', panelType: 'text', label: 'Text' },
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

// #447 removed `rolePreviewView`: the Filter role was the only role that owned
// a transient launch preview (#244), so no role has one left and every Library
// launch defers to the query's own persisted view.

export function resultChoiceForSpec(spec: QuerySpecV1 | null | undefined): string {
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
  // #447: no `choice.kind !== 'panel'` arm any more — `ResultChoice` has a
  // single member, so the only non-choice a caller can pass is null/undefined
  // (the picker's own "no matching option" miss).
  if (!choice) return query as QueryRoot;
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
