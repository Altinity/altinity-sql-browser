import { describe, it, expect } from 'vitest';
import {
  CHART_FAMILY, PANEL_TYPE_IDS, isChartFamily, isKnownPanelType,
  clonePanelCfg, resolveLogsShape, panelCfgValid, normalizePanelCfg,
  autoPanel, resolvePanel, switchPanelType,
} from '../../src/core/panel-cfg.js';
import { schemaKey } from '../../src/core/chart-data.js';

const chartCols = [
  { name: 'carrier', type: 'String' },
  { name: 'flights', type: 'UInt64' },
];
const logCols = [
  { name: 'event_time', type: 'DateTime' },
  { name: 'level', type: 'String' },
  { name: 'message', type: 'String' },
];
const strCols = [{ name: 'a', type: 'String' }, { name: 'b', type: 'String' }];

describe('type sets', () => {
  it('the chart family is the five chart types; the union adds table/logs/text', () => {
    expect([...CHART_FAMILY].sort()).toEqual(['area', 'bar', 'hbar', 'line', 'pie']);
    expect(PANEL_TYPE_IDS).toContain('table');
    expect(PANEL_TYPE_IDS).toContain('logs');
    expect(PANEL_TYPE_IDS).toContain('text');
    expect(isChartFamily('pie')).toBe(true);
    expect(isChartFamily('table')).toBe(false);
    expect(isKnownPanelType('logs')).toBe(true);
    expect(isKnownPanelType('gauge')).toBe(false);
  });
});

describe('clonePanelCfg', () => {
  it('deep-clones (no aliasing) and preserves unknown fields at every level', () => {
    const src = { type: 'table', chart: { type: 'line', x: 0, y: [1], series: null }, futureField: [1, { a: 2 }] };
    const out = clonePanelCfg(src);
    expect(out).toEqual(src);
    expect(out).not.toBe(src);
    expect(out.chart).not.toBe(src.chart);
    expect(out.futureField[1]).not.toBe(src.futureField[1]);
    out.chart.y.push(9);
    expect(src.chart.y).toEqual([1]); // source untouched
  });
  it('null / non-object → null', () => {
    expect(clonePanelCfg(null)).toBeNull();
    expect(clonePanelCfg('nope')).toBeNull();
  });
});

describe('resolveLogsShape', () => {
  it('resolves explicit names case-insensitively and computes extras', () => {
    const cols = [...logCols, { name: 'thread_id', type: 'UInt64' }];
    const shape = resolveLogsShape({ type: 'logs', time: 'Event_Time', msg: 'MESSAGE', level: 'level' }, cols);
    expect(shape).toEqual({ time: 0, msg: 2, level: 1, extras: [3] });
  });
  it('omitted names fall back to convention detection for that role', () => {
    expect(resolveLogsShape({ type: 'logs' }, logCols)).toEqual({ time: 0, msg: 2, level: 1, extras: [] });
    expect(resolveLogsShape({ type: 'logs', msg: 'message' }, logCols))
      .toEqual({ time: 0, msg: 2, level: 1, extras: [] });
  });
  it('a failed explicit time/msg lookup is the mismatch signal (null)', () => {
    expect(resolveLogsShape({ type: 'logs', time: 'gone', msg: 'message' }, logCols)).toBeNull();
    expect(resolveLogsShape({ type: 'logs', msg: 'gone' }, logCols)).toBeNull();
  });
  it('a dangling explicit level degrades to colors-off (level null), not failure', () => {
    const shape = resolveLogsShape({ type: 'logs', time: 'event_time', msg: 'message', level: 'gone' }, logCols);
    expect(shape).toEqual({ time: 0, msg: 2, level: null, extras: [1] });
  });
  it('explicit names can point at columns detection would never pick', () => {
    const cols = [
      { name: 'when', type: 'DateTime' },
      { name: 'note', type: 'String' },
    ];
    // Detection fails ('note' isn't a message-conventioned name), explicit works.
    expect(resolveLogsShape({ type: 'logs', msg: 'note' }, cols))
      .toEqual({ time: 0, msg: 1, level: null, extras: [] });
  });
  it('no explicit names + nothing detectable → null (empty columns too)', () => {
    expect(resolveLogsShape({ type: 'logs' }, strCols)).toBeNull();
    expect(resolveLogsShape({ type: 'logs' }, [])).toBeNull();
  });
});

describe('panelCfgValid', () => {
  it('chart family delegates to chart-data index validation', () => {
    expect(panelCfgValid({ type: 'bar', x: 0, y: [1], series: null }, chartCols)).toBe(true);
    expect(panelCfgValid({ type: 'bar', x: 99, y: [1], series: null }, chartCols)).toBe(false);
  });
  it('logs is valid iff the name lookups resolve', () => {
    expect(panelCfgValid({ type: 'logs' }, logCols)).toBe(true);
    expect(panelCfgValid({ type: 'logs', time: 'gone' }, logCols)).toBe(false);
  });
  it('table and text carry no schema-bound fields (always valid); unknown/absent type is not', () => {
    expect(panelCfgValid({ type: 'table' }, strCols)).toBe(true);
    expect(panelCfgValid({ type: 'text', content: 'hi' }, [])).toBe(true);
    expect(panelCfgValid({ type: 'gauge' }, strCols)).toBe(false);
    expect(panelCfgValid({}, strCols)).toBe(false);
    expect(panelCfgValid(null, strCols)).toBe(false);
  });
  it('unknown extra fields are ignored, never a failure', () => {
    expect(panelCfgValid({ type: 'table', futureField: 1 }, strCols)).toBe(true);
  });
});

describe('normalizePanelCfg', () => {
  it('chart family folds cross-field invariants (pie → single measure, no series)', () => {
    const cfg = normalizePanelCfg({ type: 'pie', x: 0, y: [1, 2], series: 1 });
    expect(cfg).toMatchObject({ y: [1], series: null });
  });
  it("text coerces a missing/non-string content to ''", () => {
    expect(normalizePanelCfg({ type: 'text' }).content).toBe('');
    expect(normalizePanelCfg({ type: 'text', content: 42 }).content).toBe('');
    expect(normalizePanelCfg({ type: 'text', content: 'keep' }).content).toBe('keep');
  });
  it('table passes through untouched; null → null', () => {
    const cfg = { type: 'table', futureField: 1 };
    expect(normalizePanelCfg(cfg)).toBe(cfg);
    expect(normalizePanelCfg(null)).toBeNull();
  });
});

describe('autoPanel', () => {
  it('log-shaped outranks chartable (thread_id would auto-chart otherwise)', () => {
    const cols = [...logCols, { name: 'thread_id', type: 'UInt64' }];
    const out = autoPanel(cols);
    expect(out.cfg).toEqual({ type: 'logs' });
    expect(out.shape).toEqual({ time: 0, msg: 2, level: 1, extras: [3] });
  });
  it('chartable → autoChart pick; else table (never text/filter/setup)', () => {
    expect(autoPanel(chartCols).cfg).toMatchObject({ type: 'hbar', x: 0, y: [1] });
    expect(autoPanel(strCols).cfg).toEqual({ type: 'table' });
    expect(autoPanel([]).cfg).toEqual({ type: 'table' });
  });
});

describe('switchPanelType', () => {
  const chartPayload = { cfg: { type: 'bar', x: 0, y: [1], series: null }, key: 'K' };
  it('same type → payload passes through (as a clone)', () => {
    const out = switchPanelType(chartPayload, 'bar', chartCols);
    expect(out).toEqual(chartPayload);
    expect(out.cfg).not.toBe(chartPayload.cfg);
  });
  it('chart → chart keeps the configured axes and key, swaps the type (normalized)', () => {
    const out = switchPanelType({ cfg: { type: 'bar', x: 0, y: [1], series: 0 }, key: 'K' }, 'pie', chartCols);
    expect(out.cfg).toMatchObject({ type: 'pie', x: 0, y: [1], series: null }); // pie invariant folded
    expect(out.key).toBe('K');
  });
  it('leaving the chart family stashes the roles; switching back consumes them (lossless)', () => {
    const table = switchPanelType(chartPayload, 'table', chartCols);
    expect(table.cfg).toEqual({ type: 'table', chart: { type: 'bar', x: 0, y: [1], series: null, key: 'K' } });
    expect(table.key).toBeNull();
    const back = switchPanelType(table, 'line', chartCols);
    expect(back.cfg).toMatchObject({ type: 'line', x: 0, y: [1], series: null });
    expect(back.key).toBe('K');
    expect('chart' in back.cfg).toBe(false); // stash consumed
  });
  it('entering the chart family with no stash derives roles via autoChart (+ fresh schema key)', () => {
    const out = switchPanelType({ cfg: { type: 'table' } }, 'line', chartCols);
    expect(out.cfg).toMatchObject({ type: 'line', x: 0, y: [1] });
    expect(out.key).toBe(schemaKey(chartCols));
  });
  it('entering the chart family on a non-chartable result yields a bare (invalid) type marker', () => {
    const out = switchPanelType({ cfg: { type: 'table' } }, 'line', strCols);
    expect(out.cfg).toEqual({ type: 'line' });
    expect(out.key).toBeNull();
  });
  it("text gains a string content (''), and content survives switches away and back", () => {
    const text = switchPanelType({ cfg: { type: 'table' } }, 'text', []);
    expect(text.cfg).toEqual({ type: 'text', content: '' });
    const away = switchPanelType({ cfg: { type: 'text', content: '# kept' } }, 'table', []);
    const back = switchPanelType(away, 'text', []);
    expect(back.cfg.content).toBe('# kept');
  });
  it('logs role names ride along through a table round-trip (unknown-field preservation)', () => {
    const away = switchPanelType({ cfg: { type: 'logs', msg: 'body' } }, 'table', logCols);
    const back = switchPanelType(away, 'logs', logCols);
    expect(back.cfg).toMatchObject({ type: 'logs', msg: 'body' });
  });
  it('a null/empty payload starts from scratch', () => {
    expect(switchPanelType(null, 'text', []).cfg).toEqual({ type: 'text', content: '' });
    expect(switchPanelType({ cfg: null }, 'table', []).cfg).toEqual({ type: 'table' });
  });
});

describe('resolvePanel', () => {
  it('no saved panel → autoPanel, not a fallback', () => {
    const out = resolvePanel(undefined, chartCols);
    expect(out.cfg.type).toBe('hbar');
    expect(out.fallback).toBe(false);
    expect(out.rederived).toBe(false);
    const noCfg = resolvePanel({ key: 'x' }, chartCols);
    expect(noCfg.cfg.type).toBe('hbar');
  });
  it('a valid chart cfg with a matching key renders as-saved (a clone, not an alias)', () => {
    const saved = { cfg: { type: 'bar', x: 0, y: [1], series: null }, key: schemaKey(chartCols) };
    const out = resolvePanel(saved, chartCols);
    expect(out).toMatchObject({ rederived: false, fallback: false });
    expect(out.cfg).toMatchObject({ type: 'bar', x: 0, y: [1] });
    out.cfg.y.push(9);
    expect(saved.cfg.y).toEqual([1]); // saved entry untouched
  });
  it('a valid chart cfg with a stale key retains its type but re-derives roles', () => {
    const cols = [...chartCols, { name: 'delay', type: 'Float64' }];
    const saved = { cfg: { type: 'bar', x: 0, y: [2], series: null }, key: 'STALE' };
    const out = resolvePanel(saved, cols);
    expect(out.rederived).toBe(true);
    expect(out.cfg.type).toBe('bar');
    expect(out.cfg).toMatchObject({ x: 0, y: [1] });
    expect(out.cfg.y).not.toEqual(saved.cfg.y);
  });
  it('an invalid chart cfg retains the explicit type and re-derives axes (unknown fields kept)', () => {
    const saved = { cfg: { type: 'pie', x: 99, y: [42], series: null, futureField: 'kept' } };
    const out = resolvePanel(saved, chartCols);
    expect(out.fallback).toBe(false);
    expect(out.rederived).toBe(true);
    expect(out.cfg.type).toBe('pie'); // explicit type kept
    expect(out.cfg.x).toBe(0);
    expect(out.cfg.y).toEqual([1]);
    expect(out.cfg.futureField).toBe('kept');
  });
  it('an impossible chart (invalid cfg + nothing plottable) falls back to autoPanel + diagnostic', () => {
    // Structurally-valid indices render as today (parity with chartCfgFor);
    // only an invalid cfg whose type can't re-derive (no measures) falls back.
    const saved = { cfg: { type: 'line', x: 99, y: [42], series: null } };
    const out = resolvePanel(saved, strCols);
    expect(out.fallback).toBe(true);
    expect(out.diagnostic).toContain('nothing to plot');
    expect(out.cfg.type).toBe('table');
  });
  it('logs: explicit names resolve → as-saved; a failed lookup re-derives by convention', () => {
    const ok = resolvePanel({ cfg: { type: 'logs', msg: 'message' } }, logCols);
    expect(ok).toMatchObject({ rederived: false, fallback: false });
    expect(ok.shape).toEqual({ time: 0, msg: 2, level: 1, extras: [] });
    const red = resolvePanel({ cfg: { type: 'logs', msg: 'renamed_away' } }, logCols);
    expect(red.fallback).toBe(false);
    expect(red.rederived).toBe(true);
    expect(red.cfg.type).toBe('logs'); // type retained
    expect(red.shape).toEqual({ time: 0, msg: 2, level: 1, extras: [] });
  });
  it('logs on a result with no time+message at all → fallback + diagnostic', () => {
    const out = resolvePanel({ cfg: { type: 'logs' } }, strCols);
    expect(out.fallback).toBe(true);
    expect(out.diagnostic).toContain('no time + message');
    expect(out.cfg.type).toBe('table');
  });
  it('table and text pass through for any result shape (text needs no result)', () => {
    const table = resolvePanel({ cfg: { type: 'table', chart: { type: 'line' } } }, logCols);
    expect(table).toMatchObject({ rederived: false, fallback: false });
    expect(table.cfg.chart).toEqual({ type: 'line' }); // latent-chart stash preserved
    const text = resolvePanel({ cfg: { type: 'text', content: '# hi' } }, []);
    expect(text.cfg.content).toBe('# hi');
    expect(text.fallback).toBe(false);
  });
  it('an unknown type (newer build) falls back with a diagnostic naming it', () => {
    const out = resolvePanel({ cfg: { type: 'gauge', max: 100 } }, chartCols);
    expect(out.fallback).toBe(true);
    expect(out.diagnostic).toContain('gauge');
    expect(out.cfg.type).toBe('hbar'); // autoPanel picked for the actual shape
  });
});
