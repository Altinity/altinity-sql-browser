import { serializeParamValue as _serializeParamValue } from './param-serialize.js';
import { validateParamValue } from './param-validate.js';
import type { ParsedParamType } from './param-type.js';
import { diagnostic } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';
import type { FieldControl } from './param-pipeline.js';
import { reconcileSelection } from './filter-selection.js';

// `param-serialize.js` is unconverted (checkJs:false) — the same narrow
// result contract `param-pipeline.ts` declares for the same function.
type SerializeParamResult =
  | { ok: true; value: string }
  | { ok: false; error: string; structural?: boolean };
const serializeParamValue = _serializeParamValue as (
  value: unknown,
  type: string | ParsedParamType,
  name?: string,
) => SerializeParamResult;

/** `diagnostics.ts`'s shared `{severity, code, message, ...extra}` factory:
 *  every Dashboard/Filter-role diagnostic producer in this app (this module,
 *  `filter-options.js`, the provider merge below) composes it, so the extra
 *  per-diagnostic context (`helperName`, `sourceId`, `optionIndex`, …) is
 *  folded in via `Diagnostic`'s open index signature rather than named per
 *  caller. */
export interface FilterDiagnostic extends Diagnostic {
  /** Named (not just index-signature) because the dashboard's per-source Retry
   *  affordance dispatches on it for `filter-query-failed` diagnostics. */
  sourceId?: string;
}

/** One option a Filter helper column offers — the value bound into the
 *  consuming Panel's param and its display label. */
export interface FilterHelperOption {
  value: string;
  label: string;
}

/** One Filter helper column as `filter-options.js`'s `readFilterOptions`
 *  reports it, narrowed to the fields this module reads. Extra properties
 *  (`columnIndex`, `sourceType`, `shape`, `totalOptions`, `truncated`) pass
 *  through verbatim into a curated field via the index signature, so this
 *  module never has to name each one just to forward it. */
export interface FilterHelper {
  name: string;
  options: FilterHelperOption[];
  [key: string]: unknown;
}

/** One Filter-role query's contribution: its helper columns (empty on a
 *  failed/loading run) plus any diagnostics the run itself produced (a
 *  contract failure, a query error). */
export interface FilterProvider {
  sourceId: string;
  sourceName?: string;
  helpers?: FilterHelper[];
  diagnostics?: FilterDiagnostic[];
}

/** One curated field the dashboard filter bar renders: the matched helper's
 *  own properties plus the consuming Panel's declared type/optionality. */
export interface MergedFilterField extends FilterHelper {
  sourceId: string;
  sourceName?: string;
  declaredType: string;
  optional: boolean;
}

/** `mergeDashboardFilterHelpers`'s options bag. */
export interface MergeDashboardFilterHelpersInput {
  providers?: FilterProvider[];
  controls?: FieldControl[];
  values?: Record<string, unknown>;
  active?: Record<string, boolean>;
}

/** `mergeDashboardFilterHelpers`'s return shape. */
export interface MergeDashboardFilterHelpersResult {
  fields: Record<string, MergedFilterField>;
  diagnostics: FilterDiagnostic[];
  values: Record<string, unknown>;
  active: Record<string, boolean>;
  changed: string[];
}

export function mergeDashboardFilterHelpers({
  providers = [], controls = [], values = {}, active = {},
}: MergeDashboardFilterHelpersInput = {}): MergeDashboardFilterHelpersResult {
  const diagnostics: FilterDiagnostic[] = providers.flatMap((provider) => provider.diagnostics || []);
  const controlsByName = new Map<string, FieldControl>(
    controls.map((control): [string, FieldControl] => [control.name, control]),
  );
  const byName = new Map<string, { provider: FilterProvider; helper: FilterHelper }[]>();
  for (const provider of providers) {
    for (const helper of provider.helpers || []) {
      const list = byName.get(helper.name) || [];
      list.push({ provider, helper });
      byName.set(helper.name, list);
    }
  }
  const fields: Record<string, MergedFilterField> = {};
  for (const [name, candidates] of byName) {
    if (candidates.length > 1) {
      const labels = candidates.map(({ provider }) => provider.sourceName || provider.sourceId).join(', ');
      diagnostics.push(diagnostic('error', 'filter-duplicate-provider', `Multiple Filter queries provide "${name}": ${labels}.`, { helperName: name }));
      continue;
    }
    const { provider, helper } = candidates[0];
    const control = controlsByName.get(name);
    if (!control) {
      diagnostics.push(diagnostic('warning', 'filter-helper-unused', `Filter helper "${name}" has no current Panel consumer.`, { sourceId: provider.sourceId, helperName: name }));
      continue;
    }
    if (control.conflict?.length) {
      diagnostics.push(diagnostic('error', 'filter-target-type-conflict', `Filter target "${name}" has conflicting Panel declarations: ${control.conflict.join(' vs ')}.`, { sourceId: provider.sourceId, helperName: name }));
      continue;
    }
    let invalid: { optionIndex: number; reason?: string } | null = null;
    for (let optionIndex = 0; optionIndex < helper.options.length; optionIndex++) {
      const option = helper.options[optionIndex];
      const verdict = validateParamValue(control.type, option.value);
      const serialized = serializeParamValue(option.value, control.type, name);
      if (verdict.status === 'invalid' || verdict.status === 'incomplete' || !serialized.ok) {
        // `serialized.error` only exists on the `ok:false` branch — narrow
        // explicitly rather than reading it unconditionally (the pre-TS code
        // relied on JS returning `undefined` for the absent property, which
        // this reproduces exactly for the `serialized.ok` case).
        invalid = { optionIndex, reason: verdict.reason || (serialized.ok ? undefined : serialized.error) };
        break;
      }
    }
    if (invalid) {
      diagnostics.push(diagnostic('error', 'filter-option-consumer-invalid', `Filter helper "${name}" has an option incompatible with ${control.type}${invalid.reason ? `: ${invalid.reason}` : '.'}`, { sourceId: provider.sourceId, helperName: name, optionIndex: invalid.optionIndex }));
      continue;
    }
    fields[name] = {
      ...helper,
      sourceId: provider.sourceId,
      sourceName: provider.sourceName,
      declaredType: control.type,
      optional: control.optional,
    };
  }

  const nextValues: Record<string, unknown> = { ...values };
  const nextActive: Record<string, boolean> = { ...active };
  const changed: string[] = [];
  for (const [name, field] of Object.entries(fields)) {
    if (!active[name]) continue;
    const committed = values[name];
    if (Array.isArray(committed)) {
      // #189: a multiselect (Array-contract) filter's committed value is a
      // real string array — it must NEVER go through the scalar `String(...)`
      // comparison below (which would stringify `['a','b']` as `"a,b"` and
      // never match any option). `reconcileSelection` (filter-selection.ts)
      // is the same pure decision core the multiselect control itself uses
      // for this exact refresh.
      const reconciled = reconcileSelection(committed as string[], field.options);
      if (reconciled.deactivate) {
        // Every previously-selected value is gone: deactivate, but KEEP the
        // dormant array untouched (`nextValues[name]` stays the ORIGINAL
        // committed array) — matches the scalar path's own reactivation
        // policy (a cleared filter keeps its retained value).
        nextActive[name] = false;
        changed.push(name);
      } else {
        // Non-empty intersection: the value updates to the canonical (fresh
        // option order) survivors — even a pure reorder/label-only refresh
        // (`waveNeeded: false`) still updates the value, it just isn't a
        // change a caller needs to re-run anything for.
        nextValues[name] = reconciled.value;
        if (reconciled.waveNeeded) changed.push(name);
      }
      continue;
    }
    if (field.options.some((option) => option.value === String(committed ?? ''))) continue;
    nextActive[name] = false;
    changed.push(name);
  }
  return { fields, diagnostics, values: nextValues, active: nextActive, changed };
}
