import { describe, expect, it } from 'vitest';
import { explicitPanel, isKpiPanel, panelExecution } from '../../src/core/panel-execution.js';

describe('panel execution ownership', () => {
  it('leaves non-KPI execution unchanged', () => {
    expect(isKpiPanel(null)).toBe(false);
    expect(isKpiPanel({ cfg: { type: 'table' } })).toBe(false);
    expect(isKpiPanel({ cfg: { type: 'kpi' } })).toBe(true);
    expect(panelExecution({ cfg: { type: 'chart' } }, 'SELECT 1', { format: 'Table', rowLimit: 99, params: { x: 1 } })).toEqual({ format: 'Table', rowLimit: 99, params: { x: 1 }, owned: false, error: null });
    expect(panelExecution(null, 'SELECT 1')).toEqual({ owned: false, error: null, params: {} });
  });
  it('selects bounded typed KPI streaming with named tuples as objects', () => {
    expect(panelExecution({ cfg: { type: 'kpi' } }, 'SELECT 1', { format: 'Table', params: { readonly: 2 } })).toEqual({ format: 'KPI', rowLimit: 2, params: { readonly: 2, output_format_json_named_tuples_as_objects: 1, output_format_json_quote_decimals: 1 }, owned: true, error: null });
    expect(panelExecution({ cfg: { type: 'kpi' } }, 'SELECT 1')).toEqual({ format: 'KPI', rowLimit: 2, params: { output_format_json_named_tuples_as_objects: 1, output_format_json_quote_decimals: 1 }, owned: true, error: null });
  });
  it('blocks a trailing top-level authored FORMAT without changing defaults', () => {
    const out = panelExecution({ cfg: { type: 'kpi' } }, 'SELECT 1 FORMAT CSV -- authored', { format: 'Table', params: { p: 1 } });
    expect(out).toMatchObject({ format: 'Table', owned: true, params: { p: 1 } });
    expect(out.error).toBe('KPI panel owns the result format. Remove FORMAT CSV from the SQL.');
    expect(panelExecution({ cfg: { type: 'kpi' } }, 'SELECT 1 FORMAT JSON').params).toEqual({});
  });
});

describe('explicitPanel', () => {
  it('returns the saved panel when its cfg is a plain object', () => {
    const query = { spec: { panel: { cfg: { type: 'kpi' } } } };
    expect(explicitPanel(query)).toEqual({ cfg: { type: 'kpi' } });
  });
  it('returns null for no panel, a non-object cfg, or a missing query/spec', () => {
    expect(explicitPanel({ spec: {} })).toBeNull();
    expect(explicitPanel({ spec: { panel: { cfg: 'kpi' } } })).toBeNull();
    expect(explicitPanel({ spec: { panel: {} } })).toBeNull();
    expect(explicitPanel(null)).toBeNull();
    expect(explicitPanel(undefined)).toBeNull();
  });
});
