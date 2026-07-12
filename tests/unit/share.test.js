import { describe, it, expect } from 'vitest';
import { encodeShare, decodeShare } from '../../src/core/share.js';

describe('share encode/decode', () => {
  it('round-trips ASCII SQL (no panel → panel null)', () => {
    const sql = 'SELECT * FROM t WHERE x = 1';
    expect(decodeShare('#' + encodeShare(sql))).toEqual({ sql, panel: null });
  });
  it('round-trips unicode', () => {
    const sql = 'SELECT \'café — 日本語\'';
    expect(decodeShare(encodeShare(sql))).toEqual({ sql, panel: null });
  });
  it('round-trips a chart-family panel alongside the SQL', () => {
    const sql = 'SELECT a, b FROM t';
    const panel = { cfg: { type: 'pie', x: 0, y: [1], series: null }, key: 'a:String|b:UInt64' };
    expect(decodeShare(encodeShare(sql, panel))).toEqual({ sql, panel });
  });
  it('a chart-family panel travels with the legacy chart mirror (rollback link-compat, #166)', () => {
    const panel = { cfg: { type: 'pie', x: 0, y: [1], series: null }, key: 'k' };
    const raw = JSON.parse(decodeURIComponent(escape(atob(encodeShare('SELECT 1', panel)))));
    expect(raw.chart).toEqual(panel); // an older build reads this and still shows the chart
    expect(raw.panel).toEqual(panel);
  });
  it('a non-chart panel (text) round-trips WITHOUT a chart mirror, even with empty SQL', () => {
    const panel = { cfg: { type: 'text', content: '# note' } };
    const enc = encodeShare('', panel);
    const raw = JSON.parse(decodeURIComponent(escape(atob(enc))));
    expect('chart' in raw).toBe(false);
    expect(decodeShare(enc)).toEqual({ sql: '', panel });
  });
  it('a legacy tagged {sql, chart} envelope upgrades to a chart-family panel', () => {
    const chart = { cfg: { type: 'line', x: 0, y: [1], series: null }, key: 'k' };
    const hash = btoa(unescape(encodeURIComponent(JSON.stringify({ __asb: 1, sql: 'SELECT 3', chart }))));
    expect(decodeShare(hash)).toEqual({ sql: 'SELECT 3', panel: { cfg: chart.cfg, key: 'k' } });
  });
  it('ignores a panel with no cfg (encodes as legacy SQL)', () => {
    const sql = 'SELECT 1';
    expect(decodeShare(encodeShare(sql, { key: 'x' }))).toEqual({ sql, panel: null });
  });
  it('drops a non-object chart field in a tagged envelope', () => {
    // hand-built tagged envelope whose chart is a string, not an object
    const hash = btoa(unescape(encodeURIComponent(JSON.stringify({ __asb: 1, sql: 'SELECT 2', chart: 'nope' }))));
    expect(decodeShare(hash)).toEqual({ sql: 'SELECT 2', panel: null });
  });
  it('tolerates a leading # or none', () => {
    const enc = encodeShare('SELECT 1');
    expect(decodeShare(enc).sql).toBe('SELECT 1');
    expect(decodeShare('#' + enc).sql).toBe('SELECT 1');
  });
  it('treats valid-JSON-but-untagged decoded text as legacy SQL', () => {
    // base64 of the literal text "123" → JSON.parse succeeds (number), not tagged
    const hash = btoa('123');
    expect(decodeShare(hash)).toEqual({ sql: '123', panel: null });
  });
  it('returns empty for empty/short/garbage hashes', () => {
    expect(decodeShare('')).toEqual({ sql: '', panel: null });
    expect(decodeShare('#')).toEqual({ sql: '', panel: null });
    expect(decodeShare(null)).toEqual({ sql: '', panel: null });
    expect(decodeShare('#@@@@')).toEqual({ sql: '', panel: null });
  });
});
