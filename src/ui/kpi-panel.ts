import { formatKpiValue, formatKpiValueParts, kpiDeltaState } from '../core/kpi.js';
import { h } from './dom.js';
import type { KpiResult } from '../core/panel-cfg.js';

/** The `.kpi-grid`/`.dash-kpi-stream` group's shared accessible name (#240) —
 *  one literal, not duplicated between kpi-panel.js and the dashboard band. */
export const KPI_STREAM_ARIA: { role: string; 'aria-label': string } = { role: 'group', 'aria-label': 'Key performance indicators' };

/** One diagnostic as kpi.js's `readKpiFields` produces it (severity/code/
 *  message, with an optional offending column) — the same shape
 *  dashboard-kpi-band.ts's own `KpiDiagnostic` mirrors for its band warnings. */
export interface KpiDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  columnName?: string;
}

/** A KPI field's resolved display metadata (core/field-config.js's shape, as
 *  kpi.js's `resolveKpiPresentation` produces it) — only the members this
 *  module's card renderer reads. */
interface KpiDeltaPresentation {
  displayName?: string;
  decimals?: number;
  unit?: string;
  positiveIsGood?: boolean;
  show?: boolean;
}
interface KpiPresentation {
  displayName: string;
  description?: string;
  decimals?: number;
  unit?: string;
  color?: string;
  noValue?: string;
  delta?: KpiDeltaPresentation;
  hidden?: boolean;
}

/** One normalized KPI field as kpi.js's `readKpiFields` produces it — the
 *  shape this module's card renderer reads (value/valueType/delta/deltaType/
 *  presentation); kpi.js also carries columnName/columnIndex/sourceType/kind,
 *  untouched here. */
interface KpiItem {
  value: unknown;
  valueType: string;
  delta: unknown;
  deltaType: string | null;
  presentation: KpiPresentation;
}

function diagnosticNode(diagnostic: KpiDiagnostic): HTMLElement {
  return h('div', {
    class: `kpi-diagnostic is-${diagnostic.severity}`,
    role: diagnostic.severity === 'error' ? 'alert' : 'status',
  }, diagnostic.message);
}

function absoluteValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value < 0n ? -value : value;
  if (typeof value === 'string') return value.trim().replace(/^[+-]/, '');
  return Math.abs(value as number);
}

function isBlockingDiagnostic(item: KpiDiagnostic): boolean {
  return item.severity === 'error' || item.code === 'kpi-no-data';
}

/** `renderKpiCards`'s return shape — dashboard-kpi-band.ts casts its own
 *  wrapper over this function to a structurally identical (not imported)
 *  shape, so keep the two in lockstep by hand if either changes. */
export interface KpiCardsResult {
  cards: HTMLElement[];
  warnings: KpiDiagnostic[];
  errors: KpiDiagnostic[];
}

/**
 * Shared lower-level KPI card rendering (#240): the individual `.kpi-card`
 * nodes, decoupled from the workbench's `.kpi-panel/.kpi-grid` wrapper, so the
 * Dashboard KPI band can flatten cards from several consecutive favorites
 * into one stream. `errors` mirrors the pre-#240 blocking-diagnostic rule
 * exactly (an `kpi-no-data` info-severity diagnostic is still blocking) —
 * changing that rule would regress the zero-row state for both callers.
 */
export function renderKpiCards(normalized?: KpiResult | null): KpiCardsResult {
  const data = normalized || { items: [], diagnostics: [] };
  // `as`: readKpiFields (kpi.js, unconverted) is the only producer of a real
  // KpiResult; its `items`/`diagnostics` are always shaped exactly like
  // KpiItem/KpiDiagnostic below — panel-cfg.ts's KpiResult deliberately only
  // pins `unknown[]` (it never reads inside an item), so this module narrows
  // it at its own read site instead.
  const diagnostics = data.diagnostics as KpiDiagnostic[];
  const errors = diagnostics.filter(isBlockingDiagnostic);
  if (errors.length) return { cards: [], warnings: [], errors: diagnostics };
  const items = data.items as KpiItem[];
  const cards = items.map((item) => {
    const presentation = item.presentation;
    const label = h('div', { class: 'kpi-label' }, presentation.displayName);
    // #316: number and unit render as separate spans (`.kpi-value-number`/
    // `.kpi-value-unit`) so CSS can keep them visually glued as one value —
    // `.kpi-value`'s concatenated textContent still equals formatKpiValue's
    // flat string exactly (no space is added between the two spans).
    const { rendered, unit } = formatKpiValueParts({ value: item.value, clickhouseType: item.valueType, presentation });
    const valueChildren: HTMLElement[] = [h('span', { class: 'kpi-value-number' }, rendered)];
    if (unit) valueChildren.push(h('span', { class: 'kpi-value-unit' }, unit));
    const value = h('div', { class: 'kpi-value' }, ...valueChildren);
    const children: HTMLElement[] = [label, value];
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
  const warnings = diagnostics.filter((item) => item.severity === 'warning');
  return { cards, warnings, errors: [] };
}

export function renderKpiPanel(normalized?: KpiResult | null): HTMLElement {
  const { cards, warnings, errors } = renderKpiCards(normalized);
  if (errors.length) return h('div', { class: 'kpi-state' }, ...errors.map(diagnosticNode));
  return h('div', { class: 'kpi-panel' },
    h('div', { class: 'kpi-grid', ...KPI_STREAM_ARIA }, ...cards),
    ...(warnings.length ? [h('div', { class: 'kpi-warnings' }, ...warnings.map(diagnosticNode))] : []));
}
