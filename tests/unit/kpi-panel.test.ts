import { describe, expect, it } from 'vitest';
import { formatKpiValue } from '../../src/core/kpi.js';
import { renderKpiCards, renderKpiPanel } from '../../src/ui/kpi-panel.js';

const item = (over: Record<string, unknown> = {}) => ({
  columnName: 'value', value: 12.4, valueType: 'Float64', delta: null, deltaType: null,
  presentation: { displayName: 'Value', noValue: '—', delta: {} }, ...over,
});

describe('renderKpiPanel', () => {
  it('renders accessible cards, descriptions, colors, and semantic deltas', () => {
    const node = renderKpiPanel({
      items: [item({
        delta: -1.5, deltaType: 'Float64',
        presentation: { displayName: 'Availability', description: 'Current service level', decimals: 1, unit: '%', color: '#123456', noValue: '—', delta: { displayName: 'Change', decimals: 1, unit: ' pp', positiveIsGood: false } },
      })],
      diagnostics: [{ severity: 'warning', code: 'warn', message: 'Ignored region' }],
    });
    expect(node.querySelector('.kpi-grid')!.getAttribute('aria-label')).toBe('Key performance indicators');
    expect(node.querySelector('.kpi-card')!.getAttribute('aria-label')).toBe('Availability');
    expect((node.querySelector('.kpi-card') as HTMLElement).style.getPropertyValue('--kpi-accent')).toBe('#123456');
    expect(node.querySelector('.kpi-value')!.textContent).toBe('12.4%');
    // #316: number and unit are separate spans, but concatenate back to the
    // exact same flat value text — no space is introduced between them.
    expect(node.querySelector('.kpi-value-number')!.textContent).toBe('12.4');
    expect(node.querySelector('.kpi-value-unit')!.textContent).toBe('%');
    expect(node.querySelector('.kpi-description')!.textContent).toBe('Current service level');
    expect(node.querySelector('.kpi-delta')!.classList.contains('is-good')).toBe(true);
    expect(node.querySelector('.kpi-delta')!.textContent).toBe('↓ Change 1.5 pp');
    expect(node.querySelector('.kpi-warnings')!.textContent).toContain('Ignored region');
  });
  it('renders no unit span when the field has no unit, and no delta element when there is no delta (#316)', () => {
    const node = renderKpiPanel({
      items: [item({ presentation: { displayName: 'Rows', noValue: '—', delta: {} } })],
      diagnostics: [],
    });
    const value = node.querySelector('.kpi-value')!;
    expect(value.querySelector('.kpi-value-number')!.textContent).toBe('12.4');
    expect(value.querySelector('.kpi-value-unit')).toBeNull();
    expect(value.textContent).toBe(formatKpiValue({ value: 12.4, clickhouseType: 'Float64', presentation: { noValue: '—' } }));
    expect(node.querySelector('.kpi-delta')).toBeNull();
  });
  it('keeps the full description text in the DOM even though CSS visually clamps it (#316)', () => {
    const longDescription = 'A very long description that would visually wrap past two lines in a narrow KPI card, but the complete text must still be readable by assistive technology.';
    const node = renderKpiPanel({
      items: [item({ presentation: { displayName: 'Rows', description: longDescription, noValue: '—', delta: {} } })],
      diagnostics: [],
    });
    expect(node.querySelector('.kpi-description')!.textContent).toBe(longDescription);
  });
  it('renders no-data and errors as visible states', () => {
    const noData = renderKpiPanel({ items: [], diagnostics: [{ severity: 'info', code: 'kpi-no-data', message: 'No data' }] });
    expect(noData.querySelector('[role="status"]')!.textContent).toBe('No data');
    const error = renderKpiPanel({ items: [], diagnostics: [{ severity: 'error', code: 'kpi-row-count', message: 'Expected 1 row, got 2' }] });
    expect(error.querySelector('[role="alert"]')!.textContent).toContain('got 2');
  });
  it('renders a neutral flat delta and tolerates a missing normalization result', () => {
    const node = renderKpiPanel({ items: [item({ delta: 0, deltaType: 'Int8' })], diagnostics: [] });
    expect(node.querySelector('.kpi-delta')!.textContent).toBe('→ 0');
    expect(node.querySelector('.kpi-delta')!.classList.contains('is-neutral')).toBe(true);
    expect(renderKpiPanel(null).querySelectorAll('.kpi-card')).toHaveLength(0);
  });
  it('preserves exact large integer delta text', () => {
    const node = renderKpiPanel({
      items: [item({
        delta: '-9007199254740993', deltaType: 'Int64',
        presentation: { displayName: 'Value', noValue: '—', delta: { decimals: 0 } },
      })], diagnostics: [],
    });
    expect(node.querySelector('.kpi-delta')!.textContent).toBe('↓ 9007199254740993');
    expect(node.querySelector('.kpi-delta')!.getAttribute('aria-label')).toContain('9007199254740993');
  });

  it('formats positive and negative bigint deltas without losing precision', () => {
    for (const [delta, arrow] of [[2n, '↑'], [-2n, '↓']] as const) {
      const node = renderKpiPanel({
        items: [item({ delta, deltaType: 'Int64' })], diagnostics: [],
      });
      expect(node.querySelector('.kpi-delta')!.textContent).toBe(`${arrow} 2`);
    }
  });
});

describe('renderKpiCards', () => {
  it('returns card nodes plus warnings, with no errors, on a normal result', () => {
    const { cards, warnings, errors } = renderKpiCards({
      items: [item()],
      diagnostics: [{ severity: 'warning', code: 'warn', message: 'Ignored region' }],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].classList.contains('kpi-card')).toBe(true);
    expect(warnings).toEqual([{ severity: 'warning', code: 'warn', message: 'Ignored region' }]);
    expect(errors).toEqual([]);
  });
  it('returns no cards and surfaces every diagnostic when a blocking one is present', () => {
    const diagnostics = [
      { severity: 'warning', code: 'warn', message: 'Ignored region' },
      { severity: 'error', code: 'kpi-row-count', message: 'Expected 1 row, got 2' },
    ];
    const { cards, warnings, errors } = renderKpiCards({ items: [], diagnostics });
    expect(cards).toEqual([]);
    expect(warnings).toEqual([]);
    expect(errors).toBe(diagnostics);
  });
  it('treats the info-severity kpi-no-data diagnostic as blocking', () => {
    const { errors } = renderKpiCards({ items: [], diagnostics: [{ severity: 'info', code: 'kpi-no-data', message: 'No data' }] });
    expect(errors).toHaveLength(1);
  });
  it('tolerates a missing normalization result', () => {
    const { cards, warnings, errors } = renderKpiCards(null);
    expect(cards).toEqual([]);
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);
  });
});
