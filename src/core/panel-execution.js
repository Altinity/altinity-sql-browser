import { detectSqlFormat } from './format.js';
import { queryPanel } from './saved-query.js';

export function isKpiPanel(panel) {
  return panel?.cfg?.type === 'kpi';
}

/** A saved query's explicit, known-typed panel payload, or null. Unknown
 *  panel-cfg shapes stay non-null-ish only through resolvePanel's diagnostic
 *  fallback. Shared by the Dashboard's ordinary-tile path and its KPI-band
 *  partitioning/execution (#240) so eligibility can never drift between them. */
export function explicitPanel(query) {
  const panel = queryPanel(query);
  return panel && panel.cfg && typeof panel.cfg === 'object' ? panel : null;
}

/** Resolve the transport owned by an explicit panel without changing SQL. */
export function panelExecution(panel, sql, defaults = {}) {
  if (!isKpiPanel(panel)) return { ...defaults, owned: false, error: null, params: { ...(defaults.params || {}) } };
  const authoredFormat = detectSqlFormat(sql);
  if (authoredFormat) {
    return {
      ...defaults,
      owned: true,
      error: `KPI panel owns the result format. Remove FORMAT ${authoredFormat} from the SQL.`,
      params: { ...(defaults.params || {}) },
    };
  }
  return {
    ...defaults,
    owned: true,
    error: null,
    format: 'KPI',
    rowLimit: 2,
    params: {
      ...(defaults.params || {}),
      output_format_json_named_tuples_as_objects: 1,
      output_format_json_quote_decimals: 1,
    },
  };
}
