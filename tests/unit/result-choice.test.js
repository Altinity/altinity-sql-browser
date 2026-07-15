import { describe, expect, it } from 'vitest';
import {
  applyResultChoice, DASHBOARD_ROLE_RESULT_CHOICES, effectiveDashboardRole,
  PANEL_RESULT_CHOICES, resultChoiceForSpec,
} from '../../src/core/result-choice.js';

const query = (spec) => ({ id: 'q', sql: 'SELECT 1', specVersion: 1, spec });

describe('result choices', () => {
  it('uses effective Panel defaults and exposes an extendable role list', () => {
    expect(effectiveDashboardRole({})).toBe('panel');
    expect(resultChoiceForSpec({})).toBe('panel:auto');
    expect(resultChoiceForSpec({ dashboard: { role: 'filter' }, panel: { cfg: { type: 'line' } } })).toBe('role:filter');
    expect(PANEL_RESULT_CHOICES.some((c) => c.id === 'panel:kpi')).toBe(true);
    expect(DASHBOARD_ROLE_RESULT_CHOICES).toEqual([{ id: 'role:filter', kind: 'role', role: 'filter', label: 'Filter' }]);
  });
  it('maps a table (or unknown) panel to panel:auto, since Table is not a picker option', () => {
    // Regression: a table-typed panel used to yield 'panel:table', which matches
    // no <option>, leaving the picker blank with no way back to Table.
    expect(resultChoiceForSpec({ panel: { cfg: { type: 'table' } } })).toBe('panel:auto');
    expect(resultChoiceForSpec({ panel: { cfg: { type: 'future-viz' } } })).toBe('panel:auto');
    expect(resultChoiceForSpec({ panel: { cfg: { type: 'line' } } })).toBe('panel:line');
    expect(PANEL_RESULT_CHOICES.some((c) => c.panelType === 'table')).toBe(false);
  });
  it('selects Filter by patching only the role', () => {
    const source = query({ dashboard: { role: 'panel', future: { x: 1 } }, panel: { cfg: { type: 'line', x: 0, y: [1] }, future: true }, keep: 1 });
    const out = applyResultChoice(source, DASHBOARD_ROLE_RESULT_CHOICES[0]);
    expect(out.spec.dashboard).toEqual({ role: 'filter', future: { x: 1 } });
    expect(out.spec.panel).toEqual(source.spec.panel);
    expect(out.spec.keep).toBe(1);
  });
  it('selects a Panel type, switches role back, and preserves extensions', () => {
    const source = query({ dashboard: { role: 'filter', future: 1 }, panel: { cfg: { type: 'text', content: 'x' }, extra: [1] } });
    const choice = PANEL_RESULT_CHOICES.find((c) => c.panelType === 'logs');
    const out = applyResultChoice(source, choice, []);
    expect(out.spec.dashboard).toEqual({ role: 'panel', future: 1 });
    expect(out.spec.panel.extra).toEqual([1]);
    expect(out.spec.panel.cfg).toMatchObject({ type: 'logs', content: 'x' });
  });
  it('does not create dashboard state for an effective Panel or alter invalid choices', () => {
    const source = query({ panel: { cfg: { type: 'text', content: '' } } });
    const choice = PANEL_RESULT_CHOICES.find((c) => c.panelType === 'text');
    expect(applyResultChoice(source, choice).spec.dashboard).toBeUndefined();
    expect(applyResultChoice(source, null)).toBe(source);
  });
});
