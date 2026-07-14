import { formatKpiValue, kpiDeltaState } from '../core/kpi.js';
import { h } from './dom.js';

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

export function renderKpiPanel(normalized) {
  const data = normalized || { items: [], diagnostics: [] };
  const errors = data.diagnostics.filter((item) => item.severity === 'error' || item.code === 'kpi-no-data');
  if (errors.length) return h('div', { class: 'kpi-state' }, ...data.diagnostics.map(diagnosticNode));
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
  return h('div', { class: 'kpi-panel' },
    h('div', { class: 'kpi-grid', role: 'group', 'aria-label': 'Key performance indicators' }, ...cards),
    ...(warnings.length ? [h('div', { class: 'kpi-warnings' }, ...warnings.map(diagnosticNode))] : []));
}
