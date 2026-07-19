import type { Panel } from '../generated/json-schema.types.js';
import { detectSqlFormat as _detectSqlFormat } from './format.js';
import { queryPanel } from './saved-query.js';

// format.js is unconverted (checkJs:false); detectSqlFormat's own body returns
// either the authored FORMAT keyword text or `null` (verified against the
// wrapped function body) — pinning that here saves this file from `unknown`.
const detectSqlFormat = _detectSqlFormat as (sql: string) => string | null;

export function isKpiPanel(panel: Panel | null | undefined): boolean {
  return panel?.cfg?.type === 'kpi';
}

/** True when `panel`'s resolved cfg is the Image (PNG) arm (#307) — the
 *  explicit-panel type whose transport `panelExecution` also owns (a single
 *  binary FORMAT PNG result, not a structured streaming one). */
export function isImagePanel(panel: Panel | null | undefined): boolean {
  return panel?.cfg?.type === 'image';
}

/** #307 UX fix: should an UNCONFIGURED panel-role tile (no explicit `panel.cfg`
 *  at all — `panel` is null or has no `cfg`) be treated as an Image panel? True
 *  only when the authored SQL's trailing FORMAT clause is exactly `PNG`
 *  (case-insensitive, via `detectSqlFormat`). An explicitly-typed panel (any
 *  type, including a non-image one) never re-types here — this is purely the
 *  "nothing chosen yet" heuristic, parallel to `autoPanel`'s result-shape
 *  heuristic but keyed on the authored SQL rather than the result. */
export function shouldInferImagePanel(panel: Panel | Record<string, unknown> | null | undefined, sql: string): boolean {
  const cfg = panel && typeof panel === 'object' ? (panel as { cfg?: unknown }).cfg : undefined;
  if (cfg && typeof cfg === 'object') return false;
  const format = detectSqlFormat(sql);
  return !!format && format.toUpperCase() === 'PNG';
}

/** A saved query's explicit, known-typed panel payload, or null. Unknown
 *  panel-cfg shapes stay non-null-ish only through resolvePanel's diagnostic
 *  fallback. Shared by the Dashboard's ordinary-tile path and its KPI-band
 *  partitioning/execution (#240) so eligibility can never drift between them. */
export function explicitPanel(query: unknown): Panel | null {
  const panel = queryPanel(query);
  return panel && panel.cfg && typeof panel.cfg === 'object' ? panel : null;
}

/** The caller-owned execution defaults `panelExecution` may override — an open
 *  bag (format/rowLimit/params plus whatever else the caller's transport
 *  already carries), so a panel arm can override only the keys it owns. */
export interface PanelExecutionDefaults {
  format?: string;
  rowLimit?: number;
  /** ClickHouse HTTP params — the strict wire shape (`param_<name>` bindings,
   *  settings), so an execution seam can forward them without narrowing. */
  params?: Record<string, string | number>;
  [k: string]: unknown;
}

/** The transport `panelExecution` resolves: `owned` distinguishes an explicit
 *  KPI panel's request (which may still carry a rejection `error`, e.g. an
 *  authored FORMAT clash) from an unowned pass-through of the caller's own
 *  defaults untouched. */
export interface PanelExecutionResult {
  owned: boolean;
  error: string | null;
  params: Record<string, string | number>;
  format?: string;
  rowLimit?: number;
  [k: string]: unknown;
}

/** Resolve the transport owned by an explicit panel without changing SQL. */
export function panelExecution(
  panel: Panel | null | undefined,
  sql: string,
  defaults: PanelExecutionDefaults = {},
): PanelExecutionResult {
  if (isImagePanel(panel)) {
    const authoredFormat = detectSqlFormat(sql);
    if (!authoredFormat) {
      return {
        ...defaults,
        owned: true,
        error: 'Image panel requires an explicit FORMAT PNG clause.',
        params: { ...(defaults.params || {}) },
      };
    }
    if (authoredFormat.toUpperCase() !== 'PNG') {
      return {
        ...defaults,
        owned: true,
        error: `Image panel requires FORMAT PNG. Remove FORMAT ${authoredFormat} from the SQL.`,
        params: { ...(defaults.params || {}) },
      };
    }
    return {
      ...defaults,
      owned: true,
      error: null,
      format: 'PNG',
      // rowLimit is not meaningful for a binary (single-blob) result — kept
      // at 0 so a caller that still reads it (e.g. a shared row-cap gate)
      // never treats an image tile as a multi-row streaming result.
      rowLimit: 0,
      params: { ...(defaults.params || {}) },
    };
  }
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
