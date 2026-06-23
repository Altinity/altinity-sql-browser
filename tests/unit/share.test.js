import { describe, it, expect } from 'vitest';
import { encodeShare, decodeShare } from '../../src/core/share.js';

describe('share encode/decode', () => {
  it('round-trips ASCII SQL (no chart → chart null)', () => {
    const sql = 'SELECT * FROM t WHERE x = 1';
    expect(decodeShare('#' + encodeShare(sql))).toEqual({ sql, chart: null });
  });
  it('round-trips unicode', () => {
    const sql = 'SELECT \'café — 日本語\'';
    expect(decodeShare(encodeShare(sql))).toEqual({ sql, chart: null });
  });
  it('round-trips a chart payload alongside the SQL', () => {
    const sql = 'SELECT a, b FROM t';
    const chart = { cfg: { type: 'pie', x: 0, y: [1], series: null }, key: 'a:String|b:UInt64' };
    expect(decodeShare(encodeShare(sql, chart))).toEqual({ sql, chart });
  });
  it('ignores a chart with no cfg (encodes as legacy SQL)', () => {
    const sql = 'SELECT 1';
    expect(decodeShare(encodeShare(sql, { key: 'x' }))).toEqual({ sql, chart: null });
  });
  it('drops a non-object chart field in a tagged envelope', () => {
    // hand-built tagged envelope whose chart is a string, not an object
    const hash = btoa(unescape(encodeURIComponent(JSON.stringify({ __asb: 1, sql: 'SELECT 2', chart: 'nope' }))));
    expect(decodeShare(hash)).toEqual({ sql: 'SELECT 2', chart: null });
  });
  it('tolerates a leading # or none', () => {
    const enc = encodeShare('SELECT 1');
    expect(decodeShare(enc).sql).toBe('SELECT 1');
    expect(decodeShare('#' + enc).sql).toBe('SELECT 1');
  });
  it('treats valid-JSON-but-untagged decoded text as legacy SQL', () => {
    // base64 of the literal text "123" → JSON.parse succeeds (number), not tagged
    const hash = btoa('123');
    expect(decodeShare(hash)).toEqual({ sql: '123', chart: null });
  });
  it('returns empty for empty/short/garbage hashes', () => {
    expect(decodeShare('')).toEqual({ sql: '', chart: null });
    expect(decodeShare('#')).toEqual({ sql: '', chart: null });
    expect(decodeShare(null)).toEqual({ sql: '', chart: null });
    expect(decodeShare('#@@@@')).toEqual({ sql: '', chart: null });
  });
});
