import { describe, expect, it } from 'vitest';
import {
  explicitPanel, isImagePanel, isKpiPanel, panelExecution, shouldInferImagePanel,
} from '../../src/core/panel-execution.js';

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

describe('image panel ownership (#307)', () => {
  it('isImagePanel narrows on cfg.type', () => {
    expect(isImagePanel(null)).toBe(false);
    expect(isImagePanel({ cfg: { type: 'table' } })).toBe(false);
    expect(isImagePanel({ cfg: { type: 'image' } })).toBe(true);
  });
  it('accepts an authored FORMAT PNG (case-insensitive) with rowLimit 0', () => {
    const out = panelExecution({ cfg: { type: 'image' } }, 'SELECT plot() FORMAT png', { params: { readonly: 2 } });
    expect(out).toEqual({ owned: true, error: null, format: 'PNG', rowLimit: 0, params: { readonly: 2 } });
  });
  it('rejects a missing FORMAT clause (leaving the caller-owned format default untouched)', () => {
    const out = panelExecution({ cfg: { type: 'image' } }, 'SELECT plot()', { format: 'Table' });
    expect(out.owned).toBe(true);
    expect(out.error).toBe('Image panel requires an explicit FORMAT PNG clause.');
    expect(out.format).toBe('Table'); // an error result never overrides the caller's default
  });
  it('rejects an authored FORMAT other than PNG', () => {
    const out = panelExecution({ cfg: { type: 'image' } }, 'SELECT plot() FORMAT CSV');
    expect(out.owned).toBe(true);
    expect(out.error).toBe('Image panel requires FORMAT PNG. Remove FORMAT CSV from the SQL.');
  });
  it('KPI (and any other panel) with an authored FORMAT PNG is still rejected exactly as any other FORMAT', () => {
    const kpi = panelExecution({ cfg: { type: 'kpi' } }, 'SELECT 1 FORMAT PNG');
    expect(kpi.error).toBe('KPI panel owns the result format. Remove FORMAT PNG from the SQL.');
    // A non-KPI, non-image panel is a pass-through — its caller (the Dashboard
    // viewer session) is the one that blanket-rejects an authored FORMAT.
    const table = panelExecution({ cfg: { type: 'table' } }, 'SELECT 1 FORMAT PNG');
    expect(table.owned).toBe(false);
  });
});

describe('shouldInferImagePanel (#307)', () => {
  it('fires for an unconfigured panel (null or no cfg) with a trailing FORMAT PNG (case-insensitive)', () => {
    expect(shouldInferImagePanel(null, 'SELECT 1 FORMAT PNG')).toBe(true);
    expect(shouldInferImagePanel(undefined, 'SELECT 1 FORMAT png')).toBe(true);
    expect(shouldInferImagePanel({}, 'SELECT 1 FORMAT PNG')).toBe(true);
    expect(shouldInferImagePanel({ cfg: null }, 'SELECT 1 FORMAT PNG')).toBe(true);
  });
  it('never fires without a trailing FORMAT PNG', () => {
    expect(shouldInferImagePanel(null, 'SELECT 1')).toBe(false);
    expect(shouldInferImagePanel(null, 'SELECT 1 FORMAT CSV')).toBe(false);
  });
  it('never fires when the panel already has ANY explicit cfg, even a non-image one', () => {
    expect(shouldInferImagePanel({ cfg: { type: 'table' } }, 'SELECT 1 FORMAT PNG')).toBe(false);
    expect(shouldInferImagePanel({ cfg: { type: 'image' } }, 'SELECT 1 FORMAT PNG')).toBe(false);
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
