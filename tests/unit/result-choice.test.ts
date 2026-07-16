import { describe, expect, it } from 'vitest';
import {
  applyResultChoice, DASHBOARD_ROLE_RESULT_CHOICES, effectiveDashboardRole,
  PANEL_RESULT_CHOICES, resultChoiceForSpec, rolePreviewView,
} from '../../src/core/result-choice.js';
import type { QueryRoot } from '../../src/core/saved-query.js';
import type { QuerySpecV1 } from '../../src/generated/json-schema.types.js';

const query = (spec: QuerySpecV1): QueryRoot => ({ id: 'q', sql: 'SELECT 1', specVersion: 1, spec });

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
    // PickablePanelType excludes 'table' by construction (that's the point being
    // tested) — widen to string for the comparison itself.
    expect(PANEL_RESULT_CHOICES.some((c) => (c.panelType as string) === 'table')).toBe(false);
  });
  it('selects Filter by patching only the role', () => {
    const source = query({ dashboard: { role: 'panel', future: { x: 1 } }, panel: { cfg: { type: 'line', x: 0, y: [1] }, future: true }, keep: 1 });
    const out = applyResultChoice(source, DASHBOARD_ROLE_RESULT_CHOICES[0]) as QueryRoot;
    expect(out.spec.dashboard).toEqual({ role: 'filter', future: { x: 1 } });
    expect(out.spec.panel).toEqual(source.spec.panel);
    expect(out.spec.keep).toBe(1);
  });
  it('selects a Panel type, switches role back, and preserves extensions', () => {
    const source = query({ dashboard: { role: 'filter', future: 1 }, panel: { cfg: { type: 'text', content: 'x' }, extra: [1] } });
    const choice = PANEL_RESULT_CHOICES.find((c) => c.panelType === 'logs');
    // applyResultChoice's signature has no explicit return type; its `return
    // query` fallback branch (query: unknown) widens the whole inferred return
    // to `unknown`, so a QueryRoot cast is needed at every call site here.
    const out = applyResultChoice(source, choice, []) as QueryRoot;
    expect(out.spec.dashboard).toEqual({ role: 'panel', future: 1 });
    expect(out.spec.panel!.extra).toEqual([1]);
    expect(out.spec.panel!.cfg).toMatchObject({ type: 'logs', content: 'x' });
  });
  it('does not create dashboard state for an effective Panel or alter invalid choices', () => {
    const source = query({ panel: { cfg: { type: 'text', content: '' } } });
    const choice = PANEL_RESULT_CHOICES.find((c) => c.panelType === 'text');
    expect((applyResultChoice(source, choice) as QueryRoot).spec.dashboard).toBeUndefined();
    expect(applyResultChoice(source, null)).toBe(source);
  });
  it('rolePreviewView: Filter owns the transient launch preview; every other role defers (#244)', () => {
    expect(rolePreviewView({ dashboard: { role: 'filter' } })).toBe('filter');
    expect(rolePreviewView({})).toBeNull();
    expect(rolePreviewView({ dashboard: { role: 'panel' } })).toBeNull();
    expect(rolePreviewView(undefined)).toBeNull();
    // dormant Panel state alongside the role has no bearing on the pure helper —
    // precedence over it is the caller's job (saved-history.js).
    expect(rolePreviewView({ dashboard: { role: 'filter' }, view: 'panel', panel: { cfg: { type: 'kpi' } } })).toBe('filter');
  });
});
