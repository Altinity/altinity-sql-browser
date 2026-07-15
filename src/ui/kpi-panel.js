import { formatKpiValue, kpiDeltaState } from '../core/kpi.js';
import { h } from './dom.js';

/** The `.kpi-grid`/`.dash-kpi-stream` group's shared accessible name (#240) —
 *  one literal, not duplicated between kpi-panel.js and the dashboard band. */
export const KPI_STREAM_ARIA = { role: 'group', 'aria-label': 'Key performance indicators' };

function diagnosticNode(diagnostic) {
  return h('div', {
    class: `kpi-diagnostic is-${diagnostic.severity}`,
    role: diagnostic.severity === 'error' ? 'alert' : 'status',
  }, diagnostic.message);
}

function absoluteValue(value) {
  if (typeof value === 'bigint') return value < 0n ? -value : value;
  if (typeof value === 'string') return value.trim().replace(/^[+-]/, '');
  return Math.abs(value);
}

function isBlockingDiagnostic(item) {
  return item.severity === 'error' || item.code === 'kpi-no-data';
}

/**
 * Shared lower-level KPI card rendering (#240): the individual `.kpi-card`
 * nodes, decoupled from the workbench's `.kpi-panel/.kpi-grid` wrapper, so the
 * Dashboard KPI band can flatten cards from several consecutive favorites
 * into one stream. `errors` mirrors the pre-#240 blocking-diagnostic rule
 * exactly (an `kpi-no-data` info-severity diagnostic is still blocking) —
 * changing that rule would regress the zero-row state for both callers.
 */
export function renderKpiCards(normalized) {
  const data = normalized || { items: [], diagnostics: [] };
  const errors = data.diagnostics.filter(isBlockingDiagnostic);
  if (errors.length) return { cards: [], warnings: [], errors: data.diagnostics };
  const cards = data.items.map((item) => {
    const presentation = item.presentation;
    const label = h('div', { class: 'kpi-label' }, presentation.displayName);
    const value = h('div', { class: 'kpi-value' }, formatKpiValue({ value: item.value, clickhouseType: item.valueType, presentation }));
    const children = [label, value];
    if (presentation.description) children.push(h('div', { class: 'kpi-description' }, presentation.description));
    const delta = kpiDeltaState(item);
    if (delta) {
      const deltaPresentation = { ...presentation.delta, noValue: presentation.noValue };
      const arrow = delta.direction === 'up' ? '↑' : delta.direction === 'down' ? '↓' : '→';
      const deltaLabel = presentation.delta?.displayName ? `${presentation.delta.displayName} ` : '';
      children.push(h('div', {
        class: `kpi-delta is-${delta.semantic}`,
        'aria-label': `${presentation.delta?.displayName || 'Delta'} ${delta.direction} ${absoluteValue(delta.value)}`,
      }, arrow + ' ' + deltaLabel + formatKpiValue({ value: absoluteValue(delta.value), clickhouseType: item.deltaType, presentation: deltaPresentation })));
    }
    const card = h('section', { class: 'kpi-card', 'aria-label': presentation.displayName }, ...children);
    if (typeof presentation.color === 'string' && presentation.color) card.style.setProperty('--kpi-accent', presentation.color);
    return card;
  });
  const warnings = data.diagnostics.filter((item) => item.severity === 'warning');
  return { cards, warnings, errors: [] };
}

export function renderKpiPanel(normalized) {
  const { cards, warnings, errors } = renderKpiCards(normalized);
  if (errors.length) return h('div', { class: 'kpi-state' }, ...errors.map(diagnosticNode));
  return h('div', { class: 'kpi-panel' },
    h('div', { class: 'kpi-grid', ...KPI_STREAM_ARIA }, ...cards),
    ...(warnings.length ? [h('div', { class: 'kpi-warnings' }, ...warnings.map(diagnosticNode))] : []));
}
