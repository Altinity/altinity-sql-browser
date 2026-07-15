import { serializeParamValue } from './param-serialize.js';
import { validateParamValue } from './param-validate.js';
import { diagnostic } from './diagnostics.js';

export function mergeDashboardFilterHelpers({ providers = [], controls = [], values = {}, active = {} } = {}) {
  const diagnostics = providers.flatMap((provider) => provider.diagnostics || []);
  const controlsByName = new Map(controls.map((control) => [control.name, control]));
  const byName = new Map();
  for (const provider of providers) {
    for (const helper of provider.helpers || []) {
      const list = byName.get(helper.name) || [];
      list.push({ provider, helper });
      byName.set(helper.name, list);
    }
  }
  const fields = {};
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
    let invalid = null;
    for (let optionIndex = 0; optionIndex < helper.options.length; optionIndex++) {
      const option = helper.options[optionIndex];
      const verdict = validateParamValue(control.type, option.value);
      const serialized = serializeParamValue(option.value, control.type, name);
      if (verdict.status === 'invalid' || verdict.status === 'incomplete' || !serialized.ok) {
        invalid = { optionIndex, reason: verdict.reason || serialized.error };
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

  const nextValues = { ...values };
  const nextActive = { ...active };
  const changed = [];
  for (const [name, field] of Object.entries(fields)) {
    if (!active[name]) continue;
    if (field.options.some((option) => option.value === String(values[name] ?? ''))) continue;
    nextActive[name] = false;
    changed.push(name);
  }
  return { fields, diagnostics, values: nextValues, active: nextActive, changed };
}
