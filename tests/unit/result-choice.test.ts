import { describe, expect, it } from 'vitest';
import {
  applyResultChoice, effectiveDashboardRole, PANEL_RESULT_CHOICES, resultChoiceForSpec,
} from '../../src/core/result-choice.js';
import type { QueryRoot } from '../../src/core/saved-query.js';
import type { QuerySpecV1 } from '../../src/generated/json-schema.types.js';

const query = (spec: QuerySpecV1): QueryRoot => ({ id: 'q', sql: 'SELECT 1', specVersion: 1, spec });

describe('result choices', () => {
  it('uses effective Panel defaults, and every choice is a panel choice (#447)', () => {
    expect(effectiveDashboardRole({})).toBe('panel');
    expect(effectiveDashboardRole({ dashboard: { role: 'setup' } })).toBe('setup');
    expect(resultChoiceForSpec({})).toBe('panel:auto');
    // #447: a non-panel role no longer diverts the picker to a `role:` choice —
    // the query's own panel type still decides, so a `setup`-role query with a
    // line panel selects `panel:line` exactly like a plain panel query.
    expect(resultChoiceForSpec({ dashboard: { role: 'setup' }, panel: { cfg: { type: 'line' } } })).toBe('panel:line');
    expect(PANEL_RESULT_CHOICES.some((c) => c.id === 'panel:kpi')).toBe(true);
    // The flattened list is panel choices only — no `role:` ids at all.
    expect(PANEL_RESULT_CHOICES.every((c) => c.kind === 'panel' && c.id.startsWith('panel:'))).toBe(true);
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
  it('selects a Panel type, switches a non-panel role back, and preserves extensions', () => {
    const source = query({ dashboard: { role: 'setup', future: 1 }, panel: { cfg: { type: 'text', content: 'x' }, extra: [1] } });
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
  it('effectiveDashboardRole reads an absent/blank role as the implicit panel default', () => {
    expect(effectiveDashboardRole(undefined)).toBe('panel');
    expect(effectiveDashboardRole(null)).toBe('panel');
    expect(effectiveDashboardRole({ dashboard: {} })).toBe('panel');
    // A BLANK role can only arrive from untrusted ingress (an imported bundle or
    // a share link, decoded before schema validation rejects it) — the enum makes
    // it unrepresentable in a typed literal, so it is parsed here the same way
    // production first sees it.
    const untrusted = JSON.parse('{"dashboard":{"role":""}}') as QuerySpecV1;
    expect(effectiveDashboardRole(untrusted)).toBe('panel');
  });
});
